# Rejected LaunchDecision Needs a Dedicated CLI Emitter
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
If a Coral CLI command emits `LaunchDecision` values in text mode, do not route rejected decisions through the generic `emit(result, formatter)` error path and expect the launch formatter to run. In `src/cli/main.ts`, `normalizeResult()` marks `{ status: "rejected" }` as `isError`, and `emit()` ignores its caller-supplied formatter when `isError` is true. Handle rejected launch decisions with a dedicated launch-decision emitter or an explicit rejected branch that formats them with `formatLaunchDecision()` before falling back to generic error formatting.
## Why
The success and error branches in the shared CLI emitter have different formatting rules. Launch commands want rejected decisions to stay in the launch vocabulary (`Rejected [code]: message`), but the generic error path only knows `formatError()`. If a plan or implementation assumes `emit(result, formatLaunchDecision)` covers both running and rejected launches, text-mode output silently degrades and the CLI loses the readable rejection contract that `formatLaunchDecision()` already defines.
## Pattern
Right:
```typescript
if (isLaunchDecision(output) && output.status === 'rejected') {
  process.stderr.write(formatLaunchDecision(output) + '\n');
  process.exitCode = 1;
  return;
}

emitLaunchDecision(output, outputFormat);
```

Wrong:
```typescript
const normalized = normalizeResult(result);
emit(result, (data) => formatLaunchDecision(data as LaunchDecision));
// Rejected launches never reach formatLaunchDecision() on the error branch.
```
