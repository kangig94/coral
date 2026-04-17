# Fix Wait-Stream Exact-Deadline Timeout Misclassification

**Diagnosis**: `CORAL_PROJECT/plans/debug-wait-stream-exact-deadline-timeout.md`

## Requirements Summary

Fix `waitForJobs` in `src/execution/job-lifecycle.ts:615-696` so deadline classification is based on terminal persistence time, not only the order in which the loop happens to wake up. A replayed terminal persisted at exactly `timeoutMs` must yield `terminal`; a terminal first persisted after the deadline must still yield `waiting` even if it becomes visible before the next loop body executes.

**Root cause**: the current loop checks `time.now() - startMs >= timeoutMs` **before** reading fresh status and replaying events, so a completion persisted at `t = startMs + timeoutMs` can be missed and reported as `{ type: 'waiting' }`. A pure reorder is still insufficient because real runtime timing is `Date.now()` plus `setTimeout()`: the waiter can wake after the deadline and observe a terminal that actually landed at `t = timeoutMs + 1`. The fix must distinguish completion time from observation time and must not let a same-poll terminal `readStatus()` reread bypass an ineligible replayed terminal.

**Downstream impact**: Discuss bid / speech flows eventually reach the same `waitStreamOnce(timeoutMs)` path exercised at `src/execution/discuss/executor.ts:278-286` and `src/execution/discuss/executor.ts:410-418`. This plan keeps the fix and proof at the service layer; discuss suites are smoke regressions, not the primary boundary proof.

## Acceptance Criteria (testable, verifiable — register each as a Task during implementation)

| # | Criterion | Verification |
|---|-----------|--------------|
| AC1 | A replayed terminal event persisted at `t = timeoutMs - 1` still yields `{ type: 'terminal' }`. | New `service.test.ts` boundary case using the existing real-runtime harness with mocked timing. |
| AC2 | A replayed terminal event persisted at exactly `t = timeoutMs` yields `{ type: 'terminal' }`, even if the waiter wakes and polls slightly after the deadline. | New `service.test.ts` case sets terminal `ts` to the computed deadline and forces the next poll to run after the deadline. |
| AC3 | A job with no terminal evidence on disk at `t = timeoutMs` yields `{ type: 'waiting' }`. | New boundary test keeps `readStatus()` in `running` and `replayFrom()` empty through the deadline. |
| AC4 | A replayed terminal event persisted at `t = timeoutMs + 1` yields `{ type: 'waiting' }`, even if observed on the first post-deadline poll and `readStatus()` is already terminal on that same iteration. | New boundary test forces a late wake, returns a replayed terminal whose `ts` is greater than the deadline, then makes the post-replay `readStatus()` reread terminal on that same poll. |
| AC5 | The status-only fallback path is covered explicitly: if `replayFrom()` is empty and `readStatus()` flips terminal on the final on-time poll, `waitStream()` / `waitStreamOnce()` returns terminal content; if the first terminal observation is post-deadline with no timed event, the waiter stays conservative and yields `waiting`. | Two new `service.test.ts` cases cover the pre-deadline status-only success and the post-deadline conservative timeout path. |
| AC6 | A replayed terminal with missing or invalid `ts` is treated as untimed terminal evidence: emit it only when first observed on or before the deadline; otherwise yield `{ type: 'waiting' }`. | New `service.test.ts` coverage uses `ts: ''` or omitted `ts` with controlled on-time vs post-deadline observation. |
| AC7 | If a post-deadline replayed terminal is skipped and no progress event advances the external cursor, a follow-up wait with the same cursor can replay that terminal and emit `terminal` once it is eligible under the new request deadline. | New two-call service-level test proves skipped late terminals are not lost across requests. |
| AC8 | `waitStreamOnce(jobId, 180000)` with an eligible exact-boundary terminal returns `{ content, nonResumable }`, not throw. | New service-level test plus the existing `timeoutSeconds: 0.001` waiting-case test stays green. |
| AC9 | All existing vitest suites pass (no regression in wait-stream, discuss-manager, lifecycle-recovery, or session tests). | `npm test` clean. |
| AC10 | Build passes clean (`npm run build`): tsc + esbuild with no new warnings. | `npm run build`. |

## Execution Order

### Dependency Graph

```
W1 (Phase A impl: job-lifecycle.ts)
 ├─→ AC1 ─┐
 ├─→ AC2 ─┤
 ├─→ AC3 ─┤
 ├─→ AC4 ─┼─→ AC9 (full test pass) ─→ AC10 (build pass)
 ├─→ AC5 ─┤
 ├─→ AC6 ─┤
 ├─→ AC7 ─┤
 └─→ AC8 ─┘
```

**Note**: W1 (implementation) and AC1-AC8 (test authoring) target different files and can be written in parallel, but the tests must run against the applied implementation to pass — all tests logically depend on W1 being in place.

### Batches

| Batch | ACs / Work | Dependencies | Parallel | Notes |
|-------|-----|--------------|----------|-------|
| 1 | W1 (Phase A impl), AC1-AC8 (Phase B tests) | — | 9 | Different files: W1 touches `job-lifecycle.ts`, AC1-AC8 touch `service.test.ts`. Write together, run tests after W1 applied. |
| 2 | AC9 (full vitest suite) | Batch 1 | 1 | Verification gate. Includes discuss smoke regression per Phase C. |
| 3 | AC10 (`npm run build`) | Batch 2 | 1 | Final gate: tsc + esbuild clean. |

### File Mapping

| AC / Work | Files |
|-----------|-------|
| W1 (Phase A impl) | `src/execution/job-lifecycle.ts` |
| AC1 — replay terminal at `timeoutMs - 1` | `src/execution/__tests__/service.test.ts` |
| AC2 — replay terminal at exactly `timeoutMs` (late wake) | `src/execution/__tests__/service.test.ts` |
| AC3 — still-running at `timeoutMs` | `src/execution/__tests__/service.test.ts` |
| AC4 — replay terminal at `timeoutMs + 1` with same-poll status guard (+ multi-job variant) | `src/execution/__tests__/service.test.ts` |
| AC5 — status-only fallback on-time success + post-deadline conservative timeout | `src/execution/__tests__/service.test.ts` |
| AC6 — invalid/missing `ts` compatibility | `src/execution/__tests__/service.test.ts` |
| AC7 — two-call cursor-resume (skipped late terminal replayable on next request) | `src/execution/__tests__/service.test.ts` |
| AC8 — `waitStreamOnce` exact-boundary returns content | `src/execution/__tests__/service.test.ts` |
| AC9 — full vitest pass (includes discuss smoke) | — (verification only) |
| AC10 — build clean | — (verification only) |

**Conflict check**: W1 and AC1-AC8 are in the same batch. W1 touches only `job-lifecycle.ts`; AC1-AC8 touch only `service.test.ts`. No file collision.

## Mathematical Specification (if applicable)

Define `deadlineMs = startMs + timeoutMs`.

- A replayed terminal event with a parseable `ts` is eligible for emission in the current wait only if `Date.parse(event.ts) <= deadlineMs`.
- A replayed terminal with missing or invalid `ts` is untimed terminal evidence: it is eligible only when first observed while `time.now() <= deadlineMs`; otherwise it is ineligible for the current request.
- If replay returns any terminal record for a job on a poll, that replay result controls terminal eligibility for that poll; the post-replay `readStatus()` fallback must not override an ineligible replayed terminal.
- A status-only terminal fallback is eligible only when the terminal status is first observed while `time.now() <= deadlineMs`.
- If pending jobs remain and no eligible terminal evidence exists once `time.now() > deadlineMs`, the waiter must yield `{ type: 'waiting', waitingJobIds: [...pending] }`.

## Implementation Phases (with file:line references)

### Phase A — Replace pure loop reorder with deadline-aware terminal classification

**Target**: `src/execution/job-lifecycle.ts:604-698` (the `waitForJobs` async generator).

**Current structure (buggy)**:
```ts
while (pending.size > 0) {
  if (this.deps.time.now() - startMs >= timeoutMs) {   // line 616 — fires before read
    yield { type: 'waiting', waitingJobIds: [...pending] };
    return;
  }
  const seq = progressStore.getChangeSeq();
  for (const jobId of [...pending]) {
    // readStatus + replayFrom + yield terminal/progress
  }
  if (pending.size === 0) return;
  const remainingMs = timeoutMs - (this.deps.time.now() - startMs);
  if (remainingMs <= 0) continue;
  await Promise.race([progressStore.waitForChange(seq), this.deps.time.sleep(remainingMs)]);
}
```

**Proposed structure**:
```ts
const deadlineMs = startMs + timeoutMs;

while (pending.size > 0) {
  const seq = progressStore.getChangeSeq();
  for (const jobId of [...pending]) {
    const status = progressStore.readStatus(jobId);
    if (!status) continue;

    let replaySawTerminal = false;
    let replayEmittedTerminal = false;

    const events = progressStore.replayFrom(jobId, fromEventId, fileCursor);
    for (const event of events) {
      fromEventIds[jobId] = event.eventId;

      if (event.type === 'progress') {
        yield progressEvent(jobId, event);
        continue;
      }

      replaySawTerminal = true;
      const parsedTerminalMs = Date.parse(event.ts);
      const replayEligible = Number.isFinite(parsedTerminalMs)
        ? parsedTerminalMs <= deadlineMs
        : this.deps.time.now() <= deadlineMs;

      if (!replayEligible) break;

      yield terminalEvent(jobId, event);
      pending.delete(jobId);
      replayEmittedTerminal = true;
      break;
    }

    if (!pending.has(jobId) || replayEmittedTerminal || replaySawTerminal) {
      continue;
    }

    const currentStatus = progressStore.readStatus(jobId);
    if (currentStatus && isTerminalPhase(currentStatus.phase) && this.deps.time.now() <= deadlineMs) {
      yield terminalEventFromStatus(jobId, currentStatus);
      pending.delete(jobId);
    }
  }
  if (pending.size === 0) return;

  if (this.deps.time.now() > deadlineMs) {
    yield { type: 'waiting', waitingJobIds: [...pending] };
    return;
  }

  const remainingMs = deadlineMs - this.deps.time.now();
  await Promise.race([progressStore.waitForChange(seq), this.deps.time.sleep(remainingMs)]);
}
```

**Pseudocode reading guide**:
- `progressEvent(jobId, event)`, `terminalEvent(jobId, event)`, and `terminalEventFromStatus(jobId, currentStatus)` are illustrative shorthand for the **existing inline yield expressions** at `src/execution/job-lifecycle.ts:649-665` (progress), `src/execution/job-lifecycle.ts:659-665` (replayed terminal with `remainingJobIds` + `resultPath`), and `src/execution/job-lifecycle.ts:673-679` (status-only terminal). Do not extract them into new helper functions — keep the inline yields.
- **Preserved as-is from the current implementation** (not shown in the pseudocode for brevity):
  - `fromEventIds` and `fileCursors` initialization (`job-lifecycle.ts:610-611`).
  - The `emittedQueued` set and queued-phase emission block (`job-lifecycle.ts:612, 632-642`) — insert this between `if (!status) continue;` and the `replayFrom()` call.
  - The `fileCursor = fileCursors.get(jobId)!` lookup and `fromEventId = fromEventIds[jobId] ?? 0` defaulting (`job-lifecycle.ts:624-626`).
  - The `remainingJobIds = jobIds.filter((id) => id !== jobId && pending.has(id))` computation and the `resultPath: progressStore.resultPath(jobId)` field on every yielded terminal event.

**On first-observation semantics for the status-only fallback**: Math Spec (line 42) and the invalid-`ts` replay rule (line 40) both describe eligibility by *first observation time*. The per-poll `this.deps.time.now() <= deadlineMs` check is equivalent in practice: the first poll that observes terminal status either emits (pre-deadline) or the outer guard at the top of the next loop turn yields `waiting` and returns. There is no subsequent poll that could see the same terminal status under a different eligibility verdict. Document this equivalence as a one-line code comment where the status-only fallback lives so future readers do not try to introduce per-jobId first-observation bookkeeping.

**Rationale**:
- Keep the existing replay/status scan, but make terminal emission deadline-aware:
  - For replayed terminal events with a parseable timestamp, compare `Date.parse(event.ts)` to `deadlineMs`. Emit the terminal only when the persisted timestamp is `<= deadlineMs`.
  - For replayed terminal events with `ts > deadlineMs`, do not emit terminal in this request; mark that this poll already saw replayed terminal evidence, keep the job pending, and let the timeout branch return `{ type: 'waiting' }` without allowing the same-poll `readStatus()` reread to bypass that decision.
  - For replayed terminal events with missing or invalid `ts`, use a compatibility rule: treat them as untimed terminal evidence and capture first-observation time when the replayed terminal is encountered on that poll; emit it only when first observed on or before the deadline, otherwise keep the job pending and yield `waiting`.
  - For the status-only fallback (`readStatus()` terminal with no replayed terminal event on that poll), emit terminal only when the terminal status is observed on or before the deadline. If the first terminal observation is after the deadline and there is no eligible replay evidence, stay conservative and time out as `waiting`.
- This keeps AC2/AC4 true under timer lag without requiring a new persisted terminal timestamp on `PersistedStatusRecord`.
- No `/jobs/wait` transport change is required in this plan; the correctness change lives in the generator used by all callers.

### Phase B — Regression tests at boundaries

**Target**: `src/execution/__tests__/service.test.ts` (extend the existing wait-stream tests and adversarial block).

New test cases:

1. **Replay terminal at `timeoutMs - 1` — yields terminal**
   - Mock `readStatus` as `running` until replay returns the terminal event.
   - Mock `replayFrom` to return a terminal event whose `ts` is one millisecond before the computed deadline.
   - Call `service.waitStream({ jobIds: ['job-1'], timeoutSeconds: X })`.
   - Expect exactly one event: `{ type: 'terminal', ... }`.

2. **Replay terminal at exactly `timeoutMs` with a late wake — yields terminal**
   - Force the next loop turn to run after the deadline using `vi.useFakeTimers()` or mocked `time.now()` / `time.sleep()`.
   - Return a replayed terminal event with `ts === deadlineMs`.
   - Expect `{ type: 'terminal' }` despite the delayed observation time.

3. **Still running at `timeoutMs` — yields waiting**
   - Mock `readStatus`: always returns `running`.
   - Mock `replayFrom`: always returns `[]`.
   - Expect exactly one event: `{ type: 'waiting', waitingJobIds: ['job-1'] }`.

4. **Replay terminal at `timeoutMs + 1` with same-poll terminal status — yields waiting**
   - Force a late wake and return a replayed terminal event whose `ts` is greater than `deadlineMs`.
   - Make the post-replay `readStatus()` reread return terminal on that same post-deadline poll.
   - Expect `{ type: 'waiting' }`, proving the timed replay decision cannot be bypassed by the existing status-only fallback branch.
   - **Multi-pending-job variant** (same case, two jobs): run the same scenario with `jobIds: ['job-1', 'job-2']` where `job-1` has the late replayed terminal and `job-2` stays `running` with empty replay. Expect a single `{ type: 'waiting', waitingJobIds: ['job-1', 'job-2'] }` — locks in the `[...pending]` set-union shape asserted by the Math Spec (line 43).

5. **Status-only fallback on the final on-time poll — yields terminal**
   - Mock `replayFrom` as `[]`.
   - Mock `readStatus` to return `running` first, then terminal on the reread before the deadline expires.
   - Assert both `waitStream()` and `waitStreamOnce()` return the terminal result.

6. **Status-only fallback first observed after the deadline — yields waiting**
   - Mock `replayFrom` as `[]`.
   - Force the first terminal `readStatus()` observation to occur after `deadlineMs`.
   - Expect the waiter to stay conservative and emit `{ type: 'waiting' }`.

7. **Replay terminal with missing or invalid `ts` uses the compatibility rule**
   - Return a replayed terminal with `ts: ''` or omitted `ts`.
   - Cover both branches: an on-time first observation emits `terminal`, while a first post-deadline observation yields `{ type: 'waiting' }`.

8. **Skipped late replayed terminal is replayable on the next request**
   - First call: provide a cursor with no terminal delivered yet, force a late wake, return a replayed terminal with `ts > deadlineMs`, and assert the request yields `waiting` without advancing the external cursor.
   - Second call: reuse the **same `cursor: { jobs: { ... } }` input** passed to the first `waitStream()` call (service-layer tests do not exercise the SSE `Last-Event-ID` path directly — cursor preservation is verified by passing the identical input object), give the new request a later deadline, replay the same terminal again, and expect a single `{ type: 'terminal' }`.

9. **`waitStreamOnce` exact-boundary replay terminal returns content**
   - Same replay setup as case 2.
   - Call `service.waitStreamOnce('job-1', timeoutMs)`; expect `{ content: 'done', nonResumable: false }` (no throw).

**Test convention**:
- Follow the existing `service.test.ts` harness (`createRealRuntime()`, spies on `progressStore`, and `vi.useFakeTimers()` where timing must be forced).
- For late-wake cases, drive the async iterator manually: start `iterator.next()`, keep `progressStore.waitForChange()` unresolved, flush microtasks until the first poll is blocked inside `await Promise.race(...)`, then advance fake timers past the deadline before letting the next poll continue.
- Keep the existing adversarial `timeoutSeconds: 0.001` waiting test green as a regression guard for pending-job reporting.

### Phase C — Post-fix downstream smoke regression check

Re-run the failing scenario described in `debug-wait-stream-exact-deadline-timeout.md`'s Reproduction Path via:
- `npx vitest run src/execution/__tests__/discuss-manager-faults.test.ts`
- `npx vitest run src/execution/__tests__/discuss-manager.test.ts`
- `npx vitest run src/execution/__tests__/discuss-manager-speech.test.ts`

These remain smoke checks only: they stub `waitStreamOnce`, so they validate higher-layer compatibility but do not prove the boundary semantics. This plan makes no standalone `/jobs/wait` SSE acceptance claim.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Replay terminals are still classified by observation order instead of persisted time | MEDIUM | HIGH | Compare each replayed terminal `ts` to `deadlineMs` and cover `t-1` / `t` / `t+1` explicitly in Phase B. |
| Same-poll status reread can still bypass an ineligible replayed terminal | HIGH | HIGH | In Phase A, block status-only fallback when replay already produced terminal evidence on that poll; in Phase B, make the `t+1` case return both replayed terminal and terminal status on the same post-deadline iteration. |
| Status-only terminal fallback has no persisted completion timestamp | HIGH | MEDIUM | Keep post-deadline status-only behavior conservative and add explicit pre-deadline + post-deadline fallback tests. |
| Legacy or corrupt replayed terminals may have missing/invalid `ts` | MEDIUM | MEDIUM | Define the compatibility rule for invalid `ts` explicitly and lock it with dedicated `ts: ''` coverage. |
| A skipped late terminal might be lost across requests if cursor semantics are misunderstood | MEDIUM | MEDIUM | Add a two-call cursor-resume test proving external cursor state does not advance when only a skipped late terminal was replayed. |
| Late-wake scenarios are hidden by the test harness | MEDIUM | MEDIUM | Force them with `vi.useFakeTimers()` or mocked `time.now()` / `time.sleep()` in `service.test.ts` rather than relying on implicit runtime timing. |
| Downstream discuss tests could be mistaken for proof of the boundary fix | LOW | MEDIUM | Label them smoke-only and keep all boundary assertions in the service-layer suite. |

## Verification Steps

1. **Unit**: `npx vitest run src/execution/__tests__/service.test.ts` — all wait-stream tests pass including new boundary cases.
2. **Smoke**: `npx vitest run src/execution/__tests__/discuss-manager.test.ts src/execution/__tests__/discuss-manager-speech.test.ts src/execution/__tests__/discuss-manager-faults.test.ts` — discuss paths unaffected.
3. **Full suite**: `npm test` — no regressions across all vitest suites.
4. **Build**: `npm run build` — tsc + esbuild clean.
5. **Review gate**: `Skill(tier-review)` — BLOCKING items pass.
