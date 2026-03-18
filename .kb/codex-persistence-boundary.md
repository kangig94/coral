# Codex: Keep Persisted Records Internal to Session Manager

## Rule
`SessionEntry` (with `createdAt`, `lastUsedAt`, etc.) should stay internal to `session-manager.ts`. Orchestration handlers only need routing identifiers (`name`, `sessionId`, `workingDirectory`). Expose a lean domain-facing view, not the storage record.

## Why
Leaking persistence-shaped records into handler code couples storage schema to domain behavior. Any future storage change (field renames, new metadata) causes unnecessary type churn in handlers that never read those fields.

## Pattern
```typescript
// Wrong — handler receives full persistence record
function handleExec(entry: SessionEntry) { /* only uses entry.name, entry.sessionId */ }

// Right — handler receives domain view
type SessionRef = Pick<SessionEntry, 'name' | 'sessionId' | 'workingDirectory'>
function handleExec(ref: SessionRef) { ... }
```
