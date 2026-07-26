/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Embedding client for semantic codebase search. Works against whatever the
// user already runs locally — LM Studio / any OpenAI-compatible /v1/embeddings
// endpoint, or Ollama's /api/embeddings — and reports failure instead of
// throwing, so the index can silently stay on BM25 when no embedder exists.

export interface Embedder {
	kind: 'openai' | 'ollama';
	baseURL: string;
	model: string;
}

/** Endpoints probed when openova.embeddingBaseUrl is left empty. */
const AUTO_ENDPOINTS: { kind: Embedder['kind']; baseURL: string; match: RegExp }[] = [
	{ kind: 'openai', baseURL: 'http://localhost:1234/v1', match: /embed/i },
	{ kind: 'ollama', baseURL: 'http://localhost:11434', match: /embed/i }
];

async function listModels(kind: Embedder['kind'], baseURL: string): Promise<string[]> {
	const base = baseURL.replace(/\/$/, '');
	try {
		if (kind === 'ollama') {
			const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2500) });
			if (!res.ok) { return []; }
			const json = (await res.json()) as { models?: { name: string }[] };
			return (json.models ?? []).map((m) => m.name);
		}
		const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(2500) });
		if (!res.ok) { return []; }
		const json = (await res.json()) as { data?: { id: string }[] };
		return (json.data ?? []).map((m) => m.id);
	} catch {
		return [];
	}
}

/**
 * Find a usable embedder. An explicit model/base URL wins; otherwise probe the
 * local servers for anything that looks like an embedding model.
 */
export async function detectEmbedder(cfg: { baseURL?: string; model?: string }): Promise<Embedder | null> {
	if (cfg.baseURL?.trim()) {
		const kind: Embedder['kind'] = /\/v1\/?$/.test(cfg.baseURL) ? 'openai' : 'ollama';
		const models = await listModels(kind, cfg.baseURL);
		const model = cfg.model?.trim() || models.find((m) => /embed/i.test(m));
		return model ? { kind, baseURL: cfg.baseURL, model } : null;
	}
	for (const ep of AUTO_ENDPOINTS) {
		const models = await listModels(ep.kind, ep.baseURL);
		const model = cfg.model?.trim()
			? models.find((m) => m === cfg.model?.trim()) ?? undefined
			: models.find((m) => ep.match.test(m));
		if (model) { return { kind: ep.kind, baseURL: ep.baseURL, model }; }
	}
	return null;
}

/** Embed a batch of texts. Returns null when the endpoint fails — callers
 *  treat that as "no semantic search available right now". */
export async function embedBatch(texts: string[], ep: Embedder, timeoutMs = 60_000): Promise<number[][] | null> {
	if (!texts.length) { return []; }
	const base = ep.baseURL.replace(/\/$/, '');
	try {
		if (ep.kind === 'ollama') {
			// Ollama embeds one prompt per call.
			const out: number[][] = [];
			for (const text of texts) {
				const res = await fetch(`${base}/api/embeddings`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ model: ep.model, prompt: text }),
					signal: AbortSignal.timeout(timeoutMs)
				});
				if (!res.ok) { return null; }
				const json = (await res.json()) as { embedding?: number[] };
				if (!json.embedding?.length) { return null; }
				out.push(json.embedding);
			}
			return out;
		}
		const res = await fetch(`${base}/embeddings`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: ep.model, input: texts }),
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (!res.ok) { return null; }
		const json = (await res.json()) as { data?: { embedding: number[]; index?: number }[] };
		const rows = json.data ?? [];
		if (rows.length !== texts.length) { return null; }
		// The API may return rows out of order; `index` is authoritative.
		const out = new Array<number[]>(texts.length);
		rows.forEach((r, i) => { out[r.index ?? i] = r.embedding; });
		return out.every((v) => v?.length) ? out : null;
	} catch {
		return null;
	}
}

export function cosine(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (!na || !nb) { return 0; }
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Blend lexical and semantic scores. Both sides are min-max normalised first
 * so one scale can't dominate the other; `alpha` is the semantic weight.
 */
export function hybridScore(
	items: { bm25: number; sem: number }[],
	alpha = 0.5
): number[] {
	if (!items.length) { return []; }
	const norm = (vals: number[]): number[] => {
		const lo = Math.min(...vals);
		const hi = Math.max(...vals);
		const span = hi - lo;
		return span > 1e-9 ? vals.map((v) => (v - lo) / span) : vals.map(() => (hi > 0 ? 1 : 0));
	};
	const lex = norm(items.map((i) => i.bm25));
	const sem = norm(items.map((i) => i.sem));
	return items.map((_, i) => (1 - alpha) * lex[i] + alpha * sem[i]);
}
