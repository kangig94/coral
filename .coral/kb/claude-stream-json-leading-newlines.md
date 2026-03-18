# Claude CLI stream-json result field has leading newlines

## Rule
The `result` field in Claude CLI's `stream-json` output can start with `\n\n` before the actual text content. Any `startsWith` checks on the result string must use `.trimStart()` first to handle this.

## Why
Session conversation logs (JSONL) may not show these leading newlines, so testing only against session data gives a false sense of correctness. The actual wire format from `claude -p --output-format stream-json` includes them. Without `.trimStart()`, pattern matching (e.g., detecting `★ Insight` blocks) silently fails in production.

## Pattern
```typescript
// Wrong — misses leading \n\n from real CLI output
if (response.startsWith('`★ Insight')) { ... }

// Right — handles actual wire format
if (response.trimStart().startsWith('`★ Insight')) { ... }
```

Lesson: Always verify against actual `claude -p --output-format stream-json` output, not just session JSONL logs. The two formats carry the same text but differ in whitespace details.
