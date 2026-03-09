# Execution Session Shard Open Must Not Re-Hash Stored Hash Dirs
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
When scanning persisted execution session shards, do not reopen a discovered shard directory by passing that directory path back into `new SessionManager(...)`. The constructor hashes its input into `~/.claude/coral/execution/sessions/<hash>`, so feeding it an existing hash-dir path hashes the hash again. Cross-shard recovery needs either raw shard enumeration or an explicit API that opens an existing shard path without re-hashing.
## Why
Orphan recovery and global session sweeps run from on-disk shard directories, not from the original project root string that created them. Reusing the normal constructor on a discovered shard path points at a different directory, so the recovery pass silently fails to clear `activeJobId` even though the target session file exists on disk.
## Pattern
```typescript
// Wrong: discoveredShardPath already points at .../sessions/<hash>
for (const discoveredShardPath of readdirSync(sessionRoot)) {
  const mgr = new SessionManager(discoveredShardPath);
  // hashes "<hash>" again and looks in the wrong place
}
```

```typescript
// Right: either enumerate shard contents directly...
for (const shardDir of enumerateSessionShards(sessionRoot)) {
  for (const entry of readShardEntries(shardDir)) {
    recover(entry);
  }
}

// ...or expose an API that opens the existing shard path verbatim
const mgr = SessionManager.openShard(shardDir);
```
