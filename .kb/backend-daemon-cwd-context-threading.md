# Backend Daemon CWD Context Threading

## Rule
Never rely on `process.cwd()` for path resolution in code running inside the backend daemon. The daemon is spawned detached and its cwd differs from the user's project directory. Always thread `projectRoot` (from `request.cwd`) explicitly through the call chain to any function that resolves file paths.

## Why
`path.relative(base, relativePath)` internally resolves the second argument against `process.cwd()`. When the daemon's cwd is `/tmp` or similar, relative paths produce nonsensical results like `../../../../tmp/file.ts`. This is silent — no error, just wrong output.

## Pattern
```typescript
// Wrong: relies on process.cwd() inside daemon
function shortPath(filePath: string): string {
  const rel = relative(process.cwd(), filePath);  // daemon cwd ≠ project root
  return rel.startsWith('..') ? filePath : rel;
}

// Right: explicit projectRoot threading
export function shortPath(filePath: string, projectRoot?: string): string {
  const base = projectRoot ?? process.cwd();
  const abs = isAbsolute(filePath) ? filePath : resolve(base, filePath);
  const rel = relative(base, abs);
  return rel.startsWith('..') ? abs : rel;
}

// Wire from request context through the call chain:
// adapter.execute(request) → makeOnEvent(runtime, id, request.cwd)
//   → extractProgressMessage(event, projectRoot)
//     → shortPath(path, projectRoot)
```
