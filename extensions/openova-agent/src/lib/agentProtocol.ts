/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pure agent tool-call protocol parser — no renderer deps, so it is
// unit-testable. Turns raw model output into a single tool Action, tolerating
// markdown fences, <think> blocks, self-closing tags, multi-line file bodies
// (including bodies that contain the literal "</tool>"), and a JSON fallback.

export interface Action {
	thought?: string;
	tool: string;
	args: Record<string, unknown>;
}

export const TOOL_NAMES = [
	'list_files',
	'read_file',
	'search',
	'codebase_search',
	'write_file',
	'run_command',
	'update_plan',
	'subagent',
	'mcp_call',
	'screenshot',
	'finish'
];

/** Drop hidden chain-of-thought blocks some local models emit (qwen/deepseek). */
function stripReasoningBlocks(text: string): string {
	return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
}

export function readAttr(attrs: string, name: string): string | undefined {
	const m =
		new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs) ??
		new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i').exec(attrs);
	return m ? m[1] : undefined;
}

/** Strip one wrapping markdown code fence, if the whole body is fenced. */
function stripCodeFence(s: string): string {
	const m = /^\s*```[^\n]*\n([\s\S]*?)\r?\n?```[ \t]*$/.exec(s);
	return m ? m[1] : s;
}

function buildAction(tool: string, attrs: string, body: string): Action {
	const args: Record<string, unknown> = {};
	const path = readAttr(attrs, 'path');
	const query = readAttr(attrs, 'query');
	const summary = readAttr(attrs, 'summary');
	// Trim a single leading newline (after the tag) and trailing whitespace.
	const inner = body.replace(/^\r?\n/, '').replace(/\s+$/, '');
	if (path) {args.path = path;}
	if (query) {args.query = query;}
	if (tool === 'write_file') {
		// Keep the body verbatim, but drop the newline right after the tag, trailing
		// whitespace, and an accidental wrapping ```lang code fence (weak models add one).
		const trimmed = body.replace(/^\r?\n/, '').replace(/[ \t]*\r?\n?$/, '');
		args.content = stripCodeFence(trimmed);
		if (!args.path) {args.path = path ?? '';}
	} else if (tool === 'read_file' && !args.path) {args.path = inner;}
	else if ((tool === 'search' || tool === 'codebase_search') && !args.query) {args.query = inner;}
	else if (tool === 'run_command') {
		args.cmd = readAttr(attrs, 'cmd') ?? inner;
		args.background = readAttr(attrs, 'background') ?? '';
	} else if (tool === 'update_plan') {args.step = readAttr(attrs, 'step') ?? inner;}
	else if (tool === 'subagent') {args.task = readAttr(attrs, 'task') ?? inner;}
	else if (tool === 'screenshot')
		{args.target = readAttr(attrs, 'url') ?? readAttr(attrs, 'target') ?? inner;}
	else if (tool === 'mcp_call') {
		args.server = readAttr(attrs, 'server') ?? '';
		args.tool = readAttr(attrs, 'tool') ?? '';
		args.argsJson = inner || '{}';
	} else if (tool === 'finish') {args.summary = summary ?? (inner || 'Done.');}
	return { tool, args };
}

/** Legacy fallback: extract the first balanced JSON object (older protocol). */
function parseJsonAction(text: string): Action | null {
	const start = text.indexOf('{');
	if (start === -1) {return null;}
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (esc) {esc = false;}
			else if (c === '\\') {esc = true;}
			else if (c === '"') {inStr = false;}
		} else if (c === '"') {inStr = true;}
		else if (c === '{') {depth++;}
		else if (c === '}') {
			depth--;
			if (depth === 0) {
				try {
					const obj = JSON.parse(text.slice(start, i + 1));
					if (obj && typeof obj.tool === 'string') {
						if (typeof obj.args !== 'object' || obj.args === null) {obj.args = {};}
						return obj as Action;
					}
				} catch {
					return null;
				}
				return null;
			}
		}
	}
	return null;
}

export function parseAction(raw: string): Action | null {
	const text = stripReasoningBlocks(raw);

	const withThought = (idx: number, action: Action): Action => {
		const pre = text
			.slice(0, idx)
			.replace(/```[\w-]*/g, '')
			.trim();
		if (pre) {action.thought = pre.slice(0, 400);}
		return action;
	};

	// Preferred: <tool name="X" ...> body </tool>. Handles self-closing tags and
	// bodies that themselves contain the literal "</tool>".
	const open = /<tool\b([^>]*?)(\/?)>/i.exec(text);
	if (open) {
		const name = readAttr(open[1], 'name');
		if (name && TOOL_NAMES.includes(name)) {
			let body = '';
			if (open[2] !== '/') {
				const bodyStart = open.index + open[0].length;
				// write_file bodies may legitimately CONTAIN "</tool>", so take the LAST
				// close when it's the only tool block. Every other tool takes the FIRST
				// close so trailing prose never leaks into its arguments.
				const openCount = (text.match(/<tool\b/gi) ?? []).length;
				const closeIdx =
					name === 'write_file' && openCount <= 1
						? text.lastIndexOf('</tool')
						: text.indexOf('</tool', bodyStart);
				body = closeIdx >= bodyStart ? text.slice(bodyStart, closeIdx) : text.slice(bodyStart);
			}
			return withThought(open.index, buildAction(name, open[1], body));
		}
	}

	// Fallback: <toolname ...> body </toolname> or self-closing <toolname .../>
	let best: { idx: number; tool: string; attrs: string; body: string } | null = null;
	for (const t of TOOL_NAMES) {
		const m = new RegExp(`<${t}\\b([^>]*?)(/?)>`, 'i').exec(text);
		if (!m) {continue;}
		let body = '';
		if (m[2] !== '/') {
			const bodyStart = m.index + m[0].length;
			const closeIdx =
				t === 'write_file' ? text.lastIndexOf(`</${t}`) : text.indexOf(`</${t}`, bodyStart);
			body = closeIdx > bodyStart ? text.slice(bodyStart, closeIdx) : text.slice(bodyStart);
		}
		if (!best || m.index < best.idx) {best = { idx: m.index, tool: t, attrs: m[1] ?? '', body };}
	}
	if (best) {return withThought(best.idx, buildAction(best.tool, best.attrs, best.body));}

	// Last resort: a single JSON object.
	return parseJsonAction(text);
}
