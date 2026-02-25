# end_reason_content is Not Derivable

## Rule
`end_reason_content` in DiscussState is the only persisted source for human-readable `session_ended` payload text. `applyEnd` appends session events to transcript without storing the canonical end reason mapping, so the field cannot be reconstructed from transcript entries. Removing it silently changes external MCP behavior (bid waiters read it directly at `handlers/bid.ts:24`).

## Why
During simplification/refactoring, this field looks redundant — it's set in handlers before `applyEnd` and seems derivable. But no transcript entry records the mapped reason string, so removing it breaks the `session_ended` response payload that agents receive.

## Pattern
**Wrong**: Remove `end_reason_content` as "derivable from transcript"
```typescript
// No transcript entry contains the endContent() mapped string
// applyEnd only writes session_event entries, not the reason text
```

**Right**: Keep `end_reason_content` or add a persisted `end_reason` enum field that `endContent()` can map at read time
```typescript
// handlers/bid.ts:24 — directly used in external response
return jsonResult({ action: 'session_ended', reason: 'already_ended', content: state.end_reason_content });
```
