# Codex Session Ref Must Match Filesystem Boundary

## Rule
If a `session` value is ever used to form a filesystem path, its schema must enforce a filesystem-safe identifier contract (or the runtime must canonicalize/reject traversal segments) before path construction. `z.string().min(1)` is not sufficient when the value flows into `join(dir, `${session}.json`)`.

## Why
A permissive session schema creates a FRAME/STRUCTURE mismatch: API input accepts arbitrary strings while storage assumes safe path stems. Inputs like `../../tmp/x` can pass validation and reach lookup/write paths, causing unintended file resolution attempts and migration edge-case behavior.

## Pattern
```typescript
// Wrong: accepts any non-empty string, then builds a path
const sessionRefSchema = z.string().min(1);
const path = join(sessionDir, `${session}.json`);

// Right: enforce safe contract before path usage
const safeSessionRefSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^[a-zA-Z0-9._-]+$/),
]);
if (session.includes('..') || session.includes('/')) throw new Error('invalid session');
const path = join(sessionDir, `${session}.json`);
```
