/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Openova Agent — built-in extension hosting the AI chat/agent sidebar.
//
// Architecture (mirrors the standalone Openova app, see PORT_PLAN.md):
// - This extension host process replaces the old Electron main process: it
//   owns provider streaming (fetch), MCP stdio clients, command execution
//   (behind the same permission gate), and file/git access via the vscode API.
// - The webview hosts the ported React UI (chat, agent steps, plans, review
//   bar). Until the bundle is ported, a bootstrap page proves the bridge.
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new OpenovaChatViewProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('openova.chat', provider, {
			webviewOptions: { retainContextWhenHidden: true }
		}),
		vscode.commands.registerCommand('openova.focusChat', () =>
			vscode.commands.executeCommand('openova.chat.focus')
		),
		vscode.commands.registerCommand('openova.newAgent', () => {
			void vscode.commands.executeCommand('openova.chat.focus');
			provider.post({ type: 'newSession' });
		})
	);
}

export function deactivate(): void {
	// MCP clients and in-flight runs are disposed via context.subscriptions.
}

type BridgeMessage = { type: string; id?: string;[key: string]: unknown };

class OpenovaChatViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	constructor(private readonly context: vscode.ExtensionContext) { }

	post(msg: BridgeMessage): void {
		void this.view?.webview.postMessage(msg);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
		};
		view.webview.html = this.html(view.webview);

		// The bridge: the ported UI calls the same surface the old preload
		// exposed (fs/git/terminal/ai/mcp), served here by the extension host.
		view.webview.onDidReceiveMessage(async (msg: BridgeMessage) => {
			switch (msg.type) {
				case 'ping':
					this.post({ type: 'pong', id: msg.id, workspace: vscode.workspace.name ?? null });
					break;
				case 'readFile': {
					try {
						const uri = vscode.Uri.file(String(msg.path));
						const bytes = await vscode.workspace.fs.readFile(uri);
						this.post({ type: 'result', id: msg.id, ok: true, data: new TextDecoder().decode(bytes) });
					} catch (e) {
						this.post({ type: 'result', id: msg.id, ok: false, error: String(e) });
					}
					break;
				}
				default:
					this.post({ type: 'result', id: msg.id, ok: false, error: `unknown message: ${msg.type}` });
			}
		});
	}

	private html(webview: vscode.Webview): string {
		const nonce = getNonce();
		const icon = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'nova.svg')
		);
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
		.hero { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
		.hero img { width: 28px; height: 28px; }
		.hero h3 { margin: 0; font-weight: 600; }
		p { color: var(--vscode-descriptionForeground); font-size: 12.5px; line-height: 1.5; }
		code { font-family: var(--vscode-editor-font-family); }
		#status { margin-top: 8px; font-size: 12px; }
	</style>
</head>
<body>
	<div class="hero"><img src="${icon}" alt=""><h3>Openova Agent</h3></div>
	<p>The agent harness is being ported from the standalone Openova app
	(chat, autonomous runs, plans, checkpoints, review bar, MCP). This
	bootstrap view verifies the webview ↔ extension-host bridge.</p>
	<div id="status">bridge: connecting…</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		window.addEventListener('message', (e) => {
			const m = e.data;
			if (m.type === 'pong') {
				document.getElementById('status').textContent =
					'bridge: connected (workspace: ' + (m.workspace ?? 'none') + ')';
			}
		});
		vscode.postMessage({ type: 'ping', id: '1' });
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
