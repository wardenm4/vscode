# Four ways to work

The dropdown in the composer picks how Openova responds:

- **Agent** — the default. Explores your workspace, writes files, runs commands (permission-gated), verifies with checks, and reviews its own diff. Multi-file tasks propose a plan you approve and can edit first.
- **Ask** — chat about your code with no side effects.
- **Plan** — draft an editable step-by-step plan; approve it to execute with live check-off. Approved plans persist to `.openova/plans/`.
- **Spec** — Kiro-style spec-driven development: EARS requirements → design → tasks, each stage a durable doc under `.openova/specs/` that you approve before the next. Approved tasks execute with requirement-traceable check-off. Type `consolidate` in Spec mode to reconcile the checklist with reality.

While a run streams you can queue follow-ups, leave feedback on the plan, or stop it. Every run gets a checkpoint — *Restore checkpoint* reverts the files **and** rewinds the conversation.
