# Open work

Each file here records something deliberately **not** done, and why. Written at the moment the decision
was made, so the reasoning survives the session that produced it.

Grouped by the concept whose absence produced the members — not by which command or file they touch.
Two entries that look alike often need opposite fixes, and two that look unrelated often close together.

Rewritten 2026-08-15 after a consolidation pass found eleven entries had drifted into fragments: two
asserted opposite facts about one directory, one had scoped its own reported symptom out of bounds, one
was built on a cause that had been inferred rather than reproduced, and a live defect was buried inside
a document about an unplanned feature.

---

## Build identity — one build's records read by another

|                                                                    |                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`build-identity-and-upgrade.md`](./build-identity-and-upgrade.md) | **Re-scored down.** Updating the plugin swaps CLI and skills immediately while the running coordinator does not swap, so two builds are live at once. Nothing has been observed to break because of it — the 2026-08-15 job losses it was written for were a single-build defect (#318), not skew. |

Its first half — a record this build cannot parse must not become a job this build destroys — shipped
as #316. What remains splits in two: the **record** direction shares a compatibility policy with
[`jobs-read-contract-schema-first.md`](./jobs-read-contract-schema-first.md) and
[`result-artifact-availability.md`](./result-artifact-availability.md), settle it once across all
three; the **output** direction — a live session holding old skill text driving a new CLI — has no
defense today and is what actually blocks the `wait` change below.

Read its correction section before citing it. It named a cause it had inferred from a bundle-string
diff rather than reproduced, which is the same defect this index was rewritten to remove.

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

|                                                          |                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`job-scope-containment.md`](./job-scope-containment.md) | Authorization already decides against the directory the work happens in; the durable record takes the shell's cwd instead. Record the former, and compare by containment rather than equality. Must land before the jobs read contract — a consumer inventory cannot be audited while the values move. |

---

## Provider proxy

|                                                                                            |                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`proxy-set-acquisition.md`](./proxy-set-acquisition.md)                                   | Acquisition fails on an exact-equality comparison of `processStartedAtSeconds` across a spawn. A three-second skew is enough, which is the most plausible reason two machines on one build behave differently. |
| [`provider-operation-shutdown-quiescence.md`](./provider-operation-shutdown-quiescence.md) | Shutdown fences only part of the mutation surface.                                                                                                                                                             |

---

## Containment that outlives its enforcer

|                                                                                  |                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [`kb-daemon-independent-containment.md`](./kb-daemon-independent-containment.md) | The KB daemon has no enforcer outside its own process. |

**Do not merge this with shutdown quiescence**, however alike the one-sentence summaries read. One is a
process-lifetime guarantee whose whole premise is that the closer may already be dead; the other
requires closing synchronously and then draining what acquired before the close. A shared primitive
would have to satisfy both, and their requirements are opposites.

---

## Durable state with no lifecycle owner

|                                                                      |                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`export-lifetime.md`](./export-lifetime.md)                         | Nothing prunes `~/.coral/exports/jobs/`. Ever. Part 1 gives it a retention authority; part 2 is archived-session restore, whose real question is answerable only once part 1 exists. |
| [`coordinator-socket-identity.md`](./coordinator-socket-identity.md) | The socket path falls back through `TMPDIR`, so two processes with one state root can both bind. Two coordinators over one journal. Small, independent.                              |

---

## Wire contracts

|                                                                              |                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`jobs-read-contract-schema-first.md`](./jobs-read-contract-schema-first.md) | `jobs.list` and `jobs.detail` cross four boundaries with no response schema.                                                                                             |
| [`result-artifact-availability.md`](./result-artifact-availability.md)       | **Re-score before starting.** The symptom that motivated it was fixed by a ten-line change (#314); what remains has never been observed and costs a protocol transition. |

---

## Design record, not open work

|                                                        |                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| [`store-format-routing.md`](./store-format-routing.md) | **Dormant.** Its one live defect was extracted to `coordinator-socket-identity.md`. Read it as a design record. |

---

## How to add an entry

State the problem with file:line evidence, the decision already made, what is explicitly out of scope,
and what would have to be true to start. Then check this index: if the new entry shares a missing
concept with an existing one, put it in that group and say how they interact — including whether they
can ship together. Most of the damage in the last rewrite came from entries that were individually
correct and collectively contradictory.
