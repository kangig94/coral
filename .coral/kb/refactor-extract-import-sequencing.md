# Extract Refactor: Declare Import Chains and Update Tests Immediately

## Rule
When planning a multi-step extract refactor with per-step build/test gates, three things must be explicit in the plan: (1) cross-module dependencies between extracted modules (e.g., `dpp.ts` imports `weightedSample` from `rng.ts` — list this import, don't just list `EPS`), (2) test import updates must happen at the same step as the export move, not at a later consolidation step, and (3) any production callers that still import the moved symbol from the old module path must be updated or the old module must re-export the moved symbol in that same step.

## Why
A plan that lists only top-level exports to move, without tracing which extracted module imports which, will fail compilation at the step boundary. Similarly, `tsc` compiles tests together with source, and runtime callers still depend on the old module surface until they are updated. Moving an export in step 1.1 immediately breaks tests and source imports that still expect the old path, even if those updates are planned for a later consolidation step. Both failures corrupt the per-step verification gate.

## Pattern
```
# WRONG plan — import chain implicit, test updates deferred
Step 1.2: create util/rng.ts — move UINT32_SIZE, drawUInt32, createSeededRng, weightedSample
Step 1.3: create util/dpp.ts — move sampleKDpp, eigendecompose (imports EPS from rng)
          # ← missing: sampleKDpp calls weightedSample, so dpp.ts must import from rng.ts
Step 1.5: update test imports

# RIGHT plan — import chain explicit, tests updated inline
Step 1.2: create util/rng.ts — move UINT32_SIZE, drawUInt32, createSeededRng, weightedSample
          update persona-seed.test.ts: add import { createSeededRng } from '../util/rng.js'
Step 1.3: create util/dpp.ts — move sampleKDpp, eigendecompose
          dpp.ts imports: weightedSample from './rng.js'  ← explicit
          update persona-seed.test.ts: add dpp imports

# ALSO RIGHT — preserve old surface while callers catch up
Step 2.1: move ensureBackend to client/backend-lifecycle.ts
          backend-client.ts: export { ensureBackend } from '../client/backend-lifecycle.js'
          or update every source/test import from backend-client.ts in the same step
```
