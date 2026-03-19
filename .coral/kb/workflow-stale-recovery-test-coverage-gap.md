# Workflow Stale Recovery Tests Use Mocked Provider Calls

## Rule
Do not treat `pipe-executor.ts` stale-recovery logic as a trusted reference algorithm when planning rewrites. The existing stale-recovery tests (`src/workflow/__tests__/handler.test.ts:261-311`) mock `toolCallFn` and return synthetic resumed sessions rather than exercising live provider/session-manager integration. The real provider resume path requires a registered conversation ID in `SessionManager`, which is only set when the original job completes — meaning the lookup source is unproven for jobs still in flight.

## Why
A rewrite that "ports stale recovery directly" from `pipe-executor.ts:424-506` may appear to have test coverage while actually having none for the live path. The gap is invisible from the test file: the mocks make all paths green regardless of whether `SessionManager` actually holds the provider ID at recovery time.

## Pattern
Before citing stale-recovery logic as a reference, verify:
1. Does the test mock `toolCallFn` / `dispatchFn` at the provider boundary?
2. Is there an integration test that runs a real (or realistic) provider job, lets it go stale, and exercises recovery end-to-end?
3. Does `SessionManager` actually hold the provider conversation ID at the point recovery tries to look it up?

If any answer is no, treat the existing implementation as a working approximation, not a verified algorithm.
