# /tmp/coral-jobs/ Is Not Auto-Cleaned

## Rule
`/tmp/coral-jobs/` job result directories are NOT cleaned up automatically by the coral backend. Any code that treats them as ephemeral (assuming they disappear after job completion) will be wrong. Use `fs.stat` mtime for recency filtering since `PersistedStatusRecord` has no creation timestamp field.

## Why
Planning or implementation that assumes job artifacts are temporary will produce bugs — files accumulate indefinitely. The "ephemeral job directory" mental model is incorrect.

## Pattern
```typescript
// Wrong assumption: treat /tmp/coral-jobs/<id>/ as temporary
// Right: filter by mtime when recency matters
const stat = await fs.stat(jobDir);
const ageMs = Date.now() - stat.mtimeMs;
if (ageMs < MAX_AGE_MS) { /* include */ }
```
