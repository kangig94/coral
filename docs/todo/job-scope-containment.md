# TODO — a job's scope should be containment over the directory it worked in

**Status**: open. **Rewritten 2026-08-15.** The previous version (`job-project-scope-from-work-dir.md`)
identified the right value and then invented two blocking questions that a pioneer pass dissolved. Both
are recorded below, because the mistake is instructive: the questions came from keeping _equality_ as
the comparison.

## The defect

One launch request carries two answers to "which project is this job for".

`src/transport/dispatch.ts` already splits them: `projectRoot` is the CLI's cwd, and
`authorizationRoot` is the `workDir` when one was given. The **capability decision is made against
`authorizationRoot`** — the directory the provider will actually run in. That value is then bound as the
session's `cwd` (`src/coordinator/services/job-launch.ts`).

But the durable job record takes the other one. `src/coordinator/services/job-launch.ts`'s `start` method passes `projectRoot: ctx.projectRoot`
into the launch record, and that becomes `projection_jobs.project_root`. So authorization says the job
belongs to where the work happens, and the record says it belongs to where the shell happened to be.

They differ exactly when `--work-dir` names something other than the caller's cwd — and the documented
usage in `docs/skills.md` and the `ralph` skill instructs precisely that, then instructs a `wait` that
cannot find the job it just created.

### The initial launch record is one of three

All three launch paths reach the same builder, `buildProviderLaunch` (`src/jobs/shell/launch.ts`),
and all three pass `ctx.projectRoot` into it:

| Launch path          | Call site                                                   | Orchestrator entry                                       |
| -------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| initial provider job | `src/coordinator/services/job-launch.ts`'s `start`          | `launchInitialProviderJob` (`src/jobs/shell/launch.ts`)  |
| workflow replacement | `src/coordinator/services/job-launch.ts`'s `resumeResolved` | `launchWorkflowReplacement` (`src/jobs/shell/launch.ts`) |
| resumed provider job | `src/coordinator/services/job-launch.ts`'s `resumeResolved` | `launchResumedProviderJob` (`src/jobs/shell/launch.ts`)  |

An earlier revision named only the initial-launch call site above. A fix applied there alone would leave every resumed and every
workflow-replacement job still recorded against the shell's cwd — the same defect on two of three
paths, and the two a long-running workflow spends most of its life on.

## The two fixes, and they are one concept

**1. Record the directory the work happened in.** The three launch call sites take `cwd` instead of
`ctx.projectRoot`. Value-only: no DDL, no Zod contract change, therefore no store fingerprint move and
no store reset.

The builder already wants the right value. `buildProviderLaunch` computes
`opts.projectRoot ?? request.cwd ?? ''` (`src/jobs/shell/launch.ts`) — `request.cwd` **is** the work
directory, and it is already second in that chain. The fallback never fires only because all three
callers supply `opts.projectRoot` explicitly, and `launchWorkflowReplacement` types it as required
(`src/jobs/shell/launch.ts`) so it cannot even be omitted. Decide deliberately between dropping the argument and
letting the existing fallback carry it, or passing `cwd` at each call site; the first is smaller but
makes an implicit chain load-bearing.

Do **not** change the other five `ctx.projectRoot` uses in `src/coordinator/services/job-launch.ts`. Enumerated, because the
earlier revision counted three and there are eight in total:

| Method                     | Use                                            | Verdict                                                  |
| -------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `start`                    | agent profile resolution                       | leave — wants the operator's configuration root          |
| `start`                    | `const cwd = input.cwd ?? ctx.projectRoot`     | leave — this is the fallback that _defines_ the work dir |
| `start`                    | session record                                 | leave until something forces it                          |
| `start`                    | **initial launch record**                      | **change**                                               |
| `resume`                   | agent profile resolution                       | leave — same as `start`, above                           |
| `buildContinuationProfile` | base for `canonicalizeWorkDir(session.cwd, …)` | leave — a resolution base, not a recorded value          |
| `resumeResolved`           | **workflow-replacement launch record**         | **change**                                               |
| `resumeResolved`           | **resumed launch record**                      | **change**                                               |

While in there: `launch.ts` reads the value back inconsistently for event metadata — the calls inside
`launchInitialProviderJob` and `launchResumedProviderJob` use the builder's result, the one inside
`launchWorkflowReplacement` uses `opts.projectRoot` directly. They agree today only because the
argument is always supplied. Whichever branch fix 1 takes, make all three read the same source.

Do **not** rename the column. `project_root` is misnamed — it is a work root — but a column rename moves
the store format fingerprint and becomes a destructive reset. That debt is cheap to carry and expensive
to pay.

**2. Compare by containment, not equality.** `scopeCheckJobs`
(`src/coordinator/composition/job-control.ts`) tests `status.projectRoot !== projectRoot`. The
predicate it should use already exists and is already used for exactly this question on the
child-principal path: `containsProjectRoot` (`src/security/policy/authorize.ts`).

That predicate is **module-private** — `authorize.ts` does not export it. Reusing it means exporting it
or moving it to a lower owner; do not copy it, since a second containment predicate is exactly the
"one concept, two homes" this repository forbids. Note also that `scopeCheckJobs` already carries one
deliberate exemption (`jobKind === 'kb'`, which belongs to no project); containment must be applied
without disturbing it.

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
provider-host `--work-dir` resolver (`src/cli/commands/backend.ts`), which is a different
selector over a live inventory and is correctly documented.

## Also fix here

`docs/skills.md` and the `ralph` skill instruct `--work-dir "<project root>"` followed by a `wait`.
Following that from another directory produces a job the same skill cannot wait on. Whatever lands, the
skill text must stop implying `--work-dir` selects the project. `jobs detail` also prints `Project:`
without ever showing the directory the provider ran in, so nothing on screen explains a mismatch.

## Start condition

None. Both blocking questions were removed by the containment reframing. The test that pins it: launch
with an explicit `--work-dir`, then wait on the job from that same directory — the case that fails
today — plus a subdirectory case that proves containment addresses it from the parent.
