# Open work

Each file here records something deliberately **not** done, and why. Written at the moment the decision
was made, so the reasoning survives the session that produced it.

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
this one orders by **what has to be true before it can be worked**. An entry appears here only if that
ordering is not obvious from its own start condition.

**One decision blocks four documents.** `build-identity-and-upgrade`, `jobs-read-contract-schema-first`
and `result-artifact-availability` are the same transition — an older and a newer build reading each
other's output — and `cli-machine-channel`'s `wait` half waits on the output direction of the first.
Settle the compatibility policy once, across all of them; `result-artifact-availability` already says so
and may be a consumer of that policy rather than its driver. Deciding it is not a document task.

**Pairs that close together, and one that does not.** `darwin-signal-authority` and
`durable-cli-signal-authority` are two limbs of one rule and one invariant; the second exists because
the first's scan found it. `legacy-v1-capsule-retirement` and `foreign-capsule-retirement-terminal-recovery`
are the two halves G3 left open and they do **not** close together: one is an evidence problem, where no
observation this build can take retires anything, and the other a durability problem, where a retirement
already happened on decisive evidence and left no proof of itself.
`preflight-cannot-defer` should be read after `provider-operation-admission-hold`, not blocked on it. Both need
a name for "this could not be established, ask again", and settling that twice is how Coral would end up with
two vocabularies for one disposition — but the two gates are not in series: admission-hold is a startup-wide
gate that returns `backend_admission_held` before a launch reaches preflight at all, so a single job meets at
most one of them. The entry's own start condition also allows an independent unblock ("or a launch-level retry
is chosen"), which an earlier version of this paragraph dropped.
`provider-operation-admission-hold` and `coordinator-process-disposition` name each other as explicitly
out of scope — adjacent, not joint. And `darwin-signal-authority` states it does **not** close with
`kb-daemon-independent-containment` or `wedged-coordinator-self-drain`: it is about the authority to
signal a correctly identified target, they are about there being no party left to signal at all.

**One and two are a cause and the thing it is mistaken for.** `store-lock-misread-as-corruption` is first
because acting on its advice destroys a healthy store, and it says the trigger — a lock held during startup — is
ordinary. `unit-suite-concurrency-and-real-time-tests` is what makes it ordinary: a suite run saturates the one
filesystem that the repo, `~/.coral` and `/tmp` all share, and a coordinator blocked mid-fsync holds exactly the
lock the first entry then calls corruption. Fixing either alone leaves a real defect standing. Fix the first
regardless, because a misclassification that recommends deletion is wrong whatever produced the lock.

| Order | Entry                                                       | Why here                                                                                                                                                  |
| ----- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | [`store-lock-misread-as-corruption`](./store-lock-misread-as-corruption.md) | Observed in the field 2026-08-23 on a store that `PRAGMA integrity_check` calls `ok`. A `database is locked` was reported as `store_corrupt_or_unsupported` with `retryable: false`, and the remediation handed to the operator discards the store. It is first because following the advice destroys data, and because the trigger — a lock held during startup — is ordinary. |
| 2     | [`unit-suite-concurrency-and-real-time-tests`](./unit-suite-concurrency-and-real-time-tests.md) | Measured 2026-08-25: this is what manufactures the condition entry 1 mishandles. One `npm test` holds the device at 100% utilization for 73% of the run with 368 requests queued, so a coordinator sharing that filesystem loses its heartbeat and a coordinator blocked mid-fsync holds the lock entry 1 then calls corruption. It also makes every gate result uncertain — adding one 2 Hz sampling loop failed four unrelated tests that pass alone. The lever is `journal_mode=WAL`, not `synchronous=FULL`: dropping the WAL is 473x where relaxing durability alone is 2.6x. |
| 3     | [`session-start-context-truncated`](./session-start-context-truncated.md) | Measured on one configuration: the SessionStart packet was persisted at 11,320 bytes against a threshold that shows the first 2 KB, so the session read the general advice and lost the operative rules. Its static fragments alone sum to 9,740 bytes before any runtime content. Option 1 is a reordering inside one file. Everything else in this directory assumes an agent that read them. |
| 4     | the compatibility policy, then `build-identity-and-upgrade` | Unblocks three others. The routing-reason step is closed; this entry still carries the record direction behind the compatibility policy and the independent output direction. |
| 5     | `darwin-signal-authority` + `durable-cli-signal-authority`  | Needs a synchronous exit state on `ChildProcessLike`, which touches every fake in the suite. Do it when nothing else is in flight.                        |
| 6     | `provider-operation-admission-hold`                         | Design complete and recorded; ships as one unit or not at all.                                                                                            |
| 7     | `coordinator-process-disposition`                           | After `provider-operation-admission-hold` has settled the recovery boundary the custody transfer has to attach to.                                                                          |
| 8     | `foreign-capsule-retirement-terminal-recovery`              | After `provider-operation-admission-hold` or `coordinator-process-disposition`, and only if one of them lands: it wants a recovery boundary that nothing about its own residue justifies introducing.                       |

**Not yet, and why it is not laziness.** `wedged-coordinator-self-drain` **was observed on 2026-08-23** and
its start condition is met — a coordinator held in uninterruptible sleep on an ext4 journal commit, long
enough that a provider control lease lapsed and the reaper terminated healthy jobs. The cause is a third one
neither half of that entry was designed against, so what it now asks for is which half the observed cause
argues for, not another reproduction. `proxy-set-acquisition`'s clock-drift symptom
closed with #324, the same fix that closed the coordinator's own paths; what is left is a narrower
comparison-shape decision, not a reproduction. `store-format-routing`
is dormant. `cli-terminal-width-layout` and `export-lifetime` wait on product decisions, not on code.
`containment-observation-deadline` is arithmetic derived from constants and asks for a measured teardown that
misses its deadline before either half of its fix is built — the same entry price, for the same reason.
`legacy-v1-capsule-retirement` is absent for a reason the table cannot express: its remaining members are
capsules no observation this build can take will decide, so its first step is a decision about what may end a
hold when no evidence will — not a step in code.
`project-source-undecidable` waits on a different kind of trigger: its lifetime-durable half is already fixed,
and the rest is a port-shape decision that would be the first of its kind, so it wants either a report of a
misfiled memo, or a discuss continuation that stopped matching its source, or a general ruling on dispositions
in `RuntimePaths`.

---

## Build identity — one build's records read by another

|                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`build-identity-and-upgrade.md`](./build-identity-and-upgrade.md)                                     | **Takeover fixed 2026-08-15; the window itself is still open.** A process start time was compared across a process boundary, where `/proc/stat` btime is cached per process, so a newer build discarded the incumbent credential it needed and died on every session start while the older daemon served on. Read its status block, not its history.                                                                                                                                                                                                                                                                                                                           |
| [`quarantine-terminal-without-session.md`](./quarantine-terminal-without-session.md)                   | **Re-scored down after the rows were read.** They were #311's, produced by the old daemon, and the fix works — but a backlog a repaired build can no longer produce still keeps `recovery` reporting `degraded` until an operator clears it one row at a time. A signal that stays red for a fixed cause gets ignored, which is how two rows of a different boundary sat unnoticed underneath.                                                                                                                                                                                                                                                                                 |
| [`legacy-v1-capsule-retirement.md`](./legacy-v1-capsule-retirement.md)                                 | **Narrowed by G3, not closed.** A source-mode boot now mints its own `buildSetId`, and a foreign V2/V3 capsule whose three recorded processes are each observed `absent` is retired — so what is left is the capsules where absence is undecidable: a V1 records no process, a V2 whose pid was recycled reads `alive` forever with no incarnation to disprove it, and a role that answers `unknown` retains on every boot. Incarnation-first rescues V3 and only V3. It keeps the residue-equivalence correction its predecessor recorded, and retires two prescriptions that were false when read: no process port was added, and the slot already carried its capsule path. |
| [`foreign-capsule-retirement-terminal-recovery.md`](./foreign-capsule-retirement-terminal-recovery.md) | **The durability half, split rather than deferred.** A retirement that unlinks and then cannot sync the directory leaves nothing durable saying it happened, so the next boot rescans and decides again. G3 accepts that: four bounded retries, one warning, and a representation consuming no capacity for the rest of the boot. A crash-exact receipt costs a new recovery boundary, and the entry carries its four prerequisites plus the six designs the review rounds demolished — three with their reasoning, three with the gap marked.                                                                                                                                 |

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
now the front item), the **record** direction, which shares a compatibility policy with
[`jobs-read-contract-schema-first.md`](./jobs-read-contract-schema-first.md) and
[`result-artifact-availability.md`](./result-artifact-availability.md), and the **output** direction —
a live session holding old skill text driving a new CLI — which has no defense today and is what
actually blocks the `wait` change below.

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
| [`preflight-cannot-defer.md`](./preflight-cannot-defer.md)                                 | **The provider observed the third answer; one hop later it is gone.** Both preflights now distinguish a check that established something from one that never completed, and say which in the message — but `preflight` returns `Promise<void>`, `runProviderPreflight` flattens any rejection to a string, and `job-launch` makes any string terminal. So a job dies on an observation nobody made. The reachable half (a verdict cached across jobs) is closed; what remains needs a decision on what "ask again later" means at launch, which is the question its neighbour above is already weighing. |

---

## Containment that outlives its enforcer

|                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`kb-daemon-independent-containment.md`](./kb-daemon-independent-containment.md) | The KB daemon has no enforcer outside its own process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [`darwin-signal-authority.md`](./darwin-signal-authority.md)                     | **Handoff and both spawn-unwind halves closed; containment measured and reverted.** A macOS incarnation is wall-clock at one-second resolution, and `ps -o lstart=` prints local time — so DST fallback widens the collision window from a second to an hour, annually. The rule to implement has two limbs: signal a recorded pid only with proof the child has not exited, or with a platform-authoritative matching incarnation. The same rule is what the unheld-target escalation paths need — `'alive'` proves occupancy, not that the occupant is the recorded process. An earlier index row claimed one caller was exempt because it holds the child; that was falsified and the document records why.        |
| [`durable-cli-signal-authority.md`](./durable-cli-signal-authority.md)           | **Six signal behaviours hold the evidence and never read it.** A durable CLI child's pid is signalled on idle timeout, on abort, and on abort-after-restart, while `durable_cli_process.v1` carries the incarnation that would settle it. Found by the scan, not by five reviewers. The invariant names four modules, not six behaviours — three `durable-transport.ts` calls share one entry and the helper-delivered one is invisible to it, so the document's table is the checklist.                                                                                                                                                                                                                              |
| [`coordinator-process-disposition.md`](./coordinator-process-disposition.md)     | **A quarantine that releases the job's only owner is not better than terminalizing it** — which is why the repairable-binding quarantine was reverted rather than kept. Recovery commits its disposition before process-local cleanup, and that cleanup drops the `RecoveryRegistry` entry unconditionally, so a quarantined job with a live carrier has no owner and `jobs abort` cannot reach it. Custody must transfer by verified receipt before ownership is released, and process absence must become a completion obligation ahead of terminal and claim-release facts.                                                                                                                                        |
| [`wedged-coordinator-self-drain.md`](./wedged-coordinator-self-drain.md)         | Every self-termination path Coral has is scheduled by the process it is meant to end. The 6h idle drain is tidiness for a healthy daemon, not a liveness backstop — reading it as one is what produced this entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [`containment-observation-deadline.md`](./containment-observation-deadline.md)   | **Not the authority to signal — the cost of deciding whether to.** Every deadline that bounds teardown measures around `process.kill`; the observation that feeds it runs outside all of them. `waitForAbsence` completes a full sweep before checking its clock, `observeRecordedSet` probes every root rather than stopping at the first, and a synchronous probe blocks the event loop so no abort can interrupt it. Arithmetic, not a reproduction: its entry price is a measured case.                                                                                                                                                                                                                           |
| [`project-source-undecidable.md`](./project-source-undecidable.md)               | **Lifetime-durable half closed 2026-08-18; a per-interval identity flip remains.** `resolveProjectSource` returns one `string` for "no git remote" and "the probe could not be run", and `projectData` derives a KB memo directory from it — so a call made while a mount is stalled files a memo where later reads do not look. Only an answered probe is cached now; an unanswered one is held with an expiry, so a recovered system self-heals — and one root can therefore resolve two different ways inside one process, which `discuss/shell/recovery.ts` persists as `sourceId` and then rejects the row over. Closing it means a disposition in a port return type every consumer assumes always has a value. |

These four are one concept — something must end a process that will not end itself, and it must be sure of
what it is ending — but they close separately and in this order of tractability.
`durable-cli-signal-authority` is the tractable one and should go first: the evidence already exists in the
record. `kb-daemon-independent-containment` and `wedged-coordinator-self-drain` are the two "no party left"
entries — the first still has a supervising parent to give the job to, the second is the top of the tree and
its answer leaves the codebase. `tests/invariants/signal-authority.test.ts` enumerates every open site across both signal entries, so
neither document is the only place its gaps are written down. `darwin-signal-authority` is about the **authority** to signal a
correctly identified target; the other two are about there being **no party left** to signal at all, and a fix
for either still has to answer the first. The kb-daemon still has a supervising parent; a wedged coordinator is
the top of the tree, which is why its answer leaves the codebase entirely.

`containment-observation-deadline` sits beside these four rather than inside them. They ask what may end a
process and on what evidence; it asks what taking that evidence costs, and answers about cost do not settle
authority. It overlaps `darwin-signal-authority` on one function and nowhere else — that entry decides whether
a macOS incarnation may authorize a signal, this one counts the subprocesses spent deriving it, and closing
either leaves the other untouched. It cannot ship with them either: its own required shape is an asynchronous
observation port, which the signal-authority entries do not need and would have to absorb.

**Do not merge this with shutdown quiescence**, however alike the one-sentence summaries read. One is a
process-lifetime guarantee whose whole premise is that the closer may already be dead; the other
requires closing synchronously and then draining what acquired before the close. A shared primitive
would have to satisfy both, and their requirements are opposites.

---

## A probe's answer is read for more than it established

Added 2026-08-19 from a PR-gate review. Both are about the distance between what a command established and
what its result is taken to mean — not about a missing observation, but about an existing one being spent on
a question it does not answer.

|                                                                                                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`exec-result-overclaim.md`](./exec-result-overclaim.md)                                                 | **Two members, both with a correct sibling beside them.** `probeIsGitRepo` caches `git rev-parse`'s exit 128 as a durable "not a work tree", though 128 is also dubious ownership and a corrupt `.git` — while `probeIsGitSyncEnabled`, ten lines down, refuses that exact inference in a comment that measured it. And the sync exec port stamps its own timeout code on every signal death, so `classifyExecOutcome`'s branch for a foreign signal is unreachable from that port. Member 1 needs a judgement; member 2 does not.                                          |
| [`missing-discovery-record-disposition.md`](./missing-discovery-record-disposition.md)                   | **Half closed; the disagreement it exposed is the remainder.** `backend status` and `backend shutdown` stopped calling a missing record an absence; `coral-cli expansion` still renders `unavailable` for the same evidence, so during a coordinator's boot window two commands say the state is unknown and a third says positively that nothing is equipped. The decision underneath is whether that observation should dial the socket rather than `existsSync` it — which would make most of these observed answers, at the cost of a round trip on a pre-command path. |
| [`handoff-escalation-never-reaches-the-operator.md`](./handoff-escalation-never-reaches-the-operator.md) | **The best sentence in the system, on a path that swallows it.** `bindWithHandoff` refuses with a message naming what to repair; `HandoffEscalationError` is a plain `Error`, the startup sentinel writer serialises only documented setup errors and returns early, so the CLI times out generically and the words never reach a terminal. The message that used to promise this text was corrected; making the text arrive is a contract decision — give the escalation a documented code, or widen what the sentinel accepts — and the two are not equivalent.           |
| [`store-lock-misread-as-corruption.md`](./store-lock-misread-as-corruption.md)                           | **The discriminator is right and its caller inverts it.** `corruptBackendStoreClassificationFromFailure` matches three corruption strings and returns `null` for everything else, so `database is locked` is correctly not corruption — and `classifyStoreForProtocol` reads that `null` as grounds to throw `store_corrupt_or_unsupported` anyway. "Not corruption" and "could not classify" are one value, and the call site resolves both to the destructive verdict. Field-observed; the remediation tells the operator to discard a healthy store. Carries two separate defects from the same startup, one of them in `bindWithHandoff`, alongside [`handoff-escalation-never-reaches-the-operator.md`](./handoff-escalation-never-reaches-the-operator.md) — that entry is about the message not arriving; this one says the message correctly reports a socket still bound after the `SIGKILL` grace, but the code has no "could not observe death" disposition and therefore cannot avoid treating that observation as a socket anomaly. |
| [`routing-journal-read-alters-and-mislabels.md`](./routing-journal-read-alters-and-mislabels.md)         | **Two defects of one function's contract, one of which may have no fix.** A zero-byte journal — this build's own creation, interrupted before the schema lands — reads as `unsupported-generation: 0`, so `backend status` names the destructive discard against a file holding nothing; the write path already distinguishes empty from foreign and the read path should not invent a second vocabulary for it. Beside it, a classify read rewrites the artifact's `-shm` whenever a `-wal` is beside it or the header says WAL — read-only does not avoid it, and neither does the main file not being a database — so every discard of a WAL-carrying journal alters it before deciding anything about it, in front of a quarantine whose stated purpose is preserved evidence. The second half is a scope decision — `-shm` carries nothing durable, so retaining it may buy only the appearance of tampering. |
| [`startup-error-sentinel-single-slot.md`](./startup-error-sentinel-single-slot.md)                       | **The startup error crosses the child boundary, but concurrent attempts share one destination.** Every child atomically renames its attempt-tagged temporary sentinel onto the same `startup-error.json`; a current-attempt parent accepts only its own attempt id after shared identity and time-window checks. Two CLIs can spawn together, so the later child's sentinel can replace the earlier one's before that parent reads it. The existing-starting reader compares pid only when it observed one; with no pid it can accept a concurrent coordinator's same-installation sentinel, so keying by attempt still needs a diagnostic disposition for that path. |

These two do not close together and are not the same fix. `exec-result-overclaim` is about a single reader
deciding more than its evidence carries; `missing-discovery-record-disposition` is about three readers
deciding differently from evidence none of them over-claims. Fixing either leaves the other untouched.

Both are the same concept as [`project-source-undecidable.md`](./project-source-undecidable.md) one section
above — a probe result that cannot say which of two things it observed — and that entry is the worked example
of the shape a fix takes: the disposition goes in the return type, and the caller stops inferring. It is
listed there rather than here because its remaining half is a durability question about what gets persisted,
not about what the probe claims.

---

## Durable state with no lifecycle owner

|                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`export-lifetime.md`](./export-lifetime.md)                           | Nothing prunes `~/.coral/exports/jobs/`. Ever — the retention setting's own doc comment says otherwise. Part 1 gives it a retention authority; part 2 is archived-session restore, whose real question is answerable only once part 1 exists.                                                                                                                                                                                        |
| [`socket-address-ownership.md`](./socket-address-ownership.md)         | What the socket-identity fix left open, in three parts. The coordinator's binder asserts the directory it binds in; the three provider role binders inherit an assertion made in another process, and moving the check to them needs a startup-diagnostic channel they do not have. Once a socket relocates the uid participates in its address, so one state root under two uids is two locks — and `design-rationale.md` §8.2 never says whether the uid, real or effective, is part of an installation. And the assertion proves owner and mode, which on macOS is not effective access: an ACL can grant another principal rights that `lstat` does not show. |
| [`shared-tmp-ownership.md`](./shared-tmp-ownership.md)                 | **Partly closed.** The three files in a job directory are now `0600`; the Bash hook spill and community-summary output use unguessable exclusive temp names; the KB curate corpus asks for a mode; and simulation project state lives below its per-run temp root. What remains is the mode and per-user name for literal `/tmp/coral-jobs`, blocked on `socket-address-ownership.md`, plus the harness-owned `/tmp/claude-<uid>`. The file-level privacy policy itself still has no decided owner. |
| [`scoped-ignore-glob-anchoring.md`](./scoped-ignore-glob-anchoring.md) | **A decision, not an investigation.** The generated `*.coral-*.tmp` line in a user's `.claude/.gitignore` is unanchored, so it matches at any depth rather than the two files Coral writes beside it. Anchoring it is not blocked — this file already retires a superseded literal the same way — but it costs one extra write on every existing install and a retirement branch that stays. No correctness argument on either side. |

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

Added 2026-08-18 from a PR-gate review. Neither entry is a defect: one file works and is hard to keep
cohesive, one scan passes and cannot see the lane where its own rule was broken. They are grouped because
they share a failure mode — the fix landed, the thing that would have caught it did not move.

|                                                                                |                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`unit-suite-concurrency-and-real-time-tests.md`](./unit-suite-concurrency-and-real-time-tests.md) | **Every gate is green and the suite starves the machine it runs on.** An unbounded fork pool reached ~108 node processes with 15 in uninterruptible sleep on the ext4 journal, which pushes a live coordinator past its 5 s heartbeat budget and has the reaper terminate unrelated jobs — twelve delegated jobs died that way in one day. Now capped at 8 local workers, which halves the stall depth for 1.9x the wall time and does not change how often a stall happens, so it is a cap and not a fix. **The entry's original conclusion — concurrency rather than volume, CPU-bound, tmpfs changes nothing — was measured wrong on 2026-08-25 and is corrected in place.** The device is the whole story: 4.651 ms per fsync through the WSL2 VHDX against 0.016 ms for the same write without one, and tmpfs could not help because the repo, `~/.coral` and `/tmp` are one filesystem. The lever is the journal mode, not the durability pragma. |
| [`e2e-cli-tests-leak-a-backend-per-temp-home.md`](./e2e-cli-tests-leak-a-backend-per-temp-home.md) | **Startable now.** Every `test:e2e:build` leaves backend sets running against deleted temp roots — one run left five processes alive twenty minutes later, and four earlier sets from the same day were still holding roots `rmSync` had already removed. `afterEach` deletes the directory and never shuts the daemon down. They are isolated to `/tmp/coral-cli-test-*` and cannot reap a live job, so they feed the stall depth the entry above measures rather than causing it. |
| [`source-import-converter-cohesion.md`](./source-import-converter-cohesion.md) | **Startable now.** Five concerns at one layer in a 1058-line file; four converter classes are the documented subdivision trigger. A local fix improved its functions and grew the file — that is the datum.  |
| [`handoff-routing-subdivision.md`](./handoff-routing-subdivision.md) | **Start after its boundary is settled.** This branch added the fourth cohesive cross-build routing facet, so §7's subdivision trigger is met. Promotion is deferred to a dedicated branch because `handoff-repair-operation.ts` now owns lifecycle-deciding classification as well as shared command grammar; that ownership decides the directory's shape. |
| [`invariant-scans-stop-at-src.md`](./invariant-scans-stop-at-src.md)           | **Startable now.** One of two scans extended to `clients/hooks/` and found nothing; the other needs its detector taught a second idiom first. Measurement already done: three files, one alternate spelling. |

---

## Design record, not open work

|                                                        |                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| [`store-format-routing.md`](./store-format-routing.md) | **Dormant.** Its one live defect was extracted to its own entry and has since been fixed. Read it as a design record. |

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

## How to add an entry

State the problem with symbol-and-path evidence, the decision already made, what is explicitly out of scope,
and what would have to be true to start. Then check this index: if the new entry shares a missing
concept with an existing one, put it in that group and say how they interact — including whether they
can ship together. Most of the damage in the last rewrite came from entries that were individually
correct and collectively contradictory.
