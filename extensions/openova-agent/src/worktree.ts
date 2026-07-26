/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Git worktree helpers: isolated checkouts used both by the "New Worktree"
// command and by best-of-N parallel runs (each candidate agent works in its
// own worktree, so concurrent runs never fight over the same files).
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitResult {
	ok: boolean;
	out: string;
}

export function git(args: string, cwd: string, timeoutMs = 30_000): Promise<GitResult> {
	return new Promise((resolve) => {
		cp.exec(`git ${args}`, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
			resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })
		);
	});
}

export async function isGitRepo(root: string): Promise<boolean> {
	return (await git('rev-parse --git-dir', root, 8000)).ok;
}

/** Sibling directory name for a worktree of `root` on `branch`. */
export function worktreePath(root: string, branch: string): string {
	const safe = branch.replace(/[^\w.-]+/g, '-');
	return path.join(path.dirname(root), `${path.basename(root)}-wt-${safe}`);
}

export async function addWorktree(root: string, branch: string): Promise<{ ok: boolean; dir: string; out: string }> {
	const dir = worktreePath(root, branch);
	const r = await git(`worktree add -b "${branch}" "${dir}"`, root);
	return { ok: r.ok, dir, out: r.out };
}

/** Remove a worktree and its branch; best-effort (never throws). */
export async function removeWorktree(root: string, dir: string, branch: string): Promise<void> {
	await git(`worktree remove --force "${dir}"`, root);
	await git(`branch -D "${branch}"`, root);
	// `worktree remove` leaves nothing behind normally; clean up if it failed.
	try {
		if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); }
	} catch {
		/* locked — the user can prune later */
	}
	await git('worktree prune', root);
}

export interface ChangedFile {
	/** Workspace-relative path, forward slashes. */
	path: string;
	status: 'added' | 'modified' | 'deleted';
}

/** What an agent changed inside a worktree, per git (covers tool writes AND
 *  anything its shell commands produced). Skips agent-private state. */
export async function changedFiles(dir: string): Promise<ChangedFile[]> {
	const r = await git('status --porcelain=v1 --untracked-files=all', dir);
	if (!r.ok) { return []; }
	const out: ChangedFile[] = [];
	for (const line of r.out.split(/\r?\n/)) {
		if (line.length < 4) { continue; }
		const code = line.slice(0, 2);
		let rel = line.slice(3).trim();
		// Renames come through as "old -> new"; take the new path.
		const arrow = rel.indexOf(' -> ');
		if (arrow !== -1) { rel = rel.slice(arrow + 4); }
		rel = rel.replace(/^"|"$/g, '').replace(/\\/g, '/');
		if (/^\.openova\//.test(rel) || rel === '.openova') { continue; }
		const status: ChangedFile['status'] =
			code.includes('D') ? 'deleted' : code.includes('?') || code.includes('A') ? 'added' : 'modified';
		out.push({ path: rel, status });
	}
	return out;
}

export interface AppliedFile {
	path: string;
	fullPath: string;
	/** Pre-apply contents of the target, when it existed and was small enough. */
	before?: string;
	after: string;
	existed: boolean;
}

const MAX_SNAPSHOT = 262_144;

/**
 * Copy a candidate worktree's changes onto the main checkout. Returns one
 * entry per applied file so the caller can build the normal review/undo
 * ledger. Deletions are applied too (reported with after === '').
 */
export function applyChanges(fromDir: string, toRoot: string, files: ChangedFile[]): AppliedFile[] {
	const applied: AppliedFile[] = [];
	for (const f of files) {
		const src = path.join(fromDir, f.path);
		const dest = path.join(toRoot, f.path);
		// Never let a candidate path escape the target root.
		if (!path.resolve(dest).startsWith(path.resolve(toRoot) + path.sep)) { continue; }
		let before: string | undefined;
		let existed = false;
		try {
			const stat = fs.statSync(dest);
			existed = stat.isFile();
			if (existed && stat.size <= MAX_SNAPSHOT) { before = fs.readFileSync(dest, 'utf8'); }
		} catch {
			existed = false;
		}
		try {
			if (f.status === 'deleted') {
				if (existed) { fs.rmSync(dest, { force: true }); }
				applied.push({ path: f.path, fullPath: dest, before, after: '', existed });
				continue;
			}
			const content = fs.readFileSync(src);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, content);
			applied.push({
				path: f.path,
				fullPath: dest,
				before,
				after: content.length <= MAX_SNAPSHOT ? content.toString('utf8') : '',
				existed
			});
		} catch {
			/* skip files we cannot read/write — reported by count difference */
		}
	}
	return applied;
}
