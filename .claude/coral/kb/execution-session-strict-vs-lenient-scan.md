# Execution Sessions Need Strict Runtime Reads and Separate Lenient Reporting Scans
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
If operational execution code must fail fast on invalid persisted session files but a reporting or indexing surface must still show legacy entries with missing provenance, split the read models. Keep `SessionManager` strict for runtime reads/writes, treat `projectRoot` as backward-compatible on read and required on new writes, and add a separate lenient scan/parser for reporting so legacy records become `legacy_unresolved` instead of being guessed from `cwd` or silently skipped.
## Why
One parser cannot satisfy both requirements cleanly. If you relax `SessionManager`, runtime code starts accepting mixed storage contracts it was meant to reject. If you keep only the strict parser, reporting surfaces hide legacy entries entirely, which looks like missing data rather than unresolved provenance.
## Pattern
Right:
```typescript
// Runtime path: strict
function isValidEntry(value: unknown): value is SessionEntry {
  return typeof v.sessionId === 'string'
    && typeof v.provider === 'string'
    && (typeof v.projectRoot === 'string' || v.projectRoot === null || v.projectRoot === undefined);
}

// Reporting path: lenient
type SessionScanRecord = {
  sessionId: string;
  provider: string;
  projectRoot: string | null;
  provenanceState: 'authoritative' | 'legacy_unresolved';
};
```

Wrong:
```typescript
// One parser for everything
const entry = readEntry(file);
if (!entry) return []; // legacy file disappears from /api/sessions

// Or: guess provenance from cwd/hash when projectRoot is absent
entry.projectRoot = reverseShardHash(shardDir) ?? entry.cwd;
```
