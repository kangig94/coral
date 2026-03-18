# Codex Union Migration — Test and Schema Gaps

## Rule
When migrating Codex MCP tools to a unified `codex` tool with `op` field, also update test files that hardcode old tool names in assertions, and decide explicitly whether union schemas should be strict.

## Why
`server-progress.test.ts` hardcodes `codex_session_create` in progress metadata assertions — these become stale after unification. Dropping `.strict()` on union shapes is a silent contract change: `{ op: 'list', extra: ... }` will parse without error, potentially masking caller bugs.

## Pattern
```typescript
// WRONG: Hardcoded old tool names in tests (becomes stale)
expect(notification.params.metadata).toEqual({ toolName: "codex_session_create" });

// RIGHT: Update to unified name
expect(notification.params.metadata).toEqual({ toolName: "codex" });

// DECISION NEEDED: Schema strictness
// Permissive (current): extra fields silently ignored
codexExecSchema.or(codexListSchema)  // no .strict()
// Strict: rejects unknown fields → catches caller bugs
codexExecSchema.strict().or(codexListSchema.strict())
```
