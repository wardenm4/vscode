/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tab completions: ghost-text inline suggestions from the configured model
// (prefix/suffix prompt around the cursor). Debounced, cancellable, capped —
// ported from the standalone Openova app's inline completions.
import * as vscode from 'vscode';
import { complete, abortRequest } from './lib/ai';
import { getApiKey } from './keys';
import type { AIProvider } from './types';
import { PROVIDERS, providerInfo } from './lib/providers';
import { parseRouteSpec } from './lib/router';

const uid = (): string => Math.random().toString(36).slice(2);

function settings(): { provider: AIProvider; model: string; baseUrl: string; enabled: boolean } {
	const cfg = vscode.workspace.getConfiguration('openova');
	const provider = cfg.get<string>('provider', 'ollama') as AIProvider;
	const model = cfg.get<string>('model', 'qwen3.5:9b');
	const baseUrl = cfg.get<string>('baseUrl', '');
	// Per-task override: a small fast model just for ghost text
	// (openova.modelCompletion, "provider:model" or bare model).
	const spec = cfg.get<string>('modelCompletion', '').trim();
	const routed = spec ? parseRouteSpec(spec, Object.keys(PROVIDERS), provider) : null;
	if (routed) {
		return {
			provider: routed.provider,
			model: routed.model,
			baseUrl: routed.provider === provider ? baseUrl : providerInfo(routed.provider).baseURL,
			enabled: cfg.get<boolean>('tabCompletion', true)
		};
	}
	return { provider, model, baseUrl, enabled: cfg.get<boolean>('tabCompletion', true) };
}

/** Core completion: returns the ghost text for a document position. */
export async function completeAtPosition(
	doc: vscode.TextDocument,
	pos: vscode.Position,
	requestId: string
): Promise<string> {
	const s = settings();
	const prefixStart = new vscode.Position(Math.max(0, pos.line - 60), 0);
	const suffixEnd = doc.lineAt(Math.min(doc.lineCount - 1, pos.line + 20)).range.end;
	const prefix = doc.getText(new vscode.Range(prefixStart, pos));
	const suffix = doc.getText(new vscode.Range(pos, suffixEnd));
	const out = await complete({
		requestId,
		provider: s.provider,
		baseURL: s.baseUrl || undefined,
		apiKey: await getApiKey(s.provider),
		model: s.model,
		system:
			'You are a code completion engine. Given code before and after a cursor, output ONLY the text ' +
			'to insert at the cursor — no markdown fences, no commentary, no repetition of existing code. ' +
			'Keep it short: complete the current statement or add at most 3 lines.',
		messages: [
			{
				role: 'user',
				content: `Language: ${doc.languageId}\n\nCode before cursor:\n${prefix}\n\nCode after cursor:\n${suffix}\n\nInsert at cursor:`
			}
		],
		temperature: 0.1,
		maxTokens: 160,
		reasoningEffort: 'off'
	});
	let text = out
		.replace(/<think(?:ing)?>[\s\S]*?(<\/think(?:ing)?>|$)/gi, '')
		.replace(/^```[\w-]*\n?/, '')
		.replace(/\n?```[\s\S]*$/, '');
	// Cap to 5 lines and drop trailing whitespace noise.
	text = text.split('\n').slice(0, 5).join('\n').replace(/\s+$/, (m) => (m.includes('\n') ? '' : m));
	// Never suggest what is already there.
	if (text && suffix.trimStart().startsWith(text.trim()) && text.trim().length > 0) { return ''; }
	return text;
}

export function registerTabCompletions(context: vscode.ExtensionContext): void {
	let generation = 0;
	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: '**' },
			{
				async provideInlineCompletionItems(doc, pos, _ctx, token) {
					if (!settings().enabled) { return { items: [] }; }
					// Skip huge files and non-file schemes (output, git, settings UI…).
					if (doc.uri.scheme !== 'file' || doc.getText().length > 200_000) { return { items: [] }; }
					const myGen = ++generation;
					// Debounce: wait for the typing pause; newer keystrokes cancel us.
					await new Promise((r) => setTimeout(r, 350));
					if (token.isCancellationRequested || myGen !== generation) { return { items: [] }; }
					const requestId = uid();
					const abort = token.onCancellationRequested(() => abortRequest(requestId));
					try {
						const text = await completeAtPosition(doc, pos, requestId);
						if (!text || token.isCancellationRequested || myGen !== generation) {
							return { items: [] };
						}
						return { items: [new vscode.InlineCompletionItem(text, new vscode.Range(pos, pos))] };
					} catch {
						return { items: [] };
					} finally {
						abort.dispose();
					}
				}
			}
		)
	);
}
