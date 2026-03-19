# Test _3_step Error Branches Explicitly Before Refactoring handle3Step

## Rule
Most `_3_step` branches in `handle3Step` / `stepBidding` / `stepSpeaking` are only reachable via indirect happy-path scenarios. Error paths like `expected_speech_entry`, `speech_not_done`, `bids_not_complete`, `speech_timeout`, and no-participant endings have no dedicated tests and can silently regress after mechanical extraction. Always add explicit per-branch regression tests before any structural refactor of this handler.

## Why
The wait-based polling and lock-scoped state reloads in `_3_step` mean that small changes in control flow can bypass or short-circuit error paths. Without direct tests, a refactor that appears "mechanical" may silently skip an error return, and the existing suite won't catch it.

## Pattern
```
// Step 3.0 in any handle3Step refactor:
// For each named error/phase outcome (speech_not_done, expected_speech_entry,
// bids_not_complete, speech_timeout, epoch_transition, no_participants):
// 1. Write a test that drives the session to that branch
// 2. Confirm the exact response shape
// 3. THEN extract the function
```
See `server-handlers.test.ts` tests added in the elegance v2 refactor (Step 3.0) for the reference patterns.
