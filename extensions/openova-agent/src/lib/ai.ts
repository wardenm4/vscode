/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Provider streaming for the Openova agent, running in the extension host
// (Node — no CSP, no CORS). Ported from the standalone app's main-process
// implementation; exposes the same runChat/complete surface the agent loop
// already depends on, minus the IPC hop.
import type { AIProvider } from '../types';

export interface AIMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	/** Base64 data-URLs (data:image/png;base64,…) for vision-capable models. */
	images?: string[];
}

export interface RunChatArgs {
	requestId: string;
	provider: AIProvider;
	apiKey?: string;
	baseURL?: string;
	model: string;
	system?: string;
	messages: { role: 'user' | 'assistant'; content: string; images?: string[] }[];
	temperature?: number;
	maxTokens?: number;
	reasoningEffort?: string;
	onDelta: (text: string) => void;
	onError?: (error: string) => void;
	onDone?: () => void;
}

// Map of in-flight requests to their AbortControllers so the UI can cancel.
const inflight = new Map<string, AbortController>();

export function abortRequest(requestId: string): boolean {
	const controller = inflight.get(requestId);
	if (controller) {
		controller.abort();
		inflight.delete(requestId);
		return true;
	}
	return false;
}

/** Split a data URL into its media type + raw base64 payload. */
function parseDataUrl(u: string): { mediaType: string; data: string } | null {
	const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(u);
	return m ? { mediaType: m[1], data: m[2] } : null;
}

interface StreamReq {
	provider: AIProvider;
	apiKey?: string;
	baseURL?: string;
	model: string;
	system?: string;
	messages: AIMessage[];
	temperature?: number;
	maxTokens?: number;
	reasoningEffort?: string;
}

/** Parse a streaming SSE body line-by-line, invoking onEvent for each `data:` chunk. */
async function consumeSSE(
	body: ReadableStream<Uint8Array>,
	onEvent: (data: string) => void
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (; ;) {
		const { done, value } = await reader.read();
		if (done) { break; }
		buffer += decoder.decode(value, { stream: true });
		const parts = buffer.split('\n');
		buffer = parts.pop() ?? '';
		for (const line of parts) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith(':')) { continue; }
			if (trimmed.startsWith('data:')) {
				onEvent(trimmed.slice(5).trim());
			}
		}
	}
	if (buffer.trim().startsWith('data:')) {
		onEvent(buffer.trim().slice(5).trim());
	}
}

async function streamAnthropic(
	req: StreamReq,
	controller: AbortController,
	onDelta: (t: string) => void
): Promise<void> {
	const baseURL = req.baseURL?.replace(/\/$/, '') || 'https://api.anthropic.com';
	const res = await fetch(`${baseURL}/v1/messages`, {
		method: 'POST',
		signal: controller.signal,
		headers: {
			'content-type': 'application/json',
			'x-api-key': req.apiKey ?? '',
			'anthropic-version': '2023-06-01'
		},
		body: JSON.stringify({
			model: req.model,
			max_tokens: req.maxTokens ?? 4096,
			temperature: req.temperature ?? 0.2,
			system: req.system,
			stream: true,
			messages: req.messages
				.filter((m) => m.role !== 'system')
				.map((m) => {
					if (!m.images?.length) { return { role: m.role, content: m.content }; }
					const parts: unknown[] = [{ type: 'text', text: m.content }];
					for (const u of m.images) {
						const p = parseDataUrl(u);
						if (p) {
							parts.unshift({
								type: 'image',
								source: { type: 'base64', media_type: p.mediaType, data: p.data }
							});
						}
					}
					return { role: m.role, content: parts };
				})
		})
	});
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => res.statusText);
		throw new Error(`Anthropic API error ${res.status}: ${text}`);
	}
	await consumeSSE(res.body, (data) => {
		if (data === '[DONE]') { return; }
		try {
			const evt = JSON.parse(data);
			if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
				onDelta(evt.delta.text);
			}
		} catch {
			/* ignore keep-alive / non-JSON */
		}
	});
}

async function streamOpenAI(
	req: StreamReq,
	controller: AbortController,
	onDelta: (t: string) => void
): Promise<void> {
	const baseURL =
		req.baseURL?.replace(/\/$/, '') ||
		(req.provider === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:1234/v1');
	const mapped = req.messages.map((m) => {
		if (!m.images?.length) { return { role: m.role, content: m.content }; }
		return {
			role: m.role,
			content: [
				{ type: 'text', text: m.content },
				...m.images.map((u) => ({ type: 'image_url', image_url: { url: u } }))
			]
		};
	});
	const messages = req.system ? [{ role: 'system', content: req.system }, ...mapped] : mapped;
	// OpenAI reasoning models (o1/o3/o4/gpt-5…) reject non-default `temperature` and `max_tokens`
	// (they need `max_completion_tokens`) and are the only ones that accept
	// `reasoning_effort`. Everything else gets the classic params and no effort.
	const isReasoning = /^(o\d|gpt-5|o1|o3|o4)/i.test(req.model);
	const effort =
		req.reasoningEffort && req.reasoningEffort !== 'off'
			? req.reasoningEffort === 'max'
				? 'high'
				: req.reasoningEffort
			: undefined;
	const body: Record<string, unknown> = { model: req.model, stream: true, messages };
	if (isReasoning) {
		body.max_completion_tokens = req.maxTokens ?? 4096;
		if (effort) { body.reasoning_effort = effort; }
	} else {
		body.temperature = req.temperature ?? 0.2;
		body.max_tokens = req.maxTokens ?? 4096;
	}
	const res = await fetch(`${baseURL}/chat/completions`, {
		method: 'POST',
		signal: controller.signal,
		headers: {
			'content-type': 'application/json',
			...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {})
		},
		body: JSON.stringify(body)
	});
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => res.statusText);
		throw new Error(`OpenAI API error ${res.status}: ${text}`);
	}
	await consumeSSE(res.body, (data) => {
		if (data === '[DONE]') { return; }
		try {
			const evt = JSON.parse(data);
			const delta = evt.choices?.[0]?.delta?.content;
			if (delta) { onDelta(delta); }
		} catch {
			/* ignore */
		}
	});
}

async function streamOllama(
	req: StreamReq,
	controller: AbortController,
	onDelta: (t: string) => void
): Promise<void> {
	const baseURL = req.baseURL?.replace(/\/$/, '') || 'http://localhost:11434';
	// Ollama takes images as raw base64 (no data-URL prefix) on the message.
	const mapped = req.messages.map((m) =>
		m.images?.length
			? {
				role: m.role,
				content: m.content,
				images: m.images.map((u) => parseDataUrl(u)?.data ?? '').filter(Boolean)
			}
			: { role: m.role, content: m.content }
	);
	const messages = req.system ? [{ role: 'system', content: req.system }, ...mapped] : mapped;
	const body: Record<string, unknown> = { model: req.model, messages, stream: true };
	const options: Record<string, unknown> = {};
	if (req.temperature !== undefined) { options.temperature = req.temperature; }
	if (req.maxTokens) { options.num_predict = req.maxTokens; }
	if (Object.keys(options).length) { body.options = options; }
	// Effort "off" disables thinking on models that support it (qwen3, deepseek…)
	// — otherwise a small ask can burn the whole token budget on reasoning and
	// stream zero content (done_reason: length).
	if (req.reasoningEffort === 'off') { body.think = false; }
	const doFetch = (): Promise<Response> =>
		fetch(`${baseURL}/api/chat`, {
			method: 'POST',
			signal: controller.signal,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
	let res = await doFetch();
	if (!res.ok && body.think === false) {
		// Non-thinking models reject the flag — retry once without it.
		const text = await res.text().catch(() => res.statusText);
		if (/think/i.test(text)) {
			delete body.think;
			res = await doFetch();
		} else {
			throw new Error(`Ollama error ${res.status}: ${text}`);
		}
	}
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => res.statusText);
		throw new Error(`Ollama error ${res.status}: ${text}`);
	}
	// Ollama streams newline-delimited JSON, not SSE.
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (; ;) {
		const { done, value } = await reader.read();
		if (done) { break; }
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) { continue; }
			try {
				const evt = JSON.parse(line);
				if (evt.message?.content) { onDelta(evt.message.content); }
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * Run a streaming chat completion. Tokens arrive via `onDelta`. Resolves when
 * the stream finishes, errors, or is aborted (errors surface via onError, so
 * callers using `complete` can reject on truncated output).
 */
export async function runChat(args: RunChatArgs): Promise<void> {
	const controller = new AbortController();
	inflight.set(args.requestId, controller);
	try {
		// Anthropic + Ollama have bespoke APIs; everything else is OpenAI-compatible
		// (OpenAI, OpenRouter, Mistral, OpenCode Zen, LM Studio, custom endpoints).
		if (args.provider === 'anthropic') { await streamAnthropic(args, controller, args.onDelta); }
		else if (args.provider === 'ollama') { await streamOllama(args, controller, args.onDelta); }
		else { await streamOpenAI(args, controller, args.onDelta); }
		args.onDone?.();
	} catch (err) {
		if (!controller.signal.aborted) {
			args.onError?.(err instanceof Error ? err.message : String(err));
		}
	} finally {
		inflight.delete(args.requestId);
	}
}

/** One-shot completion used by the agent loop — returns the full text, and
 *  REJECTS on a stream error so callers never act on truncated output (an
 *  abort still resolves with the partial text). */
export async function complete(
	args: Omit<RunChatArgs, 'onDelta' | 'onError' | 'onDone'>,
	onStream?: (fullText: string) => void
): Promise<string> {
	let out = '';
	let streamError: string | null = null;
	await runChat({
		...args,
		onDelta: (d) => {
			out += d;
			onStream?.(out);
		},
		onError: (e) => {
			streamError = e;
		}
	});
	if (streamError) { throw new Error(streamError); }
	return out;
}

/** Discover the models a provider offers (local Ollama/LM Studio or hosted). */
export async function listModels(args: {
	kind: 'openai' | 'anthropic' | 'ollama';
	baseURL: string;
	apiKey?: string;
}): Promise<{ ok: boolean; models: string[]; error?: string }> {
	const base = args.baseURL.replace(/\/$/, '');
	try {
		if (args.kind === 'ollama') {
			const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
			if (!res.ok) { return { ok: false, error: `HTTP ${res.status}`, models: [] }; }
			const json = (await res.json()) as { models?: { name: string }[] };
			return { ok: true, models: (json.models ?? []).map((m) => m.name) };
		}
		const url = args.kind === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
		const headers: Record<string, string> =
			args.kind === 'anthropic'
				? { 'x-api-key': args.apiKey ?? '', 'anthropic-version': '2023-06-01' }
				: args.apiKey
					? { authorization: `Bearer ${args.apiKey}` }
					: {};
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
		if (!res.ok) { return { ok: false, error: `HTTP ${res.status}`, models: [] }; }
		const json = (await res.json()) as { data?: { id: string }[] };
		return { ok: true, models: (json.data ?? []).map((m) => m.id).sort() };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e), models: [] };
	}
}
