# Stay in control

Two independent axes decide what the agent may do and when you're asked (the Codex model):

- **Sandbox** (`openova.sandbox`) — what's allowed: `read-only`, `workspace-write` (default), or `full-access`. Whatever the mode, `.git/` and `.openova/` are never agent-writable.
- **Approval** (`openova.approval`) — when you're prompted: `untrusted` asks for every non-trivial command, `on-request` only for escalations, `never` runs autonomously. Destructive commands always prompt unless you opt out.

Network-touching commands (curl, ssh, ...) are gated separately by `openova.networkAccess`.

Both axes are one click away in the model picker (Sandbox / Approval segments). Every run's file changes land in a review bar with per-file diffs, **Undo all**, and checkpoints you can restore — including a full conversation rewind.
