# TODO — a terminal whose export was never written, and a wait event that cannot say so

**Status**: open, two members. Rewritten 2026-09-24 when the ordinary-operation symptom — "`result.md`
only appears after `wait jobs`" — was closed by routing every job-terminal commit through one post-commit
export observer. What remains is what that funnel cannot reach, and the original wait-event member.

## Member 1 — a terminal the export observer never sees

`observeTerminalResultExports` (`src/jobs/terminal/export.ts`) renders the export for every
`job.terminal.recorded` in a committed batch, and every commit path that can record a job terminal
reaches it: the `JobStore` observer slot, `coordinatorCommit`, the kb-daemon journal handler, and
provider-event application's post-`COMMIT` call. Three independent verification passes enumerated every
terminal append site and found no path that bypasses it in ordinary operation.

The observer runs **after** the commit, in the committing process, so anything that separates the two
loses the export:

- **A kb daemon that dies between its commit and its journal message.** The daemon commits through its
  own `JobStore`, whose observer only forwards the batch to the coordinator over stdout. If the daemon
  dies first, the coordinator never observes that terminal, and `failTrackedDaemonJobs`
  (`src/coordinator/composition/index.ts`) skips every job already in a terminal phase — so nothing
  renders it afterwards. A daemon that dies before committing is fine: that job is marked as crashed
  through `JobStore.commit` and reaches the observer.
- **A render that fails.** The observer logs and drops a failed write, deliberately: the terminal is
  already durable and the export is rebuildable, so a storage failure may not fail the job.
- **A coordinator that dies between `COMMIT` and its observer call.** Not observed; the same shape as the
  daemon case one process up.

In every case `wait` still renders the file on read, so the degradation is to the behaviour this entry
used to describe — only after a failure, and only for the job that failed.

### What would close it

A backstop that renders an export for every terminal job that lacks one, independent of which process
committed the terminal. The natural place is recovery at startup, which already walks terminal jobs to
release stale claims. The unsolved part is scope: `~/.coral/exports/jobs/` already holds over 7,500
directories and nothing prunes it ([`export-lifetime.md`](./export-lifetime.md)), so an unbounded "every
terminal job" sweep grows with the tree. It needs a bound that does not depend on the export tree's size
— terminals committed since the previous clean shutdown, for example — and that bound is the design work.

### Two things settled by the fix that must not be undone

- **Provider-event application feeds the export observer only, not the lifecycle reactor.** That path
  commits on the raw database and has never fed the reactor; giving it the full composed observer would
  start retention observing those batches as well. Whether it should is a separate change.
- **The render belongs to the commit, not to the committing site.** Crash terminalization and recovery's
  `markError` once wrote an empty-string placeholder, and `ensureResultMarkdownArtifact` skips an
  artifact that exists, so the placeholder was permanent (#314). Deleting those writes fixed that and
  left both terminals with no export at all; adding writes back site by site then missed a recovery
  settlement with eleven callers and every proxied app-server job. A new terminal path needs no export
  call of its own — it needs to commit through a path that reaches the observer.

## Member 2 — availability is not part of the wait event

`WaitCoordinator.resultPathFor` (`src/jobs/shell/wait.ts`) catches a rebuild failure, logs to
coordinator stderr, and returns the **expected** filename. The terminal wait event then carries a path
that was never verified, and `wait` prints it. The trigger is narrow: `ensureResultArtifact` must
actually throw — a storage failure, or a terminal record that cannot be decoded. Member 1's failure
cases make this reachable: they are exactly the jobs whose only render is this one.

Artifact availability is not part of terminal success, but it must be explicit in the event. Replace
`resultPath: string` in the terminal arm of `WaitStreamEvent` (`src/jobs/wait.ts`) with a discriminated
value:

```ts
| { availability: 'available'; path: string }
| { availability: 'unavailable'; reason: 'materialization_failed'; detail: string; remediation: 'retry_wait' }
```

`WaitCoordinator` stops substituting a filename. The validator at `src/jobs/wait-stream-event.ts`
validates the discriminant. Exit status stays derived from the durable terminal outcome alone — and
under the settled `wait` contract, from the monitor's own success (see `cli-machine-channel.md`).

The dependency is genuinely optional in the interface (`ensureResultArtifact?`, `src/jobs/shell/wait.ts`)
and the test harnesses that construct a `WaitCoordinator` omit it, but the **sole production composition
supplies it** (`src/coordinator/execution-service.ts`). The work is making the constructor contract
require what production already provides, not adding missing wiring.

### Why member 2 is still split

The value is small; evolving an established subscription event across mixed builds is not. An older CLI
requires `resultPath`; a newer backend cannot supply one on failure without lying. The transition
policy — verified legacy terminal events may keep the legacy field, while an unavailable artifact
becomes a controlled subscription error for clients that cannot represent the new state — has to be
designed and tested before the old field is removed. The additive-only rule settled on 2026-09-12
([`design-philosophy`](../../.claude/rules/design-philosophy.md) §10) is the policy it consumes.

## Start condition

Member 1: a sweep bound that does not scale with the export tree. Member 2: re-score first — its trigger
is now confined to member 1's failure cases, so closing member 1 would make it rarer still.
