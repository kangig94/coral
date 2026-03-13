# CLI Wait Embed Must Read Artifacts Lazily
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
When CLI wait output is path-first by default and only embeds content behind an `--embed`-style flag, do not read workflow artifacts before the embed branch is taken. Build the path-only terminal shape first, return it immediately for the default path mode, and only load `resultPath` when embedded output is actually requested.
## Why
An eager artifact read defeats the point of path-first output: default mode still pays the I/O and memory cost of loading large result files, and it can fail on missing artifacts even though the caller only asked for `result.path`. The bug is easy to hide if tests only inspect emitted JSON and never assert the no-embed branch avoids file reads.
## Pattern
Right:
```typescript
const pathFirstEvent = {
  ...eventMeta,
  result: { ...resultMeta, path: resultPath },
};

if (!embed) {
  return { cursor, event: pathFirstEvent };
}

let text: string | undefined;
if (isWorkflow) {
  try {
    text = readFileSync(resultPath, 'utf8');
  } catch {
    /* path-only fallback */
  }
} else {
  text = rawContent;
}
```

Wrong:
```typescript
const text = isWorkflow ? readFileSync(event.resultPath, 'utf8') : rawContent;

if (!embed) {
  return { cursor, event: pathFirstEvent };
}
```
