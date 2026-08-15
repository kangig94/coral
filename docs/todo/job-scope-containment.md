# TODO — a job's scope should be containment over the directory it worked in

**Status**: open. **Rewritten 2026-08-15.** The previous version (`job-project-scope-from-work-dir.md`)
identified the right value and then invented two blocking questions that a pioneer pass dissolved. Both
are recorded below, because the mistake is instructive: the questions came from keeping _equality_ as
the comparison.

## The defect

One launch request carries two answers to "which project is this job for".

`src/transport/dispatch.ts:310-343` already splits them: `projectRoot` is the CLI's cwd, and
`authorizationRoot` is the `workDir` when one was given. The **capability decision is made against
`authorizationRoot`** — the directory the provider will actually run in. That value is then bound as the
session's `cwd` (`src/coordinator/services/job-launch.ts:119`).

But the durable job record takes the other one. `job-launch.ts:175` passes `projectRoot: ctx.projectRoot`
into the launch record, and that becomes `projection_jobs.project_root`. So authorization says the job
belongs to where the work happens, and the record says it belongs to where the shell happened to be.

They differ exactly when `--work-dir` names something other than the caller's cwd — and the documented
usage in `docs/skills.md` and the `ralph` skill instructs precisely that, then instructs a `wait` that
cannot find the job it just created.

## The two fixes, and they are one concept

**1. Record the directory the work happened in.** `job-launch.ts:175` takes `cwd` instead of
`ctx.projectRoot`. Value-only: no DDL, no Zod contract change, therefore no store fingerprint move and
no store reset.

Do **not** change the other three `ctx.projectRoot` uses in that file. `:107` and `:217` resolve the
agent profile — they want the operator's configuration root, which is genuinely the invocation
directory. `:146` is the session record; leave it until something forces it.

Do **not** rename the column. `project_root` is misnamed — it is a work root — but a column rename moves
the store format fingerprint and becomes a destructive reset. That debt is cheap to carry and expensive
to pay.

**2. Compare by containment, not equality.** `scopeCheckJobs`
(`src/coordinator/composition/job-control.ts:96`) tests `status.projectRoot !== projectRoot`. The
predicate it should use already exists and is already used for exactly this question on the
child-principal path: `containsProjectRoot` (`src/security/policy/authorize.ts:98`).

Apply containment to `scopeCheck` **only** — not to the `jobs list` filter
(`src/jobs/read-queries.ts`). Naming a job id is an explicit act; listing is ambient, and `cd /` must
not list the world. Fix 1 alone already repairs listing.

## The two questions the previous version got stuck on, and why they dissolve

It recorded that two things had to be settled before starting:

> **(a)** record the work directory or its enclosing project? A `--work-dir` pointing at a subdirectory
> would otherwise register a new "project" per subdirectory and fragment `coral jobs`.
>
> **(b)** mixed-vintage listings — rows written before and after the change group differently for the
> retention window.

Both are artifacts of equality. Under containment:

- **(a)** dissolves: a job recorded at `/repo/sub` is addressable from `/repo`, because `/repo` contains
  it. There is no fragmentation to prevent.
- **(b)** dissolves: containment is a strict superset of equality. Every job reachable before remains
  reachable, and some become reachable that were not. Nothing regroups, nothing needs read-time
  reconciliation, and no migration exists to write.

## Explicitly out of scope

The capability model, the child-principal binding rules, `scopeCheck` as a mechanism, and the
provider-host `--work-dir` resolver (`src/cli/commands/backend.ts:408-420`), which is a different
selector over a live inventory and is correctly documented.

## Also fix here

`docs/skills.md:42` and the `ralph` skill instruct `--work-dir "<project root>"` followed by a `wait`.
Following that from another directory produces a job the same skill cannot wait on. Whatever lands, the
skill text must stop implying `--work-dir` selects the project. `jobs detail` also prints `Project:`
without ever showing the directory the provider ran in, so nothing on screen explains a mismatch.

## Start condition

None. Both blocking questions were removed by the containment reframing. The test that pins it: launch
with an explicit `--work-dir`, then wait on the job from that same directory — the case that fails
today — plus a subdirectory case that proves containment addresses it from the parent.
