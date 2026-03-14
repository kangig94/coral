# CLI Wait Embed Budget Must Use the Final NDJSON Record
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
When gating CLI `wait` embedded terminal content, measure the serialized final NDJSON record `{ cursor, event }` after path-first shaping, not raw result text length and not the internal `WaitStreamEvent` alone. The public record adds wrapper bytes and strips internal `resultPath`, so the size check belongs at the output boundary where the emitted line is fully assembled.
## Why
If the size gate only measures terminal text or the inner event payload, borderline records can be misclassified: the CLI may embed content that pushes the actual emitted line over `MAX_INLINE`, or reject content that would have fit once internal-only fields were removed. Doing the check on the final shaped record also avoids forcing the public path-first shape back into internal `WaitStreamEvent` types.
## Pattern
Right:
```typescript
const record = {
  cursor,
  event: {
    ...pathFirstEventWithoutResultPath,
    result: { ...resultMeta, path: resultPath, content: text },
  },
};

return JSON.stringify(record).length <= MAX_INLINE
  ? record
  : { cursor, event: pathFirstEventWithoutResultPath };
```

Wrong:
```typescript
if (text.length <= MAX_INLINE) {
  return {
    cursor,
    event: { ...event, result: { ...event.result, content: text } },
  };
}
```
