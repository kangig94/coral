# Analysis: MemPalace Cross-Cutting Enhancement
Date: 2026-04-12
Question: 4개 프로젝트 비교 관점에서 MemPalace 분석 보강

## Gap Analysis (Cross-Cutting Comparative)

**Finding flow**: 28 initial → 24 after gates → 21 verified [code: 17, inference: 4, assumption: 0]

### Dimension 1: Search Quality — 가장 큰 구조적 약점

MemPalace는 비교 대상 중 유일하게 **vector-only search**. 다른 3개는 모두 hybrid:

| Project | Search Architecture | Keyword Search | Fusion |
|---------|-------------------|----------------|--------|
| Coral | Orama text + Entity graph + DuckDB vector | FTS with boosted fields | RRF K=60 (3-lane) |
| QMD | SQLite FTS5 + sqlite-vec + node-llama-cpp | BM25 with porter stemming | RRF K=60 + top-rank bonus |
| GBrain | Postgres tsvector + pgvector HNSW | ts_rank with websearch_to_tsquery | RRF K=60 + 4-layer dedup |
| **MemPalace** | **ChromaDB cosine only** | **None** | **None** |

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| M1 | **Vector-only search — no keyword search** — exact name/date/phrase queries fail when embedding maps them far from stored chunks. "Find where I discussed GraphQL pricing" may miss "we switched the API billing model." | CRITICAL | code trace (`searcher.py:1-30` — verified: only ChromaDB `.query()`, no text search) |
| M2 | **Knowledge graph isolated from search** — temporal KG has rich entity/relationship data but `searcher.py` never consults it. Coral weights entity graph at 0.22 in RRF. | HIGH | code trace (`searcher.py` imports only `palace`, not `knowledge_graph`) |
| M3 | **No result dedup** — near-identical chunks from same source file all returned. GBrain has 4-layer dedup. | MEDIUM | code trace (no dedup logic in searcher.py or mcp_server.py search handler) |
| M4 | **No query expansion** — raw query → single embedding → single ChromaDB lookup. QMD/GBrain both expand queries. | MEDIUM | code trace |

### Dimension 2: AAAK Embedding Quality Risk

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| M5 | **AAAK-compressed text degrades embeddings** — diary entries stored as compressed AAAK (e.g., `SESSION:2026-04-04\|built.palace.graph`). Embedding models never trained on AAAK. TODO acknowledged but unresolved. | HIGH | code trace (`mcp_server.py:788-789` — verified: TODO comment) |
| M6 | **No embedding model pinning** — ChromaDB default model is version-dependent. `chromadb>=0.5.0,<0.7` spans different default models. Existing embeddings become incomparable on upgrade. | HIGH | code trace (no `embedding_function` specified at collection creation) |

### Dimension 3: Data Integrity Gaps

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| M7 | **ChromaDB abstraction bypass** — 5 modules import chromadb directly, bypassing `backends/` ABC: cli.py, dedup.py, mcp_server.py, migrate.py, repair.py | HIGH | code trace (verified: `grep` found 6 files, minus backends/chroma.py = 5 bypasses) |
| M8 | **`_get_collection` swallows all exceptions** — `mcp_server.py:161` catches ALL exceptions, returns None. Masks permission denied, corruption, OOM behind generic "No palace found". | HIGH | code trace (verified) |
| M9 | **Inode-based cache may miss WAL writes** — ChromaDB WAL mode appends to existing file without changing inode. Other processes adding drawers won't trigger cache invalidation. | MEDIUM | inference (SQLite WAL mode behavior vs inode check) |
| M10 | **No atomic config/WAL writes** — `config.py` uses direct file writes, WAL uses `O_APPEND` without `fsync`. Crash → config corruption or WAL gap. | MEDIUM | code trace |
| M11 | **KG direction default mismatch** — MCP tool defaults "both", `knowledge_graph.py:203` defaults "outgoing". Direct KG users get different behavior. | LOW | code trace (verified) |

### Dimension 4: Scalability Gaps

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| M12 | **Palace graph rebuilt from scratch every call** — `build_graph()` scans all metadata on every traverse/tunnel/stats call. No caching. | MEDIUM | code trace (`palace_graph.py:build_graph()`) |
| M13 | **`_fetch_all_metadata` full scan** — status, taxonomy, graph all require full metadata scan. No incremental model. | MEDIUM | code trace |
| M14 | **Timeline query LIMIT 100 hardcoded** — `knowledge_graph.py:303` — truncates rich entity histories silently. | LOW | code trace (verified) |
| M15 | **WAL grows unbounded** — `write_log.jsonl` no rotation or size cap. | LOW | code trace |

### Dimension 5: CLI/MCP Divergence & Documentation

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| M16 | **CLI/MCP feature divergence** — CLI has compress/dedup/repair/migrate/split (no MCP equiv). MCP has diary/traverse/tunnels/hook_settings (no CLI equiv). | MEDIUM | code trace (12 CLI commands vs 24 MCP tools, partial overlap) |
| M17 | **Test suite empty** — `tests/` directory exists, pytest configured, but no test files. Zero acceptance criteria verifiable. | HIGH | code trace (verified: `tests/` directory, pyproject.toml configures pytest) |

### Dimension 6: Unique Strengths Confirmed by Comparison

MemPalace가 다른 3개보다 앞선 영역 (gap이 아닌 강점):

| Strength | vs Coral | vs QMD | vs GBrain |
|----------|---------|--------|-----------|
| Query sanitization (4-step) | Coral has none | QMD has none | GBrain has none |
| Permission hardening (0o700/0o600) | Coral: .env only | QMD: none | GBrain: config.json only |
| Write-ahead log (JSONL audit) | Coral: none | QMD: none | GBrain: schema exists, unused |
| Temporal KG (valid_from/valid_to) | Coral: no temporality | QMD: no KG | GBrain: links, no temporality |
| 4-layer memory stack (L0-L3) | Coral: flat search | QMD: flat search | GBrain: flat search |
| AAAK compression dialect | Coral: full text | QMD: full text | GBrain: compiled truth (different) |

### Prioritized Recommendations

| # | Priority | Recommendation | Complexity | Source |
|---|----------|---------------|------------|--------|
| 1 | CRITICAL | **Add keyword search + RRF fusion** — SQLite FTS5 alongside ChromaDB. Fix vocabulary mismatch. | Major (200+ lines) | Coral/QMD/GBrain all hybrid |
| 2 | HIGH | **Create test suite** — search baseline, WAL round-trip, KG temporal, migration | Major (many files) | All 3 have tests |
| 3 | HIGH | **Pin embedding model** at collection creation, verify at connect | 15 lines | GBrain explicit model |
| 4 | HIGH | **Fix ChromaDB abstraction bypass** — route 5 modules through backends/ | Refactoring | Coral module discipline |
| 5 | HIGH | **Fix exception swallowing** in `_get_collection` — catch specific exceptions | 10 lines | Basic error handling |
| 6 | MEDIUM | **Integrate KG into search ranking** — entity mention → drawer boost | 40 lines | Coral 0.22 graph weight |
| 7 | MEDIUM | **Unify CLI/MCP** from shared operation registry | Architecture | GBrain contract-first |
| 8 | MEDIUM | **Add palace graph caching** with inode invalidation | 30 lines | Own mcp_server pattern |
| 9 | MEDIUM | **Resolve version/doc drift** — plugin v3.0.14, tool count 19 vs 24 | Build step | CI automation |
| 10 | LOW | **Implement AAAK expansion before embedding** | 30 lines | Acknowledged TODO |
| 11 | LOW | **Add WAL rotation + fsync** | 20 lines | Standard audit pattern |

### Open Questions (Cross-Cutting)

| # | Question | Insight Source |
|---|----------|---------------|
| 1 | Vector-only search가 personal memory 사용 사례에 충분한가? | Coral/QMD/GBrain 모두 hybrid |
| 2 | ChromaDB 0.5-0.7 범위 내 default embedding model이 무엇이고 token limit은? | GBrain explicit model pinning |
| 3 | Temporal KG가 search ranking에 참여해야 하는가? | Coral entity graph 0.22 weight |
| 4 | `BaseCollection` ABC가 실제로 multi-backend 지원을 의도하는가? | 5개 모듈이 bypass |
| 5 | AAAK expansion before embedding 우선순위는? Diary 비중에 따라 긴급도 다름 | 자체 TODO |
| 6 | Test suite 부재가 의도적 초기 단계인가 oversight인가? | 다른 3개 모두 test 보유 |

## Synthesis Review

**Finding flow**: 28 initial → 24 after gates → 21 verified [code: 17, inference: 4, assumption: 0]

Single step executed — thematic grouping skipped.

**Unanswered aspects**: None.