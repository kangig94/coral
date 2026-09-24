# TODO — provider session files retention never names

**Status**: open, scope settled 2026-09-24. Reported as "the provider session log sometimes stays in
`~/.codex/sessions` instead of moving into `~/.coral`"; measured 2026-09-23 on the author's host.

## The fact

Retention discards exactly the one artifact it can locate for a session. `collectArtifactHandles`
(`src/sessions/artifact-discard.ts`) returns `entry.artifactHandles`, falling back to a **single**
`locateArtifact` from `entry.conversationRef`. Anything a provider writes beside or beneath that file is
never named, so it is neither archived nor discarded. Two kinds exist:

- **Codex forks.** A session the provider forks during a job gets its own thread id and rollout file.
  `isCodexRolloutFile` (`src/providers/codex/artifacts.ts`) matches only the session's own id. Of 200
  sampled forks still on disk, none has a row in `projection_sessions`.
- **Claude `tool-results`.** Claude writes large tool outputs to a sibling directory named for the
  session, `<projectDir>/<conversationRef>/tool-results/`. The claude discard removes
  `<conversationRef>.jsonl` and leaves the directory.

No Coral claude session has a `subagents/` directory, so claude has no fork residue.

## Measured

Codex, `~/.codex/sessions`, 6,493 rollout files present. The first archived rollout is dated
2026-08-14, which bounds the window in which retention was operating.

| originator | `source` | before 08-14 | from 08-14 |
| --- | --- | ---: | ---: |
| `coral` | `subagent` | 76 | **899** |
| `coral` | `vscode` | 1,105 | 70 |
| others (the user's own codex runs) | — | 4,312 | 27 |

Claude: **124 of 124** Coral claude sessions whose retention completed still have
`<conversationRef>/tool-results/` — 340 files, 27 MB. In every one the primary `.jsonl` is gone.

## Two things this is not

**Archive-then-discard is not failing.** 6,471 archive manifests (6,169 codex, 302 claude), every record
`status: "archived"`, and zero archived handles still on disk.

**The 70 unarchived `coral` primary rollouts are not a gap.** All 70 have `projection_sessions` rows; 62
are `session-retention-work` quarantine rows under the binding refusal owned by
[`quarantine-terminal-without-session.md`](./quarantine-terminal-without-session.md). The rest are live or
never retained.

## Settled

- **Both kinds are discarded, never archived** (repository owner, 2026-09-23 and 2026-09-24). A fork is a
  child of a transcript already kept. `tool-results` holds out-of-line tool output the kept transcript
  refers to; the archive loses that content, and nothing restores or prunes the archive, so preserving
  it buys nothing.
- **The accumulated backlog is a separate job after this one.** It reuses this discovery; see below.

## Design

**Residue never enters the handle set.** `continuation.handles` drives both halves of retention: the
descriptor derived from it decides what is archived, and `assertContinuationDescriptor` re-derives that
descriptor on recovery and refuses a mismatch. Putting residue into `handles` would archive it. A
separate field is not available either: `retentionDiscardContinuationSchema`
(`src/sessions/retention-work.ts`) is `.strict()` at `v: 1`, so a new key is fatal to an older reader and
would need a new generation at a new address
([`design-philosophy`](../../.claude/rules/design-philosophy.md) §10).

**Instead, residue is re-derived at every attempt and discarded before completion.** Discovery runs after
the primary discard and before `appendRetentionDiscardCompleted`. A crash anywhere earlier re-runs
`enforceRetention` from its continuation, which re-derives the residue and discards what is still there,
so no durable record of the residue is needed. The completed event's `handles` may list it, since that
field already means what was discarded.

**Codex discovery walks down from the root id, and deletes leaves first.** The walk needs the session's
own thread id (`entry.conversationRef`, durable), not its file: collect rollouts whose
`payload.source.subagent.thread_spawn.parent_thread_id` is the root, then those whose parent is one of
those, and so on. Because a child is found through its parent's id, a fork deleted before its own child
would strand that child on the next attempt, so discard runs deepest first.

**Claude discovery is a path, not a walk.** The directory is the primary handle with `.jsonl` removed. It
is removed only when its name is the session's `conversationRef` and it sits beside that primary.

**Evidence and refusal.** Each deletion rests on what the primary discard already rests on: a
provider-written identity tying the file to this session (a lineage field for codex, the directory name
for claude), under the same `bound` provider `readyBoundProvider` verified for this session. The binding
refusal therefore applies to residue exactly as it does to the primary. A rollout header that cannot be
read is unknown and is not deleted — which also leaves its descendants, the safe direction.

**Both entry points.** `enforceRetention` handles job retention. `discardSessionArtifacts` handles
on-demand discard for discuss synthesis (`finalizeSynthesizedSession`, through a composed callback the
call graph does not resolve). Codex discuss participants can fork, so both need the same step.

### Where the cost is

- **Codex headers are large.** The first record carries the full `base_instructions`, tens of kilobytes
  per file. Scanning every rollout per retention is not acceptable; restrict the scan to the date
  directories spanning the job, and cache parsed parents per path — a `session_meta` record is written
  once and never changes.
- **The locator cannot read.** `CodexArtifactLocatorStorage` is `existsSync` and `readdirSync` only; a
  bounded first-record read is a new capability on that port.
- **Claude needs a directory removal.** `discardRecordedArtifacts` (`src/providers/capability.ts`)
  unlinks files and validates nothing. A recursive removal is a new storage operation and must be pinned
  to the one derived path.

## The backlog — separate, after this

Retention for these sessions is already terminal, so `hasTerminalRetentionDiscardOutcome` returns before
any discovery runs and nothing will ever revisit them. They are reachable: the codex walk needs only the
root id, which `projection_sessions` still holds, and the claude path derives from it. What is missing is
a sweep over sessions whose retention completed, gated by the same binding check — so the 63 sessions
under the account-mismatch refusal will refuse here too.

## Correction to a neighbouring entry

[`export-lifetime.md`](./export-lifetime.md) cites the archive location as
`exports.jobsRoot/<jobId>/artifacts/<provider>/actions/<archiveActionId>/`. The directory is
`provider-artifacts`, not `artifacts`. The claim it supports is unaffected.

## Start condition

None. Codex forks and claude `tool-results` ship together; the backlog sweep follows.
