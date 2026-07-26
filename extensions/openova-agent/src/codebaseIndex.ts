/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Workspace indexer for codebase_search: walks the tree (fs, no vscode dep so
// it unit-tests standalone), chunks text files, and keeps one cached BM25
// index per root with a short TTL — an agent run rebuilds at most once a
// minute, and queries within a run hit the cache.
import * as fs from 'fs';
import * as path from 'path';
import { buildIndex, chunkFile, queryIndex, type Bm25Index, type Chunk } from './lib/bm25';

const SKIP_DIRS = new Set([
	'node_modules', '.git', 'out', 'dist', 'build', '.openova', '.build',
	'coverage', 'target', 'bin', 'obj', '.next', '.venv', 'venv', '__pycache__',
	'.cache', '.turbo', '.gradle', '.idea', '.nuxt', '.svelte-kit', '.pytest_cache'
]);
const SKIP_EXT = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.zip',
	'.gz', '.tar', '.7z', '.exe', '.dll', '.node', '.woff', '.woff2', '.ttf',
	'.eot', '.mp3', '.mp4', '.mov', '.lock', '.map'
]);
/** Minified bundles: extname() only sees ".js", so match the whole name. */
const SKIP_NAME = /\.min\.(js|css)$/i;
/**
 * Never index credential files. codebase_search results flow straight into
 * the model's context (and therefore to whichever provider serves the turn),
 * so a .env chunk would exfiltrate live keys.
 */
const SECRET_NAME = /^(\.env($|\.)|\.npmrc$|\.netrc$|\.pypirc$|id_[rd]sa|.*\.pem$|.*\.key$|.*\.pfx$|.*\.p12$|credentials$|\.git-credentials$)/i;
const MAX_FILES = 1200;
const MAX_FILE_BYTES = 262_144;
const TTL_MS = 60_000;

function collectFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (out.length >= MAX_FILES || depth > 12) { return; }
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (out.length >= MAX_FILES) { return; }
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				// Only the named dot-dirs are skipped: .github/.vscode/.husky
				// hold real, searchable project config.
				if (!SKIP_DIRS.has(e.name.toLowerCase())) { walk(full, depth + 1); }
			} else if (e.isFile()) {
				const ext = path.extname(e.name).toLowerCase();
				if (SKIP_EXT.has(ext) || SKIP_NAME.test(e.name) || SECRET_NAME.test(e.name)) { continue; }
				out.push(full);
			}
		}
	};
	walk(root, 0);
	return out;
}

function buildChunksFrom(root: string, files: string[]): Chunk[] {
	const chunks: Chunk[] = [];
	for (const full of files) {
		try {
			const stat = fs.statSync(full);
			if (stat.size > MAX_FILE_BYTES || stat.size === 0) { continue; }
			const content = fs.readFileSync(full, 'utf8');
			if (content.includes(String.fromCharCode(0))) { continue; } // binary
			const rel = path.relative(root, full).replace(/\\/g, '/');
			chunks.push(...chunkFile(rel, content));
		} catch {
			/* unreadable — skip */
		}
	}
	return chunks;
}

interface CacheEntry {
	index: Bm25Index;
	builtAt: number;
	files: number;
	truncated: boolean;
}

const cache = new Map<string, CacheEntry>();

/**
 * Drop the cached index for a root. Called whenever the agent writes a file:
 * otherwise a write followed by a search inside the same minute would return
 * the PRE-write index, and the agent would conclude its own file is missing.
 */
export function invalidateIndex(root: string): void {
	cache.delete(root);
}

/** Rank workspace chunks for a query (BM25). Rebuilds at most once per TTL. */
export function searchCodebase(
	root: string,
	query: string,
	topK = 8
): { file: string; startLine: number; text: string }[] {
	const now = Date.now();
	let entry = cache.get(root);
	if (!entry || now - entry.builtAt > TTL_MS) {
		const files = collectFiles(root);
		const chunks = buildChunksFrom(root, files);
		entry = {
			index: buildIndex(chunks),
			builtAt: now,
			files: new Set(chunks.map((c) => c.file)).size,
			truncated: files.length >= MAX_FILES
		};
		cache.set(root, entry);
	}
	const hits = queryIndex(entry.index, query, topK).map(({ file, startLine, text }) => ({
		file,
		startLine,
		// Cap what flows into the model context per hit.
		text: text.slice(0, 1200)
	}));
	// Say so when the index is partial — silent truncation reads as "no match".
	if (entry.truncated && hits.length) {
		const last = hits[hits.length - 1];
		hits[hits.length - 1] = {
			...last,
			text: `${last.text}\n(note: the index is capped at ${MAX_FILES} files — use the search tool for anything it may have missed)`
		};
	}
	return hits;
}

/** For status surfaces: how big the cached index is (0s when not built). */
export function indexStats(root: string): { files: number; chunks: number } {
	const entry = cache.get(root);
	return entry ? { files: entry.files, chunks: entry.index.chunks.length } : { files: 0, chunks: 0 };
}
