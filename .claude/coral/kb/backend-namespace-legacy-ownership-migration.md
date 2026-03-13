# Backend Namespace Migration Cannot Reconstruct Legacy Ownership
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
When introducing `backendNamespace` to previously global live-job storage, do not claim that upgraded code can infer the original installation owner for pre-migration live records unless persisted state already contains that provenance. If old `status.json` files and session claims lack plugin-root identity, use a bounded compatibility bridge that rewrites missing `backendNamespace` during upgraded recovery/shutdown for the current installation to preserve single-install continuity, and explicitly scope out perfect attribution for already-ambiguous pre-upgrade multi-install state.
## Why
Without persisted provenance, a migration routine cannot distinguish "this live job belongs to the current installation" from "this live job belongs to some other install that used to share the same global backend." Pretending otherwise produces an unsafe plan: strict namespace filtering wedges `activeJobId` claims after upgrade, while heuristic backfills can silently steal or terminate another installation's job. The honest middle path is to preserve the supported single-install upgrade path and document the boundary where prior global-state ambiguity cannot be undone.
## Pattern
Right:
```ts
function rewriteLegacyLiveJobForUpgrade(status: LegacyLiveStatus, namespace: string): PersistedStatusRecord {
  return {
    ...status,
    backendNamespace: namespace,
  };
}

// Recovery/shutdown path:
// 1. Detect live status missing backendNamespace.
// 2. Rewrite it once for the current installation.
// 3. Apply strict namespace filtering after the rewrite.
// 4. Document that this preserves single-install upgrades, not ambiguous historical multi-install ownership.
```

Wrong:
```ts
// Either strand every pre-upgrade live job...
if (status.backendNamespace !== namespace) return;

// ...or pretend projectRoot/sessionId is enough to identify the old owner.
status.backendNamespace = guessNamespaceFromProjectRoot(status.projectRoot);
```
