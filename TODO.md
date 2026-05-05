# TODO

## Optimization Candidates Requiring Logic Decisions

- `src/kb/search/graph-retrieval.ts` still rebuilds and JSON-stringifies stable entity graphs across search requests. Cross-request fingerprint caching needs an authority-owned invalidation contract tied to index/entity-graph writes so stale structural retrieval cannot be served.
- `src/kb/curate/classification/prompt.ts` still re-ranks and token-fits the full prompt vocabulary for every candidate batch probe. A more aggressive incremental selector would need a benchmark and an explicit policy for preserving relevance/support/name ordering under token-limit edge cases.
- `src/engines/needle/backend.ts` still stages embedding texts, vectors, and upserts for a snapshot in memory. Streaming or chunked embedding would change batching, partial-failure, and provider call semantics, so it needs an explicit indexing policy.
- `src/kb/corpus/manifest-authority.ts`, `src/kb/corpus/inbound-sync.ts`, and `src/kb/corpus/rescan/drift.ts` can repeat full manifest/hash scans around external mutations. Avoiding those passes needs a freshness model that defines when cached surface hashes are authoritative.
- `src/sessions/lifecycle-reactor.ts` does per-session retention/release lookups while draining lifecycle work. Batching those reads would be faster under many sessions, but it needs ordering guarantees for release events and retention attempts.
- `src/kb/curate/community/detection.ts` still performs a fixed Louvain resolution sweep. Reducing the sweep or caching intermediate graph partitions needs quality thresholds so community topology does not regress silently.
- `src/kb/search/responses.ts` now indexes top-hit tags per response, but persisting or caching community member indexes across responses needs invalidation on community document and entity graph updates.
- `src/discuss/persona/dpp.ts` uses dense matrix construction for DPP selection. Replacing it with a sparse or library-backed solver needs numerical tolerances and deterministic tie-breaking rules.
- `src/read-model/kb-query-runtime.ts:110` opens a fresh read-only DB whenever a caller provides `context.runtime` without `context.readDb`. Caching this per `KbQueryHost` would avoid repeated opens, but it needs an explicit close/lifetime contract for host-owned handles.
- `src/providers/claude/provider-facets.ts:80` and `src/providers/codex/provider-facets.ts:90` rescan provider artifact directories when emitting recovered handles. Caching locator results would reduce filesystem walks, but it needs invalidation tied to provider artifact creation, retention, and discard.
