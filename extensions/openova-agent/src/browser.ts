/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Browser tools for the agent: headless Edge/Chrome does the actual work
// (screenshot + DOM snapshot), while browser_open surfaces the URL in the
// Agents-window browser pane so the user can watch what the agent is checking.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';

let cachedBrowser: string | null | undefined;

/** Locate a headless-capable Chromium browser. Chrome first — msedge.exe
 *  detaches from the calling process on Windows, so its stdout (--dump-dom)
 *  is never capturable; Edge stays as a screenshot-only fallback. */
export function findBrowser(): string | null {
	if (cachedBrowser !== undefined) { return cachedBrowser; }
	const candidates =
		process.platform === 'win32'
			? [
				path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
				path.join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
				path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
				path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe')
			]
			: process.platform === 'darwin'
				? [
					'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
					'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
				]
				: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
	cachedBrowser = candidates.find((c) => {
		try { return fs.existsSync(c); } catch { return false; }
	}) ?? null;
	return cachedBrowser;
}

/** Turn "relative/page.html" or a URL into something the browser can load. */
export function resolveTarget(root: string, target: string): string {
	const t = target.trim();
	if (/^https?:\/\//i.test(t) || /^file:\/\//i.test(t)) { return t; }
	if (/^localhost[:/]|^127\.0\.0\.1[:/]/i.test(t)) { return `http://${t}`; }
	const full = path.isAbsolute(t) ? t : path.resolve(root, t);
	return 'file:///' + full.replace(/\\/g, '/');
}

function runBrowser(args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
	const exe = findBrowser();
	if (!exe) { return Promise.resolve({ ok: false, output: 'No Edge/Chrome installation found for headless browsing.' }); }
	return new Promise((resolve) => {
		// A dedicated profile dir keeps headless runs from handing off to an
		// already-running browser instance (which exits without output).
		const profile = path.join(os.tmpdir(), 'openova-headless');
		const child = cp.spawn(
			exe,
			['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, '--window-size=1280,900', ...args],
			{ windowsHide: true }
		);
		let output = '';
		const cap = (b: Buffer): void => {
			if (output.length < 2_000_000) { output += b.toString('utf8'); }
		};
		child.stdout?.on('data', cap);
		child.stderr?.on('data', () => { /* chromium logs freely — ignore */ });
		let done = false;
		const timer = setTimeout(() => {
			if (done) { return; }
			done = true;
			try { child.kill(); } catch { /* gone */ }
			resolve({ ok: false, output: 'Browser timed out.' });
		}, timeoutMs);
		child.on('error', (e) => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			resolve({ ok: false, output: e.message });
		});
		child.on('close', (code) => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			resolve({ ok: code === 0, output });
		});
	});
}

/** Persist a base64 PNG (e.g. a CDP capture) under .openova/assets. */
export function saveScreenshot(root: string, base64Png: string): string {
	const dir = path.join(root, '.openova', 'assets');
	try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
	const out = path.join(dir, `shot-${Date.now()}.png`);
	fs.writeFileSync(out, Buffer.from(base64Png, 'base64'));
	return out;
}

/** Screenshot a URL/file to a PNG under the workspace .openova/assets dir. */
export async function browserScreenshot(
	root: string,
	target: string
): Promise<{ ok: boolean; path?: string; error?: string }> {
	const url = resolveTarget(root, target);
	const dir = path.join(root, '.openova', 'assets');
	try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
	const out = path.join(dir, `shot-${Date.now()}.png`);
	const r = await runBrowser([`--screenshot=${out}`, url], 25_000);
	if (!r.ok && !fs.existsSync(out)) {
		return { ok: false, error: r.output.trim() || 'screenshot failed' };
	}
	return fs.existsSync(out) ? { ok: true, path: out } : { ok: false, error: 'screenshot failed' };
}

/** Reduce rendered HTML to readable text: drop script/style, keep the title
 *  and link hrefs (so the agent can navigate), collapse whitespace. */
export function htmlToText(rawHtml: string, url: string): string {
	let html = rawHtml;
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
	html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
	html = html.replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
		const t = String(inner).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		return t ? ` ${t} [link: ${href}] ` : ` [link: ${href}] `;
	});
	html = html.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n');
	const text = html
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, `'`)
		.split('\n')
		.map((l) => l.replace(/\s+/g, ' ').trim())
		.filter(Boolean)
		.join('\n')
		.slice(0, 8000);
	return `Page: ${url}${title ? `\nTitle: ${title}` : ''}\n\n${text || '(no visible text)'}`;
}

/** Render a URL/file headlessly (one-shot) and return its visible text. */
export async function browserSnapshot(root: string, target: string): Promise<string> {
	const url = resolveTarget(root, target);
	const r = await runBrowser(['--dump-dom', '--virtual-time-budget=4000', url], 25_000);
	if (!r.ok && !r.output.trim()) { return `Could not load ${url}.`; }
	return htmlToText(r.output, url);
}
