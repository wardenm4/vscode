/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Cost estimation for the live meter. Token counts are estimated from
// characters (~4 chars/token) and prices are approximate list prices in USD
// per MILLION tokens — good enough for a budget gauge, not for invoicing.

interface Price {
	in: number;
	out: number;
}

const PRICES: [RegExp, Price][] = [
	[/claude.*opus/i, { in: 15, out: 75 }],
	[/claude.*sonnet/i, { in: 3, out: 15 }],
	[/claude.*haiku/i, { in: 1, out: 5 }],
	[/gpt-4o-mini/i, { in: 0.15, out: 0.6 }],
	[/gpt-4o|gpt-4\.1(?!-mini|-nano)/i, { in: 2.5, out: 10 }],
	[/gpt-4\.1-mini/i, { in: 0.4, out: 1.6 }],
	[/gpt-4\.1-nano/i, { in: 0.1, out: 0.4 }],
	[/gpt-5/i, { in: 1.25, out: 10 }],
	[/o3-mini|o4-mini/i, { in: 1.1, out: 4.4 }],
	[/gemini.*pro/i, { in: 1.25, out: 10 }],
	[/gemini.*flash/i, { in: 0.15, out: 0.6 }],
	[/deepseek-reasoner|deepseek-r1/i, { in: 0.55, out: 2.19 }],
	[/deepseek/i, { in: 0.27, out: 1.1 }],
	[/grok-3-mini/i, { in: 0.3, out: 0.5 }],
	[/grok/i, { in: 3, out: 15 }],
	[/mistral-large/i, { in: 2, out: 6 }],
	[/codestral|mistral-small/i, { in: 0.3, out: 0.9 }],
	[/llama-?3\.3|llama-v3p3|Llama-3\.3/i, { in: 0.6, out: 0.7 }],
	[/qwen.*coder/i, { in: 0.3, out: 0.9 }],
	[/kimi/i, { in: 0.6, out: 2.5 }]
];

// Unknown hosted models get a middle-of-the-road estimate so the meter still
// moves instead of silently reading $0.00.
const DEFAULT_HOSTED: Price = { in: 1, out: 3 };

export function estTokens(chars: number): number {
	return Math.max(0, Math.round(chars / 4));
}

/** Estimated cost in USD for a call. Local providers are free. */
export function estimateCost(model: string, inTokens: number, outTokens: number, local: boolean): number {
	if (local) { return 0; }
	const price = PRICES.find(([re]) => re.test(model))?.[1] ?? DEFAULT_HOSTED;
	return (inTokens * price.in + outTokens * price.out) / 1_000_000;
}

export function fmtCost(usd: number): string {
	if (usd <= 0) { return '$0.00'; }
	return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
