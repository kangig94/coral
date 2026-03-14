# MCP Tool Result Character Limit — Measure Serialized CallToolResult
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
Claude Code enforces a character limit on MCP tool results (~40–50 K chars, not tokens). When gating inline content embedding, always measure the fully serialized `CallToolResult` body — `JSON.stringify(jsonResult(payload)).length` — not raw content length or plain `JSON.stringify(payload).length`. Use `MAX_INLINE = 30_000` as the safe threshold with headroom below the hard limit.
## Why
Two sources of measurement error cause gate misses:
1. `jsonResult()` calls `JSON.stringify(data, null, 2)` (pretty-printed with 2-space indentation), which adds 20–40 % overhead on deeply nested objects compared to compact JSON. A gate on `JSON.stringify(payload).length` will undercount the real response size.
2. Measuring raw `content.length` ignores the surrounding response envelope (state, jobId, sessionId, path fields).
A 82 K char Codex result that passes a raw-content length check can still trigger a hard overflow error in Claude Code's tool result rendering.
## Pattern
Right:
```typescript
const MAX_INLINE = 30_000; // in src/shared/schemas.ts

function fitsInlineWaitPayload(payload: Record<string, unknown>): boolean {
  return JSON.stringify(jsonResult(payload)).length <= MAX_INLINE;
}

// Gate on the full assembled response envelope
if (text !== undefined && fitsInlineWaitPayload(embeddedPayload)) {
  return jsonResult(embeddedPayload);
}
return jsonResult({ ...responseBase, result: pathFirstResult }); // path only
```

Wrong:
```typescript
// Measures raw content, misses pretty-print overhead and envelope fields
if (content.length <= 30_000) {
  return jsonResult({ ...response, content });
}
```
