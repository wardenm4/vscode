/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pure BM25 ranking over code chunks — the retrieval half of codebase_search.
// No filesystem or vscode deps so it unit-tests standalone; the host indexer
// (codebaseIndex.ts) feeds it chunks and caches the built index.

export interface Chunk {
	file: string;
	startLine: number;
	text: string;
}

export interface Bm25Index {
	chunks: Chunk[];
	/** term -> chunk indices that contain it (document frequency). */
	df: Map<string, number>;
	/** per-chunk term frequencies. */
	tf: Map<string, number>[];
	avgLen: number;
	lengths: number[];
}

const K1 = 1.5;
const B = 0.75;

/** Code-aware tokenizer: splits camelCase / snake_case and keeps identifiers. */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split(/[^A-Za-z0-9_]+/)) {
		if (!raw) { continue; }
		const lower = raw.toLowerCase();
		if (lower.length >= 2) { out.push(lower); }
		// Split compound identifiers so "getUserName" matches "user name".
		const parts = raw.split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
		if (parts.length > 1) {
			for (const p of parts) {
				const pl = p.toLowerCase();
				if (pl.length >= 2 && pl !== lower) { out.push(pl); }
			}
		}
	}
	return out;
}

/** Split file content into overlapping line-window chunks. */
export function chunkFile(file: string, content: string, windowLines = 40, overlap = 10): Chunk[] {
	const lines = content.split(/\r\n|\r|\n/);
	const chunks: Chunk[] = [];
	if (lines.length <= windowLines) {
		const text = content.trim();
		if (text) { chunks.push({ file, startLine: 1, text: text.slice(0, 4000) }); }
		return chunks;
	}
	for (let start = 0; start < lines.length; start += windowLines - overlap) {
		const slice = lines.slice(start, start + windowLines).join('\n').trim();
		if (slice) { chunks.push({ file, startLine: start + 1, text: slice.slice(0, 4000) }); }
		if (start + windowLines >= lines.length) { break; }
	}
	return chunks;
}

export function buildIndex(chunks: Chunk[]): Bm25Index {
	const df = new Map<string, number>();
	const tf: Map<string, number>[] = [];
	const lengths: number[] = [];
	for (const c of chunks) {
		const terms = tokenize(c.text);
		const freq = new Map<string, number>();
		for (const t of terms) { freq.set(t, (freq.get(t) ?? 0) + 1); }
		for (const t of freq.keys()) { df.set(t, (df.get(t) ?? 0) + 1); }
		tf.push(freq);
		lengths.push(terms.length || 1);
	}
	const avgLen = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 1;
	return { chunks, df, tf, avgLen, lengths };
}

export function queryIndex(index: Bm25Index, query: string, topK = 8): (Chunk & { score: number })[] {
	const qTerms = [...new Set(tokenize(query))];
	if (!qTerms.length || !index.chunks.length) { return []; }
	const n = index.chunks.length;
	const scores = new Array<number>(n).fill(0);
	for (const term of qTerms) {
		const dfT = index.df.get(term);
		if (!dfT) { continue; }
		const idf = Math.log(1 + (n - dfT + 0.5) / (dfT + 0.5));
		for (let i = 0; i < n; i++) {
			const f = index.tf[i].get(term);
			if (!f) { continue; }
			const denom = f + K1 * (1 - B + (B * index.lengths[i]) / index.avgLen);
			scores[i] += idf * ((f * (K1 + 1)) / denom);
		}
	}
	return scores
		.map((score, i) => ({ ...index.chunks[i], score }))
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, topK);
}
