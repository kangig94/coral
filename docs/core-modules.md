# Core Modules

A high-level map of what each area of the codebase is for. This document describes stable seams — composition roots, domain owner modules, and public contracts. Implementation files evolve inside each area without requiring doc updates.

Coral's product identity is a coding-assistant plugin for Claude Code and Codex. Its internal architecture is a local coding-agent coordination layer: the coordinator owns live decisions and recovery, domains own truth vocabulary, transport carries requests, and the CLI is the local operator surface.

## Composition Roots

| Entry | Bundle | Role |
| --- | --- | --- |
| Backend composition root | `bridge/coral-backend.cjs` | Backend daemon bootstrap. Wires runtime ports, identity metadata, domain owner modules/contracts, lifecycle, and IPC/HTTP transport routes. |
| CLI entrypoint | `bridge/coral-cli.cjs` | Commander-based CLI client that uses IPC for mutating/live work, reads `read-model/CoralStore` directly for no-coordinator paths, and retains HTTP for the remote gateway plus operational carveouts. |
| Claude PTY broker helper | `bridge/coral-claude-appserver.cjs` | Provider helper that runs interactive Claude CLI through `node-pty`, accepts broker RPC, and streams completion from Claude JSONL transcripts. |

## CLI and Client

The CLI parses commands, follows detached launches via the `jobs.wait` IPC subscription, and formats output for humans and machines. The client layer owns backend startup, IPC dispatch/subscriptions, direct `read-model/CoralStore` read helpers for no-coordinator paths, and the HTTP gateway/admin helpers exposed through the public barrel.

## Backend

The coordinator is a composition root, not a domain. The root is split into a coordinator layer and a transport layer: the coordinator owns lifecycle, startup recovery, projection freshness, corpus notify publication, job-backed KB source import/reindex, and cross-domain assembly; transport owns IPC plus HTTP/SSE parsing, validation, and wire formatting. New domain logic does not land in either layer; it stays in its owning domain and is reached through explicit owner modules/contracts.

## Runtime

The backend uses a **single Runtime world** pattern: one interface with a fixed set of I/O subports (time, storage, paths, process, ids, env), swapped once at composition. Every I/O-touching module routes through it. The real runtime is used in production; a deterministic counterpart powers the simulation lane.

## Journal

The Journal is the event-sourced truth spine for all domain state. It provides append, rebuild, envelope + upcaster, domain append-validator, and projection-reducer dispatch primitives backed by SQLite in WAL mode. `store/` exports the SQL/Journal substrate; product read APIs live in `read-model/CoralStore` and domain-owned read query modules. Upcasters run on read, not on write — stored bytes are raw input bytes at their declared body version.

## Causality

Cross-stream event references live below the domains in `causality/`. `CauseRef` is vocabulary, not storage: domains can point at originating Journal events without importing `store/`, database handles, or each other's shells.

## Domains

Each domain is self-contained: its own contract (events, projection, read-models), its own functional core (pure state transitions), its own imperative shell (persistence, loop control, external effects), and explicit coordinator-facing owner modules for commands, queries, recovery, and ports. Domains do not import each other; cross-domain composition happens at the backend layer only. Ownership surfaces are real contracts/modules, not `api.ts` barrels or compatibility shims.

| Domain | Responsibility |
| --- | --- |
| Jobs | Job lifecycle truth — launch, admit, wait, abort, terminal outcome, cause references, startup reconciliation, cross-namespace adoption. |
| Sessions | Session persistence and continuity — open, checkpoint, interrupt, provider failure, close, atomic storage, lookup by id or ref. |
| Workflow | DSL parsing, semantic plan compilation, pipeline execution (launch and retry intertwined), drain handling, resume-from-projection. |
| Discuss | Multi-agent discussion loop — pure state machine at the core, imperative shell around it for persistence, bids, speeches, follow-ups, synthesis, and snapshots. |

## Provider Adapters

Provider adapters translate between the domain contract and external CLIs. Codex uses the Codex app-server surface; Claude uses the PTY broker helper around the interactive Claude CLI. Adapter-level changes must preserve wire-compatibility with the adapted provider. Adapters stay on canonical domain types; event body evolution is handled by domain upcasters at Journal read boundaries.

## Expansion

Expansion is the installable runtime contract that lets optional backends bind to a domain's `RuntimeBinding<Backed<T>>` cells without the domain knowing whether the binding is held. An `Expansion = (host) => void | Promise<void>` is a single-function contract; bundled and (future) third-party expansions are byte-identical to the loader. The coordinator's `ExpansionLifecycleService` orchestrates equip/unequip — equip resolves the entry from `BUNDLED_EXPANSIONS`, dynamic-imports it, invokes the function under a fresh disposable scope, and persists `{id, version, installed_at}` in `expansion_state`. Unequip disposes the scope (which atomically releases every binding the expansion held) and deletes the row.

Built-in defaults are NOT registered as expansions. Orama is the constructor-time value of `kb.vector` and `kb.fts` bindings on `KbRuntime`; the KB router calls `binding.read().read(...)` and gets either the default or the bound expansion's value with one indirection. `kb.embedding` carries no constructor-time default — embedders are peer Expansions (`gemini`, `onnx`) discriminated by `BundledExpansion.metadata.slot === 'kb.embedding'`. Single-occupancy is enforced inside `RuntimeBinding.bind` itself (throws `binding-occupied` if held), not by lifecycle bookkeeping. Retrieval-consumer freshness is observed through `ConsumerDriver.waitFreshUntil('corpus', snapshot, consumerId)` after the Corpus commit; readiness is a comparison (`backed.consumer.cursor ≥ corpus version`), not a method on the `Backed<T>` contract.

## Knowledge Base

The KB domain owns the Corpus markdown authority over notes, sources, principles, communities, and wiki entries; text and vector search contracts; note and wiki mutation; source persistence; background curation (community detection, entity consolidation, wiki touch-journal drain that bubbles touched Knowledge links one position toward the front per touch event — transposition heuristic; semantic wiki mutations are user/LLM workflow only); and the project-scoped memo scratch lifecycle. Source import conversion is coordinator-owned because it can be long-running and is represented as an internal `kb.source_import` job with explicit readiness (`commit`, `base-search`, `active-vector`, `all-equipped`). Explicit reindex is also coordinator-owned as an internal `kb.reindex` job: the KB op rebuilds text artifacts, and the coordinator service waits for base-search freshness. These jobs are Journal-observable process attempts, not provider/session jobs.

The KB mutation lock commits Corpus state and text artifacts only. It does not install retrieval projections. Orama is the base CorpusConsumer and Needle is an optional Expansion-bound CorpusConsumer; both rebuild derived retrieval state from the Corpus snapshot they apply.

## Work Classes

Jobs are not an async wrapper for every command. They are durable work ledgers for long-running, observable, or recovery-relevant attempts.

| Class | Examples | Owner |
| --- | --- | --- |
| Direct read | KB search/read/list, `jobs`, discuss watch | Read model or KB query helpers; no durable artifact rebuild |
| Direct mutation | KB note write/delete; memo write/delete | Corpus lock for KB notes; project data dir for memos |
| Provider/session job | Codex/Claude launches, workflow atoms | Jobs + sessions + provider adapters |
| Internal coordinator job | KB source import, KB reindex | Coordinator service over jobs + KB |
| Projection freshness | Orama/Needle catch-up | ConsumerDriver cursor wait |

Direct KB reads are coordinator-free, not context-free. CLI/bootstrap adapters resolve plugin root, build flavor, project root, Corpus root, and KB runtime root before invoking KB query helpers or `read-model/CoralStore`; lower KB path helpers do not choose `cwd`, `HOME`, or `CORAL_KB_PATH` on their own.

Projection freshness is not authority. A Corpus commit remains durable even if a retrieval consumer fails to catch up; callers that requested readiness observe that failure through the hosting command or job.

## Coordinator

The coordinator layer owns process lifecycle, the three-era boot sequence (Kernel → Recovery → Subsystems), ConsumerDriver freshness, expansion lifecycle, provider-host coordination, job-backed KB source import/reindex, and the corpus notify seam. It is the only place allowed to compose multiple domains together and the only place that speaks to both transport and domain owner modules/contracts at once.

## Subsystems

`coordinator/subsystems/` is a small registry layer that turns long-init coordinator services into independently retried, self-healing units without leaking their boot ordering into the kernel path:

- `contract.ts` — `Subsystem<R>` (init / dispose / resource), `SubsystemStatus` (5-state phase: `pending → initializing → online | degraded | offline`), `DegradedReason` (discriminated union, currently only `{ kind: 'curate-publish'; consecutiveFailures; lastError }`), branded `SubsystemId`, and `SubsystemUnavailableError`.
- `registry.ts` — `createSubsystemRegistry()` exposing `register / initAll / disposeAll / run / runAsync / list / status`. `run(id, fn)` resolves the subsystem's `R` and runs `fn(R)` only when `phase === 'online'`; otherwise it returns a `SubsystemErrorEnvelope = { ok: false, code, message, remediation? }`.
- `kb.ts` — the only registered subsystem in 0.7.1. `createKbSubsystem(deps)` runs the KB boot pipeline (Corpus replay + CorpusConsumer registration + Orama freshness wait) inside a retry loop (3 attempts at 1s/4s/16s). `buildKbRuntime` and `initializeCapabilityCatalog` are hoisted outside the loop so retries do not duplicate work.

A `SubsystemErrorEnvelope` lifts to HTTP 503 (`kb_initializing` while the lane is still attempting init; `kb_offline` once retries are exhausted) and to the CLI through the standard error envelope with the `remediation` field. New long-init coordinator services should be added as `Subsystem<R>` implementations rather than as bespoke startup branches.

Five invariants enforce the contract: `subsystem-contract-singleton`, `subsystem-error-envelope`, `lifecycle-phase-monotonic`, `abort-signal-threading`, `no-kb-status-accessors`.

Workflow plans persist only semantic slots: slot id, dependencies, provider, instruction, and optional agent. Runtime job ids, step indexes, display labels, and atom keys are derived from the plan plus child job projections.

## Infrastructure

Infrastructure helpers sit below every domain: schemas, small utilities, SSE parsing, cross-process locking, file tailing, child-env construction, and upcaster assembly. Infrastructure resolves canonical paths, build flavor, backend connection info, and expansion paths without becoming a generic domain dumping ground.

## Ownership Matrix

| Area | Owns | Does not own |
| --- | --- | --- |
| `store/` | SQL schema, Journal append/reducer substrate | Product read facade, domain policy |
| `read-model/` | Composed read API | Writes, recovery, domain truth |
| `jobs/` | Job lifecycle and terminal vocabulary | Provider process mechanics |
| `sessions/` | Continuity and scope | Job terminal policy |
| `workflow/` | Plan and slot semantics | Provider/session persistence |
| `discuss/` | Discussion state and shell loop | Coordinator lifecycle |
| `kb/` | Corpus authority and query semantics | Expansion lifecycle ownership |
| `coordinator/` | Live state, startup order, cross-domain assembly | Domain vocabulary |
| `transport/` | Wire parsing and response mapping | Business behavior |
| `cli/` | User command surface and local startup glue | Backend/domain truth |
| `infra/` / `runtime/` | Low-level paths, flavor, I/O ports | Domain concepts |
| `causality/` | Cross-stream event-reference vocabulary | Store/database access |

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
  -> expansion lifecycle service
  -> live launch / host management
  -> provider host manager

coordinator startup (three eras)
  Era I  Kernel:     Journal open, freshness drain, transport listeners bound (lifecycle = kernel-ready)
  Era II Recovery:   jobs / discuss / workflow startup reconcile (lifecycle = running)
  Era III Subsystems: subsystems.initAll() — fire-and-forget; KB subsystem retries on its own

discuss shell
  -> discuss pure core
  -> Journal append via the domain's store-registry

KB runtime
  -> Corpus authority + publication state
  -> RuntimeBinding cells: kb.vector, kb.embedding, kb.fts (each a `RuntimeBinding<Backed<T>>`)
  -> Orama as constructor-time default for kb.vector and kb.fts (kb.embedding has no default — peer expansions bind it)

infra / runtime / causality
  -> lowest common layer reused everywhere
```

## Stable Seams

These are the load-bearing boundaries that must not leak:

- The Runtime interface is the only channel for I/O inside the backend.
- The boot eras are ordered — Era I blocks until kernel-ready, Era II blocks until running, Era III runs fire-and-forget. CLI fail-fast deadlines watch only Eras I and II (`KERNEL_BIND_DEADLINE_MS = 5s`, `KERNEL_READY_DEADLINE_MS = 15s`); subsystems must never extend the kernel path.
- `AbortSignal` is the cancellation primitive throughout startup. Aborting the startup signal with no string reason preserves the `AbortError` discriminator; calling `abort('shutdown')` strips that discriminator and breaks downstream `name === 'AbortError'` checks. Enforced by the `abort-signal-threading` invariant.
- Each domain owner module/contract set is the coordinator-facing surface for its domain; deleted `api.ts` barrels and compatibility shims are not recreated for convenience.
- `store/` is the SQL/Journal substrate; `read-model/CoralStore` composes product reads over domain-owned query modules.
- Domain registries own event schemas, append validators, and reducers; `store/` only runs the composed validators transactionally.
- Expansion lifecycle is coordinator-owned: transport reaches it through `ExpansionLifecycleService`, and KB routing reads the active backend through `kbRuntime.<name>.read()` on each `RuntimeBinding<Backed<T>>` cell.
- KB retrieval projections are rebuildable consumers of the Corpus authority; source import and explicit reindex readiness wait on `ConsumerDriver.waitFreshUntil('corpus', ...)`.
- KB source import/reindex failure facts are recorded by coordinator-owned KB job recording glue as job progress cause events; the KB domain remains Corpus authority only.
- Legacy compatibility shims are not stable seams on the rewrite branch; retired owner paths stay deleted once responsibility moves.
- Hooks never import from `src/`; shared hook logic lives alongside the hooks themselves.
- Runtime ingestion emits canonical domain events; historical body evolution is isolated to domain upcasters.
