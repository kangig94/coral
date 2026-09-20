# Work and design records

Open entries record something deliberately **not** done and why. Implemented, closed, or dormant entries
remain indexed as design records when their constraints or decisions still matter.

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

**What that decision left behind.** `build-identity-and-upgrade` keeps the record direction, which is now
applying the rule rather than choosing it. `jobs-read-contract-schema-first` and
`result-artifact-availability` are consumers of it and need no policy of their own.
`cli-machine-channel`'s `wait` half is the one that got harder rather than easier: it was waiting for a
defense of the output direction that will now never come, and its settled design — `wait` always exiting
zero — redefines a value six shipped skill documents still branch on, which the surviving constraint
forbids. It needs a shape a stale reader fails to read, not one it misreads.

**Relationships that matter before starting.** `legacy-v1-capsule-retirement` and
`foreign-capsule-retirement-terminal-recovery`
are the two halves G3 left open and they do **not** close together: one is an evidence problem, where no
observation this build can take retires anything, and the other a durability problem, where a retirement
already happened on decisive evidence and left no proof of itself.
`provider-operation-admission-hold` no longer shares a vocabulary question with anything open. It was held
behind the launch boundary's need for a name for "this could not be established, ask again", because settling
that twice would have left Coral with two vocabularies for one disposition. The launch decision now carries
`undetermined`, and the two gates were never in series anyway: admission-hold is a startup-wide gate that
returns `backend_admission_held` before a launch reaches preflight at all, so a single job meets at most one
of them.
`provider-operation-admission-hold` and `coordinator-process-disposition` are adjacent, not joint.
`darwin-signal-authority` does **not** close with
`kb-daemon-independent-containment` or `wedged-coordinator-self-drain`: it is about the authority to
signal a correctly identified target, they are about there being no party left to signal at all.

**What the 0.10.9..main diff made cheap.** Twenty-one commits across 315 files, dominated by a new
handoff-routing subsystem, a provable build identity, the coordinator socket address, the file-mode
discipline under a shared root, and two comment sweeps. Entries sitting on that code are cheapest now:
the comment ledger because the sweep that filled it just landed, and `exec-result-overclaim` because both its members were found in the
branch that became the build-identity work.

**One suspicion, checked and dismissed, so nobody re-derives it.** `src/store/schema.sql` gained
`projection_jobs.work_dir` and a `CHECK` constraint since 0.10.9, and the store format fingerprint is a hash
over the DDL, so 0.10.10 ships a new store format. That is not a principle-10 problem: `v0.10.9` already
carries `newer-incompatible` and `current-selection-newer-store`, so an older build meeting the newer store
refuses to open it rather than failing on the constraint. The compatibility policy was worth settling for
other reasons, and was; the schema change was never the one.

| Order | Entry                                                       | Why here                                                                                                                                                  |
| ----- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `build-identity-and-upgrade`                                | The policy it waited on is decided, so what is left is applying it: durable records additive-only, readers unknown-key tolerant. The routing-reason step and the output direction are both closed; the record direction is what remains. |
| 2     | [`comment-sweep-bug-ledger`](./comment-sweep-bug-ledger.md) | A ledger of defects the sweeps deliberately did not fix. Draining it is cheapest immediately after the sweep that filled it, which has just landed.        |
| 3     | [`exec-result-overclaim`](./exec-result-overclaim.md)       | Two small independent members, each with a correct sibling in the same file, both found in the branch that became the build-identity work.                 |
| 4     | [`unit-suite-concurrency-and-real-time-tests`](./unit-suite-concurrency-and-real-time-tests.md) | **Half closed**, and the reason it used to lead still holds: a suite run saturates the one filesystem the repo, `~/.coral` and `/tmp` share, and a coordinator blocked mid-fsync holds the store lock and misses its heartbeat. What remains is the cap itself and 22 real sleeps totalling 1.4 s — under 1% of wall time — so the case for them is flake. Two flakes have now been observed and neither is a sleep: both raced a real subprocess against a wall-clock budget, so that class is what the entry now asks to be settled first. |
| 5     | `provider-operation-admission-hold`                         | Design complete and recorded; ships as one unit or not at all.                                                                                            |
| 6     | `coordinator-process-disposition`                           | After `provider-operation-admission-hold` has settled the recovery boundary the custody transfer has to attach to.                                                                          |
| 7     | `foreign-capsule-retirement-terminal-recovery`              | After `provider-operation-admission-hold` or `coordinator-process-disposition`, and only if one of them lands: it wants a recovery boundary that nothing about its own residue justifies introducing.                       |

**Not yet, and why it is not laziness.** `wedged-coordinator-self-drain` **was observed on 2026-08-23** and
its start condition is met — a coordinator held in uninterruptible sleep on an ext4 journal commit, long
enough that a provider control lease lapsed and the reaper terminated healthy jobs. The cause is a third one
neither half of that entry was designed against, so what it now asks for is which half the observed cause
argues for, not another reproduction. `proxy-set-acquisition`'s clock-drift symptom
closed with #324, the same fix that closed the coordinator's own paths; what is left is a narrower
comparison-shape decision, not a reproduction. `cli-terminal-width-layout` and `export-lifetime` wait on
product decisions, not on code.
`legacy-v1-capsule-retirement` is absent for a reason the table cannot express: its remaining members are
capsules no observation this build can take will decide, so its first step is a decision about what may end a
hold when no evidence will — not a step in code.
`project-source-undecidable` waits on a different kind of trigger: its lifetime-durable half is already fixed,
and the rest is a port-shape decision that would be the first of its kind, so it wants either a report of a
misfiled memo, or a discuss continuation that stopped matching its source, or a general ruling on dispositions
in `RuntimePaths`.
`run-directory-residue` stays observation-only, and a second census on 2026-09-01 found the same two shapes
alive — 26 backend processes, several over an hour old, and a run directory of several hundred provider
sockets. Still no attribution, which is what it asks for.

---

## Build identity — one build's records read by another

|                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`build-identity-and-upgrade.md`](./build-identity-and-upgrade.md)                                     | **Takeover fixed 2026-08-15; the window itself is still open.** A process start time was compared across a process boundary, where `/proc/stat` btime is cached per process, so a newer build discarded the incumbent credential it needed and died on every session start while the older daemon served on. Read its status block, not its history.                                                                                                                                                                                                                                                                                                                           |
| [`quarantine-terminal-without-session.md`](./quarantine-terminal-without-session.md)                   | **Re-scored down after the rows were read.** They were #311's, produced by the old daemon, and the fix works — but a backlog a repaired build can no longer produce still keeps `recovery` reporting `degraded` until an operator clears it one row at a time. A signal that stays red for a fixed cause gets ignored, which is how two rows of a different boundary sat unnoticed underneath.                                                                                                                                                                                                                                                                                 |
| [`legacy-v1-capsule-retirement.md`](./legacy-v1-capsule-retirement.md)                                 | **Narrowed by G3, not closed.** A source-mode boot now mints its own `buildSetId`, and a foreign V2/V3 capsule whose three recorded processes are each observed `absent` is retired — so what is left is the capsules where absence is undecidable: a V1 records no process, a V2 whose pid was recycled reads `alive` forever with no incarnation to disprove it, and a role that answers `unknown` retains on every boot. Incarnation-first rescues V3 and only V3. It keeps the residue-equivalence correction its predecessor recorded, and retires two prescriptions that were false when read: no process port was added, and the slot already carried its capsule path. |
| [`foreign-capsule-retirement-terminal-recovery.md`](./foreign-capsule-retirement-terminal-recovery.md) | **The durability half, split rather than deferred.** A retirement that unlinks and then cannot sync the directory leaves nothing durable saying it happened, so the next boot rescans and decides again. G3 accepts that: four bounded retries, one warning, and a representation consuming no capacity for the rest of the boot. A crash-exact receipt costs a new recovery boundary, and the entry carries its four prerequisites plus the six designs the review rounds demolished — three with their reasoning, three with the gap marked.                                                                                                                                 |
| [`no-store-migration-path.md`](./no-store-migration-path.md)                                           | **The reason every other entry in this section exists.** `classifyStoreFormat` treats absent product-version metadata as `corrupt-or-unsupported`; there is no adoption outcome. Any incompatible current epoch causes settlement to publish a fresh successor without carrying its rows forward. The superseded epoch is retained data, not current authority or a migration. Measured: 9 commits to `src/store/schema.sql` against 33 release tags. The fingerprint cannot tell an additive change from a destructive one, which may be most of the fix. Sibling of the row below, and they do not close together: that one routes among formats, this one carries data forward. |
| [`store-format-routing.md`](./store-format-routing.md)                                                 | **Dormant, and dormant means unstarted.** The build-selection pointer shipped and gives one flavor one store path with cross-version handoff, which is not multi-format routing: an older build still cannot find and open a store in its own format, so it must hand authority to a newer build or replace the active store outright. The dangerous state it exists to prevent — two builds with different schemas alternating over one store — is the shape of the 2026-08-01 incident. The fingerprint-keyed layout is designed far enough to know its shape and one blocking conflict, and nobody has appetite for it. |

The last two rows are what G3 left open, and they are not one entry. `legacy-v1-capsule-retirement` is an
evidence problem — nothing observable retires those capsules — and
`foreign-capsule-retirement-terminal-recovery` is a durability problem about a retirement that already happened
on decisive evidence. Fixing either leaves the other untouched, and neither blocks the other. The
terminal-recovery entry does share one prerequisite with `provider-operation-admission-hold` and
`coordinator-process-disposition` in the sections below: all three want a new recovery boundary, whichever
lands first pays for its shape, and their dispositions do not merge — so it can ship **after** either of them
and with neither.

`build-identity`'s first half — a record this build cannot parse must not become a job this build
destroys — shipped as #316. What remains is three things, not two: **finishing the takeover** (above,
now the front item), the **record** direction, which applies the settled additive-only policy shared with
[`jobs-read-contract-schema-first.md`](./jobs-read-contract-schema-first.md) and
[`result-artifact-availability.md`](./result-artifact-availability.md). The **output** direction — a live
session holding old skill text driving a new CLI — is closed as a deliberate non-goal: resuming the session
replaces that text and a model recovers from an unexpected result on its own. What it leaves is a rule the
`wait` change below has to satisfy rather than wait out.

Read its status block before citing it. The document has now been wrong **three times** about this
subject — a cause inferred from a bundle-string diff, a trigger declared missing that fires every
session, and a mixed window called "permitted by design" — so its corrections are kept in place.

---

## The CLI has no machine channel

|                                                                  |                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`cli-machine-channel.md`](./cli-machine-channel.md)             | `wait`'s exit integer and the `jobs` table's column layout are both presentation carrying a protocol. The `wait` contract is **settled** — it becomes a pure monitor whose exit code describes the monitor, not the job. The `jobs` half is an open product decision. Ship as two PRs, never one. |
| [`cli-terminal-width-layout.md`](./cli-terminal-width-layout.md) | A **third** thing, and it must not join either. Width work rewrites the rows a contract fixture exists to freeze.                                                                                                                                                                                 |

The `wait` change is blocked on build identity's **output** direction specifically: a session still
holding the old skill's text, reading a new always-zero exit, would convert failure into success. #316
landing does not unblock it — that was the record direction.

---

## Provider proxy

|                                                                                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`proxy-set-acquisition.md`](./proxy-set-acquisition.md)                                   | **The same defect as build-identity, closed the same way.** Acquisition compared a start time the parent derived against one the child derived; measured disagreements of 2 to 670 seconds were the incumbent's age, not spawn latency. #324 closed that on this pair too, the same fix that closed the coordinator's own paths; what remains is whether the comparison should stop being cross-process at all, a design choice rather than a bug.                                                                                                                                                       |
| [`provider-operation-shutdown-quiescence.md`](./provider-operation-shutdown-quiescence.md) | Shutdown fences only part of the mutation surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [`provider-operation-admission-hold.md`](./provider-operation-admission-hold.md)           | **Written once, rejected, and taken back out — the whole unit is here.** A row nobody can attribute must stop the coordinator finishing startup, but the first attempt returned that refusal through the success value, so shutdown terminalized the very jobs it protected and no command could ever end it. A held coordinator is one whose `start()` has not resolved, whose blockers are ordinary quarantine subjects, and whose clear/abandon commands ship in the same change.                                                                                                                     |
| [`local-app-server-stream-has-no-inactivity-bound.md`](./local-app-server-stream-has-no-inactivity-bound.md) | **Open; likely cause of the usage-limit incident.** Local app-server initialization is bounded, but stream consumption has no inactivity bound. Exact permits expose the hold and give its holder an abort exit; this change does not make a stalled stream return. |
| [`provider-proxy-persistent-challenge-mismatch.md`](./provider-proxy-persistent-challenge-mismatch.md) | Repeated current-tenancy challenge mismatches are answers, not silence, but a faulty peer could answer forever without accepting an echo. Give that distinct subject a bounded disposition if it becomes reachable against a correct endpoint. |

---

## Containment that outlives its enforcer

|                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`kb-daemon-independent-containment.md`](./kb-daemon-independent-containment.md) | The KB daemon has no enforcer outside its own process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [`darwin-signal-authority.md`](./darwin-signal-authority.md)                     | **Signal authority is closed; platform support remains constrained.** A Darwin process incarnation cannot authorize a signal. Live-child authority permits teardown while the child remains uncollected; recovered containment retains a non-success disposition, and provider-host admission is Linux-only because a launch can require teardown before child authority is available. Supporting either fail-closed case requires a stronger macOS identity source or another accepted owner. |
| [`coordinator-process-disposition.md`](./coordinator-process-disposition.md)     | **A quarantine that releases the job's only owner is not better than terminalizing it** — which is why the repairable-binding quarantine was reverted rather than kept. Recovery commits its disposition before process-local cleanup, and that cleanup drops the `RecoveryRegistry` entry unconditionally, so a quarantined job with a live carrier has no owner and `jobs abort` cannot reach it. Custody must transfer by verified receipt before ownership is released, and process absence must become a completion obligation ahead of terminal and claim-release facts.                                                                                                                                        |
| [`wedged-coordinator-self-drain.md`](./wedged-coordinator-self-drain.md)         | Every self-termination path Coral has is scheduled by the process it is meant to end. The 6h idle drain is tidiness for a healthy daemon, not a liveness backstop — reading it as one is what produced this entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [`project-source-undecidable.md`](./project-source-undecidable.md)               | **Lifetime-durable half closed 2026-08-18; a per-interval identity flip remains.** `resolveProjectSource` returns one `string` for "no git remote" and "the probe could not be run", and `projectData` derives a KB memo directory from it — so a call made while a mount is stalled files a memo where later reads do not look. Only an answered probe is cached now; an unanswered one is held with an expiry, so a recovered system self-heals — and one root can therefore resolve two different ways inside one process, which `discuss/shell/recovery.ts` persists as `sourceId` and then rejects the row over. Closing it means a disposition in a port return type every consumer assumes always has a value. |

`darwin-signal-authority` records the platform boundary for identity-safe teardown.
`kb-daemon-independent-containment` and `wedged-coordinator-self-drain` are about there being **no party left**
to signal at all, so a fix for either still has to satisfy that authority rule. The KB daemon has a supervising
parent that can accept custody; a wedged coordinator is the top of the tree, so its answer leaves the codebase.

**Do not merge this with shutdown quiescence**, however alike the one-sentence summaries read. One is a
process-lifetime guarantee whose whole premise is that the closer may already be dead; the other
requires closing synchronously and then draining what acquired before the close. A shared primitive
would have to satisfy both, and their requirements are opposites.

---

## What a shutdown leaves behind

Added 2026-09-17 from PR #363, which made a drain end by itself: the coordinator releases what it holds and
exits, and everything it leaves is owned by a durable successor or named as lost in one record. The
entries are what that change could see from where it stood and deliberately did not do. They share the
premise — nobody is watching, so the process's own exit is the only exit — and not a fix: one is a stall on
the exit path, one is a loop across successors, one is a live health projection not yet carried, one is an
offer nobody can make, one is an offer that is still reachable, one is a refusal a client reads as a
success, one is a retry with nothing to exhaust, one is a test suite reaching the real home, one is a
record no bound evicts, and one is a job launched into a drain that has already refused its result.

|                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`discovery-withdrawal-is-unbounded-on-the-exit-path.md`](./discovery-withdrawal-is-unbounded-on-the-exit-path.md)           | **A stated exception with no home until now.** The synchronous finalizer's last act is a `readFileSync` and an `unlinkSync` on the discovery record, uninterruptible from inside the process. A helper process was designed and rejected because the unguarded withdrawal one line later shares the journal. The decision underneath is whether the record is withdrawn by its writer or expired by its next reader, as the socket already is.               |
| [`reproducible-fatal-successor-loop.md`](./reproducible-fatal-successor-loop.md)                                             | **Inherited and bounded, cheaper than it was.** A guardian answering out of contract produces the same fatal in every successor that redeems its capsule, until the enforcers observe the holder absent and reap the set. Under hard mode each iteration also reaped every healthy set; under handoff it costs the bad set and one CLI invocation. Ending it earlier means retiring on evidence the fatal says cannot be interpreted.                       |
| [`shutdown-remainder-has-no-reader.md`](./shutdown-remainder-has-no-reader.md)                                               | **Track B of #357.** The no-daemon `backend status` arm reports the run directory's single shutdown remainder record. The remaining question is how a live coordinator projects a held boundary's reason and exit through health, without inventing a `transfer-pending` lifecycle state.                                                                                                                                                                             |
| [`a-lifecycle-refusal-rides-a-success-envelope.md`](./a-lifecycle-refusal-rides-a-success-envelope.md) | **Older than the branch that named it.** A request refused for a draining lifecycle is answered as a JSON-RPC success whose body carries the refusal; only a client that tests the body sees it. `main` did this at two sites, and the drain branch gave it one home and a tolerant matcher rather than changing it. Moving to an error envelope is a decision every released CLI meets. |
| [`representation-release-retries-forever.md`](./representation-release-retries-forever.md) | **Seen in the wild, 28 hours of it.** `#scheduleRepresentationReleaseRetry` reschedules a 1-second timer with no attempt counter, so an unavailable consumer produced 72,641 identical WARN lines — 88% of a 10 MB log — ending only when the process died — and a cold boot after a full teardown resumed it one second in, so it is rebuilt from durable state rather than held by one unlucky instance. Principle 11 asks what ends a hold; this one is not even bounded, so there is nothing to exhaust. |
| [`hook-unit-tests-reach-the-real-coral-home.md`](./hook-unit-tests-reach-the-real-coral-home.md) | **`npm test` is not side-effect-free here.** `runHook` copies `process.env` and deletes six variables but not `HOME`, so hook fixtures spawn backends against the developer's own `~/.coral`; 108 of their `MODULE_NOT_FOUND` crashes were found in the live coordinator's log. The crashes are harmless — the spawn that does not crash is the hazard. |
| [`shutdown-remainder-unreadable-record-has-no-exit.md`](./shutdown-remainder-unreadable-record-has-no-exit.md) | **Resolved by having one address.** The directory of per-instance records, its retention ranking, its cap and its pruner are gone; the remainder is one file. A record this build cannot read is reported with the classification observed (`unreadable`, `corrupt`, `unsupported`) on every status including an unscoped one, and its exit is the next shutdown that leaves losses renaming over it. Both premises the old bounded store rested on — that a readable record's age can be unknown, and that the directory could grow to disk capacity — were refuted by measurement. |
| [`shutdown-remainder-predecessor-quarantine-was-unreleased.md`](./shutdown-remainder-predecessor-quarantine-was-unreleased.md) | **Closed provenance decision.** The nested `quarantine/<subject>/<slot>/evidence` writer existed for one unreleased branch commit and never entered `clients/bridge`; no reconciler is warranted. Moot on the reading side too: the remainder is one address and nothing enumerates the run directory, so a leftover directory is never opened. |
| [`agent-attempts-ignore-the-session-abort.md`](./agent-attempts-ignore-the-session-abort.md) | **Bounded by the same round's fix, which is why it is an entry.** `executeAgentAttempt` never reads the live controller's signal — the module contains no `aborted` at all — and an abort does not remove the snapshot its guards test, so a drain still buys one job launch per session whose result `commitDecision` then refuses. Where the check belongs is the decision: the function takes a session id, not a controller, and its existing snapshot guard already answers a different disposition through the same value. |

The first shares its cause with `wedged-coordinator-self-drain` and ships after that entry picks a half. The
second is adjacent to both capsule-retirement entries — the same question of what may retire a capsule when no
observation decides — and is now observable through the no-daemon reader.

---

## A round's own premise, corrected

Added 2026-09-19. A round in this same code area built a fix on a scenario that re-verification against
the tree found unreachable. The false premise lives in a commit message that cannot be edited, so this
entry exists only so a later round does not rebuild on it — there is nothing open here.

|                                                                                                                                          |                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`discuss-shutting-down-asymmetry-disproven.md`](./discuss-shutting-down-asymmetry-disproven.md) | **Closed — corrects a commit, not an open gap.** A hard drain was believed to answer a discuss bid and a discuss status read on the same session differently. Both are ordinary catalog routes with no special drain admission, so both are refused identically, before dispatch, by the same lifecycle gate; the asymmetry never existed. The operator-facing half built on it was reverted on the branch that introduced it. |

This is adjacent to `agent-attempts-ignore-the-session-abort.md` above (same commit, same code area) but
does not touch it: that entry never depended on the disproven asymmetry.

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

| [`process-port-answers-with-two-values.md`](./process-port-answers-with-two-values.md)                   | **The owner of the primitives is the one over-claiming, and the gate for it is in place.** `ProcessPort.readProcessIncarnation` still returns `null` for absent, unreadable, or unprobed targets; `ProcessPort.kill` still collapses distinct refusal causes into `false`; and `ProcessPort.spawn` still defers launch failure to a later event. `gracefulKill` is outside the remaining migration because its return type exposes signal failure or refusal separately from pending settlement. `process-observation-composition` refuses new collapses and carries the unconverted boundaries as a self-pruning ledger. |
| [`operator-exit-orchestration.md`](./operator-exit-orchestration.md)                                     | **Filed BLOCKING five rounds running, and the reported failure was never the real one.** Measuring `#completeOperatorExit` rather than reading it found a fence discharged by hand on twenty-one of twenty-six exits — fixed — while a ruling established that the failures the reports named are unreachable, because a released lease cannot authorize a finalization and every hold carries its own kind. Two narrower hazards were closed and lease state finally has tests. The decomposition that would make the next round cheaper is designed and deferred: it buys readability, not safety, and it must not undo the request union that made an invalid behaviour-contract pair unwritable. |

These two do not close together and are not the same fix. `exec-result-overclaim` is about a single reader
deciding more than its evidence carries; `missing-discovery-record-disposition` is about three readers
deciding differently from evidence none of them over-claims. Fixing either leaves the other untouched.

Both are the same concept as [`project-source-undecidable.md`](./project-source-undecidable.md) one section
above — a probe result that cannot say which of two things it observed — and that entry is the worked example
of the shape a fix takes: the disposition goes in the return type, and the caller stops inferring. It is
listed there rather than here because its remaining half is a durability question about what gets persisted,
not about what the probe claims.

---

## A disposition reaches its consumer and the consumer erases it

Added 2026-09-09 from a tier-1 panel on `fix/preflight-cannot-defer`. The mirror of the section above: there,
a caller infers more than its evidence carries; here the evidence arrives correctly typed and the owner below
flattens it into a vocabulary that predates it. Both members are pre-existing — the same paths received
`rejected` before the third answer existed and did the same thing with it — so neither is a regression, and
each is a behaviour change rather than a correction.

|                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`launch-disposition-flattened-below-the-boundary.md`](./launch-disposition-flattened-below-the-boundary.md)                 | **Four independent members; the first needs no new type at all, and the last two are why the first two exist.** `executeAgentAttempt` already distinguishes a launch that never started (`consumedAttempt: false`) from a failure after a job ran, and nothing in `src/` reads the field — so discuss expels required participants, appends a `speech.timed_out` transcript entry that later prompts render, and commits a launch diagnostic as `follow_up.answered`, all for a participant nobody ran. The second: every workflow launch failure becomes `wrapper_crashed`, so the same non-answer exits 75 under `codex` and 1 under `workflow`. |

---

## Nothing is wrong, and the next reader pays for it

Added 2026-09-10 from a tier-3 review. Entries here have no defect behind them: the code is correct and
covered, and what it costs is the effort of the next person to change it safely.

|                                                                                    |                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`status-prints-history-it-should-not-carry.md`](./status-prints-history-it-should-not-carry.md) | `backend status` collapses routing history past a render threshold instead of not carrying it. The classification is now the domain's, but the threshold is a number the output shape changes at; the form without one moves history to an inspection verb. Carries a second member: a capacity-eviction tombstone is a hold that prints its own command, so the ceiling wants a bulk `resolve`, never a narrower render. |
| [`hand-rolled-timeout-latches.md`](./hand-rolled-timeout-latches.md)               | **One shape written three ways, and the latch is where it went wrong once already.** `runPreflightWithTimeout`, `withDiscussLaunchTimeout` and `raceTimeout` each settle from two callbacks behind a `settled` boolean where `Promise.race` with a `finally` would say it structurally. Carries a second member: the Claude settings scan does four things in one loop, and the read-error precedence that matters is hidden in a `??=`. |

---

## Durable state with no lifecycle owner

|                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`superseded-routing-generation-has-no-owner.md`](./superseded-routing-generation-has-no-owner.md) | A schema change normally mints a new routing-status address and nothing reclaims the old one — eleven generations on one host. A time-based sweep was written and reverted: this build cannot parse the address it would delete, so whether it holds an obligation is unanswerable here. `discard` already moves a generation into the retained-evidence surface; what is open is its 16-slot ceiling, and that the generation folds into a finite band so two schemas can share one address. |
| [`export-lifetime.md`](./export-lifetime.md)                           | Nothing prunes `~/.coral/exports/jobs/`. Ever — the retention setting's own doc comment says otherwise. Part 1 gives it a retention authority; part 2 is archived-session restore, whose real question is answerable only once part 1 exists.                                                                                                                                                                                        |
| [`socket-address-ownership.md`](./socket-address-ownership.md)         | **Current-build installation identity closed; shipped-selector compatibility blocked.** Relocated current paths derive from the state root, so caller uid and `TMPDIR` cannot split two current builds; a caller that cannot own the shared installation directory refuses. The v0.10.9 guard now rejects an empty or relative selector as unenumerable, but that build also accepts arbitrary absolute `TMPDIR` values, so no finite compatibility-listener set can guarantee collision with every later shipped invocation. The three provider role binders still inherit an assertion made in another process, and the owner/mode assertion still cannot observe macOS ACL grants. |
| [`shared-tmp-ownership.md`](./shared-tmp-ownership.md)                 | **Partly closed.** The three files in a job directory are now `0600`; the Bash hook spill and community-summary output use unguessable exclusive temp names; the KB curate corpus asks for a mode; and simulation project state lives below its per-run temp root. What remains is the mode and rename for literal `/tmp/coral-jobs`, including whether job scratch inherits the socket's now-decided installation identity, plus the harness-owned `/tmp/claude-<uid>`. The file-level privacy policy itself still has no decided owner. |
| [`run-directory-residue.md`](./run-directory-residue.md)             | **Observation only; causes unassigned.** One 2026-08-24 census found 21 unbound provider socket entries spread across seven dates and 95 module-resolution crashes reaching for deleted test-shaped plugin roots. The two residues share only the run directory and the census that exposed them; attribute and fix them separately. |

---

## Wire contracts

|                                                                              |                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`jobs-read-contract-schema-first.md`](./jobs-read-contract-schema-first.md) | `jobs.list` and `jobs.detail` cross four boundaries with no response schema. The field that motivated it stopped crossing the wire while it sat open; the boundary is the defect, not the field. Its one prerequisite is cleared: job scope stopped moving when `projection_jobs.work_dir` landed, so a consumer inventory can now be audited against settled values. |
| [`result-artifact-availability.md`](./result-artifact-availability.md)       | **Re-score before starting.** The symptom that motivated it was fixed by a ten-line change (#314); what remains has never been observed and costs a protocol transition.                         |

---

## A quarantine row needs an address space wider than KbEntryId

One entry, and no neighbour to interact with: nothing else open turns on what a quarantine row may be keyed
by. Said here so the missing interaction paragraph reads as absence rather than omission.

|                                                                                                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`curate-conflict-quarantine-non-entry-paths.md`](./curate-conflict-quarantine-non-entry-paths.md) | **Scoped down deliberately, not missed.** `principles/`, `.entity-graph.json`, and `.gitattributes` sit inside the seven-path conflict scope but outside `KbEntryId`, so a merge-driver refusal on any of the three warns and leaves no quarantine row for `kb diagnose` to read. The refusal-is-not-silent half shipped; the durable row needs a quarantine subject union wider than `KbEntryId`, which touches every consumer keyed on that type and was out of the reviewed file set. |

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
| [`shutdown-remainder-tests-pin-the-whole-status.md`](./shutdown-remainder-tests-pin-the-whole-status.md) | **The guard rots on the edit principle 10 sanctions.** Both instances named in the coordinator suite are settled — one was deleted with the directory scan, the other narrowed to the skipped entry it is about. What remains is the companion sweep in the transport suite, where a `toEqual` whose test name claims a narrow property should be pulled down to that property; the sites that deliberately pin the whole status union are not that case. |

---

## A ledger, not a concept

One file here is deliberately not a concept entry, and it says so in its own opening. It is grouped
separately rather than left out, because an unindexed file in a corpus whose index is the entry point is
a file nobody reads.

|                                                                            |                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`comment-sweep-bug-ledger.md`](./comment-sweep-bug-ledger.md)             | **Open and accumulating.** Defects the comment-rot sweep found in code it walked for other reasons, recorded rather than fixed so a comment-only diff stays reviewable. A flat list of unrelated findings across fourteen sectors, most documentation-only or latent. An entry someone acts on is struck; one that needs its own argument graduates to a conforming entry. |

---

## One sweep, many instances

A file that is not a concept but a batch, kept together because splitting it per-file would lose the one
observation all of it shares. Grouped separately for the same reason the ledger below is: an unindexed file
in a corpus whose index is the entry point is a file nobody reads.

|                                                                            |                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`six-reviewer-sweep-backlog.md`](./six-reviewer-sweep-backlog.md)         | **Scheduled after PR3 of the handoff-routing work.** Six reviewers aimed at one branch were asked to sweep the repository for the classes it had just closed in itself. One BLOCKING — a cast asserts a `WorkflowExecutionPort` on an object that does not implement it, and recovery calls the missing method directly. Then branches the call graph cannot reach, places that admit two answers where the evidence has three, contracts weaker than they read, and assertions that pass when their subject is absent. One observation with many instances: a value that decides something is written once and then re-derived, widened, or discarded by the next reader. |

---

## Environment, not Coral

|                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sandboxed hooks cannot find the backend bundle.** 252 occurrences of `Cannot find module '/tmp/coral-hooks-<rand>/plugin-root/bridge/coral-backend.cjs'` in one coordinator log. Neither `coral-hooks` nor that path shape exists anywhere in this repository or in a built bundle, so the mirrored plugin root is the host harness's, and it omits `bridge/`. The hooks fail open, so nothing breaks — but every occurrence is a spawned process that dies, and the noise buries real errors in the same log. Worth a line in `docs/hooks.md` about what a hook may assume about its plugin root, and worth confirming against the harness rather than guessing. |

---

## Developer tooling nobody runs on a schedule

These were found while verifying unrelated work rather than by anything that watches them. They share a
shape: a path only a developer walks by hand, so the breakage sits until someone walks it. They are
independent and can ship in any order.

|                                                                                |                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`dev-tool-bundles-share-the-shipping-directory.md`](./dev-tool-bundles-share-the-shipping-directory.md) | **Startable now; decide where dev artifacts live first.** `npm run simulate` and the discuss golden-master capture both stage esbuild output into `clients/build/`, where the Kiwi build contract permits exactly four bundles plus a receipt, and nothing clears it — so the next `npm run build` fails and blames WASM staging. Loosening the contract is the wrong direction; the shipping directory should hold what ships. |
| [`src-imports-itself-through-the-test-alias.md`](./src-imports-itself-through-the-test-alias.md) | **Startable now.** Files under `src/` import other `src/` files through the `#src/` test alias, `tsc` carries runtime specifiers into `dist/`, and the imports map sends a loader back into `src/*.ts` where the `.js` extension no longer resolves. Production bundles are unaffected; the developer tool that loads the affected `dist/**` modules cannot run. Rewrite the static imports and add an invariant. |

---

## How to add an entry

State the problem with symbol-and-path evidence, the decision already made, what is explicitly out of scope,
and what would have to be true to start. Then check this index: if the new entry shares a missing
concept with an existing one, put it in that group and say how they interact — including whether they
can ship together. Most of the damage in the last rewrite came from entries that were individually
correct and collectively contradictory.
