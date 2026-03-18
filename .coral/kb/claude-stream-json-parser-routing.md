# Claude Stream-JSON Parser: Format Routing and Sentinel

## Rule
When routing between the legacy single-JSON path and the NDJSON stream-json path, discriminate by whether `result` is a non-null object — not by line count or whether the output starts with `{`. A single-line stream-json event (e.g., `{"type":"result","result":"ok",...}`) starts with `{` and has one line, but it must go through the NDJSON path. In the NDJSON parser, only count `result` and `assistant` events as valid lines; structural events (`system`, `rate_limit_event`) must not prevent the parse-failure sentinel from being returned.

## Why
Claude CLI with `--output-format stream-json` can produce a single-event stream in test fixtures (and edge cases like aborted runs or rate-limit failures). If a single-event `{"type":"system",...}` stream goes through the legacy path, the parser returns `{ isError: false, sessionId: 'sess-x' }` instead of the parse-failure sentinel — misleading the executor. Similarly, if the NDJSON `hasValidLine` flag is set by `system` or `rate_limit_event` records, a stream with no `result` or `assistant` events returns a non-error response with empty content, which bypasses the `ClaudeExecParseError` throw in the executor.

## Pattern
```typescript
// Wrong: routing by line count / startsWith
if (lines.length > 1 || (lines.length === 1 && !output.trim().startsWith('{'))) {
  return parseNdjson(lines);
}
// Falls through to legacy path for *all* single-line JSON, including stream-json events

// Right: routing by legacy format indicator (result as object)
if (lines.length > 1) {
  return parseNdjson(lines);
}
if (lines.length === 1) {
  const parsed = JSON.parse(lines[0]);
  if (isRecord(parsed) && isRecord(parsed.result)) {
    // Old format: result is a content-array object → legacy path
    return { response: extractLegacyResponse(parsed), ..., isError: false };
  }
  // Stream-json single event → NDJSON path handles is_error, num_turns, etc.
  return parseNdjson(lines);
}

// Wrong: hasValidLine set for any valid JSON record
hasValidLine = true; // system, rate_limit_event all count → no sentinel for incomplete streams

// Right: only semantically complete events count
if (event.type === 'result' || event.type === 'assistant') hasValidLine = true;
```
