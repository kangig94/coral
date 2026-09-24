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

**The 70 unarchived `coral` primary rollouts are not a gap.** All 70 have `projection_sessions` rows in
the flat pre-epoch store; 62 are `session-retention-work` quarantine rows under the binding refusal owned
by [`quarantine-terminal-without-session.md`](./quarantine-terminal-without-session.md). The rest are live
or never retained.

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
read, or whose `payload.id` differs from the id in its filename, is unknown and is not deleted — which also
leaves its descendants, the safe direction. Claude's tree removal re-checks each directory with `lstat` at
the moment it descends, so an entry replaced by a link mid-walk is removed as a link, never followed.

**Retention only — not the on-demand discard.** `enforceRetention` runs the step after the primary discard
applies, and also when no primary could be located (`skipped_no_handles`), since a conversation can have
residue without a surviving primary. Retention is safe to delete in because a pending discard request
blocks resume until it completes. `discardSessionArtifacts`, the on-demand discard behind discuss
synthesis, has no such exclusion: a concurrent resume can spawn a fork that descends from the same
conversation while the walk runs. It therefore does **not** discard residue, and a codex discuss
participant's forks stay on disk. Excluding resume there is the precondition for adding it.

**The resume block has to be current, not merely recorded.** A crash between an answered attempt — the
`skipped_protected` completion — and clearing its continuation recovers that continuation with its request
already answered, which no longer holds resume back. `enforceRetention` therefore restarts such a
continuation as a fresh attempt, whose new request commits before any discard
(`hasRetentionDiscardAttemptOutcome` in `src/sessions/retention-outbox.ts`). This hole predates residue: it
exposed the primary discard the same way.

**Threat model for path races.** Deletion resolves each directory with `realpath` at the moment it acts —
codex against the sessions root, claude against the conversation directory — and removes a link as a link.
What remains is the interval between that resolution and the unlink: a concurrent process swapping a
directory for a link inside it. That process must run as the same user with write access to the same
tree, so it could delete the target directly and gains nothing; closing the interval fully needs
directory-relative `unlinkat`, which Node does not expose. It is out of scope, not unexamined.

**Residue is not retried.** A residue read or delete failure is logged and retention still completes, so
that session is never revisited. Keeping a file is the safe direction; what is kept joins the backlog.

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

## The backlog — a temporary script, not product code

Retention for these sessions is already terminal, so `hasTerminalRetentionDiscardOutcome` returns before
any discovery runs and nothing will ever revisit them. They are reachable: the codex walk needs only the
root id, which `projection_sessions` still holds, and the claude path derives from it.

`clients/scripts/sweep-provider-session-residue.mjs` reclaims them, and is removed at 0.11.0. It is a
dry run unless given `--apply`. Its roots are sessions whose retention completed with outcome
`discarded` — never `skipped_protected`, which is a session the user asked to keep — and it reads every
store generation on disk, because the flat pre-epoch `store/store.db` holds almost all of them: 0.10.11
started a fresh epoch-1 with no data carried forward ([`no-store-migration-path.md`](./no-store-migration-path.md)).
A claude directory is reclaimed only once its transcript is already gone, and a codex root only once its own
rollout is. A completed discard does not retire a session: it stays `ready` and the live coordinator can
claim it for a new resume, so `--apply` refuses while the coordinator runs — every claim goes through it —
checking at start and again just before deleting. A discovery record it cannot read counts as running.

Measured by its dry run on 2026-09-24: 6,476 discarded roots (6,397 in the flat store, 79 in epoch-1),
872 codex forks totalling **2.15 GB**, and 127 claude conversation directories (343 files, 27.1 MB). The
codex count is below the 975 `coral` forks on disk because a fork whose root never completed a
`discarded` retention — quarantined, still resumable — is not reachable from any root, which is the
intent.

## Correction to a neighbouring entry

[`export-lifetime.md`](./export-lifetime.md) cites the archive location as
`exports.jobsRoot/<jobId>/artifacts/<provider>/actions/<archiveActionId>/`. The directory is
`provider-artifacts`, not `artifacts`. The claim it supports is unaffected.

## Start condition

None. Codex forks and claude `tool-results` ship together; the backlog sweep follows.
