# Work and design records

An entry records work that is **not implemented** and why — a gap, or a design worked out but not built.

The test for keeping an entry is implementation, not a label:

- **Implemented — delete it.** The code is the record. Reasoning that outlives the entry moves to
  `docs/design-rationale.md` or to a principle in `.claude/rules/design-philosophy.md` first.
- **A design not yet built — keep it.** The work is still owed, so the entry is still the record of it.
- **Partly implemented — rewrite it down to what is left.** Delete the half that shipped, including the
  symptom that opened it, and keep only the part still owed, stated as what it is now rather than as
  history. An entry whose text is mostly what was already done is an implemented entry with a tail.

Grouped by the concept whose absence produced the members — not by which command or file they touch.
Two entries that look alike often need opposite fixes, and two that look unrelated often close together.

Rewritten 2026-08-15 after a consolidation pass found eleven entries had drifted into fragments: two
asserted opposite facts about one directory, one had scoped its own reported symptom out of bounds, one
was built on a cause that had been inferred rather than reproduced, and a live defect was buried inside
a document about an unplanned feature.

**Re-verified against source the same day**, every claim and every symbol-and-path citation. The rewrite had fixed
how these documents were organised without checking what they asserted. Four entries were wrong in ways
that would have produced a wrong fix — a defect enumerated at one call site that exists at three, a
sibling of the same defect one file away, a prescription for a field that no longer crosses the wire,
and a dismissed constraint that was true of a different directory. Each carries the correction in place
rather than an edited-clean text, because the corrections are the part that does not re-derive.

Re-reconciled the entries against source on 2026-09-24 after #381–#386.

---

## What to pick up first

Added 2026-08-17, when seven entries arrived at once and the index could say what each one was but not
which could be started. The sections below group by the **cause** an entry shares with its neighbours;
this one ordered by **what has to be true before it can be worked**, until the re-ordering below replaced
that axis. An entry appears here only if that ordering is not obvious from its own start condition.

**Re-ordered 2026-09-01, from what a release needs.** The previous ordering asked what has to be true
before an entry can be worked, and kept the suite load first because no gate result is trustworthy while it
can starve the live coordinator. That is still true and is still the reason the load matters — but the suite
entry is half closed and its remainder wants an observed flake, so it cannot lead. What that re-ordering
put first was what 0.10.10 cannot ship without, followed by what the 0.10.9..main diff has made cheap
while that code is still warm.

**The compatibility policy is decided, 2026-09-12, and is no longer an entry here.** A durable record is
additive-only and its reader tolerates unknown keys; a shape that cannot stay additive becomes a new
generation at a new address. The output direction — a live session holding old skill text against a new CLI
— will not be defended, because restarting or resuming the session replaces that text and a model recovers
from an unexpected result on its own. Both halves live in
[`design-philosophy`](../../.claude/rules/design-philosophy.md) §10; the entries below consume them rather
than wait on them. The decision leaves one constraint in its place: a CLI surface may not be changed so
that a stale reader's existing expectation silently becomes wrong.

**What the compatibility decision left behind.** `build-identity-and-upgrade` asks for enforcement of
additive-only durable records, not a policy choice. `jobs-read-contract-schema-first` and
`result-artifact-availability` consume that rule. `cli-machine-channel` must give `wait` a new result
shape that an old skill cannot silently misread; the output direction will not be defended.

**Relationships that matter before starting.** `legacy-v1-capsule-retirement` and
`foreign-capsule-retirement-terminal-recovery`
are the two halves G3 left open and they do **not** close together: one is an evidence problem, where no
observation this build can take retires anything, and the other a durability problem, where a retirement
already happened on decisive evidence and left no proof of itself.
`provider-operation-admission-hold` now concerns indeterminate job attribution after the
`provider-operation-unreadable` boundary and revision-checked discard path shipped. Its unattended exit
has to be re-decided under principle 12. It and `coordinator-process-disposition` are adjacent, not joint.
`darwin-signal-authority` does **not** close with
`kb-daemon-independent-containment` or `wedged-coordinator-self-drain`: it is about the authority to
signal a correctly identified target, they are about there being no party left to signal at all.

**What the 0.10.9..main diff made cheap at the time.** Twenty-one commits across 315 files, dominated by a new
handoff-routing subsystem, a provable build identity, the coordinator socket address, the file-mode
discipline under a shared root, and two comment sweeps. Entries sitting on that code were cheapest then:
the comment ledger because the sweep that filled it had just landed, and `exec-result-overclaim` because both its members were found in the
branch that became the build-identity work.

**One suspicion, checked and dismissed, so nobody re-derives it.** `src/store/schema.sql` gained
`projection_jobs.work_dir` and a `CHECK` constraint since 0.10.9, and the store format fingerprint is a hash
over the DDL, so 0.10.10 ships a new store format. That is not a principle-10 problem: `v0.10.9` already
carries `newer-incompatible` and `current-selection-newer-store`, so an older build meeting the newer store
refuses to open it rather than failing on the constraint. The compatibility policy was worth settling for
other reasons, and was; the schema change was never the one.

**Re-ranked 2026-09-24 by end-user severity, then by the size of the first safe change.** The older
release and code-warmth ordering above remains the record of why the previous table was chosen.

| Order | Entry | Why here |
| --- | --- | --- |
| 1 | `store-epoch-replaced-on-undeterminable-open` (member 2) | `reapPostReadyStoreEpochEntries` in `src/store/epoch.ts` can delete an older epoch with running jobs. Check for live rows before reaping; this member can ship without the persistent-unknown design. |
| 2 | `unauthorized-status-remedy-cannot-act` | `formatDaemonStatus` in `src/cli/format/backend.ts` prints `backend shutdown` for a token mismatch, although that command is rejected. First stop offering a known failing remedy; then decide a proven, unattended way to act. |
| 3 | `local-app-server-stream-has-no-inactivity-bound` | A stalled Codex/local stream can hold a launch permit indefinitely. Instrument the idle case and choose a provider-safe inactivity disposition. |
| 4 | `provider-operation-startup-reconciliation-unbounded` | `awaitStartup` in `src/coordinator/services/provider-operation-reconciler.ts` has no elapsed-time bound, so one unsettled recovery can keep the whole coordinator in `starting`. Give expiry a retry owner. |
| 5 | `coordinator-process-disposition` | `RecoveryRegistry.abort` in `src/jobs/reconcile/registry.ts` can release custody before process absence. Audit runtime-bearing terminal paths and retain custody until absence or transfer is proved. |
| 6 | `hook-unit-tests-reach-the-real-coral-home` | `runHook` in `tests/unit/hooks/_helpers.ts` inherits the developer's `HOME`; a test spawn can reach a live coordinator. Isolate the fixture home. |

**Not yet, and why it is not laziness.** `wedged-coordinator-self-drain` **was observed on 2026-08-23** and
its start condition is met — a coordinator held in uninterruptible sleep on an ext4 journal commit, long
enough that a provider control lease lapsed and the reaper terminated healthy jobs. The cause is a third one
neither half of that entry was designed against, so what it now asks for is which half the observed cause
argues for, not another reproduction. `proxy-set-acquisition`'s clock-drift symptom
closed with #324, the same fix that closed the coordinator's own paths; what is left is a narrower
identity-check decision and acquisition/refusal status reporting, not a reproduction. `cli-terminal-width-layout` and `export-lifetime` wait on
product decisions, not on code.
`legacy-v1-capsule-retirement` is absent for a reason the table cannot express: its remaining members are
capsules no observation this build can take will decide, so its first step is a decision about what may end a
hold when no evidence will — not a step in code.
`project-source-undecidable` waits on a different kind of trigger: its lifetime-durable half is already fixed,
and the rest is a port-shape decision that would be the first of its kind, so it wants either a report of a
misfiled memo, or a discuss continuation that stopped matching its source, or a general ruling on dispositions
in `RuntimePaths`.
`run-directory-residue` now holds only the unbound provider-socket observation. Its separate test-shaped
backend-spawn symptom is explained by `hook-unit-tests-reach-the-real-coral-home`; attribution of the
provider-socket lifecycle remains open.

---

## Build identity — one build's records read by another

|                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`build-identity-and-upgrade.md`](./build-identity-and-upgrade.md) | **Installed-to-installed takeover shipped in #386 (issue #385); the output direction is a deliberate non-goal.** What remains is enforcement that durable records are additive-only and unknown-key tolerant for mixed-build readers. The historical single-build continuity correction stays in the entry. |
| [`quarantine-terminal-without-session.md`](./quarantine-terminal-without-session.md) | The counted rows are from the retired flat store, not the active epoch. Automatic re-evaluation of stale quarantine rows is absent; `LifecycleReactor.enforceRetention` in `src/sessions/lifecycle-reactor.ts` still retries a changed-login binding refusal. Per-row operator clear is not an unattended exit under principle 12. |
| [`legacy-v1-capsule-retirement.md`](./legacy-v1-capsule-retirement.md) | V1, recycled-pid V2 and persistently unknown observations still cannot prove absence. The proposed operator-command exit is withdrawn by principle 12; decide another exit or an explicit bounded-residue policy. |
| [`foreign-capsule-retirement-terminal-recovery.md`](./foreign-capsule-retirement-terminal-recovery.md) | A crash-exact retirement receipt remains unbuilt; G3 instead keeps bounded, non-capacity-consuming residue for a later boot to rescan. The registry now has thirteen boundaries including `provider-operation-unreadable`; a capsule boundary would be a separate addition. Admission-hold's operator clear is no longer a settled unattended exit. |
| [`no-store-migration-path.md`](./no-store-migration-path.md) | An incompatible epoch still starts a successor without carrying rows forward. Retention is not migration, and `reapPostReadyStoreEpochEntries` in `src/store/epoch.ts` can delete an older epoch with running rows; see `store-epoch-replaced-on-undeterminable-open`. |
| [`store-format-routing.md`](./store-format-routing.md) | **Dormant:** fingerprint-keyed multi-format routing remains unbuilt. Its flat `formats/<fingerprint>/store.db` layout predates write-once epochs and needs redesign. `routeOrOpenBackendStoreAtStartup` in `src/store/startup-store-routing.ts` owns startup routing, the pre-compact hook uses `resolveCurrentStoreDbPath` in `clients/hooks/lib/store-epoch.mjs`, and `recovery_quarantine` is already in the current format. |

The two capsule rows are what G3 left open, and they are not one entry. `legacy-v1-capsule-retirement` is an
evidence problem — nothing observable retires those capsules — and
`foreign-capsule-retirement-terminal-recovery` is a durability problem about a retirement that already happened
on decisive evidence. Fixing either leaves the other untouched, and neither blocks the other. The
terminal-recovery entry could use a registry shape introduced by another recovery boundary, but its
receipt is a separate decision. Admission-hold's operator clear is no longer an unattended exit under
principle 12.

`build-identity`'s first half — a record this build cannot parse must not become a job this build
destroys — shipped as #316. Installed-to-installed takeover shipped as #386. What remains is the
**record** direction: enforcing the settled additive-only policy shared with
[`jobs-read-contract-schema-first.md`](./jobs-read-contract-schema-first.md) and
[`result-artifact-availability.md`](./result-artifact-availability.md). The **output** direction — a live
session holding old skill text driving a new CLI — is closed as a deliberate non-goal: resuming the session
replaces that text and a model recovers from an unexpected result on its own. What it leaves is a rule the
`wait` change below has to satisfy rather than wait out.

Read its status block before citing it. The document has now been wrong **three times** about this
subject — a cause inferred from a bundle-string diff, a trigger declared missing that fires every
session, and a mixed window called "permitted by design" — so its corrections are kept in place.

---

## Store-epoch mutation edges

| | |
| --- | --- |
| [`partially-erased-store-epoch-reaping-residue.md`](./partially-erased-store-epoch-reaping-residue.md) | A partially erased `.reaping-<uuid>` directory without its lock cannot be recursively removed under the current ownership proof. It shares a missing pre-lock fence with `store-epoch-minting-under-sustained-external-interference`, but needs a distinct reclamation outcome. |
| [`store-epoch-minting-under-sustained-external-interference.md`](./store-epoch-minting-under-sustained-external-interference.md) | Repeated external removal can still starve minting before a writer has an artifact to lock. It shares the pre-lock ownership gap with `partially-erased-store-epoch-reaping-residue`, but concerns writer progress. |
| [`write-atomic-durable-sync-result-overloads-two-dispositions.md`](./write-atomic-durable-sync-result-overloads-two-dispositions.md) | `writeAtomicDurableSyncNode` returns one `false` for a lost private-artifact race and for a post-rename directory-sync failure. Replace the boolean with dispositions without turning unproven durability into a retry. This shares the result-shape class with the ProcessPort and provider-operation last-error entries. |
| [`store-epoch-replaced-on-undeterminable-open.md`](./store-epoch-replaced-on-undeterminable-open.md) | Transient failures to open or observe an epoch get a bounded window, but a persistent unknown still replaces it and abandons its `running` jobs. Member 2 can ship alone: `reapPostReadyStoreEpochEntries` in `src/store/epoch.ts` must not delete an older epoch with live rows. Member 1 still needs a boot-safe design; member 3 needs rejection causes. |

The first two share a missing pre-lock fence but need different outcomes: reclamation of residue whose
lock is gone and writer progress before its first artifact. The third changes the storage-port result
every caller consumes.
The fourth is a decision about when opening may give up on an epoch it cannot prove unopenable, and it owns
none of the others' mechanisms.

---

## The CLI has no machine channel

|                                                                  |                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`cli-machine-channel.md`](./cli-machine-channel.md) | `wait` and `jobs` still need a machine channel. The settled always-zero `wait` exit-code plan conflicts with principle 10 because old skills branch on the current integer; a new shape must make stale readers fail to read rather than silently misread. The `jobs` half still needs a product decision. |
| [`cli-terminal-width-layout.md`](./cli-terminal-width-layout.md) | A **third** thing, and it must not join either. Width work rewrites the rows a contract fixture exists to freeze.                                                                                                                                                                                 |

The `wait` change needs a new machine-readable shape that an old skill cannot silently misread. A session
still holding the old skill's text would read a new always-zero exit as job success; the output direction
will not be defended, so that exit-code plan cannot ship as written.

---

## Provider proxy

|                                                                                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`proxy-set-acquisition.md`](./proxy-set-acquisition.md) | The cached-clock start-time mismatch shipped fixed in #324. A failed lease can reacquire on a later `acquireHostLease` call. Open work is the identity-check design and publishing acquisition/refusal state through backend status. |
| [`provider-operation-shutdown-quiescence.md`](./provider-operation-shutdown-quiescence.md) | The shared `ProviderOperationMutationAdmission` gate in `src/store/provider-operation-journal.ts` and shutdown drain shipped. The remaining proof is a regression holding disappearance delivery open across stop, including an exhausted drain budget, plus an ordering audit when provider recovery is held and admission close is deferred. |
| [`provider-operation-startup-reconciliation-unbounded.md`](./provider-operation-startup-reconciliation-unbounded.md) | **The #380 deadlock is fixed; the unbounded wait it exposed is not.** Startup reconciliation is bounded only by the shutdown abort signal, so any wait inside it that never settles leaves the coordinator in `starting` with no component and no exit. Needs a bound whose expiry becomes a startup incident with a named successor, and a startup test that a store holding an orphaned provider-operation record still reaches `running`. |
| [`set-fence-closers-can-wait-on-each-other.md`](./set-fence-closers-can-wait-on-each-other.md) | **Found verifying #380; reachability undetermined.** Each `closeSet` excludes only its own admission chain, so two chains closing one set and awaiting their fences wait on each other. The whole-admission `close()` can likewise wait on its caller. Breaking the cycle by excluding the other closer would let containment proof race a live mutator, so it needs a protocol, not a wider exclusion. |
| [`provider-operation-admission-hold.md`](./provider-operation-admission-hold.md) | Known unreadable rows already have quarantine and revision-checked discard. Indeterminate job attribution still fences no job and needs a held startup phase. Principle 12 withdraws operator clear as its required exit; decide an unattended successor before shipping the phase, client answers, held shutdown and in-process recheck together. |
| [`local-app-server-stream-has-no-inactivity-bound.md`](./local-app-server-stream-has-no-inactivity-bound.md) | **Open, likely cause of the usage-limit incident.** Codex/local app-server initialization is bounded, but stream consumption has no inactivity deadline and can hold a launch permit indefinitely. Claude's app-server recovery and the durable-CLI timeout do not bound this path. Reproduce or instrument inactivity before choosing a provider-safe disposition. |
| [`provider-proxy-persistent-challenge-mismatch.md`](./provider-proxy-persistent-challenge-mismatch.md) | Repeated current-tenancy challenge mismatches are answers, not silence, but a faulty peer could answer forever without accepting an echo. Give that distinct subject a bounded disposition if it becomes reachable against a correct endpoint. |

[`provider-operation-startup-reconciliation-unbounded`](./provider-operation-startup-reconciliation-unbounded.md),
[`set-fence-closers-can-wait-on-each-other`](./set-fence-closers-can-wait-on-each-other.md), and
[`starting-coordinator-has-no-exit-contribution`](./starting-coordinator-has-no-exit-contribution.md)
are one stuck-starting family: the first needs a bounded
successor, the second can supply a stuck fence, and the third is the CLI answer while startup is held.

---

## Containment that outlives its enforcer

|                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`kb-daemon-independent-containment.md`](./kb-daemon-independent-containment.md) | The KB daemon's terminal window works only while its own event loop turns, parent escalation dies with the coordinator, and detached descendants have no recorded containment. Give the daemon and the children it launches one independently enforced lifetime, then prove it with a process-level test. |
| [`darwin-signal-authority.md`](./darwin-signal-authority.md) | Provider-host admission supports Darwin; record-only signalling remains fail-closed. The remaining cheap partial is to verify whether `ps` honours `TZ=UTC` and, if so, use it to remove the scheduled DST alias. That does not solve NTP or one-second collisions. |
| [`coordinator-process-disposition.md`](./coordinator-process-disposition.md) | `registerRunningRecovery` in `src/coordinator/services/recovery/actions.ts` now reaps a durable carrier before binding-fault settlement or keeps registry custody on a hold. `RecoveryRegistry.abort` in `src/jobs/reconcile/registry.ts` still removes accepted-abort custody before absence, and other runtime-bearing terminalization paths lack a general process-disposition obligation. |
| [`wedged-coordinator-self-drain.md`](./wedged-coordinator-self-drain.md)         | Every self-termination path Coral has is scheduled by the process it is meant to end. The 6h idle drain is tidiness for a healthy daemon, not a liveness backstop — reading it as one is what produced this entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [`project-source-undecidable.md`](./project-source-undecidable.md)               | **Lifetime-durable half closed 2026-08-18; a per-interval identity flip remains.** `resolveProjectSource` returns one `string` for "no git remote" and "the probe could not be run", and `projectData` derives a KB memo directory from it — so a call made while a mount is stalled files a memo where later reads do not look. Only an answered probe is cached now; an unanswered one is held with an expiry, so a recovered system self-heals — and one root can therefore resolve two different ways inside one process, which `discuss/shell/recovery.ts` persists as `sourceId` and then rejects the row over. Closing it means a disposition in a port return type every consumer assumes always has a value. |

`darwin-signal-authority` records the platform boundary for identity-safe teardown.
`kb-daemon-independent-containment` and `wedged-coordinator-self-drain` are about there being **no party left**
to signal at all, so a fix for either still has to satisfy that authority rule. The KB daemon has a supervising
parent that can accept custody; a wedged coordinator is the top of the tree, so its answer leaves the codebase.
[`coordinator-process-disposition`](./coordinator-process-disposition.md) and
[`abort-answered-by-the-registry-not-the-saga-row`](./abort-answered-by-the-registry-not-the-saga-row.md) share registry
abort custody: an accepted stop cannot release the last owner before process absence or verified transfer.

**Do not merge this with shutdown quiescence**, however alike the one-sentence summaries read. One is a
process-lifetime guarantee whose whole premise is that the closer may already be dead; the other
requires closing synchronously and then draining what acquired before the close. A shared primitive
would have to satisfy both, and their requirements are opposites.

---

## What a shutdown leaves behind

Added 2026-09-17 from PR #363, which made a drain end by itself: the coordinator releases what it holds and
exits, and everything it leaves is owned by a durable successor or named as lost in one record. The
entries are what that change could see from where it stood and deliberately did not do. They share the
premise — nobody is watching, so the process's own exit is the only exit — and not a fix. The remaining work
separates exit-path stalls, cross-successor recurrence, pre-sequence drain gating, generic hold liveness,
wire refusals, terminal classification, test isolation, durable abandonment, and work admitted after a
session abort.

|                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`unauthorized-status-remedy-cannot-act.md`](./unauthorized-status-remedy-cannot-act.md) | **The token-mismatch remedy prints a command the coordinator rejects.** `formatDaemonStatus` in `src/cli/format/backend.ts` tells the reader to run `backend shutdown`; `classifyShutdownResponse` in `src/transport/http/backend/shutdown.ts` rejects the resulting 401 as `capability_rejected`. Retrying a mutating command cannot authenticate or replace that coordinator either. Decide a proven unattended remedy; until then, print no command known to fail. |
| [`discovery-withdrawal-is-unbounded-on-the-exit-path.md`](./discovery-withdrawal-is-unbounded-on-the-exit-path.md)           | **A stated exception with no home until now.** The synchronous finalizer's last act is a `readFileSync` and an `unlinkSync` on the discovery record, uninterruptible from inside the process. A helper process was designed and rejected because the unguarded withdrawal one line later shares the journal. The decision underneath is whether the record is withdrawn by its writer or expired by its next reader, as the socket already is.               |
| [`reproducible-fatal-successor-loop.md`](./reproducible-fatal-successor-loop.md)                                             | **Inherited and bounded, cheaper than it was.** A guardian answering out of contract produces the same fatal in every successor that redeems its capsule, until the enforcers observe the holder absent and reap the set. Under hard mode each iteration also reaped every healthy set; under handoff it costs the bad set and one CLI invocation. Ending it earlier means retiring on evidence the fatal says cannot be interpreted.                       |
| [`settlement-hold-fallback-can-lose-retry-wakeup.md`](./settlement-hold-fallback-can-lose-retry-wakeup.md)                   | **The generic hold gap.** Make the settlement ledger's fallback retry keep the process alive or require every boundary to supply a guarded `retryAfter`; the fixed slot deadline does not decide the fallback sleep's unref behavior. |
| [`explicit-drain-waits-behind-inflight-gate.md`](./explicit-drain-waits-behind-inflight-gate.md) | **An unbounded unary gate before the shutdown ledger.** The gate is the only thing keeping the transport answerable because listener close starts before the bounded in-flight obligation. Reorder that close or decide that an explicit drain stops answering immediately. |
| [`ensure-waits-less-than-the-drain-it-waits-for.md`](./ensure-waits-less-than-the-drain-it-waits-for.md)                     | **Split from Track B by owner decision.** `waitForSocketRelease` spends 30 s while the production handoff drain's measured scheduled boundary is 60,100 ms, but consuming the reported bound as a deadline is still wrong: a failed retry continuation can leave the socket held after the bound reaches zero. Design the wait around observed address turnover, with the self-drain question explicit. |
| [`a-lifecycle-refusal-rides-a-success-envelope.md`](./a-lifecycle-refusal-rides-a-success-envelope.md) | **Older than the branch that named it.** A request refused for a draining lifecycle is answered as a JSON-RPC success whose body carries the refusal; only a client that tests the body sees it. `main` did this at two sites, and the drain branch gave it one home and a tolerant matcher rather than changing it. Moving to an error envelope is a decision every released CLI meets. |
| [`provider-operation-terminalization-failure-classification.md`](./provider-operation-terminalization-failure-classification.md) | **Filed, not implemented here.** The existing terminalization catch can preserve three observable answers: journal corruption, a store refusal carrying `errcode`, and a terminal this build's own validators reject. `withImmediate` already exposes entry lock refusal because `BEGIN IMMEDIATE` is outside its `try`; `validateJobTerminalOrder` is the reachable deterministic member, and `local-recovery-pending` is its already-named successor. |
| [`hook-unit-tests-reach-the-real-coral-home.md`](./hook-unit-tests-reach-the-real-coral-home.md) | **`npm test` is not side-effect-free here.** `runHook` copies `process.env` and deletes six variables but not `HOME`, so hook fixtures spawn backends against the developer's own `~/.coral`; 108 of their `MODULE_NOT_FOUND` crashes were found in the live coordinator's log. The crashes are harmless — the spawn that does not crash is the hazard. |
| [`representation-release-notice-as-a-durable-phase.md`](./representation-release-notice-as-a-durable-phase.md) | Abandonment remains a durable-decision design; disappearance is re-observed. Generation 3 shipped in v0.10.10 through v0.10.13, so a new `controlIntent` kind requires generation 4 at a new address under principle 10. |
| [`agent-attempts-ignore-the-session-abort.md`](./agent-attempts-ignore-the-session-abort.md) | **Bounded by the same round's fix, which is why it is an entry.** `executeAgentAttempt` never reads the live controller's signal — the module contains no `aborted` at all — and an abort does not remove the snapshot its guards test, so a drain still buys one job launch per session whose result `commitDecision` then refuses. Where the check belongs is the decision: the function takes a session id, not a controller, and its existing snapshot guard already answers a different disposition through the same value. |

[`discovery-withdrawal-is-unbounded-on-the-exit-path`](./discovery-withdrawal-is-unbounded-on-the-exit-path.md),
[`ensure-waits-less-than-the-drain-it-waits-for`](./ensure-waits-less-than-the-drain-it-waits-for.md), and
[`explicit-drain-waits-behind-inflight-gate`](./explicit-drain-waits-behind-inflight-gate.md) share the
decision about who may end a coordinator that cannot end itself with
[`wedged-coordinator-self-drain`](./wedged-coordinator-self-drain.md). If withdrawal moves to reader
expiry, use the shared stale-record reader in
[`missing-discovery-record-disposition`](./missing-discovery-record-disposition.md). The capsule-retirement
entries ask the related question of what may retire a capsule when no observation decides.

The pre-sequence in-flight gate and the generic settlement fallback are separate liveness gaps. The former
exists before a ledger is created and needs an owner decision about cutting off requests; the latter is a
ledger fallback no current production boundary selects. Neither changes the split follow-up's requirement to
wait for observed address turnover rather than a reported deadline.

---

## A probe's answer is read for more than it established

Added 2026-08-19 from a PR-gate review. Both are about the distance between what a command established and
what its result is taken to mean — not about a missing observation, but about an existing one being spent on
a question it does not answer.

|                                                                                                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`exec-result-overclaim.md`](./exec-result-overclaim.md)                                                 | **Two members, both with a correct sibling beside them.** `probeIsGitRepo` caches `git rev-parse`'s exit 128 as a durable "not a work tree", though 128 is also dubious ownership and a corrupt `.git` — while `probeIsGitSyncEnabled`, ten lines down, refuses that exact inference in a comment that measured it. And the sync exec port stamps its own timeout code on every signal death, so `classifyExecOutcome`'s branch for a foreign signal is unreachable from that port. Member 1 needs a judgement; member 2 does not.                                          |
| [`missing-discovery-record-disposition.md`](./missing-discovery-record-disposition.md)                   | **Half closed; the disagreement it exposed is the remainder.** `backend status` and `backend shutdown` stopped calling a missing record an absence; `coral-cli expansion` still renders `unavailable` for the same evidence, so during a coordinator's boot window two commands say the state is unknown and a third says positively that nothing is equipped. The decision underneath is whether that observation should dial the socket rather than `existsSync` it — which would make most of these observed answers, at the cost of a round trip on a pre-command path. |
| [`terminal-export-keeps-its-own-describer-map.md`](./terminal-export-keeps-its-own-describer-map.md)     | **The diagnosis exists and the exported artifact drops it.** Two failed jobs both exported `Failed: job.progress.emitted` — an event type where the reason belongs — while `wait` rendered the real sentence. `describeKnownEvent` (`src/jobs/terminal/export.ts`) is a second, hand-written describer map covering three event types with `return event.type` for the rest, beside the composed `defaultEventDescribers` the architecture designates as the single home. Adding the missing case is the option that looks smallest and preserves the shape; the real question is layering, since `jobs/` may not reach up into `read-model/`. |
| [`startup-error-sentinel-single-slot.md`](./startup-error-sentinel-single-slot.md)                       | **The startup error crosses the child boundary, but concurrent attempts share one destination.** Every child atomically renames its attempt-tagged temporary sentinel onto the same `startup-error.json`; a current-attempt parent accepts only its own attempt id after shared identity and time-window checks. Two CLIs can spawn together, so the later child's sentinel can replace the earlier one's before that parent reads it. The existing-starting reader compares pid only when it observed one; with no pid it can accept a concurrent coordinator's same-installation sentinel, so keying by attempt still needs a diagnostic disposition for that path. |

| [`process-port-answers-with-two-values.md`](./process-port-answers-with-two-values.md) | `ProcessPort.readProcessIncarnation` and `kill` still collapse distinct dispositions. `ProcessPort.spawn` still defers failure, but `launch-disposition-flattened-below-the-boundary` owns the launch-boundary remedy; this entry owns the port result shape. The storage-sync and provider-operation last-error entries share the one-value/two-dispositions class. |
| [`operator-exit-orchestration.md`](./operator-exit-orchestration.md) | The branch containing `#completeOperatorExit` has landed and its safety fixes are in place. Decomposition remains open for readability; start on the next added branch or when lease tests show the current shape obstructs change. |
| [`routing-status-contention-read-as-undeterminable-artifact.md`](./routing-status-contention-read-as-undeterminable-artifact.md) | **A correct sibling beside it, again.** A `SQLITE_BUSY` met by `classifyOpenHandoffRoutingStoreDatabase` becomes an `undeterminable` artifact, which refuses the routing publication without a retry and reports a status read as undeterminable. Its sibling `classifyPublicationError` classifies the same errcode as `contended` once it arrives after `BEGIN IMMEDIATE`, and that one is retried. The rendered incident drops the errcode, so a field report showed only a `backend status` next step that no reader owed. |

These two do not close together and are not the same fix. `exec-result-overclaim` is about a single reader
deciding more than its evidence carries; `missing-discovery-record-disposition` is about three readers
deciding differently from evidence none of them over-claims. Fixing either leaves the other untouched.
The routing-status entry has `exec-result-overclaim`'s shape — one classifier widens what a sibling already
separates — but shares no code or prerequisite with any entry here and ships on its own.

Both are the same concept as [`project-source-undecidable.md`](./project-source-undecidable.md) one section
above — a probe result that cannot say which of two things it observed — and that entry is the worked example
of the shape a fix takes: the disposition goes in the return type, and the caller stops inferring. It is
listed there rather than here because its remaining half is a durability question about what gets persisted,
not about what the probe claims.

---

## A disposition reaches its consumer and the consumer erases it

Added 2026-09-09 from a tier-1 panel on `fix/preflight-cannot-defer`. The mirror of the section above: there,
a caller infers more than its evidence carries; here the evidence arrives correctly typed and the owner below
flattens it into a vocabulary that predates it. The launch members are pre-existing — the same paths received
`rejected` before the third answer existed and did the same thing with it — and the starting-status forcing
predates the drain-reporting change. None is a regression; each is a behaviour change rather than a correction.

|                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`launch-disposition-flattened-below-the-boundary.md`](./launch-disposition-flattened-below-the-boundary.md) | Four independent launch-disposition losses remain. Discuss ignores `consumedAttempt`, workflow launch refusals flatten to `wrapper_crashed`, the discuss timeout can abandon a launch that later commits a job, and Codex preflight still defers spawn failure. Settle the timeout with `hand-rolled-timeout-latches`; the deferred spawn failure overlaps the ProcessPort result-shape entry. |
| [`starting-coordinator-has-no-exit-contribution.md`](./starting-coordinator-has-no-exit-contribution.md) | **Three inner states collapse into one exit code.** `BACKEND_STATUS_EXIT_CODES` is keyed by the outer probe status, so an answered-but-not-ready coordinator exits 0 exactly like a ready one. Start after the owner decides what that caller should do instead — retry, wait, or proceed. |
| [`abort-answered-by-the-registry-not-the-saga-row.md`](./abort-answered-by-the-registry-not-the-saga-row.md) | **A direct abort no longer acknowledges a stop it could not record, but the answer still comes from the registry in three places.** Workflow fan-out aborts reach the saga only through the launch listener, whose `requestStop` discards the decision with `void`, so a drain-time child stop is dropped while the workflow reports it aborted. Three phases that take no stop still print `Aborted` from a lingering launch registration. A request mixing a saga job with a registry-only job is refused whole. |

[`process-port-answers-with-two-values`](./process-port-answers-with-two-values.md) owns the `ProcessPort`
result shape. The deferred launch-failure member in
[`launch-disposition-flattened-below-the-boundary`](./launch-disposition-flattened-below-the-boundary.md)
owns how a launch consumes that answer.
[`write-atomic-durable-sync-result-overloads-two-dispositions`](./write-atomic-durable-sync-result-overloads-two-dispositions.md)
and [`provider-operation-last-error-overloads-two-dispositions`](./provider-operation-last-error-overloads-two-dispositions.md)
have the same one-value/two-dispositions shape but separate storage and terminalization owners.

The starting-status entry shares this section's loss of a typed disposition, not an implementation path with
launch handling. It can ship independently once its exit-contribution decision is made. The abort entry is
the same loss one layer lower — the reconciler's decision exists, and the fan-out path discards it — and it
ships independently of both.

---

## Nothing is wrong, and the next reader pays for it

Added 2026-09-10 from a tier-3 review. Entries here have no defect behind them: the code is correct and
covered, and what it costs is the effort of the next person to change it safely.

|                                                                                    |                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`status-prints-history-it-should-not-carry.md`](./status-prints-history-it-should-not-carry.md) | `backend status` still carries routing history until a render threshold; move that history to an inspection verb. The proposed operator bulk-resolve exit for capacity tombstones is withdrawn under principle 12 and needs a new design. |
| [`provider-operation-last-error-overloads-two-dispositions.md`](./provider-operation-last-error-overloads-two-dispositions.md) | `providerHostUnserviceableLastError` encodes host identity and remedy as prefixed JSON in `lastError.message`, which `terminalizeProviderOperation` parses back. Give the terminalization input its own additive record home; strict schema compatibility must be addressed. This shares the one-value/two-dispositions class with the ProcessPort and storage-sync entries. |
| [`hand-rolled-timeout-latches.md`](./hand-rolled-timeout-latches.md) | The three promise/timer latches remain a readability problem; change `withDiscussLaunchTimeout` with `launch-disposition-flattened-below-the-boundary` member 3 so late launch ownership is settled with its race. The Claude settings scan is independent. |
| [`http-backend-directory-mixes-transport-neutral-modules.md`](./http-backend-directory-mixes-transport-neutral-modules.md) | **The selector moved, the mixed directory did not.** Coordinator observation is shared with `backend shutdown`, and health parsing now serves HTTP and IPC payloads. Start only as a directory-wide move with every importer, citation, and invariant updated together. |

The transport-directory entry has no behavior defect and does not close with the output-history entries. It
can ship independently, but only as the whole-directory move its start condition names.

---

## Durable state with no lifecycle owner

|                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`superseded-routing-generation-has-no-owner.md`](./superseded-routing-generation-has-no-owner.md) | Superseded routing-status addresses accumulate and a time-based sweep cannot prove they hold no obligation. The proposed operator quarantine-clear exit is withdrawn under principle 12; re-decide the lifetime design, including finite generation-address collisions and quarantine capacity. |
| [`export-lifetime.md`](./export-lifetime.md)                           | Nothing prunes `~/.coral/exports/jobs/`. Ever — the retention setting's own doc comment says otherwise. Part 1 gives it a retention authority; part 2 is archived-session restore, whose real question is answerable only once part 1 exists.                                                                                                                                                                                        |
| [`provider-session-residue-has-no-owner.md`](./provider-session-residue-has-no-owner.md) | **Retention discard shipped; on-demand discard remains.** `LifecycleReactor.enforceRetention` in `src/sessions/lifecycle-reactor.ts` now calls `discardSessionResidue`, backed by Codex fork and Claude `tool-results` discard contracts. `discardSessionArtifacts` in that module still omits residue because a concurrent resume can add a descendant while it scans. Establish resume exclusion before extending it. Remove the temporary backlog sweep at 0.11.0. |
| [`socket-address-ownership.md`](./socket-address-ownership.md)         | **Current-build installation identity closed; shipped-selector compatibility blocked.** Relocated current paths derive from the state root, so caller uid and `TMPDIR` cannot split two current builds; a caller that cannot own the shared installation directory refuses. The v0.10.9 guard now rejects an empty or relative selector as unenumerable, but that build also accepts arbitrary absolute `TMPDIR` values, so no finite compatibility-listener set can guarantee collision with every later shipped invocation. The three provider role binders still inherit an assertion made in another process, and the owner/mode assertion still cannot observe macOS ACL grants. |
| [`shared-tmp-ownership.md`](./shared-tmp-ownership.md)                 | **Partly closed.** The three files in a job directory are now `0600`; the Bash hook spill and community-summary output use unguessable exclusive temp names; the KB curate corpus asks for a mode; and simulation project state lives below its per-run temp root. What remains is the mode and rename for literal `/tmp/coral-jobs`, including whether job scratch inherits the socket's now-decided installation identity, plus the harness-owned `/tmp/claude-<uid>`. The file-level privacy policy itself still has no decided owner. |
| [`run-directory-residue.md`](./run-directory-residue.md) | **Provider-socket cleanup unassigned.** A 2026-08-24 census found 21 unbound provider socket entries spread across seven dates. `clearStaleSocket` in `src/transport/ipc/server.ts` reclaims the coordinator socket before bind; `createControlEndpoint` in `src/provider-proxy/control-endpoint.ts` binds provider roles without an established equivalent sweep. Attribute the residue and choose an owner that can prove listener absence. |

---

## Wire contracts

|                                                                              |                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`jobs-read-contract-schema-first.md`](./jobs-read-contract-schema-first.md) | `jobs.list` and `jobs.detail` still lack `responseSchema`; seven other catalog specs now carry one. The jobs conversion remains open, with job scope settled and the consumer inventory ready to audit. |
| [`result-artifact-availability.md`](./result-artifact-availability.md)       | **Ordinary-operation symptom closed 2026-09-24; two members left.** Every job-terminal commit path now reaches one post-commit export observer. What it cannot reach is a terminal separated from its observer by a failure — a kb daemon dying between commit and journal message, a failed render — where only `wait` renders the file; closing that needs a startup backstop bounded independently of the unpruned export tree. The wait event still carries an unverified path, now reachable only through those failure cases. |

---

## A quarantine row needs an address space wider than KbEntryId

One entry, and no neighbour to interact with: nothing else open turns on what a quarantine row may be keyed
by. Said here so the missing interaction paragraph reads as absence rather than omission.

|                                                                                                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`curate-conflict-quarantine-non-entry-paths.md`](./curate-conflict-quarantine-non-entry-paths.md) | `principles/`, `.entity-graph.json`, and `.gitattributes` can enter conflict recovery but cannot key a quarantine row. A path-keyed durable subject is still needed. The proposed operator `git update-ref -d` exit is withdrawn under principle 12 and must be re-decided. |

---

## Nothing is broken, and nothing would catch the next one

Added 2026-08-18 from a PR-gate review. These are not defects: the code works, and what would have caught
the original mistake did not move with the fix. They are grouped by that failure mode — a fix landed and its
guard stayed where it was.

|                                                                                |                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`unit-suite-concurrency-and-real-time-tests.md`](./unit-suite-concurrency-and-real-time-tests.md) | **Store half closed and removed; the real-time half is what is left.** The concurrent tier no longer opens a file-backed store — the doors decide from the opened handle and an invariant keeps them the only way in — so the load that justified converting real sleeps is smaller than when this was written. Its original start condition asked for a flake among the 22 remaining sleep sites; the two since observed belong to a different class — a real subprocess raced against a wall-clock budget — and the entry's corrected condition starts there instead. |
| [`source-import-converter-cohesion.md`](./source-import-converter-cohesion.md) | **Startable now.** Five concerns at one layer in a 1058-line file; four converter classes are the documented subdivision trigger. A local fix improved its functions and grew the file — that is the datum.  |
| [`invariant-path-literals-go-stale-silently.md`](./invariant-path-literals-go-stale-silently.md) | **Startable now; reproduced.** An equality-matched store path survived the store's move, matched no import edge, and left the layering invariant green; an injected forbidden import proved the guard was a no-op. The open choice is shared path-existence checks, local component-prefix rules, or graph-derived targets. This is about a literal inside a scan, not the scan-root gap in the next row. |
| [`invariant-scans-stop-at-src.md`](./invariant-scans-stop-at-src.md)           | **Startable now.** One of two scans extended to `clients/hooks/` and found nothing; the other needs its detector taught a second idiom first. Measurement already done: three files, one alternate spelling. |
| [`shutdown-remainder-tests-pin-the-whole-status.md`](./shutdown-remainder-tests-pin-the-whole-status.md) | **The transport-suite sweep remains.** Narrow each full-result `toEqual` whose test name claims one shutdown-remainder property; keep intentional full-union shape freezes explicit. |

---

## A ledger, not a concept

One file here is deliberately not a concept entry, and it says so in its own opening. It is grouped
separately rather than left out, because an unindexed file in a corpus whose index is the entry point is
a file nobody reads.

|                                                                            |                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`comment-sweep-bug-ledger.md`](./comment-sweep-bug-ledger.md)             | **Ten findings remain.** The implemented and disproven members were removed. What remains spans ambiguous file-identity names, one sessions-layering breach, swallowed artifact invariants, unresolvable spec labels, duplicated health and IPC error shapes, duplicated curate cleanup, an unbuilt community-summary job path, incomplete discuss parity coverage, and dead simulation sub-tick state. |

---

## One sweep, many instances

A file that is not a concept but a batch, kept together because splitting it per-file would lose the one
observation all of it shares. Grouped separately for the same reason the ledger below is: an unindexed file
in a corpus whose index is the entry point is a file nobody reads.

|                                                                            |                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`six-reviewer-sweep-backlog.md`](./six-reviewer-sweep-backlog.md) | **Open sweep members.** The `WorkflowExecutionPort` cast in recovery, unreachable defensive branches, three-answer process observations, weak type contracts, and assertions without positive witnesses remain. `verifySignalTarget` now returns an unverifiable refusal and `removeDeadWriterLeases` records unknown blockers explicitly. The PR3 start condition is obsolete; the surviving members are independent. |

---

## Due at 0.11.0

| Entry or file | Release obligation |
| --- | --- |
| [`legacy-cli-bundle-name.md`](./legacy-cli-bundle-name.md) | Remove the `coral-cli.cjs` compatibility copy and its build, verification, package, and attribute references when the release moves to 0.11.0. |
| `clients/scripts/sweep-provider-session-residue.mjs` | Remove the temporary backlog cleanup tool tracked in `provider-session-residue-has-no-owner`. |

---

## Developer tooling nobody runs on a schedule

These were found while verifying unrelated work rather than by anything that watches them. They share a
shape: a path only a developer walks by hand, so the breakage sits until someone walks it. They are
independent and can ship in any order.

|                                                                                |                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`dev-tool-bundles-share-the-shipping-directory.md`](./dev-tool-bundles-share-the-shipping-directory.md) | **Startable now; decide where dev artifacts live first.** `npm run simulate` and the discuss golden-master capture both stage esbuild output into `clients/build/`, where the Kiwi build contract permits exactly four bundles plus a receipt, and nothing clears it — so the next `npm run build` fails and blames WASM staging. Loosening the contract is the wrong direction; the shipping directory should hold what ships. |
| [`src-imports-itself-through-the-test-alias.md`](./src-imports-itself-through-the-test-alias.md) | **Startable now.** Eight `src/` files import other `src/` files through the `#src/` test alias; emitted `dist/` modules then resolve back into source TypeScript and fail to load. Rewrite their static imports and add an invariant. |

---

## How to add an entry

State the problem with symbol-and-path evidence, the decision already made, what is explicitly out of scope,
and what would have to be true to start. Then check this index: if the new entry shares a missing
concept with an existing one, put it in that group and say how they interact — including whether they
can ship together. Most of the damage in the last rewrite came from entries that were individually
correct and collectively contradictory.
