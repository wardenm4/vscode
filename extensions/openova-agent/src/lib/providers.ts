/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AIProvider, Settings } from '../types';

// Central registry of AI providers. Streaming `kind` tells the main process how
// to talk to the endpoint; everything except Anthropic/Ollama is OpenAI-compatible.
export interface ProviderInfo {
	id: AIProvider;
	label: string;
	/** Default base URL (user can override via Settings). */
	baseURL: string;
	needsKey: boolean;
	/** Secrets key for the API token (empty for keyless local providers). */
	secretKey: string;
	/** How to list models & stream: openai-compatible, anthropic, or ollama. */
	kind: 'openai' | 'anthropic' | 'ollama';
	local: boolean;
	/** Suggested models (discovery augments/replaces these). */
	models: string[];
	/** Whether this provider exposes a model-list endpoint. */
	discover: boolean;
}

export const PROVIDERS: Record<AIProvider, ProviderInfo> = {
	anthropic: {
		id: 'anthropic',
		label: 'Anthropic (Claude)',
		baseURL: 'https://api.anthropic.com',
		needsKey: true,
		secretKey: 'anthropic',
		kind: 'anthropic',
		local: false,
		models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
		discover: false
	},
	openai: {
		id: 'openai',
		label: 'OpenAI',
		baseURL: 'https://api.openai.com/v1',
		needsKey: true,
		secretKey: 'openai',
		kind: 'openai',
		local: false,
		models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'gpt-4.1'],
		discover: true
	},
	gemini: {
		id: 'gemini',
		label: 'Google (Gemini)',
		// Google's OpenAI-compatibility endpoint — no bespoke client needed.
		baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
		needsKey: true,
		secretKey: 'gemini',
		kind: 'openai',
		local: false,
		models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
		discover: true
	},
	openrouter: {
		id: 'openrouter',
		label: 'OpenRouter',
		baseURL: 'https://openrouter.ai/api/v1',
		needsKey: true,
		secretKey: 'openrouter',
		kind: 'openai',
		local: false,
		models: [
			'anthropic/claude-3.7-sonnet',
			'openai/gpt-4o',
			'google/gemini-2.0-flash-001',
			'deepseek/deepseek-chat'
		],
		discover: true
	},
	mistral: {
		id: 'mistral',
		label: 'Mistral AI',
		baseURL: 'https://api.mistral.ai/v1',
		needsKey: true,
		secretKey: 'mistral',
		kind: 'openai',
		local: false,
		models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
		discover: true
	},
	groq: {
		id: 'groq',
		label: 'Groq (fast inference)',
		baseURL: 'https://api.groq.com/openai/v1',
		needsKey: true,
		secretKey: 'groq',
		kind: 'openai',
		local: false,
		models: ['llama-3.3-70b-versatile', 'qwen-2.5-coder-32b', 'deepseek-r1-distill-llama-70b'],
		discover: true
	},
	together: {
		id: 'together',
		label: 'Together AI',
		baseURL: 'https://api.together.xyz/v1',
		needsKey: true,
		secretKey: 'together',
		kind: 'openai',
		local: false,
		models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-Coder-32B-Instruct'],
		discover: true
	},
	fireworks: {
		id: 'fireworks',
		label: 'Fireworks AI',
		baseURL: 'https://api.fireworks.ai/inference/v1',
		needsKey: true,
		secretKey: 'fireworks',
		kind: 'openai',
		local: false,
		models: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/qwen2p5-coder-32b-instruct'],
		discover: true
	},
	deepseek: {
		id: 'deepseek',
		label: 'DeepSeek',
		baseURL: 'https://api.deepseek.com/v1',
		needsKey: true,
		secretKey: 'deepseek',
		kind: 'openai',
		local: false,
		models: ['deepseek-chat', 'deepseek-reasoner'],
		discover: true
	},
	xai: {
		id: 'xai',
		label: 'xAI (Grok)',
		baseURL: 'https://api.x.ai/v1',
		needsKey: true,
		secretKey: 'xai',
		kind: 'openai',
		local: false,
		models: ['grok-4', 'grok-3', 'grok-3-mini'],
		discover: true
	},
	opencode: {
		id: 'opencode',
		label: 'OpenCode Zen',
		baseURL: 'https://opencode.ai/zen/v1',
		needsKey: true,
		secretKey: 'opencode',
		kind: 'openai',
		local: false,
		models: ['claude-sonnet-4', 'gpt-4o', 'qwen3-coder'],
		discover: true
	},
	'opencode-go': {
		id: 'opencode-go',
		label: 'OpenCode Go (subscription)',
		baseURL: 'https://opencode.ai/zen/v1',
		needsKey: true,
		secretKey: 'opencode-go',
		kind: 'openai',
		local: false,
		models: ['claude-sonnet-4', 'claude-opus-4', 'gpt-5', 'qwen3-coder', 'kimi-k2'],
		discover: true
	},
	lmstudio: {
		id: 'lmstudio',
		label: 'LM Studio (local)',
		baseURL: 'http://localhost:1234/v1',
		needsKey: false,
		secretKey: '',
		kind: 'openai',
		local: true,
		models: [],
		discover: true
	},
	ollama: {
		id: 'ollama',
		label: 'Ollama (local)',
		baseURL: 'http://localhost:11434',
		needsKey: false,
		secretKey: '',
		kind: 'ollama',
		local: true,
		models: [],
		discover: true
	},
	llamacpp: {
		id: 'llamacpp',
		label: 'llama.cpp (local)',
		baseURL: 'http://localhost:8080/v1',
		needsKey: false,
		secretKey: '',
		kind: 'openai',
		local: true,
		models: [],
		discover: true
	},
	vllm: {
		id: 'vllm',
		label: 'vLLM (local)',
		baseURL: 'http://localhost:8000/v1',
		needsKey: false,
		secretKey: '',
		kind: 'openai',
		local: true,
		models: [],
		discover: true
	},
	'openai-compatible': {
		id: 'openai-compatible',
		label: 'OpenAI-compatible (custom)',
		baseURL: 'http://localhost:1234/v1',
		needsKey: true,
		secretKey: 'openai-compatible',
		kind: 'openai',
		local: true,
		models: [],
		discover: true
	}
};

export function providerInfo(id: AIProvider): ProviderInfo {
	return PROVIDERS[id] ?? PROVIDERS.openai;
}

/** Effective base URL: user override wins, else the provider default. */
export function resolveBaseURL(settings: Settings): string {
	return settings.aiBaseURL?.trim() || providerInfo(settings.aiProvider).baseURL;
}

/** API key for the active provider from the secrets bag. */
export function resolveApiKey(
	provider: AIProvider,
	secrets: Record<string, string>
): string | undefined {
	const key = providerInfo(provider).secretKey;
	return key ? secrets[key] || undefined : undefined;
}
