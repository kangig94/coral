# Core Modules

A high-level map of what each area of the codebase is for. This document describes stable seams — composition roots, domain owner modules, and public contracts. Implementation files evolve inside each area without requiring doc updates.

Coral's product identity is a coding-assistant plugin for Claude Code and Codex. Its internal architecture is a local coding-agent coordination layer: the coordinator owns live decisions and recovery, domains own truth vocabulary, transport carries requests, and the CLI is the local operator surface.

## Composition Roots

| Entry                    | Bundle                                      | Role                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend composition root | `clients/bridge/coral-backend.cjs`          | Backend daemon bootstrap. Wires runtime ports, identity metadata, domain owner modules/contracts, lifecycle, and IPC/HTTP transport routes.                                                           |
| CLI entrypoint           | `clients/bridge/coral-cli.cjs`              | Commander-based CLI client that uses IPC for mutating/live work, reads `read-model/CoralStore` directly for no-coordinator paths, and retains HTTP for the remote gateway plus operational carveouts. |
| Claude broker helper     | `clients/bridge/coral-claude-appserver.cjs` | Provider helper that accepts broker RPC and runs Claude through the default `claude -p` stream-json transport or the opt-in PTY TUI transport.                                                        |

## CLI and Client

The CLI parses commands, follows detached launches via the `jobs.wait` IPC subscription, and formats output for humans and machines. The client layer owns backend startup, IPC dispatch/subscriptions, direct `read-model/CoralStore` read helpers for no-coordinator paths, and the HTTP gateway/admin helpers exposed through the public barrel.

## Backend

The coordinator is a composition root, not a domain. The root is split into a coordinator layer and a transport layer: the coordinator owns lifecycle, startup recovery, projection freshness, corpus notify publication, job-backed KB source import/reindex, and cross-domain assembly; transport owns IPC plus HTTP/SSE parsing, validation, and wire formatting. New domain logic does not land in either layer; it stays in its owning domain and is reached through explicit owner modules/contracts.

## Runtime

The backend uses a **single Runtime world** pattern: one interface with a fixed set of I/O subports (time, storage, paths, process, ids, env), swapped once at composition. Every I/O-touching module routes through it. The real runtime is used in production; a deterministic counterpart powers the simulation lane.

## Journal

The Journal is the event-sourced truth spine for all domain state. It provides append, rebuild, strict envelope decoding, domain append-validator, and projection-reducer dispatch primitives backed by SQLite in WAL mode. `store/` exports the SQL/Journal substrate; product read APIs live in `read-model/CoralStore` and domain-owned read query modules. There are no body versions, upcasters, or old-format readers: the application-wide store format covers every persisted codec and executable DDL fragment, and startup destructively resets incompatible durable state.

## Causality

Cross-stream event references live below the domains in `causality/`. `CauseRef` is vocabulary, not storage: domains can point at originating Journal events without importing `store/`, database handles, or each other's shells.

## Domains

Each domain is self-contained: its own contract (events, projection, read-models), its own functional core (pure state transitions), its own imperative shell (persistence, loop control, external effects), and explicit coordinator-facing owner modules for commands, queries, recovery, and ports. Domains do not import each other; cross-domain composition happens at the backend layer only. Ownership surfaces are real contracts/modules, not `api.ts` barrels or compatibility shims.

| Domain   | Responsibility                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jobs     | Job lifecycle truth — launch, admit, wait, abort, terminal outcome, cause references, startup reconciliation, cross-namespace adoption.                         |
| Sessions | Session persistence and continuity — open, checkpoint, interrupt, provider failure, close, atomic storage, lookup by id or ref.                                 |
| Workflow | DSL parsing, semantic plan compilation, pipeline execution (launch and retry intertwined), drain handling, resume-from-projection.                              |
| Discuss  | Multi-agent discussion loop — pure state machine at the core, imperative shell around it for persistence, bids, speeches, follow-ups, synthesis, and snapshots. |

## Provider Adapters

Provider adapters translate between the domain contract and external CLIs. Codex uses the Codex app-server surface; Claude uses a broker helper around Claude CLI, defaulting to `claude -p` stream-json and retaining an opt-in PTY TUI transport. Adapter-level changes must preserve wire-compatibility with the adapted provider. Adapters normalize provider usage at this boundary to the canonical additive `UsageSummary` (`inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, optional `costUsd`) before it reaches jobs. Provider-owned profile, binding, and continuity parsers contribute their exact persisted contracts to the application-wide store format.

## Expansion

Expansion is the installable runtime contract that lets optional backends bind to a domain's `RuntimeBinding<Backed<T>>` cells without the domain knowing whether the binding is held. An `Expansion = (host) => void | Promise<void>` is a single-function contract; bundled and (future) third-party expansions are byte-identical to the loader. The coordinator's `ExpansionLifecycleService` orchestrates equip/unequip — equip resolves the entry from `BUNDLED_EXPANSIONS`, dynamic-imports it, invokes the function under a fresh disposable scope, and persists `{id, version, installed_at}` in `expansion_state`. Unequip disposes the scope (which atomically releases every binding the expansion held) and deletes the row.

KbRuntime registers built-in capability descriptors and empty `RuntimeBinding<Backed<T>>` cells; engines fill those cells through the same binding contract whether they are bundled or installed. Bundled Orama binds `kb.fts` during expansion lifecycle startup. `kb.embedding` carries no constructor-time default — embedders are peer engines (`gemini`, `onnx`) — and engines like Needle bind `kb.vector` when equipped. Single-occupancy is enforced inside `RuntimeBinding.bind` itself (throws `binding-occupied` if held), not by lifecycle bookkeeping. Retrieval-consumer freshness is observed through `ConsumerDriver.waitFreshUntil('corpus', snapshot, consumerId)` after the Corpus commit; readiness is a comparison (`backed.consumer.cursor ≥ corpus version`), not a method on the `Backed<T>` contract.

## Knowledge Base

The KB domain owns the Corpus markdown authority over notes, sources, principles, communities, and wiki entries; text and vector search contracts; note and wiki mutation; source persistence; background curation (content-fingerprint-driven note/source classification, community detection, entity consolidation, wiki touch-journal drain that bubbles touched Knowledge links one position toward the front per touch event — transposition heuristic; semantic wiki mutations are user/LLM workflow only); conflict-free multi-machine git sync for derived KB metadata; and the project-scoped memo scratch lifecycle. Source import conversion is coordinator-owned because it can be long-running and is represented as an internal `kb.source_import` job with explicit readiness (`commit`, `base-search`, `active-vector`, `all-equipped`). Explicit reindex is also coordinator-owned as an internal `kb.reindex` job: the KB op rebuilds text artifacts, and the coordinator service waits for base-search freshness. These jobs are Journal-observable process attempts, not provider/session jobs.

Classification pending state is content-driven: the index stores `bodyHash` plus note/source `inputFingerprint`, and curation claims only entries where `inputFingerprint` is absent or differs from the `bodyHash` already stored in the same index entry (no live re-hash at claim time). A synced peer can therefore reuse already-curated frontmatter without re-running the LLM. The curation cursor is `(timestamp, kind, slug)` (`createdAt` for notes, `importedAt` for sources); the per-machine `contentSeq` and `metadataSeq` counters (and the `currentEntrySeq()` derived from them) remain freshness metadata, not the cross-machine ordering key.

Curate/git-sync implementation lives in the KB domain: `kb/curate/entity-graph-merge-driver.ts` merges `.entity-graph.json` by feeding a union of ours and theirs into `consolidateEntityGraph` from an empty base (the git merge base is ignored — it carries no deletion semantics here); `kb/curate/frontmatter-merge-driver.ts` unions frontmatter set fields (`tags`, `principles`, `related`) and resolves scalar fields via body-match/lexicographic tiebreaks, delegating body prose to `git merge-file`; `kb/curate/conflict-quarantine.ts` records entries skipped after unrecoverable body-prose conflicts. `ensureKbMergeDrivers()` in `kb/curate/git-sync.ts` appends the managed `.gitattributes` entries, registers the merge drivers, and pins `rebase.backend=merge`; derivatives and frontmatter resolve without the LLM, while irreducible body-prose conflicts fall back to the LLM resolver as a last resort before git sync aborts the rebase, preserves local commits under `refs/coral-recovery/<branch>/...`, resets to `origin/<branch>`, and quarantines the affected entries. The AC7 rollout migration in `kb/migrations/index.ts` is TEMPORARY (REMOVE AFTER ~2026-07); it backfills missing `inputFingerprint`; errors are caught and logged inside `runPendingKbMigrations`, so a migration failure never blocks scheduler startup.

The KB mutation lock commits Corpus state and text artifacts only. It does not install retrieval projections. Orama is the base CorpusConsumer and Needle is an optional Expansion-bound CorpusConsumer; both rebuild derived retrieval state from the Corpus snapshot they apply.

Orama has a deliberate read/write split. `OramaSearchPort` is a pure consumer of `OramaSnapshotStore`: `ensureLoaded`, `search`, `tokenize`, and `tokenizeBatch` never synchronously rebuild, persist, or call `forceCorpusApply`. They classify cached or persisted artifact metadata with `classifyProjectionMismatch`, activate a served-index record, and query with the tokenizer that matches the served artifact. Intl-tier artifacts are always served through the Intl tokenizer. Kiwi-tier artifacts are served only while a live Kiwi analyzer lease can bind the tokenizer; if the lease is unavailable, the read path returns the degraded/uninitialized FTS path and asks for reconcile instead of querying a Kiwi index through Intl. During an Intl→Kiwi upgrade, a valid Intl artifact is served immediately under the Intl tokenizer, `fts_index_stale_tier` is surfaced, and `requestProjectionReconcile('stale-tier')` is fired without awaiting it.

Orama reconcile ownership lives in the KB daemon's expansion lifecycle, using the shared `projection-consumers/` driver. `createOramaProjectionReconcileRequester` is wired into one `OramaBaseProjection`; that projection's single read port is exposed as both the registered CorpusConsumer and the bound FTS capability. The requester single-flights reconcile requests and delegates writes to `ConsumerDriver.forceCorpusApply(currentSnapshot, { reason: 'projection-artifact-lag', consumers: [ORAMA_BASE_CONSUMER_ID] })`. The read model only requests reconcile. The write path remains the CorpusConsumer apply path, which persists Orama artifacts, stores the returned metadata in the cache, and uses a freshness-safe identity-aware lost-update guard: strictly fresher persisted artifacts win, but equal-snapshot identity-changing tier reconciles are allowed to converge.

Kiwi degradation also reconciles through the KB daemon's expansion lifecycle. The bundled Orama loader registers a mandatory `KiwiAnalyzerManager.observeDegraded` observer scoped to the expansion `host.scope`; scope disposal removes it from the process-singleton manager. `markDegraded` records degraded state and schedules the observer as a fire-and-forget microtask, then throws the terminal Kiwi load error; the observer runs asynchronously after the throw propagates, and observer failures are caught so the terminal-error path remains intact. The observer calls the same `createOramaProjectionReconcileRequester` requester with the `kiwi-degraded` path, which invalidates the text snapshot with `kiwi-degraded` and force-applies the Orama consumer, allowing a terminally degraded Kiwi index to converge back to the Intl tier without a corpus edit or restart. `onApplyFailure` is supplemental coverage, not the primary degradation signal.

Orama projection sidecars carry identity metadata in addition to snapshot metadata: `identitySchemaVersion`, schema version/digest, Node/ICU versions, tokenizer identity, and declared analyzers. Retired sidecars without those fields still parse, but classify as incompatible and are not serve-stale eligible. `identitySchemaVersion` participates in `ORAMA_PROJECTION_IDENTITY_HASH`, so old sidecars are detected as projection-artifact lag on boot; an Orama-only boot repair that times out with `FreshnessTimeout` is non-fatal to KB readiness and leaves FTS stale or uninitialized while the background reconcile continues.

## Work Classes

Jobs are not an async wrapper for every command. They are durable work ledgers for long-running, observable, or recovery-relevant attempts.

| Class                    | Examples                                | Owner                                                       |
| ------------------------ | --------------------------------------- | ----------------------------------------------------------- |
| Direct read              | KB read/list, `jobs`, discuss watch     | Read model or KB query helpers; no durable artifact rebuild |
| Served read              | KB search                               | KB daemon search runtime; no durable job ledger             |
| Direct mutation          | KB note write/delete; memo write/delete | Corpus lock for KB notes; project data dir for memos        |
| Provider/session job     | Codex/Claude launches, workflow atoms   | Jobs + sessions + provider adapters                         |
| Internal coordinator job | KB source import, KB reindex            | Coordinator service over jobs + KB                          |
| Projection freshness     | Orama/Needle catch-up                   | ConsumerDriver cursor wait                                  |

Direct KB reads are coordinator-free, not context-free. CLI/bootstrap adapters resolve plugin root, build flavor, project root, Corpus root, and KB runtime root before invoking KB query helpers or `read-model/CoralStore`; lower KB path helpers do not choose `cwd`, `HOME`, or `CORAL_KB_PATH` on their own. KB search is a served read: it uses the KB daemon's search runtime instead of the direct read model.

Projection freshness is not authority. A Corpus commit remains durable even if a retrieval consumer fails to catch up; callers that requested readiness observe that failure through the hosting command or job.

## Coordinator

The coordinator layer owns process lifecycle, the three-era boot sequence (Kernel → Recovery → Runtime Health Components), projection-consumer wiring, provider-host coordination, job-backed KB source import/reindex proxying, and the corpus notify seam. It is the only place allowed to compose multiple parent-daemon domains together and the only place that speaks to both transport and domain owner modules/contracts at once.

## Runtime Components

`coordinator/runtime-components/` is a small registry layer for daemon-visible health/lifecycle components that must not extend the kernel path. It does not host the KB runtime; the parent registers only a KB daemon health mirror:

- `contract.ts` — `RuntimeComponent` (init / dispose / status), `RuntimeComponentStatus` (4 serving phases: `initializing → online | degraded | offline`), `DegradedReason` (currently `{ kind: 'curate-publish'; consecutiveFailures; lastError }`), and branded `RuntimeComponentId`.
- `registry.ts` — `createRuntimeComponentRegistry()` exposing `register / initAll / disposeAll / list / status`. It is a status/lifecycle projection only; KB requests go through the KB daemon supervisor, not through this registry.
- `runtime-components/kb-health-component.ts` — `createKbDaemonHealthComponent(kbDaemonSupervisor)` mirrors daemon health into `/health.components[]`; the KB daemon process owns the boot pipeline (Corpus replay + CorpusConsumer registration + Orama freshness wait), runtime construction, curate work, and expansion lifecycle. When `CORAL_KB_ENABLE=0`, the parent wires a disabled daemon supervisor, so the health component reports terminal `offline` with `KB_DISABLED_REASON` and does not spawn the KB daemon. The CLI matches that reason on `/health` to decide whether to restart the daemon and re-enable KB.

KB request failures (`kb_initializing`, `kb_offline`, `kb_disabled`) come from the KB daemon request/supervisor path and lift to HTTP 503 through the standard error envelope with the `remediation` field.

Five invariants enforce the contract: `runtime-component-contract-singleton`, `kb-daemon-error-codes`, `lifecycle-phase-monotonic`, `abort-signal-threading`, `no-kb-status-accessors`.

Workflow plans persist only semantic slots: slot id, dependencies, provider, instruction, and optional agent. Runtime job ids, step indexes, display labels, and atom keys are derived from the plan plus child job projections.

## Infrastructure

Infrastructure helpers sit below every domain: schemas, small utilities, SSE parsing, cross-process locking, file tailing, and child-env construction. Infrastructure resolves canonical paths, build flavor, backend connection info, and expansion paths without becoming a generic domain dumping ground.

## Ownership Matrix

| Area                  | Owns                                             | Does not own                              |
| --------------------- | ------------------------------------------------ | ----------------------------------------- |
| `store/`              | SQL schema, Journal append/reducer substrate     | Product read facade, domain policy        |
| `read-model/`         | Composed read API                                | Writes, recovery, domain truth            |
| `jobs/`               | Job lifecycle and terminal vocabulary            | Provider process mechanics                |
| `sessions/`           | Immutable provider binding and continuity        | Multi-provider scope, job terminal policy |
| `workflow/`           | Plan and slot semantics                          | Provider/session persistence              |
| `discuss/`            | Discussion state and shell loop                  | Coordinator lifecycle                     |
| `kb/`                 | Corpus authority and query semantics             | Expansion lifecycle ownership             |
| `coordinator/`        | Live state, startup order, cross-domain assembly | Domain vocabulary                         |
| `transport/`          | Wire parsing and response mapping                | Business behavior                         |
| `cli/`                | User command surface and local startup glue      | Backend/domain truth                      |
| `infra/` / `runtime/` | Low-level paths, flavor, I/O ports               | Domain concepts                           |
| `causality/`          | Cross-stream event-reference vocabulary          | Store/database access                     |

## Dependency Outline

```text
CLI
  -> client helpers
     -> transport IPC/HTTP routes
  -> read-model/CoralStore library reads (read-only no-coordinator commands)

transport IPC/HTTP routes
  -> coordinator API + control ports
  -> domain owner modules/contracts (workflow / discuss / KB)

coordinator API
  -> jobs domain owner modules/contracts
  -> sessions domain owner modules/contracts
  -> provider adapters
  -> KB daemon expansion proxy
  -> live launch / host management
  -> provider host manager

coordinator startup (three eras)
  Era I  Kernel:     Journal open, freshness drain, transport listeners bound (lifecycle = kernel-ready)
  Era II Recovery:   jobs / discuss / workflow startup reconcile (lifecycle = running)
  Era III Runtime Components: components.initAll() — fire-and-forget; KB health component mirrors daemon health while the KB daemon owns boot

discuss shell
  -> discuss pure core
  -> Journal append via the domain's store-registry

KB runtime
  -> Corpus authority + publication state
  -> RuntimeBinding cells: kb.vector, kb.embedding, kb.fts (each a `RuntimeBinding<Backed<T>>`)
  -> Bundled Orama binds kb.fts; installed engines bind kb.vector / kb.embedding when equipped

infra / runtime / causality
  -> lowest common layer reused everywhere
```

## Stable Seams

These are the load-bearing boundaries that must not leak:

- The Runtime interface is the only channel for I/O inside the backend.
- The boot eras are ordered — Era I blocks until kernel-ready, Era II blocks until running, Era III runs fire-and-forget. CLI fail-fast deadlines watch only Eras I and II (`KERNEL_BIND_DEADLINE_MS = 5s`, `KERNEL_READY_DEADLINE_MS = 15s`); components must never extend the kernel path.
- `AbortSignal` is the cancellation primitive throughout startup. Aborting the startup signal with no string reason preserves the `AbortError` discriminator; calling `abort('shutdown')` strips that discriminator and breaks downstream `name === 'AbortError'` checks. Enforced by the `abort-signal-threading` invariant.
- Each domain owner module/contract set is the coordinator-facing surface for its domain; deleted `api.ts` barrels and compatibility shims are not recreated for convenience.
- `store/` is the SQL/Journal substrate; `read-model/CoralStore` composes product reads over domain-owned query modules.
- Domain registries own event schemas, append validators, and reducers; `store/` only runs the composed validators transactionally.
- Expansion lifecycle is KB-daemon-owned: transport reaches it through the parent `KbDaemonSupervisor.expansionRpc` proxy, and the KB daemon resolves active backends through `kbRuntime.<name>.read()` on each `RuntimeBinding<Backed<T>>` cell.
- KB retrieval projections are rebuildable consumers of the Corpus authority; source import and explicit reindex readiness wait on `ConsumerDriver.waitFreshUntil('corpus', ...)`.
- KB source import/reindex failure facts are recorded by coordinator-owned KB job recording glue as job progress cause events; the KB domain remains Corpus authority only.
- Compatibility shims are not stable seams on the rewrite branch; retired owner paths stay deleted once responsibility moves.
- Hooks never import from `src/`; shared hook logic lives alongside the hooks themselves.
- Runtime ingestion emits canonical domain events; incompatible historical bodies are rejected and the store-format reset boundary handles adoption.
