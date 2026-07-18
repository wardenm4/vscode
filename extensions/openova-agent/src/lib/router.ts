/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// In-process model router: retry the primary model on transient failures,
// then fall back through a user-configured chain, with per-model cooldowns so
// a rate-limited endpoint isn't hammered again next turn. In-process (no
// proxy hop) — routing overhead is a map lookup, not a network round-trip.
import type { AIProvider } from '../types';
import { complete, type RunChatArgs } from './ai';

export interface Route {
	provider: AIProvider;
	model: string;
	baseURL?: string;
	apiKey?: string;
}

type CompleteArgs = Omit<RunChatArgs, 'onDelta' | 'onError' | 'onDone'>;
type CompleteFn = (args: CompleteArgs, onStream?: (fullText: string) => void) => Promise<string>;

const COOLDOWN_MS = 90_000;
const cooldownUntil = new Map<string, number>();

function routeKey(r: Route): string {
	return `${r.provider}:${r.model}`;
}

export function noteFailure(r: Route, now = Date.now()): void {
	cooldownUntil.set(routeKey(r), now + COOLDOWN_MS);
}

export function noteSuccess(r: Route): void {
	cooldownUntil.delete(routeKey(r));
}

export function isCooling(r: Route, now = Date.now()): boolean {
	return (cooldownUntil.get(routeKey(r)) ?? 0) > now;
}

/** Errors worth retrying / falling over on (vs. bad-request/auth mistakes). */
export function isTransient(msg: string): boolean {
	return /HTTP (408|409|429|5\d\d)|rate.?limit|overloaded|timed? ?out|timeout|fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|aborted|socket/i.test(msg);
}

/** Parse a "provider:model" or bare "model" fallback entry. */
export function parseRouteSpec(
	spec: string,
	knownProviders: string[],
	defaultProvider: AIProvider
): { provider: AIProvider; model: string } | null {
	const t = spec.trim();
	if (!t) { return null; }
	const idx = t.indexOf(':');
	if (idx > 0 && knownProviders.includes(t.slice(0, idx))) {
		const model = t.slice(idx + 1).trim();
		return model ? { provider: t.slice(0, idx) as AIProvider, model } : null;
	}
	return { provider: defaultProvider, model: t };
}

export interface RoutedResult {
	text: string;
	route: Route;
	/** Set when the primary didn't answer (which fallback did, or why). */
	note?: string;
}

/**
 * Run a completion with retry -> fallback -> cooldown semantics.
 * The primary is retried once on a transient error; every candidate that
 * fails goes on cooldown; cooling candidates are skipped unless everything
 * is cooling (then we try them anyway rather than fail fast).
 */
export async function completeRouted(
	baseArgs: Omit<CompleteArgs, 'provider' | 'model' | 'apiKey' | 'baseURL'>,
	primary: Route,
	fallbacks: Route[],
	onStream?: (fullText: string) => void,
	completeFn: CompleteFn = complete
): Promise<RoutedResult> {
	const all = [primary, ...fallbacks];
	let candidates = all.filter((r) => !isCooling(r));
	if (!candidates.length) { candidates = all; }
	let lastErr = '';
	for (let i = 0; i < candidates.length; i++) {
		const route = candidates[i];
		const attempts = route === primary ? 2 : 1;
		for (let a = 0; a < attempts; a++) {
			try {
				const text = await completeFn(
					{ ...baseArgs, provider: route.provider, model: route.model, baseURL: route.baseURL, apiKey: route.apiKey },
					onStream
				);
				noteSuccess(route);
				return {
					text,
					route,
					note: route === primary ? undefined : `fallback ${routeKey(route)} (primary failed: ${lastErr.slice(0, 120)})`
				};
			} catch (e) {
				lastErr = e instanceof Error ? e.message : String(e);
				// Retry the primary once only for transient errors; a hard error
				// (bad key, unknown model) goes straight to the next candidate.
				if (a + 1 < attempts && isTransient(lastErr)) {
					await new Promise((r) => setTimeout(r, 1200));
					continue;
				}
				noteFailure(route);
				break;
			}
		}
	}
	throw new Error(`All models failed. Last error: ${lastErr}`);
}
