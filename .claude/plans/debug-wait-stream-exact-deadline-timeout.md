# Bug Diagnosis: Wait-Stream Exact-Deadline Timeout Misclassification

## Symptom
A provider job that completes **exactly at** the Discuss timeout boundary is reported as timed out instead of completed. Reproduced at both `180000ms` (bid path) and `300000ms` (speech path): `waitStreamOnce()` returned `Wait expired while job still running`.

## Reproduction Path
- **Harness**: Simulation backend with durable fake provider exiting at exactly `180000ms`, then at `300000ms`.
- **Direct wait path**: `ExecutionService.waitStreamOnce(jobId, timeoutMs)`.
- **Discuss impact (inferred from call chain)**:
  - Bid: `src/execution/discuss/subflows.ts:426` → `src/execution/discuss/executor.ts:410` → `waitStreamOnce(180000)`
  - Speech: `src/execution/discuss/subflows.ts:636` → `src/execution/discuss/executor.ts:410` → `waitStreamOnce(300000)`
- **Failure point**: `src/execution/job-lifecycle.ts:615` — timeout gate fires **before** replaying terminal events.
- **Constants verified**: `subflows.ts:47` `BID_ATTEMPT_TIMEOUT_MS = 3*60*1000`; `subflows.ts:48` `SPEECH_TIMEOUT_MS = 5*60*1000`.

## Hypothesis Log
| # | Hypothesis | Evidence | Verdict |
|---|-----------|----------|---------|
| 1 | `MAX_BID_ATTEMPTS=3` is off by one | Simulated malformed bid responses; third attempt succeeded and persisted with `currentAttempt=3` | refuted |
| 2 | Exact-deadline completion is misclassified as timeout | Exact `180000ms` and `300000ms` completions both returned timeout; `180001ms`/`300001ms` also timed out | **confirmed** |

## Root Cause
The timeout gate in `src/execution/job-lifecycle.ts:615` fires before replaying fresh progress/terminal state at `src/execution/job-lifecycle.ts:621`. A terminal event arriving exactly at the deadline is therefore lost to the timeout branch.

This is a lower-layer wait bug that affects Discuss bid and speech because those paths pass `180000`/`300000` into `waitStreamOnce`.

**Confidence**: HIGH.

## Fix Specification (DESCRIPTIVE ONLY — user directed no fix)
- **Target**: `src/execution/job-lifecycle.ts:615` — move the timeout emission until after one final status/event replay pass, or make the deadline check inclusive only after polling current state.
- **Affected files**: `src/execution/job-lifecycle.ts`; tests: `src/execution/__tests__/service.test.ts`, plus a Discuss regression test at 3min/5min boundaries.
- **Verification**: `npx vitest run src/execution/__tests__/service.test.ts src/execution/__tests__/discuss-manager-faults.test.ts` — expected: exact-deadline completions return terminal content; only `> timeout` returns running/timeout.
- **Done criteria**: jobs completing at exactly `180000ms` and `300000ms` no longer throw timeout, while `180001ms` and `300001ms` still do.
- **Regression risk**: wait-stream timeout semantics for generic jobs and SSE polling.

## Status
Finding-only run — no code changes made.
