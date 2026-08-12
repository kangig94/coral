# TODO — restore an archived provider session so it can be resumed

**Status**: open, and **half-built already**. The hard half — preserving the provider's native session file
before deleting it — has been shipping since at least 2026-06-28. What does not exist is the restore
direction. Scoped on 2026-08-13 after discovering the archive while designing
[`leaked-mcp-child-reaping.md`](leaked-mcp-child-reaping.md); the two are independent.

## Why Coral deletes the native session file at all

Coral-launched provider work writes into the provider's own session store (`~/.codex/sessions/…`,
`~/.claude/projects/…`). Left in place, those files surface in the provider's own interactive resume list — run
`codex` and type `/resume` and the picker fills with child sessions that were never a person's working session.
That is a serious UX regression in a tool Coral does not own, so Coral removes what it created.

The policy is explicit, per launch:

```ts
RetentionPolicy = 'retain' | 'discard_provider_artifacts_on_terminal'   // src/sessions/entry.ts:13-17
```

Default is `'retain'` (`src/coordinator/services/job-launch.ts:127`), and `src/workflow/launch.ts:125` is the
**only** chooser of discard. So `coral-cli codex -i "…"` leaves its rollout in place and remains resumable
through the provider's own tooling; workflow-launched children are the ones that get cleaned up.

**The cost is that a discarded session cannot be resumed at all**, by Coral or by the provider. That is what
this document is about.

## What already exists

`archiveArtifactsBeforeDiscard` (`src/sessions/lifecycle-reactor.ts:818`) runs inside the retention path
*before* `discardArtifacts`, calling `archiveProviderArtifactsForJob`
(`src/sessions/provider-artifact-archive.ts:292`). It copies the file whole into:

```
~/.coral/exports/jobs/<jobId>/provider-artifacts/<provider>/
  manifest.json
  0001-rollout-<timestamp>-<threadId>.jsonl
```

Verified on disk — a real archive from 2026-06-28 holding a 2,037,256-byte codex rollout, with this manifest
entry:

```json
{
  "sourceHandle": "/home/kang/.codex/sessions/2026/06/28/rollout-2026-06-28T18-41-25-019f0d9a-….jsonl",
  "identity": { "kind": "codex-rollout", "threadId": "019f0d9a-edbe-7ee3-942f-509dfa53fb8d" },
  "sourceJobId": "cf734669-…",
  "archivePath": "/home/kang/.coral/exports/jobs/cf734669-…/provider-artifacts/codex/0001-rollout-….jsonl",
  "bytes": 2037256,
  "sha256": "cd79651d489cefe9485054bb6bebc9f7e2d6a838ed3169c4e4da7a7f89e9dbbb",
  "status": "archived"
}
```

Three questions a restore would otherwise have to solve are therefore already answered by the record:

| Question | Answered by |
| -------- | ----------- |
| Which archive belongs to this thread? | `identity` — typed, not a filename guess |
| Where did it come from? | `sourceHandle` — the exact original path |
| Did it come back intact? | `sha256` + `bytes` |

## What is missing

`provider-artifact-archive.ts` exports exactly one action — `archiveProviderArtifactsForJob`. There is no
restore, rehydrate, or unarchive. The module is one-way.

The work is to add the return direction and a surface that asks for it, so that a discarded session can be put
back where the provider looks and then resumed through the existing path (`thread/resume` for codex, which is
already what every codex turn issues — `src/providers/codex/thread-kernel.ts:832-860`).

## Design questions, in the order they bite

1. **When does a restored file get removed again?** This is the load-bearing one. Restore without a matching
   re-discard reintroduces exactly the pollution the deletion exists to prevent, and the pollution is
   cumulative. The existing retention machinery is the obvious model — a restored file is a retained artifact
   with an owner and a terminal — but "who owns a restored session, and what ends it" needs deciding before
   anything is built.

2. **The archive can vanish before it is wanted.** The whole job directory — `provider-artifacts/` included —
   is removed by `cleanupStaleJobs` (`src/coordinator/lifecycle.ts:381-414`) once the job is terminal **and**
   either aged out or written by a different bundle:

   ```ts
   const fromOldBundle = item.bundleHash !== undefined && item.bundleHash !== currentBundleHash;
   const agedOut = isAgedOut(item.updatedAt, nowMs, retentionMs);
   ```

   `retentionMs` defaults to **14 days** (`DEFAULT_JOB_RETENTION_DAYS`, overridable with
   `CORAL_JOBS_RETENTION_DAYS`). The bundle rule is the sharp one: **a terminal job's archive is pruned on the
   first boot after any Coral version change**, regardless of age. Since Coral upgrades often, the practical
   restore window is "until the next upgrade", not two weeks. Either the archive moves out of job-export
   lifetime, or the restore feature ships with that window stated plainly.

3. **Does the provider need the file at its original path?** `locateCodexRolloutArtifact`
   (`src/providers/codex/artifacts.ts:28`) finds rollouts by scanning `sessionsRoot` up to depth 4 and matching
   the thread id, which suggests codex indexes by scan rather than by an exact path. Unverified whether the
   date-shaped directory must agree with the file's contents. `sourceHandle` records the original path, so
   restoring there is always available as the conservative choice.

4. **What surface asks for a restore?** A flag on resume that pulls from the archive if the native file is
   gone, an explicit `coral-cli` verb, or automatic-on-miss. Automatic is the most convenient and the most
   dangerous: it would silently repopulate the provider's picker as a side effect of an unrelated command.

5. **Provider generality.** The archive is provider-neutral (the retention schema names both codex rollouts and
   `~/.claude/projects/…/*.jsonl`), and `identity` is a typed union. A restore built only for codex should
   still not close the door on claude.

## What partially covers this today

`hasRetentionProtection` (`src/sessions/lifecycle-reactor.ts:1104-1108`) skips discard while `activeJobId` is
set or a protective continuation lease is live. That is why a workflow's child sessions stay resumable until
the workflow concludes — the discard is *deferred*, so the native file is simply still there.

It is worth noticing what that mechanism proves: **Coral's resumability has always been file-based.** Nothing
about it depends on a provider host still running. That is also why this work is independent of
[`leaked-mcp-child-reaping.md`](leaked-mcp-child-reaping.md), whose Part B retires idle codex hosts — host
lifetime does not affect whether a session can be resumed.

## Do not re-derive these

- The archive already exists, is byte-complete, and carries identity + sha256. It is not a metadata stub.
- `provider-artifact-archive.ts` is one-way; there is no restore export to find.
- Workflow is the only launcher that chooses discard; everything else retains by default.
- Job export directories, and therefore archives, are pruned on bundle change as well as by age.
- Resumability is file-based, not host-based.
