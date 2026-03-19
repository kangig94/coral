# Codex: Session Label Canonicalization Must Precede Dispatch

## Rule
When handling `exec` (with session) or `fork`, the dispatcher must look up the session and canonicalize `sessionLabel` to `entry.name` before choosing background/foreground path. Do not defer this lookup to downstream handlers.

## Why
`entry.name` is used by progress files and `session_name` fields in user-visible output. If downstream handlers do their own lookup by session ID, the label can drift to a non-canonical form, causing inconsistent progress metadata despite identical core execution.

## Pattern
```typescript
// Right — canonicalize at dispatch level
const entry = sessionManager.get(sessionId);
if (!entry) return error("Session not found");
const label = entry.name; // canonical
dispatch(label, ...);

// Wrong — let downstream re-derive label
dispatch(sessionId, ...); // downstream may use raw ID as label
```
