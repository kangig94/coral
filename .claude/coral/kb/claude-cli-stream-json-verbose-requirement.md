# Claude CLI stream-json Requires Verbose

## Rule
When invoking Claude CLI in print mode with streaming JSON output, always use `-p --verbose --output-format stream-json` together. Treat this flag trio as atomic.

## Why
`claude -p --output-format stream-json` fails at runtime because print mode requires verbose mode for streaming output. Missing `--verbose` produces a hard CLI error and no parseable output, which breaks executor pipelines that expect NDJSON events.

## Pattern
```bash
# Wrong
claude -p --output-format stream-json

# Right
claude -p --verbose --output-format stream-json
```

```ts
// Parser/event extraction should ignore verbose overhead events.
if (event.type === 'assistant' || event.type === 'result') {
  // extract progress/completion
}
```
