# Codex Session Schema Split: Opaque String vs UUID Enforcement

## Rule
`exec`, `fork`, and `coral:*` ops accept `session` as an opaque `z.string()` at schema level — giving session-not-found semantics when a name is passed instead of a UUID. `wait` and `abort` enforce `z.string().uuid()` at schema level. Handler-facing TypeScript types must use `Omit<..., 'op'>` even when the underlying Zod shape is strict, to avoid breaking call sites that pass only `{ session }`.

## Why
If `exec`/`fork` enforced UUID at the schema level, passing a session name would fail with a schema error rather than a "session not found" error. The session-not-found message is actionable (tells the caller the session doesn't exist); a UUID schema error is confusing (implies the user sent malformed data). Conversely, `wait`/`abort` require UUID because they must target a specific running job — opaque names are ambiguous when multiple sessions share a name. The `Omit<..., 'op'>` pattern prevents `CodexSessionAbortInput` from including `op`, which would force callers to pass `{ op: 'abort', session }` even when op-routing has already happened at the handler boundary.

## Pattern
```typescript
// schemas.ts — schema-level split
const execShape = z.object({ op: z.literal('exec'), session: z.string().optional(), ... });
const waitShape = z.object({ op: z.literal('wait'), sessions: z.array(z.string().uuid()), ... });
const abortShape = z.object({ op: z.literal('abort'), session: z.string().uuid(), ... });

// Handler types — always Omit op, even on strict shapes
export type CodexSessionAbortInput = Omit<z.infer<typeof abortShape>, 'op'>;
// Call site: handleSessionAbort({ session: uuid }, mgr)  ← no op required
// NOT:       handleSessionAbort({ op: 'abort', session: uuid }, mgr)

// WRONG — uniform UUID enforcement at schema breaks user experience:
const execShape = z.object({ session: z.string().uuid().optional() });
// Now passing { session: 'my-named-session' } gets: "Invalid UUID" instead of "Session not found"
```
