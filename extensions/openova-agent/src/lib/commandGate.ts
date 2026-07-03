/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pure permission-gate classifier for agent shell commands — no renderer deps so
// it is unit-testable. Dangerous commands ALWAYS require explicit approval (even
// with session auto-approve); allowlisted read-only/dev commands auto-run;
// everything else prompts once unless the user enables auto-approve.
//
// NOTE: `node`/`npx tsx` are deliberately NOT allowlisted — they execute
// arbitrary code (e.g. `node -e "fs.rmSync(...)"`) and must always prompt.

export const DANGEROUS_CMD =
	/(\brm\s+(-\w*\s+)*-\w*(r|f)|\brm\b[^;|&]*-(Recurse|Force)|\b(rd|rmdir)\s+\/s|\bdel\s+\/|\berase\b|\bri\b[^;|&]*-(Recurse|Force)|\bsudo\b|git\s+push|git\s+branch\s+-[dD]|git\s+(reset\s+--hard|clean|checkout\s+--)|npm\s+publish|curl[^|&;]*\|\s*(ba|z)?sh|wget[^|&;]*\|\s*(ba|z)?sh|\bshutdown\b|\bmkfs|\bformat\b|reg\s+(delete|add)|Remove-Item|Invoke-Expression|\biex\b|Set-ExecutionPolicy|node\s+(-e|--eval)|Start-Process)/i;

export const SHELL_META = /[&|;><`$]/;

export const SAFE_CMD =
	/^(npm\s+(test|run\s+[\w:.-]+|ci|ls|-v|--version)|npx\s+(tsc|eslint|prettier|vitest|jest)\b[\w\s./\\:=-]*|tsc\b[\w\s./\\:=-]*|eslint\b[\w\s./\\:=-]*|prettier\s+--check\b[\w\s./\\:=-]*|vitest\s+run\b[\w\s./\\:=-]*|jest\b[\w\s./\\:=-]*|git\s+(status|diff|log|show|ls-files)\b[\w\s./\\:="'~^-]*|ls\b[\w\s./\\-]*|dir\b[\w\s./\\-]*|pwd|cat\s+[\w./\\-]+|type\s+[\w./\\-]+)$/i;

export interface CommandClass {
	/** Destructive — always prompt, even under session auto-approve. */
	dangerous: boolean;
	/** Read-only/dev command with no shell metacharacters — runs without asking. */
	autoSafe: boolean;
}

export function classifyCommand(cmd: string, background = false): CommandClass {
	const trimmed = cmd.trim();
	const dangerous = DANGEROUS_CMD.test(trimmed);
	const autoSafe =
		!background && !dangerous && !SHELL_META.test(trimmed) && SAFE_CMD.test(trimmed);
	return { dangerous, autoSafe };
}
