# KB Wiki System — Living Knowledge Layer

**Preplan**: `plans/pre-kb-wiki-system.md`

## Requirements Summary

Add a wiki entry kind (`wiki:{slug}`) to the Coral KB as a fully independent, living knowledge layer. Wiki entries reside in `~/.coral/kb/wiki/`, are LLM-consumed, Obsidian-native markdown with 3-section body (`## Understanding` + `## Knowledge` + `## Evidence`). Self-organizing Knowledge sectors use LRU move-to-front on successful KB reads of referenced entries. Curate pipeline is extended for wiki maintenance. Wake-up packet provides ~900 token context on session start. This revision keeps wiki entries standalone for the full round: do not add wiki-to-note promotion.

## Acceptance Criteria (testable, verifiable — register each as a Task during implementation)

- **AC1**: `KbEntryId` type includes `wiki:${string}`. `parseKbEntryId('wiki:foo')` returns the normalized `KbEntryId` string `'wiki:foo'`. `entryIdToVaultLink('wiki:foo')` returns `'[[wiki/foo]]'`.
- **AC2**: `WikiEntry` type exists with `KbWikiFrontmatter` (tags, sources, references_principles, createdAt, updatedAt, entrySeq, related). `EntryRecord` union includes `WikiEntry`.
- **AC3**: `~/.coral/kb/wiki/` directory, `wikiDir()`, `wikiPathFromName()` path functions. `KbRuntime` exposes `wikiDir()` and `wikiPath()`.
- **AC4**: Wiki frontmatter parse/serialize: `parseWikiFrontmatter()`, `serializeWiki()` in `frontmatter.ts`. Round-trip: parse(serialize(fm)) === fm.
- **AC5**: Wiki CRUD ops — `kb_wiki_create`, `kb_wiki_update`, `kb_wiki_delete`, `kb_wiki_list`, `kb_wiki_read`. Zod schemas, typed HTTP routes, `BackendClient` methods, CLI wiring, and route/client/CLI tests exist for each.
- **AC6**: Wiki body convention enforced: `## Understanding` (rewritable) + `## Knowledge` (ordered `[[wikilinks]]`) + `## Evidence` (append-only). Parser splits body on `## ` headers.
- **AC7**: `KbSearchScope` includes `'wiki'`. `kb search --scope wiki` returns only wiki entries. `KIND_ORDER` assigns `wiki: 0` as the equal-score tie-break priority, not a score override. Wiki results remain eligible in default search even when hybrid mode is enabled, but in v1 they enter hybrid results through the Orama/text lane only; vector and graph lanes remain note/source-only.
- **AC8**: `toOramaDocument()` and text-artifact rebuilds handle wiki records. Text-artifact freshness detection uses per-file fingerprints/mtimes for text-bearing KB files (including in-place wiki edits) instead of directory mtimes. Wiki entries appear in `kb reindex` output with `wiki: N` count. V1 keeps vector snapshot/chunking/manifest limited to notes and sources, and vector freshness is keyed to a dedicated notes/sources corpus seq so wiki-only rewrites do not invalidate hybrid availability.
- **AC9**: `kb read` cascade: memo → note → **wiki** → community → source → principle. `KB_BARE_READ_ORDER` updates accordingly. `parseKbSelector`, `BackendClient.kbReadByKind()`, and HTTP GET routes all handle `wiki:slug`.
- **AC10**: Move-to-front: when a successful KB read resolves a target that a wiki's Knowledge sector `[[wikilinks]]` to, that link moves to position 0 of the Knowledge list. The rewrite runs through a shared server-side post-read hook, is awaited under `withMutationLock()`, and consults a backlink cache that is refreshed after committed wiki rewrites and revalidated against current wiki text freshness before use so in-process and out-of-band wiki edits cannot serve stale ordering.
- **AC11**: Curate wiki maintenance runs after community detection in both scheduler paths: the main `runScheduledCurate()` flow and the `lastCompletedThrough === null` fallback. For each wiki entry whose `sources` list includes entries with `entrySeq` greater than that wiki's recorded maintenance cursor, LLM regenerates Understanding and appends Evidence, then advances only that wiki's maintenance cursor. Rebuild/scheduler paths prune `wikiMaintenanceBySlug` against the live wiki set so external delete/rename cannot leave stale maintenance cursors behind.
- **AC12**: Wake-up packet: `generateWakeUpPacket(kb, tokenBudget)` produces a markdown string from wiki entries sorted by `updatedAt DESC`, truncated to a ~900 token budget. Cache artifacts live under the build-flavor-aware KB runtime dir via shared path helpers, with a persisted wiki-text freshness state alongside the markdown payload. `hooks/session-start.mjs` reads the cached wake-up payload directly and appends it to `additionalContext` during SessionStart only when that freshness state still matches live wiki text freshness, omitting stale or missing cache without depending on backend warm-start. Typed HTTP route, client method, and CLI command: `kb wake-up` remain available for manual inspection/debugging.
- **AC13**: All wiki files are valid Obsidian markdown: frontmatter with `tags:` (Obsidian tag rendering), `[[wiki/slug]]` links resolve in vault, and the `wiki/` directory is visible in Obsidian graph.
- **AC14**: `kb promote` gains optional `--wiki <slug>` argument. When provided, the promoted note's `[[notes/d-t]]` link is prepended to the specified wiki's Knowledge section. Missing or invalid wiki targets fail before any note or memo mutation. No separate wiki promote command. No `promotedTo` field or note-side mirror field. Wiki remains fully independent — it just gains one Knowledge link.

## Execution Order

### Dependency Graph
```
AC1 ─→ AC2 ─→ AC4 ─→ AC5 ─→ AC6
 │       │              │       │
 │       └──→ AC7 ──→ AC8      │
 │       │              │       │
 │       └──→ AC9 ──────┘      │
 │                              │
 └──→ AC3 ─────────────────────┘
                                │
AC10 ◄──────────────────────────┘ (depends on CRUD + body parser)
AC11 ◄──────────────────────────┘ (depends on CRUD + search)
AC12 ◄─── AC10, AC11              (depends on wiki mutations existing)
AC13 (cross-cutting, verified at each phase)
AC14 ◄─── AC5, AC6               (extends existing promote with --wiki)
```

### Batches
| Batch | ACs | Dependencies | Parallel |
|-------|-----|--------------|----------|
| 1 (Phase A) | AC1, AC2, AC3, AC4 | — | 4 (type foundation) |
| 2 (Phase B) | AC7, AC8, AC9 | AC1, AC2, AC3 | 3 (search + read + freshness) |
| 3 (Phase C) | AC5, AC6, AC14 | AC1-AC4, AC7-AC9 | 3 (CRUD + body + promote) |
| 4 (Phase D) | AC10 | AC5, AC6 | 1 (move-to-front) |
| 5 (Phase E) | AC11 | AC5, AC7, AC8 | 1 (curate maintenance) |
| 6 (Phase F) | AC12 | AC10, AC11 | 1 (wake-up packet) |
| ∀ | AC13 | — | verified at each batch |

### File Mapping
| AC | Primary Files |
|----|---------------|
| AC1 | `src/kb/types.ts`, `src/kb/validation.ts` |
| AC2 | `src/kb/types.ts`, `src/kb/mutation-helpers.ts` |
| AC3 | `src/kb/paths.ts`, `src/kb/contracts.ts`, `src/kb/runtime.ts` |
| AC4 | `src/kb/frontmatter.ts`, `src/kb/__tests__/reindex.test.ts` |
| AC5 | `src/kb/ops/wiki-create.ts`, `wiki-update.ts`, `wiki-delete.ts`, `wiki-list.ts`, `src/execution/kb-tools.ts`, `http-handler.ts`, `src/client/http-client.ts`, `src/cli/main.ts` |
| AC6 | `src/kb/frontmatter.ts` (parseWikiBody), `src/kb/ops/wiki-rewrite.ts` |
| AC7 | `src/kb/ops/search.ts`, `src/shared/kb-read-contract.ts`, `src/execution/query-coerce.ts` |
| AC8 | `src/kb/orama-factory.ts`, `src/kb/curate/text-artifacts.ts`, `src/kb/runtime.ts`, `src/kb/vector/sync.ts` |
| AC9 | `src/shared/kb-read-contract.ts`, `src/kb/read.ts`, `src/execution/kb-tools.ts`, `src/execution/http-handler.ts`, `src/client/http-client.ts` |
| AC10 | `src/kb/ops/wiki-move-to-front.ts`, `src/execution/http-handler.ts` |
| AC11 | `src/kb/curate/wiki-maintenance.ts`, `src/kb/curate/scheduler.ts`, `src/kb/curate/state.ts` |
| AC12 | `src/kb/ops/wake-up.ts`, `src/kb/runtime.ts`, `hooks/session-start.mjs`, `src/execution/kb-tools.ts`, `src/execution/http-handler.ts`, `src/client/http-client.ts`, `src/cli/main.ts` |
| AC13 | (cross-cutting — Obsidian compatibility verified at each phase) |
| AC14 | `src/kb/ops/promote.ts`, `src/execution/kb-tools.ts`, `src/cli/main.ts` |

### Conflict Notes
- AC5 and AC9 both touch `kb-tools.ts` and `http-handler.ts` — placed in sequential batches (B→C)
- AC7 and AC9 both touch `kb-read-contract.ts` — same batch, but AC7 adds scope enum while AC9 adds cascade order (independent sections)
- AC8 and AC11 both touch `runtime.ts` and `curate/` — placed in sequential batches (B→E)

## Implementation Phases (with file:line references)

### Phase A: Type Foundation (AC1, AC2, AC3, AC4)

**A1. Types** (`src/kb/types.ts`)
- Add `wiki:${string}` to `KbEntryId` union (line 63)
- Add `KbWikiFrontmatter` interface after `CommunityFrontmatter` (after line 110):
  ```typescript
  export interface KbWikiFrontmatter {
    tags: string[];
    sources: KbEntryId[];
    references_principles: string[];
    createdAt: string;
    updatedAt: string;
    entrySeq?: number;
    related?: KbEntryId[];
  }
  ```
- Add `WikiEntry` type:
  ```typescript
  export type WikiEntry = KbWikiFrontmatter & {
    kind: 'wiki';
    slug: string;
    title: string;
  };
  ```
- Extend `EntryRecord` (line 123): `NoteEntry | SourceEntry | CommunityEntry | WikiEntry`
- Add `isWikiEntry()` type guard, `wikiEntryId()` helper
- Extend `KbResult.kind` (line 53): add `'wiki'`
- Extend `KbReadResult.kind` (line 224): add `'wiki'` to the union (`'memo' | 'note' | 'source' | 'community' | 'principle' | 'wiki'`). This type is consumed by `BackendClient.kbRead()`, `kbReadByKind()` switch in `http-client.ts`, `cli/format.ts`, and `readEntry()` in `read.ts`.
- Extend `ReindexResult` (line 139): add `wiki: number`

**A2. Paths** (`src/kb/paths.ts`)
- Add `wikiDir(root)` function (after `sourcesDir`, line 39)
- Add `wikiPathFromName(slug, root)` function

**A3. Contracts** (`src/kb/contracts.ts`)
- Add `wikiDir(): string` and `wikiPath(slug: string): string` to `KbRuntime` interface (after `principlePath`, line 97)

**A4. Runtime** (`src/kb/runtime.ts`)
- Implement `wikiDir()` and `wikiPath()` methods on `KbRuntimeImpl`
- Add `parseWikiIndexEntry()` and extend `parseIndex()` so wiki-bearing `index.json` content survives `persistIndexToDisk()` / `readIndex()` round-trips instead of being treated as corrupt

**A5. Validation** (`src/kb/validation.ts`)
- Add `assertWikiSlug()` function (same pattern as `assertNoteSlug`)

**A6. Frontmatter** (`src/kb/frontmatter.ts`)
- Add `parseWikiFrontmatter(content: string)` — extracts tags, sources, references_principles, timestamps, related
- Add `serializeWiki(frontmatter: KbWikiFrontmatter, title: string, body: string): string`
- Add wiki body parser: `parseWikiBody(body: string): { understanding: string, knowledge: string, evidence: string }`

**A7. Entry ID infrastructure** (`src/kb/types.ts` helper functions area)
- Extend `parseKbEntryId()` to handle `wiki:` prefix while preserving the normalized-string return contract
- Extend `entryIdToVaultLink()` for `wiki/` directory
- Extend `vaultLinkToEntryId()` for `wiki/` pattern

**A8. Mutation helpers** (`src/kb/mutation-helpers.ts`)
- Add `buildWikiIndexEntry(input): WikiEntry` (after `buildCommunityIndexEntry`, ~line 65)
- Extend `cloneEntryRecord()` (line 124) with `isWikiEntry` branch

**A9. Runtime/index regression** (`src/kb/__tests__/reindex.test.ts`)
- Add a regression that persists an index containing a wiki entry and reloads it through `readIndex()`, plus a reindex round-trip proving a wiki-bearing `index.json` is not deleted as invalid

### Phase B: Search, Read Path, and Freshness (AC7, AC8, AC9)

**B1. Orama schema** (`src/kb/orama-schema.ts`)
- No schema change needed (kind is `string` type, accommodates `'wiki'` already)

**B2. Orama factory** (`src/kb/orama-factory.ts`)
- Add wiki branch to `toOramaDocument()` (after source branch, before community fallback, ~line 82). Use single-field discriminant matching the existing pattern (`'note' in record`, `'type' in record`):
  ```typescript
  if ('references_principles' in record) {
    return { entryId: wikiEntryId(record.slug), slug: ..., kind: 'wiki', ... };
  }
  ```
  Ordering constraint: wiki check must precede the community fallback (which has no discriminant field). The resulting order is: note → source → wiki → community.
- Add `KbReindexWikiRecord` type
- Extend `KbOramaDocument.kind` to include `'wiki'`

**B3. Search** (`src/kb/ops/search.ts`)
- Add `wiki: 0` to `KIND_ORDER` (line 42), shift note→1, community→2, source→3, and document that kind order only breaks score ties
- Extend scope filter and `KbResult.kind` handling to include `'wiki'`
- Make the default-search contract explicit: wiki documents participate through the Orama/text lane and remain eligible in hybrid results, while vector snapshot/chunking/manifest and graph-lane expansion stay note/source-only in v1
- Split graph/vector eligibility helpers so adding `kind='wiki'` does not accidentally admit wiki-only graph hits in `--scope all`
- Extend `resolveEntry()` / `resolveHit()` so wiki entries project `references_principles` into result `principles` metadata instead of dropping them after index lookup

**B4. Read contract** (`src/shared/kb-read-contract.ts`)
- Add `'wiki'` to `KbReadKind` (line 1)
- Insert `'wiki'` into `KB_BARE_READ_ORDER` between `'note'` and `'community'` (line 16)
- Add `wiki:` prefix handling in `parseKbSelector()` (after `communities:` case, line 61)

**B5. Search/read transport** (`src/execution/query-coerce.ts`, `src/execution/http-handler.ts`, `src/client/http-client.ts`)
- Add `'wiki'` to `kbSearchQuerySchema` scope enum
- Add wiki GET route coverage to the HTTP handler (`GET /kb/wikis/:slug`) and keep `/kb/entries` scope parsing aligned with the client and CLI
- Add `BackendClient` wiki read support (`kbReadByKind('wiki')`, `kbReadWiki()`) so CLI reads reach the server end to end

**B6. Read cascade + handlers** (`src/kb/read.ts`, `src/execution/kb-tools.ts`)
- Add wiki lookup function `readWikiEntry(slug)` following `readSourceEntry` pattern
- Insert wiki step in `readEntry()` cascade between note and community
- Extend `parseReadSelector()` (read.ts:76-103) to handle `wiki:` prefix alongside `sources:` and `communities:`, dispatching to `assertWikiSlug()`. Without this, `readEntry({ note: 'wiki:foo' })` falls through to `assertNoteSlug('wiki:foo')` which fails on the `:` character.
- **Sync note**: keep `readEntry()` cascade order in `read.ts` synchronized with `KB_BARE_READ_ORDER` in `kb-read-contract.ts` (B4). These are independent cascades that must agree.
- Extend `kbSearchSchema` scope enum to include `'wiki'` (line 44)
- Add `handleKbWikiRead` and `case 'wiki':` in read dispatch (`dispatchKbReadCandidate`, line 225)
- Extend `normalizeKbSlug()` (kb-tools.ts:180-196) with a `'wiki'` case that calls `assertWikiSlug()`. Without this, wiki reads fall through to `assertNoteSlug`, bypassing the dedicated wiki slug validation from A5.

**B7. Text artifacts + freshness** (`src/kb/curate/text-artifacts.ts`, `src/kb/contracts.ts`, `src/kb/runtime.ts`, `src/kb/vector/sync.ts`, `src/kb/ops/search.ts`)
- Include wiki entries in `rebuildTextArtifactsAndPersistRepairState()` — read from `wikiDir()`, parse frontmatter, add to Orama, and thread wiki counts into `kb reindex`
- Replace directory-mtime invalidation in `detectTextArtifactRebuildInfo()` with per-file freshness descriptors (path + mtime/content fingerprint) for notes, sources, communities, principles, and wiki files so in-place wiki edits, external deletes, and renames invalidate text artifacts correctly
- Expose the wiki portion of those per-file freshness descriptors as a reusable wiki-text freshness-state helper so read-time/startup caches can detect out-of-band wiki edits without requiring a prior search or reindex call
- Introduce a dedicated notes/sources vector freshness seq in `KbIndexState` / runtime mutation helpers / vector sync / search gating; note/source mutations advance both text `contentSeq` and the vector-corpus seq, while wiki-only rewrites advance text freshness without invalidating vector freshness
- Prune `wikiMaintenanceBySlug` against the live wiki slug set during rebuild/shared scheduler tail so out-of-band wiki delete/rename cannot leave stale maintenance cursors behind
- Leave vector snapshot capture (`KbVectorTextSnapshot`, chunking, manifest sync) limited to notes and sources in v1

**B8. Regression tests** (`src/execution/__tests__/query-coerce.test.ts`, `src/execution/__tests__/server.test.ts`, `src/client/__tests__/http-client.test.ts`, `src/cli/__tests__/main-routing.test.ts`, `src/cli/__tests__/format.test.ts`, `src/execution/__tests__/kb-tools.test.ts`, `src/kb/__tests__/search.test.ts`)
- Add coverage for `--scope wiki`, explicit `wiki:slug` reads, bare-cascade wiki fallback, in-place wiki file edits forcing artifact freshness updates, external wiki rename/delete pruning stale maintenance cursors, and hybrid-search regression proving wiki remains text-lane-only in v1 even after wiki-only rewrites
- Update `formatKbReindex()` (cli/format.ts:416) to render `wiki: N` count from the extended `ReindexResult` type, and update CLI formatter/snapshot coverage so `kb reindex` renders `wiki: N` counts end to end

### Phase C: CRUD Operations and Shared Wiki Rewrite Contract (AC5, AC6, AC14)

**C1. Wiki create** (new `src/kb/ops/wiki-create.ts`)
- Input: `{ slug, title, understanding, knowledge?, evidence?, tags?, sources?, references_principles? }`
- Validate slug, build frontmatter, compose 3-section body
- Under `withMutationLock()`, call a dedicated wiki-text mutation helper before write so the returned text `contentSeq` becomes the initial wiki `entrySeq` without advancing the notes/sources vector-corpus seq, then `writeFileAtomic()` to the wiki path and `commitIndexUpdate()` to add the entry
- Return: `{ path, slug }`

**C2. Shared wiki rewrite helper** (new `src/kb/ops/wiki-rewrite.ts`)
- Add `rewriteWikiLocked()` to own the wiki mutation contract in one place: load wiki content under the existing mutation lock, parse frontmatter + body sections, normalize/dedupe Knowledge links, record a wiki-text mutation that refreshes text/wake-up freshness without advancing the notes/sources vector-corpus seq, optionally touch `updatedAt`, refresh the index entry, and write atomically
- The helper accepts explicit rewrite modes so wiki update, move-to-front, curate maintenance, and `kb promote --wiki` can share parsing/mutation logic without guessing about timestamps or duplicate links
- `kb promote --wiki` must validate and load the target wiki before any note or memo mutation, then reuse this helper for the wiki-side Knowledge rewrite only; do not mirror the relation into note `related` or add any promotion field

**C3. Wiki update** (new `src/kb/ops/wiki-update.ts`)
- Input: `{ slug, understanding?, knowledge?, evidence_append? }`
- Load existing wiki, parse body sections
- Replace Understanding if provided, append to Evidence if provided, reorder Knowledge if provided
- Call `rewriteWikiLocked()` with the requested body mutations, `touchUpdatedAt: true`, and index refresh handled in the helper
- Return: `{ path }`

**C4. Wiki delete** (new `src/kb/ops/wiki-delete.ts`)
- Input: `{ slug }`
- `rmSync()` wiki file, record a wiki-text mutation (not a notes/sources vector-corpus mutation), `commitIndexUpdate()` to remove entry, and clear any per-wiki maintenance cursor for that slug
- Return: `{ deleted }`

**C5. Wiki list** (new `src/kb/ops/wiki-list.ts`)
- Read all .md files from `wikiDir()`, parse frontmatter
- Return: `{ wikis: WikiListItem[] }` sorted by updatedAt DESC

**C6. HTTP routes + client surface** (`src/execution/kb-tools.ts`, `src/execution/http-handler.ts`, `src/client/http-client.ts`)
- Add Zod schemas and handlers: `kbWikiCreateSchema`, `kbWikiUpdateSchema`, `kbWikiDeleteSchema`, `kbWikiListSchema`, `handleKbWikiCreate`, `handleKbWikiUpdate`, `handleKbWikiDelete`, `handleKbWikiList`
- Add typed HTTP routes: `POST /kb/wikis`, `GET /kb/wikis`, `GET /kb/wikis/:slug`, `PUT /kb/wikis/:slug`, `DELETE /kb/wikis/:slug`
- Add `BackendClient` methods: `kbWikiCreate`, `kbWikiUpdate`, `kbWikiDelete`, `kbWikiList`, `kbWikiRead`

**C7. CLI + tests** (`src/cli/main.ts`, `src/cli/__tests__/main-routing.test.ts`, `src/client/__tests__/http-client.test.ts`, `src/execution/__tests__/server.test.ts`)
- Add `kb wiki create`, `kb wiki update`, `kb wiki delete`, `kb wiki list` subcommands
- Keep `kb read wiki:<slug>` as the canonical CLI read path and update CLI help text/examples accordingly
- Add route/client/CLI regression tests for the full wiki CRUD surface

**C8. Promote-to-wiki wiring** (`src/kb/types.ts`, `src/execution/kb-tools.ts`, `src/client/http-client.ts`, `src/cli/main.ts`, `src/kb/ops/promote.ts`, promote route/client/CLI/op tests`)
- Extend `KbPromoteInput`, `kbPromoteSchema`, `BackendClient.kbPromote()`, and CLI `kb promote --wiki <slug>` so AC14 is wired through the existing promote transport instead of living only in acceptance text
- Keep `promote()` under the existing `withMutationLock()` path; when `--wiki` is provided, load and validate the wiki target before writing either file so missing/invalid wiki targets leave the memo untouched and no note created
- Reuse `rewriteWikiLocked()` for the Knowledge-section prepend. The wiki rewrite must occur **before** `rmSync(memoPath)` (promote.ts:76) so that a wiki rewrite failure preserves the memo. Add route/client/CLI/op regression coverage for success, duplicate-link dedupe, and invalid target failure

### Phase D: Move-to-Front (AC10)

**D1. Backlink index** (new utility in `src/kb/ops/wiki-move-to-front.ts`)
- Build a backlink lookup from wiki Knowledge `[[wikilinks]]` to target entry IDs, persist it with the current wiki-text freshness state, and refresh it whenever wiki text artifacts are rebuilt
- Add a shared `refreshWikiBacklinkCache()` helper invoked after committed wiki create/update/delete/move-to-front/maintenance/promote rewrites so in-process mutations keep the cache warm instead of waiting for a later rebuild/search
- For each matching wiki, parse Knowledge section, move the matching link to position 0
- Rewrite through `rewriteWikiLocked()` so Knowledge ordering, duplicate-link normalization, `updatedAt`, text freshness, and index refresh stay consistent with manual updates and `kb promote --wiki` without invalidating notes/sources vector freshness
- Move-to-front does NOT advance the wiki's own `entrySeq` (it is a metadata-only reorder, not a content mutation). This prevents wiki from becoming a curate maintenance candidate solely due to read-triggered reordering. `updatedAt` is refreshed for wake-up recency, but `entrySeq` stays unchanged.

**D2. Server-side post-read hook** (`src/execution/http-handler.ts`, `src/kb/ops/wiki-move-to-front.ts`)
- Introduce a shared `runKbPostReadEffects()` helper invoked by successful note/source/wiki/community/principle GET routes
- Before consulting the backlink cache, compare its persisted wiki-text freshness state with the current wiki freshness helper under lock; if stale or missing, rebuild/refresh the backlink cache synchronously before deciding which wiki rewrites to run
- Perform move-to-front rewrites inside `kb.withMutationLock()` using a bounded lock acquisition (tryLock or short timeout). If the lock is contended (e.g., curate holding it), skip the move-to-front for this read — the ordering will converge on the next read. This preserves the current lockless read latency contract. Do not detach work after the lock is released.
- Treat move-to-front as best-effort side effects: log failures without turning a successful read response into a transport failure
- **Durability policy**: schedule a deferred git commit after move-to-front rewrites (same `scheduleDeferredCommit()` pattern used by write handlers in `kb-tools.ts:430`). Without this, read-triggered wiki rewrites leave the KB dirty indefinitely.

### Phase E: Curate Wiki Maintenance (AC11)

**E1. Wiki maintenance module** (new `src/kb/curate/wiki-maintenance.ts`)
- `runWikiMaintenanceSubphase(kb, spawnCli, { signal, shouldStop })`: Promise<boolean>
- For each wiki entry: compute the highest referenced source `entrySeq` and compare it against that wiki's recorded maintenance cursor, not the wiki's general `entrySeq`
- If yes: read all referenced source bodies, compose LLM prompt to regenerate Understanding
- LLM call via `runCurateClaude(kb, spawnCli, prompt)` (existing pattern)
- Parse response, update Understanding section, append Evidence entry
- Apply the rewrite through `rewriteWikiLocked()` with `touchUpdatedAt: true`, then advance that wiki's maintenance cursor to the absorbed source high-water mark only after the write succeeds

**E2. Shared scheduler tail** (`src/kb/curate/scheduler.ts`)
- Factor community detection + wiki maintenance into a shared helper that runs after either scheduler path reaches the community phase
- Invoke the shared helper from both `runScheduledCurate()` and the `lastCompletedThrough === null` fallback path
- Prune `wikiMaintenanceBySlug` against the live wiki slug set inside the shared tail before/after maintenance so stale cursors from external delete/rename are removed even when the file disappeared outside explicit wiki delete flows
- The shared tail must return a `changed: boolean` signal. In the fallback path, push only when `changed` is true (aligns with main-path push semantics where push is unconditional post-community)
- Auto-commit wiki maintenance writes from the shared tail:
  ```typescript
  if (!stopped && !signal.aborted) {
    try {
      if (await runWikiMaintenanceSubphase(kb, spawnCli, { signal, shouldStop: () => stopped })) {
        gitSync.gitAutoCommit('curate: maintain wiki entries');
      }
    } catch (error: unknown) {
      throw new CurateRunError(lastCompletedThrough, error);
    }
  }
  ```

**E3. Curate state** (`src/kb/curate/state.ts`)
- Add `wikiMaintenanceBySlug: Record<string, number>` to curate state (no field to replace — this is a new addition). Update `parseCurateState()` default/parse/write paths.
- Only advance a slug's cursor after successful maintenance for that wiki; clear the cursor on wiki delete and prune missing slugs during rebuild/scheduler tail so state cannot claim freshness for a removed or renamed file

### Phase F: Wake-Up Packet (AC12)

**F1. Wake-up generator** (new `src/kb/ops/wake-up.ts`)
- `generateWakeUpPacket(kb: KbRuntime, tokenBudget: number = 900): string`
- **Precondition**: call `await kb.ensureIndex()` (not bare `readIndex()`) to guarantee fresh text artifacts before generation — prevents stale wake-up after out-of-band wiki edits
- Read index, filter wiki entries, sort by `updatedAt` DESC
- For each entry: extract first paragraph of Understanding section
- Concatenate as `## slug (updatedAt)\nfirst-paragraph\n`
- Truncate at token budget (chars / 4 approximation)
- Prepend with identity note content if `identity.md` exists

**F2. Caching** (`src/kb/runtime.ts`, `src/kb/ops/wake-up.ts`, wiki mutation call sites)
- Add shared build-flavor-aware runtime-dir helpers for wake-up cache paths instead of hard-coding `~/.coral/data/kb/...`, and use the same path contract from backend and hook code
- Cache wake-up at `wake-up.md` under `kb.runtimeDir`
- Track `wake-up-state.json` using the shared wiki-text freshness-state helper at generation time rather than a literal seq-only contract
- Add a shared cache-refresh helper invoked after committed wiki create/update/delete/move-to-front/maintenance/promote rewrites and after external wiki-driven text-artifact rebuilds so SessionStart can read a warm cache without waiting for backend startup

**F3. SessionStart consumption** (`hooks/session-start.mjs`, `src/hooks/__tests__/hooks.test.ts`)
- Extend `hooks/lib/hook-utils.mjs` with the same build-flavor-aware KB runtime-dir resolution used by backend code so `session-start.mjs` reads the correct `kb` vs `kb-dev` wake-up cache location
- Read the cached wake-up file directly inside `session-start.mjs` after `INJECT.md` substitution, compare `wake-up-state.json` with current live wiki-text freshness, and append the payload only when fresh; do not depend on `/kb/wake-up` or backend warm-start ordering for startup delivery
- If the cache is missing or stale, omit the wake-up section rather than blocking SessionStart on backend startup
- Add hook-level tests proving `additionalContext` contains the cached wake-up payload when present and fresh, skips stale cache, and preserves existing `INJECT.md` behavior when absent

**F4. Route + client + CLI** (`src/execution/kb-tools.ts`, `src/execution/http-handler.ts`, `src/client/http-client.ts`, `src/cli/main.ts`)
- Add `handleKbWakeUp()`: return the cached wake-up payload and regenerate it when `wake-up-state.json` no longer matches current wiki text freshness
- Add typed route/client support (`GET /kb/wake-up`, `BackendClient.kbWakeUp()`)
- Add `kb wake-up` CLI command plus route/client/CLI coverage in `server.test.ts`, `http-client.test.ts`, and `main-routing.test.ts`

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Move-to-front scanning wiki files on every `kb read` is slow | High — read latency | Build a cached backlink map stamped with wiki-text freshness, refresh it after committed wiki rewrites, and have the post-read hook rebuild it only when the stamp is stale/missing |
| Adding wiki to the real transport path touches query coercion, HTTP routes, client methods, CLI wiring, and tests | High — integration regression | Treat search/read/CRUD/wake-up as one end-to-end contract and update `query-coerce`, `http-handler`, `http-client`, CLI, and tests together |
| Split text freshness and vector-corpus freshness can drift if mutation paths bypass the shared helper | High — hybrid/search correctness | Funnel wiki rewrites through one wiki-text mutation helper, advance note/source vector freshness separately, and add regression coverage that wiki-only rewrites preserve hybrid availability |
| SessionStart could inject stale or wrong-flavor wake-up context | High — startup correctness | Resolve wake-up cache paths through shared runtime-dir helpers and skip injection whenever the cached wake-up freshness state no longer matches live wiki text freshness |
| Curate wiki maintenance LLM calls are expensive | Medium — API cost | Rate-limit: max 5 wiki updates per curate run; respect usage budget |
| Wiki Knowledge section rewrite on move-to-front races with curate | Medium — data loss | Keep move-to-front awaited under the shared mutation lock and never fire-and-forget after lock release |
| Wiki has no vector-only recall in default search v1 | Medium — retrieval gap | Make the text-lane contract explicit, verify wiki survives hybrid-enabled searches, and only extend vector parity in a later dedicated phase if needed |
| SessionStart may read a stale or missing wake-up cache | Medium — startup context drift | Refresh the cache on wiki mutations/rebuilds, key it to text `contentSeq`, and keep hook behavior fail-open when the cache is absent |
| Obsidian may try to index `.wake-up.md` | Low — noise | Place in `data/kb/` not vault, or use dot-prefix `.wake-up.md` |
| Large number of wiki entries degrades wake-up generation | Low | Token budget truncation; only scan first N entries |

## Verification Steps

1. **Type safety**: `npm run build` passes with zero errors after Phase A
2. **Search integration**: Create a wiki entry, run `kb search --scope wiki`, verify it appears and only wiki entries are returned. Run `kb search --scope all` with hybrid enabled, verify the wiki result remains eligible through the Orama/text lane only, does not appear as a graph-only/vector-only hit, and use an equal-score fixture to verify `KIND_ORDER` only breaks ties.
3. **Cascade + explicit read**: `kb read inverse-kinematics` resolves the wiki entry when no note with that slug exists. `kb read wiki:inverse-kinematics` uses the explicit wiki route/client branch. When both note and wiki exist for a bare slug, note still wins.
4. **CRUD round-trip**: `kb wiki create` → `kb read wiki:foo` → `kb wiki update` → `kb wiki list` (shows entry) → `kb wiki delete` → `kb wiki list` (gone)
5. **Promote-to-wiki**: Create a wiki and a memo, run `kb promote --wiki inverse-kinematics`, and verify the new note is created while its `[[notes/d-t]]` link is prepended exactly once in the wiki Knowledge section. Repeat with a missing/invalid wiki target and verify the memo remains in place and no note is created.
6. **External edit freshness**: Edit `~/.coral/kb/wiki/foo.md` in place, then rename/delete it out-of-band, run search/rebuild entrypoints, and verify text artifacts are invalidated/refreshed via per-file freshness tracking without manual cleanup. Confirm stale `wikiMaintenanceBySlug` state is pruned for the deleted/renamed slug.
7. **Move-to-front**: Create wiki with Knowledge items A, B, C. Read `B-target` through the normal KB read path. Read the wiki again; B is now first in Knowledge section, no duplicate Knowledge link was introduced, list/wake-up recency follows the shared rewrite policy, and hybrid search remains available because the wiki-only rewrite did not invalidate notes/sources vector freshness.
8. **Curate maintenance**: Verify wiki maintenance runs in both scheduler branches: one run after a normal claim batch completes and one run through the `lastCompletedThrough === null` fallback. In both cases, a wiki referencing a newly advanced source gets updated Understanding and a new Evidence entry, and only that wiki's maintenance cursor advances.
9. **Wake-up**: Create 3 wiki entries. Run `kb wake-up` and invoke the SessionStart hook path. Verify both the manual output and hook `additionalContext` contain the same recency-sorted Understanding excerpts, truncated to ~900 tokens, without requiring backend warm-start to complete first.
10. **Obsidian**: Open vault in Obsidian. Verify `wiki/` folder is visible in file explorer. Graph view shows wiki links resolving to other KB entries via `[[wikilinks]]`. Tags render correctly.
11. **Reindex**: `kb reindex` includes wiki entries in count and CLI formatting prints `wiki: N`. Orama index contains `kind='wiki'` documents, wiki search results retain `references_principles` metadata, and vector snapshot/chunking remains limited to notes and sources in v1.
