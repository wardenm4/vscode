/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Workspace tool surface for the agent loop — the extension-host counterpart
// of the standalone app's store-level tools. File access goes through the
// vscode API; commands run through the SAME permission gate the standalone
// app shipped (dangerous commands always prompt, whatever the approval mode).
import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import type { AgentTools } from './lib/agent';
import { classifyCommand } from './lib/commandGate';
import { isDevRunActive } from './devMode';
import { searchCodebase, searchCodebaseSemantic, invalidateIndex } from './codebaseIndex';
import { detectEmbedder, type Embedder } from './lib/embeddings';

// Embedder detection probes local servers, so cache the answer for the
// session (re-probed when the settings change).
let embedderCache: { key: string; value: Embedder | null } | undefined;

async function embedderForWorkspace(): Promise<Embedder | null> {
	const cfg = vscode.workspace.getConfiguration('openova');
	const mode = cfg.get<string>('embeddings', 'auto');
	if (mode === 'off') { return null; }
	const baseURL = cfg.get<string>('embeddingBaseUrl', '').trim();
	const model = cfg.get<string>('embeddingModel', '').trim();
	const key = `${mode}|${baseURL}|${model}`;
	if (embedderCache?.key === key) { return embedderCache.value; }
	const value = await detectEmbedder({ baseURL, model });
	embedderCache = { key, value };
	return value;
}

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.openova/**}';

export interface ToolHost {
	root: string;
	/** Commands the user allowed for the rest of this session. */
	sessionAllowed: Set<string>;
	/** Extension storage dir for the semantic index's vector cache. */
	cacheDir?: string;
	/** Reports which ranking a codebase_search used (for status/tracing). */
	onSearchMode?: (mode: 'semantic' | 'lexical', hits: number) => void;
	/** Diagnostic breadcrumbs for the semantic index (dev tracing). */
	onDebug?: (msg: string) => void;
	/** Reports a file write for the run ledger (review bar / undo). `isNew`
	 *  comes from a real existence check — never inferred from `before`. */
	onWrite?: (info: { relPath: string; fullPath: string; existed: boolean; before: string; content: string }) => void;
}

function resolveInRoot(root: string, rel: string): string {
	const full = path.resolve(root, rel);
	const normRoot = path.resolve(root) + path.sep;
	if (full !== path.resolve(root) && !full.startsWith(normRoot)) {
		throw new Error(`Path escapes the workspace: ${rel}`);
	}
	return full;
}

// ---- security axes (Codex-style: sandbox x approval, independent) ----------
// sandbox:  read-only | workspace-write | full-access — what the agent MAY do.
// approval: untrusted | on-request | never — when the user is ASKED.
// Enforcement is application-layer on Windows (no kernel sandbox available);
// the settings descriptions say so honestly.

export interface SecurityConfig {
	sandbox: 'read-only' | 'workspace-write' | 'full-access';
	approval: 'untrusted' | 'on-request' | 'never';
	network: boolean;
}

export function securityConfig(): SecurityConfig {
	const cfg = vscode.workspace.getConfiguration('openova');
	const sandbox = cfg.get<string>('sandbox', 'workspace-write') as SecurityConfig['sandbox'];
	let approval = cfg.get<string>('approval', '') as SecurityConfig['approval'] | '';
	if (!approval) {
		// Legacy mapping: permissionMode auto → never, ask → untrusted.
		approval = cfg.get<string>('permissionMode', 'ask') === 'auto' ? 'never' : 'untrusted';
	}
	return { sandbox, approval, network: cfg.get<boolean>('networkAccess', false) };
}

/** Paths the agent must never write, whatever the sandbox mode. */
function isProtectedWrite(rel: string): boolean {
	const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
	return /^(\.git|\.openova)(\/|$)/i.test(norm);
}

/** Commands that reach the network (approval-gated when network access is off). */
function isNetworkCommand(cmd: string): boolean {
	return /(^|[\s;&|])(curl|wget|iwr|invoke-webrequest|invoke-restmethod|ping|ssh|scp|sftp|telnet|nc|ncat)\b/i.test(cmd);
}

async function runShell(
	cmd: string,
	cwd: string,
	timeoutMs: number
): Promise<{ output: string; exitCode: number | null; timedOut?: boolean }> {
	return new Promise((resolve) => {
		const child = cp.spawn(cmd, [], { shell: true, cwd, windowsHide: true });
		let output = '';
		let done = false;
		const cap = (chunk: Buffer): void => {
			if (output.length < 200_000) { output += chunk.toString('utf8'); }
		};
		child.stdout?.on('data', cap);
		child.stderr?.on('data', cap);
		const timer = setTimeout(() => {
			if (done) { return; }
			done = true;
			try {
				if (process.platform === 'win32' && child.pid) {
					cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
				} else {
					child.kill('SIGKILL');
				}
			} catch {
				/* best effort */
			}
			resolve({ output, exitCode: null, timedOut: true });
		}, timeoutMs);
		child.on('error', (e) => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			resolve({ output: `${output}\n${e.message}`, exitCode: null });
		});
		child.on('close', (code) => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			resolve({ output, exitCode: code });
		});
	});
}

// ---- background jobs (awaitable) -------------------------------------------
// Background commands run as tracked child processes so the agent can `await`
// their output or exit — Cursor/Codex-style "start the dev server, then wait
// for it to say ready". Output also mirrors to an output channel for the user.

interface BgJob {
	id: number;
	cmd: string;
	output: string;
	exitCode: number | null;
	done: boolean;
}

const bgJobs = new Map<number, BgJob>();
let nextJobId = 1;
let jobChannel: vscode.OutputChannel | undefined;

function startBgJob(cmd: string, cwd: string): BgJob {
	jobChannel ??= vscode.window.createOutputChannel('Openova agent jobs');
	const job: BgJob = { id: nextJobId++, cmd, output: '', exitCode: null, done: false };
	bgJobs.set(job.id, job);
	jobChannel.appendLine(`[job ${job.id}] $ ${cmd}`);
	try {
		const child = cp.spawn(cmd, [], { shell: true, cwd, windowsHide: true });
		const cap = (chunk: Buffer): void => {
			const text = chunk.toString('utf8');
			if (job.output.length < 200_000) { job.output += text; }
			jobChannel!.append(text);
		};
		child.stdout?.on('data', cap);
		child.stderr?.on('data', cap);
		child.on('error', (e) => {
			job.output += `\n${e.message}`;
			job.done = true;
		});
		child.on('close', (code) => {
			job.exitCode = code;
			job.done = true;
			jobChannel!.appendLine(`\n[job ${job.id}] exited ${code}`);
		});
	} catch (e) {
		job.output = e instanceof Error ? e.message : String(e);
		job.done = true;
	}
	return job;
}

/**
 * Wait for a background job to exit, or for a pattern to appear in its
 * output, or for a plain number of seconds. Returns the observation text.
 */
export async function awaitTool(args: {
	job?: string;
	pattern?: string;
	seconds?: string;
	timeout?: string;
}): Promise<string> {
	const timeoutMs = Math.min(Math.max((Number(args.timeout) || 60), 1), 600) * 1000;
	// Plain sleep: <tool name="await" seconds="5"/>
	if (args.seconds && !args.job && !args.pattern) {
		const ms = Math.min(Math.max(Number(args.seconds) || 1, 1), 300) * 1000;
		await new Promise((r) => setTimeout(r, ms));
		return `Waited ${ms / 1000}s.`;
	}
	// Resolve the job: explicit id, else the most recent one.
	const id = args.job ? Number(args.job) : Math.max(0, ...bgJobs.keys());
	const job = bgJobs.get(id);
	if (!job) {
		return bgJobs.size
			? `No background job #${args.job}. Running jobs: ${[...bgJobs.keys()].join(', ')}`
			: 'No background jobs have been started (use run_command with background="true" first).';
	}
	const start = Date.now();
	const patt = args.pattern?.trim();
	for (; ;) {
		if (patt && job.output.toLowerCase().includes(patt.toLowerCase())) {
			return `Job ${job.id} output matched "${patt}":\n${job.output.slice(-4000)}`;
		}
		if (job.done) {
			return `Job ${job.id} exited ${job.exitCode}. Output:\n${job.output.slice(-6000)}`;
		}
		if (Date.now() - start > timeoutMs) {
			return `Timed out after ${timeoutMs / 1000}s waiting on job ${job.id} (still running). Output so far:\n${job.output.slice(-4000)}`;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** Ask the user to approve a command the gate didn't auto-allow. */
async function approveCommand(
	host: ToolHost,
	cmd: string,
	reason: 'destructive' | 'network' | 'command'
): Promise<boolean> {
	// Headless harness runs can't answer a modal — deny deterministically so
	// verification never hangs (the model is told the user declined). Scoped
	// to the harness's own run: user turns in the same instance prompt normally.
	if (isDevRunActive()) { return false; }
	const dangerous = reason === 'destructive';
	if (!dangerous && host.sessionAllowed.has('*')) { return true; }
	const label =
		reason === 'destructive' ? ' a potentially destructive command'
			: reason === 'network' ? ' a command that reaches the network'
				: ' a command';
	const pick = await vscode.window.showWarningMessage(
		`Openova agent wants to run${label}:`,
		{ modal: true, detail: cmd },
		'Run',
		...(dangerous ? [] : ['Always allow this session'])
	);
	if (pick === 'Always allow this session') {
		host.sessionAllowed.add('*');
		return true;
	}
	return pick === 'Run';
}

export function createTools(host: ToolHost): AgentTools {
	return {
		listFiles: async () => {
			const uris = await vscode.workspace.findFiles('**/*', EXCLUDE, 1000);
			const rootUri = path.resolve(host.root);
			return uris
				.map((u) => path.relative(rootUri, u.fsPath).replace(/\\/g, '/'))
				.filter(Boolean)
				.sort();
		},

		readFile: async (rel) => {
			const full = resolveInRoot(host.root, rel);
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(full));
			return new TextDecoder().decode(bytes);
		},

		search: async (query) => {
			const uris = await vscode.workspace.findFiles('**/*', EXCLUDE, 300);
			const results: { file: string; line: number; preview: string }[] = [];
			const needle = query.toLowerCase();
			for (const u of uris) {
				if (results.length >= 40) { break; }
				let text: string;
				try {
					const bytes = await vscode.workspace.fs.readFile(u);
					if (bytes.byteLength > 262_144) { continue; }
					text = new TextDecoder().decode(bytes);
				} catch {
					continue;
				}
				if (text.includes(String.fromCharCode(0))) { continue; }
				const lines = text.split(/\r\n|\r|\n/);
				for (let i = 0; i < lines.length && results.length < 40; i++) {
					if (lines[i].toLowerCase().includes(needle)) {
						results.push({
							file: path.relative(host.root, u.fsPath).replace(/\\/g, '/'),
							line: i + 1,
							preview: lines[i].trim().slice(0, 200)
						});
					}
				}
			}
			return results;
		},

		codebaseSearch: async (query) => {
			// Hybrid when a local embedder is reachable AND the corpus is fully
			// embedded; plain BM25 otherwise (the embedding pass warms up in the
			// background so later searches upgrade themselves).
			const embedder = host.cacheDir ? await embedderForWorkspace() : null;
			host.onDebug?.(
				`index: cacheDir=${host.cacheDir ? 'yes' : 'MISSING'} embedder=${embedder ? `${embedder.kind}/${embedder.model}` : 'none'}`
			);
			if (embedder && host.cacheDir) {
				const r = await searchCodebaseSemantic(host.root, query, {
					cacheDir: host.cacheDir,
					embedder,
					alpha: vscode.workspace.getConfiguration('openova').get<number>('embeddingWeight', 0.5),
					onProgress: (done, total) => {
						if (done === total || done % 64 === 0) { host.onDebug?.(`embedding ${done}/${total}`); }
					},
					onEvent: (msg) => host.onDebug?.(msg)
				});
				host.onSearchMode?.(r.mode, r.hits.length);
				return r.hits;
			}
			const hits = searchCodebase(host.root, query);
			host.onSearchMode?.('lexical', hits.length);
			return hits;
		},

		writeFile: async (rel, content) => {
			const sec = securityConfig();
			if (sec.sandbox === 'read-only') {
				throw new Error('The sandbox is read-only — file writes are disabled (openova.sandbox).');
			}
			if (isProtectedWrite(rel)) {
				throw new Error(`Writes to ${rel} are blocked (.git and .openova are protected).`);
			}
			const full = resolveInRoot(host.root, rel);
			const uri = vscode.Uri.file(full);
			let existed = true;
			let before = '';
			try {
				before = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
			} catch {
				existed = false;
			}
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
			// The search index must not serve pre-write content back to the
			// agent that just wrote the file.
			invalidateIndex(host.root);
			host.onWrite?.({ relPath: rel, fullPath: full, existed, before, content });
			// Surface any known problems for this file so the model can self-correct.
			const probs = vscode.languages
				.getDiagnostics(vscode.Uri.file(full))
				.filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
				.slice(0, 10);
			return probs.length
				? `Problems detected in ${rel}:\n` +
				probs.map((d) => `  line ${d.range.start.line + 1}: ${d.message}`).join('\n')
				: '';
		},

		runCommand: async (cmd, background) => {
			const sec = securityConfig();
			const verdict = classifyCommand(cmd, !!background);
			const net = !sec.network && isNetworkCommand(cmd);
			// Decision matrix: the sandbox axis decides what MAY run; the
			// approval axis decides when to ASK for the rest.
			let prompt: 'destructive' | 'network' | 'command' | null = null;
			if (sec.sandbox === 'read-only') {
				prompt = verdict.dangerous ? 'destructive' : 'command';
			} else if (verdict.dangerous) {
				prompt = sec.approval === 'never' ? null : 'destructive';
			} else if (net) {
				prompt = sec.approval === 'never' ? null : 'network';
			} else if (!verdict.autoSafe) {
				// untrusted asks for everything non-trivial; on-request lets the
				// agent work inside the sandbox and only asks for escalations.
				prompt = sec.approval === 'untrusted' ? 'command' : null;
			}
			if (prompt) {
				const ok = await approveCommand(host, cmd, prompt);
				if (!ok) { return { output: `(declined: ${prompt} approval)`, exitCode: null, denied: true }; }
			}
			// Commands create/modify files too (installs, generators, builds).
			invalidateIndex(host.root);
			if (background) {
				const job = startBgJob(cmd, host.root);
				return {
					output: `(started background job ${job.id}: ${cmd} — use <tool name="await" job="${job.id}"> to wait for output or exit)`,
					exitCode: 0
				};
			}
			return runShell(cmd, host.root, 120_000);
		},

		awaitJob: (args) => awaitTool(args),

		check: undefined // wired by the caller when openova.checkCommand is set
	};
}

/** Build the optional finish-gate check from user configuration. */
export function createCheck(host: ToolHost): (() => Promise<{ output: string; exitCode: number | null }>) | undefined {
	const cmd = vscode.workspace.getConfiguration('openova').get<string>('checkCommand', '').trim();
	if (!cmd) { return undefined; }
	return async () => {
		const r = await runShell(cmd, host.root, 180_000);
		return { output: r.output, exitCode: r.timedOut ? null : r.exitCode };
	};
}
