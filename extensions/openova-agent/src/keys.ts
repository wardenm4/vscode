/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Provider API keys, stored in VS Code's encrypted SecretStorage.
import * as vscode from 'vscode';
import { providerInfo } from './lib/providers';
import type { AIProvider } from './types';

let store: vscode.SecretStorage | undefined;

export function initKeys(context: vscode.ExtensionContext): void {
	store = context.secrets;
}

export async function getApiKey(provider: AIProvider): Promise<string | undefined> {
	const sk = providerInfo(provider).secretKey;
	if (!sk || !store) { return undefined; }
	return (await store.get(`openova.key.${sk}`)) || undefined;
}

export async function setApiKey(provider: AIProvider, value: string | undefined): Promise<void> {
	const sk = providerInfo(provider).secretKey;
	if (!sk || !store) { return; }
	if (value) {
		await store.store(`openova.key.${sk}`, value);
	} else {
		await store.delete(`openova.key.${sk}`);
	}
}

export async function hasApiKey(provider: AIProvider): Promise<boolean> {
	return !!(await getApiKey(provider));
}
