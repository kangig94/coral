# TODO — a preflight that could not check terminalizes the job it could not check

**Status**: open, and narrower than it looks. Both providers now _observe_ the third answer and say so in the
message; what is missing is a way to carry it across one boundary, so the job dies with an accurate sentence
instead of an inaccurate one. Closing it is a change to a contract every provider implements.

## What exists

`ProviderDefinition.preflight` returns `Promise<void>` (`src/providers/contract.ts:724`). It has exactly two
outcomes a caller can see: it resolves, or it rejects. Downstream:

- `runProviderPreflight` (`src/coordinator/services/execution-policies.ts:244-254`) catches any rejection and
  returns `errorMessage(error)` — a `string | null`. The message survives; which _kind_ of failure it was does
  not, because there was never a kind to lose.
- `job-launch.ts:139` and `:383` turn any non-null string into `rejectLaunch('provider_preflight_failed', …)`,
  which is terminal.

So three answers become two, and both of the two that are not "proceed" are the same one.

## Why that is a defect and not just a shape

Both providers now genuinely distinguish a check that established something from a check that never completed:

- `codexPreflight` builds a `PreflightVerdict` of `satisfied | refused | undetermined`
  (`src/providers/codex/provider-facets.ts`). `refused` is "this CLI has no `app-server` subcommand" or "this
  home holds no auth tokens" — conditions observed, each with a remedy. `undetermined` is the fork losing to
  `EAGAIN`, the probe being killed, or `auth.json` being unreadable.
- `claudePreflight` does the same over `CliInfo`'s `not-found | undetermined`.

An `undetermined` verdict then reaches `throwUnlessSatisfied`, becomes a rejection, becomes a string, and
becomes a terminal job. Design-philosophy §11: _unknown never authorizes finalization_, and _a hold cannot be
returned through a type whose success means "done"_. Terminalizing a job is a finalization, and the evidence
authorizing it here is an observation nobody made.

The practical shape: a machine briefly out of process slots fails the next codex or claude job outright, and
the operator is told — accurately, which is the part that already improved — that the check could not be run.
Being told accurately that your job died for no established reason is better than being told to reinstall a CLI
you have, and is still not the right outcome.

## What has already been done, so it is not redone

- The verdicts exist and are the right shape; do not re-derive them.
- The messages no longer borrow a remedy from a cause that was not observed.
- Neither provider caches an `undetermined` verdict any more, so a verdict cannot decide for a _different_ job
  that never observed anything. That was the reachable half and it is closed —
  `src/providers/codex/provider-facets.ts` and `src/providers/cli-detection.ts` both re-ask instead.

What remains is exactly one hop: the job that _did_ observe the non-answer still dies on it.

## Required shape

`preflight` answers three ways instead of two, and the coordinator's launch policy learns the third:

```ts
type PreflightOutcome =
  | { kind: 'satisfied' }
  | { kind: 'refused'; message: string }
  | { kind: 'undetermined'; message: string };
```

`runProviderPreflight` stops flattening to `string | null`, and `job-launch` routes `undetermined` to whatever
Coral's answer to "ask again later" is — which is the part that needs deciding, not just typing. A bounded
retry is not by itself an exit (§11); exhausting it has to reach a named successor. The candidates are a
launch-time retry with a deadline, or admission-hold semantics like the ones
[`provider-operation-admission-hold`](./provider-operation-admission-hold.md) is already weighing for a
neighbouring boundary — that entry should be read first, because if both grow their own answer to the same
question this becomes two.

## Explicitly out of scope

- The provider-side classification. It is done and correct.
- `PROVIDER_PREFLIGHT_TIMEOUT_MS` (`execution-policies.ts:217`). A preflight that overruns its own bound is a
  different question from one that completed and could not conclude, and folding them together is how this
  entry would get the wrong fix.

## What would have to be true to start

A decision on what "ask again later" means at job launch — there is no such disposition anywhere on that path
today, so this entry cannot be worked before `provider-operation-admission-hold` settles the vocabulary or a
launch-level retry is chosen. Absent that, the honest state is the one recorded here: the message is accurate,
the disposition is not carried, and the job dies.
