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
	'coverage', 'target', 'bin', 'obj', '.next', '.venv', 'venv', '__pycache__'
]);
const SKIP_EXT = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.zip',
	'.gz', '.tar', '.7z', '.exe', '.dll', '.node', '.woff', '.woff2', '.ttf',
	'.eot', '.mp3', '.mp4', '.mov', '.lock', '.map', '.min.js', '.min.css'
]);
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
			if (e.name.startsWith('.') && e.isDirectory()) { continue; }
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name.toLowerCase())) { walk(full, depth + 1); }
			} else if (e.isFile()) {
				const ext = path.extname(e.name).toLowerCase();
				if (!SKIP_EXT.has(ext)) { out.push(full); }
			}
		}
	};
	walk(root, 0);
	return out;
}

function buildChunks(root: string): Chunk[] {
	const chunks: Chunk[] = [];
	for (const full of collectFiles(root)) {
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
}

const cache = new Map<string, CacheEntry>();

/** Rank workspace chunks for a query (BM25). Rebuilds at most once per TTL. */
export function searchCodebase(
	root: string,
	query: string,
	topK = 8
): { file: string; startLine: number; text: string }[] {
	const now = Date.now();
	let entry = cache.get(root);
	if (!entry || now - entry.builtAt > TTL_MS) {
		const chunks = buildChunks(root);
		entry = { index: buildIndex(chunks), builtAt: now, files: new Set(chunks.map((c) => c.file)).size };
		cache.set(root, entry);
	}
	return queryIndex(entry.index, query, topK).map(({ file, startLine, text }) => ({
		file,
		startLine,
		// Cap what flows into the model context per hit.
		text: text.slice(0, 1200)
	}));
}

/** For status surfaces: how big the cached index is (0s when not built). */
export function indexStats(root: string): { files: number; chunks: number } {
	const entry = cache.get(root);
	return entry ? { files: entry.files, chunks: entry.index.chunks.length } : { files: 0, chunks: 0 };
}
