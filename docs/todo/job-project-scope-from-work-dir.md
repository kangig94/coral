# TODO — record a job's project from where the work happens, not where the shell was

**Status**: open. Found while dispatching parallel review agents during PR #309: six jobs launched with
`--work-dir /home/kang/workspace/coral` from a scratchpad cwd became unwaitable from the directory they were
working in. Not a defect in that PR; recorded separately.

## The problem

One launch request carries two different answers to "which project is this job for", and they disagree
whenever `--work-dir` names something other than the caller's cwd.

**Authorization already answers `workDir`.** For `sessions.create` and `workflow.run`,
`src/transport/dispatch.ts:318-343` canonicalizes the request's `workDir` and returns it as the
`authorizationRoot`; `projectRoot` is used only as the base for resolving a relative `workDir`. The
capability decision at `:526-528` is therefore made against the directory the provider will actually run in.

**The durable record answers cwd.** `src/cli/dispatch.ts:476` derives `projectRoot` from `process.cwd()`, and
`buildTransportContextBody` (`:362`) puts that value on every request. The launch record stores it, so
`projection_jobs.project_root` names the shell's directory rather than the work directory. There is no
`--project-root` option on any launch command; changing the process cwd is the only way to move a job.

**The two answers then collide at `wait`.** `jobs.wait` runs `rpcPorts.jobs.scopeCheck(jobs, projectRoot)`
(`src/transport/dispatch.ts:786`) and rejects jobs whose stored `project_root` differs from the caller's, as
`scope_mismatch` / HTTP 403. A job authorized against project A and doing its work in project A cannot be
waited on from project A, because it was recorded under project B.

Observed directly: a review job launched with `--work-dir /home/kang/workspace/coral` read and reviewed that
repository, and `coral-cli jobs detail` reported
`Project: /tmp/claude-1000/-home-kang-workspace-coral/<session>/scratchpad`.

## Why this is not a security boundary today

The initial reading — that `projectRoot` is a capability binding and must not be caller-chosen — does not
hold for the top-level operator. `IPC_OPERATOR_PRINCIPAL` is `binding: { kind: 'unbound' }`
(`src/transport/ipc/server.ts:57`), and `bindingSatisfies` returns `true` for an unbound principal whose
subject is `operator` or `system` (`src/security/policy/authorize.ts:87-89`). The observed 403 came from
`jobs.scopeCheck`, a bookkeeping comparison, not from `authorize()`. Nor is cwd less caller-chosen than
`--work-dir`: `cd` is available to any caller.

Binding is enforced for child principals, whose bound root arrives on the wire
(`src/security/principal-wire.ts:66`) and is checked by `containsProjectRoot`
(`src/security/policy/authorize.ts:98-101`) against the **requested** binding — which for launches is already
the `workDir`. Deriving the recorded project from `workDir` therefore does not weaken that check; it records
the value that check already uses.

## Decision required

Make one value answer the question. The straightforward form: record the job's `projectRoot` as the
`authorizationRoot` — `workDir` when supplied, cwd otherwise — leaving cwd as the base for resolving a
relative `--work-dir`. Because the fallback already unifies the two when `--work-dir` is omitted, only the
explicit case changes.

The alternative — keep cwd as the record and add an explicit `--project-root` to the launch commands — is
worse: it adds a third input to a question that already has one too many answers, and it leaves the recorded
project disagreeing with the authorization decision.

What must be settled before implementing:

- **Whether the record should be the work directory or its enclosing project.** A `--work-dir` pointing at a
  subdirectory would otherwise register a new "project" per subdirectory and fragment `coral jobs`.
- **Mixed-vintage listings.** `projection_jobs.project_root` is durable and is not rewritten, so jobs launched
  before and after the change group differently for the retention window. Decide whether that is acceptable or
  needs a read-time reconciliation.
- **Every consumer of the value.** At minimum the `jobs list` cwd filter and its KB-job exemption
  (`src/jobs/read-queries.ts`), `jobs.scopeCheck`, `jobs.abort`, the discuss and workflow launch paths, and the
  no-coordinator `CoralStore` read surface. Enumerate them; they must move together or not at all.

## Also worth fixing here

- **The documented usage teaches the mistake.** `docs/skills.md:42` and the `ralph` skill instruct
  `coral-cli <host> -b -i "…" --work-dir "<project root>" -d` and then `coral-cli wait jobs <id>`. Following
  that from any other directory produces a job the same skill cannot wait on. Whatever is decided, the skill
  text and `docs/skills.md` must stop implying that `--work-dir` selects the project.
- **The failing input is invisible.** `formatJobDetail` prints `Project:` but never the directory the provider
  ran in (`src/cli/format/jobs.ts`), so nothing on screen explains why a job landed where it did.

## Explicitly out of scope

This item does not change the capability model, the child-principal binding rules, `jobs.scopeCheck` as a
mechanism, or the provider-host `--work-dir` resolver (`src/cli/commands/backend.ts:408-420`), which is a
different selector over a live inventory and is correctly documented in `docs/configuration.md:277`.

## Start condition

Begin after the record-vs-enclosing-project question and the mixed-vintage listing policy are decided. The
implementation must carry a test that launches with an explicit `--work-dir` and then waits on the job from
that same directory — the case that fails today — plus the full consumer enumeration above.
