# TODO — make jobs read contracts schema-first

**Status**: open. Split from PR #309 after the round-5 design pass settled compatibility rules but found the
conversion too broad for a workflow-identity change.

## The problem

Jobs list/detail responses cross producer, RPC, CLI dispatch, and formatting boundaries without one runtime
schema as their authority.

The core vocabulary lives as TypeScript-first records in `src/jobs/records.ts`, while `jobs.list`
and `jobs.detail` lack response schemas in `src/transport/rpc/catalog.ts` — the only methods in the
catalog that carry a `responseSchema` are the three `coordinator.provider_host.*` ones. Producer values pass through `executeJobsListCatalogRequest` / `executeJobsDetailCatalogRequest`
(`src/transport/dispatch.ts`), both of which reach their input by `request as …` cast, and
`src/cli/dispatch.ts` requests typed values rather than parsing `unknown`. Measured today, the type
family (`JobStatus`, `JobEvent`, `JobExit`, `JobsListResponse`, `JobDetailResponse`) has **120 references
across 24 files** in `src/`, so changing the source of those types is a cross-surface conversion, not a local
annotation.

### Correction — the field that motivated this no longer crosses the wire

An earlier revision opened with "This PR added `workflowChildren` and `workflowLabel` along that unchecked
path", written against PR #309. That PR was split and closed. What shipped instead (#312) derives children
**client-side**: `src/cli/commands/session.ts` calls `listJobs` and filters on
`parentWorkflowJobId`, and `WorkflowChildJob` is now defined as `JobsListResponse['jobs'][number]`
(`src/cli/format/jobs.ts`). `workflowLabel` does not exist anywhere in `src/`.

So the concrete failure this document cited — a malformed response reaching `formatWorkflowChildren`, where
`[...children]` throws instead of producing a controlled contract error (`src/cli/format/jobs.ts`) — is
still reachable, but through **`jobs.list`**, not `jobs.detail`. The unvalidated boundary is the same one;
the field that crosses it is not.

## The decision

Make the jobs read contract schema-first in `src/jobs/records.ts`, deriving TypeScript types from:

- `jobStatusSchema` → `JobStatus`;
- `jobEventSchema`;
- `jobExitSchema`;
- `workflowChildJobSummarySchema`;
- `jobsListResponseSchema`;
- `jobDetailResponseSchema`.

`workflowChildJobSummarySchema` describes a **list** row, not a detail field — see the correction above.
`formatJobDetail` already defaults its `workflowChildren` parameter to `[]` (`src/cli/format/jobs.ts`)
because the CLI assembles that array itself; the schema's job is to make the `jobs.list` rows it is
assembled from parsed rather than asserted.

Add `responseSchema` for `jobs.list` and `jobs.detail` in `src/transport/rpc/catalog.ts`. Parse producer values
in `src/transport/dispatch.ts`; in `src/cli/dispatch.ts`, request `unknown` and parse it rather than asserting a
response type.

## Compatibility rules already settled

Response records are additive and unknown-key tolerant. Zod's default strip-on-parse behavior lets an older
client consume a newer backend's optional additions without a cold upgrade. `.strict()` is therefore unsafe
for list/detail envelopes, job rows, and statuses. It remains appropriate only for genuinely closed leaf
values and separately negotiated request objects.

Removing, renaming, or retyping an existing response field is not additive. Any such change requires an
explicitly versioned or capability-gated protocol transition with mixed-build tests; schema-first ownership
does not make breaking changes safe by itself.

## Why it is split

Converting a core type family with 120 references across 24 files, adding parsing on both producer and
consumer sides, and pinning mixed-build behavior is too broad to hide inside a workflow slot/job identity PR.
A partial conversion would be worse than the current visible gap because callers could not tell which types
had runtime authority.

That the motivating field changed shape while this sat open is itself an argument for the split: the
boundary is the defect, not any one field crossing it.

## Explicitly out of scope

This item does not redesign the jobs payload, remove additive fields, make envelopes strict, add a new
transport version, or change CLI presentation. It does not implement structured CLI output; that is a
separate decision.

## Start condition

Begin when the conversion can be done across all list/detail producers and consumers in one change, with
contract tests covering malformed responses, unknown additive keys, and both mixed-build directions. The
TypeScript consumer inventory must be refreshed before editing — the count above is a measurement, not a
constant, and the `request as …` casts in `src/transport/dispatch.ts` are the paths most likely to be
missed since they type-check today.
