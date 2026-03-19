# Hook Input Has `session_id`; MCP Initialize Does Not
## Rule
Do not assume the Coral MCP bridge can discover the caller's Claude `session_id` from the MCP protocol. Hook input JSON exposes `session_id`, but the MCP `initialize` handshake only provides client metadata. If backend logic truly needs caller session identity, capture it in a hook and persist or forward it explicitly; otherwise prefer a more stable scope such as `CLAUDE_PROJECT_DIR`.
## Why
Plans that treat hook input and MCP transport as symmetric end up inventing impossible bridge behavior and overfitting recovery logic to session continuity. That adds unnecessary plumbing when project-scoped recovery is already sufficient, and it fails silently because the session identifier is simply not present in normal MCP initialization.
## Pattern
Right:
```text
Hook reads input.session_id
Hook writes handoff file keyed by project or explicit token
MCP bridge reads the persisted handoff if needed
```

Wrong:
```text
MCP initialize -> infer caller session_id directly
Use that assumed session_id as the only recovery key
```
