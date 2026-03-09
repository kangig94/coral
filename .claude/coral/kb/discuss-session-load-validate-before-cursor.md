# Discuss Session Load Validate Before Cursor
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
In `SessionStore.load()`, validate the persisted JSON shape before reading cursor-related fields such as `transcript_rendered` or `transcript.length`. The load path should fail with a path-specific schema error, not with incidental property access failures from malformed state.
## Why
`SessionStore` does two jobs at once during load: it validates domain state and restores persistence metadata into `renderCursors`. If cursor restoration runs first, malformed `state.json` files can throw vague runtime errors while reading `transcript.length`, which hides the real contract violation and makes corrupted session debugging slower.
## Pattern
```typescript
const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown> | null;
if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
  throw new Error(`Invalid discuss state shape in ${fullSessionPath}: expected object`);
}
if (!Array.isArray(raw.transcript)) {
  throw new Error(`Invalid discuss state shape in ${fullSessionPath}: missing transcript`);
}

const stateWithCursor = raw as DiscussState & { transcript_rendered?: number };
this.renderCursors.set(fullSessionPath, stateWithCursor.transcript_rendered ?? stateWithCursor.transcript.length);
```

```typescript
// Wrong: cursor bookkeeping runs before shape validation
const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as DiscussState & { transcript_rendered?: number };
this.renderCursors.set(fullSessionPath, raw.transcript_rendered ?? raw.transcript.length);
```
