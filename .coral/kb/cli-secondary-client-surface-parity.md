# Verify CLI Flag Surface Against Full Backend Schema, Not Example Paths
Promoted: 2026-03-13 | Updated: 2026-03-13
## Rule
When designing a secondary CLI client, compare the planned flag surface against the full existing backend/client schema, not just the happy-path examples. Parity failures for secondary clients are usually plan-level surface omissions, not backend capability gaps.
## Why
Coral's backend already supports optional `session` on provider `exec` (routes to resume semantics) and `stale_timeout_seconds`/`atoms` on workflow. A CLI plan written from examples will miss these fields, causing silent under-exposure of existing backend features.
## Pattern
Right: read `src/shared/schemas.ts`, `src/workflow/schemas.ts`, and `src/execution/server.ts` route handlers before writing CLI flag lists — check every field in the Zod schema.
Wrong: copy example invocations from docs and only add flags for the fields shown in those examples.
