# Openova on VS Code — port plan

This fork (wardenm4/vscode, upstream microsoft/vscode 1.128.0) is the new base
for Openova, replacing the from-scratch Electron+Monaco app at
`Desktop/cursor clone`. Same architecture as Cursor/Windsurf/Void.

## Why rebase

The standalone app reached strong agent-harness parity but can never match a
real VS Code base: full extension ecosystem (via Open VSX), debugger, LSP,
tasks, remote SSH/WSL, settings/appearance surface, themes, keybindings,
accessibility. The agent harness is the differentiator — the editor should be
free.

## What's done here

- `product.json` de-branded: Openova naming, fresh installer GUIDs, `.openova`
  data dirs, `openova` protocol, Open VSX gallery (Microsoft's marketplace is
  ToS-restricted to genuine VS Code products), report-issue URL → this repo.
- `extensions/openova-agent/` scaffold: built-in extension contributing the
  Openova activity-bar container + `openova.chat` webview view, Ctrl+L focus,
  settings (provider/model/effort/baseUrl), and a working webview ↔ extension
  host message bridge (bootstrap page proves the round trip).

## Build (Windows)

- Node **24.17+** required by `build/npm/preinstall.ts` (24.5 works with
  `VSCODE_SKIP_NODE_VERSION_CHECK=1`; upgrade when convenient). npm only
  (yarn rejected), npm < 12.
- VS Build Tools 2022 with MSVC v143 **Spectre-mitigated libs**, **C++ ATL
  Spectre**, **C++ MFC Spectre** (MSB8040 without them), Win 10/11 SDK,
  Python 3.x + `pip install setuptools`.
- `npm ci` (~10-20 min first run, native gyp modules), then `npm run watch`
  (first compile ~5-10 min) and `.\scripts\code.bat` to launch.

## Port phases

1. **Boot** — fork builds and launches branded (this milestone).
2. **Harness into the extension host** (`extensions/openova-agent`):
   - Port the pure libs verbatim (they have no DOM/Electron deps):
     `agentProtocol.ts`, `commandGate.ts`, `diff.ts`, `automations.ts`,
     `sessionPersist.ts`, `agentReview.ts`, `providers.ts`, `time.ts` (+ their
     45+ vitest tests).
   - Provider streaming (`ipc/ai.ts` → ext host fetch; no CSP in Node),
     MCP stdio client (`ipc/mcp.ts` → child_process), command execution via
     `vscode.window.createTerminal` + the SAME permission gate (dangerous
     commands always prompt via `vscode.window.showWarningMessage`).
   - fs/git via `vscode.workspace.fs` + the `vscode.git` extension API.
   - Sessions persist via `context.globalState`/`storageUri` (port the
     serializer/sanitizer as-is).
3. **UI into the webview** — bundle the React tree (AIChatPanel, MessageView,
   ReviewBar, plans, ModelPicker, ChatHistory) with a vite webview target;
   replace `window.opencursor` with a postMessage RPC adapter (same method
   names, so components port near-verbatim).
4. **Deeper workbench integration** (Void-style `src/vs/workbench/contrib/openova/`):
   inline Cmd+K edits, tab completions, editor context menu, review-changes
   in the diff editor. Do this only after 2-3 ship; core contribs raise the
   monthly upstream-rebase cost.
5. **Ship**: adapt VSCodium/void-builder GitHub Actions for packaging +
   auto-update off the existing public opencursor-releases feed; strip/redirect
   telemetry endpoints (VSCodium `undo_telemetry` approach); decide what to do
   with the vendored `extensions/copilot` (strip or leave disabled).

## Reference

Research notes: Void's VOID_CODEBASE_GUIDE (archived June 2026) is the best
prior art for fork structure; VSCodium's prepare_vscode.sh for de-branding and
release automation; Cursor proxies Open VSX via marketplace.cursorapi.com.
MS-licensed extensions (C/C++, Pylance, C#) stay unavailable on any fork.
