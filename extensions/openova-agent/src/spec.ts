/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Kiro-style spec-driven development: requirements (EARS) -> design -> tasks,
// each stage a durable markdown doc under .openova/specs/<slug>/ and gated by
// user approval before the next stage runs. Pure helpers here (prompts,
// parsing, file placement) so the flow is unit-testable without vscode.
import * as fs from 'fs';
import * as path from 'path';

export function specSlug(title: string): string {
	return (
		title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'feature'
	);
}

export function specDir(root: string, slug: string): string {
	return path.join(root, '.openova', 'specs', slug);
}

/**
 * Write a spec doc without ever clobbering existing content silently: if the
 * file already exists with different content, the new doc gets a -2/-3...
 * suffix (Kiro's overwrite-user-docs failure mode, avoided by construction).
 * Returns the path actually written.
 */
export function writeSpecFile(dir: string, name: string, content: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const base = name.replace(/\.md$/i, '');
	let target = path.join(dir, `${base}.md`);
	for (let i = 2; fs.existsSync(target); i++) {
		try {
			if (fs.readFileSync(target, 'utf8') === content) { return target; }
		} catch { /* unreadable -> pick a fresh name */ }
		target = path.join(dir, `${base}-${i}.md`);
	}
	fs.writeFileSync(target, content, 'utf8');
	return target;
}

// ---- stage prompts ---------------------------------------------------------

export const TRIVIAL_MARKER = 'TRIVIAL';

export function requirementsPrompt(): string {
	return (
		'You are a senior product engineer writing requirements for a coding task. ' +
		'If the task is genuinely trivial (one small edit or file, no real design decisions), reply with ONLY the word ' +
		TRIVIAL_MARKER +
		'. Otherwise reply with ONLY a markdown document in EXACTLY this shape:\n' +
		'# Requirements: <short feature title>\n\n' +
		'## R1. <requirement name>\n' +
		'As a <user>, I want <capability>, so that <benefit>.\n' +
		'- WHEN <trigger or state> THEN the system SHALL <observable behavior>\n' +
		'- WHEN <another case, including error/edge cases> THEN the system SHALL <behavior>\n\n' +
		'## R2. <requirement name>\n...\n\n' +
		'Use 2-6 requirements, each with 2-4 EARS acceptance criteria (WHEN/THEN, SHALL). ' +
		'Cover error and edge cases, not just the happy path. No prose outside the format.'
	);
}

export function designPrompt(): string {
	return (
		'You are a senior software architect. Given the requirements document, reply with ONLY a markdown design doc in this shape:\n' +
		'# Design: <feature title>\n\n' +
		'## Overview\n<2-4 sentences>\n\n' +
		'## Files\n- `path/to/file` — what it is and why (new or modified)\n\n' +
		'## Components\n<key functions/classes/data structures and how they interact; reference requirement ids like (R1)>\n\n' +
		'## Edge cases\n- <edge case and how the design handles it> (R2)\n\n' +
		'Ground every choice in the requirements by id. Prefer the simplest design that satisfies them. No prose outside the format.'
	);
}

export function tasksPrompt(): string {
	return (
		'You are a tech lead breaking a design into implementation tasks. Reply with ONLY a markdown doc in this shape:\n' +
		'# Tasks: <feature title>\n\n' +
		'- [ ] 1. <concrete task: a specific file to create/modify or command to run> (R1)\n' +
		'- [ ] 2. <next task> (R2, R3)\n\n' +
		'Rules: 3-10 tasks, strictly ordered, each one independently completable and traceable to requirement ids in parentheses. ' +
		'The last task verifies the work (run/tests/manual check). No prose outside the format.'
	);
}

// ---- parsing ---------------------------------------------------------------

/** "# Requirements: Foo bar" -> "Foo bar" (falls back to the given default). */
export function docTitle(md: string, fallback: string): string {
	const m = /^#\s*(?:Requirements|Design|Tasks)\s*:\s*(.+)$/im.exec(md);
	return (m?.[1] ?? fallback).trim().slice(0, 60);
}

/** Section headers "## R1. Name" -> ["R1. Name", ...] for the approval card. */
export function requirementTitles(md: string): string[] {
	return [...md.matchAll(/^##\s+(R\d+\.?\s*.+)$/gim)].map((m) => m[1].trim()).slice(0, 12);
}

/** Checkbox lines -> step texts for the executable plan card. */
export function taskSteps(md: string): string[] {
	return [...md.matchAll(/^[-*]\s*\[[ xX]?\]\s*(.+)$/gm)]
		.map((m) => m[1].replace(/^\d+[.)]\s*/, '').trim())
		.filter(Boolean)
		.slice(0, 16);
}

/** Rewrite tasks.md checkboxes to match completed step indices (1-based). */
export function checkOffTasks(md: string, doneIndices: Set<number>): string {
	let i = 0;
	return md.replace(/^([-*]\s*)\[[ xX]?\]/gm, (_m, pre) => {
		i++;
		return `${pre}[${doneIndices.has(i) ? 'x' : ' '}]`;
	});
}
