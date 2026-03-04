# Claude CLI Resume JSON Contract Fallback

## Rule
Never assume `claude --output-format json` guarantees JSON on failure paths. In executor code, parse JSON opportunistically and keep a structured fallback that returns exit code plus raw stdout/stderr when parsing fails. For resumable workflows, do not use `--no-session-persistence`, and treat missing `session_id` as explicitly non-resumable.

## Why
Resume flows (`--resume <id>`) can fail with plain-text output even when JSON mode is requested. If code unconditionally calls `JSON.parse(stdout)`, session handling breaks at exactly the point where callers need a recoverable error. Combining this with `--no-session-persistence` silently violates resume continuity requirements.

## Pattern
```typescript
// Wrong
const payload = JSON.parse(stdout);
return { sessionId: payload.session_id };

// Right
const parsed = tryParseJson(stdout);
if (!parsed.ok) {
  return { kind: 'exec_error', exitCode, stdout, stderr };
}
if (!parsed.value.session_id) {
  return { ...parsed.value, notice: 'Session cannot be resumed', non_resumable: true };
}
```
