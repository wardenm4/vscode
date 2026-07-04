# Keeping Openova in sync with upstream VS Code

Openova is a fork of [microsoft/vscode](https://github.com/microsoft/vscode).
Our work lives as ~30 commits on top of an upstream base (branch
`openova-base` on wardenm4/vscode). Upstream moves fast; merge it in
**monthly** (or after any security release) so the fork never drifts far.

## The routine

```powershell
cd C:\Users\Budge\dev\vscode

# 0. clean tree required
git status --short

# 1. fetch upstream (added once: git remote add upstream https://github.com/microsoft/vscode.git)
git fetch upstream main

# 2. see how far things have moved
git rev-list --count (git merge-base HEAD upstream/main)..upstream/main

# 3. merge — prefer a release-ish point over main-tip when available
git merge upstream/main
```

## Resolving conflicts

Dry-run findings (2026-07-04, 63 commits behind): **every conflict was in
`extensions/copilot/`**, which Openova deletes. Resolve those by deleting
again — this is the standing rule for that directory:

```powershell
git rm -r --force extensions/copilot
git checkout --ours .github/workflows 2>$null   # keep our release workflow if touched
git commit
```

Files where real conflicts are *possible* (our patches live here — resolve
by keeping the Openova behavior and folding in upstream's changes around it):

- `product.json` — identity, Open VSX gallery, updateUrl/quality, skipWelcomeOnboarding
- `src/vs/workbench/workbench.common.main.ts` — our `contrib/openova` import
- `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts` — AI-disabled defaults
- `src/vs/platform/update/electron-main/*` — static update feed + version-equality checks
- `src/vs/workbench/services/themes/common/workbenchThemeService.ts` — default theme names
- `src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts` — skip gate
- `src/vs/workbench/browser/parts/editor/media/letterpress-*.svg` — logo watermarks
- `build/gulpfile.vscode.ts`, `build/gulpfile.vscode.win32.ts`, `build/hygiene.ts` — fork guards
- `build/npm/dirs.ts` — extensions/copilot entry is existsSync-guarded (upstream re-adds it)
- `build/win32/code.iss` — installer branding
- `eslint.config.js` — copilot plugin stub

`extensions/openova-agent`, `extensions/openova-themes`,
`src/vs/workbench/contrib/openova/` and `build/openova/` are ours alone —
upstream never touches them.

## Verify before pushing

```powershell
$env:VSCODE_SKIP_NODE_VERSION_CHECK = '1'
npm ci                       # only if package.json/lockfile changed in the merge
npm run compile              # core + extensions, must be 0 errors
npm run gulp vscode-win32-x64   # packaged build boots
```

Smoke the agent with the dev harness (any workspace):
`OPENOVA_DEV_TRIGGER` json `{"agentsWindow":true,"text":"Create a file up.txt containing exactly UP OK","mode":"agent"}`
then check the file contents and `OPENOVA_DEV_TRACE` for `finish:`.

Push to the working branch (never force, never to main directly):

```powershell
git push origin main:openova-base
```

Then rebuild the release artifacts (zip + user-setup + update manifests via
`build/openova/updateManifest.ts`) if you intend to ship the merged build.
