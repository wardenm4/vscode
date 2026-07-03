/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Openova Agent — built-in extension hosting the AI chat/agent sidebar.
// The extension host owns sessions, provider streaming, the agent loop, and
// the command permission gate (ported from the standalone Openova app); the
// webview renders and sends user intents over a postMessage bridge.
import * as vscode from 'vscode';
import { runChat, abortRequest, listModels } from './lib/ai';
import { runAgent } from './lib/agent';
import { providerInfo, PROVIDERS } from './lib/providers';
import type { AIProvider } from './types';
import { createTools, createCheck, ToolHost } from './tools';

interface UiStep {
	id: string;
	kind: string;
	title: string;
	status: 'running' | 'done' | 'error';
	detail?: string;
}

interface UiMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	steps?: UiStep[];
}

interface Session {
	id: string;
	title: string;
	messages: UiMessage[];
}

interface RunState {
	stop: boolean;
	requestId: string | null;
}

const uid = (): string => Math.random().toString(36).slice(2);

// Bring-up tracing for headless verification — writes only when the
// OPENOVA_DEV_TRACE env var names a log file; inert otherwise.
import * as fs from 'fs';
function trace(msg: string): void {
	const p = process.env.OPENOVA_DEV_TRACE;
	if (!p) { return; }
	try {
		fs.appendFileSync(p, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		/* ignore */
	}
}

export function activate(context: vscode.ExtensionContext): void {
	trace('activate');
	const provider = new OpenovaChatViewProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('openova.chat', provider, {
			webviewOptions: { retainContextWhenHidden: true }
		}),
		vscode.commands.registerCommand('openova.focusChat', () =>
			vscode.commands.executeCommand('openova.chat.focus')
		),
		vscode.commands.registerCommand('openova.newAgent', () => {
			void vscode.commands.executeCommand('openova.chat.focus');
			provider.newSession();
		}),
		// Deep link: openova://openova.openova-agent/run?mode=agent&text=…
		vscode.window.registerUriHandler({
			handleUri(uri: vscode.Uri): void {
				trace(`handleUri ${uri.toString()}`);
				if (uri.path !== '/run') { return; }
				const params = new URLSearchParams(uri.query);
				const text = params.get('text') ?? '';
				const mode = params.get('mode') === 'ask' ? 'ask' : 'agent';
				if (!text.trim()) { return; }
				void vscode.commands.executeCommand('openova.chat.focus');
				provider.startRun(text, mode);
			}
		})
	);

	// Headless bring-up harness: when OPENOVA_DEV_TRIGGER points at a JSON file
	// ({"text","mode"}), consume it and run — lets CI/agents verify a real run
	// without synthetic input. Env-gated; inert for normal users.
	const triggerPath = process.env.OPENOVA_DEV_TRIGGER;
	if (triggerPath) {
		setTimeout(() => {
			try {
				if (!fs.existsSync(triggerPath)) { return; }
				const req = JSON.parse(fs.readFileSync(triggerPath, 'utf8')) as {
					text?: string;
					mode?: string;
				};
				fs.unlinkSync(triggerPath);
				trace(`devTrigger ${JSON.stringify(req)}`);
				if (req.text) { provider.startRun(req.text, req.mode === 'ask' ? 'ask' : 'agent'); }
			} catch (e) {
				trace(`devTrigger error ${e instanceof Error ? e.message : String(e)}`);
			}
		}, 3000);
	}
}

export function deactivate(): void {
	// In-flight model requests die with the extension host process.
}

class OpenovaChatViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private sessions: Session[] = [];
	private activeSession: string | null = null;
	private readonly runs = new Map<string, RunState>();
	private readonly sessionAllowed = new Set<string>();

	constructor(private readonly context: vscode.ExtensionContext) {
		const saved = context.workspaceState.get<{ sessions: Session[]; active: string | null }>(
			'openova.sessions'
		);
		if (saved?.sessions?.length) {
			this.sessions = saved.sessions;
			this.activeSession = saved.active ?? saved.sessions[0].id;
		}
		if (this.sessions.length === 0) {
			this.newSessionInternal();
		}
	}

	// ---- session management -------------------------------------------------

	newSession(): void {
		this.newSessionInternal();
		this.persist();
		this.postSessions();
	}

	/** Programmatic entry point (URI handler / commands): run in the active session. */
	startRun(text: string, mode: 'ask' | 'agent'): void {
		const sessionId = this.activeSession;
		trace(`startRun mode=${mode} session=${sessionId} busy=${!!(sessionId && this.runs.get(sessionId))}`);
		if (!sessionId || this.runs.get(sessionId)) { return; }
		if (mode === 'agent') { void this.sendAgent(sessionId, text); }
		else { void this.sendAsk(sessionId, text); }
	}

	private newSessionInternal(): void {
		const existing = this.sessions.find((s) => s.messages.length === 0);
		if (existing) {
			this.activeSession = existing.id;
			return;
		}
		const s: Session = { id: uid(), title: 'New Chat', messages: [] };
		this.sessions.unshift(s);
		this.activeSession = s.id;
	}

	private persist(): void {
		// Cap history; drop transient run-only fields if any creep in.
		void this.context.workspaceState.update('openova.sessions', {
			sessions: this.sessions.slice(0, 40),
			active: this.activeSession
		});
	}

	private post(msg: Record<string, unknown>): void {
		void this.view?.webview.postMessage(msg);
	}

	private postSessions(): void {
		this.post({ type: 'sessions', sessions: this.sessions, active: this.activeSession });
	}

	private settings(): { provider: AIProvider; model: string; effort: string; baseUrl: string } {
		const cfg = vscode.workspace.getConfiguration('openova');
		return {
			provider: cfg.get<string>('provider', 'ollama') as AIProvider,
			model: cfg.get<string>('model', 'qwen3.5:9b'),
			effort: cfg.get<string>('reasoningEffort', 'off'),
			baseUrl: cfg.get<string>('baseUrl', '')
		};
	}

	private session(id: string): Session | undefined {
		return this.sessions.find((s) => s.id === id);
	}

	private mutateMsg(sessionId: string, msgId: string, fn: (m: UiMessage) => void): void {
		const sess = this.session(sessionId);
		const msg = sess?.messages.find((m) => m.id === msgId);
		if (msg) { fn(msg); }
	}

	// ---- webview ------------------------------------------------------------

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
		};
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((msg: Record<string, unknown>) => {
			void this.onMessage(msg);
		});
	}

	private async onMessage(msg: Record<string, unknown>): Promise<void> {
		switch (msg.type) {
			case 'ready': {
				const s = this.settings();
				this.post({
					type: 'init',
					sessions: this.sessions,
					active: this.activeSession,
					settings: s,
					workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? null,
					providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label }))
				});
				break;
			}
			case 'newSession':
				this.newSession();
				break;
			case 'switchSession':
				this.activeSession = String(msg.id);
				this.persist();
				this.postSessions();
				break;
			case 'deleteSession': {
				const id = String(msg.id);
				this.abort(id);
				this.sessions = this.sessions.filter((s) => s.id !== id);
				if (this.sessions.length === 0) { this.newSessionInternal(); }
				if (this.activeSession === id) { this.activeSession = this.sessions[0].id; }
				this.persist();
				this.postSessions();
				break;
			}
			case 'send': {
				const sessionId = String(msg.sessionId ?? this.activeSession ?? '');
				const text = String(msg.text ?? '').trim();
				const mode = msg.mode === 'agent' ? 'agent' : 'ask';
				if (!text || !this.session(sessionId)) { return; }
				if (this.runs.get(sessionId)) { return; } // one run per session
				if (mode === 'agent') { await this.sendAgent(sessionId, text); }
				else { await this.sendAsk(sessionId, text); }
				break;
			}
			case 'abort':
				this.abort(String(msg.sessionId ?? this.activeSession ?? ''));
				break;
			case 'setSettings': {
				const cfg = vscode.workspace.getConfiguration('openova');
				const patch = (msg.patch ?? {}) as Record<string, string>;
				for (const [key, val] of Object.entries(patch)) {
					if (['provider', 'model', 'reasoningEffort', 'baseUrl'].includes(key)) {
						await cfg.update(key, val, vscode.ConfigurationTarget.Global);
					}
				}
				this.post({ type: 'settings', settings: this.settings() });
				break;
			}
			case 'listModels': {
				const s = this.settings();
				const info = providerInfo(s.provider);
				const r = await listModels({
					kind: info.kind,
					baseURL: s.baseUrl || info.baseURL,
					apiKey: undefined
				});
				this.post({ type: 'models', models: r.ok ? r.models : [], error: r.error });
				break;
			}
		}
	}

	private abort(sessionId: string): void {
		const run = this.runs.get(sessionId);
		if (!run) { return; }
		run.stop = true;
		if (run.requestId) { abortRequest(run.requestId); }
	}

	// ---- ask mode -----------------------------------------------------------

	private async sendAsk(sessionId: string, text: string): Promise<void> {
		const sess = this.session(sessionId)!;
		const userMsg: UiMessage = { id: uid(), role: 'user', content: text };
		const reply: UiMessage = { id: uid(), role: 'assistant', content: '' };
		if (sess.messages.length === 0) { sess.title = text.slice(0, 40); }
		sess.messages.push(userMsg, reply);
		this.postSessions();
		this.post({ type: 'running', sessionId, running: true });

		const run: RunState = { stop: false, requestId: uid() };
		this.runs.set(sessionId, run);
		const s = this.settings();
		const history = sess.messages
			.filter((m) => m.id !== reply.id && !m.steps)
			.map((m) => ({ role: m.role, content: m.content }));
		try {
			let out = '';
			await runChat({
				requestId: run.requestId!,
				provider: s.provider,
				baseURL: s.baseUrl || undefined,
				model: s.model,
				system:
					'You are Openova, an expert AI coding assistant inside a code editor. Be concise and direct.',
				messages: history,
				temperature: 0.4,
				maxTokens: 4096,
				reasoningEffort: s.effort,
				onDelta: (d) => {
					out += d;
					this.post({ type: 'live', sessionId, msgId: reply.id, text: out });
				},
				onError: (e) => {
					out += `\n\n**Error:** ${e}`;
				}
			});
			const clean = out.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
			this.mutateMsg(sessionId, reply.id, (m) => {
				m.content = clean || out.trim() || '(no reply)';
			});
		} finally {
			this.runs.delete(sessionId);
			this.persist();
			this.postSessions();
			this.post({ type: 'running', sessionId, running: false });
		}
	}

	// ---- agent mode ---------------------------------------------------------

	private async sendAgent(sessionId: string, text: string): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		trace(`sendAgent root=${root ?? 'NONE'} model=${this.settings().model}`);
		if (!root) {
			void vscode.window.showErrorMessage('Openova: open a folder to run the agent.');
			return;
		}
		const sess = this.session(sessionId)!;
		const userMsg: UiMessage = { id: uid(), role: 'user', content: text };
		const agentMsg: UiMessage = { id: uid(), role: 'assistant', content: '', steps: [] };
		if (sess.messages.length === 0) { sess.title = text.slice(0, 40); }
		sess.messages.push(userMsg, agentMsg);
		this.postSessions();
		this.post({ type: 'running', sessionId, running: true });

		const run: RunState = { stop: false, requestId: null };
		this.runs.set(sessionId, run);

		const addStep = (step: UiStep): void => {
			this.mutateMsg(sessionId, agentMsg.id, (m) => m.steps!.push(step));
			this.post({ type: 'step', sessionId, msgId: agentMsg.id, step });
		};
		const patchStep = (id: string, patch: Partial<UiStep>): void => {
			this.mutateMsg(sessionId, agentMsg.id, (m) => {
				const st = m.steps!.find((x) => x.id === id);
				if (st) { Object.assign(st, patch); }
			});
			this.post({ type: 'stepUpdate', sessionId, msgId: agentMsg.id, id, patch });
		};
		let currentToolId: string | null = null;

		const host: ToolHost = { root, sessionAllowed: this.sessionAllowed };
		const tools = createTools(host);
		tools.check = createCheck(host);
		const s = this.settings();

		const title = (name: string, args: Record<string, unknown>): string => {
			switch (name) {
				case 'list_files': return 'Listed workspace files';
				case 'read_file': return `Read ${String(args.path ?? '')}`;
				case 'search': return `Searched "${String(args.query ?? '')}"`;
				case 'codebase_search': return `Codebase search "${String(args.query ?? '')}"`;
				case 'write_file': return `Edited ${String(args.path ?? '')}`;
				case 'run_command': return `$ ${String(args.cmd ?? '').slice(0, 80)}`;
				case 'subagent': return `Subagent: ${String(args.task ?? '').slice(0, 60)}`;
				case 'check': return 'Running checks';
				default: return name;
			}
		};

		try {
			await runAgent(
				text,
				tools,
				{
					provider: s.provider,
					baseURL: s.baseUrl || undefined,
					model: s.model,
					maxTokens: 8192
				},
				{
					onThought: (t) => addStep({ id: uid(), kind: 'thought', title: t, status: 'done' }),
					onAction: (name, args) => {
						currentToolId = uid();
						addStep({ id: currentToolId, kind: name, title: title(name, args), status: 'running' });
					},
					onObservation: (obs, isError) => {
						if (currentToolId) {
							patchStep(currentToolId, {
								status: isError ? 'error' : 'done',
								detail: obs.slice(0, 2000)
							});
							currentToolId = null;
						}
					},
					onFinish: (summary) => {
						addStep({ id: uid(), kind: 'finish', title: summary, status: 'done' });
						this.mutateMsg(sessionId, agentMsg.id, (m) => {
							m.content = summary;
						});
					},
					onError: (e) => addStep({ id: uid(), kind: 'error', title: e, status: 'error' }),
					shouldStop: () => this.runs.get(sessionId)?.stop ?? true,
					onRequestStart: (rid) => {
						const r = this.runs.get(sessionId);
						if (r) { r.requestId = rid; }
					},
					onStreamDelta: (full) => {
						// Strip tool payloads from the live view — show the reasoning only.
						const cleaned = full
							.replace(/<think(?:ing)?>[\s\S]*?(<\/think(?:ing)?>|$)/gi, '')
							.replace(/<tool[\s\S]*$/i, '')
							.trim();
						this.post({ type: 'live', sessionId, msgId: agentMsg.id, text: cleaned.slice(0, 500) });
					}
				}
			);
		} finally {
			this.runs.delete(sessionId);
			this.post({ type: 'live', sessionId, msgId: agentMsg.id, text: '' });
			this.persist();
			this.postSessions();
			this.post({ type: 'running', sessionId, running: false });
		}
	}

	// ---- shell --------------------------------------------------------------

	private html(webview: vscode.Webview): string {
		const nonce = uid() + uid();
		const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
		const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
		const icon = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'nova.svg'));
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${css}">
</head>
<body data-icon="${icon}">
	<div id="app"></div>
	<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
	}
}
