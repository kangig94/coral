# Analysis: Mempalace Project
Date: 2026-04-12
Question: ~/workspace/mempalace을 분석해줘

## Scan Report

**Finding flow**: 36 initial → 30 after gates → 28 verified [code: 24, inference: 4, assumption: 0]

### Project Identity

- **Name**: MemPalace (v3.1.0)
- **Author**: milla-jovovich (Milla Jovovich & Ben Sigman)
- **License**: MIT
- **What**: 로컬 AI 메모리 시스템. 프로젝트/대화를 구조화된 "palace"로 마이닝하여 ChromaDB 벡터 검색 + SQLite knowledge graph로 저장. API key 불필요, 완전 로컬.
- **Target**: AI 코딩 어시스턴트 (Claude Code, ChatGPT, Cursor, Gemini CLI, Codex) 사용자. 세션 간 영구 기억.
- **Runtime**: Python 3.9+, Bun/uv

### Technology Stack

| Component | Technology | Evidence |
|-----------|-----------|----------|
| Vector DB | ChromaDB (HNSW, cosine similarity) | `pyproject.toml:22` |
| Knowledge graph | SQLite (temporal triples) | `mempalace/knowledge_graph.py` |
| MCP | JSON-RPC 2.0 (stdio) | `mempalace/mcp_server.py` |
| Build | Hatchling | `pyproject.toml` |
| Test | pytest (85% coverage threshold) | `pyproject.toml` |
| Lint | ruff | `pyproject.toml` |
| Package manager | uv | `uv.lock` |
| Config | PyYAML | `pyproject.toml:23` |
| Distribution | PyPI (`pip install mempalace`) + Claude/Codex/OpenClaw plugins | `pyproject.toml`, `.claude-plugin/`, `.codex-plugin/` |

### Architecture

```
                   ┌──────────────────────────────────────────────────┐
                   │              USER / AI CLIENT                    │
                   │  (Claude Code, ChatGPT, Cursor, Gemini, Codex)  │
                   └────────────┬────────────────────┬───────────────┘
                                │                    │
                     CLI (argparse)          MCP Server (JSON-RPC 2.0)
                     cli.py (596L)           mcp_server.py (1420L)
                                │                    │
              ┌─────────────────┼────────────────────┼──────────────────┐
              │          SERVICE LAYER                │                  │
              │  miner.py (648L)    searcher.py (168L)                 │
              │  convo_miner.py     query_sanitizer.py                 │
              │  layers.py (493L)   palace_graph.py                    │
              │  dialect.py (1075L) knowledge_graph.py (401L)          │
              │  entity_detector.py entity_registry.py                 │
              │  onboarding.py      room_detector_local.py             │
              └────────────────────────────────────────────────────────┘
                                │                    │
              ┌─────────────────┼────────────────────┼──────────────────┐
              │          STORAGE LAYER                │                  │
              │  palace.py (73L)       knowledge_graph.py (SQLite)     │
              │  backends/base.py      ~/.mempalace/knowledge_graph.sqlite3│
              │  backends/chroma.py                                     │
              │     ChromaDB at ~/.mempalace/palace/                    │
              └────────────────────────────────────────────────────────┘
```

**핵심 특징**: Standalone 모듈 설계 — `dialect.py`, `knowledge_graph.py`, `normalize.py`, `entity_detector.py`, `query_sanitizer.py` 등이 내부 import 0개.

### Data Model

**Palace** (ChromaDB):
- Collection: `mempalace_drawers` (cosine HNSW)
- Document: verbatim text chunk (요약 없음, 원본 보존)
- Metadata: `wing`, `room`, `hall`, `source_file`, `chunk_index`, `added_by`, `filed_at`, `type`, `topic`
- ID: deterministic `drawer_{wing}_{room}_{sha256_prefix}` (idempotent)

**Knowledge Graph** (SQLite temporal):
- `entities`: id, name, type, properties (JSON)
- `triples`: subject → predicate → object + `valid_from`/`valid_to` + confidence
- `attributes`: entity_id → key-value + temporal validity
- Thread-safe with `threading.Lock`

**4-Layer Memory Stack** (`layers.py`):
- L0: Identity (~100 tokens) — `identity.txt`
- L1: Essential (~500-800 tokens) — core context
- L2: On-demand — search results
- L3: Deep search — full vector retrieval

**AAAK Dialect** (lossy abbreviation format):
- Header: `FILE_NUM|PRIMARY_ENTITY|DATE|TITLE`
- Zettel: `ZID:ENTITIES|topic_keywords|"key_quote"|WEIGHT|EMOTIONS|FLAGS`
- Entity codes: 3-letter uppercase (e.g., `ALC=Alice`)
- Emotion codes: abbreviated (e.g., `vul=vulnerability`)

### CLI Surface (12 commands)

| Command | Purpose |
|---------|---------|
| `mempalace init <dir>` | Guided onboarding: entity detection + room detection + config |
| `mempalace mine <dir>` | Project files / conversations (`--mode convos`) 인제스트 |
| `mempalace search "query"` | Semantic search (wing/room 필터) |
| `mempalace wake-up` | L0+L1 context 출력 (~170 tokens) |
| `mempalace compress` | AAAK lossy compression |
| `mempalace split <dir>` | Concatenated transcript 분리 |
| `mempalace status` | Palace 전체 상태 |
| `mempalace repair` | Vector index 재빌드 |
| `mempalace migrate` | ChromaDB version migration |
| `mempalace mcp` | MCP setup command 출력 |
| `mempalace hook run` | Hook logic 실행 (JSON stdin) |
| `mempalace instructions <name>` | Skill instruction 출력 |

### MCP Tools (24개, verified)

| Category | Tools |
|----------|-------|
| Palace (read, 7) | status, list_wings, list_rooms, get_taxonomy, search, check_duplicate, get_aaak_spec |
| Palace (write, 5) | add_drawer, delete_drawer, get_drawer, list_drawers, update_drawer |
| Knowledge Graph (5) | kg_query, kg_add, kg_invalidate, kg_timeline, kg_stats |
| Navigation (3) | traverse, find_tunnels, graph_stats |
| Agent Diary (2) | diary_write, diary_read |
| Hook Mgmt (2) | hook_settings, memories_filed_away |

### Key Patterns

| Pattern | Evidence |
|---------|----------|
| Lazy CLI imports (per command) | `cli.py:40-43, :76, :102` |
| Deterministic IDs (`sha256(wing+room+content[:100])`) | `mcp_server.py:461` |
| Write-ahead log (JSONL, content redacted) | `mcp_server.py:100-120` |
| Inode-based cache invalidation | `mcp_server.py:123-142` |
| Input sanitization (path traversal, null bytes, length) | `config.py:22-58` |
| Argument whitelisting (MCP strips unknown params) | `mcp_server.py:1353` |
| Metadata cache (5s TTL) | `mcp_server.py:192-212` |
| Permission hardening (dirs 0o700, files 0o600) | `config.py:201-202`, `backends/chroma.py:81-82` |
| Backend abstraction (BaseCollection ABC) | `backends/base.py:7-45` |
| HOME isolation in tests (tmpdir redirect) | `tests/conftest.py:17-27` |

### Integration Points

| Integration | Mechanism |
|------------|-----------|
| Claude Code | `.claude-plugin/` — MCP server + 6 skills + hooks |
| Codex CLI | `.codex-plugin/` — MCP server + 5 skills + hook |
| OpenClaw | `integrations/openclaw/SKILL.md` |
| ChromaDB | Embedded vector DB (HNSW cosine), `>=0.5.0,<0.7` |
| Chat formats | Claude Code JSONL, ChatGPT JSON, Slack JSON, plain text |
| Shell hooks | Auto-save every 15 human messages, emergency save before compaction |

### Scan Findings

| ID | Finding | Severity | Provenance |
|----|---------|----------|------------|
| S1 | **`fact_checker.py` phantom** — README에 3회 언급되나 파일 미존재 | HIGH | code trace (verified: `grep -c` 3 matches, `ls` NOT_FOUND) |
| S2 | **Version drift** — `plugin.json:3` v3.0.14 vs `pyproject.toml:3` v3.1.0 (Claude/Codex 플러그인 모두 stale) | HIGH | code trace (both verified) |
| S3 | **Tool count mismatch** — README claims 19 MCP tools, actual TOOLS dict has 24 | MEDIUM | code trace (verified: 24 tools enumerated) |
| S4 | **ChromaDB direct imports bypass abstraction** — `dedup.py`, `repair.py`, `cli.py:279` import chromadb directly instead of `backends/` | MEDIUM | code trace |
| S5 | **MCP server dual client path** — `mcp_server.py` manages own `PersistentClient` cache separately from `backends/chroma.py` | MEDIUM | code trace (`mcp_server.py:123-162`) |
| S6 | **ChromaDB version range risk** — `>=0.5.0,<0.7` spans incompatible storage formats (reason `migrate.py` and `_fix_blob_seq_ids` exist) | MEDIUM | code trace |
| S7 | **`exporter.py` not exposed** — has `export_palace()` but no MCP tool or CLI command | LOW | code trace |
| S8 | **`dedup.py` CLI dead code** — has argparse but no `mempalace dedup` subcommand | LOW | code trace |

## Synthesis Review

**Finding flow**: 36 initial → 30 after gates → 28 verified [code: 24, inference: 4, assumption: 0]

Single step executed — thematic grouping skipped.

**Unanswered aspects**: None — general analysis request fully covered.

## Cross-Cutting Enhancement (2026-04-12)

4개 AI 지식 시스템 비교 분석에서 도출된 추가 findings.
상세 분석: [mempalace-cross-cutting.md](2026-04-12-mempalace-cross-cutting.md)

### New CRITICAL Gap (from comparison)

| ID | Gap | Source Comparison |
|----|-----|-------------------|
| M1 | **Vector-only search** — 4개 중 유일하게 keyword search 없음. 정확한 이름/날짜/구문 검색 시 vocabulary mismatch 발생. Coral/QMD/GBrain 모두 hybrid. | 3개 모두 hybrid search |

### Search Quality (최대 약점)

- No keyword search, no fusion, no expansion, no reranking, no dedup
- Knowledge graph가 search ranking에 0 영향 (Coral은 0.22 weight)
- AAAK compressed text → embedding 품질 저하 (TODO acknowledged)
- Embedding model 미고정 → ChromaDB 업그레이드 시 silent quality degradation

### Data Integrity

- ChromaDB 추상화 bypass: 5개 모듈이 backends/ 우회하여 직접 import (M7, verified: 6 files)
- `_get_collection` 모든 예외 삼��� → real errors를 "No palace found"로 마스킹 (M8)
- Inode-based cache가 WAL 모드 writes를 놓칠 가능성 (M9)

### Testing (unique weakness)

- **Test suite 완전 부재** (M17) — `tests/` 디렉토리 존재, pytest 설정됨, 테스트 파일 0개
- 다른 3개: Coral (vitest), QMD (vitest), GBrain (bun test) 모두 테스트 보유

### Unique Strengths (비��에서 확인)

MemPalace만의 강점: query sanitization (4개 중 유일), permission hardening (가장 철저), WAL audit trail (유일한 ���구현), temporal KG (유일), 4-layer memory stack (유일), AAAK dialect (유일)
