# KB Multilingual FTS Tokenizer Design

> **Status: IMPLEMENTED.** This document describes the current Orama FTS implementation.
> Created: 2026-06-19. Updated: 2026-06-20. The measurements that motivated the design are summarized in section 2.

## 1. Background / Problem

- **Original failure mode**: Orama FTS used an English-only tokenizer, formerly `ORAMA_LANGUAGE='english'` plus the `SPLITTERS` regex in `src/engines/orama/document-builder.ts`. The splitter treated Hangul as a separator, so Korean and CJK text could tokenize to an empty array and silently disappear from the index. Korean search returned zero results without an error.
- **Constraint**: Vector search (`kb.vector`) is off by default and requires an API key or equipped capability. Default search quality therefore depends on FTS quality, which makes multilingual FTS a core requirement.
- **Current behavior goals**: no language should silently disappear, Korean morphology should be high-accuracy when explicitly enabled, the baseline path should add no required bundle or runtime cost, semantic similarity remains a vector-search concern, and tokenizer-tier changes must not block reads on full rebuilds.

## 2. Key Measurements

Spike results on Node 25 on the development machine:

| Topic | Result |
| --- | --- |
| `Intl.Segmenter` multilingual segmentation | Korean, no-space Chinese, Japanese, and Latin text segment correctly, for example `["한국어","검색을",...]` and `["中文","分词","测试"]`. |
| Intl indexing throughput / query latency | 37.6 MB/s / 13 us |
| Minimum Node support for `Intl.Segmenter` | Node 16+; full ICU is present by default from Node 13. Coral requires `>=24`, so this is covered. |
| Kiwi WASM (`kiwi-nlp`) on Node | Works through `ENVIRONMENT_IS_NODE`; WASM keeps Windows, WSL, Ubuntu, and macOS portable. |
| Kiwi `cong` model | 88 MB download, about 110 MB unpacked. Node injects the model as a `Uint8Array`, so no runtime fetch is needed after install. |
| Kiwi `cong` quality | Handles particles, conjugation, irregular forms, and derivational normalization, for example `검색을 -> 검색+을`, `골라 -> 고르+어`, `재검색 -> 재/XPN+검색`. |
| **Kiwi resident memory** | **~1.0-1.1 GB**, dominated by the non-quantized neural model and WASM heap. |
| **Kiwi throughput** | **~0.07-0.18 MB/s**, dominated by kiwi-nlp JSON marshaling rather than model choice. |
| knlm/sbg | Still about 640 MB, slower, and lower quality, so it is not adopted. WASM 0.23 is also `cong`-only. |
| Native MeCab | Excluded because Windows builds and dictionary management do not fit Coral's distribution model. |
| Current Orama projection | Applies `insert/update/remove` deltas from the sidecar `entryManifest`, with full-install fallback when the manifest is insufficient. Tokenizer-identity tier reconciles converge through full install even when snapshot content is unchanged. |

Conclusion: the baseline should be `Intl.Segmenter` because it has zero extra cost. Kiwi `cong` is the best high-accuracy Korean option, but its memory and throughput require opt-in enablement, incremental projection, and idle memory release.

## 3. Architecture

### 3.1 Two-Layer Tokenizer

- **Layer 0 - baseline, always on, zero extra cost**: `Intl.Segmenter(undefined, { granularity: 'word' })` plus English stemming for ASCII tokens. Every script is segmented into word-like units. English remains the primary stemmed language.
- **Layer 1 - language-specific morphology, opt-in**: languages declared through `CORAL_KB_EXTRA_LANGS` are routed to a dedicated analyzer. Today the only dedicated analyzer is `ko -> Kiwi cong`.

### 3.2 Script Routing

A single router splits text into script runs, tokenizes each run with the selected analyzer, and merges the result into one token stream. Indexing and query text go through the same router.

```text
Index: "코랄 검색 hello world"
  [코랄 검색](Hangul) -> Kiwi -> 코랄/NNP, 검색/NNG
  [hello world](Latin) -> Intl+stem -> hello, world
  document tokens = {코랄, 검색, hello, world} -> one index insert

Search: "검색 hello" -> same router -> {검색, hello} -> one Orama search
```

- There is one index, one tokenizer router, and one search call. There is no secondary pass or score aggregation.
- Korean tokens match Korean tokens, English tokens match English tokens, and BM25 scores them together inside the same index.
- Mixed-script no-space text such as `검색API` splits at the script boundary into `검색` and `API`.
- Coral search already uses prefix matching (`exact: false`), so an Intl-only Korean token can still match forms like `검색 -> 검색을` when Kiwi is not active.

### 3.3 Configuration

```text
CORAL_KB_EXTRA_LANGS=ko        # promote ko to morphological analysis on top of the baseline
CORAL_KB_EXTRA_LANGS=ko,ja     # reserved for future expansion
# unset = English baseline + universal Intl; Korean still searches through word-like segmentation and prefix matching
```

- Parsing trims input, lowercases it, splits on commas, and drops empty tokens. `ko`, `KO`, and `Ko` are equivalent.
- Language codes without a dedicated analyzer are ignored with a warning; the Intl baseline still covers the text.

### 3.4 Kiwi Engine

- The model is `cong` (`modelType: 'cong-global'`) through kiwi-nlp WASM. Node reads the model file from `fs` and injects it as a `Uint8Array`.
- Delivery uses an installable artifact, following the needle/onnx pattern. The artifact can be equipped explicitly or fetched lazily.
- Lazy load and idle eviction:
  - The model is not loaded by default. It loads when search or indexing first needs Korean morphology, with a roughly 1.5s build cost.
  - If search and indexing are idle for the configured window, currently 5 minutes by default, the analyzer is disposed and about 1 GB can be released. The 88 MB model remains on disk.
  - Reloading from the disk cache costs about 1.5s and does not fetch again. Only the first cold query waits.
  - During eviction, search must not fall back to Intl for a Kiwi-built index because the query tokenizer would no longer match the index tokenizer. The next search waits for reload instead.
- Dictionary options stay enabled. Disabling `loadDefaultDict`, `loadMultiDict`, or `loadTypoDict` saves only about 15 MB while harming accuracy; the neural model dominates memory.

### 3.5 Incremental Projection

- Content edits re-tokenize only changed or deleted entries and apply `insert/update/remove` deltas to the persistent Orama database. If the manifest is insufficient for deltas, the system falls back to full install.
- This makes one-document edits cost one Kiwi pass for that document. It is the prerequisite that makes Kiwi practical, and it also speeds up large Intl-only KBs.
- The installed artifact sidecar's `entryManifest` is the delta baseline. `snapshotStore.persist` returns the actual `OramaProjectionMetadata` that it wrote, and the write path installs that metadata into the cache with the database.
- A separate token memoization cache is unnecessary. Entry-manifest-based incremental projection is the authoritative path.

### 3.6 Index Identity / Mismatch Classifier

- `ORAMA_PROJECTION_IDENTITY_HASH` includes identity schema version, schema version and digest, Node and ICU versions, tokenizer identity, and declared analyzers.
- `OramaProjectionMetadata` stores the same classifier inputs: `identitySchemaVersion`, `schemaVersion`, `schemaDigest`, `nodeVersion`, `icuVersion`, `tokenizerIdentity`, and `declaredAnalyzers`. Newly added fields are optional for sidecar parsing compatibility, but missing metadata classifies as `incompatible`.
- `classifyProjectionMismatch(persistedMetadata, currentExpectedInput)` returns:
  - `match`: every identity input matches.
  - `tier-only-upgrade`: schema, Node, and ICU match; only tokenizer/analyzer identity differs; persisted tier is Intl and expected tier is Kiwi.
  - `incompatible`: schema, Node, or ICU drift; missing metadata; obsolete sidecar shape; persisted Kiwi tier would need to be read with Intl; or the tier is unknown.
- `identitySchemaVersion` is part of the hash input, not just metadata. Even if an obsolete sidecar accidentally has a retired hash, boot repair treats it as projection-artifact lag.
- If Orama-only sidecar repair hits `FreshnessTimeout`, KB readiness remains non-fatal. FTS exposes a stale or uninitialized warning while the already-started background reconcile continues. Non-Orama lag, structural errors, and apply failures remain fatal under the normal readiness rules.
- The lost-update guard is freshness-safe and identity-aware. Before persisting, it rechecks disk/cache metadata. If the persisted snapshot is strictly fresher for Orama's concern set, it skips regardless of identity. If the snapshot is equal or sufficiently equal, it skips only when the target `projectionIdentityHash` also matches. A reconcile that changes only Intl/Kiwi tier identity therefore still converges.

### 3.7 Read Path: Pure Consumer + Serve-Stale

- `OramaSearchPort` reads (`ensureLoaded`, `search`, `tokenize`, `tokenizeBatch`) are pure consumers of `OramaSnapshotStore`. Reads do not synchronously run full corpus rebuilds, `persist`, `installFullSnapshot`, or `forceCorpusApply`.
- The read path classifies cache/load output with `classifyProjectionMismatch`, then activates a served-index record containing metadata, `servedTokenizerIdentity`, database tokenizer, and snippet tokenizer. Orama query tokenization and snippet/query tokenization always come from that served record.
- `match`: serve only when the artifact tier and served tokenizer agree. Intl artifacts use the Intl tokenizer. Kiwi artifacts serve only when a live Kiwi analyzer lease can bind the tokenizer.
- `tier-only-upgrade`: when Kiwi is expected but the persisted artifact is a valid Intl tier, serve immediately with the Intl tokenizer, expose `fts_index_stale_tier`, and fire `requestProjectionReconcile('stale-tier')`.
- `incompatible`: do not serve structurally incompatible artifacts, missing metadata, Kiwi artifacts that would require an Intl query tokenizer, or cold Kiwi artifacts without a live lease. The system falls back to the degraded/uninitialized FTS path and requests non-blocking reconcile.
- The core invariant is served-tokenizer consistency: Intl-built indexes are queried only with the Intl tokenizer, and Kiwi-built indexes are queried only with a live Kiwi tokenizer lease.

### 3.8 Reconcile Ownership + Degrade Trigger

- Reconcile ownership lives in the KB daemon expansion lifecycle and the shared `ConsumerDriver`. The Orama read path only calls the injected `requestProjectionReconcile?: (reason: OramaReconcileReason) => void` callback.
- The KB daemon creates `createOramaProjectionReconcileRequester` and passes it to a single `OramaBaseProjection`. That projection exposes one read port both as the registered `CorpusConsumer` and the bound FTS capability. The requester is single-flight inside the KB daemon and calls `driver.forceCorpusApply(snapshot, { reason: 'projection-artifact-lag', consumers: [ORAMA_BASE_CONSUMER_ID] })` for the current corpus snapshot.
- Kiwi degrade is primarily a KB daemon trigger. `KiwiAnalyzerManager.markDegraded` records degraded state, schedules `observeDegraded` observers in a fire-and-forget microtask, then throws the terminal load error. Bundled Orama loading registers this observer in `host.scope`, so scope disposal removes it from the process-singleton manager and does not retain a disposed daemon driver.
- Degraded observers are exception-isolated and fire-and-forget. A throwing or slow observer must not break the Kiwi terminal-error path.
- The observer calls `createOramaProjectionReconcileRequester.requestKiwiDegradedReconcile`. That path runs `invalidateTextSnapshot('kiwi-degraded')` and force-applies the Orama consumer, allowing the persisted index to converge back to the Intl tier without a corpus edit or restart. `OramaBaseProjection.onApplyFailure` is supplemental coverage, not the primary degrade signal.

### 3.9 Statusline Indicator

- Location: the far right of the gear/discuss-count statusline segment.
- States: Korean model background fetch, reindex in progress, and idle hidden state.
- Data source: the daemon exposes projection rebuild progress and model fetch state through events/IPC; the statusline subscribes to those signals.
- Display examples: `Korean model downloading`, `KB reindex 12%`, or hidden while idle.

## 4. Behavior Decisions

- Diacritics: fold only Latin diacritics through Orama `replaceDiacritics`. Do not run global NFKD normalization because it decomposes Hangul jamo.
- English stemming applies only to ASCII tokens.
- Underscores and identifiers are split by Intl. This is acceptable for prose-oriented KB content.
- Locale selection uses one neutral segmenter for mixed-script text.
- Custom `tokenize` ignores Orama's `language` argument; the previous mismatch throw behavior is removed.
- `create()` still omits `language` to avoid `NO_LANGUAGE_WITH_CUSTOM_TOKENIZER`.

## 5. Non-Goals

- Semantic similarity belongs to embeddings/vector search.
- Dedicated Chinese or Japanese morphology is not introduced; Intl dictionary segmentation is sufficient for the current scope.
- knlm/sbg and native MeCab are not adopted.

## 6. Cost / Tradeoff Summary

| | Layer 0 (Intl) | Layer 1 (Kiwi cong, ko) |
| --- | --- | --- |
| Dependency / bundle | 0; built into Node | Installable 88 MB model with lazy fetch |
| Resident memory | ~0 | ~1 GB, releasable after 5 idle minutes |
| Throughput | 37.6 MB/s | ~0.18 MB/s, but only changed entries are processed |
| Quality | Word-like segmentation plus prefix matching | High-accuracy morphology |
| Activation | Always on | `CORAL_KB_EXTRA_LANGS=ko` plus model availability |

## 7. Implementation Phases

### Phase 1 - Multilingual Baseline (Intl Router) _[implemented]_

- Replaced `createOramaTokenizer` with a custom tokenizer using universal `Intl.Segmenter` plus English stemming for ASCII tokens.
- Added script routing: split by script, tokenize each run, then merge into one token stream. Runs without an effective dedicated analyzer use Intl plus Latin stemming.
- Changed `KbOramaTokenizer` from `DefaultTokenizer` to the narrower `Tokenizer` contract.
- Used `ORAMA_PROJECTION_SCHEMA_VERSION` and projection identity drift to reindex existing users automatically.
- Result: Korean and CJK are immediately searchable, fixing the previous zero-result behavior with no new dependency or memory cost.
- Risk: low. English behavior remains effectively equivalent through Intl segmentation plus stemming.

### Phase 2 - Incremental Projection _[implemented, prerequisite for Phase 3]_

- Replaced full-rebuild-centered behavior with delta application through `insert/update/remove`.
- Computes entry `contentHash` deltas against the installed snapshot, applies them to the persistent Orama database, and advances cursor/freshness.
- Result: each edit re-tokenizes only changed entries. This reduces large-KB Intl rebuild cost and is the key prerequisite for practical Kiwi use.
- Risk: medium-high because it changes projection authority behavior and requires broad test coverage.

### Phase 3 - Korean Morphology Opt-In (Kiwi) _[implemented]_

- Parses `CORAL_KB_EXTRA_LANGS`, normalizes to lowercase, and gates dedicated analyzers.
- Delivers Kiwi `cong` as an installable artifact, either through explicit equip or background fetch when `ko` is declared and Korean corpus text is detected.
- Keeps boot non-blocking: serve Intl while the model fetches, prepare the model, reindex in the background, then swap Korean runs to Kiwi when ready.
- Adds lazy load and 5-minute idle eviction. Search or indexing activity resets the timer; search during eviction waits for reload and never falls back to Intl for a Kiwi-built index.
- Includes tokenizer identity and declared analyzers in the projection identity hash so toggles trigger reindex.
- Keeps reads as pure consumers. Tier mismatch does not rebuild during reads; the serve-stale gate in section 3.7 preserves the served-tokenizer invariant.
- Makes reconcile KB-daemon-owned. `requestProjectionReconcile` goes through the single-flight requester to `ConsumerDriver.forceCorpusApply`, and Kiwi terminal degrade uses the scoped `observeDegraded` registration in section 3.8 as its primary trigger.
- Adds statusline indicators for model fetch and reindex progress.
- Result: Korean search accuracy and ranking improve substantially for opt-in users, with no impact when the setting is unset.
- Risk: medium. Memory release, cold reload UX, and background reindex progress presentation require ongoing validation.

Phase 1 had standalone value. Phase 3 required Phase 2 because Kiwi plus full rebuild on every edit would be impractical. The current implementation includes Phases 1-3 plus the serve-stale and reconcile hardening described above.

## 8. Operational Follow-Up

- Verify that the Emscripten WASM heap is actually reclaimed after dispose, including stale reference cleanup and eviction/reload races.
- Improve progress UX for first large-KB Kiwi reindex runs.
- Keep improving user-facing messages for repeated model-fetch failures and terminal degrade.
- Regression axes: multilingual tokenization, index/query symmetry, identity-change reindex, script routing, incremental deltas, serve-stale tier gates, degrade reconcile, sidecar boot repair, and lost-update guarding.

## 9. Impacted Code Areas

- `src/engines/orama/document-builder.ts` - tokenizer/router.
- `src/engines/orama/schema.ts` - `KbOramaTokenizer` type.
- `src/engines/orama/backend.ts` - served-index read path, pure-consumer reconcile request, projection apply, lost-update guard.
- `src/engines/orama/artifact-port.ts` - projection identity metadata, identity hash, `classifyProjectionMismatch`.
- `src/engines/orama/snapshot.ts` - metadata-bearing load/persist/cache and tier-appropriate analyzer getter.
- `src/kb-daemon/expansion/lifecycle.ts` - `createOramaProjectionReconcileRequester`, Kiwi fetch-triggered reindex, degrade reconcile wiring.
- `src/coordinator/index.ts` - coordinator wiring and Orama-only boot `FreshnessTimeout` fallback.
- `src/engines/kiwi/analyzer-manager.ts` - lazy lease lifecycle, idle eviction, `observeDegraded` registration.
- `src/kb/corpus/...` - projection input and freshness source.
- Coordinator/env wiring - `CORAL_KB_EXTRA_LANGS` to declared/effective analyzers.
- Kiwi engine modules and installer - installable artifact delivery.
- Statusline - fetch/reindex indicators.
- Tests - unit and integration coverage for the paths above.
