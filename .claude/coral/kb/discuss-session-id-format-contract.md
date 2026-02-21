# Discuss Session ID Format Is a Validation Contract
## Rule
Treat discuss session ID format as an API contract across generation, storage, and schema validation. Any format change must update `state-machine` generation, `session-store` resolution, and `sessionIdPattern` in `src/discuss/schemas.ts` together, with dual-format acceptance during migration when older sessions must remain addressable.
## Why
If only generation/storage changes, newly created session IDs fail Zod validation on every subsequent discuss tool call. If only the regex changes to the new format, legacy sessions become unreachable. Both failure modes are high-impact because they break normal discussion flow after `discuss_create`.
## Pattern
```typescript
// Wrong: generation changed, validation unchanged
// formatDateId -> yymmdd-HHmm
export const sessionIdPattern = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;

// Better migration: accept both old and new during transition
export const sessionIdPattern = /^(?:[0-9]{8}-[0-9]{6}|[0-9]{6}-[0-9]{4})-[a-z0-9]{4}$/;

// Also keep resolveDir backward-compatible for dir separators
entries.find((e) => e.startsWith(sessionId + '-') || e.startsWith(sessionId + '_') || e === sessionId);
```
