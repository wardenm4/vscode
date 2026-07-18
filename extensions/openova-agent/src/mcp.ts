/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Minimal Model Context Protocol client over stdio (JSON-RPC 2.0, one JSON
// object per line), ported from the standalone Openova app. Hand-rolled to
// keep the dependency surface small — only initialize / tools/list /
// tools/call are needed.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

export interface McpToolInfo {
	server: string;
	name: string;
	description: string;
}

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

class McpClient {
	proc: ChildProcessWithoutNullStreams;
	tools: { name: string; description?: string }[] = [];
	ready = false;
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();

	constructor(
		public name: string,
		public command: string
	) {
		this.proc = spawn(command, [], {
			shell: true,
			windowsHide: true,
			env: { ...process.env }
		}) as ChildProcessWithoutNullStreams;
		// setEncoding uses a StringDecoder internally, so multi-byte UTF-8
		// characters split across chunk boundaries are decoded correctly.
		this.proc.stdout.setEncoding('utf8');
		this.proc.stdout.on('data', (d: string) => this.onData(d));
		this.proc.stderr.on('data', () => {
			/* servers log freely on stderr — ignore */
		});
		this.proc.on('error', () => this.dispose());
		this.proc.on('exit', () => this.dispose());
		this.proc.stdin.on('error', () => {
			/* swallow EPIPE */
		});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split('\n');
		this.buffer = lines.pop() ?? '';
		for (const line of lines) {
			const t = line.trim();
			if (!t) { continue; }
			try {
				const msg = JSON.parse(t) as {
					id?: number | string;
					method?: string;
					result?: unknown;
					error?: { message?: string };
				};
				// Server-initiated request (has BOTH id and method) — answer it so
				// spec-compliant servers (ping, roots/list) don't drop the session.
				if (msg.id !== undefined && typeof msg.method === 'string') {
					if (msg.method === 'ping') {
						this.write({ jsonrpc: '2.0', id: msg.id, result: {} });
					} else if (msg.method === 'roots/list') {
						this.write({ jsonrpc: '2.0', id: msg.id, result: { roots: [] } });
					} else {
						this.write({
							jsonrpc: '2.0',
							id: msg.id,
							error: { code: -32601, message: 'Method not found' }
						});
					}
					continue;
				}
				if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
					const p = this.pending.get(msg.id)!;
					this.pending.delete(msg.id);
					clearTimeout(p.timer);
					if (msg.error) { p.reject(new Error(msg.error.message ?? 'MCP error')); }
					else { p.resolve(msg.result); }
				}
			} catch {
				/* non-JSON line — ignore */
			}
		}
	}

	private write(obj: unknown): void {
		try {
			this.proc.stdin.write(JSON.stringify(obj) + '\n');
		} catch {
			/* ignore */
		}
	}

	request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP ${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
			} catch (e) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	notify(method: string, params: unknown): void {
		try {
			this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
		} catch {
			/* ignore */
		}
	}

	async init(): Promise<void> {
		await this.request('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'openova', version: '1.0.0' }
		});
		this.notify('notifications/initialized', {});
		const res = (await this.request('tools/list', {})) as {
			tools?: { name: string; description?: string }[];
		};
		this.tools = res.tools ?? [];
		this.ready = true;
	}

	async call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
		const res = (await this.request('tools/call', { name: tool, arguments: args }, 60_000)) as {
			content?: { type: string; text?: string }[];
			isError?: boolean;
		};
		const text = (res.content ?? [])
			.map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type} content]`))
			.join('\n');
		// Failure comes from the protocol's isError flag — never from sniffing text.
		return { ok: !res.isError, text: text || (res.isError ? 'tool call failed' : '(no output)') };
	}

	dispose(): void {
		this.ready = false;
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error('MCP server exited'));
		}
		this.pending.clear();
		try {
			// shell:true wraps the server in cmd.exe on Windows — kill the tree so
			// the actual server process doesn't get orphaned.
			if (process.platform === 'win32' && this.proc.pid) {
				spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true });
			} else {
				this.proc.kill();
			}
		} catch {
			/* ignore */
		}
	}
}

/**
 * Streamable HTTP transport (the modern MCP remote transport): JSON-RPC over
 * POST, with the session id carried in the Mcp-Session-Id header and
 * responses arriving as plain JSON or a single-response SSE stream.
 */
class HttpMcpClient {
	tools: { name: string; description?: string }[] = [];
	ready = false;
	private sessionId: string | undefined;
	private nextId = 1;

	constructor(
		public name: string,
		public url: string,
		private readonly headers: Record<string, string> = {}
	) { }

	private async post(body: unknown, expectReply: boolean, timeoutMs = 30_000): Promise<unknown> {
		const res = await fetch(this.url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
				...this.headers
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
		const sid = res.headers.get('mcp-session-id');
		if (sid) { this.sessionId = sid; }
		if (!expectReply) { return undefined; }
		if (!res.ok) { throw new Error(`MCP HTTP ${res.status}`); }
		const ctype = res.headers.get('content-type') ?? '';
		const text = await res.text();
		if (ctype.includes('text/event-stream')) {
			// Parse SSE: the reply is the last data: line carrying our id.
			let result: unknown;
			for (const line of text.split(/\r?\n/)) {
				if (!line.startsWith('data:')) { continue; }
				try {
					const msg = JSON.parse(line.slice(5).trim()) as { id?: number; result?: unknown; error?: { message?: string } };
					if (msg.id !== undefined) {
						if (msg.error) { throw new Error(msg.error.message ?? 'MCP error'); }
						result = msg.result;
					}
				} catch (e) {
					if (e instanceof Error && e.message !== 'Unexpected end of JSON input') { throw e; }
				}
			}
			return result;
		}
		if (!text.trim()) { return undefined; }
		const msg = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
		if (msg.error) { throw new Error(msg.error.message ?? 'MCP error'); }
		return msg.result;
	}

	request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
		return this.post({ jsonrpc: '2.0', id: this.nextId++, method, params }, true, timeoutMs);
	}

	async init(): Promise<void> {
		await this.request('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'openova', version: '1.0.0' }
		});
		await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, false);
		const res = (await this.request('tools/list', {})) as {
			tools?: { name: string; description?: string }[];
		};
		this.tools = res?.tools ?? [];
		this.ready = true;
	}

	async call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
		const res = (await this.request('tools/call', { name: tool, arguments: args }, 60_000)) as {
			content?: { type: string; text?: string }[];
			isError?: boolean;
		};
		const text = (res?.content ?? [])
			.map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type} content]`))
			.join('\n');
		return { ok: !res?.isError, text: text || (res?.isError ? 'tool call failed' : '(no output)') };
	}

	dispose(): void {
		this.ready = false;
	}
}

export interface McpServerConfig {
	name: string;
	command?: string;
	url?: string;
	headers?: Record<string, string>;
}

type AnyClient = McpClient | HttpMcpClient;
const clients = new Map<string, AnyClient>();
const clientKeys = new Map<string, string>();

function configKey(s: McpServerConfig): string {
	return s.url ? `http:${s.url}` : `stdio:${s.command}`;
}

/** Connect configured-but-not-connected servers, drop removed/dead ones, and
 *  return the full flattened tool list. Safe to call repeatedly. */
export async function ensureMcp(servers: McpServerConfig[]): Promise<McpToolInfo[]> {
	// Dedupe by name (first entry wins) and drop blank rows.
	const byName = new Map<string, McpServerConfig>();
	for (const s of servers) {
		if (s.name?.trim() && (s.command?.trim() || s.url?.trim()) && !byName.has(s.name)) {
			byName.set(s.name, s);
		}
	}
	// Drop removed servers, dead clients, and clients whose config changed.
	for (const [name, client] of clients) {
		const want = byName.get(name);
		if (!want || !client.ready || clientKeys.get(name) !== configKey(want)) {
			client.dispose();
			clients.delete(name);
			clientKeys.delete(name);
		}
	}
	await Promise.all(
		Array.from(byName.values())
			.filter((s) => !clients.has(s.name))
			.map(async (s) => {
				const client: AnyClient = s.url
					? new HttpMcpClient(s.name, s.url, s.headers ?? {})
					: new McpClient(s.name, s.command!);
				clients.set(s.name, client);
				clientKeys.set(s.name, configKey(s));
				try {
					await client.init();
				} catch {
					client.dispose();
					clients.delete(s.name);
					clientKeys.delete(s.name);
				}
			})
	);
	const out: McpToolInfo[] = [];
	for (const [name, client] of clients) {
		if (!client.ready) { continue; }
		for (const t of client.tools) {
			out.push({ server: name, name: t.name, description: (t.description ?? '').slice(0, 200) });
		}
	}
	return out;
}

export async function callMcp(
	server: string,
	tool: string,
	argsJson: string
): Promise<{ ok: boolean; output: string }> {
	const client = clients.get(server);
	if (!client?.ready) { return { ok: false, output: `MCP server "${server}" is not connected.` }; }
	let parsed: Record<string, unknown> = {};
	try {
		parsed = argsJson.trim() ? JSON.parse(argsJson) : {};
	} catch {
		return { ok: false, output: 'Arguments must be valid JSON.' };
	}
	try {
		const r = await client.call(tool, parsed);
		return { ok: r.ok, output: r.text.slice(0, 100_000) };
	} catch (e) {
		return { ok: false, output: e instanceof Error ? e.message : String(e) };
	}
}

export function disposeMcp(): void {
	for (const [, c] of clients) { c.dispose(); }
	clients.clear();
}
