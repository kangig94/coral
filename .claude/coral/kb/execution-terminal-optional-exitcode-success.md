# Successful Terminal Results May Omit `exitCode`
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
When deriving a process exit status from Coral terminal results, do not treat `exitCode === undefined` as failure by default. Successful provider and workflow executions may persist terminal results without any `exitCode`; map explicit integer `0..255` values through, map `aborted === true` to `1`, treat `undefined` on an otherwise successful terminal as `0`, and reserve `1` for explicit invalid values such as `null`, non-integers, or out-of-range codes.
## Why
`TerminalResult.exitCode` is optional, and current successful workflow and Claude execution paths do not set it. A foreground follow command that blindly converts `undefined` to `1` will report failure for successful jobs, creating a contract regression even though the underlying execution completed normally.
## Pattern
Right:
```typescript
function toProcessExitCode(result: TerminalResult): number {
  if (result.aborted) return 1;
  if (result.exitCode === undefined) return 0;
  if (!Number.isInteger(result.exitCode)) return 1;
  if (result.exitCode < 0 || result.exitCode > 255) return 1;
  return result.exitCode;
}
```

Wrong:
```typescript
if (result.exitCode == null) {
  return 1;
}
return result.exitCode;
```
