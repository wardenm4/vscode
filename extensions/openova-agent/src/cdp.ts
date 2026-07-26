/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Interactive browser session over the Chrome DevTools Protocol: a persistent
// headless Chrome the agent can navigate, click, type into, read, and
// screenshot — page state (JS, forms, SPA routing) survives across tool
// calls, unlike the one-shot --dump-dom path. The WebSocket client is
// hand-rolled over net.Socket to keep the dependency surface at zero.
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { findBrowser } from './browser';

// ---- minimal WebSocket client ----------------------------------------------

type WsMessageHandler = (text: string) => void;

class MiniWebSocket {
	private socket: net.Socket | null = null;
	private buffer = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	onMessage: WsMessageHandler = () => { };
	onClose: () => void = () => { };

	connect(host: string, port: number, wsPath: string, timeoutMs = 8000): Promise<void> {
		return new Promise((resolve, reject) => {
			const key = crypto.randomBytes(16).toString('base64');
			const socket = net.connect(port, host);
			this.socket = socket;
			let upgraded = false;
			let headerBuf = Buffer.alloc(0);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error('WebSocket connect timed out'));
			}, timeoutMs);
			socket.on('connect', () => {
				socket.write(
					`GET ${wsPath} HTTP/1.1\r\n` +
					`Host: ${host}:${port}\r\n` +
					'Upgrade: websocket\r\n' +
					'Connection: Upgrade\r\n' +
					`Sec-WebSocket-Key: ${key}\r\n` +
					'Sec-WebSocket-Version: 13\r\n\r\n'
				);
			});
			socket.on('data', (data: Buffer) => {
				if (!upgraded) {
					headerBuf = Buffer.concat([headerBuf, data]);
					const idx = headerBuf.indexOf('\r\n\r\n');
					if (idx === -1) { return; }
					const head = headerBuf.slice(0, idx).toString('utf8');
					if (!/^HTTP\/1\.1 101/.test(head)) {
						clearTimeout(timer);
						socket.destroy();
						reject(new Error(`WebSocket upgrade failed: ${head.split('\r\n')[0]}`));
						return;
					}
					upgraded = true;
					clearTimeout(timer);
					this.buffer = headerBuf.slice(idx + 4);
					this.drain();
					resolve();
					return;
				}
				this.buffer = Buffer.concat([this.buffer, data]);
				this.drain();
			});
			socket.on('error', (e) => {
				clearTimeout(timer);
				if (!upgraded) { reject(e); }
				this.onClose();
			});
			socket.on('close', () => this.onClose());
		});
	}

	/** Send one masked text frame (client frames MUST be masked per RFC 6455).
	 *  Returns false when the socket is gone so callers can fail fast instead
	 *  of waiting out a request timeout. */
	send(text: string): boolean {
		if (!this.socket || this.socket.destroyed) { return false; }
		const payload = Buffer.from(text, 'utf8');
		const mask = crypto.randomBytes(4);
		let header: Buffer;
		if (payload.length < 126) {
			header = Buffer.from([0x81, 0x80 | payload.length]);
		} else if (payload.length < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x81;
			header[1] = 0x80 | 126;
			header.writeUInt16BE(payload.length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x81;
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(payload.length), 2);
		}
		const masked = Buffer.alloc(payload.length);
		for (let i = 0; i < payload.length; i++) { masked[i] = payload[i] ^ mask[i % 4]; }
		this.socket.write(Buffer.concat([header, mask, masked]));
		return true;
	}

	private drain(): void {
		for (; ;) {
			if (this.buffer.length < 2) { return; }
			const b0 = this.buffer[0];
			const b1 = this.buffer[1];
			const fin = (b0 & 0x80) !== 0;
			const opcode = b0 & 0x0f;
			const hasMask = (b1 & 0x80) !== 0;
			let len = b1 & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (this.buffer.length < 4) { return; }
				len = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (len === 127) {
				if (this.buffer.length < 10) { return; }
				len = Number(this.buffer.readBigUInt64BE(2));
				offset = 10;
			}
			let maskKey: Buffer | null = null;
			if (hasMask) {
				if (this.buffer.length < offset + 4) { return; }
				maskKey = this.buffer.slice(offset, offset + 4);
				offset += 4;
			}
			if (this.buffer.length < offset + len) { return; }
			let payload = this.buffer.slice(offset, offset + len);
			this.buffer = this.buffer.slice(offset + len);
			if (maskKey) {
				const un = Buffer.alloc(payload.length);
				for (let i = 0; i < payload.length; i++) { un[i] = payload[i] ^ maskKey[i % 4]; }
				payload = un;
			}
			if (opcode === 0x9) {
				// ping -> pong (masked). Control frames cap at 125 bytes, so the
				// echoed payload must be TRUNCATED, not just its length field —
				// writing more bytes than the header declares desyncs the stream.
				const echo = payload.subarray(0, 125);
				const mask = crypto.randomBytes(4);
				const masked = Buffer.alloc(echo.length);
				for (let i = 0; i < echo.length; i++) { masked[i] = echo[i] ^ mask[i % 4]; }
				this.socket?.write(Buffer.concat([Buffer.from([0x8a, 0x80 | echo.length]), mask, masked]));
				continue;
			}
			if (opcode === 0x8) {
				this.socket?.destroy();
				return;
			}
			if (opcode === 0x1 || opcode === 0x0) {
				this.fragments.push(payload);
				if (fin) {
					const full = Buffer.concat(this.fragments).toString('utf8');
					this.fragments = [];
					this.onMessage(full);
				}
			}
			// binary (0x2) and pong (0xA) frames are ignored
		}
	}

	close(): void {
		try { this.socket?.destroy(); } catch { /* gone */ }
		this.socket = null;
	}
}

// ---- CDP session -----------------------------------------------------------

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
		srv.on('error', reject);
	});
}

const instances = new Set<CdpBrowser>();

/** Tree-kill every live headless session (extension deactivate). */
export function disposeAllCdp(): void {
	for (const c of [...instances]) { c.dispose(); }
}

/** Delete profile dirs left behind by sessions that died hard (crash, kill). */
export function sweepStaleProfiles(): void {
	try {
		for (const name of fs.readdirSync(os.tmpdir())) {
			if (!name.startsWith('openova-cdp-')) { continue; }
			const pid = Number(name.split('-')[2]);
			if (pid === process.pid) { continue; }
			try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); } catch { /* in use */ }
		}
	} catch { /* no temp access — skip */ }
}

export class CdpBrowser {
	private proc: cp.ChildProcess | null = null;
	private profileDir: string | null = null;
	private ws = new MiniWebSocket();
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private disposed = false;
	alive = false;
	currentUrl = 'about:blank';

	/** Throw (and clean up) if dispose() landed while we were awaiting. */
	private assertLive(): void {
		if (this.disposed) {
			this.dispose();
			throw new Error('Browser session was disposed during launch.');
		}
	}

	async launch(): Promise<void> {
		const exe = findBrowser();
		if (!exe) { throw new Error('No Chrome/Edge installation found for the interactive browser.'); }
		const port = await freePort();
		this.assertLive();
		// UNIQUE profile per session: with a shared dir a second launch hands
		// off to the existing Chrome and never exposes the new DevTools port.
		const profile = path.join(os.tmpdir(), `openova-cdp-${process.pid}-${Date.now()}`);
		this.profileDir = profile;
		this.proc = cp.spawn(
			exe,
			[
				'--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1280,900',
				`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'
			],
			{ windowsHide: true }
		);
		// Register only once a process exists — otherwise a dispose() racing the
		// awaits above would find nothing to kill and orphan this Chrome.
		instances.add(this);
		// spawn reports failures (EACCES, EMFILE, a mid-session Chrome update)
		// asynchronously; without a listener Node throws them as uncaught.
		this.proc.on('error', () => { this.alive = false; });
		this.proc.on('exit', () => { this.alive = false; });
		// Wait for the DevTools endpoint, then attach to the first page target.
		let targets: { type: string; webSocketDebuggerUrl?: string }[] = [];
		const deadline = Date.now() + 12_000;
		for (; ;) {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
				targets = (await res.json()) as typeof targets;
				if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) { break; }
			} catch { /* not up yet */ }
			if (Date.now() > deadline) {
				this.dispose();
				throw new Error('Headless browser did not expose a DevTools page target in time.');
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)!;
		const wsUrl = new URL(page.webSocketDebuggerUrl!);
		this.ws.onMessage = (text) => {
			try {
				const msg = JSON.parse(text) as { id?: number; method?: string; result?: unknown; error?: { message?: string } };
				// With Page.enable on, Chrome hands JS dialogs to US and blocks
				// the renderer until they are answered — an unanswered alert()
				// would wedge every later evaluate. Dismiss them automatically.
				if (msg.method === 'Page.javascriptDialogOpening') {
					void this.send('Page.handleJavaScriptDialog', { accept: true }, 5000).catch(() => { });
					return;
				}
				if (msg.id !== undefined && this.pending.has(msg.id)) {
					const p = this.pending.get(msg.id)!;
					this.pending.delete(msg.id);
					if (msg.error) { p.reject(new Error(msg.error.message ?? 'CDP error')); }
					else { p.resolve(msg.result); }
				}
			} catch { /* event or junk — ignore */ }
		};
		this.ws.onClose = () => {
			this.alive = false;
			for (const [, p] of this.pending) { p.reject(new Error('Browser session closed')); }
			this.pending.clear();
		};
		await this.ws.connect(wsUrl.hostname, Number(wsUrl.port), wsUrl.pathname + wsUrl.search);
		this.assertLive();
		this.alive = true;
		await this.send('Page.enable', {});
		await this.send('Runtime.enable', {});
		this.assertLive();
	}

	send(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP ${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => { clearTimeout(timer); resolve(v); },
				reject: (e) => { clearTimeout(timer); reject(e); }
			});
			// A dead socket must fail now, not after the full timeout.
			if (!this.ws.send(JSON.stringify({ id, method, params }))) {
				const p = this.pending.get(id);
				this.pending.delete(id);
				p?.reject(new Error('Browser session is not connected.'));
				return;
			}
		});
	}

	/** Run an expression in the page; returns its JSON value. */
	async evaluate(expression: string): Promise<unknown> {
		const res = (await this.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true
		})) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
		if (res.exceptionDetails) {
			throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'page script threw');
		}
		return res.result?.value;
	}

	async navigate(url: string): Promise<void> {
		// Mark the CURRENT document: a freshly committed document won't carry
		// the marker. Without this, readyState 'complete' on the OLD page ends
		// the wait immediately and we read the previous page's DOM and URL.
		const marker = `__ovNav${Date.now().toString(36)}`;
		await this.evaluate(`window.${marker} = 1`).catch(() => { });
		const res = (await this.send('Page.navigate', { url })) as { errorText?: string };
		if (res?.errorText) { throw new Error(`${res.errorText} (${url})`); }
		const start = Date.now();
		const deadline = start + 15_000;
		for (; ;) {
			try {
				const [state, committed] = (await this.evaluate(
					`[document.readyState, typeof window.${marker} === 'undefined']`
				)) as [string, boolean];
				// Same-document navigations (hash links) keep the marker, so after
				// a short grace accept a settled readyState on its own.
				const settled = state === 'complete' || state === 'interactive';
				if (settled && (committed || Date.now() - start > 3000)) { break; }
			} catch { /* mid-navigation: the JS context is being swapped */ }
			if (Date.now() > deadline) { break; }
			await new Promise((r) => setTimeout(r, 200));
		}
		// small settle for SPA hydration
		await new Promise((r) => setTimeout(r, 300));
		this.currentUrl = String(await this.evaluate('location.href').catch(() => url));
	}

	async screenshotBase64(): Promise<string> {
		const res = (await this.send('Page.captureScreenshot', { format: 'png' }, 20_000)) as { data?: string };
		if (!res.data) { throw new Error('screenshot returned no data'); }
		return res.data;
	}

	dispose(): void {
		this.disposed = true;
		instances.delete(this);
		this.alive = false;
		this.ws.close();
		try {
			if (process.platform === 'win32' && this.proc?.pid) {
				const killer = cp.spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true });
				killer.on('error', () => { /* taskkill missing — nothing else to try */ });
			} else {
				this.proc?.kill();
			}
		} catch { /* gone */ }
		this.proc = null;
		const dir = this.profileDir;
		this.profileDir = null;
		if (dir) {
			// Try once inline (deactivate exits before any timer would fire),
			// then again after the tree-kill has had time to release locks.
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still locked */ }
			setTimeout(() => {
				try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp GC gets it */ }
			}, 2000);
		}
	}
}

// ---- page-script helpers (built as strings, executed via evaluate) ---------

/** Find-element expression shared by click/type: selector first, then by
 *  visible text over clickable elements. Resolves to the element or null. */
function finderJs(target: string): string {
	const lit = JSON.stringify(target);
	return (
		'(() => {' +
		`const t = ${lit};` +
		// An empty target would make querySelector throw and then text-match the
		// first element with no visible text — i.e. click something at random.
		'if (!t || !t.trim()) { return null; }' +
		'let el = null;' +
		'try { el = document.querySelector(t); } catch (e) { el = null; }' +
		'if (!el) {' +
		'  const cands = [...document.querySelectorAll("a,button,input[type=button],input[type=submit],[role=button],[onclick],label,summary")];' +
		'  const q = t.toLowerCase();' +
		'  el = cands.find(c => (c.innerText || c.value || "").trim().toLowerCase() === q)' +
		'    || cands.find(c => (c.innerText || c.value || "").toLowerCase().includes(q));' +
		'}' +
		'return el;' +
		'})()'
	);
}

export function clickJs(target: string): string {
	return (
		'(() => {' +
		`const el = ${finderJs(target)};` +
		'if (!el) { return { ok: false, error: "no element matched" }; }' +
		'if (el.scrollIntoView) { el.scrollIntoView({ block: "center" }); }' +
		// click() lives on HTMLElement; SVG anchors and other non-HTML elements
		// need a synthesized event instead.
		'if (typeof el.click === "function") { el.click(); }' +
		'else { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); }' +
		// SVG anchors expose href as SVGAnimatedString, which serializes to {}.
		'return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || "").trim().slice(0, 80), href: (typeof el.href === "string" ? el.href : null) };' +
		'})()'
	);
}

export function typeJs(selector: string, text: string, pressEnter: boolean): string {
	const litText = JSON.stringify(text);
	return (
		'(() => {' +
		`const el = ${finderJs(selector)};` +
		'if (!el) { return { ok: false, error: "no element matched" }; }' +
		'el.focus();' +
		'if (el.isContentEditable) { el.textContent = ' + litText + '; }' +
		// The native value setter is receiver-checked: calling the input setter
		// on a <select>/<div> throws "Illegal invocation". Only use it for the
		// element types it belongs to, and reject anything with no value at all.
		'else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {' +
		'  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;' +
		'  const setter = Object.getOwnPropertyDescriptor(proto, "value");' +
		'  if (setter && setter.set) { setter.set.call(el, ' + litText + '); } else { el.value = ' + litText + '; }' +
		'}' +
		'else if ("value" in el) { el.value = ' + litText + '; }' +
		'else { return { ok: false, error: "element is not typable: <" + el.tagName.toLowerCase() + ">" }; }' +
		'el.dispatchEvent(new Event("input", { bubbles: true }));' +
		'el.dispatchEvent(new Event("change", { bubbles: true }));' +
		(pressEnter
			? 'el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));' +
			'el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));' +
			'if (el.form && el.form.requestSubmit) { el.form.requestSubmit(); }'
			: '') +
		'return { ok: true, tag: el.tagName.toLowerCase(), value: (el.value || el.textContent || "").slice(0, 80) };' +
		'})()'
	);
}
