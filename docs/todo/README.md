# Open work

Each file here records something deliberately **not** done, and why. Written at the moment the decision
was made, so the reasoning survives the session that produced it.

Grouped by the concept whose absence produced the members — not by which command or file they touch.
Two entries that look alike often need opposite fixes, and two that look unrelated often close together.

Rewritten 2026-08-15 after a consolidation pass found eleven entries had drifted into fragments: two
asserted opposite facts about one directory, one had scoped its own reported symptom out of bounds, one
was built on a cause that had been inferred rather than reproduced, and a live defect was buried inside
a document about an unplanned feature.

**Re-verified against source the same day**, every claim and every `file:line`. The rewrite had fixed
how these documents were organised without checking what they asserted. Four entries were wrong in ways
that would have produced a wrong fix — a defect enumerated at one call site that exists at three, a
sibling of the same defect one file away, a prescription for a field that no longer crosses the wire,
and a dismissed constraint that was true of a different directory. Each carries the correction in place
rather than an edited-clean text, because the corrections are the part that does not re-derive.

---

## Build identity — one build's records read by another

|                                                                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`build-identity-and-upgrade.md`](./build-identity-and-upgrade.md)                   | **Takeover fixed 2026-08-15; the window itself is still open.** A process start time was compared across a process boundary, where `/proc/stat` btime is cached per process, so a newer build discarded the incumbent credential it needed and died on every session start while the older daemon served on. Read its status block, not its history.                                                                                                                                                                                                                |
| [`quarantine-terminal-without-session.md`](./quarantine-terminal-without-session.md) | **Re-scored down after the rows were read.** They were #311's, produced by the old daemon, and the fix works — but a backlog a repaired build can no longer produce still keeps `recovery` reporting `degraded` until an operator clears it one row at a time. A signal that stays red for a fixed cause gets ignored, which is how two rows of a different boundary sat unnoticed underneath.                                                                                                                                                                      |
| [`foreign-capsule-retirement.md`](./foreign-capsule-retirement.md)                   | **Harm removed, residue kept.** A handoff capsule this build may not act on is represented so its address cannot be aliased, and dialing one is fatal rather than merely useless — but nothing retires the file, so it is rediscovered and re-warned every boot. The rollback-unsafe rewrite it used to also carry is gone: the path that produced it was deleted rather than repaired.                                                                                                                                                                             |
| [`source-mode-build-identity-sentinel.md`](./source-mode-build-identity-sentinel.md) | **The cause behind that deletion.** Every source-mode run claims one fixed `buildSetId`, so the gate that decides whether one build may dial another's processes answers "same build" for two unrelated source trees. One consequence was found and removed; the gate still returns a confident wrong answer. The fix is a fresh UUID per source-mode boot, keeping an explicit boot-snapshot id ahead of it. Absence is provable from the recorded pids without redeeming or signalling anything; what it needs is a process port and an observe-then-retire turn. |

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

## A job has one root

|                                                          |                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`job-scope-containment.md`](./job-scope-containment.md) | Authorization already decides against the directory the work happens in; the durable record takes the shell's cwd instead. Record the former, and compare by containment rather than equality. **Three launch paths write the record, not one** — initial, resumed, and workflow-replacement. Must land before the jobs read contract — a consumer inventory cannot be audited while the values move. |

---

## Provider proxy

|                                                                                            |                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`proxy-set-acquisition.md`](./proxy-set-acquisition.md)                                   | **The same defect as build-identity, at a different pair of processes.** Acquisition compares a start time the parent derived against one the child derived; measured disagreements of 2 to 670 seconds are the incumbent's age, not spawn latency. The coordinator paths are fixed; this pair is not. |
| [`provider-operation-shutdown-quiescence.md`](./provider-operation-shutdown-quiescence.md) | Shutdown fences only part of the mutation surface.                                                                                                                                                                                                                                                     |

---

## Containment that outlives its enforcer

|                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`kb-daemon-independent-containment.md`](./kb-daemon-independent-containment.md) | The KB daemon has no enforcer outside its own process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [`darwin-signal-authority.md`](./darwin-signal-authority.md)                     | **Handoff and both spawn-unwind halves closed; containment measured and reverted.** A macOS incarnation is wall-clock at one-second resolution, and `ps -o lstart=` prints local time — so DST fallback widens the collision window from a second to an hour, annually. The rule to implement has two limbs: signal a recorded pid only with proof the child has not exited, or with a platform-authoritative matching incarnation. An earlier index row claimed one caller was exempt because it holds the child; that was falsified and the document records why. |
| [`durable-cli-signal-authority.md`](./durable-cli-signal-authority.md)           | **Six signal behaviours hold the evidence and never read it.** A durable CLI child's pid is signalled on idle timeout, on abort, and on abort-after-restart, while `durable_cli_process.v1` carries the incarnation that would settle it. Found by the scan, not by five reviewers. The invariant names four modules, not six behaviours — three `durable-transport.ts` calls share one entry and the helper-delivered one is invisible to it, so the document's table is the checklist.                                                                            |
| [`wedged-coordinator-self-drain.md`](./wedged-coordinator-self-drain.md)         | Every self-termination path Coral has is scheduled by the process it is meant to end. The 6h idle drain is tidiness for a healthy daemon, not a liveness backstop — reading it as one is what produced this entry.                                                                                                                                                                                                                                                                                                                                                  |

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

**Do not merge this with shutdown quiescence**, however alike the one-sentence summaries read. One is a
process-lifetime guarantee whose whole premise is that the closer may already be dead; the other
requires closing synchronously and then draining what acquired before the close. A shared primitive
would have to satisfy both, and their requirements are opposites.

---

## Durable state with no lifecycle owner

|                                                                      |                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`export-lifetime.md`](./export-lifetime.md)                         | Nothing prunes `~/.coral/exports/jobs/`. Ever — the retention setting's own doc comment says otherwise. Part 1 gives it a retention authority; part 2 is archived-session restore, whose real question is answerable only once part 1 exists. |
| [`coordinator-socket-identity.md`](./coordinator-socket-identity.md) | The socket path falls back through `TMPDIR`, so two processes with one state root can both bind. Two coordinators over one journal. The **provider endpoint resolver has the same fallback** — fix both together. Small, independent.         |

---

## Wire contracts

|                                                                              |                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`jobs-read-contract-schema-first.md`](./jobs-read-contract-schema-first.md) | `jobs.list` and `jobs.detail` cross four boundaries with no response schema. The field that motivated it stopped crossing the wire while it sat open; the boundary is the defect, not the field. |
| [`result-artifact-availability.md`](./result-artifact-availability.md)       | **Re-score before starting.** The symptom that motivated it was fixed by a ten-line change (#314); what remains has never been observed and costs a protocol transition.                         |

---

## Design record, not open work

|                                                        |                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| [`store-format-routing.md`](./store-format-routing.md) | **Dormant.** Its one live defect was extracted to `coordinator-socket-identity.md`. Read it as a design record. |

---

---

## Environment, not Coral

|                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sandboxed hooks cannot find the backend bundle.** 252 occurrences of `Cannot find module '/tmp/coral-hooks-<rand>/plugin-root/bridge/coral-backend.cjs'` in one coordinator log. Neither `coral-hooks` nor that path shape exists anywhere in this repository or in a built bundle, so the mirrored plugin root is the host harness's, and it omits `bridge/`. The hooks fail open, so nothing breaks — but every occurrence is a spawned process that dies, and the noise buries real errors in the same log. Worth a line in `docs/hooks.md` about what a hook may assume about its plugin root, and worth confirming against the harness rather than guessing. |

---

## How to add an entry

State the problem with file:line evidence, the decision already made, what is explicitly out of scope,
and what would have to be true to start. Then check this index: if the new entry shares a missing
concept with an existing one, put it in that group and say how they interact — including whether they
can ship together. Most of the damage in the last rewrite came from entries that were individually
correct and collectively contradictory.
