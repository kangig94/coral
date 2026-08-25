# TODO — the exported result prints an event's type where its diagnosis belongs

**Status**: open. Field-observed 2026-08-25 on this host, in two separate failed jobs.

## What an operator gets

`~/.coral/exports/jobs/<id>/result.md`, in full:

```
Failed: job.progress.emitted
```

Two different failed jobs, in two different projects, exported that same line. `job.progress.emitted`
is an event type, not a failure. The same job's `coral-cli wait jobs` output rendered the real
sentence — `The provider became unavailable, so this job stopped before completion. Retry the job.`
with the proxy and build-set identities attached — so the diagnosis exists and one path drops it. The
path that drops it is the one that writes the artifact a person opens after the fact.

## Where it goes

`describeTerminalOutcome` (`src/jobs/outcome.ts`) renders a `failed` terminal by describing its
`causeRef`, which is correct: failure truth lives on the originating stream and the job terminal points
at it. The export supplies its own describer — `describeResolvedCauseRef`
(`src/jobs/terminal/export.ts`) — which walks the chain through `describeCauseRefChain` and, for each
event it reaches, calls `describeKnownEvent` in the same file.

`describeKnownEvent` hard-codes three event types — `workflow.completed`,
`workflow.lifecycle_fault`, and `job.terminal.recorded` — and ends with `return event.type`. So the
walk resolved the cause correctly, arrived at an event nobody taught it, and printed the type string as
the diagnosis.

## Why this is a structural defect and not a missing case

`docs/architecture.md` states the split deliberately: `causality/` owns the walk and its diagnostics,
each domain owns its event describer map, and `read-model/event-describers.ts` composes the default
map — `defaultEventDescribers`, guarded for completeness by `assertDescriberCoverage`. The export does
not use it. It is a **second** describer map, hand-written, covering three of the vocabulary's events,
with a silent fallback for the rest.

Adding `job.progress.emitted` to `describeKnownEvent` would fix the observed line and leave the shape
intact, so the next unhandled event kind exports its own name again. The composed map exists precisely
so that a new domain event cannot be forgotten; the export opted out of it.

## The part that is not mechanical

The export takes a `Database` and a `StoreReadContext` and lives in `src/jobs/`. The composed map lives
in `src/read-model/`, and the Source Tree Policy puts the read model above the domains — a domain
reaching up for it is the layering the policy forbids, which is plausibly why this second map exists at
all. So the fix is one of:

- have the export receive a describer map from its composition root, the way the read model already
  receives domain describers, so `jobs/` depends on the contract rather than on `read-model/`; or
- move the export's assembly to the layer that may compose both, and leave `jobs/terminal/export.ts`
  owning only the file write.

Whoever takes it should settle that before touching `describeKnownEvent`, because patching the map in
place is the option that looks smallest and preserves the defect.

## Start condition

Startable now; it touches no part of the routing-status audit branch.

## Why deferring is not free

The exported result is what survives the session. `wait`'s output scrolls away, and a job whose
provider disappeared is exactly the case a person comes back to read later — so the artifact that
outlives the incident is the one carrying an event name instead of the reason.
