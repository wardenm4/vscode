/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Openova Agent — built-in extension hosting the AI chat/agent sidebar.
// The extension host owns sessions, provider streaming, the agent loop, the
// run write-ledger (review bar / undo), queued follow-ups and the command
// permission gate (all ported from the standalone Openova app); the webview
// renders and sends user intents over a postMessage bridge.
import * as vscode from 'vscode';
import { runChat, complete, abortRequest, listModels } from './lib/ai';
import { registerTabCompletions, completeAtPosition } from './completions';
import { runAgent } from './lib/agent';
import { providerInfo, PROVIDERS } from './lib/providers';
import { lineDiff } from './lib/diff';
import type { AIProvider } from './types';
import { createTools, createCheck, ToolHost } from './tools';
import { ensureMcp, callMcp, disposeMcp } from './mcp';
import { initKeys, getApiKey, setApiKey, hasApiKey } from './keys';
import { setDevRunActive, isDevRunActive } from './devMode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';

interface UiStep {
	id: string;
	kind: string;
	title: string;
	status: 'running' | 'done' | 'error';
	detail?: string;
}

/** One file a run touched — a row in the post-run review bar. */
interface WriteEntry {
	path: string;
	fullPath: string;
	added: number;
	removed: number;
	/** Pre-run contents (first write wins); undefined = not kept (too large). */
	before?: string;
	/** True when the file did not exist before the run (undo = delete). */
	isNew: boolean;
}

interface PlanStep {
	id: string;
	text: string;
	done: boolean;
}

interface Plan {
	title: string;
	status: 'proposed' | 'running' | 'done' | 'cancelled';
	steps: PlanStep[];
}

interface UiMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	steps?: UiStep[];
	writes?: WriteEntry[];
	reviewDismissed?: boolean;
	plan?: Plan;
	/** Set while an agent run is paused at its step budget (value = steps used). */
	paused?: number;
	/** Set while the agent is waiting on a user answer (ask_user tool). */
	pendingQuestion?: { qid: string; question: string; options: string[] };
	/** Wall-clock duration of the finished run, for "Worked for Ns". */
	durationMs?: number;
	/** Creation time (for the hover "Nm ago" meta row). */
	at?: number;
}

interface Session {
	id: string;
	title: string;
	messages: UiMessage[];
	updatedAt?: number;
}

interface QueuedItem {
	id: string;
	text: string;
	mode: 'ask' | 'agent' | 'plan';
}

interface Automation {
	id: string;
	name: string;
	prompt: string;
	everyMinutes: number;
	enabled: boolean;
	lastRun?: number;
}

interface RepoEntry {
	path: string;
	name: string;
	lastOpened: number;
	sessions: { id: string; title: string; updatedAt?: number }[];
}

interface RunState {
	stop: boolean;
	requestId: string | null;
}

const uid = (): string => Math.random().toString(36).slice(2);
const MAX_BEFORE = 262_144;

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

/**
 * LM Studio ships a CLI (`lms`) that can wake its local server headlessly.
 * When discovery can't reach the server, start it instead of telling the
 * user to. Returns true if the CLI was found and invoked.
 */
async function tryStartLmStudioServer(): Promise<boolean> {
	const home = os.homedir();
	const lms = [
		path.join(home, '.lmstudio', 'bin', 'lms.exe'),
		path.join(home, '.lmstudio', 'bin', 'lms')
	].find((p) => fs.existsSync(p));
	if (!lms) { return false; }
	trace('lmstudio: starting server via lms CLI');
	return new Promise<boolean>((resolve) => {
		try {
			const child = cp.spawn(lms, ['server', 'start'], { stdio: 'ignore', windowsHide: true });
			const timer = setTimeout(() => resolve(true), 12_000);
			child.once('error', () => { clearTimeout(timer); resolve(false); });
			child.once('exit', () => { clearTimeout(timer); resolve(true); });
		} catch {
			resolve(false);
		}
	});
}

export function activate(context: vscode.ExtensionContext): void {
	trace('activate');
	initKeys(context);
	const provider = new OpenovaChatViewProvider(context);
	registerTabCompletions(context);
	// Automations scheduler: a minute tick runs whatever is due.
	const automationTimer = setInterval(() => void provider.tickAutomations(), 60_000);
	context.subscriptions.push({ dispose: () => clearInterval(automationTimer) });
	context.subscriptions.push({ dispose: () => provider.killTerm() });
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
		vscode.commands.registerCommand('openova.openAgentsWindow', () => {
			void provider.openAgentsWindow();
		}),
		// Restores the Agents window (incl. its floating OS window) across restarts.
		vscode.window.registerWebviewPanelSerializer('openova.agents', {
			deserializeWebviewPanel: async (panel) => {
				provider.adoptPanel(panel);
			}
		}),
		// Inline edit (Ctrl+I): rewrite the selection (or current line) per an
		// instruction, streamed from the configured model, applied in place —
		// the editor's undo stack is the rollback.
		vscode.commands.registerCommand(
			'openova.inlineEdit',
			async (args?: { instruction?: string }) => {
				const editor = vscode.window.activeTextEditor;
				if (!editor) { return; }
				const doc = editor.document;
				const sel = editor.selection;
				const range = sel.isEmpty
					? doc.lineAt(sel.active.line).range
					: new vscode.Range(sel.start, sel.end);
				const instruction =
					args?.instruction ??
					(await vscode.window.showInputBox({
						prompt: 'Openova inline edit',
						placeHolder: 'e.g. add error handling, convert to async, fix the bug…'
					}));
				if (!instruction?.trim()) { return; }
				const original = doc.getText(range);
				const before = doc.getText(
					new vscode.Range(new vscode.Position(Math.max(0, range.start.line - 20), 0), range.start)
				);
				const after = doc.getText(
					new vscode.Range(
						range.end,
						doc.lineAt(Math.min(doc.lineCount - 1, range.end.line + 20)).range.end
					)
				);
				const cfg = vscode.workspace.getConfiguration('openova');
				trace(`inlineEdit lines=${range.start.line + 1}-${range.end.line + 1}`);
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Openova: editing…' },
					async () => {
						try {
							const out = await complete({
								requestId: uid(),
								provider: cfg.get<string>('provider', 'ollama') as AIProvider,
								baseURL: cfg.get<string>('baseUrl', '') || undefined,
								apiKey: await getApiKey(cfg.get<string>('provider', 'ollama') as AIProvider),
								model: cfg.get<string>('model', 'qwen3.5:9b'),
								system:
									'You are an expert code editor. Rewrite ONLY the provided code section per the instruction. ' +
									'Reply with ONLY the replacement code — no markdown fences, no commentary, no surrounding context.',
								messages: [
									{
										role: 'user',
										content:
											`Language: ${doc.languageId}\n\nContext before:\n${before}\n\n` +
											`Code section to rewrite:\n${original}\n\nContext after:\n${after}\n\n` +
											`Instruction: ${instruction}`
									}
								],
								temperature: 0.2,
								maxTokens: 4096,
								reasoningEffort: 'off'
							});
							let cleaned = out
								.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
								.trim()
								.replace(/^```[\w-]*\n?/, '')
								.replace(/\n?```$/, '');
							if (!cleaned.trim()) {
								void vscode.window.showWarningMessage('Openova: the model returned nothing.');
								return;
							}
							// Preserve the trailing newline shape of the original.
							if (original.endsWith('\n') && !cleaned.endsWith('\n')) { cleaned += '\n'; }
							await editor.edit((b) => b.replace(range, cleaned));
							trace('inlineEdit applied');
						} catch (e) {
							void vscode.window.showErrorMessage(
								`Openova inline edit failed: ${e instanceof Error ? e.message : String(e)}`
							);
						}
					}
				);
			}
		),
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
				void provider.startRun(text, mode);
			}
		})
	);

	// Headless bring-up harness: when OPENOVA_DEV_TRIGGER points at a JSON file
	// ({"text","mode",("thenUndo")}), consume it and run — lets CI/agents verify
	// real runs (and the undo path) without synthetic input. Env-gated.
	const triggerPath = process.env.OPENOVA_DEV_TRIGGER;
	if (triggerPath) {
		setTimeout(() => {
			void (async () => {
				// Harness behavior applies ONLY while this triggered work runs —
				// user turns in the same instance behave completely normally.
				setDevRunActive(true);
				try {
					if (!fs.existsSync(triggerPath)) { return; }
					const req = JSON.parse(fs.readFileSync(triggerPath, 'utf8')) as {
						text?: string;
						mode?: string;
						thenUndo?: boolean;
						thenApprove?: boolean;
						context?: string[];
						inline?: { file: string; startLine: number; endLine: number; instruction: string };
						completion?: { file: string; line: number; col: number };
						agentsWindow?: boolean;
						showView?: string;
						automation?: { name: string; prompt: string; everyMinutes?: number; run?: boolean };
					};
					fs.unlinkSync(triggerPath);
					trace(`devTrigger ${JSON.stringify(req)}`);
					if (req.showView) {
						provider.pendingView = String(req.showView);
					}
					if (req.agentsWindow) {
						await provider.openAgentsWindow();
						trace('devAgentsWindow opened');
						if (req.showView) {
							// the panel may have been restored (already initialized) —
							// deliver the view hint directly too
							setTimeout(() => provider.postView(String(req.showView)), 1500);
						}
					}
					if (req.automation) {
						provider.saveAutomation({
							name: req.automation.name,
							prompt: req.automation.prompt,
							everyMinutes: req.automation.everyMinutes ?? 60
						});
						const created = provider.getAutomations().find((a) => a.name === req.automation?.name);
						if (created && req.automation.run !== false) {
							await provider.runAutomation(created.id);
						}
						trace('devAutomation done');
						return;
					}
					if (req.agentsWindow && !req.text) { return; }
					if (req.completion) {
						const doc = await vscode.workspace.openTextDocument(req.completion.file);
						const text = await completeAtPosition(
							doc,
							new vscode.Position(req.completion.line - 1, req.completion.col),
							'dev-completion'
						);
						trace(`devCompletion [${text.replace(/\n/g, '\\n').slice(0, 200)}]`);
						return;
					}
					if (req.inline) {
						const doc = await vscode.workspace.openTextDocument(req.inline.file);
						const editor = await vscode.window.showTextDocument(doc);
						editor.selection = new vscode.Selection(
							new vscode.Position(req.inline.startLine - 1, 0),
							doc.lineAt(req.inline.endLine - 1).range.end
						);
						await vscode.commands.executeCommand('openova.inlineEdit', {
							instruction: req.inline.instruction
						});
						await doc.save();
						trace('devInline done');
						return;
					}
					if (!req.text) { return; }
					const mode = req.mode === 'ask' ? 'ask' : req.mode === 'plan' ? 'plan' : 'agent';
					await provider.startRun(req.text, mode, req.context ?? []);
					if (req.thenApprove) {
						const ok = await provider.approveLastPlan();
						trace(`devApprove ran=${ok}`);
					}
					if (req.thenUndo) {
						const n = await provider.undoLastRun(true);
						trace(`devUndo reverted=${n}`);
					}
				} catch (e) {
					trace(`devTrigger error ${e instanceof Error ? e.message : String(e)}`);
				} finally {
					setDevRunActive(false);
				}
			})();
		}, 3000);
	}
}

export function deactivate(): void {
	// In-flight model requests die with the extension host process; MCP server
	// child processes need an explicit tree-kill.
	disposeMcp();
}

class OpenovaChatViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private sessions: Session[] = [];
	private activeSession: string | null = null;
	private readonly runs = new Map<string, RunState>();
	private readonly queues = new Map<string, QueuedItem[]>();
	private readonly sessionAllowed = new Set<string>();
	/** Resolvers for runs paused at their step budget (sessionId → grant more?). */
	private readonly pauseResolvers = new Map<string, (more: boolean) => void>();
	/** Shell backing the Agents window Terminal pane. */
	private term: cp.ChildProcessWithoutNullStreams | undefined;
	/** Whether the Agents panel is known to live in its own OS window. */
	private panelFloating = false;
	/** Resolvers for ask_user questions awaiting an answer (qid → resolver). */
	private readonly questionResolvers = new Map<string, { sessionId: string; resolve: (a: string) => void }>();
	/** Resolvers for in-run propose_plan cards awaiting approval (sessionId). */
	private readonly planResolvers = new Map<string, { msgId: string; resolve: (steps: string[] | null) => void }>();
	private automations: Automation[] = [];
	/** One-shot view hint for the next webview init (dev harness). */
	pendingView: string | null = null;

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
		this.automations = context.workspaceState.get<Automation[]>('openova.automations', []);
		this.updateRepoRegistry();
	}

	// ---- cross-repo registry (Agents window Repositories rail) ----------------

	private updateRepoRegistry(): void {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) { return; }
		const reg = { ...this.context.globalState.get<Record<string, RepoEntry>>('openova.repoRegistry', {}) };
		reg[folder.uri.fsPath] = {
			path: folder.uri.fsPath,
			name: folder.name,
			lastOpened: Date.now(),
			sessions: this.sessions
				.filter((s) => s.messages.length > 0)
				.slice(0, 20)
				.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }))
		};
		const keep = Object.values(reg)
			.sort((a, b) => b.lastOpened - a.lastOpened)
			.slice(0, 8);
		void this.context.globalState.update(
			'openova.repoRegistry',
			Object.fromEntries(keep.map((e) => [e.path, e]))
		);
	}

	private repoList(): RepoEntry[] {
		const cur = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		return Object.values(
			this.context.globalState.get<Record<string, RepoEntry>>('openova.repoRegistry', {})
		).sort((a, b) =>
			a.path === cur ? -1 : b.path === cur ? 1 : b.lastOpened - a.lastOpened
		);
	}

	postView(view: string): void {
		this.post({ type: 'showView', view });
	}

	/** Workspace-relative or absolute path → Uri (absolute paths allowed). */
	private resolvePathUri(p: string): vscode.Uri | undefined {
		if (!p) { return undefined; }
		if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')) {
			return vscode.Uri.file(p);
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		return root ? vscode.Uri.joinPath(root, p) : undefined;
	}

	// ---- terminal pane (Agents window) ----------------------------------------

	private ensureTerm(): void {
		if (this.term) { return; }
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const exe = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
		const args = process.platform === 'win32' ? ['-NoLogo'] : [];
		try {
			const child = cp.spawn(exe, args, { cwd: root, windowsHide: true });
			child.stdout.on('data', (d: Buffer) => this.post({ type: 'termData', data: d.toString() }));
			child.stderr.on('data', (d: Buffer) => this.post({ type: 'termData', data: d.toString() }));
			child.on('exit', (code) => {
				this.post({ type: 'termData', data: `\n[shell exited (${code ?? 'killed'}) — press Enter to restart]\n` });
				this.term = undefined;
			});
			child.on('error', (e) => {
				this.post({ type: 'termData', data: `\n[failed to start shell: ${e.message}]\n` });
				this.term = undefined;
			});
			this.term = child;
			this.post({ type: 'termData', data: `[${exe} @ ${root}]\n` });
		} catch (e) {
			this.post({ type: 'termData', data: `[failed to start shell: ${e instanceof Error ? e.message : String(e)}]\n` });
		}
	}

	killTerm(): void {
		try {
			this.term?.kill();
		} catch {
			/* already gone */
		}
		this.term = undefined;
	}

	private postRepos(): void {
		this.post({
			type: 'repos',
			repos: this.repoList(),
			repoCurrent: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
		});
	}

	// ---- automations ----------------------------------------------------------

	private persistAutomations(): void {
		void this.context.workspaceState.update('openova.automations', this.automations);
		this.post({ type: 'automations', items: this.automations });
	}

	saveAutomation(item: Partial<Automation>): void {
		const existing = item.id ? this.automations.find((a) => a.id === item.id) : undefined;
		if (existing) {
			Object.assign(existing, item);
		} else {
			this.automations.push({
				id: uid(),
				name: String(item.name || 'Automation').slice(0, 60),
				prompt: String(item.prompt || ''),
				everyMinutes: Math.max(5, Number(item.everyMinutes) || 60),
				enabled: item.enabled !== false
			});
		}
		this.persistAutomations();
	}

	deleteAutomation(id: string): void {
		this.automations = this.automations.filter((a) => a.id !== id);
		this.persistAutomations();
	}

	getAutomations(): Automation[] {
		return this.automations;
	}

	/** Run one automation now, in a fresh session titled after it. */
	async runAutomation(id: string): Promise<void> {
		const a = this.automations.find((x) => x.id === id);
		if (!a || !a.prompt) { return; }
		a.lastRun = Date.now();
		this.persistAutomations();
		this.newSessionInternal();
		this.postSessions();
		const sessionId = this.activeSession;
		trace(`automation run ${a.name}`);
		await this.startRun(a.prompt, 'agent', []);
		const sess = sessionId ? this.session(sessionId) : undefined;
		if (sess) {
			sess.title = ('Auto: ' + a.name).slice(0, 40);
			this.persist();
			this.postSessions();
		}
	}

	/** Minute tick: run whatever is due, one at a time, never over a live run. */
	async tickAutomations(): Promise<void> {
		if (this.runs.size) { return; }
		for (const a of this.automations) {
			if (!a.enabled || !a.prompt) { continue; }
			if (a.lastRun && Date.now() - a.lastRun < a.everyMinutes * 60_000) { continue; }
			await this.runAutomation(a.id);
			return;
		}
	}

	// ---- session management -------------------------------------------------

	newSession(): void {
		this.newSessionInternal();
		this.persist();
		this.postSessions();
	}

	private newSessionInternal(): void {
		const existing = this.sessions.find((s) => s.messages.length === 0);
		if (existing) {
			this.activeSession = existing.id;
			return;
		}
		const s: Session = { id: uid(), title: 'New Chat', messages: [], updatedAt: Date.now() };
		this.sessions.unshift(s);
		this.activeSession = s.id;
	}

	private persist(): void {
		// Strip pre-run snapshots and retire review bars in the PERSISTED copy —
		// a stale Undo after reload could destroy newer work (same rule the
		// standalone app ships). The in-memory session keeps the live bar.
		const sanitized = this.sessions.slice(0, 40).map((s) => ({
			...s,
			messages: s.messages.map((m) => {
				let out = m;
				// A paused run / pending question can't resume after a reload.
				if (out.paused !== undefined || out.pendingQuestion) {
					out = { ...out, paused: undefined, pendingQuestion: undefined };
				}
				if (out.writes) {
					out = {
						...out,
						reviewDismissed: true,
						writes: out.writes.map((w) => ({ ...w, before: undefined }))
					};
				}
				// A plan mid-execution can't still be running after a reload.
				if (out.plan && out.plan.status === 'running') {
					out = { ...out, plan: { ...out.plan, status: 'cancelled' } };
				}
				return out;
			})
		}));
		void this.context.workspaceState.update('openova.sessions', {
			sessions: sanitized,
			active: this.activeSession
		});
		this.updateRepoRegistry();
		this.postRepos();
	}

	private post(msg: Record<string, unknown>): void {
		// Both surfaces (sidebar view + Agents window panel) mirror the state.
		void this.view?.webview.postMessage(msg);
		void this.panel?.webview.postMessage(msg);
	}

	/** Wire an Agents panel (fresh or deserialized after restart) to this provider. */
	adoptPanel(panel: vscode.WebviewPanel): void {
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
		};
		panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'nova-color.svg');
		panel.webview.html = this.html(panel.webview, 'window');
		panel.webview.onDidReceiveMessage((msg: Record<string, unknown>) => {
			void this.onMessage(msg);
		});
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
				this.panelFloating = false;
			}
		});
		this.panel = panel;
		// A deserialized panel may have been restored as a TAB in the IDE —
		// we can't tell which window it landed in, so the next
		// openAgentsWindow call floats it to be sure.
		this.panelFloating = false;
	}

	/** Move the panel into its own OS window (tracked via panelFloating). */
	private async floatPanel(panel: vscode.WebviewPanel): Promise<void> {
		// The move targets the ACTIVE editor — during startup another editor
		// (e.g. Welcome) can win that slot, so wait until it's really us.
		if (!panel.active) {
			await new Promise<void>((resolve) => {
				const d = panel.onDidChangeViewState(() => {
					if (panel.active) { d.dispose(); resolve(); }
				});
				setTimeout(() => { d.dispose(); resolve(); }, 1500);
			});
		}
		panel.reveal(vscode.ViewColumn.One, false);
		try {
			await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
			this.panelFloating = true;
			trace('agents panel floated to its own window');
		} catch {
			// aux windows unavailable — the in-tab panel still works
		}
	}

	/** Separate-OS-window mission control (Cursor-style) — same engine as the sidebar view. */
	async openAgentsWindow(): Promise<void> {
		if (this.panel) {
			// Focus it — and if it's (or might be) sitting as a tab inside the
			// IDE window, free it into its own window now.
			this.panel.reveal();
			if (!this.panelFloating) {
				await this.floatPanel(this.panel);
			}
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			'openova.agents',
			'Openova Agents',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
			}
		);
		this.adoptPanel(panel);
		// Pop the panel out into its own OS window like Cursor's agent app.
		await this.floatPanel(panel);
	}

	private postSessions(): void {
		this.post({ type: 'sessions', sessions: this.sessions, active: this.activeSession });
	}

	private postQueue(sessionId: string): void {
		this.post({ type: 'queue', sessionId, items: this.queues.get(sessionId) ?? [] });
	}

	private settings(): { provider: AIProvider; model: string; effort: string; baseUrl: string; permissionMode: string } {
		const cfg = vscode.workspace.getConfiguration('openova');
		return {
			provider: cfg.get<string>('provider', 'ollama') as AIProvider,
			model: cfg.get<string>('model', 'qwen3.5:9b'),
			effort: cfg.get<string>('reasoningEffort', 'off'),
			baseUrl: cfg.get<string>('baseUrl', ''),
			permissionMode: cfg.get<string>('permissionMode', 'ask')
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

	/** Programmatic entry point (URI handler / commands / dev harness). */
	async startRun(
		text: string,
		mode: 'ask' | 'agent' | 'plan',
		contextPaths: string[] = []
	): Promise<void> {
		const sessionId = this.activeSession;
		trace(`startRun mode=${mode} session=${sessionId} busy=${!!(sessionId && this.runs.get(sessionId))}`);
		if (!sessionId || this.runs.get(sessionId)) { return; }
		await this.dispatch(sessionId, text, mode, contextPaths);
	}

	/** Resolve @-mentioned files into a context block, then route by mode. */
	private async dispatch(
		sessionId: string,
		text: string,
		mode: 'ask' | 'agent' | 'plan',
		contextPaths: string[]
	): Promise<void> {
		let contextBlock = '';
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (root && contextPaths.length) {
			for (const rel of contextPaths.slice(0, 8)) {
				try {
					const uri = vscode.Uri.joinPath(root, rel);
					const bytes = await vscode.workspace.fs.readFile(uri);
					if (bytes.byteLength > 24_576) { continue; }
					contextBlock += `\n\nAttached file ${rel}:\n\`\`\`\n${new TextDecoder().decode(bytes)}\n\`\`\``;
				} catch {
					/* skip unreadable */
				}
			}
		}
		const full = contextBlock ? `${text}${contextBlock}` : text;
		if (mode === 'agent') { await this.sendAgent(sessionId, full, contextBlock ? { displayText: text } : {}); }
		else if (mode === 'plan') { await this.sendPlan(sessionId, full, text); }
		else { await this.sendAsk(sessionId, full, text); }
	}

	/** Dev harness: approve the most recent proposed plan and await the run. */
	async approveLastPlan(): Promise<boolean> {
		for (const sess of this.sessions) {
			for (let i = sess.messages.length - 1; i >= 0; i--) {
				const m = sess.messages[i];
				if (m.plan && m.plan.status === 'proposed') {
					await this.approvePlan(sess.id, m.id);
					return true;
				}
			}
		}
		return false;
	}

	/** Dev harness: undo the most recent run's writes (skips the confirm). */
	async undoLastRun(skipConfirm: boolean): Promise<number> {
		for (const sess of this.sessions) {
			for (let i = sess.messages.length - 1; i >= 0; i--) {
				const m = sess.messages[i];
				if (m.writes?.length && !m.reviewDismissed) {
					return this.undoWrites(sess.id, m.id, skipConfirm);
				}
			}
		}
		return 0;
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
				const providers = await Promise.all(
					Object.values(PROVIDERS).map(async (p) => ({
						id: p.id,
						label: p.label,
						needsKey: p.needsKey,
						local: p.local,
						hasKey: p.needsKey ? await hasApiKey(p.id) : false
					}))
				);
				this.post({
					type: 'init',
					sessions: this.sessions,
					active: this.activeSession,
					settings: this.settings(),
					workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? null,
					providers,
					queue: this.activeSession ? (this.queues.get(this.activeSession) ?? []) : [],
					automations: this.automations,
					repos: this.repoList(),
					repoCurrent: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
					theme: vscode.workspace.getConfiguration('workbench').get<string>('colorTheme', ''),
					view: this.pendingView
				});
				this.pendingView = null;
				break;
			}
			case 'termStart':
				this.ensureTerm();
				break;
			case 'termInput':
				this.ensureTerm();
				try {
					this.term?.stdin.write(String(msg.data ?? '') + '\n');
				} catch {
					/* shell died mid-write; the exit handler resets it */
				}
				break;
			case 'readFileContent': {
				const rel = String(msg.path ?? '');
				const uri = this.resolvePathUri(rel);
				if (!rel || !uri) { break; }
				try {
					const bytes = await vscode.workspace.fs.readFile(uri);
					this.post({
						type: 'fileContent',
						path: rel,
						content: new TextDecoder().decode(bytes.slice(0, 200_000))
					});
				} catch (e) {
					this.post({
						type: 'fileContent',
						path: rel,
						content: `(couldn't read ${rel}: ${e instanceof Error ? e.message : String(e)})`
					});
				}
				break;
			}
			case 'openInEditor': {
				const uri = this.resolvePathUri(String(msg.path ?? ''));
				if (uri) {
					void vscode.commands.executeCommand('vscode.open', uri);
				}
				break;
			}
			case 'openRepoFolder': {
				const p = String(msg.path ?? '');
				if (p) {
					void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), {
						forceNewWindow: false
					});
				}
				break;
			}
			case 'forgetRepo': {
				const p = String(msg.path ?? '');
				const reg = { ...this.context.globalState.get<Record<string, RepoEntry>>('openova.repoRegistry', {}) };
				delete reg[p];
				void this.context.globalState.update('openova.repoRegistry', reg);
				this.postRepos();
				break;
			}
			case 'automationSave':
				this.saveAutomation((msg.item ?? {}) as Partial<Automation>);
				break;
			case 'automationDelete':
				this.deleteAutomation(String(msg.id));
				break;
			case 'automationRun':
				void this.runAutomation(String(msg.id));
				break;
			case 'newSession':
				this.newSession();
				break;
			case 'answerQuestion': {
				const qid = String(msg.qid ?? '');
				const q = this.questionResolvers.get(qid);
				if (q) {
					this.questionResolvers.delete(qid);
					q.resolve(String(msg.answer ?? '(no answer)'));
				}
				break;
			}
			case 'continueRun': {
				const sid = String(msg.sessionId ?? this.activeSession ?? '');
				const resolve = this.pauseResolvers.get(sid);
				if (resolve) {
					this.pauseResolvers.delete(sid);
					trace(`agent continue granted session=${sid}`);
					resolve(true);
				}
				break;
			}
			case 'openSettings':
				void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:openova.openova-agent');
				break;
			case 'customize':
				void vscode.commands.executeCommand('workbench.action.selectTheme');
				break;
			case 'openRepo':
				void vscode.commands.executeCommand('workbench.action.openRecent');
				break;
			case 'pickFolder': {
				const picked = await vscode.window.showOpenDialog({
					canSelectFolders: true,
					canSelectFiles: false,
					canSelectMany: false,
					openLabel: 'Open in Openova'
				});
				if (picked?.[0]) {
					void vscode.commands.executeCommand('vscode.openFolder', picked[0], { forceNewWindow: false });
				}
				break;
			}
			case 'editorWindow':
				// The Agents surface lives in an aux window — cycle focus back to
				// the main editor window.
				void vscode.commands.executeCommand('workbench.action.focusNextWindow');
				break;
			case 'switchSession':
				this.activeSession = String(msg.id);
				this.persist();
				this.postSessions();
				this.postQueue(String(msg.id));
				break;
			case 'deleteSession': {
				const id = String(msg.id);
				this.abort(id);
				this.queues.delete(id);
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
				const mode = msg.mode === 'ask' ? 'ask' : msg.mode === 'plan' ? 'plan' : 'agent';
				const contextPaths = Array.isArray(msg.context) ? (msg.context as string[]) : [];
				if (!text || !this.session(sessionId)) { return; }
				if (this.runs.get(sessionId)) {
					// A run is streaming — queue the follow-up (dispatched at run end).
					const q = this.queues.get(sessionId) ?? [];
					q.push({ id: uid(), text, mode });
					this.queues.set(sessionId, q);
					this.postQueue(sessionId);
					return;
				}
				await this.dispatch(sessionId, text, mode, contextPaths);
				break;
			}
			case 'listWorkspaceFiles': {
				const uris = await vscode.workspace.findFiles(
					'**/*',
					'{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**}',
					400
				);
				const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
				this.post({
					type: 'workspaceFiles',
					files: root
						? uris.map((u) => vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/')).sort()
						: []
				});
				break;
			}
			case 'planEdit':
				this.mutatePlan(String(msg.sessionId), String(msg.msgId), (p) => {
					const st = p.steps.find((x) => x.id === String(msg.stepId));
					if (st && p.status === 'proposed') { st.text = String(msg.text ?? st.text); }
				});
				break;
			case 'planAdd':
				this.mutatePlan(String(msg.sessionId), String(msg.msgId), (p) => {
					if (p.status === 'proposed') { p.steps.push({ id: uid(), text: '', done: false }); }
				});
				break;
			case 'planRemove':
				this.mutatePlan(String(msg.sessionId), String(msg.msgId), (p) => {
					if (p.status === 'proposed') {
						p.steps = p.steps.filter((x) => x.id !== String(msg.stepId));
					}
				});
				break;
			case 'planCancel': {
				const sid = String(msg.sessionId);
				this.mutatePlan(sid, String(msg.msgId), (p) => {
					if (p.status === 'proposed') { p.status = 'cancelled'; }
				});
				const pr = this.planResolvers.get(sid);
				if (pr && pr.msgId === String(msg.msgId)) {
					this.planResolvers.delete(sid);
					pr.resolve(null);
				}
				break;
			}
			case 'planApprove': {
				const sid = String(msg.sessionId);
				const pr = this.planResolvers.get(sid);
				if (pr && pr.msgId === String(msg.msgId)) {
					// In-run proposal: hand the (possibly edited) steps back to the
					// waiting agent loop — same run continues.
					this.planResolvers.delete(sid);
					let finalSteps: string[] = [];
					this.mutatePlan(sid, pr.msgId, (p) => {
						p.steps = p.steps.filter((s) => s.text.trim());
						p.status = 'running';
						finalSteps = p.steps.map((s) => s.text);
					});
					this.persist();
					this.postSessions();
					trace(`plan approved in-run (${finalSteps.length} steps)`);
					pr.resolve(finalSteps);
				} else {
					await this.approvePlan(sid, String(msg.msgId));
				}
				break;
			}
			case 'cancelQueued': {
				const sessionId = String(msg.sessionId ?? '');
				const q = (this.queues.get(sessionId) ?? []).filter((x) => x.id !== String(msg.id));
				this.queues.set(sessionId, q);
				this.postQueue(sessionId);
				break;
			}
			case 'abort': {
				const sessionId = String(msg.sessionId ?? this.activeSession ?? '');
				// Stop is an explicit stand-down — drop queued follow-ups too.
				this.queues.set(sessionId, []);
				this.postQueue(sessionId);
				this.abort(sessionId);
				break;
			}
			case 'setSettings': {
				const cfg = vscode.workspace.getConfiguration('openova');
				const patch = (msg.patch ?? {}) as Record<string, string>;
				for (const [key, val] of Object.entries(patch)) {
					if (['provider', 'model', 'reasoningEffort', 'baseUrl', 'permissionMode'].includes(key)) {
						await cfg.update(key, val, vscode.ConfigurationTarget.Global);
					}
				}
				this.post({ type: 'settings', settings: this.settings() });
				break;
			}
			case 'listModels': {
				// Browse any provider's models (for the picker) without committing.
				const s = this.settings();
				const p = (typeof msg.provider === 'string' ? msg.provider : s.provider) as AIProvider;
				const info = providerInfo(p);
				const keyed = await hasApiKey(p);
				const discoverArgs = {
					kind: info.kind,
					baseURL: p === s.provider && s.baseUrl ? s.baseUrl : info.baseURL,
					apiKey: await getApiKey(p)
				};
				let r = info.discover
					? await listModels(discoverArgs)
					: { ok: false as const, models: [], error: undefined as string | undefined };
				if (!r.ok && p === 'lmstudio' && (await tryStartLmStudioServer())) {
					// server just woke up — poll briefly until it answers
					for (let i = 0; i < 5 && !r.ok; i++) {
						await new Promise((res) => setTimeout(res, 1500));
						r = await listModels(discoverArgs);
					}
					trace(`lmstudio: post-start discovery ok=${r.ok} models=${r.models.length}`);
				}
				// Fall back to the curated list so cloud providers are usable
				// even when their /models endpoint is gated or unreachable.
				const models = r.ok && r.models.length ? r.models : info.models;
				this.post({
					type: 'models',
					provider: p,
					models,
					discovered: r.ok,
					error: r.ok ? undefined : r.error,
					needsKey: info.needsKey,
					hasKey: keyed,
					local: info.local,
					baseURL: info.baseURL
				});
				break;
			}
			case 'setApiKey': {
				const p = String(msg.provider ?? '') as AIProvider;
				const info = providerInfo(p);
				if (!info.secretKey) { break; }
				const value = await vscode.window.showInputBox({
					title: `${info.label} API key`,
					prompt: `Stored encrypted in this profile. Leave empty to clear.`,
					password: true,
					ignoreFocusOut: true
				});
				if (value === undefined) { break; } // cancelled
				await setApiKey(p, value.trim() || undefined);
				// refresh the picker for this provider
				await this.onMessage({ type: 'listModels', provider: p });
				break;
			}
			case 'applyTheme': {
				const name = String(msg.name ?? '');
				if (name) {
					await vscode.workspace
						.getConfiguration('workbench')
						.update('colorTheme', name, vscode.ConfigurationTarget.Global);
					this.post({ type: 'theme', current: name });
				}
				break;
			}
			case 'browseThemes':
				void vscode.commands.executeCommand('workbench.action.selectTheme');
				break;
			case 'dismissReview':
				this.mutateMsg(String(msg.sessionId), String(msg.msgId), (m) => {
					m.reviewDismissed = true;
				});
				this.persist();
				this.postSessions();
				break;
			case 'undoWrites':
				await this.undoWrites(String(msg.sessionId), String(msg.msgId), false);
				break;
			case 'revertFile': {
				const sess = this.session(String(msg.sessionId));
				const m = sess?.messages.find((x) => x.id === String(msg.msgId));
				const w = m?.writes?.find((x) => x.fullPath === String(msg.fullPath));
				if (w && !w.isNew && w.before !== undefined) {
					await this.restoreFile(w.fullPath, w.before);
					void vscode.window.showInformationMessage(`Openova: reverted ${w.path}`);
				}
				break;
			}
		}
	}

	private abort(sessionId: string): void {
		const run = this.runs.get(sessionId);
		if (!run) { return; }
		run.stop = true;
		if (run.requestId) { abortRequest(run.requestId); }
		// A paused run waiting on Continue must also unwind on Stop.
		const resolve = this.pauseResolvers.get(sessionId);
		if (resolve) {
			this.pauseResolvers.delete(sessionId);
			resolve(false);
		}
		// So must any question the agent is waiting on.
		for (const [qid, q] of this.questionResolvers) {
			if (q.sessionId === sessionId) {
				this.questionResolvers.delete(qid);
				q.resolve('(the user stopped the run)');
			}
		}
		// …and any in-run plan proposal.
		const pp = this.planResolvers.get(sessionId);
		if (pp) {
			this.planResolvers.delete(sessionId);
			pp.resolve(null);
		}
	}

	// ---- review bar / undo ---------------------------------------------------

	private async restoreFile(fullPath: string, content: string): Promise<boolean> {
		const uri = vscode.Uri.file(fullPath);
		// Never clobber unsaved editor changes.
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fullPath);
		if (doc?.isDirty) { return false; }
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
		return true;
	}

	private async undoWrites(sessionId: string, msgId: string, skipConfirm: boolean): Promise<number> {
		const sess = this.session(sessionId);
		const m = sess?.messages.find((x) => x.id === msgId);
		const files = m?.writes ?? [];
		if (!m || files.length === 0) { return 0; }
		if (!skipConfirm) {
			const pick = await vscode.window.showWarningMessage(
				`Undo changes to ${files.length} file(s)?`,
				{
					modal: true,
					detail:
						'Modified files are restored to their pre-run contents; files the agent created are deleted. Unsaved editor changes are never overwritten.'
				},
				'Undo all'
			);
			if (pick !== 'Undo all') { return 0; }
		}
		let reverted = 0;
		let skipped = 0;
		for (const f of files) {
			try {
				if (f.isNew) {
					const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === f.fullPath);
					if (doc?.isDirty) { skipped++; continue; }
					await vscode.workspace.fs.delete(vscode.Uri.file(f.fullPath), { useTrash: true });
				} else if (f.before !== undefined) {
					if (!(await this.restoreFile(f.fullPath, f.before))) { skipped++; continue; }
				} else {
					// Pre-existing file with no snapshot kept (>256KB): restoring is
					// impossible and deleting would destroy user data. Leave it.
					skipped++;
					continue;
				}
				reverted++;
			} catch {
				/* keep going — report what we could revert */
			}
		}
		m.reviewDismissed = true;
		this.persist();
		this.postSessions();
		if (!skipConfirm) {
			void vscode.window.showInformationMessage(
				`Openova: reverted ${reverted}/${files.length} file(s)` +
				(skipped ? ` — ${skipped} skipped` : '')
			);
		}
		return reverted;
	}

	// ---- auto-title ----------------------------------------------------------

	private autoTitle(sessionId: string): void {
		const sess = this.session(sessionId);
		if (!sess || sess.messages.length === 0) { return; }
		const first = sess.messages.find((m) => m.role === 'user');
		if (!first?.content.trim()) { return; }
		const reply = sess.messages.find((m) => m.role === 'assistant' && m.content);
		const prevTitle = sess.title;
		const s = this.settings();
		void (async () => {
			try {
				const out = await complete({
					requestId: uid(),
					provider: s.provider,
					baseURL: s.baseUrl || undefined,
					apiKey: await getApiKey(s.provider),
					model: s.model,
					system:
						'You name coding chats. Reply with ONLY a concise 3-6 word title for the conversation. No quotes, no trailing punctuation, no explanations.',
					messages: [
						{
							role: 'user',
							content:
								`User request:\n${first.content.slice(0, 600)}` +
								(reply ? `\n\nAssistant answered:\n${reply.content.slice(0, 400)}` : '')
						}
					],
					temperature: 0.3,
					maxTokens: 2000,
					reasoningEffort: 'off'
				});
				const title = (
					out
						.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
						.split('\n')
						.map((l) => l.trim())
						.filter(Boolean)
						.pop() ?? ''
				)
					.replace(/^["'`#*\s]+|["'`.*\s]+$/g, '')
					.slice(0, 60);
				const cur = this.session(sessionId);
				if (!title || !cur || cur.title !== prevTitle) { return; }
				cur.title = title;
				this.persist();
				this.postSessions();
			} catch {
				/* best effort — the prefix title stays */
			}
		})();
	}

	// ---- run completion shared tail -------------------------------------------

	private finishRun(sessionId: string, wasFirstTurn: boolean): void {
		this.runs.delete(sessionId);
		this.persist();
		this.postSessions();
		this.post({ type: 'running', sessionId, running: false });
		if (wasFirstTurn) { this.autoTitle(sessionId); }
		// Dispatch the next queued follow-up, skipping items that would
		// early-return (which would silently stall the rest of the queue).
		const q = this.queues.get(sessionId) ?? [];
		let next: QueuedItem | undefined;
		while (q.length) {
			const head = q.shift()!;
			if (head.mode === 'agent' && !vscode.workspace.workspaceFolders?.length) {
				void vscode.window.showErrorMessage('Openova: skipped a queued agent message — no folder open.');
				continue;
			}
			next = head;
			break;
		}
		this.queues.set(sessionId, q);
		this.postQueue(sessionId);
		if (next) {
			if (next.mode === 'agent') { void this.sendAgent(sessionId, next.text); }
			else if (next.mode === 'plan') { void this.sendPlan(sessionId, next.text); }
			else { void this.sendAsk(sessionId, next.text); }
		}
	}

	// ---- plan mode ----------------------------------------------------------

	private mutatePlan(sessionId: string, msgId: string, fn: (p: Plan) => void): void {
		this.mutateMsg(sessionId, msgId, (m) => {
			if (m.plan) { fn(m.plan); }
		});
		this.persist();
		this.postSessions();
	}

	/** Draft an editable step-by-step plan (approve to execute). */
	private async sendPlan(sessionId: string, text: string, displayText = text): Promise<void> {
		const sess = this.session(sessionId)!;
		const wasFirstTurn = sess.messages.length === 0;
		const userMsg: UiMessage = { id: uid(), role: 'user', content: displayText, at: Date.now() };
		const planMsg: UiMessage = { id: uid(), role: 'assistant', content: '', at: Date.now() };
		if (wasFirstTurn) { sess.title = displayText.slice(0, 40); }
		sess.updatedAt = Date.now();
		sess.messages.push(userMsg, planMsg);
		this.postSessions();
		this.post({ type: 'running', sessionId, running: true });

		const run: RunState = { stop: false, requestId: uid() };
		this.runs.set(sessionId, run);
		const s = this.settings();
		try {
			let out = '';
			await runChat({
				requestId: run.requestId!,
				provider: s.provider,
				baseURL: s.baseUrl || undefined,
				apiKey: await getApiKey(s.provider),
				model: s.model,
				system:
					'You are a senior software engineer planning a coding task. Respond with ONLY this exact format:\n' +
					'PLAN: <short title>\n1. <first step>\n2. <second step>\n' +
					'Each step is ONE concrete action (a specific file to create/modify, or a command to run). ' +
					'Use 3-10 steps. No other prose, no markdown headings, no code blocks.',
				messages: [{ role: 'user', content: text }],
				temperature: 0.2,
				maxTokens: 2048,
				reasoningEffort: s.effort,
				onDelta: (d) => {
					out += d;
					this.post({ type: 'live', sessionId, msgId: planMsg.id, text: out.slice(0, 800) });
				},
				onError: (e) => {
					out += `\n\n**Error:** ${e}`;
				}
			});
			const clean = out.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
			const lines = clean.split('\n');
			const title =
				(lines.find((l) => /^\s*PLAN:/i.test(l)) ?? '').replace(/^\s*PLAN:\s*/i, '').trim() ||
				text.slice(0, 60);
			const steps: PlanStep[] = lines
				.map((l) => /^\s*\d+[.)]\s+(.+)$/.exec(l))
				.filter((m): m is RegExpExecArray => !!m)
				.map((m) => ({ id: uid(), text: m[1].trim(), done: false }));
			this.mutateMsg(sessionId, planMsg.id, (m) => {
				if (steps.length) {
					m.content = '';
					m.plan = { title, status: 'proposed', steps };
				} else {
					m.content = clean.trim() || '(no plan produced)';
				}
			});
			trace(`plan proposed steps=${steps.length}`);
		} finally {
			this.post({ type: 'live', sessionId, msgId: planMsg.id, text: '' });
			this.finishRun(sessionId, wasFirstTurn);
		}
	}

	/** Approve & Run: execute the plan as an agent task with step check-off. */
	private async approvePlan(sessionId: string, msgId: string): Promise<void> {
		const sess = this.session(sessionId);
		const msg = sess?.messages.find((m) => m.id === msgId);
		const plan = msg?.plan;
		if (!plan || plan.status !== 'proposed' || this.runs.get(sessionId)) { return; }
		const steps = plan.steps.filter((s) => s.text.trim());
		if (!steps.length) { return; }
		plan.steps = steps;
		plan.status = 'running';
		this.persist();
		this.postSessions();
		const task =
			`Execute this plan, in order. After completing each step, call ` +
			`<tool name="update_plan" step="N"></tool> with that step's number.\n\n` +
			`Plan: ${plan.title}\n` +
			steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
		await this.sendAgent(sessionId, task, {
			displayText: `Run plan: ${plan.title}`,
			plan: { sessionId, msgId }
		});
	}

	// ---- ask mode -----------------------------------------------------------

	private async sendAsk(sessionId: string, text: string, displayText = text): Promise<void> {
		const sess = this.session(sessionId)!;
		const wasFirstTurn = sess.messages.length === 0;
		const userMsg: UiMessage = { id: uid(), role: 'user', content: displayText, at: Date.now() };
		const reply: UiMessage = { id: uid(), role: 'assistant', content: '', at: Date.now() };
		if (wasFirstTurn) { sess.title = displayText.slice(0, 40); }
		sess.updatedAt = Date.now();
		sess.messages.push(userMsg, reply);
		this.postSessions();
		this.post({ type: 'running', sessionId, running: true });

		const run: RunState = { stop: false, requestId: uid() };
		this.runs.set(sessionId, run);
		const s = this.settings();
		// The transcript shows the typed text; the model gets it WITH the
		// attached-file context block for this turn.
		const history = sess.messages
			.filter((m) => m.id !== reply.id && !m.steps)
			.map((m) => ({ role: m.role, content: m.id === userMsg.id ? text : m.content }));
		try {
			let out = '';
			await runChat({
				requestId: run.requestId!,
				provider: s.provider,
				baseURL: s.baseUrl || undefined,
				apiKey: await getApiKey(s.provider),
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
			this.finishRun(sessionId, wasFirstTurn);
		}
	}

	// ---- agent mode ---------------------------------------------------------

	private async sendAgent(
		sessionId: string,
		text: string,
		opts: { displayText?: string; plan?: { sessionId: string; msgId: string } } = {}
	): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		trace(`sendAgent root=${root ?? 'NONE'} model=${this.settings().model}`);
		if (!root) {
			void vscode.window.showErrorMessage('Openova: open a folder to run the agent.');
			return;
		}
		const sess = this.session(sessionId)!;
		const wasFirstTurn = sess.messages.length === 0;
		const userMsg: UiMessage = { id: uid(), role: 'user', content: opts.displayText ?? text, at: Date.now() };
		const agentMsg: UiMessage = { id: uid(), role: 'assistant', content: '', steps: [], at: Date.now() };
		if (wasFirstTurn) { sess.title = text.slice(0, 40); }
		// A new run supersedes earlier review windows (undoing an old turn after
		// this run writes would silently wipe newer work).
		for (const m of sess.messages) {
			if (m.writes?.length && !m.reviewDismissed) { m.reviewDismissed = true; }
		}
		sess.updatedAt = Date.now();
		sess.messages.push(userMsg, agentMsg);
		this.postSessions();
		this.post({ type: 'running', sessionId, running: true });
		const runStartedAt = Date.now();

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
		let devContinues = 0;
		let autoExtends = 0;

		// Run write-ledger: first write wins for existed/before; counts summed.
		const writes = new Map<string, WriteEntry>();
		const host: ToolHost = {
			root,
			sessionAllowed: this.sessionAllowed,
			onWrite: ({ relPath, fullPath, existed, before, content }) => {
				const d = lineDiff(before, content);
				const led = writes.get(fullPath);
				if (led) {
					led.added += d.added;
					led.removed += d.removed;
				} else {
					writes.set(fullPath, {
						path: relPath,
						fullPath,
						added: d.added,
						removed: d.removed,
						before: existed && before.length <= MAX_BEFORE ? before : undefined,
						isNew: !existed
					});
				}
				// Live-follow: the Editor pane in the Agents window tracks the
				// file the agent is writing right now.
				this.post({ type: 'agentWrote', path: relPath, content: content.slice(0, 200_000) });
			}
		};
		const tools = createTools(host);
		tools.check = createCheck(host);
		tools.askUser = (question, options) =>
			new Promise<string>((resolve) => {
				// Headless harness: pick the first option so runs never hang.
				if (isDevRunActive()) {
					const auto = options[0] ?? 'yes';
					trace(`devAskUser auto-answered: ${auto}`);
					resolve(auto);
					return;
				}
				const qid = uid();
				this.questionResolvers.set(qid, {
					sessionId,
					resolve: (answer) => {
						this.mutateMsg(sessionId, agentMsg.id, (m) => { m.pendingQuestion = undefined; });
						this.postSessions();
						resolve(answer);
					}
				});
				this.mutateMsg(sessionId, agentMsg.id, (m) => {
					m.pendingQuestion = { qid, question, options };
				});
				this.postSessions();
			});
		// MCP: connect configured servers and expose their tools to this run.
		const mcpServers = vscode.workspace
			.getConfiguration('openova')
			.get<{ name: string; command: string }[]>('mcpServers', []);
		let mcpRules = '';
		if (mcpServers.length) {
			try {
				const mcpTools = await ensureMcp(mcpServers);
				if (mcpTools.length) {
					mcpRules =
						'These external MCP tools are available via ' +
						'<tool name="mcp_call" server="SERVER" tool="TOOL">{"json":"args"}</tool>:\n' +
						mcpTools.map((t) => `- ${t.server} / ${t.name}: ${t.description}`).join('\n');
					tools.callMcp = async (server, tool, argsJson) => {
						// Per-call approval (auto-approved under the dev harness — the
						// user configured the server themselves).
						if (!process.env.OPENOVA_DEV_TRIGGER) {
							const pick = await vscode.window.showWarningMessage(
								`Openova agent wants to call MCP tool "${tool}" on server "${server}":`,
								{ modal: true, detail: argsJson },
								'Allow'
							);
							if (pick !== 'Allow') { return { ok: false, output: 'The user declined this MCP call.' }; }
						}
						return callMcp(server, tool, argsJson);
					};
				}
			} catch {
				/* MCP is best-effort — the run proceeds without it */
			}
		}
		// update_plan targets the run's plan card — either the pre-approved plan
		// this run came from (plan mode) or one proposed mid-run via propose_plan.
		let activePlanMsgId: string | null = opts.plan?.msgId ?? null;
		const activePlanSessionId = opts.plan?.sessionId ?? sessionId;
		tools.updatePlan = (stepIndex) => {
			if (!activePlanMsgId) { return; }
			this.mutatePlan(activePlanSessionId, activePlanMsgId, (p) => {
				const st = p.steps[stepIndex - 1];
				if (st) { st.done = true; }
			});
		};
		tools.proposePlan = (planTitle, stepTexts) =>
			new Promise<string[] | null>((resolve) => {
				// Headless harness: auto-approve so runs never hang.
				if (isDevRunActive()) {
					trace(`devProposePlan auto-approved: ${planTitle} (${stepTexts.length} steps)`);
					this.mutateMsg(sessionId, agentMsg.id, (m) => {
						m.plan = {
							title: planTitle,
							steps: stepTexts.map((t) => ({ id: uid(), text: t, done: false })),
							status: 'running'
						};
					});
					activePlanMsgId = agentMsg.id;
					this.postSessions();
					resolve(stepTexts);
					return;
				}
				this.mutateMsg(sessionId, agentMsg.id, (m) => {
					m.plan = {
						title: planTitle,
						steps: stepTexts.map((t) => ({ id: uid(), text: t, done: false })),
						status: 'proposed'
					};
				});
				this.postSessions();
				this.planResolvers.set(sessionId, {
					msgId: agentMsg.id,
					resolve: (steps) => {
						if (steps) { activePlanMsgId = agentMsg.id; }
						resolve(steps);
					}
				});
			});
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
				case 'ask_user': return `Asked: ${String(args.question ?? '').slice(0, 80)}`;
				case 'check': return 'Running checks';
				default: return name;
			}
		};

		// Ground the model in its environment — without this it cannot answer
		// even "where is the file?" (it has no idea what the workspace path is).
		const envRules =
			`Environment:\n- Workspace root (absolute): ${root}\n- OS: ${process.platform === 'win32' ? 'Windows' : process.platform}\n` +
			`- All relative paths are under the workspace root. When the user asks where something is, give the full absolute path.`;

		// Conversation continuity: recent turns (user text + assistant summaries)
		// so follow-ups like "is it done?" don't start from amnesia.
		const priorTurns = sess.messages
			.filter((m) => m.id !== userMsg.id && m.id !== agentMsg.id && m.content?.trim())
			.slice(-6)
			.map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content.slice(0, 500)}`);
		const taskWithContext = priorTurns.length
			? `Conversation so far:\n${priorTurns.join('\n')}\n\n---\nCurrent request: ${text}`
			: text;

		try {
			await runAgent(
				taskWithContext,
				tools,
				{
					provider: s.provider,
					baseURL: s.baseUrl || undefined,
					apiKey: await getApiKey(s.provider),
					model: s.model,
					maxTokens: 8192,
					extraRules: [envRules, mcpRules].filter(Boolean).join('\n\n') || undefined
				},
				{
					onThought: (t) => addStep({ id: uid(), kind: 'thought', title: t, status: 'done' }),
					onAction: (name, args) => {
						currentToolId = uid();
						addStep({ id: currentToolId, kind: name, title: title(name, args), status: 'running' });
						this.post({ type: 'activity', sessionId, msgId: agentMsg.id, status: title(name, args), chars: 0 });
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
						trace(`finish: ${summary.slice(0, 300).replace(/\n/g, ' | ')}`);
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
						// Activity heartbeat: even while a huge file body streams (nothing
						// visible above), tell the user exactly what's being generated.
						const toolTag = /<tool\b[^>]*name="(\w+)"[^>]*?(?:path="([^"]*)")?[^>]*>/i.exec(full);
						let status: string;
						if (toolTag) {
							const t = toolTag[1];
							status =
								t === 'write_file' ? `Writing ${toolTag[2] || 'a file'}` :
									t === 'run_command' ? 'Preparing a command' :
										t === 'propose_plan' ? 'Drafting a plan' :
											t === 'ask_user' ? 'Writing a question' :
												t === 'finish' ? 'Wrapping up' : t.replace(/_/g, ' ');
						} else if (/<think/i.test(full) || !cleaned) {
							status = 'Thinking';
						} else {
							status = 'Responding';
						}
						this.post({
							type: 'activity',
							sessionId,
							msgId: agentMsg.id,
							status,
							chars: full.length
						});
					},
					onPause: (stepsUsed) =>
						new Promise<boolean>((resolve) => {
							trace(`agent paused after ${stepsUsed} steps`);
							// Headless harness: prove the resume path once, then stop —
							// a modal-less run must never wait forever.
							if (isDevRunActive()) {
								const more = devContinues++ < 1;
								trace(`devPause: auto-${more ? 'continue' : 'stop'}`);
								resolve(more);
								return;
							}
							// First exhaustion: extend silently — Cursor never interrupts
							// a healthy run. The bar only appears on the SECOND exhaustion.
							if (autoExtends++ < 1) {
								trace('pause: auto-extended silently');
								this.post({ type: 'activity', sessionId, msgId: agentMsg.id, status: 'Continuing (extended the step budget)', chars: 0 });
								resolve(true);
								return;
							}
							this.pauseResolvers.set(sessionId, (more) => {
								this.mutateMsg(sessionId, agentMsg.id, (m) => { m.paused = undefined; });
								this.postSessions();
								resolve(more);
							});
							this.mutateMsg(sessionId, agentMsg.id, (m) => { m.paused = stepsUsed; });
							this.postSessions();
						})
				},
				Math.max(10, vscode.workspace.getConfiguration('openova').get<number>('maxAgentSteps', 40))
			);
		} finally {
			this.mutateMsg(sessionId, agentMsg.id, (m) => {
				if (writes.size) { m.writes = Array.from(writes.values()); }
				m.durationMs = Date.now() - runStartedAt;
			});
			if (activePlanMsgId) {
				// Settle the plan card: a clean finish completes it (weak models
				// often skip update_plan), a stop leaves it cancelled.
				const stopped = this.runs.get(sessionId)?.stop ?? false;
				this.mutatePlan(activePlanSessionId, activePlanMsgId, (p) => {
					if (p.status === 'running') {
						if (stopped) {
							p.status = 'cancelled';
						} else {
							p.status = 'done';
							for (const st of p.steps) { st.done = true; }
						}
					}
				});
				trace('plan run finished');
			}
			this.post({ type: 'live', sessionId, msgId: agentMsg.id, text: '' });
			this.finishRun(sessionId, wasFirstTurn);
		}
	}

	// ---- shell --------------------------------------------------------------

	private html(webview: vscode.Webview, mode: 'sidebar' | 'window' = 'sidebar'): string {
		const nonce = uid() + uid();
		const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
		const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
		const icon = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'nova-color.svg'));
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; frame-src http: https:;">
	<link rel="stylesheet" href="${css}">
</head>
<body data-icon="${icon}" data-mode="${mode}">
	<div id="app"></div>
	<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
	}
}
