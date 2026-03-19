# Home-Based Path Extracts Need a Sync Seam
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
When extracting `homedir()`-derived paths into a shared module, do not assume an eager top-level constant is behavior-preserving. If importers are loaded before tests or callers finish configuring the mocked home directory, the extracted value can capture the wrong base path or even throw during module evaluation. Keep the shared export, but add a small sync/recompute seam that use sites call immediately before joining or enumerating under that base.
## Why
`tmpdir()` paths like `JOBS_DIR` can survive as true import-time constants when tests hoist a stable mock before import. `homedir()` paths are more fragile because some suites mutate the mocked home root in `beforeEach()` or close over a variable that is not initialized when the shared module first loads. Extracting `SESSION_BASE` to `paths.ts` turned a previously lazy `SessionManager` path into an eager import-time read, which broke the session-manager suite and orphan-recovery startup scan until the code refreshed the exported path at constructor/list-shard call time.
## Pattern
Wrong:
```typescript
export const SESSION_BASE = join(homedir(), '.claude', 'coral', 'execution', 'sessions');

constructor(workingDirectory: string) {
  this.sessionDir = join(SESSION_BASE, projectHash(workingDirectory));
}
```

Right:
```typescript
export let SESSION_BASE = join(readHomeDir(), '.claude', 'coral', 'execution', 'sessions');

export function syncHomePaths(): void {
  SESSION_BASE = join(readHomeDir(), '.claude', 'coral', 'execution', 'sessions');
}

constructor(workingDirectory: string) {
  syncHomePaths();
  this.sessionDir = join(SESSION_BASE, projectHash(workingDirectory));
}
```
