# Phased Decider Migrations Need Explicit Caller Cutover
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
When migrating from direct state mutation helpers to deciders + reducer replay, keep compatibility wrappers only until every production caller and test has been moved. After the last caller is gone, delete the wrappers and any wrapper-based tests in the same cleanup pass so the codebase has one authoritative transition path.
## Why
Deleting wrappers too early breaks the tree while callers still depend on the legacy surface. Keeping them after the cutover is also harmful: dead compatibility layers hide the real architecture, keep obsolete tests alive, and make documentation drift toward a path that production no longer uses.
## Pattern
Right:
```typescript
// 1. Search all callers.
const callers = rg("initSession|startBidding|applyBid|resolveWinner", "src docs");

// 2. Move runtime code and tests to deciders + reducer replay.
const snapshot = replayDiscussEvents(decideSessionCreate(input, sessionId, root, input.topic, 1, now));
const next = replayDiscussEvents(
  decideBid(snapshot.state, "alpha", 10, "Thought", sessionId, root, input.topic, 3, now),
  snapshot,
);

// 3. Remove the zero-caller wrapper surface in one cleanup batch.
// export function applyBid(...) { ... }  // deleted
```

Wrong:
```typescript
// Delete wrappers before checking callers.
// Runtime/tests still import applyBid() and startBidding().

// Or leave them around after the migration, keeping dead code and stale docs.
export function applyBid(...) { ... } // zero callers, still documented
```
