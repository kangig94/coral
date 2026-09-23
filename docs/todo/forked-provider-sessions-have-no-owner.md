# TODO — a session forked inside a job is owned by nobody

**Status**: open. Measured 2026-09-23 on the author's host, reported as "the provider session log
sometimes stays in `~/.codex/sessions` instead of moving into `~/.coral`".

## The fact

Retention treats a job as owning exactly one provider session. A session the provider forks **during**
the job gets its own conversation id and its own rollout file, and Coral never learns it exists — so it
is neither archived into the export tree nor discarded from the provider's own directory. It is not a
failed archive. It is a file no code path ever names.

Of 200 sampled forked rollouts still on disk, **none** has a row in `projection_sessions`. The session
domain has no record of them at all.

## Why no handle can name one

`collectArtifactHandles` (`src/sessions/artifact-discard.ts`) returns `entry.artifactHandles`, and when
that list is empty falls back to a **single** `locateArtifact` resolved from `entry.conversationRef`.
Both providers resolve exactly one file from exactly one conversation:

- `isCodexRolloutFile` (`src/providers/codex/artifacts.ts`) matches `rollout-*-${threadId}.jsonl`,
  keyed on the session's own thread id;
- `locateClaudeJsonlArtifact` (`src/providers/claude/artifacts.ts`) resolves one file from one
  `conversationRef`.

`archiveProviderArtifactsForJob` (`src/sessions/provider-artifact-archive.ts`) then iterates
`descriptor.handles` — whatever that set contains and nothing else. A fork's thread id is not the
parent's, so no locator can reach it and no handle records it.

The lineage exists in the artifact and is never read. A codex fork's first record carries
`payload.source.subagent.thread_spawn` with `parent_thread_id`, `depth`, and `agent_nickname`. A
repository-wide search for `forked_from`, `forkedFrom`, and `originator` in `src/` returns nothing:
Coral does not read the field that would let it find its own descendants.

## Measured

`~/.codex/sessions`, 6,493 rollout files present (9 with an unparseable or non-`session_meta` head).
The archive's own date range gives the window in which this feature was operating: first archived
rollout 2026-08-14.

| originator | `source` | present, before 08-14 | present, from 08-14 |
| --- | --- | ---: | ---: |
| `coral` | `subagent` | 76 | **899** |
| `coral` | `vscode` | 1,105 | 70 |
| `codex_exec` | `exec` | 2,184 | 2 |
| `codex-tui` | `subagent` | 1,304 | 0 |
| `codex_exec` | `subagent` | 681 | 0 |
| `codex-tui` | `cli` | 126 | 25 |
| `codex_vscode` / `codex_cli_rs` | `vscode` / `cli` | 12 | 0 |

Only the `coral` rows are Coral's obligation; the rest belong to the user's own codex invocations. In
the active window that is **899 forks** left behind.

## Two things this is not, both of which were checked

**Archive-then-discard is not failing.** 6,471 archive manifests (6,169 codex, 302 claude); every
artifact record carries `status: "archived"`; and the intersection of archived source handles with files
still present on disk is **zero**. The two-action retention does what it says.

**The 70 unarchived `coral` primary rollouts are not a second gap.** All 70 resolve to rows in
`projection_sessions`, and **62 of them are `session-retention-work` quarantine rows** holding the
documented refusal `Retention provider binding is unavailable for session <id>` — the ChatGPT-account
mismatch already owned by
[`quarantine-terminal-without-session.md`](./quarantine-terminal-without-session.md). That boundary
stood at 8 rows when it was re-measured on 2026-09-01 and stands at **63** now (62 `active`, one
`continuation`), detected between 2026-08-15 and 2026-09-17. Its open question — that the producer was
never addressed, only the rows — is answered here with a rate. Do not re-open it in this entry; the
remaining 8 of the 70 are live or never-retained sessions and are not evidence of anything.

So the gap is forks, and only forks.

## Settled: a fork is discarded, never archived

Decided 2026-09-23 by the repository owner. A subagent transcript is a child of a transcript Coral
already keeps; a child of a child has no independent value worth preserving. Retention for a fork is the
discard half alone.

Two consequences, and the second is the whole remaining design.

**This entry no longer touches the export tree.** Archiving 899 rollouts per window into
`~/.coral/exports/jobs/` was the interaction with [`export-lifetime.md`](./export-lifetime.md); with
archiving withdrawn, the two entries are independent and ship in either order.

**The discovery route is now the entire safety argument.** `discardRecordedArtifacts`
(`src/providers/capability.ts`) unlinks every handle it is given and validates nothing — its only
contract is best-effort retry until the paths are gone. Nothing downstream can refuse a path that should
not have been there, so whatever puts a fork into the handle set is the sole thing standing between a
lineage claim and an irreversible delete. Principle 11: a deletion is a finalization and must cite
decisive evidence for the exact obligation it discharges.

## The route: scan the provider session directory at terminal

Two routes were open. Under discard-only the second is the one to build.

**Rejected as a prerequisite — app-server fork events.** The provider reports each fork as it happens and
the session records a handle then, which is the same evidence a handle carries today. It costs a
protocol dependency per provider (not verified as available for either), and it only sees forks made
while Coral is watching, so a job that crashes mid-fork leaves the same residue this entry is about. It
remains available later as a precision improvement; it is not needed to start.

**Chosen — walk the lineage at terminal.** Scan the provider's session root for artifacts whose lineage
chain roots at the job's own conversation, and add them to the handle set the existing discard already
consumes. For codex the field is `payload.source.subagent.thread_spawn.parent_thread_id` in the rollout's
first record; the sessions root is `join(access.home, 'sessions')`, which `locateCodexRolloutArtifact`
already scans.

Two reasons this clears the bar discard-only raises:

- **Its evidence is the class already trusted to delete.** The current discard reaches the primary file
  through `isCodexRolloutFile` (`src/providers/codex/artifacts.ts`), which matches a thread id the
  provider wrote into the filename. A `parent_thread_id` the provider wrote into the same artifact is
  not weaker evidence than a thread id the provider wrote into the same artifact's name.
- **At terminal the tree is still intact, so the walk terminates.** The 1,119 forks measured with an
  unarchived parent are accumulated residue, not a property of the walk: nothing has been discarded yet
  when the walk runs, so a fork of a fork reaches the job's conversation through intermediates that are
  all still present. That figure argued against this route and does not.

The binding refusal applies unchanged and must be inherited, not bypassed. A fork is discarded under its
parent's provider binding, so a session whose account has since changed refuses for its descendants for
the same reason it refuses for itself — the `session-retention-work` path in
[`quarantine-terminal-without-session.md`](./quarantine-terminal-without-session.md). A fork must not
become a way to delete a provider file under a login Coral cannot verify.

## The handle set now carries two classes, and that is where the cost is

Discard-only does not simplify the insertion. `collectArtifactHandles` has exactly two callers —
`LifecycleReactor.discardSessionArtifacts` and `LifecycleReactor.enforceRetention` — but
`enforceRetention` reaches 57 callees and routes every handle through `archiveArtifactsBeforeDiscard`,
continuation persistence, quarantine, and the retention outbox. A fork that must be discarded **without**
being archived is a second class inside a set that is currently uniform, so the split has to be
represented in the handle type rather than decided by a branch inside that function. Expect the design
cost to land there, not in the directory scan.

**The claude half is unscoped.** Codex lineage is established
(`payload.source.subagent.thread_spawn.parent_thread_id`). A sampled claude session record carries only
`sessionId`, `type`, `timestamp`, `content`, and `operation` — no parent or sidechain field was found,
and whether claude forks at all under Coral was not established. 302 claude archives exist, so the
provider is in use. Scope the codex half first and answer the claude question before assuming symmetry.

## Still open — the accumulated backlog

The fix stops production; it reclaims nothing. 899 post-feature `coral` forks and 76 from before it
remain, and their parents are already gone, so the terminal-time walk will never see them. Whether a
one-time sweep is offered, and on what evidence when the parent no longer exists to root the chain, is
not decided here and is not a prerequisite.

## Correction to a neighbouring entry

[`export-lifetime.md`](./export-lifetime.md) cites the archive location as
`exports.jobsRoot/<jobId>/artifacts/<provider>/actions/<archiveActionId>/`. The directory is
`provider-artifacts`, not `artifacts`; no path of the cited form exists. The claim that entry makes with
it — that archived provider artifacts inherit the export tree's absent lifetime — is unaffected and
still true.

## Start condition

None. The counts are reconciled, the two competing explanations are eliminated, retention is decided,
and the route follows from it. The backlog question above is separable and does not gate the fix.
