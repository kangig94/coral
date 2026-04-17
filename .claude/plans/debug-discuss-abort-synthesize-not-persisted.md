# Bug Diagnosis: User Abort During Synthesize Window Not Durably Persisted

## Symptom
Aborting a session during the synthesize window (after `session.ended`, before `session.synthesized`) is not durably persisted. The live session detaches, but backend recovery still resumes it after restart.

## Reproduction Path
- **Setup**: Persist a session with one `session.ended` event and no `session.synthesized`.
- **Action**: Attach it live, call `abortDiscussSession()`.
- **Verify**: Run recovery — session is resumed despite the abort.
- **Call chain**:
  - `src/execution/discuss/operations.ts:230` `abortDiscussSession()`
  - → `commitDecision()` → `src/discuss/state-machine.ts:495` `decideEnd()`
  - Because `state.status === 'ended'`, `decideEnd` returns `{ ok: true, value: [] }` (no events)
  - `abortDiscussSession` then only aborts controller + detaches at `src/execution/discuss/operations.ts:246-247`
  - Reducer keeps ended sessions in `controlPhase='synthesize'` (`src/discuss/reducer.ts:247` → line 251 `controlPhase: 'synthesize'`)
  - Recovery `src/execution/discuss/operations.ts:327` calls `readSessionEvents()` + `isAbortEnded()`; with no abort marker, the session is treated as resumable and re-attached at line 337.

## Hypothesis Log
| # | Hypothesis | Evidence | Verdict |
|---|-----------|----------|---------|
| 1 | Hard-shutdown abort persistence is lost on restart | Simulated shutdown persisted `reason:"abort"` and recovery stayed clean | refuted |
| 2 | User abort during synthesize persists an abort marker and prevents recovery | After abort, only the original `session.ended` remained; `recoverPersistedSessionsFromStore()` returned the aborted session | **confirmed** |

## Root Cause
`abortDiscussSession()` relies on `decideEnd()`, but `src/discuss/state-machine.ts:495` intentionally emits no event once `state.status === 'ended'`. For synthesize-window sessions, that means **no abort marker is written**, while recovery still considers `controlPhase='synthesize'` resumable in `src/execution/discuss/operations.ts:313-337`.

Asymmetry: shutdown path has `persistAbortEndForShutdown()` / `persistAbortEndForPersistedShutdownCandidates()` at `operations.ts:250-301`, but the **user-abort** path has no equivalent when the session is already ended.

**Confidence**: HIGH.

## Fix Specification (DESCRIPTIVE ONLY — user directed no fix)
- **Target**: `src/execution/discuss/operations.ts:230` — special-case `ended && controlPhase !== 'idle'` to append an abort marker before detach, reusing `buildAbortEndEventsForShutdown` / `appendRuntimeEvents` from the shutdown-style abort persistence.
- **Affected files**: `src/execution/discuss/operations.ts`, likely `src/execution/discuss/persistence.ts`, and recovery/lifecycle tests.
- **Verification**: `npx vitest run src/execution/__tests__/discuss-manager.test.ts src/execution/__tests__/discuss-manager-lifecycle.test.ts` — expected: abort during synthesize writes `reason:"abort"` and recovery returns no resumed session.
- **Done criteria**: post-abort event log contains an abort end marker; `recoverPersistedSessionsFromStore()` skips that session.
- **Regression risk**: duplicate `session.ended` handling and shutdown/abort parity.

## Status
Finding-only run — no code changes made.
