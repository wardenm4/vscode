/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface DirEntry {
	name: string;
	path: string;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

export interface TreeNode extends DirEntry {
	children?: TreeNode[];
	expanded?: boolean;
	loading?: boolean;
}

export interface OpenTab {
	path: string;
	name: string;
	language: string;
	/** Current in-editor content. */
	content: string;
	/** Last-saved content; if it differs from `content` the tab is dirty. */
	savedContent: string;
	/** Editor view state (cursor, scroll) restored when the tab is reactivated. */
	viewState?: unknown;
	pinned?: boolean;
}

export type ChatRole = 'user' | 'assistant' | 'system';

/** One step of an agent run, rendered as a Cursor-style tool card. */
export interface AgentStep {
	id: string;
	/** 'thought' | tool name ('read_file', 'write_file', …) | 'finish' | 'error'. */
	kind: string;
	/** Short one-line label, e.g. "Read src/app.ts" or "Created index.html". */
	title: string;
	/** Optional expandable detail (observation preview, error text). */
	detail?: string;
	/** For screenshot steps: absolute path of the captured PNG. */
	image?: string;
	/** For write_file steps: a reviewable line diff of the change. */
	diff?: {
		path: string;
		/** Resolved absolute path — used for Revert regardless of the current folder. */
		fullPath?: string;
		added: number;
		removed: number;
		lines: { t: '+' | '-' | ' '; s: string }[];
		/** Previous file contents (for Revert); omitted for new files or huge files. */
		before?: string;
		/** True when the write created the file (checked, not inferred from `before`). */
		isNew?: boolean;
	};
	status: 'running' | 'done' | 'error';
}

/** An editable, approvable implementation plan proposed by the model. */
export interface PlanArtifact {
	title: string;
	steps: { id: string; text: string; done: boolean }[];
	status: 'proposed' | 'running' | 'done' | 'cancelled';
	/** Feedback the user left while the plan was executing. */
	comments?: string[];
}

export interface ChatMessage {
	id: string;
	role: ChatRole;
	content: string;
	/** Files attached as context for this message. */
	context?: { path: string; name: string }[];
	/** Base64 image data-URLs attached to this message (vision models). */
	images?: string[];
	/** Structured agent tool-call steps (agent mode only). */
	steps?: AgentStep[];
	/** Plan artifact (plan mode) — approve to execute. */
	plan?: PlanArtifact;
	/** Pre-run file states captured on this user turn — restore = whole-run undo. */
	checkpoint?: { path: string; existed: boolean; content: string }[];
	/** Estimated token usage for the run that produced this message. */
	usage?: { tokens: number };
	/** Live model output for the in-flight agent turn (cleared once parsed). */
	liveText?: string;
	streaming?: boolean;
	error?: boolean;
	/** Post-run review bar was resolved (Keep all / Undo all) or is stale (restored). */
	reviewDismissed?: boolean;
	/** Run write ledger for the review bar — includes subagent writes, which
	 *  never appear as step cards. Live-run only; never persisted. */
	writes?: ReviewFile[];
}

export interface ChatSession {
	id: string;
	title: string;
	messages: ChatMessage[];
	createdAt: number;
	/** Last user-visible activity — used to sort chat history by recency. */
	updatedAt?: number;
}

export type AIProvider =
	| 'anthropic'
	| 'openai'
	| 'openrouter'
	| 'mistral'
	| 'opencode'
	| 'opencode-go'
	| 'lmstudio'
	| 'ollama'
	| 'openai-compatible';

export type ChatMode = 'ask' | 'agent' | 'plan' | 'debug';

/** A follow-up composed while a run was streaming — sent when it finishes. */
export interface QueuedMessage {
	id: string;
	text: string;
	mode: ChatMode;
	contextPaths: string[];
	images: string[];
}

/** One file an agent run touched — a row in the post-run review bar. */
export interface ReviewFile {
	/** Workspace-relative path as shown in step cards. */
	path: string;
	/** Absolute path — revert/delete target regardless of the current folder. */
	fullPath: string;
	added: number;
	removed: number;
	/** Pre-run contents (first write wins); undefined = not kept (too large). */
	before?: string;
	/** True when the file did not exist before the run (undo = delete). */
	isNew: boolean;
}
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface ProviderConfig {
	provider: AIProvider;
	model: string;
	baseURL?: string;
}

export interface Settings {
	// Appearance
	theme: 'dark' | 'light' | 'high-contrast' | 'custom';
	/** Overrides for --oc-* CSS variables when theme === 'custom'. */
	customTheme: Record<string, string>;
	fontSize: number;
	fontFamily: string;
	tabSize: number;
	wordWrap: 'on' | 'off' | 'bounded';
	minimap: boolean;
	lineNumbers: 'on' | 'off' | 'relative';
	cursorBlinking: 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
	cursorStyle: 'line' | 'block' | 'underline';
	renderWhitespace: 'none' | 'boundary' | 'selection' | 'all';
	bracketPairColorization: boolean;
	formatOnSave: boolean;

	// AI
	aiProvider: AIProvider;
	aiModel: string;
	aiBaseURL: string;
	aiTemperature: number;
	aiMaxTokens: number;
	inlineCompletions: boolean;
	/** Global custom AI instructions, prepended to every request's system prompt. */
	aiRules: string;
	/** Semantic codebase index via embeddings (falls back to BM25 if unavailable). */
	embeddingsEnabled: boolean;
	embeddingModel: string;
	embeddingBaseURL: string;
	/** Reasoning effort passed to models that support it (o-series, etc.). */
	reasoningEffort: ReasoningEffort;
	/** Check command the agent must pass before finishing (e.g. "npx tsc --noEmit"); empty disables. */
	agentCheckCommand: string;
	/** MCP servers (stdio) whose tools are offered to the agent. */
	mcpServers: { name: string; command: string }[];
	/** Hook run after every agent file write ({file} = written path); empty disables. */
	hookAfterWrite: string;
	/** Hook run when an agent run completes; empty disables. */
	hookAfterRun: string;

	// Editor behaviour
	autoSave: 'off' | 'afterDelay' | 'onFocusChange';
	autoSaveDelay: number;

	/** Command id → chord overrides (e.g. { 'file.save': 'Mod+K Mod+S' }). */
	keybindings: Record<string, string>;

	/** User-defined code snippets offered in completions. */
	snippets: Snippet[];

	/** Saved agent prompts that run on a schedule while Openova is open. */
	automations: Automation[];
}

/** A scheduled agent task. */
export interface Automation {
	id: string;
	name: string;
	prompt: string;
	/** Absolute workspace folder the agent runs in. */
	folder: string;
	intervalMinutes: number;
	enabled: boolean;
	/** Last time it ran (ms epoch); 0 = never. */
	lastRun: number;
}

export interface Snippet {
	prefix: string;
	/** Monaco snippet syntax supported ($1, ${1:default}, $0). */
	body: string;
	description?: string;
	/** Comma-separated language ids, or '*' for all. */
	scope: string;
}

export const DEFAULT_SETTINGS: Settings = {
	theme: 'dark',
	customTheme: {},
	fontSize: 14,
	fontFamily:
		`'Cascadia Code', 'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace`,
	tabSize: 2,
	wordWrap: 'off',
	minimap: true,
	lineNumbers: 'on',
	cursorBlinking: 'blink',
	cursorStyle: 'line',
	renderWhitespace: 'selection',
	bracketPairColorization: true,
	formatOnSave: false,

	aiProvider: 'anthropic',
	aiModel: 'claude-opus-4-8',
	aiBaseURL: '',
	aiTemperature: 0.2,
	aiMaxTokens: 4096,
	inlineCompletions: true,
	aiRules: '',
	embeddingsEnabled: true,
	embeddingModel: 'nomic-embed-text',
	embeddingBaseURL: '',
	reasoningEffort: 'off',
	agentCheckCommand: '',
	mcpServers: [],
	hookAfterWrite: '',
	hookAfterRun: '',

	autoSave: 'afterDelay',
	autoSaveDelay: 1000,

	keybindings: {},

	snippets: [
		{
			prefix: 'log',
			body: 'console.log($1)',
			description: 'Log to the console',
			scope: 'javascript,typescript'
		}
	],

	automations: []
};

export type SidebarView = 'explorer' | 'search' | 'ai' | 'source-control' | 'settings';

export interface SearchResult {
	file: string;
	line: number;
	column: number;
	preview: string;
}

export interface SearchOpts {
	caseSensitive?: boolean;
	wholeWord?: boolean;
	regex?: boolean;
	includeGlob?: string;
	excludeGlob?: string;
}
