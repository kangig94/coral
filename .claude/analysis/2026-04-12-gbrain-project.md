# Analysis: GBrain Project
Date: 2026-04-12
Question: ~/workspace/gbrain을 분석해줘

## Scan Report

**Finding flow**: 34 initial → 30 after gates → 27 verified [code: 23, inference: 4, assumption: 0]

### Project Identity

- **Name**: GBrain (v0.9.0)
- **Author**: Garry Tan (garrytan)
- **License**: MIT
- **What**: Postgres-native personal knowledge brain with hybrid RAG search. AI 에이전트가 매일 더 똑똑해지는 장기 기억 시스템.
- **Target**: AI agent 운영자 (OpenClaw/Hermes Agent 사용자) 및 파워유저. 마크다운 파일을 git repo에 저장하고, Postgres + pgvector로 인덱싱.
- **Runtime**: Bun (ESM), compiled binary 배포 가능

### Technology Stack

| Component | Technology | Evidence |
|-----------|-----------|----------|
| Runtime | Bun (ESM) | `package.json:5`, `bun.lock` |
| DB (dual engine) | PGLite (embedded WASM Postgres 17.5) + Remote Postgres | `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts` |
| Vector search | pgvector + HNSW cosine (1536 dims) | `schema.sql:35` |
| Embeddings | OpenAI text-embedding-3-large | `src/core/embedding.ts:12` |
| Query expansion | Anthropic Claude Haiku (tool use) | `src/core/search/expansion.ts` |
| MCP | @modelcontextprotocol/sdk (stdio) | `src/mcp/server.ts` |
| File storage | AWS S3 / R2 / MinIO / Supabase Storage | `src/core/storage/` |
| Frontmatter | gray-matter | `src/core/markdown.ts` |
| Build | `bun build --compile` (cross-platform binary) | `package.json:18-19` |
| Test | Bun test runner + Docker pgvector | `docker-compose.test.yml` |
| Distribution | npm-style + ClawHub plugin + GitHub releases binary | `openclaw.plugin.json` |

### Architecture

```
                    ┌─────────────────────────────────────────┐
                    │         User / AI Agent                 │
                    └────────┬──────────┬──────────┬──────────┘
                             │          │          │
                    CLI      │    MCP   │   Library│
                    (bun)    │  (stdio) │   import │
                             ▼          ▼          ▼
   ┌─────────────────────────────────────────────────────────┐
   │  L2  Entry Points                                       │
   │  src/cli.ts (438L) ── commands/*.ts ── mcp/server.ts (90L) │
   └─────────────────────┬───────────────────────────────────┘
                         │ delegates to
                         ▼
   ┌─────────────────────────────────────────────────────────┐
   │  L1  Operations Layer (contract-first, single source)   │
   │  src/core/operations.ts (666L) — 30 operations          │
   └────────────┬────────────────────────────────────────────┘
                │ calls engine methods
                ▼
   ┌─────────────────────────────────────────────────────────┐
   │  L0  Core Domain (pluggable engine interface)           │
   │  engine.ts (81L) — BrainEngine interface (37 methods)   │
   │  engine-factory.ts — PGLite | Postgres dispatch         │
   │  types.ts (184L) — Page, Chunk, SearchResult, Link...   │
   │  import-file.ts (125L) — parse → hash → chunk → embed   │
   │  search/ — hybrid.ts (98L), expansion.ts, dedup.ts      │
   │  chunkers/ — recursive.ts, semantic.ts, llm.ts          │
   │  storage/ — s3.ts, supabase.ts, local.ts                │
   └─────────────────────────────────────────────────────────┘
```

**핵심 설계**: Contract-first. `operations.ts` 하나가 30개 operation을 정의하고, CLI/MCP/tools-json이 모두 이 single source에서 생성됨. Parity test가 구조적 동일성 검증.

### Data Model

**Core entity: Page** — 유니버설 지식 단위
- **Slug**: repo-relative path (e.g., `people/pedro-franceschi`)
- **Type**: 9종 — `person | company | deal | yc | civic | project | concept | source | media`
- **Structure**: `compiled_truth` (현재 이해, rewritable) + `timeline` (append-only 증거 기록), `---`로 분리
- **Content hash**: SHA-256 for import idempotency

**10 Postgres tables** (`schema.sql`, 274 lines):

| Table | Purpose |
|-------|---------|
| `pages` | Core content (slug, type, title, compiled_truth, timeline, frontmatter, search_vector) |
| `content_chunks` | Chunked content + `vector(1536)` embeddings, HNSW index |
| `links` | Typed cross-references between pages |
| `tags` | Many-to-many page-to-tag |
| `timeline_entries` | Structured timeline events |
| `page_versions` | Snapshot history for compiled_truth |
| `raw_data` | Sidecar JSONB from external APIs |
| `files` | Binary attachment metadata |
| `ingest_log` | Import audit trail |
| `access_tokens` + `mcp_request_log` | Remote MCP access control + usage logging |

### Search Pipeline

```
Query → Multi-query expansion (Claude Haiku, 2 alternatives)
  → Embed all variants (OpenAI text-embedding-3-large)
  → Parallel: vector search (HNSW cosine) + keyword search (tsvector ts_rank)
  → RRF Fusion: score = sum(1/(60 + rank))
  → 4-layer dedup: best-per-page → Jaccard > 0.85 → type diversity 60% cap → per-page chunk cap
  → Results with stale alerts
```

Graceful fallback: OpenAI key 없으면 keyword-only 검색 (`hybrid.ts:32-34`).

### Chunking Strategies

| Strategy | Description | Usage |
|----------|-------------|-------|
| Recursive (default) | 5-level delimiter hierarchy, 300 words, 50-word overlap | `import-file.ts:52` — 기본 파이프라인 |
| Semantic | Sentence embedding + Savitzky-Golay smoothing for topic boundaries | Available but not wired |
| LLM-guided | Claude Haiku identifies topic shifts in sliding windows | Available but not wired |

### CLI Surface (40+ commands)

**Operation-backed (30, CLI + MCP 동일)**:
get, put, delete, list, search, query, tag, untag, tags, link, unlink, backlinks, graph, timeline, timeline-add, stats, health, history, revert, sync

**CLI-only**:
init, upgrade, check-update, integrations, publish, check-backlinks, lint, report, import, export, files, embed, serve, call, config, doctor, migrate

### MCP Server

- Stdio transport only, `gbrain serve`로 시작
- 30개 operation을 MCP tool로 자동 생성 (`mcp/server.ts:17-36`)
- Resource: 없음 (tool-only)

### Key Patterns

| Pattern | Evidence |
|---------|----------|
| Contract-first (single operations source → CLI/MCP/tools-json) | `operations.ts:1-4` — verified |
| Pluggable engine (BrainEngine interface + factory dispatch) | `engine.ts:14`, `engine-factory.ts` — verified |
| Compiled truth + timeline (rewritable above `---`, append-only below) | `markdown.ts:68-93` |
| Content-addressed idempotency (SHA-256 hash) | `import-file.ts:33-47` |
| Transactional writes (version + putPage + tags + chunks in tx) | `import-file.ts:74-99` |
| Graceful degradation (no OpenAI key → keyword-only) | `hybrid.ts:32-34` |
| File fallback chain (local → .redirect.yaml → .redirect → .supabase) | `file-resolver.ts:50-99` |
| Embedded SQL migrations (Bun compile strips fs) | `migrate.ts:24-85` |
| Fat skills, thin harness (agent behavior in markdown, not code) | `skills/manifest.json`, `docs/ethos/THIN_HARNESS_FAT_SKILLS.md` |
| Retry with backoff (embedding: 5 retries, 4s base, 120s cap) | `embedding.ts:49-83` |
| Type inference from path (people/ → person, companies/ → company) | `markdown.ts:125-139` |

### Integration Points

| Integration | Mechanism |
|------------|-----------|
| OpenAI API | Embeddings (text-embedding-3-large, 1536d) |
| Anthropic API | Multi-query expansion (Claude Haiku tool use) |
| MCP Protocol | stdio, 30 tools |
| Supabase | Postgres + pgvector + Storage |
| PGLite | Embedded WASM Postgres 17.5 (zero-config) |
| AWS S3 / R2 / MinIO | Binary file storage |
| Git | Brain repo sync (diff, pull) |
| ClawHub | Plugin distribution |
| GitHub API | Self-update (check-update, upgrade) |
| Recipes | Twilio voice, Gmail, Google Calendar, X/Twitter, Circleback meetings |

### Scan Findings

| ID | Finding | Severity | Provenance |
|----|---------|----------|------------|
| S1 | **No Zod validation** — operations use manual `p.slug as string` casting. ParamDef is informational, not enforced. | HIGH | code trace (`operations.ts:90` — verified) |
| S2 | **Version drift** — `package.json:3` v0.9.0 vs `openclaw.plugin.json:3` v0.4.1. No automated sync. | MEDIUM | code trace (both verified) |
| S3 | **File ops bypass engine** — `file_list/upload/url` in operations.ts use direct `db.getConnection()` instead of BrainEngine interface | MEDIUM | code trace (`operations.ts:538-635`) |
| S4 | **MCP lacks HTTP transport** — stdio only. TODOS.md documents as P2 blocker for ChatGPT OAuth 2.1. | MEDIUM | code trace + doc reference |
| S5 | **PGLite binary limitation** — WASM cannot be embedded in `bun build --compile` (Bun issue #15032) | MEDIUM | doc reference (TODOS.md:22-31) |
| S6 | **No CI E2E on PR** — `test.yml` runs unit only; E2E requires separate workflow trigger | MEDIUM | code trace |
| S7 | **Semantic/LLM chunkers unused** — exist in `chunkers/` but not wired into default import pipeline | LOW | code trace (`import-file.ts:52`) |
| S8 | **Single-threaded embedding** — no batch queue across workers | LOW | inference (TODOS.md reference) |

### Peripheral Findings

- Recipe health checks use shell commands (arbitrary code execution) — TODOS.md documents as P1 blocker for community recipes
- `finetune/` directory likely absent (not found in `src/` listing, may be QMD-specific confusion — dropped)

## Synthesis Review

**Finding flow**: 34 initial → 30 after gates → 27 verified [code: 23, inference: 4, assumption: 0]

Single step executed — thematic grouping skipped.

**Unanswered aspects**: None — general analysis request fully covered.

## Cross-Cutting Enhancement (2026-04-12)

4개 AI 지식 시스템 비교 분석에서 도출된 추가 findings.
상세 분석: [gbrain-cross-cutting.md](2026-04-12-gbrain-cross-cutting.md)

### New CRITICAL Gap (from comparison)

| ID | Gap | Source Comparison |
|----|-----|-------------------|
| G1 | **Zero runtime validation** — 30+ ops use `as` casting, ParamDef is docs-only. MCP accepts arbitrary JSON. 4개 중 유일하게 validation 0%. | Coral Zod (100%), MemPalace sanitizer |

### Silent Degradation (unique weakness)

3곳에서 API 실패를 무시, 호출자에 degradation 신호 0:
- Embedding failure: `catch { /* non-fatal */ }` → chunks with null embeddings (G5)
- Vector search failure: silent keyword-only fallback (G6)
- Expansion failure: `catch { return [query] }` (G7)
- **비교**: QMD 로컬 모델 = API 실패 없음. Coral structured error 전파. MemPalace WAL 기록.

### Concurrency Gaps

- Import: 외부 API embedding → transaction, per-slug lock 없음. Concurrent import 시 이중 API 호출 + race (G9)
- Revert: `createVersion` + `revertToVersion` 비트랜잭션 2-step (G10)
- Anthropic API timeout 없음 — search 무한 블록 가능 (G12)

### Search Quality (Pre-mortem)

- No strong-signal bypass (QMD 패턴) — 확실한 BM25 매치여도 항상 Haiku 호출 (G13)
- Type diversity 60% 하드코딩 — VC brain에서 company pages 강제 제거 (G14)
- Jaccard-as-cosine proxy 미검증 (G15)
- Graph ↔ search 완전 분리 — links가 ranking에 0 영향 (G16)

### Dead Schema Risk (G8)

`access_tokens` + `mcp_request_log` tables exist in schema.sql but server.ts never references them → false security confidence.
