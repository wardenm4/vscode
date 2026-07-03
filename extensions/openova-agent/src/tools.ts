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

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.openova/**}';

export interface ToolHost {
	root: string;
	/** Commands the user allowed for the rest of this session. */
	sessionAllowed: Set<string>;
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

/** Ask the user to approve a command the gate didn't auto-allow. */
async function approveCommand(host: ToolHost, cmd: string, dangerous: boolean): Promise<boolean> {
	// Headless harness runs can't answer a modal — deny deterministically so
	// verification never hangs (the model is told the user declined).
	if (process.env.OPENOVA_DEV_TRIGGER) { return false; }
	if (!dangerous && host.sessionAllowed.has('*')) { return true; }
	const pick = await vscode.window.showWarningMessage(
		`Openova agent wants to run${dangerous ? ' a potentially destructive command' : ''}:`,
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

		codebaseSearch: async () => {
			// Semantic indexing hasn't been ported yet — the agent falls back to
			// exact search / reading files when this returns nothing.
			return [];
		},

		writeFile: async (rel, content) => {
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
			const verdict = classifyCommand(cmd, !!background);
			if (verdict.dangerous || !verdict.autoSafe) {
				const ok = await approveCommand(host, cmd, verdict.dangerous);
				if (!ok) { return { output: '', exitCode: null, denied: true }; }
			}
			if (background) {
				const term = vscode.window.createTerminal({ name: 'Openova agent', cwd: host.root });
				term.show(true);
				term.sendText(cmd, true);
				return { output: `(started in terminal: ${cmd})`, exitCode: 0 };
			}
			return runShell(cmd, host.root, 120_000);
		},

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
