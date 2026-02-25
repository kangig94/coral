# weightedSample Returns First Zero-Weight Entry When rng() Returns 0

## Rule
`weightedSample(weights, rng)` in `util/rng.ts` has a known edge case: when `rng()` returns exactly `0`, `threshold = 0 * total = 0`, and the first `cumulative >= threshold` check fires at index 0 regardless of whether that entry has zero weight. Do not rely on this function to exclude zero-weight entries when `rng` can return 0.

## Why
`createSeededRng` (Mulberry32) can return 0.0 for certain seed states. When used with `weightedSample([0, 100, 0], rng)`, the caller expects index 1 (the only non-zero weight) but may receive index 0. The red-attacker test `util.test.ts` documents this as actual behavior. The bug is pre-existing (same logic was in `persona-seed.ts` before extraction to `util/rng.ts`).

## Pattern
```typescript
// Actual behavior (documented in util.test.ts):
weightedSample([0, 100, 0], () => 0)  // returns 0, not 1

// Safe usage: only call with arrays where all weights > 0, or guard upstream
const safeWeights = weights.map(w => Math.max(w, Number.EPSILON));
const idx = weightedSample(safeWeights, rng);
```

The fix would change `threshold <= 0` to `threshold < 0` in the loop condition, but this hasn't been applied to preserve existing behavior pending a deliberate decision.
