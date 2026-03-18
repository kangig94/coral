# Execution Session Version Must Be Owned by the Write Path
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
When persisted execution sessions carry a `version`, make `SessionManager.writeEntry()` the single place that increments it and require `version` during validation. New entries can seed `version: 0`, but every persisted write must bump first so allocation, state transitions, and job-claim updates all share the same monotonic contract, while old files without `version` fail fast instead of being migrated.
## Why
If each caller manages `version` separately, one mutating path eventually forgets to bump it and the persisted session contract stops being trustworthy. If validation accepts missing-version files or silently migrates them, the store mixes incompatible record shapes and hides the schema break that downstream code now depends on.
## Pattern
```typescript
// Right: centralize the bump in the persistence boundary
function writeEntry(entry: SessionEntry): void {
  entry.version = (entry.version ?? 0) + 1;
  writeFileSync(path, JSON.stringify(entry, null, 2), 'utf-8');
}

function allocate(...): SessionEntry {
  const entry: SessionEntry = {
    ...,
    version: 0,
  };
  writeEntry(entry);
  return entry; // version is now 1 after the first persisted write
}
```

```typescript
// Wrong: let callers bump ad hoc and accept legacy shapes on read
if (!parsed.version) parsed.version = 1;
entry.version += 1; // only in some call sites
```
