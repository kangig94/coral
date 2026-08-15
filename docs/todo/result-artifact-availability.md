# TODO — a terminal wait event should say whether its artifact exists

**Status**: open, and **re-scored 2026-08-15 after PR #314**. The symptom that motivated the original
document has been fixed by a different, much smaller change; what remains is real but has never been
observed.

## What #314 removed, and why it matters here

The reported bug — a crashed workflow printing `Result path:` at a 0-byte file — was not a missing
renderer. Crash terminalization and recovery's `markError` were writing the empty string over the
export, and `ensureResultMarkdownArtifact` short-circuits on the file existing, so the placeholder was
never repaired. Deleting the two writes made the next read render the fault from the durable terminal.

The original version of this document listed those writers as **explicitly out of scope**. It had
pushed the reported symptom outside its own boundary, which is why it would not have fixed the bug it
was written for. Recorded here because the failure mode is worth recognising: a design document can
scope itself away from the thing that prompted it.

## What actually remains

`WaitCoordinator.resultPathFor` (`src/jobs/shell/wait.ts:362-374`) catches a rebuild failure, logs to
coordinator stderr, and returns the **expected** filename. The terminal wait event then carries a path
that was never verified, and `wait` prints it.

The remaining trigger is narrow: `ensureResultArtifact` must actually throw — a storage failure, or a
terminal record that cannot be decoded. Unlike the writers #314 removed, this has not been seen in the
field.

Five post-commit writers have the same warning-only shape and are **correct as they are**: they
materialize a rebuildable cache and must not fail a job when the cache write fails
(`src/jobs/shell/launch.ts`, `src/coordinator/services/recovery/service.ts`,
`recovery/interrupted-finalizer.ts`, `workflow-execution.ts`, `workflow-recovery-finalizer.ts`).

## The designed answer

Artifact availability is not part of terminal success, but it must be explicit in the event. Replace
`resultPath: string` in the terminal arm of `WaitStreamEvent` (`src/jobs/wait.ts:68-77`) with a
discriminated value:

```ts
| { availability: 'available'; path: string }
| { availability: 'unavailable'; reason: 'materialization_failed'; detail: string; remediation: 'retry_wait' }
```

`WaitCoordinator` stops substituting a filename. The validator at
`src/jobs/wait-stream-event.ts:73-84` validates the discriminant. Exit status stays derived from the
durable terminal outcome alone — and under the settled `wait` contract, from the monitor's own success
(see `cli-machine-channel.md`).

The dependency is genuinely optional in the interface (`ensureResultArtifact?`,
`src/jobs/shell/wait.ts:226`) and the four test harnesses that construct a `WaitCoordinator` omit it, but
the **sole production composition supplies it** (`src/coordinator/execution-service.ts:120`, inside the
one `new WaitCoordinator` at `:108`). The work is making the constructor contract require what
production already provides, not adding missing wiring.

## Why it is still split

The value is small; evolving an established subscription event across mixed builds is not. An older CLI
requires `resultPath`; a newer backend cannot supply one on failure without lying. The transition
policy — verified legacy terminal events may keep the legacy field, while an unavailable artifact
becomes a controlled subscription error for clients that cannot represent the new state — has to be
designed and tested before the old field is removed.

That transition is the same problem `build-identity-and-upgrade.md` and
`jobs-read-contract-schema-first.md` face. Settle the compatibility policy once, across all three,
rather than inventing it here.

## Start condition

Re-score before starting. The common failure is gone, the remaining trigger has never been observed,
and the cost is a protocol transition. It may be right to hold this until the compatibility policy
exists for another reason and this becomes a consumer of it rather than the driver.
