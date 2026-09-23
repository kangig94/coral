# TODO — a terminal that writes no artifact, and a wait event that cannot say so

**Status**: open, **re-scored 2026-09-23 by measurement**. The entry previously said the remaining work
had never been observed and should be re-scored before starting. It has now been observed, and it is a
different member than the one this document was carrying.

## Two members, and only one of them is rare

**Member 1 — two terminals write no export, so a monitor materializes it.** Observed on the author's
host; reported as "`result.md` only appears after `wait jobs`".

**Member 2 — a wait event carries a path it never verified.** Still never observed. Costs a protocol
transition. This is the original content and is unchanged below.

They meet at `ensureResultMarkdownArtifact` (`src/jobs/terminal/export.ts`) and are otherwise
independent. Member 1 ships alone.

## Member 1 — the terminal export has six writers and the two crash paths are not among them

Every terminal that can render its own result writes it at commit:

- `src/jobs/shell/launch.ts` calls `progressStore.ensureResultArtifact(jobId)` — renders from the
  durable terminal through the guard.
- `writeResultArtifact` (`src/jobs/terminal/export.ts`) is called with caller-supplied markdown from
  `src/coordinator/services/recovery/service.ts`, `recovery/interrupted-finalizer.ts`,
  `workflow-execution.ts`, and `workflow-recovery-finalizer.ts`.

Two terminals write nothing:

- crash terminalization in `src/coordinator/lifecycle.ts`, which commits a `wrapper_crashed` fault;
- `markRecoveryError` in `src/coordinator/services/recovery/actions.ts`, which settles a recovery fault.

Both carry a comment saying the omission is deliberate. For those jobs the export exists only once some
reader calls `ensureResultMarkdownArtifact`, and the reader that does is `WaitCoordinator.resultPathFor`
(`src/jobs/shell/wait.ts`). **`wait` is a monitor, and for this class of job it is the materializing
authority.** A job that is never waited on has a durable terminal and no readable result.

Measured: a normally-terminating job has `result.md` within ten seconds with no `wait` at all. The
reported symptom is specific to these two paths.

### Why the omission was right, and why it no longer decides the fix

`ensureResultMarkdownArtifact` short-circuits on `storage.existsSync(targetPath)` and regenerates only
for a workflow child (`projection.parent_workflow_job_id !== null`). Before #314 these two sites wrote
the **empty string**, which satisfied that check forever — a permanent 0-byte file for a failure Coral
could describe exactly. Deleting the writes was the correct ten-line fix, and the comments record it.

What the comments then fixed in place was the wrong lesson: they read as "a terminal must not write
here", when what is forbidden is **writing a placeholder instead of the content**. The other four
coordinator sites write real markdown at their terminals through the same guard-free helper and are
correct. Nothing distinguishes these two except that the renderer was never wired to them.

### The decision

Give both sites the same post-commit writer `launch.ts` has, rendering from the terminal that was just
committed. The guard needs no change: nothing was written, so `existsSync` is false and the real content
is produced. `wait`'s call becomes the fallback it reads as.

**Both sites already hold what they need, so no dependency moves.** `RecoveryActionContext` carries
`progressStore: JobStore` and `ensureResultArtifact(jobId)` is on `JobProgressStore`
(`src/jobs/contracts/job-store.ts`); `createCrashedJobTerminalizationPolicy` destructures the same
`progressStore` from its context. The change is one call per site after the terminal commits, plus
deleting the two comments that forbade it.

The writer must keep the warning-only shape the other five have — a failed cache write must not fail a
job whose terminal is already durable. The one thing a test has to pin rather than assume is that the
render sees the terminal: the crash path commits through `coordinatorCommit` and the recovery path
through `settleFault`, and the call must read back the fault that was just written, not an empty job.

### Out of scope, and what it costs elsewhere

- Member 2 below. An eager write shrinks the population that reaches the read path; it does not remove
  the unverified-path defect, because a retry still reaches `resultPathFor`.
- Retention. These exports land in `~/.coral/exports/jobs/`, which nothing prunes
  ([`export-lifetime.md`](./export-lifetime.md)). This adds files to a tree with no owner. It is not a
  blocker — the same jobs already accumulate an export the moment anyone waits on them — but the two
  entries should not be read as independent when export-lifetime part 1 is scoped.

## Member 2 — availability is not part of the event

`WaitCoordinator.resultPathFor` catches a rebuild failure, logs to coordinator stderr, and returns the
**expected** filename. The terminal wait event then carries a path that was never verified, and `wait`
prints it. The trigger is narrow: `ensureResultArtifact` must actually throw — a storage failure, or a
terminal record that cannot be decoded.

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
and the four test harnesses that construct a `WaitCoordinator` omit it, but the **sole production
composition supplies it** (`src/coordinator/execution-service.ts`, inside the one `new WaitCoordinator`
call). The work is making the constructor contract require what production already provides, not adding
missing wiring.

### Why member 2 is still split

The value is small; evolving an established subscription event across mixed builds is not. An older CLI
requires `resultPath`; a newer backend cannot supply one on failure without lying. The transition
policy — verified legacy terminal events may keep the legacy field, while an unavailable artifact
becomes a controlled subscription error for clients that cannot represent the new state — has to be
designed and tested before the old field is removed.

That transition is the same problem `build-identity-and-upgrade.md` and
`jobs-read-contract-schema-first.md` face, and the policy it was waiting for was settled on 2026-09-12:
durable records are additive-only with unknown-key tolerant readers
([`design-philosophy`](../../.claude/rules/design-philosophy.md) §10). This member is a consumer of that
rule now rather than a driver of it.

## Recorded because the shape repeats

The original version of this document listed the two crash writers as **explicitly out of scope**. It had
pushed its own reported symptom outside its boundary, which is why it would not have fixed the bug it was
written for. #314 then fixed that symptom from outside the document, and the comments #314 left behind
stated the prohibition one step too wide — which is how the same two sites produced a second symptom,
opposite in sign to the first, and this document again did not cover it. A design document can scope
itself away from the thing that prompted it twice.
