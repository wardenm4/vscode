/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Workspace indexer for codebase_search: walks the tree (fs, no vscode dep so
// it unit-tests standalone), chunks text files, and keeps one cached BM25
// index per root with a short TTL — an agent run rebuilds at most once a
// minute, and queries within a run hit the cache.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { buildIndex, chunkFile, queryIndex, type Bm25Index, type Chunk } from './lib/bm25';
import { cosine, embedBatch, hybridScore, type Embedder } from './lib/embeddings';

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

// ---- semantic layer --------------------------------------------------------
// Chunks are embedded ONCE per content hash and cached on disk, so reopening a
// workspace (or editing one file) costs almost nothing. Search stays lexical
// until the whole corpus is embedded — a partially embedded index would rank
// the embedded half unfairly high.

export interface SemanticOptions {
	/** Directory for the persistent vector cache (extension global storage). */
	cacheDir: string;
	embedder: Embedder;
	/** Weight of the semantic score in the blend (0 = pure BM25, 1 = pure vector). */
	alpha?: number;
	/** Called when a background embedding pass finishes a batch. */
	onProgress?: (done: number, total: number) => void;
	/** Diagnostics for the background pass (start / finish / failure). */
	onEvent?: (msg: string) => void;
}

interface VectorStore {
	model: string;
	dim: number;
	/** content hash -> vector */
	vectors: Record<string, number[]>;
}

const stores = new Map<string, VectorStore>();
const embedJobs = new Map<string, Promise<void>>();
const EMBED_BATCH = 8;
/** Embedding models have a context window: a batch whose TOTAL text exceeds
 *  it fails as a unit, so cap requests by characters, not just item count. */
const EMBED_CHAR_BUDGET = 8_000;
/** Retrieval quality barely moves past the first couple of KB of a chunk,
 *  and this keeps any single item inside the model's window. */
const EMBED_TEXT_CAP = 2_000;
const VECTOR_PRECISION = 5;

function hashText(text: string): string {
	return crypto.createHash('sha1').update(text).digest('base64url').slice(0, 22);
}

/** One workspace = one cache, however its path happens to be spelled
 *  (drive-letter case and separators vary between callers on Windows). */
function rootKey(root: string): string {
	return path.resolve(root).replace(/\\/g, '/').toLowerCase();
}

function storePath(cacheDir: string, root: string): string {
	return path.join(cacheDir, `vectors-${hashText(rootKey(root))}.json`);
}

function loadStore(cacheDir: string, root: string, model: string): VectorStore {
	const key = `${rootKey(root)}::${model}`;
	const cached = stores.get(key);
	if (cached) { return cached; }
	let store: VectorStore = { model, dim: 0, vectors: {} };
	try {
		const raw = JSON.parse(fs.readFileSync(storePath(cacheDir, root), 'utf8')) as VectorStore;
		// A different embedding model produces incompatible vectors.
		if (raw?.model === model && raw.vectors) { store = raw; }
	} catch {
		/* no cache yet */
	}
	stores.set(key, store);
	return store;
}

function saveStore(cacheDir: string, root: string, store: VectorStore): void {
	try {
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(storePath(cacheDir, root), JSON.stringify(store), 'utf8');
	} catch {
		/* cache is an optimisation — never fail the search over it */
	}
}

/** Embed every chunk missing from the store. Safe to call repeatedly; only
 *  one pass per root runs at a time. */
export function ensureEmbeddings(root: string, chunks: Chunk[], opts: SemanticOptions): Promise<void> {
	const key = `${rootKey(root)}::${opts.embedder.model}`;
	const running = embedJobs.get(key);
	if (running) { return running; }
	const job = (async () => {
		const store = loadStore(opts.cacheDir, root, opts.embedder.model);
		const missing = chunks.filter((c) => !store.vectors[hashText(c.text)]);
		opts.onEvent?.(`embed job: ${missing.length} of ${chunks.length} chunks to embed -> ${opts.cacheDir}`);
		if (!missing.length) { return; }
		let done = 0;
		let dirty = false;
		let sinceSave = 0;

		/** Embed one group, halving it on failure so a single oversized chunk
		 *  can't sink the whole pass. Returns false only if nothing worked. */
		const embedGroup = async (group: Chunk[]): Promise<boolean> => {
			const vecs = await embedBatch(group.map((c) => c.text.slice(0, EMBED_TEXT_CAP)), opts.embedder);
			if (vecs) {
				group.forEach((c, j) => {
					store.vectors[hashText(c.text)] = vecs[j].map((v) => Number(v.toFixed(VECTOR_PRECISION)));
				});
				store.dim = vecs[0].length;
				dirty = true;
				done += group.length;
				sinceSave += group.length;
				opts.onProgress?.(done, missing.length);
				return true;
			}
			if (group.length === 1) {
				// One chunk the endpoint refuses. Mark it as attempted (empty
				// vector = never matches) so coverage can still complete — but
				// ONLY once some other chunk has embedded successfully, or a
				// dead server would "cover" the corpus with zero vectors.
				if (store.dim > 0) {
					store.vectors[hashText(group[0].text)] = [];
					dirty = true;
					done += 1;
					sinceSave += 1;
				}
				return false;
			}
			const mid = Math.ceil(group.length / 2);
			const a = await embedGroup(group.slice(0, mid));
			const b = await embedGroup(group.slice(mid));
			return a || b;
		};

		try {
			let batch: Chunk[] = [];
			let chars = 0;
			const flush = async (): Promise<void> => {
				if (!batch.length) { return; }
				await embedGroup(batch);
				batch = [];
				chars = 0;
				if (sinceSave >= 64) { saveStore(opts.cacheDir, root, store); dirty = false; sinceSave = 0; }
			};
			for (const c of missing) {
				const len = Math.min(c.text.length, EMBED_TEXT_CAP);
				if (batch.length >= EMBED_BATCH || chars + len > EMBED_CHAR_BUDGET) { await flush(); }
				batch.push(c);
				chars += len;
			}
			await flush();
		} catch (e) {
			opts.onEvent?.(`embed job threw: ${e instanceof Error ? e.message : String(e)}`);
			throw e;
		} finally {
			if (dirty) { saveStore(opts.cacheDir, root, store); }
			opts.onEvent?.(`embed job done: ${done}/${missing.length} embedded`);
		}
	})()
		.catch(() => { /* reported via onEvent — never an unhandled rejection */ })
		.finally(() => embedJobs.delete(key));
	embedJobs.set(key, job);
	return job;
}

/**
 * Semantic (hybrid) codebase search. Falls back to plain BM25 whenever the
 * corpus isn't fully embedded yet or the embedder is unreachable, and kicks
 * off the embedding pass in the background so the next search is semantic.
 */
export async function searchCodebaseSemantic(
	root: string,
	query: string,
	opts: SemanticOptions,
	topK = 8
): Promise<{ hits: { file: string; startLine: number; text: string }[]; mode: 'semantic' | 'lexical' }> {
	// Always build/refresh the lexical index first — it is the fallback and
	// the source of the chunk list.
	const lexical = searchCodebase(root, query, topK);
	const entry = cache.get(root);
	if (!entry) { return { hits: lexical, mode: 'lexical' }; }
	const chunks = entry.index.chunks;
	const store = loadStore(opts.cacheDir, root, opts.embedder.model);
	const covered = chunks.every((c) => store.vectors[hashText(c.text)]);
	if (!covered) {
		// Warm the cache for next time without blocking this search.
		void ensureEmbeddings(root, chunks, opts);
		return { hits: lexical, mode: 'lexical' };
	}
	const qVec = (await embedBatch([query], opts.embedder, 20_000))?.[0];
	if (!qVec) { return { hits: lexical, mode: 'lexical' }; }

	// Rank the WHOLE corpus: BM25 alone can't surface a chunk that shares no
	// keywords with the query, which is the entire point of going semantic.
	const bm25 = new Map<string, number>();
	for (const h of queryIndex(entry.index, query, chunks.length)) {
		bm25.set(`${h.file}:${h.startLine}`, h.score);
	}
	const scored = chunks.map((c) => ({
		chunk: c,
		bm25: bm25.get(`${c.file}:${c.startLine}`) ?? 0,
		sem: cosine(qVec, store.vectors[hashText(c.text)])
	}));
	const blended = hybridScore(scored, opts.alpha ?? 0.5);
	const hits = scored
		.map((s, i) => ({ ...s, score: blended[i] }))
		.sort((a, b) => b.score - a.score)
		.slice(0, topK)
		.map((s) => ({ file: s.chunk.file, startLine: s.chunk.startLine, text: s.chunk.text.slice(0, 1200) }));
	return { hits, mode: 'semantic' };
}

/** Coverage report for status surfaces / tests. */
export function embeddingStats(root: string, cacheDir: string, model: string): { embedded: number; chunks: number } {
	const entry = cache.get(root);
	const store = loadStore(cacheDir, root, model);
	const chunks = entry?.index.chunks ?? [];
	return {
		embedded: chunks.filter((c) => store.vectors[hashText(c.text)]).length,
		chunks: chunks.length
	};
}
