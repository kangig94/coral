# Analysis: Integrated Four-Project Evaluation
Date: 2026-04-12
Question: 4개 프로젝트 통합 분석 — 정량적 정성적 평가
Sources: 8 analysis files, 213 verified findings (Coral 68, QMD 46, GBrain 50, MemPalace 49)

## Quantitative Dimension Scores

### Score Matrix (0-10)

| Dimension | Weight | Coral KB | QMD | GBrain | MemPalace |
|-----------|--------|----------|-----|--------|-----------|
| 1. Search Quality | 2x | 6 | **9** | 7 | 1 |
| 2. Input Validation & Security | 1x | 7 | 3 | 2 | **8** |
| 3. Data Integrity & Mutation Safety | 2x | **7** | 3 | 6 | 5 |
| 4. Modularity & Code Quality | 1x | **9** | 2 | 8 | 6 |
| 5. Operational Maturity | 1x | **8** | 6 | 5 | 4 |
| 6. API Surface Design | 1x | 7 | 5 | **9** | 4 |
| 7. Knowledge Organization | 1x | 7 | 4 | 5 | **8** |
| 8. Testing & Documentation | 1x | **8** | 5 | 4 | 2 |

**Bold** = dimension leader.

### Weighted Composite (Search Quality + Data Integrity = 2x weight)

| Rank | Project | Score | Character |
|------|---------|-------|-----------|
| **1** | **Coral KB** | **72/100** | 가장 강한 기반: 최고 모듈성, 최고 검증, 최고 운영 성숙도 |
| **2** | **GBrain** | **59/100** | 가장 우아한 설계이지만 가장 취약한 런타임 |
| **3** | **QMD** | **49/100** | 가장 정교한 검색 엔진이 가장 나쁜 코드 구조에 갇힘 |
| **4** | **MemPalace** | **44/100** | 가장 혁신적 지식 모델이지만 검색 + 테스트 부재 |

### Dimension Leaders & Laggards

| Dimension | Leader | Score | Laggard | Score |
|-----------|--------|-------|---------|-------|
| Search Quality | QMD | 9 | MemPalace | 1 |
| Validation & Security | MemPalace | 8 | GBrain | 2 |
| Data Integrity | Coral KB | 7 | QMD | 3 |
| Modularity | Coral KB | 9 | QMD | 2 |
| Operational Maturity | Coral KB | 8 | MemPalace | 4 |
| API Surface Design | GBrain | 9 | MemPalace | 4 |
| Knowledge Organization | MemPalace | 8 | QMD | 4 |
| Testing & Docs | Coral KB | 8 | MemPalace | 2 |

### Radar Profile

```
                    Search Quality (2x)
                         10
                          │
                     8 ···│··· 
                    /     │     \
Testing & Docs  6 /  ····│····  \ Input Validation
               /    Coral│KB     \
              4 ···  72/100  ···· 4
              │         │         │
Knowledge  6  │    ·····│·····    │  Data Integrity (2x)
Org           │         │         │
              4 ···  ·······  ··· 4
               \        │       /
API Surface  6  \  ·····│····  / Modularity
                  \     │    /
                   8 ···│··· 
                        │
                  Op. Maturity
```

## Qualitative Assessment

### Per-Project

| Project | 설계 철학 | 고유 혁신 | 치명적 결함 | 모범 교훈 | 반면 교훈 |
|---------|----------|----------|------------|----------|----------|
| **Coral KB** | Defense-in-depth + layered decomposition. 모든 boundary를 schema로, 모든 module을 layer로, 모든 write를 atomic으로. | Entity graph가 search ranking에 직접 참여 (0.22 weight). Background curate (LLM 분류→원칙 발견→커뮤니티 탐지). | Post-fusion 품질 파이프라인 부재. 3 lane → RRF → 바로 응답. Reranking, dedup, expansion 없음. | **Layer discipline** — L0/L1/L2 strict dependency가 monolith 방지. | In-process-only mutex — 단일 프로세스 가정이 확장 시 깨짐. |
| **QMD** | Search quality maximalism. 알려진 모든 검색 기법을 투입: BM25, vector, LLM expansion, LLM reranking, AST chunking, strong-signal bypass. | Strong-signal short-circuit (확실한 매치 → expensive pipeline 건너뜀). AST-aware tree-sitter chunking (코드 함수 경계 존중). | **Monolith** — store.ts 4673L, 80+ exports. F1 엔진을 섀시 없는 차에 넣은 격. | **Strong-signal short-circuit** — 확실한 답이 있으면 비싼 연산 건너뜀. | **3-way validation split** — 같은 API에 surface마다 다른 안전 보장. |
| **GBrain** | Contract-first minimalism. 하나의 operations.ts가 진실의 원천, 모든 surface 자동 생성. ~4K lines로 가장 가벼움. | Single-source contract pattern + pluggable engine (PGLite ↔ Postgres). 4-layer dedup (best-per-page, Jaccard, type diversity, chunk cap). | **Zero runtime validation** — 30+ `as` casts. 아름다운 계약이 실행 시 아무것도 강제하지 않음. | **Contract-first auto-generation** — operations.ts 하나로 CLI/MCP/tools-json drift 제거. | **Silent degradation** — 3곳에서 실패 무시. 경고등이 끊긴 대시보드. |
| **MemPalace** | Security-first personal memory. 모든 파일에 권한, 모든 쿼리에 sanitization, 모든 쓰기에 WAL. 지식을 민감 데이터로 취급. | Temporal KG (valid_from/valid_to). AAAK lossy compression dialect. 4-layer memory stack (L0→L3). | **Vector-only search** — keyword search 0. AAAK compression이 유일한 search lane 품질을 저하시키는 자기 모순. | **Write-ahead log** — 4개 중 유일한 감사 추적. mutation recovery 경로 제공. | **Empty test suite for security-focused project** — 검증 안 된 보안 주장은 보안 극장. |

## Cross-Project Patterns

### Universal Gaps (4개 모두 공유)

| # | Gap | Impact |
|---|-----|--------|
| 1 | **Search timeout 없음** — 4개 모두 검색에 timeout 미구현. Hung query → DoS. | CRITICAL |
| 2 | **Embedding model 미고정** — 4개 모두 모델 버전 미잠금. Provider 업데이트 → silent vector 비호환. | HIGH |
| 3 | **Result dedup 미흡** — Coral 없음, QMD content-level 없음, GBrain Jaccard proxy 미검증, MemPalace 없음. | MEDIUM |
| 4 | **Version drift** — GBrain (0.9.0 vs 0.4.1), MemPalace (3.1.0 vs 3.0.14), QMD (finetune/ 미동기). | MEDIUM |

### Complementary Strengths (각 프로젝트의 최강점이 다른 프로젝트의 약점 커버)

```
QMD strong-signal bypass ──────────→ Coral 항상 full pipeline 실행
Coral Zod-on-all-boundaries ───────→ GBrain zero validation
MemPalace WAL audit trail ─────────→ QMD multi-step writes 무보호
GBrain contract-first auto-gen ────→ MemPalace CLI/MCP feature drift
Coral layer discipline ────────────→ QMD monolith 문제
MemPalace temporal KG ─────────────→ GBrain basic page model
QMD LLM reranking ─────────────────→ Coral post-fusion 품질 부재
GBrain 4-layer dedup ──────────────→ 나머지 3개 모두 dedup 부재
```

### Industry Convergence (독립적으로 같은 결론 도달)

| Pattern | Coral | QMD | GBrain | MemPalace |
|---------|-------|-----|--------|-----------|
| **RRF K=60** | Yes | Yes | Yes | N/A |
| **Hybrid search (keyword + vector)** | Yes | Yes | Yes | **No** (outlier → 최약 검색) |
| **Hash-based idempotency** | Yes | Yes | Yes | Yes |
| **LLM query/content enrichment** | Yes (curate) | Yes (expansion) | Yes (expansion) | No |

### Divergent Bets (같은 문제, 다른 선택)

| Problem | Coral KB | QMD | GBrain | MemPalace |
|---------|----------|-----|--------|-----------|
| 실행 환경 | Plugin daemon (HTTP) | 완전 로컬 (no API) | Postgres (local/remote) | ChromaDB (local) |
| 청킹 전략 | Section/paragraph | AST-aware tree-sitter | Recursive 300w/50 overlap | Fixed 800 char window |
| Graph ↔ Search | **통합** (0.22 weight) | 없음 | 분리 | 분리 |
| 검증 철학 | Schema everywhere (Zod) | Schema sometimes (split) | Schema nowhere (casts) | Permission everywhere (OS) |
| Mutation safety | Atomic files + mutex | Content-addressable | DB transactions | WAL + permissions |
| 검색 품질 전략 | More lanes | More stages | Better dedup | Not addressed |

**가장 흥미로운 divergence**: Graph strategy — 3개 프로젝트가 KG를 보유하지만 통합 결정이 완전히 다름. Coral만 graph가 retrieval에 직접 영향. GBrain/MemPalace는 조직용만.

## Use-Case Rankings

| Use Case | 1위 | 2위 | 3위 | 4위 |
|----------|-----|-----|-----|-----|
| **Developer Tool** (코드 검색, 일상 워크플로우) | QMD (AST chunking, local, fast) | Coral KB (plugin, curation) | GBrain (contract-first) | MemPalace (exact-match 불가) |
| **Personal Memory** (일상 지식, 일기, 시간 추적) | MemPalace (temporal KG, L0-L3, security) | Coral KB (조직, 검증, curation) | GBrain (compiled truth) | QMD (개발자 중심) |
| **Enterprise Knowledge** (팀 KB, 컴플라이언스, 감사) | Coral KB (검증, 모듈성, mutation safety) | GBrain (contract-first, 트랜잭션) | MemPalace (WAL, 권한 — 단 테스트 0) | QMD (monolith, validation split) |
| **AI Agent Brain** (자율 에이전트 메모리) | Coral KB (graph→search, auto-curation) | GBrain (contract auto-gen, pluggable engine) | QMD (최고 검색 품질) | MemPalace (temporal graph, 단 vector-only) |

## Synthesis Review

**Finding flow summary**:
- Prior analyses: 213 verified findings across 8 files
- This synthesis: 0 new investigation (pure synthesis of existing findings)
- Scoring: 32 dimension scores + 4 qualitative profiles + 4 cross-project patterns

**Cross-step consistency**: 이 통합 분석에서 기존 분석과의 모순 없음. 모든 점수가 verified code-trace evidence에 기반.

**Unanswered aspects**: None — 정량적 (8차원 점수 + 가중 복합) + 정성적 (철학/혁신/결함/교훈) + 교차 패턴 + 사용 사례별 순위 모두 완료.