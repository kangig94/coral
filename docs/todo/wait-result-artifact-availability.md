# TODO — make terminal wait events explicit about result-artifact availability

**Status**: open. Split from PR #309 after the round-5 design pass established the contract but also found a
mixed-build wire transition that must be designed before implementation.

## The decision

Replace terminal wait events' speculative `resultPath` with a discriminated result-artifact availability
contract. Artifact materialization failures must preserve the Journal terminal outcome, carry retry
remediation, and never expose an unverified path as available. Define and test the legacy-wire transition
before removing the old field.

The replacement value is:

```ts
type ResultArtifactAvailability =
  | { availability: 'available'; path: string }
  | {
      availability: 'unavailable';
      reason: 'materialization_failed';
      detail: string;
      remediation: 'retry_wait';
    };
```

Artifact availability is not part of terminal success. Exit status remains derived only from the durable
Journal terminal outcome. The five post-commit artifact writers remain warning-only cache materializers; a
filesystem failure must not rewrite lifecycle truth.

## Evidence and present symptom

The terminal arm of `WaitStreamEvent` exposes an unconditional `resultPath: string`
(`src/jobs/wait.ts:68-77`).
`WaitCoordinator.resultPathFor` catches an artifact rebuild failure and falls back to the expected filename
(`src/jobs/shell/wait.ts:362-372`), even though that path has not been verified. The subscription validator
accepts the same unconditional field (`src/jobs/wait-stream-event.ts:73-84`). The sole production
`WaitCoordinator` construction already supplies `ensureResultArtifact`
(`src/coordinator/execution-service.ts:108-120`); only the constructor interface
(`src/jobs/shell/wait.ts:225`) and the four test constructors in `wait-sse-reconnect.test.ts`,
`wait-carrier-observation.test.ts`, and `workflow-usage.test.ts` permit omission.

Today `coral-cli wait` can therefore print `Result path: …/result.md` and exit 0 when the file does not exist.
The exit code is correct for the durable job outcome; presenting the path as available is not.

## Why it is split

The value change is small, but the wait event is an established subscription protocol across mixed builds.
An older CLI requires `resultPath`; a newer backend cannot supply one after materialization failure without
lying. Removing or changing the field without a transition would convert a cache failure into an uncontrolled
wire-parse failure.

The settled transition direction is:

- a verified legacy terminal event may retain its legacy path while both sides can represent only the old
  shape;
- an unavailable artifact becomes a controlled subscription error for clients that cannot represent the new
  discriminant;
- a new client consumes the discriminated value and presents `retry_wait` remediation instead of a path.

The exact capability/version signal, fixtures for both directions, and removal point for `resultPath` remain
to be specified and tested.

## Explicitly out of scope

This item does not make artifact creation lifecycle-authoritative, change terminal exit status, make the five
post-commit writers fatal, move export files, or define export retention. It also does not change the
zero-byte crash-path writers.

## Start condition

Begin only after the mixed-build protocol has executable contract tests for old client/new backend and new
client/old backend, including both verified legacy paths and materialization failure. Then make
`ensureResultArtifact` required by the `WaitCoordinator` constructor contract (the production wiring already
exists), remove its filename fallback, and validate the discriminant at subscription ingress.
