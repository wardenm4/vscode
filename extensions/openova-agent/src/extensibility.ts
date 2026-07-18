/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The extensibility trio (Claude Code's model, open formats):
//  - Skills:    SKILL.md folders, loaded ON DEMAND by description match
//               (progressive disclosure — critical for local-model budgets).
//  - Hooks:     .openova/hooks.json — deterministic shell commands at
//               lifecycle events; a non-zero PreToolUse exit BLOCKS the tool.
//  - Subagents: .openova/agents/*.md — named agent types with their own
//               system-prompt addition, optional model and tool allowlist.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { parseFrontmatter } from './rules';

// ---- skills ----------------------------------------------------------------

export interface SkillInfo {
	name: string;
	description: string;
	/** Absolute path to the SKILL.md file. */
	file: string;
	source: 'workspace' | 'user';
}

const SKILL_BODY_CAP = 9000; // ~1500 words — the recommended ceiling

function scanSkillDir(base: string, source: SkillInfo['source']): SkillInfo[] {
	const out: SkillInfo[] = [];
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(base);
	} catch {
		return out;
	}
	for (const e of entries) {
		const file = path.join(base, e, 'SKILL.md');
		if (!fs.existsSync(file)) { continue; }
		try {
			const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
			out.push({
				name: (meta.name || e).trim(),
				description: (meta.description || '').trim() || e,
				file,
				source
			});
		} catch {
			/* unreadable skill */
		}
	}
	return out;
}

export function discoverSkills(root: string): SkillInfo[] {
	const seen = new Set<string>();
	const all = [
		...scanSkillDir(path.join(root, '.openova', 'skills'), 'workspace'),
		...scanSkillDir(path.join(os.homedir(), '.openova', 'skills'), 'user')
	];
	// workspace wins on name collisions
	return all.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

export function loadSkill(root: string, name: string): string {
	const skill = discoverSkills(root).find((s) => s.name.toLowerCase() === name.toLowerCase());
	if (!skill) {
		const names = discoverSkills(root).map((s) => s.name).join(', ') || '(none)';
		return `No skill named "${name}". Available: ${names}`;
	}
	const { body } = parseFrontmatter(fs.readFileSync(skill.file, 'utf8'));
	return `Skill "${skill.name}" loaded — follow these instructions now:\n\n${body.trim().slice(0, SKILL_BODY_CAP)}`;
}

// ---- hooks -----------------------------------------------------------------

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop';

interface HookDef {
	command: string;
	timeoutMs?: number;
}

function readHooks(root: string): Partial<Record<HookEvent, HookDef[]>> {
	try {
		const raw = fs.readFileSync(path.join(root, '.openova', 'hooks.json'), 'utf8');
		const parsed = JSON.parse(raw) as Partial<Record<HookEvent, HookDef[]>>;
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

export function hasHooks(root: string): boolean {
	return Object.keys(readHooks(root)).length > 0;
}

export function listHooks(root: string): { event: string; command: string }[] {
	const defs = readHooks(root);
	const out: { event: string; command: string }[] = [];
	for (const [event, arr] of Object.entries(defs)) {
		for (const d of arr ?? []) { out.push({ event, command: d.command }); }
	}
	return out;
}

function runOne(root: string, def: HookDef, env: Record<string, string>): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		const child = cp.spawn(def.command, [], {
			shell: true,
			cwd: root,
			windowsHide: true,
			env: { ...process.env, ...env }
		});
		let output = '';
		const cap = (b: Buffer): void => {
			if (output.length < 8000) { output += b.toString('utf8'); }
		};
		child.stdout?.on('data', cap);
		child.stderr?.on('data', cap);
		let done = false;
		const timer = setTimeout(() => {
			if (done) { return; }
			done = true;
			try { child.kill(); } catch { /* gone */ }
			resolve({ code: null, output: output + '\n(hook timed out)' });
		}, def.timeoutMs ?? 10_000);
		child.on('error', (e) => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			resolve({ code: null, output: e.message });
		});
		child.on('close', (code) => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

/**
 * Run every hook for an event. Returns the first BLOCKING result (non-zero
 * exit) for PreToolUse, else the concatenated stdout of all hooks.
 */
export async function runHooks(
	root: string,
	event: HookEvent,
	env: Record<string, string> = {}
): Promise<{ blocked: string | null; output: string }> {
	const defs = readHooks(root)[event] ?? [];
	let output = '';
	for (const def of defs) {
		const r = await runOne(root, def, { OPENOVA_EVENT: event, OPENOVA_ROOT: root, ...env });
		if (r.output.trim()) { output += (output ? '\n' : '') + r.output.trim(); }
		if (event === 'PreToolUse' && r.code !== 0 && r.code !== null) {
			return { blocked: r.output.trim() || `hook exited ${r.code}`, output };
		}
	}
	return { blocked: null, output: output.slice(0, 2000) };
}

// ---- subagents -------------------------------------------------------------

export interface SubagentDef {
	name: string;
	description: string;
	model?: string;
	/** Allowed tool names (protocol names); empty = all tools. */
	tools: string[];
	/** System-prompt addition (the file body). */
	prompt: string;
}

export function discoverSubagents(root: string): SubagentDef[] {
	const dir = path.join(root, '.openova', 'agents');
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
	} catch {
		return [];
	}
	const out: SubagentDef[] = [];
	for (const f of entries) {
		try {
			const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
			out.push({
				name: (meta.name || path.basename(f, '.md')).trim(),
				description: (meta.description || '').trim() || path.basename(f, '.md'),
				model: meta.model?.trim() || undefined,
				tools: (meta.tools ?? '')
					.split(',')
					.map((t) => t.trim())
					.filter(Boolean),
				prompt: body.trim().slice(0, SKILL_BODY_CAP)
			});
		} catch {
			/* unreadable agent def */
		}
	}
	return out;
}
