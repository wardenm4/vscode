/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Persistent project context for agent runs. Reads the cross-tool standards so
// users migrate for free:
//   - AGENTS.md at the workspace root (Linux Foundation standard)
//   - .openova/rules/*.md   (ours; frontmatter: description, globs, alwaysApply)
//   - .cursor/rules/*.mdc   (Cursor's format, same frontmatter keys)
//   - .kiro/steering/*.md   (Kiro steering files — always applied)
//   - .openova/memory.md    (facts the agent chose to remember)
import * as fs from 'fs';
import * as path from 'path';

export interface RuleInfo {
	/** Workspace-relative path (forward slashes). */
	relPath: string;
	source: 'AGENTS.md' | 'openova' | 'cursor' | 'kiro' | 'memory';
	description: string;
	mode: 'always' | 'glob' | 'manual';
	globs: string[];
	/** Whether this rule is injected for the current run. */
	active: boolean;
}

const PER_FILE_CAP = 6000;
const TOTAL_CAP = 16000;

function readSafe(p: string): string {
	try {
		return fs.readFileSync(p, 'utf8');
	} catch {
		return '';
	}
}

/** Minimal YAML-ish frontmatter parser: leading --- block of key: value lines. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!m) { return { meta: {}, body: text }; }
	const meta: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
		if (kv) { meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, ''); }
	}
	return { meta, body: text.slice(m[0].length) };
}

/** Tiny glob matcher supporting ** and * (enough for rule globs). */
export function globMatch(pattern: string, filePath: string): boolean {
	const norm = filePath.replace(/\\/g, '/');
	const rx = pattern
		.replace(/\\/g, '/')
		.replace(/[.+^${}()|[\]]/g, '\\$&')
		.replace(/\*\*/g, '__GLOBSTAR__')
		.replace(/\*/g, '[^/]*')
		.replace(/__GLOBSTAR__/g, '.*')
		.replace(/\?/g, '.');
	return new RegExp(`(^|/)${rx}$`).test(norm) || new RegExp(`^${rx}$`).test(norm);
}

function listFiles(dir: string, exts: string[]): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
			.map((f) => path.join(dir, f));
	} catch {
		return [];
	}
}

export interface CollectedRules {
	/** Text block to append to the system prompt (capped). */
	inject: string;
	/** All discovered rules, with active flags — for the Customize pane. */
	rules: RuleInfo[];
}

/**
 * Collect project rules. `contextPaths` are workspace-relative files in play
 * this run (attachments, active editor) — used to activate glob rules.
 */
export function collectRules(root: string, contextPaths: string[]): CollectedRules {
	const rules: RuleInfo[] = [];
	const sections: { label: string; body: string }[] = [];
	const manual: RuleInfo[] = [];

	const push = (
		abs: string,
		source: RuleInfo['source'],
		mode: RuleInfo['mode'],
		description: string,
		globs: string[],
		body: string
	) => {
		const relPath = path.relative(root, abs).replace(/\\/g, '/');
		let active = mode === 'always';
		if (mode === 'glob') {
			active = contextPaths.some((cp) => globs.some((g) => globMatch(g, cp)));
		}
		const info: RuleInfo = { relPath, source, description, mode, globs, active };
		rules.push(info);
		if (active && body.trim()) {
			sections.push({ label: relPath, body: body.trim().slice(0, PER_FILE_CAP) });
		} else if (!active) {
			manual.push(info);
		}
	};

	// AGENTS.md — the cross-tool standard, always applied.
	const agentsMd = path.join(root, 'AGENTS.md');
	if (fs.existsSync(agentsMd)) {
		push(agentsMd, 'AGENTS.md', 'always', 'Project instructions (AGENTS.md)', [], readSafe(agentsMd));
	}

	// .openova/rules + .cursor/rules — frontmatter decides activation.
	const ruleFiles = [
		...listFiles(path.join(root, '.openova', 'rules'), ['.md', '.mdc']).map((p) => ({ p, src: 'openova' as const })),
		...listFiles(path.join(root, '.cursor', 'rules'), ['.mdc', '.md']).map((p) => ({ p, src: 'cursor' as const }))
	];
	for (const { p, src } of ruleFiles) {
		const { meta, body } = parseFrontmatter(readSafe(p));
		const globs = (meta.globs ?? '')
			.split(',')
			.map((g) => g.trim())
			.filter(Boolean);
		const always = /^true$/i.test(meta.alwaysapply ?? '') || (!globs.length && !meta.description);
		const mode: RuleInfo['mode'] = always ? 'always' : globs.length ? 'glob' : 'manual';
		push(p, src, mode, meta.description ?? path.basename(p), globs, body);
	}

	// .kiro/steering — always applied (Kiro semantics).
	for (const p of listFiles(path.join(root, '.kiro', 'steering'), ['.md'])) {
		push(p, 'kiro', 'always', 'Steering (' + path.basename(p) + ')', [], readSafe(p));
	}

	// Memory — appended facts, always applied.
	const memPath = path.join(root, '.openova', 'memory.md');
	if (fs.existsSync(memPath)) {
		push(memPath, 'memory', 'always', 'Remembered facts', [], readSafe(memPath));
	}

	// Assemble capped inject block.
	let out = '';
	for (const s of sections) {
		const block = `\n## Rules from ${s.label}\n${s.body}\n`;
		if (out.length + block.length > TOTAL_CAP) { break; }
		out += block;
	}
	if (manual.length) {
		out +=
			'\n## Additional project rules (read the file with read_file when relevant)\n' +
			manual.map((r) => `- ${r.relPath} — ${r.description}`).join('\n') +
			'\n';
	}
	return { inject: out.trim() ? `# Project context\n${out.trim()}` : '', rules };
}

/** Append a remembered fact to .openova/memory.md (creates the file). */
export function appendMemory(root: string, fact: string): string {
	const dir = path.join(root, '.openova');
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, 'memory.md');
	if (!fs.existsSync(p)) {
		fs.writeFileSync(p, '# Openova memory\n\nFacts the agent was asked to remember.\n\n');
	}
	fs.appendFileSync(p, `- ${fact.trim().replace(/\r?\n+/g, ' ')}\n`);
	return path.relative(root, p).replace(/\\/g, '/');
}
