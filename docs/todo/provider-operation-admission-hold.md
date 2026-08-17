# TODO — the coordinator that must refuse to finish starting, and what ends the refusal

**Status**: open, and open *because it was written once and taken back out*. The hold shipped on
`refactor/process-incarnation-token` as commit `0e59ac52`, was rejected by review, and was removed by
`42b8a559`. Nothing about the diagnosis was wrong; what was wrong was shipping the refusal without the
capability that discharges it. This entry carries the whole unit so the next attempt ships it whole.

## The situation the hold answers

A durable `provider_operation_saga.v2:` row names the job a provider saga owns. A row this build cannot
decode still names one — and `attributeUnreadableProviderOperations`
(`src/store/provider-operation-journal.ts`) answers per dimension: the job identity is `known` with
values, or `indeterminate`. `indeterminate` means the row could name **any** job, so generic recovery
may claim none of them: whichever job it terminalizes might be the one that row owns, whose provider
process is still running.

That substrate is on `main` and decides nothing. `snapshotProviderOperationStartupOwnership`
(`src/coordinator/services/recovery/index.ts`) maps `indeterminate` to "contributes no fenced job id",
which is the permissive behaviour that predates the branch — the known gap this entry closes, unchanged
rather than half-changed.

## Why the first attempt was rejected — six findings, one cause

The refusal was represented honestly and then returned through the ordinary success value:
`state.started = true; return serverInfo`. Everything else followed from that.

1. Bootstrap logged "Running on …" and `backend status` printed "Backend ok" for a coordinator that had
   admitted nothing.
2. A hard shutdown then ran `markJobsAsErrorFn` (`src/coordinator/shutdown.ts:398`) and terminalized
   every nonterminal job — **the hold destroyed exactly what it was protecting.**
3. `state.started = true` foreclosed any in-process retry, so the daemon could never reach `running`
   even after the blocker was gone. Only a restart could re-ask, and a restart met the same row.
4. No client could see it: IPC readiness copied coarse `starting` and threw `BackendUnreachableError`,
   launches got `recovering — retry after 500ms` forever, `jobs.wait` bypassed the fence and presented
   as a 590s hang.
5. Nothing ended it. Host eviction (`services/provider-host-administration.ts`) evicts the host, not the
   row, and does not re-ask. Automatic absence retirement scans only *superseded* generations, so a
   malformed **current** row refuses again on every boot, forever. The refusal message's advice —
   restore the build that owns the row — is not a CLI operation, and is simply false when the current
   build owns corrupt bytes.
6. Separately, the repairable-binding quarantine written alongside it released the only owner of a live
   carrier. That half is [`coordinator-process-disposition.md`](./coordinator-process-disposition.md)
   and does not ship here.

## The shape of the fix

Designed by a pioneer pass after the rejection. The load-bearing idea is that a held coordinator is
**alive and reachable while `start()` has not completed** — not a coordinator that completed with a flag
saying it didn't.

### The state

Replace the `LifecycleState` string union (`src/coordinator/lifecycle.ts`) with a discriminated one that
carries the evidence:

```ts
type CoordinatorLifecycle =
  | { phase: 'starting' }
  | { phase: 'kernel-ready' }
  | { phase: 'admission-held'; admission: Extract<ProviderOperationStartupAdmission, { kind: 'refused' }> }
  | { phase: 'running' }
  | { phase: 'draining' }
  | { phase: 'stopped' };
```

`ProviderOperationStartupAdmission = admitted { ownedJobIds } | refused { blockers: { key, revision }[] }`
returns to `src/jobs/startup.ts` and stays the single canonical blocker vocabulary — do not mint a
second lifecycle-local one. The `revision` is the SHA-256 content revision, so an operator coordinate
cannot be replayed against replaced bytes.

`LifecycleController.start()` keeps returning `Promise<CoordinatorServerInfo>` and simply **does not
resolve** until `running`. A shutdown while held ends it by rejection, never by success. Two mechanisms
are then redundant and should be deleted rather than updated:

- `LifecycleControlState.started`,
- the independently mutable launch-fence boolean — launch admission derives from
  `phase === 'running'`, which makes "held, but the fence was released" unrepresentable.

### The exit

Materialize each blocker as an ordinary recovery-quarantine subject, using the table that already
exists: boundary `provider-operation-startup-admission`, key = the row key, revision = the content
revision, detail = why startup is held and the two commands that end it. The shipped v0.10.8 reader
accepts arbitrary `boundary_id` values and ignores `provider_operation_saga.v2:` addresses, so this adds
no rollback-fatal shape (Principle 10 — verify that claim again before relying on it).

- `backend recovery-quarantine clear` — retry the exact `{boundary, key, revision}` after repair. It
  reruns retirement, provider-operation reconciliation, and the admission snapshot **in the same
  process**, which is what finding 3 demands.
- `backend recovery-quarantine abandon` — an explicit operator override, only for boundaries that
  declare abandonment support. For this boundary it transactionally deletes the source row **only if its
  content revision still matches**, deletes the quarantine row, records the override, and signals
  re-admission. It must not be a generic "delete the quarantine row": the registered source owns what
  abandonment does to its authoritative record, and here that includes preserving the abandoned bytes so
  the decision is recoverable and auditable.

Startup becomes: bind and publish `kernel-ready` → attempt admission → if refused, persist the blocker
set, transition to `admission-held`, await a retry signal → on clear/abandon, re-snapshot in-process →
when admitted, finish Era II exactly once and transition to `running`. Emit one structured
`held` / `changed` / `cleared` event from the blocker-set difference — not one warning per scan.

### The call sites that must answer it

Each of these is a finding above, and the compiler should force each one:

| Site | Answer |
| --- | --- |
| `coordinator/bootstrap.ts` | already awaits `start()`, so "Running on …" becomes correct for free |
| `coordinator/composition/index.ts` health | coarse `starting` for old clients; detailed health carries `admission-held` + blockers |
| `transport/server-ports.ts`, `transport/http/backend/health.ts` | one blocker shape, not a second definition |
| `transport/ipc/ensure.ts` | authenticated `admission-held` is **reachable**, not `BackendUnreachableError` |
| `transport/ipc/server.ts`, `transport/http/handler.ts` | exhaustive switch: `running` permits; `admission-held` → `backend_admission_held`; `starting`/`kernel-ready` → `backend_recovering`; `draining`/`stopped` → `backend_shutting_down` |
| `transport/dispatch.ts` launch routes | immediate non-retrying `backend_admission_held` carrying blockers and the exact remediation command — never the 500ms retry |
| `transport/dispatch.ts` `jobs.wait` | reject **before** opening a subscription that cannot progress; `jobs.list`/`jobs.detail` stay readable |
| `transport/http/backend/status.ts` | a public `held` result naming every `key@revision`, printing the clear command and identifying abandon as an override — never "Backend ok" |
| handoff replacement | a held daemon is a live authenticated incumbent eligible for hot handoff; not healthy-ready, not absent |
| `coordinator/shutdown.ts` | see below |

### Held shutdown

Switch on the pre-drain phase. If it was held: do not call `markJobsAsErrorFn`, do not retire, clean,
reconcile, or release claims and fences; stop only resources this incarnation can prove it created and
owns; close IPC last, preserving the existing handoff authority ordering.

There is no honest protected-job exclusion list — an indeterminate row may own *any* job — so held
shutdown skips store-wide terminalization entirely rather than filtering it.

## The proofs, and they are the point

A test nobody watched fail is a test nobody wrote. At minimum:

1. `start()` remains unsettled while a blocker exists, and no barrier, cleanup, completion hook, fence
   release, or "Running" log occurs.
2. One lifecycle test inserts a malformed current-generation row, observes `admission-held`, invokes the
   exact `recovery-quarantine abandon`, and asserts **the same start promise** reaches `running` with
   every completion action executed exactly once.
3. Launch returns `backend_admission_held` with no retry; `jobs.wait` rejects before subscribing;
   `backend status` prints the exact blocker and runnable commands; IPC readiness does not throw.
4. Start held with a nonterminal job, request a hard shutdown, and assert `markJobsAsErrorFn` was never
   called and no job-terminal or claim-release fact was written.

## Explicitly out of scope

Decoding or repairing corrupt provider-operation bytes. Automatic quarantine of unobservable rows,
interpreting foreign record generations, or reading a missing identity as evidence of process absence —
each erases the uncertainty the hold exists to retain.

## What this still will not close

Abandonment is an authority override, not a proof: it cannot establish that no carrier remains, and it
may deliberately orphan external work. It must say so before acting. Already-shipped clients will not
understand `admission-held`; they see coarse `starting` and fail softly, which is the Principle 10
bargain and not an oversight. And while no coordinator is running there is no abort endpoint at all —
the durable records let the next coordinator reconstruct custody, but they do not cover the gap.

## Start condition

The lifecycle state change, the quarantine boundary with both operator commands, the client answers, and
the held-shutdown policy ship as **one** unit. That is the entire lesson of `0e59ac52`: a hold whose
discharge is deferred is not a partial fix, it is a worse defect than the gap it replaced, because
shutdown then destroys the state the hold was protecting.
