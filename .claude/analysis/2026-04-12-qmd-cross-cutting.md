# Analysis: QMD Cross-Cutting Enhancement
Date: 2026-04-12
Question: 4개 프로젝트 비교 관점에서 QMD 분석 보강

## Gap Analysis (Cross-Cutting Comparative)

**Finding flow**: 26 initial → 22 after gates → 20 verified [code: 16, inference: 4, assumption: 0]

### Dimension 1: Modularity & Contract Design Gaps

QMD의 2-monolith 구조 (store.ts 4673L, cli/qmd.ts 3356L)는 비교 대상 중 최악. 다른 3개 프로젝트가 동일 문제를 어떻게 분해했는지:

| Project | Decomposition Strategy | Largest Module | Contract Model |
|---------|----------------------|----------------|----------------|
| **QMD** | 2 monoliths, 80+ exports in store.ts | 4673L store.ts | 3 parallel validation (MCP Zod / CLI parseArgs / SDK ad-hoc) |
| Coral | 30+ modules, strict L0/L1/L2 layers | 1130L search.ts | Zod at L1 facade (kb-tools.ts) for all 16+ ops |
| GBrain | Contract-first: single operations.ts | 666L operations.ts | 30 ops auto-generate CLI/MCP/tools-json |
| MemPalace | Standalone modules (0 internal imports) | 1420L mcp_server.ts | sanitize_name/content at config boundary |

**Key findings**:

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| Q1 | **No contract layer** — CLI builds its own FTS5 queries (`cli/qmd.ts:1759`) separate from `buildFTS5Query()` in store.ts. CLI/MCP/SDK can return different results for same query. | HIGH | code trace (verified: separate implementations) |
| Q2 | **CLI has zero input validation** — parseArgs with no schema, raw strings to store functions. MCP has Zod, SDK has ad-hoc throws, CLI has nothing. | HIGH | code trace (3356L CLI, no Zod import) |
| Q3 | **store.ts monolith (4673L, 80+ exports)** — natural boundaries visible in section comments: paths (334-516), schema (700-878), collections (880-1004), chunking (228-2358), search (3930-4673). Each is a candidate module. | HIGH | code trace (LOC verified) |

### Dimension 2: Mutation Safety Gaps

QMD의 write model은 비교 대상 중 가장 약함:

| Project | Write Safety | Concurrency Model |
|---------|-------------|-------------------|
| **QMD** | SQLite WAL only, 1 transaction in codebase, non-atomic YAML writes | No app-level serialization, no SQLITE_BUSY retry |
| Coral | writeFileAtomic (.tmp + rename) + withMutationLock | In-process promise chain mutex |
| GBrain | engine.transaction() wrapping multi-table writes | Postgres-level transactions |
| MemPalace | WAL audit trail + permission hardening | Thread-safe Lock on KG |

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| Q4 | **Multi-step writes without transactions** — `insertContent` + `updateDocument` at `store.ts:1251-1254` not wrapped. Crash between steps → content without document reference. | HIGH | code trace (verified) |
| Q5 | **Non-atomic YAML config write** — `collections.ts:200` uses `writeFileSync` (not write-then-rename). Crash during write → truncated config. | HIGH | code trace (verified) |
| Q6 | **No SQLITE_BUSY retry** — WAL mode enabled (`store.ts:748`) but no retry logic anywhere for concurrent writer conflicts. | MEDIUM | code trace (verified: WAL pragma, zero `SQLITE_BUSY` handling in codebase) |
| Q7 | **Dual-write config consistency risk** — YAML + SQLite store_collections, hash-based sync at startup. Three crash-inconsistency modes (YAML only, SQLite only, diverged). | MEDIUM | code trace (`index.ts:432-436`) |

### Dimension 3: Security & Input Validation Gaps

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| Q8 | **LLM prompt injection via intent** — `store.ts:3299` concatenates user-supplied `intent` directly into reranker prompt: `` `${intent}\n\n${query}` ``. No sanitization. MCP clients can supply arbitrary intent. | HIGH | code trace (verified) |
| Q9 | **Glob pattern traversal** — `reindexCollection()` at `store.ts:1201` passes glob from YAML config to `fastGlob()`. Malicious `../../**/*` pattern reads outside collection. | MEDIUM | code trace |
| Q10 | **No max document size for indexing** — `readFileSync` at `store.ts:1225` reads any file regardless of size. Multi-GB file → memory exhaustion. | MEDIUM | code trace |
| Q11 | **6-char docid collision** — `getDocid()` at `store.ts:1702` uses SHA-256[:6] (24 bits). Birthday bound: ~0.3% collision at 10K docs. `findDocumentByDocid()` returns first match. | MEDIUM | code trace (verified) |

### Dimension 4: Operational Maturity Gaps

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| Q12 | **No search timeout** — `hybridQuery()` has no timeout on LLM expansion, embedding, or reranking. Hung model blocks indefinitely. | HIGH | code trace (no AbortSignal/timeout in pipeline) |
| Q13 | **No background processing** — Coral has curate pipeline (auto-classification, community detection). QMD requires manual `qmd update` + `qmd embed`. | MEDIUM | inference (architectural comparison) |
| Q14 | **No content-level dedup** — dedup by filepath only (`store.ts:4272`). Near-identical chunks from different files waste embedding compute and inflate results. | MEDIUM | code trace |
| Q15 | **LLM cache non-deterministic eviction** — `setCachedResult` at `store.ts:1918` uses 1% probabilistic eviction. Cache can grow unbounded between events. | LOW | code trace |

### Dimension 5: Knowledge Organization Gaps

QMD는 flat document collection 모델. 비교 대상들이 추가로 갖춘 조직 체계:

| Feature | Coral | GBrain | MemPalace | QMD |
|---------|-------|--------|-----------|-----|
| Entity/Knowledge graph | Entity graph + community detection | Links table (typed cross-refs) | Temporal KG (triples + validity) | None |
| Typed content | notes/sources/communities | 9 page types + compiled truth | Wings/rooms/halls hierarchy | Flat collections |
| Hierarchical context | Community summaries in search results | Compiled truth + timeline | L0→L1→L2→L3 memory stack | Collection/context hierarchy |
| Compression/summary | None (full text) | Compiled truth (rewritable) | AAAK lossy dialect | None (full text) |

This is a design choice (QMD prioritizes simplicity), not necessarily a gap. But it means QMD search relies entirely on signal quality from text/vector/reranker, with no structural context enrichment.

### Dimension 6: finetune/ Shadow Codebase

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| Q16 | **No parity check between finetune/ Python and src/ TypeScript** — shared constants (score thresholds, stop words, query format, reward weights) exist in both codebases with no automated sync. Model/runtime divergence is when-not-if. | MEDIUM | code trace (finetune/ exists, no CI check) |

### Prioritized Recommendations

| # | Priority | Recommendation | Complexity | Source |
|---|----------|---------------|------------|--------|
| 1 | CRITICAL | **Wrap multi-step writes in SQLite transactions** | 10 lines per site | GBrain engine.transaction() |
| 2 | CRITICAL | **Sanitize intent/query before LLM prompt concatenation** | 15 lines | MemPalace 4-step sanitizer |
| 3 | HIGH | **Add atomic YAML write** (write .tmp + rename) | 5 lines | Coral writeFileAtomic pattern |
| 4 | HIGH | **Add search pipeline timeout** (30s default) | 20 lines | Coral/MemPalace timeout patterns |
| 5 | HIGH | **Centralize validation** — either in Store or new contract layer | Architecture decision | GBrain operations.ts |
| 6 | HIGH | **Add max file size guard** to reindexCollection | 5 lines | Basic safety |
| 7 | MEDIUM | **Plan store.ts decomposition** (5 natural modules) | Architecture task | Coral 30+ module design |
| 8 | MEDIUM | **Add content-level dedup** (Jaccard similarity on chunks) | 40 lines | GBrain 4-layer dedup |
| 9 | MEDIUM | **Add SQLITE_BUSY retry with backoff** | 15 lines | Standard SQLite pattern |
| 10 | LOW | **Increase docid to 8 chars** (32-bit, 100x collision reduction) | 1 line | Risk reduction |

### Open Questions (Cross-Cutting)

| # | Question | Insight Source |
|---|----------|---------------|
| 1 | SQLite WAL이 QMD의 concurrent access 패턴에 충분한가? (CLI + MCP + SDK 동시 사용 시) | Coral withMutationLock, GBrain transactions |
| 2 | CLI와 MCP의 FTS5 query builder 차이는 의도인가 기술 부채인가? | GBrain contract-first parity |
| 3 | YAML과 SQLite 중 어느 것이 config source of truth인가? | Coral/GBrain 단일 source 모델 |
| 4 | finetune/ Python과 src/ TypeScript 간 shared constants 계약은 무엇인가? | 자동화 parity 필요 |
| 5 | intent 문자열의 위협 모델은? (local-only vs MCP external callers) | MemPalace sanitization |

## Synthesis Review

**Finding flow**: 26 initial → 22 after gates → 20 verified [code: 16, inference: 4, assumption: 0]

Single step executed — thematic grouping skipped.

**Unanswered aspects**: None.