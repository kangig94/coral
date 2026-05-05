# TODO

## Optimization Candidates Requiring Logic Decisions

- `src/kb/curate/classification/prompt.ts` still re-ranks and token-fits the full prompt vocabulary for every candidate batch probe. A more aggressive incremental selector would need a benchmark and an explicit policy for preserving relevance/support/name ordering under token-limit edge cases.
- `src/engines/needle/backend.ts` still stages embedding texts, vectors, and upserts for a snapshot in memory. Streaming or chunked embedding would change batching, partial-failure, and provider call semantics, so it needs an explicit indexing policy.
- `src/kb/corpus/manifest-authority.ts`, `src/kb/corpus/inbound-sync.ts`, and `src/kb/corpus/rescan/drift.ts` can repeat full manifest/hash scans around external mutations. Avoiding those passes needs a freshness model that defines when cached surface hashes are authoritative.
- `src/sessions/lifecycle-reactor.ts` does per-session retention/release lookups while draining lifecycle work. Batching those reads would be faster under many sessions, but it needs ordering guarantees for release events and retention attempts.
- `src/kb/curate/community/detection.ts` still performs a fixed Louvain resolution sweep. Reducing the sweep or caching intermediate graph partitions needs quality thresholds so community topology does not regress silently.
- `src/discuss/persona/dpp.ts` uses dense matrix construction for DPP selection. Replacing it with a sparse or library-backed solver needs numerical tolerances and deterministic tie-breaking rules.
- `src/providers/claude/provider-facets.ts:80` and `src/providers/codex/provider-facets.ts:90` rescan provider artifact directories when emitting recovered handles. Caching locator results would reduce filesystem walks, but it needs invalidation tied to provider artifact creation, retention, and discard.
