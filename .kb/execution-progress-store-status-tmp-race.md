# ProgressStore Async And Sync Status Writes Cannot Share One Temp File
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
If `ProgressStore` mixes async non-terminal status writes with sync terminal status writes, those writes cannot target the same `status.json.tmp` path. Each write attempt needs its own temp file or a serialized writer, because a generation check on `rename` alone does not stop an already-started stale write from corrupting the shared temp file.
## Why
When a non-terminal async write is already writing `status.json.tmp` and a terminal sync write fires before it finishes, both writes race on the same temp path. The stale async `rename` may be skipped, but the earlier `writeFile()` can still append or overwrite bytes in the shared temp file before that point. The result is corrupt `status.json` content or a terminal publish that contains concatenated JSON from two phases.
## Pattern
Right:
```typescript
const tmpPath = join(jobDir, `status.${generation}.tmp`);
await writeFile(tmpPath, payload);
if (generation !== currentGeneration(jobId)) return;
await rename(tmpPath, statusPath);
```

```typescript
queueStatusWrite(jobId, async () => {
  writeFileSync(tmpPath, payload);
  renameSync(tmpPath, statusPath);
});
```

Wrong:
```typescript
await writeFile(statusTmpPath, runningJson);
writeFileSync(statusTmpPath, terminalJson);
renameSync(statusTmpPath, statusPath);
```
