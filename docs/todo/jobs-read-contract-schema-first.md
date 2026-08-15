# TODO — make jobs read contracts schema-first

**Status**: open. Split from PR #309 after the round-5 design pass settled compatibility rules but found the
conversion too broad for a workflow-identity change.

## The problem

Jobs list/detail responses cross producer, RPC, CLI dispatch, and formatting boundaries without one runtime
schema as their authority. This PR added `workflowChildren` and `workflowLabel` along that unchecked path. A
malformed backend response can reach `formatWorkflowChildren`, where `[...children]` throws instead of
producing a controlled contract error (`src/cli/format/jobs.ts:199`).

The core vocabulary lives as TypeScript-first records in `src/jobs/records.ts:69,246-274`, while `jobs.list`
and `jobs.detail` lack response schemas in `src/transport/rpc/catalog.ts:254-271`. Producer values pass
through `src/transport/dispatch.ts:812-840`, and `src/cli/dispatch.ts:582-585` requests typed values rather
than parsing `unknown`. Approximately 33 consumers depend on the current types, so changing the source of
those types is a cross-surface conversion, not a local annotation.

## The decision

Make the jobs read contract schema-first in `src/jobs/records.ts`, deriving TypeScript types from:

- `jobStatusSchema` → `JobStatus`;
- `jobEventSchema`;
- `jobExitSchema`;
- `workflowChildJobSummarySchema`;
- `jobsListResponseSchema`;
- `jobDetailResponseSchema`.

The detail schema accepts `workflowChildren` as optional wire input and normalizes absence to `[]` at ingress.
After that normalization, `src/cli/format/jobs.ts` must consume the canonical array without `?? []`.

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

Converting a core type family with roughly 33 consumers, adding parsing on both producer and consumer sides,
and pinning mixed-build behavior is too broad to hide inside a workflow slot/job identity PR. A partial
conversion would be worse than the current visible gap because callers could not tell which types had runtime
authority.

## Explicitly out of scope

This item does not redesign the jobs payload, remove additive fields, make envelopes strict, add a new
transport version, or change CLI presentation. It does not implement structured CLI output; that is a
separate decision.

## Start condition

Begin when the conversion can be done across all list/detail producers and consumers in one change, with
contract tests covering malformed responses, missing `workflowChildren`, unknown additive keys, and both
mixed-build directions. The TypeScript consumer inventory must be refreshed before editing so no cast path is
left behind.
