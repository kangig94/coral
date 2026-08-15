# TODO — `~/.coral/exports/jobs/` has no lifecycle owner

**Status**: open. Consolidated 2026-08-15 from `persistent-job-export-retention.md` and
`archived-session-restore.md`. Those two documents asserted **opposite facts about the same directory**;
the merge exists so that cannot happen again.

## The fact both documents disagreed about

Nothing prunes `~/.coral/exports/jobs/<id>/`. Ever.

`CORAL_JOBS_RETENTION_DAYS` prunes `progressStore.jobDir(id)`, which `src/jobs/paths.ts:9-11` defines as
`<tmpdir>/coral-jobs/<id>` — temporary scratch — plus the job's durable CLI-process metadata row
(`src/coordinator/lifecycle.ts` → `src/jobs/runtime-meta-store.ts`, a `DELETE FROM meta`).

The export tree is `runtime.paths.coral.exports.jobsRoot`, a different root. A repository-wide search
found no removal targeting it.

The retention document eventually recorded this correctly. The archive-restore document recorded the
inverse — that the archive is pruned on the first boot after any version change, giving a restore window
of "until the next upgrade" — and built a blocking design question on top of it. That question was
answering a constraint that does not exist.

## What follows from getting the fact right

The design pressure inverts. It is not "restore before it vanishes"; it is "this accumulates forever
with no owner". Two consequences:

- **Disk and privacy.** An operator shortening retention for either reason keeps every job result
  indefinitely, including provider artifacts archived beside them. The setting's name implies otherwise.
- **Restore is unblocked, but second in line.** Archived-session restore's real load-bearing question is
  _who owns a restored file and what ends it_ — which is answerable by lookup once this directory has a
  lifecycle authority, and is guesswork before that.

## Part 1 — retention authority

Decide who owns the export tree's lifetime, then implement it. The decision is genuinely a product one,
because the content is user data:

- Does the existing `CORAL_JOBS_RETENTION_DAYS` extend to cover exports, or does exports get its own
  setting? Extending changes the meaning of a setting operators have already tuned.
- Does pruning an export require the job to be terminal _and_ aged, as scratch cleanup does?
- What happens to a provider artifact archived beside a result — same lifetime, or its own?

The documentation must be corrected in the same change. It said the wrong thing for two review rounds
before anyone checked, and elaborating on a false claim is how it survived that long.

## Part 2 — archived session restore

**Half already ships.** Coral removes the provider's native session file after a Coral-launched run,
because leaving it in place fills the provider's own interactive `/resume` picker with sessions that
were never a person's working session — a real UX regression in a tool Coral does not own. Before
removing it, Coral preserves it. That preservation has been shipping since at least 2026-06-28.

What does not exist is the restore direction: taking a preserved file and putting it back so the
provider can resume it.

Its open questions, with the false constraint removed:

1. **Who owns a restored file, and what ends it?** Restoring re-creates exactly the picker pollution the
   removal exists to prevent. Answerable once Part 1 defines lifetime authority.
2. **What does the operator name?** A job id, a session id, or a picker of preserved sessions.
3. **What happens if the provider's own store has moved on** — same session id present, different
   content.

## Ship as two PRs, in order

Part 1 is a cleanup policy. Part 2 is a new user-facing verb. They do not belong in one change, and
Part 2's first question is guesswork until Part 1 lands.

## Explicitly out of scope

The journal, the store fingerprint, and what `result.md` contains. This is only about how long the
exported tree lives and who says so.

## Start condition

Part 1 needs the product decisions above answered. Part 2 needs Part 1.
