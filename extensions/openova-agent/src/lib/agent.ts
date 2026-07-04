/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AIProvider } from '../types';
import { complete } from './ai';
import { parseAction } from './agentProtocol';

// A provider-agnostic ReAct-style coding agent. The model is told to respond with
// ONE tool call each turn using a robust XML-tag format (so multi-line file
// contents never need JSON escaping); we execute the tool and feed the result
// back, looping until it emits `finish`. Works with any model (no native tool API).

export interface AgentTools {
	listFiles: () => Promise<string[]>;
	readFile: (path: string) => Promise<string>;
	search: (query: string) => Promise<{ file: string; line: number; preview: string }[]>;
	codebaseSearch: (query: string) => Promise<{ file: string; startLine: number; text: string }[]>;
	/** May return a diagnostics note (e.g. type errors) appended to the observation. */
	writeFile: (path: string, content: string) => Promise<string | void>;
	/** Run a shell command (permission-gated by the host). `background` starts a
	 *  long-running process (dev server) in a visible terminal instead. */
	runCommand: (
		cmd: string,
		background?: boolean
	) => Promise<{ output: string; exitCode: number | null; timedOut?: boolean; denied?: boolean }>;
	/** Optional user-configured check (typecheck/lint/test) run before finish. */
	check?: () => Promise<{ output: string; exitCode: number | null }>;
	/** Marks a step of the active plan complete (1-based index). */
	updatePlan?: (stepIndex: number) => void;
	/** Calls an external MCP tool (host-gated). */
	callMcp?: (
		server: string,
		tool: string,
		argsJson: string
	) => Promise<{ ok: boolean; output: string }>;
	/** Captures a screenshot of a URL / HTML file for visual verification. */
	screenshot?: (target: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
	/** Asks the user one multiple-choice question; resolves with their answer. */
	askUser?: (question: string, options: string[]) => Promise<string>;
	/**
	 * Shows an editable plan checklist and waits for the user's decision.
	 * Resolves with the approved step list (possibly edited) or null if the
	 * user cancelled the plan.
	 */
	proposePlan?: (title: string, steps: string[]) => Promise<string[] | null>;
}

export interface AgentConfig {
	provider: AIProvider;
	apiKey?: string;
	baseURL?: string;
	model: string;
	maxTokens: number;
	/** User + project AI rules appended to the agent system prompt. */
	extraRules?: string;
}

export interface AgentCallbacks {
	onThought: (text: string) => void;
	onAction: (name: string, args: Record<string, unknown>) => void;
	onObservation: (text: string, isError?: boolean) => void;
	onFinish: (summary: string) => void;
	onError: (err: string) => void;
	shouldStop: () => boolean;
	/** Reports the active model-request id each turn so the run can be aborted. */
	onRequestStart?: (requestId: string) => void;
	/** Drains user feedback left mid-run (Antigravity-style plan comments). */
	getPendingFeedback?: () => string[];
	/** Reports per-turn character counts so the host can estimate tokens/cost. */
	onUsage?: (promptChars: number, completionChars: number) => void;
	/** Live model output for the current turn (full text so far) — for streaming UI. */
	onStreamDelta?: (fullText: string) => void;
	/**
	 * Step budget exhausted. Resolve true to grant another budget and RESUME
	 * the run in place (full context kept); false ends it. Without this
	 * callback the run ends with an error like before.
	 */
	onPause?: (stepsUsed: number) => Promise<boolean>;
}

const SYSTEM = `You are Openova Agent, an autonomous coding agent working inside a code editor with full access to the user's workspace. You complete the user's task by taking one action at a time.

Each turn: optionally write ONE short sentence of reasoning, then call EXACTLY ONE tool using this format:

<tool name="TOOL_NAME" attr="value">optional body</tool>

Tools:
<tool name="list_files"></tool>
    List every file in the workspace.
<tool name="read_file" path="relative/path"></tool>
    Read a file's contents.
<tool name="search" query="exact text"></tool>
    Find where exact text appears in the workspace.
<tool name="codebase_search" query="what you're looking for"></tool>
    Semantic search across the codebase.
<tool name="write_file" path="relative/path">
FULL contents of the file, exactly as they should be saved to disk.
</tool>
    Create or overwrite a file. The body is written to disk verbatim.
<tool name="run_command">npm test</tool>
    Run a shell command in the workspace root (put the command in the body).
    Use it to install dependencies, run tests/builds, and inspect git. Output
    and exit code come back as the result. Commands may need user approval.
    For a long-running process (a dev server), add background="true" — it runs
    in a visible terminal and you continue immediately.
<tool name="update_plan" step="2"></tool>
    Only when the task includes a numbered plan: mark that plan step complete
    right after you finish it.
<tool name="subagent">a complete, self-contained subtask description</tool>
    Delegate a focused subtask (e.g. "write unit tests for src/utils.js") to a
    fresh subagent with its own context window. Use it to keep big tasks
    manageable; you get back a summary of what it did.
<tool name="screenshot">http://localhost:5173 or relative/page.html</tool>
    Capture a screenshot of a URL or HTML file you built, to visually verify
    UI work. The image is attached to the conversation for the user to review.
<tool name="ask_user" question="How should we build it? (I recommend A for a basic app.)">
A — Single-page web app, data in localStorage. Fastest, works offline.
B — Next.js + cloud database. Sync across devices, more setup.
</tool>
    Ask the user ONE multiple-choice question when a decision genuinely
    changes what you will build (stack, scope, design direction). One option
    per body line; include your recommendation in the question. The run waits
    for their answer. Use at most once or twice per task, near the start.
<tool name="propose_plan" title="Habit tracker v1">
1. Create index.html with the page structure
2. Create style.css with the dark theme
3. Create script.js with habit CRUD + localStorage
</tool>
    Present your implementation plan as a checklist and WAIT for the user to
    approve (they can edit the steps). The result is the final step list.
<tool name="finish">your answer or a short summary of what you built (markdown ok)</tool>
    Call this when the task is complete — or IMMEDIATELY when the user is
    just asking a question: put the full answer in the body.

WORKFLOW — how to run a task:
0. If the message is a QUESTION or conversation (nothing to build or change),
   answer it directly: call finish right away with the complete answer in the
   body. Use the conversation context and workspace info you already have —
   only explore files if the answer genuinely requires reading them.
1. UNDERSTAND first: for anything beyond a trivial edit, briefly explore the
   workspace (list_files, read key files) before writing code.
2. If the request leaves an important decision open (scope, stack, design
   direction), ask ONE ask_user question — include your recommendation.
3. PLAN: for tasks that create or change more than one file, call
   propose_plan with 3-8 concrete steps and wait for approval. Do NOT start
   implementing before the plan is approved.
4. IMPLEMENT: work through the approved steps in order; call update_plan
   after finishing each step so the user sees progress.
5. Call finish with a one-sentence summary.
Trivial tasks (one small file or edit) skip steps 2-3 — just do them.

Rules:
- Explore with list_files / read_file before editing existing code.
- Build everything the task needs — create each file (HTML, CSS, JS, package.json, etc.) with its own write_file turn.
- The write_file body is saved exactly as written: do NOT escape it, wrap it in markdown code fences, or add commentary inside it.
- Provide COMPLETE file contents every time (never a diff or a "// rest unchanged").
- Write each file once with its complete, final contents. Do NOT rewrite a file you already wrote unless you genuinely need to fix a specific problem in it.
- As soon as every file the task needs exists, call finish immediately — don't keep polishing.
- Output at most one short reasoning sentence and exactly one <tool> block per turn — nothing else.`;

export async function runAgent(
	task: string,
	tools: AgentTools,
	config: AgentConfig,
	cb: AgentCallbacks,
	maxSteps = 40,
	depth = 0
): Promise<void> {
	const transcript: { role: 'user' | 'assistant'; content: string }[] = [
		{ role: 'user', content: `Task: ${task}` }
	];

	let misfires = 0;
	// Diagnostics loop: run the user-configured check before accepting `finish`
	// when files changed since the last check; give up blocking after 2 failures.
	let writesSinceCheck = 0;
	let checkFailures = 0;
	// Plan-first enforcement: multi-file work requires an approved plan. Weak
	// models ignore prompt guidance, so the loop enforces it mechanically.
	let planSettled = depth > 0 || !tools.proposePlan;
	const writtenPaths = new Set<string>();
	// Rewrite-loop guard: weak models burn entire step budgets rewriting the
	// same file. Track per-file write counts and last-content fingerprints.
	const writeCounts = new Map<string, number>();
	const lastContent = new Map<string, string>();

	// The step cap is a BUDGET, not a wall: when it runs out the host can ask
	// the user and grant another round — the loop resumes with context intact.
	let budget = maxSteps;
	let step = 0;
	for (;;) {
		if (step >= budget) {
			const more = cb.onPause ? await cb.onPause(step) : false;
			if (!more) {
				cb.onError(`Stopped after ${step} steps without finishing.`);
				return;
			}
			budget += maxSteps;
		}
		step++;
		if (cb.shouldStop()) {return;}

		// Merge any mid-run user feedback into the conversation (keeps the run going
		// instead of restarting — Antigravity-style). Role-alternation safe.
		const feedback = cb.getPendingFeedback?.() ?? [];
		if (feedback.length) {
			const fbText = `User feedback (incorporate without restarting):\n- ${feedback.join('\n- ')}`;
			const last = transcript[transcript.length - 1];
			if (last && last.role === 'user') {last.content += `\n\n${fbText}`;}
			else {transcript.push({ role: 'user', content: fbText });}
		}

		let raw: string;
		const requestId = Math.random().toString(36).slice(2);
		cb.onRequestStart?.(requestId);
		try {
			raw = await complete(
				{
					requestId,
					provider: config.provider,
					apiKey: config.apiKey,
					baseURL: config.baseURL,
					model: config.model,
					system: config.extraRules?.trim()
						? `${SYSTEM}\n\n# Additional rules to follow\n${config.extraRules.trim()}`
						: SYSTEM,
					messages: transcript,
					temperature: 0,
					maxTokens: config.maxTokens
				},
				(full) => cb.onStreamDelta?.(full)
			);
		} catch (e) {
			cb.onError(e instanceof Error ? e.message : String(e));
			return;
		}
		cb.onStreamDelta?.(''); // clear the live buffer now the turn is parsed

		cb.onUsage?.(
			SYSTEM.length +
			(config.extraRules?.length ?? 0) +
			transcript.reduce((n, m) => n + m.content.length, 0),
			raw.length
		);

		// The stream may have finished with a full action buffered right as the user
		// hit Stop — don't execute that action's side effect after an abort.
		if (cb.shouldStop()) {return;}

		const action = parseAction(raw);
		if (!action) {
			// Model didn't follow the protocol — nudge it with the exact format.
			// The nudge is transcript-only: surfacing it as an observation stacked
			// noisy "(no tool call detected…)" rows in the UI on every retry.
			misfires++;
			if (misfires >= 4) {
				cb.onError('The model kept replying without a valid tool call. Try a more capable model.');
				return;
			}
			transcript.push({ role: 'assistant', content: raw.slice(0, 2000) });
			transcript.push({
				role: 'user',
				content:
					'That did not contain a valid tool call. Reply with exactly one tool block, e.g.\n' +
					'<tool name="write_file" path="index.html">\n<!doctype html>...\n</tool>\n' +
					'or <tool name="finish">summary</tool> when done.'
			});
			continue;
		}
		misfires = 0;

		if (action.thought) {cb.onThought(action.thought);}
		// `finish` is reported via onFinish; don't also emit a stuck "running" card.
		if (action.tool !== 'finish') {cb.onAction(action.tool, action.args);}
		// Echo the action into the transcript — but never re-embed full file bodies
		// (that would blow the context window on multi-file builds).
		const echo =
			action.tool === 'write_file'
				? `<tool name="write_file" path="${String(action.args.path ?? '')}">…</tool>`
				: action.tool === 'run_command'
					? `<tool name="run_command">${String(action.args.cmd ?? '')}</tool>`
					: `<tool name="${action.tool}"${action.args.path ? ` path="${String(action.args.path)}"` : ''}${action.args.query ? ` query="${String(action.args.query)}"` : ''
					}></tool>`;
		transcript.push({ role: 'assistant', content: echo });

		let observation = '';
		let toolFailed = false;
		try {
			switch (action.tool) {
				case 'list_files': {
					const files = await tools.listFiles();
					observation = files.slice(0, 400).join('\n') || '(workspace is empty)';
					break;
				}
				case 'read_file': {
					const content = await tools.readFile(String(action.args.path ?? ''));
					observation = content.slice(0, 12000);
					break;
				}
				case 'search': {
					const results = await tools.search(String(action.args.query ?? ''));
					observation =
						results
							.slice(0, 40)
							.map((r) => `${r.file}:${r.line}: ${r.preview}`)
							.join('\n') || '(no matches)';
					break;
				}
				case 'codebase_search': {
					const results = await tools.codebaseSearch(String(action.args.query ?? ''));
					observation =
						results
							.slice(0, 6)
							.map((r) => `${r.file}:${r.startLine}\n${r.text}`)
							.join('\n---\n') || '(no matches)';
					break;
				}
				case 'write_file': {
					const p = String(action.args.path ?? '');
					if (!p) {
						observation = 'Error: write_file needs a path attribute.';
						toolFailed = true;
						break;
					}
					if (!planSettled && writtenPaths.size >= 1 && !writtenPaths.has(p)) {
						observation =
							'STOP — this task touches multiple files, so the user must approve a plan first. ' +
							'Call propose_plan now with 3-8 concrete steps (one per line), wait for approval, then continue implementing.';
						toolFailed = true;
						break;
					}
					const content = String(action.args.content ?? '');
					if (lastContent.get(p) === content) {
						observation = `STOP — you already wrote ${p} with exactly this content. It is saved. Move on to the next step or call finish.`;
						toolFailed = true;
						break;
					}
					const rewrites = writeCounts.get(p) ?? 0;
					if (rewrites >= 4) {
						observation = `STOP — you have rewritten ${p} ${rewrites} times. The file is saved; do NOT write it again. Move on to the next step or call finish.`;
						toolFailed = true;
						break;
					}
					const note = await tools.writeFile(p, content);
					writtenPaths.add(p);
					writeCounts.set(p, rewrites + 1);
					lastContent.set(p, content);
					writesSinceCheck++;
					observation = `Saved ${p}${typeof note === 'string' && note ? `\n${note}` : ''}`;
					break;
				}
				case 'run_command': {
					const cmd = String(action.args.cmd ?? '').trim();
					if (!cmd) {
						observation = 'Error: run_command needs a command in the tool body.';
						toolFailed = true;
						break;
					}
					const bg = String(action.args.background ?? '').toLowerCase() === 'true';
					const r = await tools.runCommand(cmd, bg);
					if (r.denied) {
						observation = 'The user declined to run this command. Try another approach.';
						toolFailed = true;
						break;
					}
					observation = `exit code: ${r.exitCode ?? 'none'}${r.timedOut ? ' (timed out)' : ''}\n${r.output.trim() || '(no output)'
						}`;
					toolFailed = r.exitCode !== 0;
					break;
				}
				case 'subagent': {
					const subtask = String(action.args.task ?? '').trim();
					if (!subtask) {
						observation = 'Error: subagent needs a task description in the tool body.';
						toolFailed = true;
						break;
					}
					if (depth >= 1) {
						observation = 'Error: subagents cannot spawn further subagents — do the work directly.';
						toolFailed = true;
						break;
					}
					// Run a nested agent with a FRESH transcript (isolated context); only
					// its action trace + finish summary flow back to this conversation.
					const trace: string[] = [];
					let summary = '';
					let failed = false;
					await runAgent(
						subtask,
						tools,
						config,
						{
							onThought: () => { },
							onAction: (name, a) =>
								trace.push(
									`${name}${a.path
										? ` ${a.path}`
										: a.cmd
											? ` ${String(a.cmd).slice(0, 60)}`
											: a.query
												? ` "${a.query}"`
												: ''
									}`
								),
							onObservation: () => { },
							onFinish: (s) => {
								summary = s;
							},
							onError: (e) => {
								summary = `Subagent error: ${e}`;
								failed = true;
							},
							shouldStop: cb.shouldStop,
							onRequestStart: cb.onRequestStart,
							onUsage: cb.onUsage
						},
						20,
						depth + 1
					);
					// Subagent writes count toward the parent's finish-check gate.
					if (trace.some((t) => t.startsWith('write_file'))) {writesSinceCheck++;}
					observation = `${summary || 'Subagent finished without a summary.'}\n\nSubagent actions:\n${trace.map((t) => `  ${t}`).join('\n') || '  (none)'
						}`;
					toolFailed = failed;
					break;
				}
				case 'screenshot': {
					const target = String(action.args.target ?? '').trim();
					if (!tools.screenshot) {
						observation = 'Screenshots are not available here.';
						toolFailed = true;
						break;
					}
					if (!target) {
						observation = 'Error: screenshot needs a URL or file path.';
						toolFailed = true;
						break;
					}
					const r = await tools.screenshot(target);
					observation = r.ok
						? `Screenshot saved to ${r.path} (attached for the user to review).`
						: `Error: ${r.error ?? 'capture failed'}`;
					toolFailed = !r.ok;
					break;
				}
				case 'mcp_call': {
					const server = String(action.args.server ?? '').trim();
					const toolName = String(action.args.tool ?? '').trim();
					if (!tools.callMcp) {
						observation = 'No MCP servers are configured.';
						toolFailed = true;
						break;
					}
					if (!server || !toolName) {
						observation = 'Error: mcp_call needs server and tool attributes.';
						toolFailed = true;
						break;
					}
					const r = await tools.callMcp(server, toolName, String(action.args.argsJson ?? '{}'));
					observation = r.output.slice(0, 12000);
					toolFailed = !r.ok;
					break;
				}
				case 'ask_user': {
					const question = String(action.args.question ?? '').trim();
					const options = Array.isArray(action.args.options)
						? (action.args.options as string[])
						: [];
					if (!tools.askUser) {
						observation = 'Asking the user is not available here — use your best judgment.';
						break;
					}
					if (!question) {
						observation = 'Error: ask_user needs a question attribute.';
						toolFailed = true;
						break;
					}
					const answer = await tools.askUser(question, options);
					observation = `User answered: ${answer}`;
					break;
				}
				case 'propose_plan': {
					const planTitle = String(action.args.title ?? 'Plan');
					const planSteps = Array.isArray(action.args.steps)
						? (action.args.steps as string[])
						: [];
					if (!tools.proposePlan) {
						observation = 'Plan display is not available — proceed step by step.';
						break;
					}
					if (planSteps.length < 2) {
						observation = 'Error: propose_plan needs at least 2 steps (one per body line).';
						toolFailed = true;
						break;
					}
					const approved = await tools.proposePlan(planTitle, planSteps);
					planSettled = true;
					if (approved === null) {
						observation =
							'The user cancelled the plan. Ask what they want instead with ask_user, or finish.';
						toolFailed = true;
					} else {
						observation =
							'Plan approved. Final steps:\n' +
							approved.map((s, idx) => `${idx + 1}. ${s}`).join('\n') +
							'\nImplement them in order, calling update_plan after each.';
					}
					break;
				}
			case 'update_plan': {
					const n = parseInt(String(action.args.step ?? ''), 10);
					if (Number.isFinite(n) && n > 0 && tools.updatePlan) {
						tools.updatePlan(n);
						observation = `Marked plan step ${n} complete.`;
					} else {
						observation = tools.updatePlan
							? 'Invalid step number for update_plan.'
							: '(no active plan — continue with the task)';
					}
					break;
				}
				case 'finish': {
					// Diagnostics gate: refuse to finish while the configured check fails.
					if (tools.check && writesSinceCheck > 0 && checkFailures < 2) {
						cb.onAction('check', {});
						let res: { output: string; exitCode: number | null };
						try {
							res = await tools.check();
						} catch (e) {
							res = { output: e instanceof Error ? e.message : String(e), exitCode: null };
						}
						// Only a PASSING check clears the gate — otherwise a second finish
						// call would sail through without fixing anything.
						if (res.exitCode === 0) {writesSinceCheck = 0;}
						if (res.exitCode !== 0) {
							checkFailures++;
							const failObs = `Check failed (exit ${res.exitCode ?? 'none'}). Fix the problems below, then call finish again.\n${res.output.slice(0, 6000)}`;
							cb.onObservation(failObs, true);
							// The finish echo is already in the transcript (pushed above the
							// switch); only append the user-side result to keep roles alternating.
							transcript.push({ role: 'user', content: `Result:\n${failObs}` });
							continue;
						}
						cb.onObservation('All checks passed.', false);
					}
					cb.onFinish(String(action.args.summary ?? 'Done.'));
					return;
				}
				default:
					observation = `Unknown tool: ${action.tool}`;
					toolFailed = true;
			}
		} catch (e) {
			observation = `Error: ${e instanceof Error ? e.message : String(e)}`;
			toolFailed = true;
		}

		cb.onObservation(observation, toolFailed);
		transcript.push({ role: 'user', content: `Result:\n${observation}` });
	}
}
