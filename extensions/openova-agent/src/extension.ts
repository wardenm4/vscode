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
}

interface Session {
	id: string;
	title: string;
	messages: UiMessage[];
}

interface QueuedItem {
	id: string;
	text: string;
	mode: 'ask' | 'agent' | 'plan';
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

export function activate(context: vscode.ExtensionContext): void {
	trace('activate');
	const provider = new OpenovaChatViewProvider(context);
	registerTabCompletions(context);
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
					};
					fs.unlinkSync(triggerPath);
					trace(`devTrigger ${JSON.stringify(req)}`);
					if (req.agentsWindow) {
						await provider.openAgentsWindow();
						trace('devAgentsWindow opened');
						return;
					}
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
		// Strip pre-run snapshots and retire review bars in the PERSISTED copy —
		// a stale Undo after reload could destroy newer work (same rule the
		// standalone app ships). The in-memory session keeps the live bar.
		const sanitized = this.sessions.slice(0, 40).map((s) => ({
			...s,
			messages: s.messages.map((m) => {
				let out = m;
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
	}

	private post(msg: Record<string, unknown>): void {
		// Both surfaces (sidebar view + Agents window panel) mirror the state.
		void this.view?.webview.postMessage(msg);
		void this.panel?.webview.postMessage(msg);
	}

	/** Separate-OS-window mission control (Cursor-style) — same engine as the sidebar view. */
	async openAgentsWindow(): Promise<void> {
		if (this.panel) {
			this.panel.reveal();
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
		panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'nova.svg');
		panel.webview.html = this.html(panel.webview, 'window');
		panel.webview.onDidReceiveMessage((msg: Record<string, unknown>) => {
			void this.onMessage(msg);
		});
		panel.onDidDispose(() => {
			this.panel = undefined;
		});
		this.panel = panel;
		// Pop the panel out into its own OS window like Cursor's agent app.
		// The panel is the active editor immediately after creation, so the
		// move targets it; if the move fails we gracefully keep the tab.
		try {
			await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
		} catch {
			// aux windows unavailable — the in-tab panel still works
		}
	}

	private postSessions(): void {
		this.post({ type: 'sessions', sessions: this.sessions, active: this.activeSession });
	}

	private postQueue(sessionId: string): void {
		this.post({ type: 'queue', sessionId, items: this.queues.get(sessionId) ?? [] });
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
				this.post({
					type: 'init',
					sessions: this.sessions,
					active: this.activeSession,
					settings: this.settings(),
					workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? null,
					providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label })),
					queue: this.activeSession ? (this.queues.get(this.activeSession) ?? []) : []
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
			case 'planCancel':
				this.mutatePlan(String(msg.sessionId), String(msg.msgId), (p) => {
					if (p.status === 'proposed') { p.status = 'cancelled'; }
				});
				break;
			case 'planApprove':
				await this.approvePlan(String(msg.sessionId), String(msg.msgId));
				break;
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
					if (['provider', 'model', 'reasoningEffort', 'baseUrl'].includes(key)) {
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
				const r = await listModels({
					kind: info.kind,
					baseURL: p === s.provider && s.baseUrl ? s.baseUrl : info.baseURL,
					apiKey: undefined
				});
				this.post({ type: 'models', provider: p, models: r.ok ? r.models : [], error: r.error });
				break;
			}
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
		const userMsg: UiMessage = { id: uid(), role: 'user', content: displayText };
		const planMsg: UiMessage = { id: uid(), role: 'assistant', content: '' };
		if (wasFirstTurn) { sess.title = displayText.slice(0, 40); }
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
		const userMsg: UiMessage = { id: uid(), role: 'user', content: displayText };
		const reply: UiMessage = { id: uid(), role: 'assistant', content: '' };
		if (wasFirstTurn) { sess.title = displayText.slice(0, 40); }
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
		const userMsg: UiMessage = { id: uid(), role: 'user', content: opts.displayText ?? text };
		const agentMsg: UiMessage = { id: uid(), role: 'assistant', content: '', steps: [] };
		if (wasFirstTurn) { sess.title = text.slice(0, 40); }
		// A new run supersedes earlier review windows (undoing an old turn after
		// this run writes would silently wipe newer work).
		for (const m of sess.messages) {
			if (m.writes?.length && !m.reviewDismissed) { m.reviewDismissed = true; }
		}
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
			}
		};
		const tools = createTools(host);
		tools.check = createCheck(host);
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
		if (opts.plan) {
			const ref = opts.plan;
			tools.updatePlan = (stepIndex) => {
				this.mutatePlan(ref.sessionId, ref.msgId, (p) => {
					const st = p.steps[stepIndex - 1];
					if (st) { st.done = true; }
				});
			};
		}
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
					maxTokens: 8192,
					extraRules: mcpRules || undefined
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
			this.mutateMsg(sessionId, agentMsg.id, (m) => {
				if (writes.size) { m.writes = Array.from(writes.values()); }
			});
			if (opts.plan) {
				const ref = opts.plan;
				this.mutatePlan(ref.sessionId, ref.msgId, (p) => {
					if (p.status === 'running') { p.status = 'done'; }
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
		const icon = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'nova.svg'));
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${css}">
</head>
<body data-icon="${icon}" data-mode="${mode}">
	<div id="app"></div>
	<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
	}
}
