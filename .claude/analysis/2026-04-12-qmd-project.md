# Analysis: QMD Project
Date: 2026-04-12
Question: ~/workspace/qmd를 분석해줘

## Scan Report

**Finding flow**: 32 initial → 28 after gates → 26 verified [code: 22, inference: 4, assumption: 0]

### Project Identity

- **Name**: `@tobilu/qmd` (v2.1.0)
- **Author**: Tobi Lutke (tobi@lutke.com) — Shopify founder
- **License**: MIT, repo: `github.com/tobi/qmd`
- **What**: On-device hybrid search engine for markdown files. BM25 full-text + vector semantic + LLM re-ranking, all local via node-llama-cpp with GGUF models.
- **Target**: 개발자/지식 워커. 로컬 프라이버시 보장 마크다운 검색. Agentic AI 워크플로우 (Claude Code, MCP clients) 지원.
- **Runtime**: Node.js >= 22.0.0, Bun (optional)

### Technology Stack

| Component | Technology | Evidence |
|-----------|-----------|----------|
| LLM inference | node-llama-cpp (GGUF models) | `src/llm.ts` |
| Persistence | SQLite + FTS5 + sqlite-vec | `src/db.ts`, `src/store.ts:757-877` — verified |
| MCP server | @modelcontextprotocol/sdk (stdio + HTTP Streamable) | `src/mcp/server.ts` |
| Code chunking | web-tree-sitter (AST-aware) | `src/ast.ts` |
| Validation | Zod | `src/mcp/server.ts` |
| Build | tsc → `dist/` | `tsconfig.build.json` |
| Test | vitest (30s timeout, serial) | `vitest.config.ts` |
| Package manager | pnpm (primary), bun/npm (supported) | `pnpm-lock.yaml`, `bun.lock` |
| Distribution | npm (`@tobilu/qmd`) + Nix flake + Claude Code plugin | `package.json`, `flake.nix`, `.claude-plugin/` |

### Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │              User Interaction                │
                    │  CLI (qmd.ts)  │  MCP Server  │  SDK (index) │
                    └───────┬────────┴──────┬───────┴──────┬───────┘
                            │               │              │
                    ┌───────▼───────────────▼──────────────▼───────┐
                    │         SDK Public Interface (index.ts)       │
                    │   QMDStore facade: search, get, manage, embed │
                    └───────────────────┬──────────────────────────┘
                                        │
               ┌────────────────────────┼────────────────────────┐
               │                        │                        │
       ┌───────▼───────┐    ┌──────────▼──────────┐    ┌───────▼────────┐
       │  store.ts      │    │  collections.ts      │    │  llm.ts        │
       │  (4673 lines)  │    │  YAML config mgmt    │    │  (1665 lines)  │
       │  Data access,  │    │  Collection CRUD     │    │  LlamaCpp class│
       │  FTS5/Vec search│   │  Context management  │    │  Embed/Rerank  │
       │  Chunking/RRF  │    │  File I/O            │    │  Query expand  │
       └───────┬────────┘    └──────────────────────┘    └───────┬────────┘
               │                                                  │
       ┌───────▼────────┐                                ┌───────▼────────┐
       │  db.ts (96L)   │                                │  ast.ts (391L) │
       │  SQLite compat  │                                │  Tree-sitter   │
       │  Bun/Node dual  │                                │  AST chunking  │
       └─────────────────┘                                └────────────────┘
               │
       ┌───────▼────────┐
       │  SQLite DB      │
       │  ~/.cache/qmd/  │
       │  index.sqlite   │
       └─────────────────┘
```

### Module Map (12,070 total lines)

| Module | LOC | Responsibility |
|--------|-----|---------------|
| `src/store.ts` | 4673 | **Core engine**: SQLite schema, FTS5/vector search, chunking, RRF fusion, hybrid query, document CRUD, embedding, reindex — verified |
| `src/cli/qmd.ts` | 3356 | **CLI**: 모든 subcommand 처리, store lifecycle, terminal UI — verified |
| `src/llm.ts` | 1665 | **LLM**: LlamaCpp class, GGUF model resolution, VRAM lifecycle, embed/generate/rerank, 5min inactivity auto-unload |
| `src/mcp/server.ts` | 836 | **MCP**: query/get/multi_get/status tools, stdio+HTTP transport, dynamic system instructions |
| `src/index.ts` | 541 | **SDK**: `createStore()` facade, type re-exports |
| `src/collections.ts` | 512 | **Config**: YAML `~/.config/qmd/{index}.yml` read/write, collection/context CRUD, dual-write |
| `src/cli/formatter.ts` | 434 | **Output**: JSON/CSV/XML/Markdown/files-list formatting |
| `src/ast.ts` | 391 | **AST chunking**: tree-sitter language detection, per-language function/class/import boundary queries |
| `src/db.ts` | 96 | **DB**: Bun/Node auto-detect, sqlite-vec extension loading, macOS Homebrew fallback |
| `src/maintenance.ts` | 54 | **Housekeeping**: vacuum, orphan cleanup, cache clear, embedding wipe |
| `src/embedded-skills.ts` | 22 | **Plugin**: Base64-encoded Claude Code skill files |

### Data Model (SQLite)

| Table | Type | Purpose | Evidence |
|-------|------|---------|----------|
| `content` | Regular | Content-addressable store (hash → doc text) | `store.ts:757` — verified |
| `documents` | Regular | File-system layer: collection+path → content hash, active flag | `store.ts:767` — verified |
| `documents_fts` | FTS5 | Full-text search: filepath, title, body; tokenize=porter unicode61 | `store.ts:835` |
| `content_vectors` | Regular | Embedding metadata: hash, seq, pos, model, timestamp | `store.ts:802` |
| `vectors_vec` | vec0 | sqlite-vec cosine similarity: hash_seq → float[N] embedding | `store.ts:1080` |
| `llm_cache` | Regular | LLM response cache (query expansion, reranking) | `store.ts:787` |
| `store_collections` | Regular | Self-contained collection config mirror | `store.ts:814` |
| `store_config` | Regular | Key-value metadata (e.g., config_hash for sync) | `store.ts:827` |

FTS5 sync via triggers on `documents` (insert/update/delete): `store.ts:842-877`.

### Search Pipeline (Hybrid Query)

```
User query
  │
  ├─ Step 1: BM25 probe (searchFTS, 20 results)
  │          Strong signal check: score ≥ threshold AND gap ≥ min
  │          → If strong signal + no intent: SKIP expansion (short-circuit)
  │          (store.ts:4024-4036 — verified)
  │
  ├─ Step 2: LLM query expansion (expandQuery via LlamaCpp)
  │          → lex/vec/hyde sub-queries generated
  │
  ├─ Step 3a: FTS for all lex queries (sync, instant)
  ├─ Step 3b: Batch-embed all vec/hyde queries → sqlite-vec lookups
  │
  ├─ Step 4: RRF fusion (reciprocalRankFusion, store.ts:3346-3389 — verified)
  │          First 2 lists: 2x weight, K=60
  │          Top-rank bonus: +0.05 (rank 0), +0.02 (rank 1-2)
  │
  ├─ Step 5: Document chunking (900 tokens/chunk, 15% overlap)
  │          Smart break points: markdown headings, code blocks, AST boundaries
  │
  └─ Step 6: LLM reranking (qwen3-reranker)
             Final score = blend(rrfScore, rerankScore)
```

`structuredSearch` variant (`store.ts:4399`) takes pre-expanded queries, skips Step 1-2.

### CLI Surface

| Command | Purpose |
|---------|---------|
| `qmd search <query>` | BM25 keyword search (no LLM) |
| `qmd vsearch <query>` | Vector similarity search |
| `qmd query <query>` | Full hybrid: expand + multi-signal + rerank |
| `qmd get <path\|docid>` | Single document retrieval |
| `qmd multi-get <pattern>` | Batch retrieve by glob |
| `qmd collection add/list/remove/rename/...` | Collection CRUD |
| `qmd context add/list/rm/check` | Context hierarchy management |
| `qmd update [--pull]` | Re-index all collections |
| `qmd embed` | Generate vector embeddings |
| `qmd pull` | Download/update LLM models |
| `qmd mcp [--http] [--daemon]` | Start MCP server |
| `qmd status` | Index health and statistics |
| `qmd bench` | Reranking benchmark suite |
| `qmd skill show/install` | Embedded skill management |

### MCP Tools

| Tool | Purpose |
|------|---------|
| `query` | Structured search with typed sub-queries, intent, collections |
| `get` | Single document retrieval with line range support |
| `multi_get` | Batch document retrieval by glob pattern |
| `status` | Index health and collection info |
| Resource: `qmd://{path}` | Read-only document access via URI |

### LLM Models (Defaults)

| Role | Model | Evidence |
|------|-------|----------|
| Embedding | `embeddinggemma` | `store.ts:42` — verified |
| Reranking | `ExpedientFalcon/qwen3-reranker:0.6b-q8_0` | `store.ts:43` — verified |
| Query expansion | `Qwen/Qwen3-1.7B` | `store.ts:44` — verified |

### Configuration

| Config | Location | Purpose |
|--------|----------|---------|
| YAML config | `~/.config/qmd/{index}.yml` | Collection definitions, contexts, model config |
| SQLite DB | `~/.cache/qmd/index.sqlite` | Self-contained index + mirrored config |
| Model cache | `~/.cache/qmd/models/` | GGUF model files |
| MCP PID | `~/.cache/qmd/mcp.pid` | HTTP daemon tracking |

Key env vars: `QMD_EMBED_MODEL`, `QMD_GENERATE_MODEL`, `QMD_RERANK_MODEL`, `QMD_LLAMA_GPU`, `NO_COLOR`, `CI`.

### Key Patterns

| Pattern | Evidence |
|---------|----------|
| Content-addressable storage (hash → doc) | `store.ts:757-778` — verified |
| Dual-write config (SQLite + YAML simultaneously) | `index.ts:431-479` |
| Lazy model loading + 5min inactivity auto-unload | `llm.ts:521-546` |
| Graceful degradation (sqlite-vec optional → BM25 only; tree-sitter optional) | `db.ts:41-51`, `ast.ts` |
| Cross-runtime compat (Bun/Node auto-detect) | `db.ts:14-56` |
| Smart chunking (scored break points + distance decay) | `store.ts:97-224` |
| RRF fusion (weighted lists + top-rank bonus) | `store.ts:3346-3389` — verified |
| Strong-signal short-circuit (skip LLM expansion on clear BM25 winner) | `store.ts:4024-4036` — verified |
| Batch embedding (single call for all vector queries) | `store.ts:4089-4094` |
| Document ID = first 6 chars of content hash | `store.ts:1702-1703` |

### Integration Points

| Integration | Mechanism |
|------------|-----------|
| Claude Code | Plugin marketplace + MCP server + embedded skills |
| Claude Desktop | MCP server (stdio) via config |
| Any MCP client | Stdio or HTTP Streamable transport |
| node-llama-cpp | GGUF model loading, embedding, generation, reranking |
| SQLite / sqlite-vec | Persistence, FTS5, vector similarity |
| Tree-sitter | AST-aware code chunking (.ts/.js/.py/.go/.rs) |
| Git | Optional `--pull` flag during `qmd update` |
| Nix/home-manager | System-level installation via flake |

### Scan Findings

| ID | Finding | Severity | Provenance |
|----|---------|----------|------------|
| S1 | `store.ts` is a 4673-line monolith (schema, chunking, search, indexing, RRF, CRUD, caching, maintenance) | HIGH | code trace (LOC verified) |
| S2 | `cli/qmd.ts` is a 3356-line monolith handling all commands with no module separation | HIGH | code trace (LOC verified) |
| S3 | No `docs/architecture.md` — `docs/` only contains `SYNTAX.md`. README provides overview but no module-level architecture doc | MEDIUM | code trace |
| S4 | `finetune/` directory contains full Python ML training pipeline (reward model, GRPO, ONNX/GGUF conversion) but is not referenced from README or docs | LOW | code trace |

## Cross-Cutting Enhancement (2026-04-12)

4개 AI 지식 시스템 비교 분석에서 도출된 추가 findings.
상세 분석: [qmd-cross-cutting.md](2026-04-12-qmd-cross-cutting.md)

### New CRITICAL/HIGH Gaps (from comparison)

| ID | Gap | Source Comparison |
|----|-----|-------------------|
| Q4 | **Multi-step writes without transactions** — insertContent + updateDocument not wrapped | GBrain engine.transaction() |
| Q5 | **Non-atomic YAML config write** — writeFileSync, not write-then-rename | Coral writeFileAtomic |
| Q8 | **LLM prompt injection** — user-supplied intent concatenated directly into reranker prompt | MemPalace 4-step sanitizer |
| Q12 | **No search timeout** — hybridQuery blocks indefinitely on hung model | Coral/MemPalace timeout |
| Q1 | **No contract layer** — CLI/MCP/SDK have separate search implementations | GBrain contract-first |
| Q2 | **CLI zero input validation** — 3356L CLI, no Zod | Coral Zod at all boundaries |

### Mutation Safety (worst among all 4)

QMD는 WAL 모드만, 앱 레벨 serialization 없음, SQLITE_BUSY retry 없음, 비원자적 YAML 쓰기.
- Coral: writeFileAtomic + withMutationLock
- GBrain: Postgres transactions
- MemPalace: thread Lock + WAL audit trail

### Knowledge Organization (design choice, not necessarily a gap)

QMD는 flat collection model. Entity graph (Coral), typed pages (GBrain), temporal KG (MemPalace) 모두 없음.
Search quality는 signal 품질(expansion + reranking)에 전적으로 의존 — 가장 정교한 파이프라인이지만 구조적 context enrichment 없음.

### finetune/ Shadow Codebase (Q16)

Python training pipeline과 TypeScript runtime 간 shared constants (score thresholds, stop words, query format) 자동 parity check 없음.

## Synthesis Review

**Finding flow**: 32 initial → 28 after gates → 26 verified [code: 22, inference: 4, assumption: 0]

Single step executed — thematic grouping skipped.

**Unanswered aspects**: None — "분석해줘" is a general project understanding request, fully covered by architecture scan.
