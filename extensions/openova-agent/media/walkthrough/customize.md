# Make it yours

Openova reads open-format project files — the same ones Cursor, Claude Code, and Kiro use, so your existing setup just works:

- **`AGENTS.md`** — project instructions, always injected (the cross-tool standard)
- **`.openova/rules/*.md`** and **`.cursor/rules/*.mdc`** — rules with frontmatter activation: always, glob-scoped, or on-demand
- **`.kiro/steering/*.md`** — steering docs
- **`.openova/memory.md`** — durable memory; the agent's `remember` tool appends to it
- **`.openova/skills/<name>/SKILL.md`** — skills the agent loads on demand (progressive disclosure)
- **`.openova/agents/*.md`** — named subagent types with their own prompt, model, and tool allowlist
- **`.openova/hooks.json`** — deterministic shell hooks at lifecycle events; a non-zero PreToolUse exit **blocks** the tool

The *Customize* pane in the Agents window shows everything that's active, with one-click open.
