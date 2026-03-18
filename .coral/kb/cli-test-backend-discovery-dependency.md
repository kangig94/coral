# CLI Test Backend Discovery Dependency
Promoted: 2026-03-14

## Rule
CLI integration tests that pass validation and proceed to `ensureBackend()` implicitly depend on finding (or not finding) a backend at the current discovery path. When backend path logic changes (e.g. namespace isolation), tests that previously found a running backend may start spawning a new one, causing timeouts. Always pass `HOME: tmpDir` in `runCli()` env overrides for tests that should fail at the connection stage — this prevents accidental dependency on a running backend from another installation.

## Why
The CLI workflow --json tests passed for months because a running backend's `backend.json` was at the global path. After namespace isolation moved discovery to `installations/<hash>/`, these tests couldn't find it, tried to spawn a new backend, and timed out. The root cause was invisible until the path changed.

## Pattern
Right:
```typescript
// Test expects connection failure, not validation failure
const { stderr } = runCli(['workflow', '--json', jsonFile], { HOME: tmpDir });
expect(stderr).not.toContain('--expression is required');
```

Wrong:
```typescript
// Implicitly depends on whatever backend is running globally
const { stderr } = runCli(['workflow', '--json', jsonFile]);
```
