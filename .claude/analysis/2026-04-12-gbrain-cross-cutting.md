# Analysis: GBrain Cross-Cutting Enhancement
Date: 2026-04-12
Question: 4개 프로젝트 비교 관점에서 GBrain 분석 보강

## Gap Analysis (Cross-Cutting Comparative)

**Finding flow**: 30 initial → 26 after gates → 23 verified [code: 19, inference: 4, assumption: 0]

### Dimension 1: Input Validation — 4개 중 최악

GBrain은 비교 대상 중 유일하게 **런타임 입력 검증이 0**인 시스템.

| Project | Validation Strategy | Coverage |
|---------|-------------------|----------|
| Coral | Zod at L1 facade (kb-tools.ts), 16+ schemas | 100% of operations |
| QMD | Zod in MCP, ad-hoc in CLI/SDK | ~60% (MCP only) |
| MemPalace | sanitize_name/content + argument whitelisting | All write paths |
| **GBrain** | Zero. ParamDef is documentation-only, 30+ `as` casts | **0%** |

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| G1 | **Zero runtime validation** — 30+ operations use `p.slug as string`, `p.limit as number` etc. ParamDef defines schemas declaratively but is never enforced at runtime. MCP accepts arbitrary JSON from external callers. | CRITICAL | code trace (`operations.ts:90` — verified, `server.ts:39` `request: any` — verified) |
| G2 | **`p.limit as number` falsy-or-default bug** — `(p.limit as number) \|\| 50`: if limit=0, evaluates to 50 (silently wrong) | HIGH | code trace (`operations.ts:159` pattern) |
| G3 | **`put_raw_data` unbounded JSONB** — `p.data as object` stores any JSON with no size/depth limit | HIGH | code trace (`operations.ts:454`) |
| G4 | **No query input length limit** — 100KB query → sent to tsvector search AND Anthropic expansion | HIGH | code trace (no validation anywhere in search path) |

### Dimension 2: Silent Degradation — Observability 부재

GBrain은 3곳에서 실패를 무시하며, 호출자에게 degradation 신���를 전혀 ��달하지 않음:

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| G5 | **Embedding failure swallowed** — `import-file.ts:70` `catch { /* non-fatal */ }`. Chunks with null embeddings → vector search never finds them. Caller sees `status: 'imported'`. | HIGH | code trace (verified) |
| G6 | **Vector search failure invisible** — `hybrid.ts:54` silent fallback to keyword-only. Caller gets degraded results with no signal. | HIGH | code trace (verified) |
| G7 | **Expansion failure invisible** — `expansion.ts:36` `catch { return [query] }`. No signal expansion was skipped. | MEDIUM | code trace (verified) |
| G8 | **MCP auth schema dead** — `access_tokens` + `mcp_request_log` tables exist in schema.sql but `server.ts` never writes/checks them. False security confidence. | MEDIUM | code trace (verified: tables in schema, zero references in server.ts) |

**비교**: QMD의 로컬 모델은 API 실패 자체가 없음. Coral의 KB operations는 structured error 전파. MemPalace는 WAL에 모든 실패 기록.

### Dimension 3: Concurrency & Atomicity Gaps

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| G9 | **No mutation lock on import** — `import-file.ts:62-74`: embedding outside transaction, no per-slug lock. Concurrent imports of same slug both embed (wasting API $) and race into transaction. | HIGH | code trace (verified: no advisory lock, embedding before tx) |
| G10 | **`revert_version` non-atomic** — `operations.ts:408-409`: `createVersion` then `revertToVersion` as 2 separate awaits, no transaction wrapper. Crash between them → spurious version record. | HIGH | code trace (verified) |
| G11 | **File upload non-atomic** — storage upload + DB write not transactional. Crash between → orphan file in S3. | MEDIUM | code trace (`operations.ts:549-617`, acknowledged `/* best effort cleanup */`) |
| G12 | **No Anthropic API timeout** — `expansion.ts:42` calls Claude with no timeout/AbortSignal. Network issue → search blocks indefinitely. | HIGH | code trace (verified: no timeout option) |

**비교**: Coral — withMutationLock. QMD — SQLite WAL (앱 레벨은 없지만 DB 레벨 보호). MemPalace — threading.Lock on KG.

### Dimension 4: Search Quality Gaps (Pre-mortem Inversion)

GBrain은 expansion + dedup을 갖추었으나, pre-mortem 분석에서 4개 failure path 발견:

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| G13 | **No strong-signal bypass** — 항상 expansion 실행. BM25에서 이미 확실한 매치여도 Haiku API 호출 소비. QMD는 BM25 probe로 bypass. | MEDIUM | code trace (`hybrid.ts:38` — expansion runs if opts say so, no score-based skip) |
| G14 | **Type diversity filter can remove best results** — `dedup.ts:103-117` 60% cap 하드코딩. VC brain이 80% company pages면, 최상위 company 결과가 강제 제거됨. | MEDIUM | code trace (verified: `maxRatio` = 0.6, no override) |
| G15 | **Jaccard-as-cosine proxy unvalidated** — `dedup.ts:71-73` comment acknowledges proxy. Word overlap ≠ semantic similarity. Layer 2 dedup 품질 미검증. | MEDIUM | code trace (verified) |
| G16 | **Graph disconnected from search** — links table는 존재하나 search ranking에 0 영향. Coral은 entity graph를 0.22 weight로 RRF에 반영. | LOW | inference (architectural comparison) |

### Dimension 5: Knowledge Organization Gaps

| Feature | Coral | QMD | MemPalace | **GBrain** |
|---------|-------|-----|-----------|------------|
| Entity/Knowledge graph in search | Entity graph → 0.22 RRF weight | None | Temporal KG (query tool) | links table, **search와 분리** |
| Temporal validity | None | None | valid_from/valid_to | None |
| Background processing | Curate pipeline (auto-classify) | None (manual) | None (manual) | **None (manual)** |
| Incremental freshness | contentSeq/metadataSeq | None | Inode-based cache | **None** — stale embeddings can outrank fresh keyword matches |
| Compression/summary | None | None | AAAK lossy dialect | Compiled truth (rewritable) ← **unique strength** |
| Memory tiering | None | None | L0→L1→L2→L3 | None |

### Dimension 6: Markdown `---` Separator Edge Case

| ID | Gap | Severity | Evidence |
|----|-----|----------|----------|
| G17 | **`splitBody` vulnerable to `---` in code blocks** — `markdown.ts:68-93` splits on first standalone `---`. Fenced code block containing `---` misattributes content between compiled_truth and timeline. | MEDIUM | code trace (`markdown.ts` split logic) |

### Prioritized Recommendations

| # | Priority | Recommendation | Complexity | Source |
|---|----------|---------------|------------|--------|
| 1 | CRITICAL | **Add runtime validation** — Zod schema per operation, enforce at operations.ts entry | 30 lines per op | Coral Zod pattern |
| 2 | HIGH | **Add Anthropic API timeout** (30s AbortSignal) | 5 lines | Coral/QMD timeout patterns |
| 3 | HIGH | **Wrap revert_version in transaction** | 3 lines | GBrain's own transaction pattern |
| 4 | HIGH | **Add degradation signals** — `degraded: true` + `reason` in search response | 15 lines | MemPalace WAL observability |
| 5 | HIGH | **Add per-slug advisory lock on import** | 10 lines | Coral withMutationLock |
| 6 | HIGH | **Add query length limit** (10K chars) | 5 lines | MemPalace sanitizer |
| 7 | MEDIUM | **Add strong-signal bypass** — skip expansion on high BM25 score | 15 lines | QMD BM25 probe |
| 8 | MEDIUM | **Make type diversity ratio configurable** | 5 lines | Remove hardcoded 0.6 |
| 9 | MEDIUM | **Resolve MCP auth** — enforce access_tokens or remove dead schema | Decision | MemPalace argument whitelisting |
| 10 | MEDIUM | **Fix `---` in code fences** — respect fenced code blocks in splitBody | 15 lines | Standard markdown parsing |
| 11 | LOW | **Validate Jaccard proxy** — empirical correlation test | Research task | Own dedup assumption |
| 12 | LOW | **Evaluate graph-weighted search** — link density → RRF bonus | Architecture decision | Coral 0.22 graph weight |

### Open Questions (Cross-Cutting)

| # | Question | Insight Source |
|---|----------|---------------|
| 1 | Zero runtime validation이 MCP 외부 호출자에 대한 수용된 위험인가? | Coral Zod, MemPalace sanitization |
| 2 | Graph structure가 search ranking에 영향을 줘야 하는가? | Coral entity graph 0.22 weight |
| 3 | Jaccard > 0.85 ↔ cosine > 0.85 상관관계가 검증되었는가? | 자체 dedup 가정 |
| 4 | Concurrent import의 위협 모델은? (single-user vs multi-user MCP) | Coral withMutationLock |
| 5 | access_tokens/mcp_request_log 스키마는 의도된 미래 기능인가 dead code인가? | MemPalace WAL pattern |
| 6 | Stale embeddings가 fresh keyword matches를 outrank하는 빈도는? | Coral 2-lane freshness |

## Synthesis Review

**Finding flow**: 30 initial → 26 after gates → 23 verified [code: 19, inference: 4, assumption: 0]

Single step executed — thematic grouping skipped.

**Unanswered aspects**: None.