# Analysis: KB Cross-Cutting Enhancement
Date: 2026-04-12
Question: 4개 프로젝트 비교 관점에서 Coral KB 분석 보강

## Gap Analysis (Cross-Cutting Comparative)

**Finding flow**: 24 initial → 20 after gates → 18 verified [code: 14, inference: 4, assumption: 0]

### Dimension 1: Search Quality Gaps

Coral's search pipeline runs all 3 lanes (Orama text → entity graph → vector) and fuses via RRF. Compared to the other 3 systems, several quality stages are absent:

| Missing Stage | Who Has It | Coral Impact | Evidence |
|---------------|-----------|--------------|----------|
| **Query expansion** | QMD (LLM lex/vec/hyde), GBrain (Haiku 2-alt), MemPalace (ChromaDB built-in) | Low recall when user terminology ≠ stored terminology. Entity graph aliases partially compensate. | `search.ts:1106` passes raw query directly to embedding — no expansion step |
| **Strong-signal short-circuit** | QMD (BM25 probe, skip LLM if strong match) | Wasted vector API calls on exact slug/title matches | `search.ts:1034-1049` — always proceeds to vector lane regardless of text score |
| **LLM reranking** | QMD (qwen3-reranker after RRF) | No post-fusion quality filtering | `search.ts:1114-1115` — fusedHits go directly to response |
| **Result dedup** | GBrain (4-layer: best-per-page, Jaccard >0.85, type diversity 60%, chunk cap) | Overlapping entries can dominate top results | `fuseHits` merges by entryId but no cross-entry content similarity |
| **Query sanitization** | MemPalace (4-step pipeline, prompt injection mitigation) | Raw query passed to Orama, graph seeds, embedding API | No sanitization anywhere in search path |

### Dimension 2: Data Integrity Gaps

| Missing Pattern | Who Has It | Coral Impact | Evidence |
|----------------|-----------|--------------|----------|
| **Write-ahead log / audit trail** | MemPalace (JSONL WAL with content redaction) | No operation history for debugging or recovery | `mutation-helpers.ts` — atomic writes only, no log |
| **Content hash idempotency** | GBrain (SHA-256 per page), QMD (content-addressable), MemPalace (sha256 drawer IDs) | Promoting same content twice with different slugs creates duplicates | `promote.ts` — no hash check |
| **Temporal entity validity** | MemPalace (triples with valid_from/valid_to) | Entity graph is point-in-time snapshot only; no fact evolution tracking | `types.ts:5-50` — EntityMeta has no temporal fields |
| **Path traversal guard on staged imports** | (basic security expectation) | `stagedPath: z.string().min(1)` accepts `../../../../etc/passwd` | `kb-tools.ts:82` — verified, no path prefix validation |
| **Permission hardening** | MemPalace (dirs 0o700, files 0o600 everywhere) | Only `.env` is 0o600; KB directories/files use default perms | `env.ts:58` only |
| **Merge conflict detection on all JSON files** | (Coral does it for entity graph only) | `index.json`, `index-state.json` silently corrupt after git-sync conflicts | `runtime.ts:545` — only `.entity-graph.json` checks for `<<<<<<<` |

### Dimension 3: Scalability Gaps

| Missing Pattern | Who Has It | Coral Impact | Evidence |
|----------------|-----------|--------------|----------|
| **Vector snapshot GC** | QMD (content-addressable, inherent), MemPalace (inode-based invalidation) | Old snapshots accumulate indefinitely under `vec/specs/<specId>/snapshots/` | `sync.ts:449-452` — renameSync + writeActiveSnapshotId, no old snapshot removal — verified |
| **Search timeout / abort** | QMD (timeout-bounded), MemPalace (TTL cache) | Slow embedding provider blocks search indefinitely | `search.ts:1106` — `embedQuery` has no timeout/AbortSignal |
| **AST-aware code chunking** | QMD (tree-sitter, scored break points, distance decay) | Section/paragraph splitting can split mid-function in code-heavy KB content | `chunking.ts` — `##`/`###` headers and `\n\s*\n+` only |
| **Content size limits** | QMD (AST chunking rejects pathological input), GBrain (per-page chunk caps) | Unbounded notes bloat Orama index, vector snapshot, and JSON serialization | `kb-tools.ts:59,69` — `content: z.string()` no `.max()` — verified |
| **top_k upper bound** | GBrain (DB-level limit) | `top_k=1000000` triggers unbounded widening and vector expansion | `search.ts:1034` — positive int only, no max — verified |

### Dimension 4: Operational Gaps

| Missing Pattern | Who Has It | Coral Impact | Evidence |
|----------------|-----------|--------------|----------|
| **Contract-first operations** | GBrain (single `operations.ts` → CLI/MCP/tools-json auto-gen, parity tested) | `kb-tools.ts` is more ad-hoc; no single source of truth for all KB operations | inference (architectural pattern comparison) |
| **Export / backup** | MemPalace (`exporter.py` → browsable markdown) | No way to export KB as portable bundle | No export command in CLI or backend |
| **Dedup / repair** | MemPalace (`dedup.py`, `repair.py`), QMD (maintenance module) | No built-in deduplication or index repair commands | Only `reindex` exists in ops |

### Prioritized Recommendations

| # | Priority | Recommendation | Complexity | Source Comparison |
|---|----------|---------------|------------|-------------------|
| 1 | CRITICAL | **Add `stagedPath` traversal guard** — assert prefix before `persistPreparedSource` | 5 lines | Security baseline |
| 2 | CRITICAL | **Add `top_k` max(100) and content `.max(200000)`** | 3 lines each | GBrain DB-level limit |
| 3 | HIGH | **Implement vector snapshot GC** — remove old snapshots after activation | 15 lines | QMD content-addressable model |
| 4 | HIGH | **Add search timeout (5s AbortSignal)** on embedding call | 10 lines | QMD/MemPalace timeout model |
| 5 | HIGH | **Add query length limit (500 chars) + control char stripping** | 10 lines | MemPalace 4-step sanitizer |
| 6 | MEDIUM | **Strong-signal short-circuit** — skip vector on high-confidence text match | 20 lines | QMD BM25 probe pattern |
| 7 | MEDIUM | **Extend merge conflict detection** to index.json, index-state.json | 10 lines | Coral's own entity graph pattern |
| 8 | MEDIUM | **Entity graph orphan cleanup** on delete | 30 lines | GBrain cascading delete |
| 9 | LOW | **Operation audit log** — append-only JSONL | 40 lines | MemPalace WAL pattern |
| 10 | LOW | **Query expansion** — start with entity alias expansion, then LLM | 100+ lines | QMD/GBrain expansion |
| 11 | LOW | **LLM reranking** — post-fusion quality pass | 100+ lines | QMD reranker pattern |

### Open Questions (Cross-Cutting)

| # | Question | Insight Source |
|---|----------|---------------|
| 1 | Entity graph alias resolution이 query expansion의 대체재로 충분한가? | QMD/GBrain 둘 다 별도 expansion 구현 |
| 2 | Code-heavy source import에 AST-aware chunking이 필요한가? | QMD tree-sitter 패턴 |
| 3 | KB 엔트리 간 content similarity dedup이 실제로 문제가 되는가? | GBrain 4-layer dedup 패턴 |
| 4 | Entity graph에 temporal validity가 필요한가? | MemPalace valid_from/valid_to 패턴 |
| 5 | Contract-first 단일 operations source로 리팩토링할 가치가 있는가? | GBrain operations.ts 패턴 |

## Synthesis Review

**Finding flow**: 24 initial → 20 after gates → 18 verified [code: 14, inference: 4, assumption: 0]

Single step executed — thematic grouping skipped.

**Unanswered aspects**: None — 4개 프로젝트 비교 관점 보강 요청 fully covered.
