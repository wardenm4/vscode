# Openova roadmap — parity plan (researched 2026-07-09)

Goal: an open-source, highly customizable Cursor replacement. Agent parity with
Cursor / Claude Code / Codex; Kiro-style spec-driven mode; universal BYO
model/provider support; a visual identity that is not stock VS Code.

Sources: cursor.com/docs + /changelog, Claude Code docs, OpenAI Codex docs,
Kiro docs + launch threads, LiteLLM/OpenRouter docs, Linear design analyses.
Claims below were extracted and (mostly) adversarially verified; items marked
(unverified) survived extraction but not the 3-vote check.

---

## 1. Where we stand

Openova already has: agent/ask/plan modes, `propose_plan` editable checklist
cards, `ask_user` mid-run questions, ReAct XML tool loop (works with weak local
models), review/undo write-ledger, per-turn checkpoints, MCP stdio client, tab
completions, inline edit (Ctrl+I), a separate Agents OS window with
editor/browser/terminal panes, automations scheduler, multi-repo rail, 10 themes,
and 8 BYO-key providers.

That is roughly Cursor-2024 parity plus some 2026 UX. The gaps below are real.

---

## 2. Gap analysis

### 2a. Persistent context / project instructions — **we have NOTHING here**
- `AGENTS.md` is an open cross-tool standard governed under the Linux Foundation,
  adopted by Codex, Cursor, Copilot, Gemini CLI, Windsurf, Cline, Aider and Zed,
  reportedly used in 60,000+ repos. We support none of it.
- Cursor: `.cursor/rules/*.mdc` with frontmatter and **four activation modes**
  (always / intelligent / glob-matched / manual @-mention), plus nested
  `AGENTS.md` in subdirectories.
- Kiro: steering files are plain markdown in `.kiro/steering/`, so other tools'
  rule files drop in and work as-is.
- Community consensus in the research: support the *standard* format, not a
  proprietary one. Per-tool rule migration friction is a top complaint.

**This is our single biggest gap and the cheapest to close.**

### 2b. Extensibility primitives (Claude Code's model, now copied by Cursor)
Three distinct primitives, each with a different job:
- **Skills** — `SKILL.md` folders (+ optional scripts/templates) in
  `~/.claude/skills/` and repo-local `.claude/skills/`. Loaded **on demand** by
  matching the one-line `description` (progressive disclosure), so baseline token
  cost stays low. Anthropic **open-sourced the format as a standard in Dec 2025**,
  so we can adopt it directly. Keep bodies under ~1,500 words.
- **Hooks** — deterministic shell commands fired at fixed lifecycle events
  (~26 events incl. `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`,
  `UserPromptSubmit`). Near-zero token cost; run outside the model. Power users
  use them for governance and for "keep going" autonomy loops.
- **Subagents** — files in `.claude/agents/`, each with its own context window,
  tool allowlist, and model assignment. Claude Code 2.0 ships named built-ins
  (general-purpose, Explore, Plan) spawned via a Task tool.

Cursor 3.9 added a unified **Customize** page for plugins/skills/MCPs/subagents/
rules/commands/hooks + a marketplace. Plugins bundle all of the above into one
distributable unit.

We have: an inline `subagent` tool with a fresh transcript. That's it.

### 2c. Safety model — Codex is the reference, and it is a *sandbox*, not a prompt
- Codex enforces at the **OS kernel layer**: Seatbelt/`sandbox-exec` on macOS,
  bubblewrap + seccomp/Landlock on Linux, a native Windows sandbox, WSL2
  inheriting Linux semantics. Claude Code by contrast enforces at the
  application layer via hooks.
- **Three sandbox modes**: `read-only`, `workspace-write` (default),
  `danger-full-access`.
- A **separate approval-policy axis**: `untrusted` / `on-request` / `never`.
  Sandbox and approval are orthogonal — escalation is its own decision.
- **Network off by default** for sandboxed commands; explicit opt-in
  (`network_access = true` under `[sandbox_workspace_write]`).
- Even inside writable roots, `.git` stays read-only so the agent can't corrupt
  repo metadata.
- Child processes (git, package managers, test runners) **inherit** restrictions.
- Codex's built-in web search defaults to **cached** results as an explicit
  prompt-injection mitigation; live browsing is opt-in.

We have a regex command gate + a modal + an `auto` bypass. That is application-
layer only, and our `permissionMode` conflates the sandbox and approval axes.

### 2d. Agent capability gaps vs Cursor
Confirmed:
- **Browser control as an agent tool** — navigate, interact with elements,
  capture state, visual verification. (We have a browser *pane*; the agent
  cannot drive it.)
- **Image generation** for UI mockups, saved to `assets/`.
- **No cap on tool calls** per task.
- **Checkpoints** snapshot the codebase before major changes, restore without git.
- **Queued follow-ups**, reorderable, sequential. (We have this.)
- **Per-model harness tuning** — Cursor orchestrates instructions, tools, and
  model separately per frontier model rather than one generic harness.
- **Plan mode persists plans as files** (home dir by default; "Save to workspace"
  to promote for team sharing/documentation). Ours are transient cards.
- **Codebase indexing**: semantic chunking by function/class/logic block (a
  ~1000-line file → ~30 chunks), Merkle-tree incremental sync ~every 5 min,
  server-side embeddings in a remote vector DB, indexes deleted after 6 weeks
  idle. `.cursorignore` controls scope.
- **@-symbols**: `@Codebase`, `@Files`, `@Folders`, `@Code`, `@Docs`, `@Web`.
- **Await tool** for waiting on background shell commands/subagents/output;
  browser automation with screenshot-based coordinate-click fallback.

Cursor 3.x (unverified — extracted but the 3-vote check was cut short by rate
limits; treat as directional):
- Dedicated **Agents Window** running many agents in parallel across local, git
  worktrees, cloud, and remote SSH — a superset of ours.
- **Design Mode**: annotate the rendered UI (Shift+drag area select, Cmd+L to
  add to chat) so the agent gets precise visual feedback.
- **/best-of-n**: same task in parallel across multiple models, each in an
  isolated git worktree, then compare outcomes. **/worktree** isolates one agent.
- **Agent tabs** side-by-side/grid.
- Cloud subagents (`/in-cloud`) on isolated VMs + branches; local↔cloud handoff;
  iOS app with remote control of desktop agents; automations triggered by Slack
  emoji + 5 GitHub event types.

**Out of scope for us (deliberately):** cloud VMs, mobile app, hosted
marketplace, team/enterprise MCP administration. We are local-first and
open-source; those require a backend business. Everything else is fair game.

### 2e. MCP
Both Claude Code and Codex support MCP over **stdio *and* HTTP** (Codex with
OAuth). **We are stdio-only — behind the current baseline.**

### 2f. Checkpoints
Claude Code rewinds **code *and* conversation state** (`Esc Esc` / `/rewind`).
Ours is a code-only write-ledger. Cursor snapshots before major changes.

### 2g. Kiro spec-driven development — what it actually is
A three-stage **Requirements → Design → Tasks** flow, materialized as three
version-controlled markdown files:
1. `requirements.md` — user stories with **GIVEN/WHEN/THEN (EARS-style)**
   acceptance criteria.
2. `design.md` — architecture, data models/flow, error handling, testing strategy
   (diagrams).
3. `tasks.md` — itemized work packages, each **traceable to requirement numbers**,
   sized for an LLM, with per-task execute/review UI; the agent tracks progress
   in the file.

Plus **steering files** (`.kiro/steering/*.md`, e.g. `structure.md`, `tech.md`)
and **agent hooks**. Kiro's stated goal: move from vibe coding to repeatable,
trackable development where specs are version-controlled collaboration artifacts.
Kiro recommends committing specs as an append-only history. Incremental editing
preserves prior requirements across sessions.

**The criticisms are as important as the mechanics** — design around them:
- Over-engineers small tasks: a small bug fix became **4 user stories with 16
  acceptance criteria**; 12+ tasks with 4+ sub-tasks each.
- The review burden shifts from code to **verbose markdown nobody wants to read**.
- **Spec drift/consolidation**: no step merges accumulated per-feature specs into
  one ground truth; hard to apply to legacy codebases.
- Kiro **rewrites existing planning documents** instead of respecting them.
- Cultural resistance: "a regression toward waterfall / Big Design Up Front."
- GitHub spec-kit (Constitution → Specify → Plan → Tasks, immutable
  "constitution", per-phase definition-of-done, a branch per spec) produced a
  broken build after a 10-day trial.

Design implications: **opt-in, scale artifacts to task size, never overwrite the
user's docs, and make specs skimmable.**

### 2h. BYO models / routing / cost
- **LiteLLM** = self-hosted OSS router: OpenAI Chat Completions as the single
  frontend, translated to ~100 backends (incl. Ollama, vLLM). Routing strategies:
  weighted pick, latency-based, rate-limit-aware, least-busy, lowest-cost, plus
  custom. Retry→fallback chains, cooldowns on failed upstreams, context-window-
  aware routing for oversized requests. Budgets per provider/model (and per-tag,
  enterprise) with a USD `budget_limit` + `time_period` ("30s".."1mo"), auto-reset;
  over-budget providers are **skipped and failed over**, erroring only if all are
  over. Redis required for consistent multi-instance spend. Virtual keys
  (Org → Team → Key) with combined spend/request-rate/token-rate caps.
- **OpenRouter** = hosted aggregator, 400+ models, **5.5% on credits and 5% even
  when using your own provider keys**; routing is provider-level LB + an
  auto-router.
- **Latency**: LiteLLM ~3 ms median routing overhead (1% > 31 ms); routing local
  models through it costs ~4 ms and 2.2% throughput. OpenRouter adds ~40 ms via
  Cloudflare edge. → For interactive features (tab completion) the router must be
  **in-process**, not a hosted hop.
- **Per-task model assignment is the expected pattern.** JetBrains splits local
  models across three feature groups (core / instant helpers / completion), with
  completion restricted to **FIM-compatible** models. A cited power-user setup:
  Opus for execution, GPT-5.2-Codex for review/bug-detection.
- **Hard constraint:** even JetBrains' mature assistant does **not** offer
  completion/next-edit with BYO models, because those depend on proprietary
  models. Our prompt-based completion is a differentiator but must use FIM where
  the model supports it.
- JetBrains defaults local models to a **64k context window**, user-overridable.
- JetBrains does **not** allow MCP tool calls with local models. Our ReAct XML
  loop giving local models real tools is a genuine differentiator — lean into it.
- OpenCode delegates routing to gateways (Vercel AI Gateway, OpenRouter) and cost
  tracking to Helicone rather than building either. We should build in-process.

Providers to add: Google Gemini, Vertex AI, AWS Bedrock, Groq, Together,
Fireworks, DeepSeek, xAI, llama.cpp, vLLM.

### 2i. Visual identity
- The 2026 dev-tool look is the **"Linear aesthetic"** (named after linear.app;
  adopted by Stripe, Wise, Raycast, GitHub, Reflect). Ingredients: bold
  typography, gradients as faux-depth, glassmorphism, high contrast with a
  minimal palette, single-column sequential layouts.
- **Linear's dark theme is NOT pure black.** Canvas `#010102` with a ladder of
  layered surfaces: `#0f1011`, `#141516`, `#18191a`, `#191a1b`. Guidance is
  explicit: avoid `#000000`; tint dark backgrounds with the brand color at ~1-10%
  lightness. **Our "Void" theme is pure `#000000` — it should gain an elevation
  ladder and a hint of brand tint.**
- Linear's accent: `#5e6ad2`, hover `#828fff`. Custom brand fonts (Linear
  Display/Text/Mono, falling back to SF Pro Display) with aggressive negative
  letter-spacing at display sizes (80px / 600 / -3.0px).
- **The trap:** wholesale adoption produces visual sameness; glassmorphism is
  hard to execute distinctively. Openova should take the *structure* (elevation
  ladder, typography discipline, restraint) and pick its **own** accent identity
  (we already have nova purple `#7c6cf0`), not clone Linear's lavender.
- Competitive notes: Windsurf's Cascade is EOL 1 Jul 2026 (→ Devin Local) and had
  destructive bulk-delete incidents. Zed is fast/free but has **no built-in agent
  harness** — it shells out to Claude Code. Antigravity's free tier exhausts in
  ~10 exchanges. A polished, local-first, BYO-model harness has a real opening.

---

## 3. Implementation plan

Ordered by (user value ÷ effort). Each phase is independently shippable.

### Phase 1 — Persistent context (the biggest gap, smallest cost)
1. **`AGENTS.md` support.** Load repo-root `AGENTS.md` into `extraRules`; walk
   up from the edited file for **nested** `AGENTS.md` in subdirectories, nearest
   wins. Standard format, zero lock-in.
2. **Rules directory.** `.openova/rules/*.md` with YAML frontmatter:
   `alwaysApply`, `globs`, `description`. Four activation modes:
   always / glob-matched / model-selected (by description) / manual `@rule-name`.
   Also read `.cursor/rules/*.mdc` and `.kiro/steering/*.md` verbatim so users
   migrate for free.
3. **Memories.** `.openova/memory.md`, appended by an agent tool
   (`remember`), injected each run.
4. UI: a **Rules** section in the Agents-window Customize pane listing what is
   active this turn and why (always / glob hit / model-selected).

*Touches: `extension.ts` (rule loading + `extraRules` assembly), a new
`src/rules.ts`, `media/main.js` (Customize pane).*

### Phase 2 — Safety model done properly (Codex's two axes)
1. Split `openova.permissionMode` into **two** settings:
   - `openova.sandbox`: `read-only` | `workspace-write` (default) | `full-access`
   - `openova.approval`: `untrusted` | `on-request` (default) | `never`
2. Enforce the sandbox where the OS lets us:
   - Windows: run agent commands in a restricted job object / low-integrity token,
     cwd-scoped; deny writes outside workspace.
   - Linux/WSL: `bwrap` + seccomp when available (feature-detect).
   - macOS: `sandbox-exec` profile.
   Fall back to the current gate + a clear "unsandboxed" badge when unavailable —
   **be honest in the UI about which boundary is actually enforced.**
3. **Network off by default** inside `workspace-write`; explicit opt-in.
4. Keep `.git`, `.openova` read-only always. Ensure child processes inherit.
5. Web fetches default to **cached**; live fetch is opt-in (prompt-injection
   mitigation).

*Touches: `tools.ts` (`runShell`, `approveCommand`), new `src/sandbox.ts`,
`package.json` config.*

### Phase 3 — Extensibility trio (Skills / Hooks / Subagents)
1. **Skills** — adopt the open `SKILL.md` standard verbatim. Discover from
   `.openova/skills/` and `~/.openova/skills/`; inject only the one-line
   descriptions into the system prompt; load a body on demand when the model
   calls `use_skill(name)`. (Progressive disclosure keeps our local-model token
   budget viable — this matters *more* for us than for cloud tools.)
2. **Hooks** — `.openova/hooks.json` mapping lifecycle events to shell commands.
   Start with the events that pay for themselves: `SessionStart`,
   `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`. A non-zero exit on
   `PreToolUse` blocks the tool (deterministic governance, zero tokens).
3. **Subagents as files** — `.openova/agents/*.md` with frontmatter
   (`description`, `tools`, `model`). Our existing `subagent` tool gains a
   `type` arg selecting one; each runs with an isolated transcript, its own tool
   allowlist, and **its own model** (ties into Phase 5 routing).
4. **Customize pane** becomes the single surface for Rules / Skills / Hooks /
   Subagents / MCP — mirroring Cursor's Customize page, locally and file-backed.

*Touches: new `src/skills.ts`, `src/hooks.ts`; `lib/agent.ts` (tool surface),
`extension.ts`.*

### Phase 4 — Agent capability parity
1. **MCP over HTTP** (Streamable HTTP + OAuth) alongside stdio. Closes a
   documented baseline gap.
2. **Browser control as an agent tool.** We already host a browser pane — expose
   `browser_navigate`, `browser_click`, `browser_screenshot`, `browser_snapshot`
   to the agent, with a screenshot-coordinate fallback. This turns a passive pane
   into Cursor's differentiating capability.
3. **`await` tool** — wait on a background command / subagent / output pattern.
4. **Conversation rewind** — extend checkpoints to restore transcript state, not
   just files (`/rewind`). We already persist per-turn write ledgers; add message
   truncation + a restore point.
5. **Plans as files** — write approved plans to `.openova/plans/<slug>.md`,
   editable on disk, re-loadable, promotable into the repo. (Cursor's model; also
   the bridge to Phase 6 specs.)
6. **Codebase index** — port the BM25 index from the standalone app first (local,
   no embeddings, no server). Optional local embeddings later via the
   `text-embedding-nomic` model already present in LM Studio. Semantic chunking
   by function/class; incremental refresh on save. Feeds `@Codebase`.
7. **@-symbols**: `@Files`/`@Folders` (have), add `@Code` (symbol), `@Codebase`,
   `@Docs` (indexed URLs), `@Web` (cached-by-default fetch).
8. **Worktree isolation** (`/worktree`) and **best-of-N** across models —
   cheap for us because it's just N agent loops in N `git worktree` dirs plus a
   comparison view. This is a headline feature that costs us little.

### Phase 5 — Universal BYO models (in-process router)
1. **Provider registry expansion**: Gemini, Vertex, Bedrock, Groq, Together,
   Fireworks, DeepSeek, xAI, llama.cpp, vLLM (most are OpenAI-compatible → cheap).
2. **In-process router** (LiteLLM's design, not its dependency — ~3 ms, vs ~40 ms
   for a hosted hop; tab completion cannot afford the hop):
   - retry → fallback chains across deployments
   - cooldown on failing upstreams
   - context-window-aware routing (oversized request → bigger-context model)
   - strategies: lowest-cost, lowest-latency, least-busy
3. **Per-task model assignment** — distinct models for: agent execution, plan
   drafting, code review, chat titling, tab completion, embeddings. Mirrors
   JetBrains' three feature groups and the Opus-executes/Codex-reviews pattern.
   Completion must prefer **FIM-capable** models.
4. **Cost tracking + budgets** — token/spend accounting per request, per provider,
   per session; USD `budget_limit` + `time_period` with auto-reset; over-budget
   providers are skipped, not fatal. Surface as a live cost meter in the composer
   and a stats tile in the Agents window (BridgeAgent's `$3.20 / $10.00 cap`
   pattern). Local models = $0 and should say so.
5. **Local-model context default**: 64k, user-overridable.
6. Keep BYO keys direct (no aggregator tax); OpenRouter stays *a* provider, not
   *the* path.

*Touches: `lib/providers.ts`, `lib/ai.ts`, new `src/router.ts`, `src/cost.ts`.*

### Phase 6 — Spec-driven mode (Kiro, with its lessons applied)
A **fourth mode** next to Agent / Ask / Plan: **Spec**.

1. `openova.spec.start "<intent>"` scaffolds `.openova/specs/<slug>/`:
   - `requirements.md` — user stories + **GIVEN/WHEN/THEN** acceptance criteria,
     each numbered (`R1.2`).
   - `design.md` — architecture, data model, error handling, testing strategy.
   - `tasks.md` — checklist, **each task citing the requirement IDs it satisfies**.
2. Gate each stage behind approval, reusing the existing plan-card machinery:
   requirements card → design card → tasks card. Tasks execute one at a time with
   per-task review, checking off in `tasks.md` (our `update_plan` already does
   check-off; point it at the file).
3. **Apply the research's criticisms as hard rules:**
   - **Scale to size.** A one-file change must never produce 16 acceptance
     criteria. Heuristic gate: spec mode is opt-in, and the agent proposes
     "this looks small — do it directly?" when the task touches < 2 files.
   - **Never overwrite user docs.** If `requirements.md` exists, *amend*,
     preserving prior requirements (Kiro's own incremental-edit promise, which
     users report it breaks).
   - **Fight drift.** A `spec consolidate` command that merges per-feature specs
     into one ground-truth doc — the step every SDD tool is missing.
   - **Skimmable.** Cap generated markdown; lead each artifact with a 3-line
     summary so review isn't a slog.
4. Steering files: read `.openova/steering/*.md` **and** `.kiro/steering/*.md`.
5. Commit specs to the repo (append-only history) — but only when asked.

### Phase 7 — Identity reskin (stop looking like VS Code)
The research is blunt: adopting the Linear look wholesale produces sameness. Take
the *discipline*, keep our *identity* (nova purple `#7c6cf0`).

1. **Fix Void's elevation.** Replace flat `#000000` with a Linear-style ladder:
   canvas `#050507` (brand-tinted, not pure black), surfaces
   `#0d0d12` → `#131319` → `#191920`, hairlines at 8-11% foreground. Pure black
   kills depth and is explicitly discouraged.
2. **Typography discipline.** A display face for hero/wordmark with negative
   letter-spacing at large sizes; `ui-sans-serif`/Inter for UI; keep the mono for
   all numerics, paths and durations (already done in the BridgeAgent pass).
3. **Custom workbench chrome** — replace the stock activity bar with our rail
   idiom, restyle the title bar, tabs, quick-input and command palette to the
   card/hairline language. This is where "it still looks like VS Code" actually
   lives: the workbench, not the webview.
4. **Own onboarding** — replace the VS Code welcome page with an Openova hero:
   provider setup, model picker, theme picker, "open a folder", and a first-run
   agent demo. (We already flag `skipWelcomeOnboarding`.)
5. **Iconography** — one coherent icon set for the rail/tabs; retire mixed
   Codicons where they show.
6. **Design Mode** (Cursor 3.0, unverified but obviously good): Shift+drag to
   select a region of the rendered page in the browser pane, `Ctrl+L` to attach
   it as visual context. We already own the browser pane and image input — this
   is mostly wiring.

---

## 4. Suggested order

| # | Phase | Why here |
|---|-------|----------|
| 1 | AGENTS.md + rules + memories | Biggest gap, days not weeks, unlocks everything else |
| 2 | Sandbox + approval split | Safety debt; blocks confident `auto` mode |
| 3 | Skills / Hooks / Subagents | The extensibility story; skills' progressive disclosure is worth *more* on local models |
| 4 | MCP HTTP + browser tool + rewind + plans-as-files | Closes named capability gaps |
| 5 | Router + per-task models + cost/budgets | The "bring any model" promise, properly |
| 6 | Spec mode | Differentiator; needs 1+3 to exist first |
| 7 | Reskin + Design Mode | Identity; do it once the surfaces have stopped moving |

Worktrees + best-of-N can be pulled forward into 4 — they are cheap and headline.

## 5. Explicit non-goals
Cloud VMs, hosted agents, mobile app, hosted marketplace, team MCP administration,
server-side embeddings. These require a backend business and are contrary to
local-first, BYO-key, open-source. Note that Zed — fast, free, popular — ships
**no** built-in agent harness, and Windsurf's is being retired; a polished
local-first harness is an open lane.
