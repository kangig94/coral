# Pre-plan: KB Wiki System

## Problem Statement
- Current state: Coral KB has notes (stable, cross-domain), sources (immutable evidence), communities (auto-generated clusters), principles (cross-domain rules). Knowledge is static — once a note is created it rarely changes. There is no living knowledge layer that synthesizes across sources, evolves as new evidence arrives, and provides context-efficient briefings to the LLM on session start.
- Desired state: A wiki layer — a fully independent entry kind (`wiki:{slug}`) in `~/.coral/kb/wiki/` — where entries are living documents that grow/evolve, with self-organizing knowledge sectors (LRU move-to-front) and a wake-up packet for LLM session context.

## Success Criteria
- [ ] `wiki:{slug}` is a first-class entry kind alongside `note:`, `source:`, `community:`
- [ ] Wiki entries live in `~/.coral/kb/wiki/` with own frontmatter, path functions, and CRUD ops
- [ ] Full CRUD: LLM creates during conversation, user/LLM updates, deletes, lists, reads
- [ ] Wiki body: `## Understanding` (rewritable narrative) + `## Knowledge` (ordered reference list) + `## Evidence` (append-only log)
- [ ] Knowledge sector items are `[[wikilinks]]` to any entry type (notes, sources, wikis, communities) + annotation
- [ ] Knowledge sector self-organizes: `kb read` of a linked entry triggers move-to-front in the referencing wiki
- [ ] Curate maintains existing wiki entries: updates Understanding when new sources arrive, appends Evidence
- [ ] Wake-up packet (~900 tokens) generated from most recently active wiki entries, served via `kb wake-up`
- [ ] `kb search --scope wiki` filters to wiki entries; `kind='wiki'` in Orama
- [ ] Search ranking: wiki results prioritized above notes (`KIND_ORDER` wiki=0), promoted wiki defers to its note
- [ ] `kb read` cascade: memo → note → wiki → community → source → principle
- [ ] Promotion: `kb wiki promote` copies Understanding to new note; wiki keeps `promotedTo`, shows redirect, continues collecting evidence
- [ ] All wiki entries are valid Obsidian markdown with [[wikilinks]], #tags in frontmatter, graph rendering

## Scope
- Included:
  - New `KbEntryId` variant: `wiki:${string}`
  - New `WikiEntry` type in `EntryRecord` union
  - New `KbWikiFrontmatter`: tags, sources (KbEntryId[]), references_principles (string[]), createdAt, updatedAt, entrySeq, related, promotedTo
  - New directory `~/.coral/kb/wiki/` with `wikiDir()`, `wikiPath()` path functions
  - `wiki` value in `KbSearchScope`, `kind='wiki'` in Orama schema
  - Full CRUD operations: create, read, update, list, delete
  - Body convention: `## Understanding` (rewritable) + `## Knowledge` (self-organizing ordered [[wikilink]] list) + `## Evidence` (append-only)
  - Move-to-front: when `kb read` resolves an entry that a wiki's Knowledge sector links to, that item moves to the front of the list
  - Curate extension: wiki maintenance phase (update Understanding from new sources, append Evidence)
  - Wake-up packet: generated from recently active wiki entries, cached, served via `kb wake-up`
  - Promotion: copy to note + `promotedTo` field + redirect in wiki Understanding
  - `wiki/.wake-up.md` (gitignored, generated projection)

- Excluded:
  - Entry-level confidence/scoring (no confidence field on wiki frontmatter)
  - Knowledge sector scoring/decay algorithm (Phase 3 — forgetting system)
  - Deprecated label logic for low-rank knowledge items (Phase 3)
  - Auto git-repo wiki generation (Phase 2)
  - AAAK-style compression
  - Palace metaphor / manual hierarchy (entity graph + communities provide automatic organization)
  - `principles` field on wiki (uses `references_principles` instead — references only, no production)
  - WAL audit trail (불필요 — markdown 파일 자체가 기록, Evidence 섹션이 append-only 이력)

- Legacy:
  - Existing notes, sources, communities, principles completely unaffected
  - `parseKbEntryId` gains `wiki:` prefix handling (additive)
  - `entryIdToVaultLink` gains `wiki/` directory mapping (additive)
  - Orama schema kind field gains `'wiki'` value (additive)
  - `readEntry` cascade gains wiki step between note and community (additive)

## Assumptions
- Adding `wiki:` to `KbEntryId` union and related dispatch sites is bounded (each gains one new branch)
- Move-to-front on `kb read` can be implemented by rewriting the Knowledge section of referencing wiki entries — the performance cost of scanning wiki entries for backlinks is acceptable for typical KB sizes
- LLM-created wiki entries during conversation will have sufficient quality (the LLM has session context + source access)
- Curate can identify which wiki entries to update when new sources arrive (via shared tags/entities)
- ~900 token wake-up packet from recent wiki entries provides sufficient session context
- Obsidian renders unknown frontmatter fields (references_principles, promotedTo, sources) without issues
- Wiki entries as curate maintenance targets (not creation targets) — curate updates, doesn't create
- The 3-section body convention (Understanding + Knowledge + Evidence) is parseable by simple string splitting on `## ` headers

## Affected Systems
- `src/kb/types.ts` — new `WikiEntry`, `KbWikiFrontmatter`, `KbEntryId` expansion, `EntryRecord` union
- `src/kb/frontmatter.ts` — new `parseWikiFrontmatter()`, `serializeWiki()`
- `src/kb/validation.ts` — new `assertWikiSlug()`
- `src/kb/paths.ts` — new `wikiDir()`, `wikiPathFromName()`
- `src/kb/read.ts` — cascade insertion (wiki between note and community), move-to-front trigger on read
- `src/kb/contracts.ts` — KbRuntime: `wikiDir()`, `wikiPath()` methods
- `src/kb/runtime.ts` — implement new KbRuntime methods, wake-up packet caching
- `src/kb/orama-schema.ts` — kind gains `'wiki'`
- `src/kb/orama-factory.ts` — `toOramaDocument()` wiki branch
- `src/kb/ops/search.ts` — `KbSearchScope` + `KIND_ORDER` (wiki=0, promoted wiki defers to note)
- `src/kb/ops/` — new `wiki-create.ts`, `wiki-update.ts`, `wiki-delete.ts`, `wiki-list.ts`, `wiki-promote.ts`
- `src/kb/mutation-helpers.ts` — `buildWikiIndexEntry()`, `wikiEntryId()`
- `src/kb/curate/scheduler.ts` — wiki maintenance phase (update existing wiki entries)
- `src/kb/curate/` — new `wiki-maintenance.ts` module
- `src/kb/curate/text-artifacts.ts` — wiki entries in Orama rebuild
- `src/execution/kb-tools.ts` — wiki CRUD handlers, `kb_wake_up`, extended search scope
- `src/cli/main.ts` — `kb wiki` subcommand, `kb wake-up`
- `src/shared/kb-read-contract.ts` — `KbSearchScope`, `KbReadKind`, `KB_BARE_READ_ORDER`

## Constraints
- Wiki is a FULLY INDEPENDENT entry kind — not a note variant or lifecycle flag
- All wiki entries must be valid Obsidian markdown (frontmatter + [[wikilinks]] + #tags)
- Wiki entries are NEVER automatically forgotten/deleted — only explicit user deletion
- Knowledge sector items point to ANY entry type via [[wikilinks]]
- Move-to-front is the ONLY ordering mechanism for Knowledge sectors — no scoring
- Curate maintains wiki entries but does NOT create them (LLM/user creates during conversation)
- Phase D freeze — design/preplan only, implementation blocked until freeze lifts
- `[[wiki/slug]]` links must resolve as vault-relative paths in Obsidian
- `wiki/.wake-up.md` must be gitignored (generated projection)
- CuratableEntry does NOT include WikiEntry (wiki maintenance is a separate curate phase, not classification input)

## Approach Direction
- Wiki = independent entry kind with `wiki:{slug}` and `~/.coral/kb/wiki/`
- **LLM creates during conversation** (like memo write, but for wiki)
- **Curate maintains** (updates Understanding from new sources, appends Evidence)
- **Knowledge sector = self-organizing [[wikilink]] list** (LRU move-to-front on kb read)
- **Copy on promote** (wiki continues living, note is stable snapshot, wiki shows redirect)
- **Forgetting = Phase 3** (deprecated labels for old + low-rank knowledge items, algorithm TBD)
- MemPalace-inspired: tiered memory (L0/L1 wake-up from recent wiki entries, L2/L3 = existing search)
- GBrain-inspired: Understanding (rewritable compiled truth) + Evidence (append-only)
- GraphRAG foundation: entity graph + communities provide wiki structural context

## Additional Context

### Wiki Entry Example
```markdown
---
tags:
  - inverse-kinematics
  - jacobian
  - robot-arm
sources:
  - "[[sources/ikflow-2024]]"
  - "[[sources/craig-robotics]]"
  - "[[notes/rendering-joint-limit-clamping]]"
references_principles:
  - "[[numerical-stability-first]]"
createdAt: 2026-04-12T00:00:00Z
updatedAt: 2026-04-12T00:00:00Z
entrySeq: 512
---
# Inverse Kinematics

## Understanding

CCD 기반 IK solver는 joint clamp를 iteration 전에 수행해야 한다.
7-DOF 이상 arm은 numerical(DLS) 또는 neural(IKFlow) 필수.
Real-time constraint < 1ms/solve에서는 DLS가 적합.

## Knowledge

- [[sources/ikflow-2024]] — Neural IK via normalizing flows, multi-solution sampling
- [[notes/ccd-clamp-ordering]] — CCD clamp-before-iterate prevents oscillation
- [[sources/craig-robotics]] — Craig Ch.4: DLS with damping λ, reference impl
- [[wiki/jacobian-methods]] — Jacobian pseudo-inverse vs DLS 비교
- [[sources/siciliano-2016]] — Siciliano 교과서 기구학 기초

## Evidence

- 2026-04-12 [[sources/ikflow-2024]] IKFlow normalizing flows → neural approach 추가
- 2026-04-01 [[sources/craig-robotics]] Craig Ch.4 → base framework 구축
- 2026-03-20 [[sources/siciliano-2016]] Siciliano 교과서 import
```

### Design Decisions Summary
| Decision | Choice | Rationale |
|----------|--------|-----------|
| Entry kind | Fully independent `wiki:` | Notes are stable; wiki is living. Fundamentally different. |
| Creation | LLM during conversation (full CRUD) | "이 주제로 위키 만들어줘" — natural interaction |
| Slug | Freeform (not entity-mapped) | LLM decides appropriate slug during creation |
| Body sections | Understanding + Knowledge + Evidence | Rewritable narrative + self-organizing references + append-only log |
| Knowledge items | [[wikilinks]] to any entry type | Sources, notes, wikis, communities — all valid targets |
| Ordering | LRU move-to-front on kb read | No scoring. Usage patterns determine importance. |
| Forgetting | Phase 3 — deprecated labels for old + low-rank items | Algorithm TBD. Wiki entry itself never forgotten. |
| Cascade | memo → note → wiki → community → source → principle | Note wins for exact slug; wiki wins in search ranking |
| Search priority | KIND_ORDER wiki=0, promoted wiki defers | Compiled summary more useful than individual insight |
| Principles | references_principles (reference only, no production) | Prevents curate feedback loop |
| Promotion | Copy + redirect in wiki + evidence continues | Wiki is living; note is stable snapshot |
| Curate role | Maintenance (update existing) not creation | LLM creates; curate evolves |
| Wake-up | From recently active wikis, ~900 tokens, cached | L0/L1 = file read, L2/L3 = existing search |

### MemPalace Features Adopted
- Tiered memory (wake-up packet for session start context)
- Self-organizing knowledge (LRU instead of MemPalace's importance scoring)
- Token budget management for context efficiency

### MemPalace Features NOT Adopted
- Palace metaphor (entity graph + communities provide organization)
- AAAK compression (token efficiency via compiled-truth convention)
- Verbatim-only storage (Understanding is synthesized)
- Entry-level confidence scoring (ordering-based, not score-based)
- Separate retrieval per layer (existing 3-lane RRF)

### Phased Delivery

**Phase 0: KB Foundation Hardening** (wiki가 올라갈 기반 — ~100줄 수정)
- 0a. `stagedPath` traversal guard (5줄, CRITICAL)
- 0b. `top_k` max(100) + content `.max(200000)` (6줄, CRITICAL)
- 0c. Search timeout — AbortSignal on embedding call (10줄, HIGH)
- 0d. Query length limit + control char stripping (10줄, HIGH)
- 0e. Vector snapshot GC after activation (15줄, HIGH)
- 0f. Permission hardening — dirs 0o700, files 0o600 for KB root (20줄)
- 0g. Search result dedup — cross-entry content similarity filtering (30줄)

**Phase 1: Wiki System** (깨끗한 기반 위에 구축 — this preplan)
- Wiki entry kind (`wiki:{slug}`), CRUD, 3-section body
- Search integration (scope, KIND_ORDER, cascade)
- Curate maintenance phase (update Understanding from new sources)
- Wake-up packet generation and caching
- Promotion (copy to note + redirect)

**Phase 2: Wiki Auto-Generation**
- Auto git-repo wiki generation
- Session-based wiki auto-update

**Phase 3: Forgetting System**
- Knowledge sector move-to-front automation on `kb read`
- Deprecated labels for old + low-rank knowledge items (algorithm TBD)
- Entity graph temporal validity (valid_from/valid_to on relationships)

### Rationale: Why Phase 0 Before Wiki
KB cross-cutting 분석(2026-04-12)에서 4개 프로젝트 비교 시 발견된 gap들:
- Query sanitization, search timeout, input bounds → wiki search에도 그대로 적용됨
- Permission hardening → wiki에 연구 논문/민감 기술 지식 저장 시 보호 필요
- Dedup → wiki + note + source 혼합 검색에서 중복 결과 방지
기반을 먼저 다져야 wiki가 같은 gap을 반복하지 않음.

### WAL 미채택 근거
MemPalace의 WAL은 실질적으로 디버깅 로그 (코드 어디에서도 read 안 됨, recovery/replay 없음).
Coral KB는 모든 생성물이 markdown (vault 안) — 파일 자체가 기록.
- Git 사용자: `git log`가 완전한 history
- Non-git 사용자: Obsidian Sync 등 file-level history 존재하나 LLM 접근 불가 → 알려진 tradeoff로 수용
- Evidence 섹션이 append-only → "왜 바뀌었는지" 근거는 wiki 내부에 보존
- 자체 VCS 구현(WAL)은 과도한 복잡성.
