# Final Unified Architecture — 2026-04-18

**Status**: Self-contained design specification. No prior documents required.
**Synthesized from**: six pioneer verdicts (A–F), the All-6 meta-pioneer unifier, Pioneer B-v2's reëxamination under event-sourcing, and Pioneer-final's ground-up critique. Cost was explicitly excluded from selection.

**This is a clean-slate rewrite, not a migration.** Existing `~/.coral/` state is assumed destroyed before the new build runs. No migration path exists or is planned. The document describes only the endpoint; transitional constructs, backward-compat fields, and dual-write windows are out of scope.

**Solo-development model, no transition period.** Coral is developed by a single author. No deployment happens until the refactor is complete AND all declared features (including the post-refactor KB slot model) land.
Orama fills `kb.fts` only.
`kb.vector` is empty until an installed vector engine is equipped, and peer embedder engines fill `kb.embedding` independently.
There is no window in which users run "refactor done but feature X pending." The doc therefore does not specify transition-period behavior, partial-feature error paths, or compatibility shims for in-flight development. Every capability the doc declares is available at first deploy.

**Scope of the "discuss is the template" claim**: the word *template* refers to the **persistence pattern** — events → pure reducer → projections → replay — and the **functional-core / imperative-shell** separation. It does NOT claim domain isomorphism. Jobs-specific complexity (workflow composition, shared host pools, cross-namespace release, admission seat control) is modeled by first-class structures (`coordinator/live/*`, `jobs/reconcile/*`, `workflow/`), not by stretching discuss semantics.

---

## 0. Executive Summary

**One sentence**:
Coral is **one coordinator and two authorities** — a Journal (SQLite event database) for process-like state, a Corpus (markdown filesystem) for knowledge content — where process domains are event-sourced with causal-graph fault propagation, knowledge is filesystem-authoritative with content-hash diff sync, and equipment sharpens projections without changing the command surface.

**Product frame**:
Coral is a coding-assistant plugin for Claude Code and Codex. Its purpose is better software work by LLM agents: plan/review workflow, early side-effect and bug discovery, multi-perspective discussion, durable observation of long-running work, provider continuity, and long-term project memory through KB.

**Architectural frame**:
Internally, Coral is a **local coding-agent coordination layer**. The coordinator acts as a local control plane for live decisions, recovery sequencing, provider/session continuity, durable jobs, KB publication, projection freshness, and optional runtime capabilities. This is implementation vocabulary, not product positioning: Coral is not an infrastructure platform for users to operate; it is a plugin whose internal shape prevents prompt glue and ad-hoc shell scripts from owning state they cannot recover.

**Why it exists**:
The current Coral architecture has six well-documented pain points: `src/execution/` is a god-directory, `TerminalResult` mixes concerns, the provider layer has three overlapping paths, persistence is fragmented across six files per job, `src/shared/` is a catch-all, and the CLI always pretends coordination is HTTP even locally. Each is a symptom of the same disease: there is no canonical boundary for *what is truth* and *who owns live state*. This design establishes that boundary — and recognizes that Coral has two distinct truths, not one.

**What changes**:
- **Journal authority** = SQLite `events` table in `~/.coral/data/store/store.db`. Truth for `job`, `session`, `discuss`, `workflow`. Append-only; ordered by `seq`; ACID transactions for multi-event operations.
- **Corpus authority** = markdown filesystem at `~/.coral/kb/`, git-tracked. Truth for `kb` (notes, sources, principles, communities, entity graph). Obsidian-editable; freshness tracked by `contentSeq` / `metadataSeq`.
- **CoralCoordinator** = single writer across both authorities. Sole owner of live state (admission, host pool, subscriptions).
- **Read authorities**:
  - Journal: domain-owned read queries over the SQL substrate, composed by `read-model/CoralStore`.
  - Corpus: direct filesystem reads + KB runtime/query helpers for search, list, and diagnose.
- **Providers** emit canonical event bodies; the coordinator wraps them in envelopes and appends to the Journal in transactions.
- **Workflow** = durable plan declared once on `workflow/<id>` stream; child jobs reference slots by `slotId`.
- **Failures (Journal)** = domain events on their originating stream; job terminals carry `causeRef: {stream, seq}` pointers. No wrapped fault union. The only fault ADT is `JobLifecycleFault` (3 variants).
- **Schema evolution** = per-`type` `bodyVersion` + upcaster chain for Journal events; ordered SQL schema scripts for projection schema; markdown format evolution via frontmatter parser flexibility.
- **Engine layer + Expansion (Zelda UX metaphor)** = engines live under `src/engines/<id>/` with rebuildable data under `~/.coral/data/engines/<id>/`; each engine ships one Expansion lifecycle body. Bundled engines auto-equip as a fallback pass at coordinator boot, while installed engines are user-equipped through `/equip <name>` / `coral-cli expansion equip <name>`.
- Everything else (`status.json`, `result.md` as authority, `WorkflowCheckpoint`, `LaunchState` files, segment rotation, checkpoint files, advisory `writer.lock`, multi-variant `CoralFault` union, unified "everything is an event" thesis) either becomes a projection/export or disappears outright.

Flavor-gated data families use sibling top-level roots: production data under `~/.coral/data/<family>/`, development data under `~/.coral/data-dev/<family>/`. Do not encode flavor into the family name (`data/<family>-dev/`). This applies to the Journal store, Corpus-derived retrieval artifacts, engine runtime artifacts, and any future device-local rebuildable state. The Corpus authority itself remains `~/.coral/kb/` for production and `~/.coral/kb-dev/` for development.

---

## 1. Current Pain (What We're Leaving Behind)

### 1.1 `src/execution/` is a god-directory
One directory carries 6+ concerns: HTTP routing, business orchestration (`service.ts` is 1603 lines), job lifecycle, persistence, recovery, simulation, and discuss/KB glue. The architecture boundary test labels all of this "L1", but it is really 3–4 sub-layers welded together.

### 1.2 `TerminalResult` mixes concerns
Today's shape:
```ts
interface TerminalResult {
  content: string;
  outcome: TerminalOutcome;
  durationMs?: number;
  nonResumable?: boolean;              // session policy leaking into result
  exitCode?: number | null;            // redundant with outcome.provider_exit.code
  warnings?: string[];                 // sidecar
  usage?: UsageSummary;                // sidecar
  workflow?: WorkflowResultMeta;       // "is this a workflow" polymorphism
}
```
Five of eight fields are either redundant, off-topic, or evidence of polymorphism leaking.

### 1.3 Provider layer has three overlapping paths
The same "provider call" is implemented three ways: exec adapter (`claude/adapter.ts`), session driver (`claude/session-driver.ts`), and app-server runner (`providers/app-server/runner.ts`). `runner.ts:66-83` overwrites the driver's outcome — architectural hint that two layers compete for failure-mapping ownership.

### 1.4 Fragmented job files
Durable `result.md` materialization belongs under the exports root. Per `<OS temp>/coral-jobs/<jobId>/`: scratch status/progress/launch/runtime/exit files and live intermediates. `recovery-core.ts` has a 10+ row classifier table because each file-presence combination carries different meaning. The classifier is a symptom of fragmentation.

### 1.5 `src/shared/` is a catch-all
`types.ts` alone is 600+ lines mixing `TerminalResult`, `PersistedStatusRecord`, `WaitStreamEvent`, `JobPhase`, `LaunchState`, across multiple domains. Anything that did not fit elsewhere ended up here.

### 1.6 CLI pretends HTTP is the boundary
Every local CLI invocation routes through `localhost` HTTP with an auth token. HTTP is a *costume* on a local IPC relationship. It is not the architectural seam; coordination is.

---

## 2. Authority Model

**Coral has one coordinator and two authorities.** The coordinator mediates all writes. Each authority is a distinct source of truth, matched to the nature of the state it holds:

| Authority | Substrate | Truth shape | Domains |
|---|---|---|---|
| **Journal** | SQLite `events` table | Append-only event history, ordered by `seq` | `job`, `session`, `discuss`, `workflow` |
| **Corpus** | Markdown filesystem (`~/.coral/kb/`, git-tracked) | Current file contents, versioned by `contentSeq` / `metadataSeq` | `kb` (notes, sources, principles, communities, entity graph) |

This is not an asymmetry or exception — it is Coral's **duality**. Process-like state (something happening, unfolding, terminating) belongs on the Journal. Knowledge-like state (something accumulating, edited, referenced) belongs in the Corpus. Forcing one substrate on both would distort one of the two; naming them separately reveals the structure honestly.

### 2.1 Why a Journal for process-like domains

Jobs, sessions, discussions, workflows are inherently **temporal**: they have a beginning, unfold in ordered steps, and terminate. The ordered event history IS the story; replay reconstructs any projection at any past `seq`. Causal references (`causeRef`) and cross-stream atomicity (§3.3) fall out naturally.

Global ordering is cheap (single SQLite ROWID); cross-log ordering is expensive. One journal gives every event a universally comparable `seq`.

### 2.2 Why a Corpus for knowledge-like domains

KB notes, sources, principles, and communities are **spatial**: they accumulate, get edited, reference each other. What matters is the current state, not the sequence of edits. Obsidian-as-editor reinforces this — users edit markdown files directly; the filesystem IS the truth they see and manipulate.

Event-sourcing KB would force bi-directional sync (external edits → synthetic events → reconstructed markdown), with conflict resolution for Obsidian-vs-coordinator races. The filesystem already offers atomic rename semantics and git provides sync; reinventing these inside a journal adds complexity without elegance gain.

### 2.3 Why one coordinator over two authorities

Single-writer discipline eliminates distributed-consensus machinery. The coordinator:
- Appends events to the Journal (SQLite `BEGIN IMMEDIATE`).
- Mutates the Corpus atomically via `writeFileAtomic` under a mutation lock.
- Owns live state (admission, host pool, subscriptions) that spans both authorities.

The daemon's existence is justified by **live-state ownership**, not by gatekeeping — writes happen to follow. Library-direct readers access either authority without involving the coordinator for read-only operations.

### 2.4 Cross-authority references — none

Journal events do not reference KB entries through a typed cross-authority pointer. The two authorities are independent: process-like state (Journal) does not embed knowledge-like state (Corpus), and the recovery paths of each authority do not consume the other's events as input. KB has its own retry/rebuild surface (`kb_curate_retry_queue`, Corpus rescan, authority baseline rebuild — §6.4, §12.2); job lifecycle records the *fact* of a hosted KB attempt and its failure on the hosting `job/<id>` stream, but the slug/identity of the targeted KB entry is the caller's input and is not durably re-persisted into the Journal envelope. If a future surface (e.g., a "cited evidence" UI, a forensic listener) needs cross-authority references, that surface introduces the shape together with its consumer; this document does not pre-declare a placeholder.

### 2.5 Invariants

1. Exactly one coordinator holds write authority across both Journal and Corpus per Coral installation.
2. Every domain declares **one authoritative substrate**. Journal domains: `events` table. Corpus domain (`kb`): markdown filesystem.
3. Projections and indexes are rebuildable from their domain's authority alone.
4. Exports (e.g., `result.md`) are materialized views, never authority.
5. Recovery per authority:
   - Journal: pure replay over events + reconciliation (append new facts when world disagrees).
   - Corpus: rescan filesystem, diff content hashes, rebuild projections (no history reconstruction).

### 2.6 Ownership Matrix

The rewrite is judged by ownership, not by file count. Every module should answer four questions: what truth it owns, what it may write, what it may compose, and what it must not absorb.

| Area | Owns truth | May write | May read/compose | Must not own |
|---|---|---|---|---|
| `store/` | SQL schema, Journal append/reducer substrate | Store DB primitives only | Domain query modules | Product read facade, domain policy, CLI behavior |
| `read-model/` | No authority; product read composition | Nothing authoritative | Domain read queries + KB read helpers | Writes, recovery, domain truth |
| `jobs/` | Job lifecycle, terminal outcomes, wait/reconcile vocabulary | Job streams/projections through the Journal substrate | Cause refs and domain-owned read queries | Provider process mechanics, transport formatting |
| `sessions/` | Provider continuity, session scope, resumability | Session streams/projections | Provider-owned opaque continuity | Job terminal policy |
| `workflow/` | Durable plan, slots, dependency semantics | Workflow streams/projections | Child jobs through coordinator composition | Provider/session persistence |
| `discuss/` | Discuss events, reducer, shell loop | Discuss streams/projections | Provider execution through injected shell seams | Coordinator lifecycle or transport |
| `kb/` | Corpus markdown authority and KB query semantics | Corpus files under mutation lock | Expansion view through KB runtime port | Expansion slot ownership, coordinator startup |
| `coordinator/` | Live state, startup order, expansion lifecycle, ConsumerDriver, cross-domain assembly | Authority writes through domain shells/substrates | Broad domain owner modules/contracts | Domain vocabulary or wire formatting |
| `transport/` | No truth; carriage only | Nothing authoritative | Coordinator ports and domain contracts | Business behavior, startup, recovery |
| `cli/` | User command surface and local startup/activation glue | No domain truth directly | IPC client and `read-model/CoralStore` | Backend/domain truth, HTTP client (CLI does not dispatch over HTTP — §11.3) |
| `infra/` / `runtime/` | Low-level paths, build flavor, process/env/I/O ports | Files/process/env through ports | No domain imports | Domain concepts |
| `causality/` | Cross-stream event-reference vocabulary | Nothing authoritative | Domain event/fault models | Store/database access |

### 2.7 Work Classification

Jobs are durable process attempts, not an async wrapper for every command. A command becomes a job only when the work is long-running, externally observable, resumable, or recovery-relevant.

| Class | Examples | Surface | Authority relationship |
|---|---|---|---|
| Direct read | `kb search`, `kb read`, `kb memo read`, `jobs`, `discuss watch` | Return result immediately | Reads an authority or projection; creates no Journal fact. Direct KB list/read paths may build transient in-memory views, but do not persist derived artifacts. |
| Direct mutation | KB note write/delete, lightweight metadata edits; project memo write/delete | Return after the small authority write | Corpus writes use the KB mutation lock. Memos are project-scoped scratch artifacts, not Corpus authority. Creates no job unless durable work is needed. |
| Provider/session job | Codex/Claude launches, workflow atoms | Return job id; `wait` observes terminal state | Journal records launch, progress, terminal, and continuity references. |
| Internal coordinator job | `kb source import`, `kb reindex` | Default may wait; `async` returns job id | Journal records the process attempt; Corpus holds the imported/rebuilt knowledge truth. |
| Projection freshness wait | Projection consumer catch-up after Corpus commit | `ConsumerDriver.waitFreshUntil(...)` | Freshness is not authority; failure is reported by the hosting command/job. |

`kb source import` is job-backed because document conversion, staging, Corpus commit, and retrieval readiness can take real time even before installed vector engines are equipped. `kb search`, `kb read`, memo operations, and note writes remain direct because their expected path is immediate and their authority changes are small. Direct KB list/read paths do not lazily repair or rebuild durable text artifacts; explicit `kb reindex` owns that durable work. If a future direct command gains long-running recovery semantics, the job boundary moves for that command only; the whole KB surface does not become job/wait by default.

Direct KB reads are structurally read-only. The query edge opens a `ReadonlyDatabase` through `openReadOnlyStoreDatabase(... readonly: true)` ([`src/kb/read-port.ts:22`](../../src/kb/read-port.ts#L22), [`src/kb/read-port.ts:51`](../../src/kb/read-port.ts#L51)-[`src/kb/read-port.ts:65`](../../src/kb/read-port.ts#L65)); `searchKnowledgeBase` builds its read runtime from that port and loads bundled search capabilities through the read-side expansion host ([`src/kb/queries.ts:31`](../../src/kb/queries.ts#L31)-[`src/kb/queries.ts:38`](../../src/kb/queries.ts#L38), [`src/kb/query-runtime.ts:117`](../../src/kb/query-runtime.ts#L117)-[`src/kb/query-runtime.ts:130`](../../src/kb/query-runtime.ts#L130), [`src/kb/query-runtime.ts:139`](../../src/kb/query-runtime.ts#L139)-[`src/kb/query-runtime.ts:208`](../../src/kb/query-runtime.ts#L208)). A missing Orama snapshot on the read path calls `loadReadOnly()`, reports `fts_index_uninitialized`, and installs only an in-memory fallback; the durable `persist(...)` path is reached from `CorpusConsumer.apply`, not from search ([`src/engines/orama/backend.ts:126`](../../src/engines/orama/backend.ts#L126)-[`src/engines/orama/backend.ts:150`](../../src/engines/orama/backend.ts#L150), [`src/engines/orama/backend.ts:248`](../../src/engines/orama/backend.ts#L248)-[`src/engines/orama/backend.ts:250`](../../src/engines/orama/backend.ts#L250), [`src/engines/orama/snapshot.ts:82`](../../src/engines/orama/snapshot.ts#L82)-[`src/engines/orama/snapshot.ts:97`](../../src/engines/orama/snapshot.ts#L97), [`src/engines/orama/snapshot.ts:99`](../../src/engines/orama/snapshot.ts#L99)-[`src/engines/orama/snapshot.ts:108`](../../src/engines/orama/snapshot.ts#L108)).

Direct reads are not ambient reads. The CLI/bootstrap edge resolves plugin root, build flavor, project root, Corpus markdown root, and KB runtime root before invoking KB/read-model code. KB path helpers and `CoralStore` do not silently choose `cwd`, `HOME`, or the user's default KB; that choice belongs at the local command/composition edge.

**Flavor is a runtime input, not ambient state.** The build flavor (`prod` / `dev`) is resolved once at the bootstrap edge from `CORAL_FLAVOR` or the bundle manifest, then **passed as an argument** to `createRealRuntime(flavor)`. Once constructed, the runtime's `paths.coral` exposes the resolved path families (`store`, `coordinator`, `corpus`, `exports`, `equipment`); domains and coordinator services consume paths through this port. There is no `setBuildFlavor` / `currentBuildFlavor` global, no `getSettledBuildFlavor` accessor, no lazy port construction guarded by `E_FLAVOR_NOT_SETTLED`. A process-wide singleton would force lazy port resolution, which would force defensive `try/catch` fallbacks at every consumer, which would invite parallel access paths (factory + port) that drift apart. Threading flavor as input collapses all of that. Module-level helpers like `composeCoralPaths(flavor, opts?)` and `coordinatorPaths(flavor, env, opts?)` exist for the bootstrap edge that does the resolution; downstream code reads paths from `runtime.paths.coral`, never by recomputing from a global.

### 2.8 Extension Model (Expansion)

Coral ships as a lightweight plugin (~3MB bundle): install gives a fully functional system for its zero-config surface (CLI, jobs, sessions, discuss, workflow, KB FTS). Features that intrinsically need external resources (vector retrieval needs an embedding engine; ANN at scale may need a native addon) are documented in README with a one-line setup per feature. Users opt into heavier capabilities via the `/equip <name>` skill, which routes to `coral-cli expansion equip <name>`.

**UX philosophy — Zelda-style**:
Equipment is **curiosity-driven**, never enforced. A user scanning the CLI notices `/equip` exists, reads what's in the catalog (`/equip --list`, internally `coral-cli expansion list`), and picks something interesting if they want to. Nothing prompts, nags, or requires them to equip. The base tier remains fully functional forever — equipping is a **reward for curiosity**, not a completion requirement.

The metaphor: Link's base sword always works. Finding the bow is exciting because it opens new play, but Link was never broken without it. Coral's base tier always works. Finding a specialized engine is exciting because it sharpens KB search, but KB was never broken without it.

**Two-term split: engine vs. expansion**:
- **Engine** = data/source identity, the noun: source lives under `src/engines/<id>/` and rebuildable local state lives under `~/.coral/data/engines/<id>/`.
- **Expansion** = lifecycle pattern + user verb: the coordinator invokes an `Expansion` body under a scope, and users still run `coral-cli expansion equip <name>`.

One engine ships one Expansion. The terms describe distinct facets, not synonyms: engine names ownership of source and data; expansion names how that engine participates in runtime binding, equip/unequip, recovery, and onboarding.

**Two-tier runtime**:
- **Bundled tier** — the default after plugin install. Bundled engines auto-equip as a fallback pass at coordinator boot after installed-engine recovery, filling only empty bindings.
- **Installed tier** — user-equipped engines. Same commands, sharper or additional implementations on specific query paths. Tier controls lifecycle (when equipped, who can unequip), not invocation mechanism.

**Expansion principles**:
1. An Expansion **replaces a specific projection backend**, it does not add new commands. The CLI surface is identical in both tiers.
2. An Expansion **never writes an authority**. Journal events and Corpus markdown remain truth; an Expansion maintains additional or replacement projections.
3. Every equipped projection is **rebuildable from the authority it serves**. Journal-backed Expansions replay events; Corpus-backed Expansions diff Corpus snapshots. Equipping = install + subscribe + build local projection state.
4. **`coral-cli expansion unequip <name>`** (surfaced to users as `/equip uninstall <name>`) returns the replaced path to the base backend without data loss and without command availability changes.
5. An Expansion is loaded via **dynamic import** — the heavy dependency enters the process only after `/equip` completes.
6. An Expansion is **never prompted** — the base tier must never display "equip X to unlock this" suggestions. Discovery is through `/equip --list` (internally `coral-cli expansion list`) or documentation, not through nagging.

Expansion cannot receive cursor-only Journal consumer registrations through its public host. The `ExpansionConsumerRegistration` type admits only journal apply, corpus apply, and stateless lifecycle registrations, and omits host-derived `registrationKind` ([`src/expansion/contract.ts:15`](../../src/expansion/contract.ts#L15)-[`src/expansion/contract.ts:22`](../../src/expansion/contract.ts#L22)); `ExpansionHost.registerConsumer` accepts only that narrowed type ([`src/expansion/contract.ts:24`](../../src/expansion/contract.ts#L24)-[`src/expansion/contract.ts:32`](../../src/expansion/contract.ts#L32)), while the host derives the lifecycle kind before forwarding to `ConsumerDriver.register` ([`src/expansion/host.ts:58`](../../src/expansion/host.ts#L58)-[`src/expansion/host.ts:63`](../../src/expansion/host.ts#L63), [`src/expansion/host.ts:109`](../../src/expansion/host.ts#L109)-[`src/expansion/host.ts:120`](../../src/expansion/host.ts#L120)). Cursor-only Journal consumers remain coordinator-startup-owned.

**Installed engine pattern**:
- An installed engine may provide native/vector indexing, provider-backed embedding, or another projection implementation.
- It fills one or more KB bindings under its Expansion scope; if a dependency binding is empty, equip fails structurally before any bind.
- FTS and vector retrieval are peer bindings. Hybrid RRF uses whichever vector binding is active; if the vector path is unbound, KB search falls back to FTS-only behavior through structured `binding_empty` handling.
- Onboarding for dependencies lives in `skills/equip/SKILL.md` and CLI-tier declarative steps, not inside runtime Expansion bodies.

The `/equip` skill now lives at `skills/equip/SKILL.md` only. The deleted helper files `skills/equip/install.mjs`, `skills/equip/coordinator-client.mjs`, `skills/equip/equipment-paths.mjs`, and `skills/equip/fs-lock.mjs` are replaced by the `coral-cli expansion list|equip|unequip|update|info` surface plus pure install/onboarding modules under `src/cli/expansion/` and the runtime expansion contract under `src/expansion/` (see §2.8a). The post-refactor catalog uses engine/tool-named entries rather than capability-named entries, matching the Zelda equipment metaphor.

Installed expansion activation is tracked in an explicit durable expansion registry keyed by engine/expansion id, not by implicit boot-time registration. In the clean-slate rewrite, `001_initial.sql` includes `expansion_state` (rows: `{id, version, installed_at}`) for installed engines only. The KB domain declares `kb.vector`, `kb.fts`, and `kb.embedding` as `RuntimeBinding<Backed<...>>` cells with no initial binding values. Orama is a bundled engine that auto-equips at coordinator boot via the fallback pass, after installed-engine recovery, filling only empty slots under its Expansion scope. Embedders are peer engines discovered through `BUNDLED_ENGINES` entries whose `EngineManifest.fills?.includes('kb.embedding')`. Expansion bodies call `host.bind(binding, backed)` under their own scope; structural single-occupancy enforces "at most one active Expansion per binding" (#43) inside the primitive. Native addons enter the process only via user activation routed through `coral-cli expansion equip <name>`.

**Engine paths are per-name closures, not per-name standalone functions.** `runtime.paths.coral.engine` exposes `dataDir(name)` and `installLockPath(name)` — closures bound to the resolved `EnginePaths` family. Lifecycle, install/onboarding, and retrieval backends call these closures with the engine name and never recompute paths from `coralRoot()` or compose the path family themselves. This keeps path-shape decisions (e.g., "data lives under `data/engines/<name>/`") in one place — the `enginePaths` composer — and prevents per-call sites from quietly diverging on naming or layout. Engine-specific addon paths are computed inside the owning engine tree, not by generic infra.

**Projection freshness model**:
Consumers subscribe to an **authority** (Journal or Corpus, §2). Each authority has its own monotonic version:
- Journal authority → version is `events.seq`. Two consumer kinds with distinct freshness mechanics:
  - **Base journal projection consumers** (`projection_jobs`, `projection_sessions`, `projection_discuss`, `projection_workflows`) are **cursor-only**: their projection rows are already written by the commit-time reducer inside the same `BEGIN IMMEDIATE` that appends the events (§3.3, §12.1). `notify(authority, version)` advances their durable cursor in `consumer_cursors` directly — no `apply()` body runs in production. They expose freshness through the same `waitFreshUntil` primitive but never re-read the event range.
  - **Expansion-tier journal consumers** (added by an installed engine that subscribes to journal events for its own derived state) use range-based replay through `apply(ctx: { upToSeq, signal })`.
- Corpus authority → version is `contentSeq` (or `metadataSeq` for metadata-only changes). Corpus consumers use snapshot-based content-hash diff through `apply(ctx: { contentSeq, metadataSeq, signal })`.

`ConsumerDriver` owns both flows. For both kinds it receives `notify(authority, version)` signals after an authoritative write and exposes `waitFreshUntil(authority, version, consumerId)` as a condition-variable wake (not polling). For cursor-only registrations the driver advances the cursor directly and resolves waiters; for apply-kind registrations (expansion-tier journal consumers and corpus consumers) the driver drains in a single-in-flight microtask (backpressure-safe) and persists the cursor only after successful `apply()` completes. Journal waiters target `events.seq`; Corpus waiters target `contentSeq` / `metadataSeq`. `coral-cli expansion list` is status observation, not the freshness primitive. Apply-kind consumer `apply()` must be **idempotent** (§16 #44) — a crash between apply and cursor persistence causes the same range to be re-applied on startup; consumer implementations must tolerate this (`upsert` semantics, not `insert`). Cursor-only base journal consumers do not face this hazard because no `apply()` runs outside the commit transaction.

For coordinator-mediated KB writes: the Corpus mutation lock wraps only authoritative markdown writes, Corpus version bumps, and lightweight Corpus metadata/index state. Retrieval projections are CorpusConsumers: bundled and installed engine consumers receive the post-commit notify and drain asynchronously.

This decouples projection latency from authoritative write latency: a slow or failing retrieval projection never blocks the Corpus commit. A caller that needs strict retrieval readiness waits after commit via `waitFreshUntil`; if the wait fails, the Corpus commit remains durable and the running job reports the readiness failure. Failed drains retain the last-successful cursor for retry on next `notify` or startup. Fault isolation is structural.

### 2.8a Expansion architecture (target model, rewritten 2026-04-28)

> **Status**: This section describes the post-commit-6 target for the KB engine uniform-binding plan. It intentionally lands in commit 0 before code changes. Reviewers verifying intermediate commits (1-5) should reference `/home/ing/.coral/projects/kangig94-coral/plans/kb-engine-uniform-binding.md`, not this section, because this section describes the final target state.

The old binary "default owner + override" slot model is gone. It encoded two mechanisms for the same semantic operation: one backend supplied as a construction-time initializer and another backend supplied by user equip. The final model uses one mechanism for every binding fill.

**Diagnosis**: the question is not "which of several competing implementations?" (a multiplexer) but "which implementation is currently bound for this name?" (a single mutable cell). A multiplexer with one decision is a reference cell with extra steps. The original §2.8a draft's `Slot`/`SlotProvider`/`SlotRegistry` apparatus was a multiplexer addressing a problem Coral does not have.

The unified design uses three load-bearing primitives:

1. **`RuntimeBinding<T>`** — a domain-owned mutable cell with structural single-occupancy and no initial value. Replaces the original slot apparatus.
2. **`EngineManifest` + `Expansion = (host) => void | Promise<void>`** — the manifest names an engine, its tier, and the bindings it fills; the Expansion body is the one lifecycle mechanism used by bundled and installed engines alike.
3. **`Backed<T> = { read(): T, consumer: Consumer }`** — capability + freshness, exposed by every backend. The cell holds `Backed<T>`, not raw `T`. This lets routing read `binding.read().read(...)` synchronously while coordinator readiness reads `binding.read().consumer.id` — same cell, two clients, two faces.

**Term split**: engine and expansion are not synonyms. **Engine** is the data/source identity: `src/engines/<id>/` for source and `~/.coral/data/engines/<id>/` for rebuildable local state. **Expansion** is the lifecycle pattern and user verb: an engine ships an Expansion body, and users invoke `coral-cli expansion equip <name>` for installed engines. One engine ships one Expansion; the terms describe distinct facets of the same feature.

#### Core types

```ts
// runtime/binding.ts — the cell.
interface RuntimeBinding<T> {
  read(): T;                                          // returns bound value; throws `binding_empty` if unbound
  bind(value: T, scope: Disposable, holder: string): void; // single-occupancy; throws CoralSetupError('binding_occupied') if already bound
  readonly heldBy?: string;
}
function createRuntimeBinding<T>(name: string): RuntimeBinding<T>;

// src/expansion/contract.ts — every expansion.
type Expansion = (host: ExpansionHost) => void | Promise<void>;

interface EngineManifest {
  id: string;
  version: string;
  specifier: string;
  tier: 'bundled' | 'installed';
  description: string;
  fills?: readonly string[];
  installer?: EngineInstaller;
  onboarding?: readonly OnboardingStep[];
}

interface ExpansionHost {
  // Generic over T (not constrained to Backed<T>) — Backed<T> is a KB-specific
  // composition (capability + consumer freshness), and tying host.bind to it
  // would block future domains that own bindings with a different shape.
  // Today's KB bindings happen to be RuntimeBinding<Backed<T>>; the host
  // contract stays one layer above that choice.
  bind<T>(binding: RuntimeBinding<T>, value: T): void;
  require<T>(binding: RuntimeBinding<T>): T;          // throws CoralSetupError if unbound
  registerConsumer(reg: ExpansionConsumerRegistration, scope: Disposable): ConsumerHandle;
  registerArtifactPort(port: EngineArtifactPort, options: { targetConsumerHandles: ConsumerHandle[] }, scope: Disposable): EngineArtifactRegistration;
  runtime: Runtime;
  kb: KbEngineRuntime;                                // engine-facing: typed ports, no raw DB or authority writers/readers
  scope: Disposable;                                  // the expansion's own dispose token
  id: string;
}

// kb/contract.ts — capability + freshness.
interface Backed<T> {
  read(): T;                                          // synchronous capability handle
  consumer: Consumer;                                 // CorpusConsumer | JournalConsumer (§9)
}

// kb/runtime.ts — KB declares which bindings it owns.
interface KbRuntime {
  readonly vector:    RuntimeBinding<Backed<VectorRetrieval>>;
  readonly embedding: RuntimeBinding<Backed<EmbeddingService>>;
  readonly fts:       RuntimeBinding<Backed<FtsRetrieval>>;
}
```

The engine-facing `host.kb` value is a narrowed `KbEngineRuntime`, not the domain-owned `KbRuntime`: `createExpansionHost` constructs it from typed projection/cursor ports ([`src/expansion/host.ts:65`](../../src/expansion/host.ts#L65)-[`src/expansion/host.ts:78`](../../src/expansion/host.ts#L78)). Engines therefore see runtime bindings, projection artifact storage, `corpusProjectionReader`, `journalReader`, and `corpusStateReader`; they do not receive the raw store DB or KB authority mutation/read/write surface.

Load-bearing invariants (also tracked in §16 #43, #43a, #43b, #43c, #43d):

- **Routing reads `binding.read().read(...)`** — one indirection. No literal union, no priority compare, no readiness poll at the routing layer.
- **Bundled engines are Expansions that auto-equip as a fallback pass at coordinator boot.** The pass runs after installed-engine recovery and fills only empty slots. Every binding is filled by an Expansion under a scope; no binding is created with an initial value (#43a).
- **Expansion bodies call `host.bind(binding, backed)`** under their own scope; `scope.dispose()` is the only un-bind path.
- **Single-occupancy is structural**: `RuntimeBinding.bind` throws `CoralSetupError('binding_occupied', { heldBy })` if already held. Invariant #43 is enforced inside the primitive, not by lifecycle bookkeeping.
- **Readiness is a comparison**: `backed.consumer.cursor ≥ runtime.authorities.<kind>.version`. No `isReady()` / `waitForReady()` on the `Backed<T>` contract. The only readiness primitive is `waitFreshUntil(authority, version, consumerId)` from §9.4 (#43c).
- **Capability deps via `host.require(binding)`** — inline at expansion top, throws `CoralSetupError` before any `bind`.
- **`kb.embedding` is a peer-category slot.** All three KB slots (`kb.fts`, `kb.vector`, `kb.embedding`) have no initial binding values. Embedders are bundled or installed engines like any other, discovered structurally through `EngineManifest.fills?.includes('kb.embedding')`.
- **Adding a backend** = one new engine Expansion module + one manifest entry. Coordinator/router/lifecycle code change: zero unless the engine creates a new domain binding.

#### Ownership

| Concern | Owner |
|---|---|
| `RuntimeBinding<T>` primitive | `runtime/binding.ts` |
| `Expansion`, `ExpansionHost`, `EngineManifest` types and impl | `src/expansion/contract.ts` + `src/expansion/host.ts` |
| Bundled-engine manifest registry | `src/expansion/bundled.ts` |
| `Backed<T>` shape; KB capability interfaces | `kb/contract.ts` |
| Domain binding declarations | `<domain>/runtime.ts` (e.g., `kb/runtime.ts` declares `vector`/`embedding`/`fts`) |
| Orama bundled engine | `src/engines/orama/expansion.ts` |
| Needle installed engine | `src/engines/needle/expansion.ts` |
| Coordinator expansion lifecycle (equip = invoke Expansion + persist installed row; unequip = dispose scope + delete row; bundled fallback = invoke without state row) | `coordinator/expansion/lifecycle.ts` |
| Durable expansion state — keyed by installed engine id | `coordinator/expansion/state.ts` (rows: `{id, version, installed_at}`) |
| Install/uninstall dispatch | `cli/expansion/install.ts` (generic dispatcher; engine-specific installers live under `src/engines/<id>/`) |
| Onboarding flows | `cli/expansion/onboarding.ts` (cli tier, declarative manifest steps, not runtime) |

Deleted: `coordinator/equipment/slots.ts`, the old `expansion/catalog.ts`, and the old four-method contract shape — the original slot registry apparatus no longer exists.

Retired (drift items never to exist): `coordinator/discovery-api.ts`, `expansion/paths.ts`.

#### Migration order (each commit independently green)

0. **Doc vocabulary correction.** Rewrite §0/§2.7/§2.8/§2.8a body+migration/§10/§16 #43a/#43d to describe the post-commit-6 target. Reviewers of intermediate commits (1-5) reference the plan file, not this section, since the doc lands ahead of code.
1. **Path layer rename + ChunkSeed direction reversal.** Rename `infra/path/expansion.ts` → `infra/path/engine.ts`; `runtime.paths.coral.expansion` → `runtime.paths.coral.engine`; `ExpansionPaths.expansionRoot` → `EnginePaths.engineRoot`; data path `data/expansion/<name>/` → `data/engines/<name>/`. Introduce `src/kb/chunking.ts` defining `ChunkSeed`; needle's `ChunkRecord = ChunkSeed & { specId, vector }` reverses the import direction.
2. **Engine relocation.** Move `src/kb/search/{orama,needle}/` and `src/kb/embedding/{gemini,onnx}/` to `src/engines/{orama,needle,gemini,onnx}/`. `src/kb/embedding/vector.ts` → `src/kb/embedding-vector.ts`. `src/kb/embedding/fetch.ts` → `src/infra/http-retry.ts`. Test mirror-move. Engine-id helpers in `src/kb/paths.ts` relocate to engine-internal `paths.ts`.
3. **Manifest + dispatcher + onboarding rewrite.** `EngineManifest` (replaces `BundledExpansion`) with `tier: 'bundled' | 'installed'`, `fills?: readonly string[]`, `installer?: EngineInstaller`, `onboarding?: readonly OnboardingStep[]`. `BUNDLED_EXPANSIONS` → `BUNDLED_ENGINES`. Generic `cli/expansion/install.ts` (≤100 lines, call-time manifest lookup); engine-internal `src/engines/needle/install.ts`. Generic `cli/expansion/onboarding.ts` (≤100 lines, declarative `OnboardingStep[]` walker). Existing `OnboardingStep` at `coordinator/expansion/rpc.ts` renamed to `OnboardingChoice`. `infra/install-helpers.ts` lifted from `cli/expansion/install-support.ts`.
4. **Orama as Expansion + KbRuntime engine-blind + bundled fallback pass** (squashed per Clean-Slate Ownership). `RuntimeBinding<T>` drops `defaultValue` parameter. `KbRuntime` drops all Orama-named state. `src/engines/orama/expansion.ts` (NEW) constructs `OramaBaseProjection` + `OramaSnapshotStore` Expansion-internally and binds ONLY `kb.fts`.
   The `kb.vector` binding has no bundled fill; queries fail with `binding_empty` until needle/kb_scann is equipped. `FtsRetrieval` exposes `{search, tokenize, warnings}`; `VectorRetrieval` uses the symmetric `search(...)` verb. `applyBundledFallback()` returns `{equipped, failed}` map. `ExpansionLifecycleService.scopes` becomes `Map<string, Disposable[]>`. Host derives `registrationKind` from `(manifest.tier, registration.apply)` triple — preserving `'stateless'` for embedders. `readBinding` retained (RPC chain preserved); only `KB_BINDING_BY_SLOT`/`bindingOf`/`BundledExpansionSlot` removed.
5. **KB-init failure wraps bundled-equip failure.** `recoverOnBoot` aggregates `applyBundledFallback` failures and throws; existing try/catch at `coordinator/lifecycle.ts:410-414` routes to `runtimeState.setKbInitError(...)`. Daemon comes up with `subsystems.kb = 'unavailable'`; KB IPC ops return `kb_unavailable`; non-KB ops continue.
6. **Architecture-boundary invariants + cleanup.** New invariant tests forbid imports from `src/engines/**` outside two wiring points (`src/expansion/bundled.ts`, `src/coordinator/expansion/lifecycle.ts`); forbid engine-id literals in `src/kb/**` and `src/coordinator/**`; forbid `Backed<T>` caching outside `KbRuntime`. `tests/helpers/ts-import-scanner.ts` extended with sibling `getSubpathModuleSpecifier` for `#src/...` specifiers. `DOMAIN_ROOTS` extended with `src/engines/`. `tests/invariants/engine-acceptance.test.ts` (NEW) verifies the kb_scann gate. Phase 2 namespace `~/.coral/expansions/<name>/` reserved via comment in `infra/path/engine.ts`.

#### Forward compatibility — Phase 2 (third-party loading)

This contract is third-party-ready. Loading mechanism is orthogonal:

- **Phase 1 (this round)**: bundled manifest entries live in `BUNDLED_ENGINES: readonly EngineManifest[]` in `src/expansion/bundled.ts`. Entries name engine source specifiers and declare `fills`.
- **Phase 2 (later)**: `loader.ts` scans `~/.coral/expansions/<name>/package.json` for a `"coral": { "expansion": "./dist/expansion.js" }` field; dynamic-imports each, calls the default export with the same `ExpansionHost`. No contract change; bundled and filesystem engines get the same Expansion lifecycle.

The third-party test: bundled and filesystem engines get **equal treatment** — same `Expansion` type, same `ExpansionHost`, same lifecycle. Sandboxing is a property of *how* the loader invokes `expansion(host)` (worker thread / vm context), not of the contract.

#### Resolutions to original-draft open questions

1. **Multi-slot expansion.** An `Expansion` calls `host.bind` N times on one scope; one scope releases all bindings. No `slots: string[]` field, no `Expansion.bindings[]` array. Single-binding is the degenerate case of N=1.
2. **Capability negotiation.** `host.require(binding)` inline at expansion top, throws `CoralSetupError` before any `bind`. Peer binding dependencies are handled by declarative onboarding plus empty bindings, not by a runtime `requires` field.
3. **Test override.** Tests are expansions. `loadExpansions([fakeExpansion])` binds the fake; `scope.dispose()` releases it. No priority arithmetic, no `replaceForTest`, no built-in default path.
4. **Phase 2 manifest format.** `package.json` with `"coral": { "expansion": "./dist/expansion.js" }`. The expansion module's default export is `Expansion`. Reuses Node's existing manifest with no Coral-specific dialect.
5. **Phase 2 security model.** Out of contract; loader-level concern. The `ExpansionHost`'s `bind`/`require` already pass capabilities structurally — an expansion can only touch bindings it imports — so future sandboxing wraps `expansion(host)` invocation without changing the contract.
6. **Onboarding ownership.** Lives in `cli/expansion/onboarding.ts`, keyed by engine id. NOT on the runtime Expansion function. Onboarding runs once before any installed Expansion invocation.
7. **Routing freshness vs. authority writes.** Non-issue. Router calls `binding.read()` — one indirection. Readiness is computed only when a caller invokes `waitFreshUntil`. Per-request cost: zero readiness checks.

#### Synthesis history

The original 2026-04-27 draft proposed a `Slot`/`SlotProvider`/`ExpansionContract` model with `priority` and explicit `isReady`/`waitForReady` — eight open questions remained. On 2026-04-27, five parallel pioneers (A-E) explored alternative framings; a meta-pioneer synthesized them. The uniform-binding plan refines that synthesis by removing initial binding values entirely and making bundled engines participate through the same Expansion body shape as installed engines.

Synthesis-level move that remains load-bearing: the binding holds `Backed<T>`, not raw `T`. This composition lets routing and freshness coordination see two faces of the same cell: the router reads the capability, while `waitFreshUntil` reads the consumer id.

---

## 3. Journal Substrate (SQLite)

The Journal authority (§2.1) is backed by a **single transactional event database**. Path depends on build flavor (hook isolation requires flavor-gated paths):
- prod: `~/.coral/data/store/store.db`
- dev: `~/.coral/data-dev/store/store.db`

This is the general flavor layout rule for device-local rebuildable data: `data/<family>/` in prod and `data-dev/<family>/` in dev, never `data/<family>-dev/`.

SQLite in WAL mode is the reference implementation: it provides append-only write semantics, ACID transactions across multiple events, concurrent readers, and a single-writer discipline via `BEGIN IMMEDIATE` — all properties the Journal requires, without reinventing them.

Journal authority is power-loss durable. The store opens with `synchronous = FULL`; commits return only after fsync. Process crash and OS crash both preserve every committed event. Bulk-rebuild paths (regression-test replay) may opt into `synchronous = NORMAL` since they rebuild from a source of truth that survives.

The Corpus authority (§2.2, §6.4) uses the filesystem directly and is documented separately. This section covers only the Journal substrate.

### 3.1 Schema

```sql
-- The journal: append-only event log.
-- `seq` is coordinator-reserved by `MAX(seq)+1..N` under BEGIN IMMEDIATE
-- (see §3.3); AUTOINCREMENT is intentionally omitted because it would maintain
-- a parallel counter in `sqlite_sequence` that the explicit-INSERT path
-- bypasses, creating a competing source of truth that can drift from MAX(seq).
CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY,                -- coordinator-reserved (see §3.3)
  ts             TEXT    NOT NULL,                   -- ISO 8601 (informational; see §4.1)
  type           TEXT    NOT NULL,                   -- e.g. 'job.terminal.recorded'
  stream_kind    TEXT    NOT NULL,                   -- 'job'|'session'|'discuss'|'workflow' (four Journal kinds only; see §5)
  stream_id      TEXT    NOT NULL,
  namespace      TEXT,
  project        TEXT,
  correlation_id TEXT,
  causation_seq  INTEGER,                            -- FK to events(seq), loose
  refs           TEXT,                               -- JSON: { jobId?, sessionId?, parentJobId?, ... }
  body_version   INTEGER NOT NULL DEFAULT 1,         -- per-type schema version
  body           BLOB    NOT NULL                    -- JSON payload
);
CREATE INDEX IF NOT EXISTS events_stream ON events(stream_kind, stream_id, seq);
CREATE INDEX IF NOT EXISTS events_type   ON events(type, seq);
CREATE INDEX IF NOT EXISTS events_refs_parent ON events(json_extract(refs, '$.parentJobId'), seq);

-- Projection tables (read models). Rebuildable from events.
-- projection_jobs materializes stable-at-launch identity fields plus lifecycle
-- summary so list/filter queries are single-query operations. Event bodies stay
-- authoritative; the projection is derived via reducer dispatch + replay identity.
CREATE TABLE IF NOT EXISTS projection_jobs (
  job_id                  TEXT PRIMARY KEY,
  phase                   TEXT NOT NULL,
  terminal                TEXT,            -- JSON { outcome, durationMs } or NULL
  diagnostics             TEXT,
  session_id              TEXT,            -- NULL for coordinator-owned internal KB jobs
  provider                TEXT,            -- NULL for coordinator-owned internal KB jobs
  project_root            TEXT NOT NULL,
  backend_namespace       TEXT NOT NULL,
  bundle_hash             TEXT,
  job_kind                TEXT NOT NULL,
  parent_workflow_job_id  TEXT,            -- workflow-slot parent (jobs launched by a workflow plan)
  workflow_slot           TEXT,            -- slotId on parent's plan
  created_at              TEXT NOT NULL,
  last_seq                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projection_jobs_phase_namespace ON projection_jobs(phase, backend_namespace);
CREATE INDEX IF NOT EXISTS projection_jobs_session ON projection_jobs(session_id);
CREATE INDEX IF NOT EXISTS projection_jobs_parent ON projection_jobs(parent_workflow_job_id);

CREATE TABLE IF NOT EXISTS projection_sessions (
  session_id       TEXT PRIMARY KEY,
  controller       TEXT NOT NULL,
  provider         TEXT NOT NULL,
  resumable        INTEGER NOT NULL,
  conversation_ref TEXT,
  scope_key        TEXT NOT NULL,
  entry            TEXT NOT NULL,       -- JSON SessionEntry projection body
  last_seq         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_discuss (
  discuss_id TEXT PRIMARY KEY,
  state      TEXT NOT NULL,        -- JSON (reducer output)
  last_seq   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_workflows (
  workflow_id TEXT PRIMARY KEY,
  plan        TEXT NOT NULL,       -- JSON: { slots: [{slotId, provider, instruction, agent?, dependencies}] }
  last_seq    INTEGER NOT NULL
);

-- Metadata
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Rows: schema_version, journal_version, coordinator_id, created_ts

-- Corpus version state (KB authority — see §6.4).
-- Single row. contentSeq/metadataSeq are monotonic counters on the Corpus;
-- snapshot_id and the manifest hashes pin the most recent atomic snapshot
-- swap so consumers can detect snapshot identity changes that happen at the
-- same seq (e.g., compaction without content change).
CREATE TABLE IF NOT EXISTS kb_corpus_state (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  snapshot_id            TEXT,
  content_seq            INTEGER NOT NULL,
  metadata_seq           INTEGER NOT NULL,
  content_manifest_hash  TEXT,
  metadata_manifest_hash TEXT,
  last_mutation          TEXT    NOT NULL    -- ISO 8601
);

CREATE TABLE IF NOT EXISTS kb_corpus_authority_baseline (
  entry_id      TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  metadata_hash TEXT NOT NULL
);

-- Consumer cursors (async push model; see §2.8).
-- Cursor interpretation depends on the consumer's authority:
-- - Journal consumers: `cursor` is the last applied events.seq.
-- - Corpus consumers: snapshot_id + the seq/hash columns describe the last
--   applied snapshot. `corpus_interest` declares which lane the consumer
--   subscribes to ('content' for vector/FTS that depend on body text,
--   'metadata' for tag-only changes, 'both' otherwise) so a metadata-only
--   bump never wakes a content consumer. `lane` is a hint used to short-
--   circuit fan-out when a publication carries a single lane.
CREATE TABLE IF NOT EXISTS consumer_cursors (
  consumer_id            TEXT PRIMARY KEY,      -- 'orama-base', 'needle-vector'
  authority              TEXT NOT NULL,         -- 'journal' | 'corpus'
  lane                   TEXT,                  -- NULL for journal and 'both' corpus consumers
  corpus_interest        TEXT,                  -- 'content' | 'metadata' | 'both' for corpus; NULL for journal
  cursor                 INTEGER,               -- journal only (events.seq)
  snapshot_id            TEXT,                  -- corpus only
  content_seq            INTEGER,               -- corpus only
  metadata_seq           INTEGER,               -- corpus only
  content_manifest_hash  TEXT,                  -- corpus only
  metadata_manifest_hash TEXT,                  -- corpus only
  registered_at          TEXT    NOT NULL,      -- ISO 8601 of most recent registration
  registration_kind      TEXT    NOT NULL DEFAULT 'base'  -- 'base' | 'expansion'
);

-- Expansion activation registry (durable expansion ownership; see §2.8a).
-- One row per currently-equipped expansion, keyed by expansion id. Row existence
-- is the only durable transition: pre-write crash leaves no row (re-equip on
-- boot is a no-op); post-write crash leaves a row that the lifecycle replays
-- by re-invoking the expansion during boot recovery. There is no `state` column
-- because lifecycle transitions happen in memory and are not persisted —
-- structural single-occupancy on `RuntimeBinding<T>` (invariant #43) makes a
-- state machine unnecessary.
CREATE TABLE IF NOT EXISTS expansion_state (
  id                 TEXT PRIMARY KEY,             -- expansion id (e.g., 'needle')
  version            TEXT NOT NULL,                -- expansion version captured at install time
  installed_at       TEXT NOT NULL                 -- ISO 8601 of most recent successful install
);

-- Curate scheduler bookkeeping (replaces today's curate-state.json).
-- Scalar scheduler state lives here; the active in-flight claim moves to
-- kb_curate_active_claim so the scheduler row stays single-row idempotent.
-- Two `processed_through_*` columns store the cursor as discrete fields
-- rather than opaque JSON so SQL can compare/order them.
-- `last_attempted_through_*` lets the scheduler back off without losing
-- the last successfully-processed checkpoint. The two
-- consecutive_*_failures counters drive exponential backoff and are capped
-- at MAX_CONSECUTIVE_FAILURES (10): on the cap-trip transaction the
-- corresponding `*_lane_disabled_at` column records an ISO-8601 timestamp
-- and the scheduler stops scheduling that lane until an operator clears
-- the state via `clearCurateRetryState` (or a fresh-suffix claim resets
-- the claim lane naturally). The boolean "disabled?" is derivable from
-- the counter; the timestamp is the operator-visible diagnostic.
-- The two community_*_topology_hash columns let curate skip community
-- detection / summary regeneration when the underlying graph hasn't
-- structurally changed (cheaper than always re-running).
CREATE TABLE IF NOT EXISTS kb_curate_scheduler (
  id                                   INTEGER PRIMARY KEY CHECK (id = 1),
  processed_through_seq                INTEGER,
  processed_through_entry_id           TEXT,
  processed_through_entry_kind         TEXT,
  discovery_high_seq                   INTEGER,
  discovery_offset                     INTEGER,
  last_run_day                         TEXT,
  last_attempted_through_seq           INTEGER,
  last_attempted_through_entry_id      TEXT,
  last_attempted_through_entry_kind    TEXT,
  retry_not_before                     TEXT,
  consecutive_claim_failures           INTEGER NOT NULL DEFAULT 0,
  consecutive_community_batch_failures INTEGER NOT NULL DEFAULT 0,
  claim_lane_disabled_at               TEXT,                                 -- ISO-8601 of cap-trip; NULL while healthy
  community_batch_lane_disabled_at     TEXT,                                 -- ISO-8601 of cap-trip; NULL while healthy
  community_topology_hash              TEXT,
  community_summary_topology_hash      TEXT,
  initialized                          INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1))
);

-- Active curate claim: the in-flight checkpoint a curate worker is
-- currently processing. Singleton; coordinator single-writer ensures only
-- one claim exists at a time.
CREATE TABLE IF NOT EXISTS kb_curate_active_claim (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  through_seq        INTEGER NOT NULL CHECK (through_seq > 0),
  through_entry_id   TEXT    NOT NULL,
  through_entry_kind TEXT    NOT NULL,
  started_at         TEXT    NOT NULL
);

-- Per-community input fingerprints. Lets summary regeneration skip
-- communities whose member-set fingerprint is unchanged.
CREATE TABLE IF NOT EXISTS kb_curate_community_summary_input_fingerprints (
  community_slug TEXT PRIMARY KEY,
  fingerprint    TEXT NOT NULL
);

-- Curate retry queue (pendingRepair[] in today's JSON state).
-- Each entry has its own retry schedule; indexed by retry_not_before for
-- O(log n) "who is due now" scans. The classification fields
-- (canonical_incident, signals_json, repair_hint) feed the corpus repair
-- pipeline (§6.4.1) so retry attempts know what to try.
CREATE TABLE IF NOT EXISTS kb_curate_retry_queue (
  entry_id              TEXT PRIMARY KEY,
  entry_seq             INTEGER,
  reason                TEXT NOT NULL,
  observed_at           TEXT NOT NULL,
  observed_content_hash TEXT,
  locus                 TEXT,
  canonical_incident    TEXT,
  signals_json          TEXT,
  repair_hint           TEXT,
  retry_not_before      TEXT NOT NULL,
  retry_count           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS kb_curate_retry_by_time ON kb_curate_retry_queue(retry_not_before);

-- Curate discovery backlog: principle-statement candidates queued for the
-- next curate pass to attach to source notes. Two tables because each
-- backlog entry can reference many source notes.
CREATE TABLE IF NOT EXISTS kb_curate_discovery_backlog (
  entry_id        TEXT PRIMARY KEY,
  principle_slug  TEXT NOT NULL,
  statement       TEXT NOT NULL,
  queued_at       TEXT NOT NULL,
  reason          TEXT,
  UNIQUE(principle_slug, statement)
);

CREATE TABLE IF NOT EXISTS kb_curate_discovery_backlog_notes (
  backlog_entry_id TEXT NOT NULL REFERENCES kb_curate_discovery_backlog(entry_id) ON DELETE CASCADE,
  note_id          TEXT NOT NULL,
  PRIMARY KEY(backlog_entry_id, note_id)
);
```

### 3.2 Storage tiers collapse into one

Because projections live in the same database as events, the three-tier model (journal / checkpoint / projections) collapses to **one substrate with two shapes**:

- **Events table** — authoritative append-only truth.
- **Projection tables** — rebuildable read models, maintained incrementally inside the same transaction that appends events.

No segment rotation. No standalone checkpoint files. No advisory lockfile. SQLite's WAL mode + `BEGIN IMMEDIATE` give the single-writer guarantee; WAL checkpoints (internal to SQLite) handle on-disk compaction automatically.

### 3.3 Commit semantics

`commit(cb)` is the Journal substrate primitive. The callback runs inside SQLite `BEGIN IMMEDIATE`; `c.append(input)` records a commit-local event and returns an opaque `CauseRefToken` that later events in the same closure may use at explicit `causeRef` paths. The substrate reserves contiguous `seq` values via `MAX(seq) + 1..N` under the same `BEGIN IMMEDIATE` (so only one writer reserves at a time and the values are contiguous within the closure), inserts the rows with explicit `seq`, resolves tokens to durable `CauseRef { stream, seq }` pointers, validates/upcasts, and applies reducers before the transaction commits. SQLite's `AUTOINCREMENT` is intentionally NOT used — see §3.1 schema comment.

```ts
journal.commit((c) => {
  const cause = c.append(sessionProviderFailedEvent(...));
  c.append(jobTerminalRecordedEvent({ ..., terminal: { outcome: failedTerminalOutcome(cause) } }));
  return undefined;
});
```

Either all appended facts land and all projections update, or none do. Replay never sees partial truth — this is the atomicity commit groups need (§16 #6).

### 3.4 Journal-domain exports

Materialized files for Journal domains (e.g., `result.md` per job) live outside the database and are rebuildable:

```
~/.coral/data/store/store.db                    (Journal substrate)
~/.coral/exports/jobs/                      (prod; dev uses ~/.coral/exports-dev/jobs/)
  <jobId>/result.md                  (durable export materialized from job.terminal.recorded)

<OS temp>/coral-jobs/
  <jobId>/stdout|stderr|...          (live scratch artifacts and intermediates)
```

Deleting `~/.coral/exports/jobs/<jobId>/result.md` never loses truth — rebuild from Journal events. Tmp job directories remain live-runtime scratch only; they are not the durable wait/follow result contract.

Note: KB markdown files at `~/.coral/kb/` are **not exports**. They are the Corpus authority itself (§2.2, §6.4). Derived KB indexes (Orama, needle) live at `~/.coral/data/kb/` and are rebuildable from the Corpus.

### 3.5 Replay identity

Pure reconstruction holds: for any `seq_cutoff`, the projection rows derived by replaying events `[1..seq_cutoff]` are byte-identical to the projection rows SQLite would hold after committing those events. This is exercised by regression tests through `tests/helpers/rebuild-projections.ts`; production keeps projections current inside `commit(cb)`.

### 3.6 What this buys

| Current design (residue) | SQLite substrate | Gain |
|---|---|---|
| Segment rotation logic | None — SQLite WAL checkpointing is automatic | Delete code |
| Standalone checkpoint files | None — projections ARE the live state | Delete code |
| Journal writer `lock` file | SQLite `BEGIN IMMEDIATE` | Delete code |
| Projection versioning / invalidation files | `meta.schema_version` row + SQL schema script | Simpler |
| Log-scan queries for cross-domain lookups | SQL JOIN | Faster, less code |
| Cross-stream atomicity gap | `BEGIN..COMMIT` transaction | Correct by construction |
| Custom JSONL segment readers/parsers | Parameterized SQL queries | Delete code |

`store/` becomes the SQL/Journal substrate. Domain-owned read query modules (`jobs/read/queries.ts`, `sessions/read-queries.ts`, `discuss/read-queries.ts`, `workflow/read-queries.ts`) sit above it, and `read-model/CoralStore` composes them with Corpus reads. The `CoralCoordinator` is the sole owner of a writable DB connection.

**Terminology note**: SQL schema scripts live under `schemas/` (§10). They are ordered schema generations applied to an empty or existing Coral store and are never user-data migration scripts; this rewrite has no prior deployed SQL state to preserve (§0). `src/store/schemas/001_initial.sql` is the single SQL schema authority for the clean-slate baseline and first applied schema. `src/store/schema.sql` must not exist because duplicate DDL authority is worse than a larger first script. Until the first main-branch deploy that actually creates SQL state, schema changes edit `001_initial.sql` in place; `002+` begins only after deployed SQL exists.

---

## 4. Journal Event Envelope

This envelope applies to **Journal events only** (§2.1). The Corpus authority (§2.2) uses markdown files directly and has no envelope — it has `contentSeq` / `metadataSeq` as its version counters (§6.4).

```ts
const journalEventEnvelope = z.object({
  seq: z.number().int().positive(),    // global total order (SQLite ROWID)
  ts: z.string().datetime(),
  type: z.string(),                    // e.g. 'job.terminal.recorded'
  stream: z.object({
    kind: z.enum(['job', 'session', 'discuss', 'workflow']),  // Journal kinds only; no 'kb'
    id: z.string().min(1),
  }).strict(),
  namespace: z.string().optional(),    // emitter identity (who)
  project: z.string().optional(),      // project scoping
  correlationId: z.string().optional(),
  causationSeq: z.number().optional(), // general-purpose backward causality pointer
  refs: z.object({
    jobId: z.string().optional(),
    sessionId: z.string().optional(),
    parentJobId: z.string().optional(),
    workflowId: z.string().optional(),
    workflowSlotId: z.string().optional(),
    discussSessionId: z.string().optional(),
  }).strict().optional(),
  bodyVersion: z.number().int().positive(),  // per-type schema version (starts at 1)
  body: z.unknown(),                         // domain payload
}).strict();
```

### 4.1 Why this shape

**`seq`**: global total order. The coordinator reserves contiguous `seq` values via `MAX(seq) + 1..N` under `BEGIN IMMEDIATE` (see §3.3). Every subscriber tracks a single `afterSeq` cursor and `seq` is the *only* field guaranteed to be strictly monotone.

**`ts` is informational only — it MAY be non-monotone w.r.t. `seq`.** The append input accepts a `tsOverride` so producers (notably discuss restoration replaying historical bids/speeches from an external archive) can stamp an event with its original wall-clock time. That stamp is allowed to be earlier than `MAX(ts)` of the prior events. Consumers that need ordering MUST use `seq`, not `ts`. The substrate enforces strict monotonicity on `seq`; it does not enforce any property on `ts`.

**Four Journal stream kinds**: `job`, `session`, `discuss`, **`workflow`**. Workflow is its own kind because a workflow owns a durable plan separate from the jobs it spawns (§6.5). KB is NOT a Journal stream — it lives in the Corpus authority (§2.2, §6.4).

**`stream.kind` vs `namespace`**: two different concepts. `stream.kind` is *what this event mutates*; `namespace` is *who emitted it*. Conflating them would break sessions that cross namespaces and force per-namespace logs that fragment natural cross-domain references (a discuss event referring to a job across namespaces becomes a distributed join).

**`refs`**: typed dereferences. `refs.workflowSlotId` on a child job launch points into the parent workflow's plan (§6.5); `refs.parentJobId` points to the workflow job. All `refs.*` fields point at *Journal* streams; cross-authority references to Corpus entries are deliberately absent (§2.4). Typed shape avoids string-id-in-body anti-patterns.

**`correlationId` + `causationSeq`**: the causality graph. `correlationId` groups related events (same user command); `causationSeq` is a **general-purpose backward pointer** — for fault propagation it points to the originating event (§7); for request/response flows it points to the request event; etc. `causeRef` in terminal outcomes is a typed alias of `causationSeq` + stream context.

**`bodyVersion`**: per-type schema version. Each event type starts at `bodyVersion: 1`. When a type's body shape evolves, the new version increments and an **upcaster** is registered that lifts older-version payloads into the current shape at read time (§4.2). There is no single envelope `v:` field — envelope evolution uses SQL schema script on the `events` table itself (rare; a major surgery).

**`body: unknown`**: the envelope is type-stable; payloads are domain-owned. Validation happens at projection construction via the type's current Zod schema (after upcast).

### 4.2 Schema evolution

Each event `type` has:
- A current Zod schema for its body (in the domain's `events.ts`).
- A `bodyVersion` corresponding to that schema.
- An optional chain of upcasters for older versions: `upcaster_v1_to_v2`, `upcaster_v2_to_v3`, etc.

At read time, the projection builder applies the upcaster chain:

```ts
function parseBody<T>(type: string, bodyVersion: number, body: unknown): T {
  const current = currentSchema(type);
  const chain = upcasterChain(type, fromVersion: bodyVersion);
  return current.parse(chain.reduce((b, upcast) => upcast(b), body));
}
```

Upcasters are pure functions. Old events are never rewritten; only the in-memory interpretation evolves. Writing a new event always uses the current `bodyVersion`.

All read-side event body decode routes through `UpcasterRegistry.parseBody`; direct `schema.parse` at read call sites is forbidden (invariant #45).

Rules:
- Additive fields (new optional field): no version bump; keep schema backward-compatible.
- Structural changes (removed field, renamed field, type narrowed): version bump + upcaster.
- Upcasters are kept forever — the store may contain any historical version.

This is the endpoint's evolution story. "Clean-slate rewrite" starts every event at `v:1`; upcasters are zero on day one. But the **mechanism** exists, so the first real evolution is cheap.

### 4.3 Reducer dispatch

Projection tables carry materialized read-model columns for stable-at-launch identity fields + lifecycle summary.

Event body is authoritative; each projection row is derived via reducer dispatch keyed by replay identity (`stream.kind`, `stream.id`, `seq`).
Richer launch/runtime/terminal payloads remain event-backed; projection is derived via reducer + replay identity, never by mutating historical event bodies.

Domain registries own the full write-time contract for their events: schemas, reducers, and append validators. Each event type is declared as a `DomainEventEntry` that pairs the schema with its (optional) reducer in one place, so the schema-reducer pairing is structural rather than two parallel maps that happen to share keys. The `defineDomainEvent({type, schema, reducer})` helper uses `z.output<S>` to infer the reducer's body type from the schema, so reducers receive a fully-typed body without per-call `schema.parse()` and without `as Reducer<unknown>` casts at the registration site.

`store.commit()` is the domain-neutral transaction substrate; it runs the closure, reserves seqs, resolves cause-ref tokens, parses bodies, validates, inserts, and dispatches reducers in one `BEGIN IMMEDIATE` block. Reducers therefore can rely on `event.body` matching the registered schema, which is why a reducer never re-parses; rebuild and consumer-apply paths route bodies through the same upcaster + schema before dispatch.

---

## 5. Journal Stream Kinds

The Journal authority (§2) carries **four** stream kinds, one per process-like domain. KB is NOT a Journal stream — it lives in the Corpus authority and is documented in §6.4.

### 5.1 `job/<id>`
Events about a single job's lifecycle: launch request, queue admission, runtime start, progress ticks, terminal outcome.
Projection: `JobView` / `projection_jobs` materializes stable launch identity (`session_id`, `provider`, `project_root`, `backend_namespace`, `bundle_hash`, `job_kind`, `parent_workflow_job_id`, `workflow_slot`, `created_at`) plus lifecycle summary (`phase`, `terminal`, `diagnostics`, `last_seq`).

Terminal wait is event-driven via `session:released` + `job.terminal.recorded` subscription; no polling fallback.

### 5.2 `session/<id>`
Events about a provider session: opened, continuity checkpointed (full snapshots), interrupted, closed.
Projection: `SessionView` / `projection_sessions` (controller, provider, resumable, conversationRef, scopeKey, lastSeq).

### 5.3 `discuss/<id>`
Events about a multi-agent discussion: existing vocabulary preserved (seed, speak, bid, synthesis, etc.).
Projection: `DiscussView`.

### 5.4 `workflow/<id>`
Events about a workflow's durable plan and execution shape: plan declared, revised, completed. A workflow is a first-class aggregate, distinct from the jobs that execute its slots. Child jobs reference their slot via `refs.workflowSlotId`; they do NOT carry `stepIndex`/`atomIndex`/`label` (those are plan-owned).
Projection: `WorkflowView` (plan + slot outcomes aggregated at read time from the workflow projection and child job rows).

`workflow.plan.declared` append validity is enforced at append time before a stream entry is written. The append substrate runs domain append validators before inserting rows ([`src/store/append.ts:287`](../../src/store/append.ts#L287)), and the workflow registry already contributes append validators for duplicate plan/completion protection ([`src/workflow/events.ts:243`](../../src/workflow/events.ts#L243)). The target validator rejects malformed plans with `CoralAppendError('workflow_plan_invalid', { reason, ...detail })` and writes no `workflow.plan_invalid` event; the Phase 2 rejection tests land at `tests/unit/workflow/plan-validity.test.ts`.

### 5.5 Why four Journal kinds

Every Journal event must tell projections which dispatch table applies. Collapsing to a single kind forces every projection to filter on `type` string prefixes — fragile, string-typed. Four kinds = four natural boundaries, each owning a genuinely different process-like vocabulary.

### 5.6 Why KB is not a Journal stream

KB entries are **knowledge artifacts**, not process events. They accumulate, get edited (often externally via Obsidian), and reference each other through entity graphs. The filesystem is the natural substrate: atomic rename, git-backed sync, direct human editability. Forcing a `kb/<id>` Journal stream would require bi-directional sync between filesystem and events, with race resolution for Obsidian edits — complexity with no compensating elegance.

KB's authority is the Corpus (§6.4). Journal events do not carry typed references to Corpus entries (§2.4).

---

## 6. Event Families

### 6.1 Jobs (`stream.kind = 'job'`)

```ts
job.launch.requested   { jobId, jobKind, provider?, projectRoot, request?, createdAt, ... }
job.launch.rejected    { reason, message, provider, globalActive, globalLimit }
job.queue.queued       { queuePosition, runningJobIds }
job.queue.admitted     { queuePosition? }
job.runtime.started    { transport?, operation?, pid?, startedAt, ... }
job.progress.emitted   { kind: 'message' | 'domain' | 'missing_launch_record' | 'recovery_parse_failed', ... }
job.aborted            { reason }
job.terminal.recorded  { terminal: JobTerminal, diagnostics?, continuity? }
```

**Why the queue split (`queued` vs `admitted`)**: queueing is a first-class state, not an implementation detail. `queued` names the reason (host lock, seat exhaustion) for observability; `admitted` names the transition. Projections can answer "how long was this job queued" without log-grepping.

**Lifecycle ordering on a job stream** (enforced at append by `src/jobs/projections.ts` and validated by invariant tests):

| Position | Required body | Notes |
|---|---|---|
| First | `job.launch.requested` | Exactly one. No other body may precede it on the stream. |
| Mid (optional) | `job.launch.rejected` | Terminal-causing in its own right; must be followed by exactly one `job.terminal.recorded { failed { causeRef → this rejected } }` and nothing else. No `queue.*` / `runtime.*` / `progress.*` / `aborted` after a `rejected`. |
| Mid | `job.queue.queued` then `job.queue.admitted` | Both optional, but if `queued` appears, `admitted` (or a terminal) must follow. `admitted` never appears without a preceding `queued` on the same stream. |
| Mid | `job.runtime.started` | At most one in production; appears after `admitted` (if the job queued) or directly after `requested` (if admission was immediate). |
| Mid (any number) | `job.progress.emitted` | Multiple allowed. May carry `kind: 'domain'` failure detail (§7.3) — the terminal then points back via self-stream `causeRef`. |
| Mid (optional) | `job.aborted` | Records the abort cause on-stream; the terminal still must follow. Multiple `aborted` events are not appended (the registry suppresses re-aborts). |
| Last | `job.terminal.recorded` | Exactly one, and last (§8.3 #1, invariant #8). After the terminal, no further bodies append to this stream. |

`job.launch.rejected` and `job.aborted` are causal/domain events that can precede the terminal body; they are not substitutes for the terminal body. Multiple `runtime.started` bodies on the same stream are a recovery anomaly recorded as `job.progress.emitted { kind: 'recovery_parse_failed' }`, not silently coalesced.

**`job.progress.emitted` carries domain-specific failure detail**: when an internal KB job (source import, explicit reindex/curation step, etc.) hits a terminal-causing failure, the failure is recorded as a rich progress event. In the implementation's discriminated progress body this is `kind: 'domain'`; `stage` names the semantic stage (e.g., `kb_operation_failed`); `detail` carries domain payload (e.g., `{ operation, entryId, cause }`). The terminal outcome then uses `failed { causeRef }` pointing back at this progress event on the same stream — self-stream causeRef is the normal pattern for job-local failure chains.
Provider-hosted KB work inside an already-running job reports non-terminal failures with `stage: 'hosted_kb_operation_failed'` and does not cause the hosting job terminal. This is why there is no separate `kb/<id>` stream: KB content is Corpus authority, while slow process-like KB attempts and KB work hosted by a running job report their failures on the hosting `job/<id>` stream. Fast direct KB commands that do not create a job return structured command errors instead of becoming Journal truth.

**Source import is a job-owned ingest attempt, not a KB stream**: importing a source may include PDF conversion, staging, Corpus commit, and retrieval freshness waits. Those are temporal process facts, so they belong on `job/<id>`. The imported source itself belongs only to the Corpus (`~/.coral/kb/sources/<slug>.md`). A source-import job completes according to an explicit readiness contract:

```ts
type SourceImportReadiness =
  | 'commit'        // source markdown is durably written to the Corpus
  | 'base-search'   // current kb.fts binding owner is fresh for the commit
  | 'active-vector' // current kb.vector binding owner is fresh; binding_empty if unbound
  | 'all-equipped'; // every installed Corpus consumer is fresh
```

The default CLI experience may create the job and wait internally, but the underlying contract is job/wait. The default readiness is `base-search`: after `kb source import paper.pdf` returns, `kb search paper` should observe the document. Stricter readiness (`active-vector` or `all-equipped`) is explicit because it binds the command to embedding and expansion latency.

**Explicit reindex is also coordinator-owned**: `kb reindex` rebuilds Corpus text artifacts and then waits for base-search freshness through the CorpusConsumer driver. It records an internal `kb.reindex` job on `job/<id>` for recovery and observability, but it is not a provider/session job and has `session_id = NULL`, `provider = NULL`. Fast KB reads, note writes, memo operations, and normal search remain direct commands because they are expected to be immediate.

**Workflow context lives on envelope refs, not in body**:
A child job launched by a workflow carries envelope-level references, not body fields:
- `refs.workflowId` — points to the workflow stream that owns the plan.
- `refs.workflowSlotId` — points to the specific slot within that plan.
- `refs.parentJobId` — points to the workflow job (a distinct job that materializes the workflow's execution).

The child launch event's **body** is the canonical `JobLaunchRequestBody` used by any other job launch. Syntax-shaped metadata like `stepIndex`, `atomIndex`, and `label` do not appear on the launch event — they are plan-owned (§6.5) and derived via `refs.workflowSlotId` at render time. This is the strict application of "stream identity is truth, labels are presentation" to workflow composition.

### 6.2 Sessions (`stream.kind = 'session'`)

```ts
session.opened                   { entry, controller, provider, scope_key }
session.continuity.checkpointed  { entry, snapshot }
session.claimed                  { entry, jobId }
session.claim.released           { entry, jobId }
session.interrupted              { fault | { entry?, fault } }
session.provider_failed          { ...provider failure fault }
session.adapter_unparseable      { ...adapter parse fault }
```

A session has no "closed" event. Sessions exist for as long as their stream has events; there is no user-facing close action and no expiry path, so a `session.closed` vocabulary would be wired truth without a producer (per the clean-slate rule applied to `workflow.plan.revised`). Re-add only when a real session-close concept arrives.

**Why continuity is a full snapshot, not a patch**:
Today's design would have us emit "conversationRef changed from X to Y". A future reader would need every prior patch to know the current state. Full snapshots are idempotent: the latest one is the truth. This matches Pioneer C's stream model and eliminates a replay-order-dependency bug class.

**What `providerContinuity: unknown` is**:
Each provider stores opaque continuation data — Codex stores a `threadId`, Claude stores an `appServerSessionId` and control cursor. The coordinator does not interpret this; it round-trips it. The `unknown` type is intentional: it is the provider's private state.

Session scope lookup is O(1) via `projection_sessions`, populated by the reducer.

### 6.3 Discuss (`stream.kind = 'discuss'`)

Discuss Journal event types are `discuss.${kind}` over the live discuss domain vocabulary: `session.created`, `bidding.opened`, `bid.submitted`, `participants.expelled`, `bid.round.closed`, `speech.recorded`, `speech.timed_out`, `epoch.summary.recorded`, `must_answer.carry_forward.set`, `follow_up.queue.set`, `follow_up.answered`, `session.ended`, `session.synthesized`, and agent run/job lifecycle events. The reducer and projections in `src/discuss/` own that vocabulary; the Journal envelope carries it without inventing legacy aliases. Follow-up answer collection is `Promise.all` across independent agents; any per-flow deviation must be explicitly documented.

### 6.4 KB Corpus (not a Journal stream)

The KB domain does not live on the Journal. Its authority is the **Corpus** — markdown files at `~/.coral/kb/`, git-tracked, directly editable in Obsidian. See §2.2 for the authority rationale.

**Corpus substrate**:

```
~/.coral/kb/                        ← Corpus authority (git-tracked)
  notes/<slug>.md                   ← promoted KB notes
  sources/<slug>.md                 ← imported source documents
  principles/<slug>.md              ← cross-domain patterns
  communities/<slug>.md             ← entry clusters (curation output)
  .entity-graph.json                ← semantic relationships
  .gitignore                        ← lists data/, .obsidian/
  .git/

~/.coral/data/kb/                   ← Corpus-derived indexes (device-local, git-ignored)
  index.json                        ← structured metadata snapshot
  orama/                            ← Orama snapshot directory (bundled FTS)
    orama-index.json                ← Orama serialized index
    orama-index.metadata.json       ← projected Corpus + Orama projection identity sidecar
  needle/                           ← needle runtime storage (installed vector engine)
  needle-staging/                   ← needle staging area for snapshot builds
  consumer_cursors                  ← in store.db (SQLite); tracked per Corpus consumer
```

Project memos are deliberately outside this tree. They live under the project data directory as scratch capture artifacts for review/promotion. A memo becomes long-term KB only when promoted into a Corpus note/source; until then it is neither Corpus authority nor a CorpusConsumer input.

**Freshness counters** (versions, not events):

- `contentSeq` — monotonic counter; increments on any content mutation (promote, update, source-import).
- `metadataSeq` — monotonic counter; increments on metadata-only changes (tags, frontmatter).

These are analogous to `events.seq` on the Journal side but version the whole Corpus rather than counting discrete events. Consumers track their cursor against these counters and catch up via manifest diff (not event replay).

The seq pair is the **operator-facing** view of Corpus freshness. The full freshness identity passed to `CorpusConsumer.apply` and `waitFreshUntil('corpus', ...)` is `CorpusSnapshot = { snapshotId, contentSeq, metadataSeq, contentManifestHash, metadataManifestHash }` (§9.2). The manifest hashes detect identity changes that bypass the seq counters — external Obsidian edits absorbed by lazy rescan, git pull, repair pipeline rewrites — so consumer cursors stay correct without depending on every external mutation to bump a coordinator-owned counter.

**Mutations** (coordinator-mediated, via CLI):

Fast coordinator KB operations follow the same pattern inside a single **Corpus mutation lock**:

1. `writeFileAtomic` — markdown `.tmp` + rename (atomic at filesystem level).
2. Bump `contentSeq` (or `metadataSeq`) in the corpus version state.
3. Update lightweight Corpus metadata/index state (`index.json`, manifest authority records) needed to describe the Corpus itself.
4. Release lock.
5. Notify Corpus consumers for currently bound retrieval projections (for example the consumer behind `kb.fts`, and the consumer behind `kb.vector` when that binding is filled) — they run their apply loop asynchronously (§9).

Retrieval artifacts are not built inside the authoritative critical section. A command that promises retrieval freshness captures the committed `contentSeq` / `metadataSeq` and waits for the relevant consumer cursor after the lock releases. This keeps the Corpus write small while still giving long-running commands a precise readiness contract.

**Mutation-lock deadline (ownership-on-settle)**: `withMutationLock(fn, { signal? })` injects a composed `AbortSignal` into `fn(mutation, { signal })`. The signal aborts on caller cancellation (propagating `options.signal.reason`) **or** when an internal deadline timer fires (with a non-user reason — `{ kind: 'mutation_deadline', timeoutMs }`). The deadline aborts the signal but **does not release ownership**: ownership transfers to the next caller only when `fn` settles (success, failure, or cooperative `AbortError` propagation). A non-cooperative `fn` that ignores the signal continues to hold the lock — there is no race between `fn` and a timeout that lets a second caller proceed against the same critical section. Default deadline is **30 seconds** for fast coordinator paths (memo write, note update, source delete); heavy paths pass an explicit longer timeout — `kb reindex` and `kb source import` use **5 minutes**, set on the call site. When the deadline fires before `fn` settles, the lock surfaces a stuck-mutation diagnostic at `/health.subsystems.kb.mutationBlocked` carrying `{ owner, signaledAtMs, ageMs }`; the deadline-reason `AbortError` is not a user abort. This guarantees: (a) no parallel-mutation hazard from premature lock release, (b) wedged operations are observable rather than silent, and (c) cooperative `fn` honors cancellation cleanly through its injected signal.

External edits (Obsidian, manual filesystem ops, `git pull`) bypass the coordinator entirely. They are detected by startup scans and the lazy non-blocking rescan dispatched on KB read paths (§12.3); CorpusConsumers pick up the drift via manifest diff.

**Source import readiness**:
`kb source import` is the one KB mutation whose shell is process-like by default. It stages/converts the external document, commits the resulting markdown source to the Corpus, then optionally waits for retrieval consumers according to the readiness contract defined in §6.1:

| Readiness | Completion condition | Unbound-binding fail-mode |
|---|---|---|
| `commit` | Corpus source markdown is durable and `contentSeq` advanced. | n/a (no binding read). |
| `base-search` | `commit` + `kb.fts.read().consumer` reached the committed `contentSeq`. | `kb_unavailable { binding: 'kb.fts' }` — bundled Orama is normally always bound, but if startup left `kb.fts` empty the readiness wait fails structurally instead of leaking a raw `binding_empty`. |
| `active-vector` | `commit` + `kb.vector.read().consumer` reached the committed `contentSeq`. | `kb_unavailable { binding: 'kb.vector' }` — `kb.vector` is empty until an installed engine fills it. |
| `all-equipped` | `commit` + every installed Corpus consumer reached the committed Corpus version. | Empty bindings are skipped (best-effort over what's currently equipped). |

The command surface is identical in base and equipped tiers. Equipping needle or another vector engine changes whether `kb.vector` is bound and which consumer satisfies `active-vector`; it does not create a separate import command.
Retrieval readiness is observed through `waitFreshUntil('corpus', version, consumerId)` after the Corpus commit. If that wait fails, the source markdown and Corpus version remain durable; the hosting job records the readiness failure instead of rolling back knowledge content.

**Projections / search backends** (all rebuildable from the Corpus alone):

| Backend | Consumer ID | Role | Tier | Substrate |
|---|---|---|---|---|
| KB runtime/query layer | — (direct read, no consumer) | direct markdown read + list/diagnose helpers | base, always | `~/.coral/kb/` + `~/.coral/data/kb/` |
| **FTS projection** | `kb.fts.read().consumer.id` (bundled Orama by default) | FTS (BM25) | bundled fallback, always in normal startup | `~/.coral/data/kb/orama/orama-index.json` |
| **Vector projection** | `kb.vector.read().consumer.id` when bound | vector/ANN retrieval | installed engine (`/equip needle`, `/equip kb_scann`, ...) | engine-owned runtime storage |

**Why binding lookup, not hardcoded consumer IDs**: readiness waits first read the active binding, then pass that bound backend's `consumer.id` to `waitFreshUntil`. `base-search` reads `kb.fts`; `active-vector` reads `kb.vector`. This keeps future engines behind the same binding cells and prevents source import from depending on a specific engine name.
The bundled Orama consumer owns the FTS projection.
Needle and future vector engines own independent projection state when they fill `kb.vector`.

Engine artifacts are described to KB through a KB-owned lifecycle registry, not through engine-id literals, fixed constructor arrays, or KB parsing engine files. An `EngineArtifactPort` returns consumer-addressed normalized descriptors with `targetConsumerIds`, corpus interest, artifact paths, expected projection identity, and freshness status ([`src/kb/corpus/artifact-port.ts:26`](../../src/kb/corpus/artifact-port.ts#L26)-[`src/kb/corpus/artifact-port.ts:38`](../../src/kb/corpus/artifact-port.ts#L38)). `EngineArtifactRegistry` records the active ports by expansion scope, decorates descriptors with the registered consumer handle ids, and is unregistered before consumer cleanup during expansion-scope disposal ([`src/kb/corpus/artifact-registry.ts:20`](../../src/kb/corpus/artifact-registry.ts#L20)-[`src/kb/corpus/artifact-registry.ts:71`](../../src/kb/corpus/artifact-registry.ts#L71), [`src/expansion/host.ts:144`](../../src/expansion/host.ts#L144)-[`src/expansion/host.ts:155`](../../src/expansion/host.ts#L155)). Bundled Orama uses the same path: its Expansion registers the consumer, registers the artifact port for that handle, then binds FTS ([`src/engines/orama/expansion.ts:16`](../../src/engines/orama/expansion.ts#L16)-[`src/engines/orama/expansion.ts:32`](../../src/engines/orama/expansion.ts#L32)).

Freshness is backed by full projected snapshot identity persisted beside engine artifacts. Orama writes a metadata sidecar containing `snapshotId`, `contentSeq`, `metadataSeq`, both manifest hashes, `projectionIdentityHash`, and an artifact digest; missing/legacy/corrupt sidecars report normalized corrupt or missing states instead of letting KB parse Orama bytes ([`src/engines/orama/artifact-port.ts:33`](../../src/engines/orama/artifact-port.ts#L33)-[`src/engines/orama/artifact-port.ts:56`](../../src/engines/orama/artifact-port.ts#L56), [`src/engines/orama/artifact-port.ts:68`](../../src/engines/orama/artifact-port.ts#L68)-[`src/engines/orama/artifact-port.ts:122`](../../src/engines/orama/artifact-port.ts#L122), [`src/engines/orama/snapshot.ts:99`](../../src/engines/orama/snapshot.ts#L99)-[`src/engines/orama/snapshot.ts:108`](../../src/engines/orama/snapshot.ts#L108)). Needle reports the same normalized projected snapshot shape after validating its active pointer, manifest, and native store spec ([`src/engines/needle/artifact-port.ts:70`](../../src/engines/needle/artifact-port.ts#L70)-[`src/engines/needle/artifact-port.ts:167`](../../src/engines/needle/artifact-port.ts#L167)). KB compares those descriptors to the current Corpus snapshot and projection identity through `detectProjectionArtifactLag`, never by hardcoding engine file names ([`src/kb/corpus/rescan/drift.ts:305`](../../src/kb/corpus/rescan/drift.ts#L305)-[`src/kb/corpus/rescan/drift.ts:366`](../../src/kb/corpus/rescan/drift.ts#L366), [`src/kb/corpus/rescan/drift.ts:368`](../../src/kb/corpus/rescan/drift.ts#L368)-[`src/kb/corpus/rescan/drift.ts:373`](../../src/kb/corpus/rescan/drift.ts#L373)).

Corpus authority drift is separate from projection artifact lag. The KB-owned `kb_corpus_authority_baseline` table stores content/metadata hashes for Corpus authority records, including entity graph state ([`src/store/schemas/001_initial.sql:85`](../../src/store/schemas/001_initial.sql#L85)-[`src/store/schemas/001_initial.sql:101`](../../src/store/schemas/001_initial.sql#L101), [`src/kb/corpus/rescan/authority-baseline.ts:33`](../../src/kb/corpus/rescan/authority-baseline.ts#L33)-[`src/kb/corpus/rescan/authority-baseline.ts:45`](../../src/kb/corpus/rescan/authority-baseline.ts#L45), [`src/kb/corpus/rescan/authority-baseline.ts:156`](../../src/kb/corpus/rescan/authority-baseline.ts#L156)-[`src/kb/corpus/rescan/authority-baseline.ts:164`](../../src/kb/corpus/rescan/authority-baseline.ts#L164)). Mutation commit points update or rebuild this baseline independently of projection artifacts, including entity-graph writes ([`src/kb/runtime.ts:388`](../../src/kb/runtime.ts#L388)-[`src/kb/runtime.ts:392`](../../src/kb/runtime.ts#L392), [`src/kb/runtime.ts:416`](../../src/kb/runtime.ts#L416)-[`src/kb/runtime.ts:429`](../../src/kb/runtime.ts#L429), [`src/kb/runtime.ts:639`](../../src/kb/runtime.ts#L639)-[`src/kb/runtime.ts:673`](../../src/kb/runtime.ts#L673), [`src/kb/runtime.ts:782`](../../src/kb/runtime.ts#L782)-[`src/kb/runtime.ts:807`](../../src/kb/runtime.ts#L807)). ProjectionArtifactLag repairs compose `forceCorpusApply` orchestration with readiness waiting on `{ snapshot, atLeastGeneration }`: boot detects lag, forces targeted consumers, then awaits `ConsumerDriver.waitFreshUntil('corpus', { snapshot, atLeastGeneration }, consumerId)` ([`src/coordinator/index.ts:168`](../../src/coordinator/index.ts#L168)-[`src/coordinator/index.ts:194`](../../src/coordinator/index.ts#L194)).

KB has no SQLite content projection in the steady state. Markdown remains authoritative; Orama/needle are rebuildable retrieval artifacts; SQLite stores only control state (`kb_corpus_state`, `kb_corpus_authority_baseline`, `consumer_cursors`, `kb_curate_scheduler`, and `kb_curate_retry_queue`).

**Equipment principle applied**:
- Command surface is identical in both tiers: `kb search "query"`, `kb search --vector <emb>`, `kb search --hybrid "query"` all exist.
- Base tier: FTS is zero-config through bundled fallback. Vector and hybrid paths require both `kb.vector` and `kb.embedding` to be filled by equipped engines.
- Equipped (`/equip needle`): needle fills `kb.vector` for scale. Embedders such as gemini or onnx fill `kb.embedding` independently. FTS unchanged.
- No new commands appear from equipping. The needle sharpens existing blades, it does not add new weapons.
- Why not bundle ONNX for zero-config local embeddings? `onnxruntime-node` is ~82MB compressed / 210MB unpacked — roughly 40× the current plugin size. Bundling breaks the "click-install, just works" UX premise. Users who need fully offline embedding can opt in via `/equip` onboarding, which installs the local ONNX runtime as the engine that fills `kb.embedding`.

**Why Orama is architecturally load-bearing** (not replaceable by SQLite FTS5):
Orama's value is focused FTS with pure JS and zero native dependencies. That is exactly what the bundled tier needs: reliable full-text KB search with no install friction. Replacing it with SQLite FTS5 is superficially attractive (unified storage, FTS co-transactional with metadata), but it would add a second SQL search subsystem beside Corpus-derived engine projections without improving the binding model.
The vector axis is intentionally separate: `kb.vector` starts empty and is filled by installed engines that can own their native/runtime dependencies explicitly. The Corpus + indexes layout is role-specialization, not accidental complexity.

**Operational facts are not Corpus mutations.** Events like "Orama index rebuilt", "needle index snapshot rotated", "WAL checkpointed" are coordinator-local operational telemetry — they belong in structured logs, not on any authority.

**Curate state location**: the curation pipeline (discovery, classification, community detection, entity consolidation, retry scheduling) maintains operational state in `kb_curate_scheduler` + `kb_curate_retry_queue` SQLite tables (§3.1), not in `curate-state.json`. The curate scheduler runs as a coordinator-live component (§10 `coordinator/live/curate-scheduler.ts`), not as a Corpus domain leaf — single-writer discipline requires it inside the coordinator process. Its cursors are device-local operational state, not authoritative content.

#### 6.4.1 Corpus repair pipeline

Rescan detects markdown content that cannot be parsed normally. Examples:
- Git merge conflict markers left in a file (`<<<<<<<`, `=======`, `>>>>>>>`).
- Invalid frontmatter (unclosed YAML block, syntax errors).
- Missing required fields (e.g., missing `entrySeq` on a note created outside coral).
- `entrySeq` collisions (two entries claiming the same seq).
- Orphaned derived state (e.g., entity-graph references to a deleted entry).

The repair pipeline runs during rescan + curate passes. It classifies each detected issue and dispatches:

| Classification | Action |
|---|---|
| **Auto-fixable** | Apply fix under Corpus mutation lock (e.g., re-assign `entrySeq`, regenerate minimal valid frontmatter from filename + defaults). Commit via git-sync. Log the auto-repair. |
| **Needs manual** | Queue the entry in `kb_curate_retry_queue` with a repair hint. User sees a diagnostic (`coral-cli kb diagnose` or dashboard). |
| **Unrecoverable** | Log + skip. Entry absent from projections until user fixes the source file. |

**Status note (current state)**: this section describes two surfaces that exist together by intent — the spec's earlier framing conflated them. They have distinct concerns and distinct lifetimes:

1. **Classification-driven repair pipeline** (`src/kb/corpus/rescan/{auto-fix,drift,index,projections,scan,storage}.ts` plus `rescan/incidents/{catalog,file-syntax,frontmatter,identity,references}.ts`). This is the surface that owns *individual entry diagnosis + classified fix dispatch* per the table above. As of this writing, the rescan tree is in place and wired into KB freshness — `KbRuntime.ensureCorpusFreshness` (`src/kb/runtime.ts`) is gated by `textArtifactsNeedRebuild()` and runs `performRescan` under the Corpus mutation lock when needed. End-to-end automated dispatch of every classified outcome through the runtime drain loop is forward work; until that lands, malformed-entry detection during bulk reload (#2 below) covers the gap.

2. **Derived-index cache maintenance** (`src/kb/curate/text-artifacts/`). This is *not* repair — it owns the drift detection and bulk rebuild of the derived `index.json` + `orama-index.json` artifacts vs the Corpus markdown. `detectTextArtifactRebuildInfo` answers "is the cached index stale?"; `rebuildTextArtifacts` reloads the derived snapshot from current markdown. The shallow `pendingRepair[]` it produces during reload is a side-effect of try/catching parse errors per file, persisted to `curate-state.json` and synced to `kb_curate_retry_queue` by `curate/state/store.ts`. This is structural cache machinery, not ad-hoc repair, and remains load-bearing.

Both surfaces converge at `kb_curate_retry_queue` — the SQL table that tracks pending repair work regardless of which surface detected it. Repair operations that mutate the Corpus go through the standard Corpus mutation lock (§6.4 mutations). No special substrate.

### 6.5 Workflow (`stream.kind = 'workflow'`)

```ts
workflow.plan.declared  { plan: WorkflowPlan }
workflow.drain.entered  { firstFailureSlotId, drainDeadline }
workflow.completed
  | { outcome: 'completed'; stepDetails: WorkflowStepDetail[] }
  | { outcome: 'aborted'; stepDetails: WorkflowStepDetail[] }
  | { outcome: 'failed'; causeRef: CauseRef; stepDetails: WorkflowStepDetail[] }
workflow.lifecycle_fault
  | { kind: 'wrapper_crashed'; message: string; stack?: string }
  | { kind: 'recovery_failed'; message: string; stack?: string }
  | { kind: 'unknown'; message: string }
```

```ts
type WorkflowPlan = {
  slots: WorkflowSlot[];
};

type WorkflowSlot = {
  slotId: string;                    // stable id; production format is `${workflowId}:${stepIndex}:${atomIndex}`
                                     // e.g. "wf-1:0:0", "wf-1:1:2". The slotId itself encodes step+atom
                                     // position so renderers can reconstruct presentation without storing it.
  dependencies: string[];            // slotIds this slot waits for
  provider: string;                  // e.g. 'codex', 'claude'
  instruction: string;
  agent?: string;
};

type WorkflowStepDetail = {
  stepIndex: number;
  atomIndex: number;
  kind: 'agent' | 'prompt';
  label: string;
  provider: string;
  tagName: string;
  output: string;
};
```

**Plan body owns no `workflowId` field** — the workflow stream identity (`event.stream.id`) is the truth. Storing it inside the body would be a duplicate that can drift from the stream id; helpers receive `workflowId` separately when they need it. This is the same "stream identity is truth" principle that keeps `stepIndex`/`atomIndex`/`label` off the launch event.

**Plan body owns no `labels` field** — labels are presentation, derived at render time from `slot.agent ?? prompt#${atomIndex}(${truncated instruction})`. Storing them separately would create a second source of truth that the `agent`/`instruction` fields could drift from. The `slotId` format above lets the renderer recover step/atom position without lookup.

**Append-time plan validity for `workflow.plan.declared`**:
- Duplicate `slotId` is rejected with `workflow_plan_invalid { reason: 'duplicate_slot' }`. Existing plan construction creates one slot per atom ([`src/workflow/plan.ts:58`](../../src/workflow/plan.ts#L58)); Phase 2 enforces the rejection in `tests/unit/workflow/plan-validity.test.ts`.
- Cycles in the slot dependency graph are rejected with `workflow_plan_invalid { reason: 'cycle', cycle: [slotId, ...] }`. Today the read-side planner detects cycles when computing step depths ([`src/workflow/plan.ts:130`](../../src/workflow/plan.ts#L130), [`src/workflow/plan.ts:145`](../../src/workflow/plan.ts#L145)); Phase 2 moves the rule to append validation and verifies it in `tests/unit/workflow/plan-validity.test.ts`.
- Empty plans (`plan.slots.length === 0`) are rejected with `workflow_plan_invalid { reason: 'empty_plan' }`. The schema currently accepts an array shape ([`src/workflow/plan.ts:37`](../../src/workflow/plan.ts#L37)), so Phase 2 owns the append-time semantic rejection in `tests/unit/workflow/plan-validity.test.ts`.
- Rejection model: all `workflow_plan_invalid` rejections are thrown at append time as `CoralAppendError('workflow_plan_invalid', { reason, ...detail })`; no `workflow.plan_invalid` event is written. Per §5 (failure truth lives once on the originating stream), a rejected `workflow.plan.declared` append produces no stream entry, so its truth is purely a caller-facing error response — there is no causal target for a `causeRef` to point at, because the workflow stream was never declared. The append substrate runs validation before the insert loop ([`src/store/append.ts:281`](../../src/store/append.ts#L281), [`src/store/append.ts:287`](../../src/store/append.ts#L287), [`src/store/append.ts:308`](../../src/store/append.ts#L308)); Phase 2 verifies no event row is produced in `tests/unit/workflow/plan-validity.test.ts`.
- `slotId` format anchor: validation preserves the production format generated by `src/workflow/plan.ts:60`, `${workflowId}:${stepIndex}:${atomIndex}` (for example `wf-1:0:0`). Validation bounds the workflow id and numeric components and must not use a regex that excludes `:` ([`src/workflow/plan.ts:60`](../../src/workflow/plan.ts#L60), [`tests/unit/workflow/pipe-executor.test.ts:899`](../../tests/unit/workflow/pipe-executor.test.ts#L899)); Phase 2 pins the append rejection/acceptance cases in `tests/unit/workflow/plan-validity.test.ts`.
- Stream prefix references (`refs.workflowSlotId`) are rejected at append if the `slotId` is not present in the plan. Child launches currently carry `refs.workflowSlotId` from job launch storage into job projection rows ([`src/jobs/job-store.ts:420`](../../src/jobs/job-store.ts#L420), [`src/jobs/projections.ts:171`](../../src/jobs/projections.ts#L171)); Phase 2 adds the append validator coverage in `tests/unit/workflow/plan-validity.test.ts`.
- Unknown provider references are rejected at append time. Phase boundary: Phase 1 documents only the target rule and cites today's compile-time validation at [`src/workflow/compile.ts:36`](../../src/workflow/compile.ts#L36) as the existing pre-append check. The actual `DomainAppendValidator` redesign (narrow `ProviderLookupPort`/append validation context derived from `providers/catalog.ts` instead of `(db, inputs)`) is scheduled to Phase 2 step 0 (validator port); Phase 1 must not claim that redesign has landed. Phase 2 verifies the append-time target in `tests/unit/workflow/plan-validity.test.ts`.

**Why plan as a separate stream-kind**:
- Plan is a durable aggregate with semantics (dependencies, slot IDs) independent of any single job execution.
- Child jobs reference `refs.workflowSlotId` and `refs.workflowId`; the plan lives ONCE on the workflow stream, not duplicated on every child launch.
- Launch-time syntax-shaped metadata (`stepIndex`, `atomIndex`, label) is encoded in `slotId` and `agent`, not duplicated on child launches. Completion `stepDetails` separately records execution summaries for completed atoms, including step/atom indices and label alongside output.
- Workflow completion is a stream-level fact. The `causeRef` on `workflow.completed` points to the failing child's terminal event when relevant — no wrapped fault variant needed.

**Why a workflow job still exists as a `job/<id>` stream**:
The workflow is also a job (from the user's perspective, they `wait` on a workflow id). The `job/<id>` stream carries the user-facing job lifecycle. The `workflow/<id>` stream carries the plan and slot outcomes. They are linked by convention (`workflowJobId === workflowId`, or explicit `refs.workflowId` on the job's launch event).

---

## 7. Terminal & Fault Model

The fault model is **causal-graph, not wrapped-union**. Every failure lives **once** — on the stream where it happened, as a domain-owned event. Job terminals carry a **pointer** (`causeRef`) to the originating event rather than re-encoding its content. CLI and dashboards walk the causal chain to render.

This is the strictest application of "journal is truth, exports are presentation" to failure modeling.

### 7.1 Terminal shape

```ts
type JobTerminal = {
  content: string;              // provider's final output (may be empty on failure)
  outcome: TerminalOutcome;
  durationMs: number;
};

type JobDiagnostics = {
  warnings: string[];
  usage?: UsageSummary;
  model?: string;
};

type TerminalOutcome =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason: AbortReason }
  | { kind: 'provider_exit'; code: number; note?: string }
  | { kind: 'failed'; causeRef: CauseRef }
  | { kind: 'job_fault'; fault: JobLifecycleFault };

type AbortReason = 'signal_abort' | 'user_abort' | 'queue_shutdown';

type CauseRef = {
  stream: { kind: 'job' | 'session' | 'discuss' | 'workflow'; id: string };  // Journal kinds only — KB is Corpus (§5.5)
  seq: number;
};
```

**Five-variant outcome, not one wrapped union**:

- `completed` — exit code 0, normal termination.
- `aborted` — user or signal aborted the job; `reason` names the source.
- `provider_exit` — provider process exited non-zero. `code` is the exit status. No `cause` field — the provider's process exit IS the full fact.
- `failed` — a domain event on another stream caused this job to terminate. `causeRef` points to it. **No fault payload is duplicated here.** To render, dereference the referenced event.
- `job_fault` — a truly job-local lifecycle failure (wrapper crashed, ghost launch, reconciliation mismatch) that has no originating domain stream. This is the ONLY surviving "fault union" variant, and its vocabulary is small and bounded.

### 7.2 `JobLifecycleFault` — the only remaining ADT

```ts
// src/jobs/outcome.ts
export type JobLifecycleFault =
  | { kind: 'ghost_launch' }               // launch recorded, no process ever observed
  | { kind: 'wrapper_lost' }               // wrapper exited without reporting outcome
  | { kind: 'wrapper_crashed'; cause: ExternalError };  // wrapper threw; cause is wrapper-local

export type ExternalError = { message: string; stack?: string };
```

Three variants. All three represent failures of the **coordinator's own wrapper process**, where there is no domain stream to point at — the wrapper was supposed to emit domain events and did not. `cause` on `wrapper_crashed` is a wrapper-local error, not a foreign domain fault.

**Why no composable union across domains**: when a domain has a stream-resident fault event, the job terminal uses `failed { causeRef }` to point at it. There is no need to copy the domain's fault variant into a union that the job terminal owns. The domain's event type **is** the fault's authoritative declaration.

**Removed from the previous composable-union design**:
- `workflow_child_failed` — replaced by `failed { causeRef: { stream: {kind:'job', id: childJobId}, seq } }`. The "failing child" is a reference, not a variant.
- `workflow_aborted` — replaced by `workflow.completed { outcome: 'aborted', stepDetails }` on the workflow stream; job terminal uses `aborted { reason: 'user_abort' }` or `failed { causeRef }` to the workflow completion event.
- `launch_rejected` — `job.launch.rejected` event on the job's own stream; `job.terminal.recorded` on the same stream uses `failed { causeRef }` pointing backward to the rejected event (self-stream causeRef is fine and common).
- `app_server_interrupted` — `session.interrupted` event on the `session/<id>` stream; job terminal uses `failed { causeRef }`.
- `adapter_output_unparseable`, `provider_session_unavailable`, `provider_request_failed` — each emitted on the `session/<id>` stream as `session.adapter_unparseable`, `session.provider_failed`, etc. Job terminal uses `failed { causeRef }`.
- `kb_operation_failed` — replaced by `job.progress.emitted { kind: 'domain', stage: 'kb_operation_failed', detail }` on the **internal KB job's own stream** (slow terminal-causing KB attempts such as source import or explicit reindex); job terminal uses `failed { causeRef }` pointing self-stream to that progress event. KB is not a Journal stream (§5.5, §6.4). Discuss provider/facilitator attempts record their operational outcome as `discuss.agent.job.finished` on `discuss/<id>`; any external terminal that needs to explain a discuss-origin failure points at that event with `causeRef`.
- Provider-hosted KB failures inside an already-running provider job use `job.progress.emitted { kind: 'domain', stage: 'hosted_kb_operation_failed', detail }` and are non-terminal for the hosting job.

The **composable union with domain-owned variants** was itself residue — ADT-shaped thinking on top of journal-native causal references. A journal already gives us stream+seq as durable identities; wrapping each fault kind into a union was reinventing pointers as enums.

### 7.3 Domain fault events

Every domain that can surface failure emits domain-owned events on its own stream. Representative event types (each domain defines its own body schema):

```
job/<id>                  job.launch.rejected              { provider, reason, message, globalActive, globalLimit }
job/<id>                  job.progress.emitted             { message, stage?, detail? }  — carries coordinator-mediated
                                                                                            domain failures (e.g., KB op
                                                                                            errors inside source-import
                                                                                            or provider-hosted KB work)
session/<id>              session.interrupted              { trigger, continuity }
session/<id>              session.provider_failed          { provider, reason, message }
session/<id>              session.adapter_unparseable      { provider, stdout, stderr, parseError }
discuss/<id>              discuss.agent.job.finished       { agent, jobId, outcome, attempt }
workflow/<id>             workflow.completed               { outcome: 'completed' | 'aborted', stepDetails }
workflow/<id>             workflow.completed               { outcome: 'failed', causeRef, stepDetails }
```

KB failures have no dedicated Journal stream. Slow process-like KB attempts (source import, explicit reindex/curation jobs) record terminal-causing failures on the internal KB job's own stream as rich progress events (`kind: 'domain'`, `stage: 'kb_operation_failed' | 'kb_curation_failed' | ...`), and the job terminal's `causeRef` points to that progress event.
KB work performed inside an existing provider/workflow job records non-terminal failures with `stage: 'hosted_kb_operation_failed'`. Fast direct KB commands that do not create a job return structured command errors. Background curate failures are operational logs, not events — retry is scheduled via `kb_curate_retry_queue` (§3.1). External edits themselves are the **normal** path (Obsidian + git + rescan auto-handle them, see §12.3); only **malformed** content (git conflict markers left in a file, invalid frontmatter) is treated as a skip + log case during rescan, not as an event.

These are NOT declared in a central `CoralFault` union. They are regular domain events with well-known type strings. A renderer that wants to describe a `causeRef` walks the cross-stream chain and dispatches each hop to the owning domain's describer through an injected map:

```ts
// src/causality/render.ts — owns the walk + dispatch vocabulary, imports no domain.
export type EventDescriber = (event: CoralEvent) => string;
export type EventDescriberMap = ReadonlyMap<string, EventDescriber>;  // key: `${stream.kind}:${type}`

export function createCauseRefRenderer(describers: EventDescriberMap): CauseRefRenderer { /* ... */ }

// src/jobs/event-describers.ts — jobs domain owns its describers.
export const jobsEventDescribers: EventDescriberMap = new Map([
  ['job:job.launch.rejected', (e) => describeLaunchRejected(e.body)],
  ['job:job.progress.emitted', (e) => describeJobProgressFault(e.body)],  // KB + other in-job failures
  ['job:job.terminal.recorded', (e) => describeTerminalOutcome(e.body.terminal.outcome, ...)],
  // ... one describer per job event type
]);
// (sessions/event-describers.ts, discuss/event-describers.ts, and workflow/event-describers.ts follow the same shape.)

// src/read-model/event-describers.ts — composition site joins the domain maps.
export const defaultEventDescribers: EventDescriberMap = new Map([
  ...jobsEventDescribers,
  ...sessionsEventDescribers,
  ...discussEventDescribers,
  ...workflowEventDescribers,
]);
```

Causality holds the cross-stream walk (cycle detection, missing-link diagnostics, hop accumulation) and the dispatch primitive. Each domain owns one map of `${stream.kind}:${type}` → describer. The read-model layer joins those maps into the default `EventDescriberMap`, mirroring how `CoralStore` joins per-domain queries. Causality stays acyclic — it imports no domain — and adding a new fault-bearing event is one line in the domain's own describer map.

Adding a new domain with failure modes: define the domain's `event-describers.ts` exporting an `EventDescriberMap`, then add it to the spread in `read-model/event-describers.ts`. No central fault union, no central switch to edit.

### 7.4 Fault ownership (single-producer per event type)

Each fault-bearing event type has one producer:

| Event | Stream | Producer |
|---|---|---|
| `job.launch.rejected` | `job/<id>` | `coordinator/live/admission.ts` |
| `job.progress.emitted` (with `kind: 'domain'`, `stage: 'kb_operation_failed'`/etc.) | `job/<id>` | internal KB job recorder; domain leaf (`kb/ops/`, etc.) supplies detail |
| `job.progress.emitted` (with `kind: 'domain'`, `stage: 'hosted_kb_operation_failed'`/etc.) | `job/<id>` | provider-hosted KB failure recorder; domain leaf (`kb/ops/`, etc.) supplies detail |
| `session.interrupted` | `session/<id>` | `coordinator/services/terminal-materializer.ts` (input from `coordinator/live/provider-hosts.ts`) |
| `session.provider_failed` | `session/<id>` | `coordinator/services/terminal-materializer.ts` (input from provider leaf kernel) |
| `session.adapter_unparseable` | `session/<id>` | `coordinator/services/terminal-materializer.ts` (input from `providers/middleware/adapter-parse-guard.ts`) |
| `discuss.agent.job.finished` (failed/recovery outcomes) | `discuss/<id>` | `discuss/shell/` |
| `workflow.lifecycle_fault` | `workflow/<id>` | the workflow lifecycle finalizer (covering both launch-time `executor.ts` finalization and recovery-time `resumeAll` finalization) |
| `workflow.completed { outcome: 'aborted', stepDetails }` or `{ outcome: 'failed', causeRef, stepDetails }` | `workflow/<id>` | the workflow lifecycle finalizer (a single conceptual producer enacted at two coordinator-owned call sites) |
| `job.terminal.recorded { outcome: { kind: 'job_fault', ... } }` | `job/<id>` | `jobs/reconcile/` (for ghost/lost) or job wrapper (for crashed) |

`workflow.lifecycle_fault` has exactly three body variants:

```ts
workflow.lifecycle_fault {
  body:
    | { kind: 'wrapper_crashed'; message: string; stack?: string }
    | { kind: 'recovery_failed'; message: string; stack?: string }
    | { kind: 'unknown'; message: string }
}
```

KB curation background failures and malformed-content detection during rescan are NOT on the Journal — they are operational logs + entries in `kb_curate_retry_queue` + corpus repair pipeline. Successful external edits (the common case) are transparent: rescan picks up the change, retrieval artifacts reindex, git-sync auto-commits. No events, no errors. Malformed markdown (conflict markers, invalid frontmatter, missing required fields, entrySeq collisions) enters the **corpus repair pipeline** (§6.4.1) — auto-fix where safe, queue manual cases, log unrecoverable.

No layer rewrites another layer's event.

### 7.5 Fault propagation — end-to-end with causal graph

Any subsystem fault reaches any end consumer uniformly by walking the causal graph. No duplication; no wrapping; no re-encoding.

**End-to-end example — KB source import failure inside a workflow**:

The coordinator writes the chain as one closure; the closure scope is the transaction scope:

```ts
progressStore.commit((c) => {
  const kbFailure = c.append(kbOperationFailedProgressEvent(...));
  const kbTerminal = appendJobTerminalRecorded(c, {
    jobId: 'kb-1',
    terminal: { content: '', outcome: failedTerminalOutcome(kbFailure) },
    continuity: null,
  });
  const workflowStepDetails: WorkflowStepDetail[] = [
    {
      stepIndex: 0,
      atomIndex: 0,
      kind: 'agent',
      label: 'KB import',
      provider: 'codex',
      tagName: 'agent',
      output: 'PDF conversion failed before usable content was produced.',
    },
  ];
  const workflowFailure = c.append(workflowCompletedEvent('wf-1', {
    outcome: 'failed',
    causeRef: kbTerminal,
    stepDetails: workflowStepDetails,
  }));
  appendJobTerminalRecorded(c, {
    jobId: 'wf-1',
    terminal: { content: '', outcome: failedTerminalOutcome(workflowFailure) },
    continuity: null,
  });
  return undefined;
});
```

Persisted events after token resolution:

```
seq=101  job/kb-1      job.progress.emitted
                       { kind: 'domain',
                         message: 'KB source import failed during PDF conversion',
                         stage: 'kb_operation_failed',
                         detail: { operation: 'source_import',
                                   path: '/papers/topic.pdf',
                                   cause: { message: 'marker_single exited 1' } } }

seq=102  job/kb-1      job.terminal.recorded
                       terminal: { content: '',
                                   outcome: { kind: 'failed',
                                              causeRef: { stream: {kind: 'job', id: 'kb-1'}, seq: 101 } },
                                   durationMs: 4231 }

seq=103  workflow/wf-1 workflow.completed
                       { outcome: 'failed',
                         causeRef: { stream: {kind: 'job', id: 'kb-1'}, seq: 102 },
                         stepDetails: [
                           { stepIndex: 0,
                             atomIndex: 0,
                             kind: 'agent',
                             label: 'KB import',
                             provider: 'codex',
                             tagName: 'agent',
                             output: 'PDF conversion failed before usable content was produced.' }
                         ] }

seq=104  job/wf-1      job.terminal.recorded
                       terminal: { content: '',
                                   outcome: { kind: 'failed',
                                              causeRef: { stream: {kind: 'workflow', id: 'wf-1'}, seq: 103 } },
                                   durationMs: 8452 }
```

Four events, three of them cause pointers; the originating failure fact lives on the same job's progress stream (self-stream causeRef from seq=102 → seq=101). The transaction guarantees all-or-nothing. KB content itself is not a Journal stream — see §5.5 for the rationale.

**CLI wait rendering** (walks the chain backward from the outermost failure):

```
$ coral-cli wait --jobs wf-1

Job wf-1 failed
  → Workflow wf-1 failed (slot wf-1:1:0 "kb-promote")
    → Job kb-1 failed
      → KB entry-x: promote failed at orama_index_write — index corrupted

  ✓ analyze      wf-1:0:0 completed
  ✗ kb-promote   wf-1:1:0 failed   [kb_operation_failed]
```

The renderer:
1. Reads `JobView(wf-1).terminal.outcome` → `failed` with `causeRef` to `workflow/wf-1@103`.
2. Reads event at `workflow/wf-1@103` → `workflow.completed { outcome: 'failed', causeRef: job/kb-1@102, stepDetails }`.
3. Reads event at `job/kb-1@102` → terminal with `causeRef: job/kb-1@101` (self-stream progress event).
4. Reads event at `job/kb-1@101` → `job.progress.emitted { kind: 'domain', stage: 'kb_operation_failed', detail: { entryId: 'entry-x', cause: {...} } }` — the origin fact.
5. Dispatches each event type to its registered describer through the injected `EventDescriberMap` (§7.3); concatenates the rendered chain.

Slot labels (`"kb-promote"`, `"analyze"`) are derived from each slot's `agent` field on the workflow plan (§6.5) at render time — the plan stores no `labels` map.

### 7.6 Coordinator crash safety

Because every multi-event fault scenario lands in one SQLite transaction, a coordinator crash mid-sequence cannot produce partial truth:

- Crash before `COMMIT` → all events rolled back; replay sees pre-failure state.
- Crash after `COMMIT` → all events durable; replay sees the full chain.

Reconciliation (§12.2) handles the orphan case where a provider wrapper was running but the coordinator crashed before receiving its terminal body. Reconciliation observes the dead process and emits a `job_fault { wrapper_lost }` terminal — a job-local fault, not a causeRef, because the wrapper was supposed to produce a domain event and didn't.

### 7.7 Why causal graph beats composable union

The previously-considered "composable `CoralFault` union" had each domain contribute variants; jobs' terminal outcome wrapped them. That model's costs:

1. **Duplication**: the fault's payload appeared twice — once as the domain event, once wrapped in `CoralFault`. Every field on the domain event had to be mirrored on the union variant.
2. **Synchronization burden**: adding a field on a domain fault event required updating the union variant and its describer. Two places to touch per evolution.
3. **TypeScript coupling**: the top-level union had to import from every domain, creating a central coupling point that readers had to chase.
4. **Loss of atomicity**: even with the union, nothing tied the domain event and the job terminal into one commit — partial truth was possible.

The causal-graph model solves all four:
1. **Single source**: the fault lives once on the originating stream.
2. **No sync burden**: evolving the domain event requires zero changes at the job level.
3. **No central union**: the job terminal references by `CauseRef`, which is a simple `{stream, seq}` pair.
4. **Atomic by construction**: all events in a causal chain land in one SQL transaction (§3.3).

The only price is that CLI renderers dereference at read time. Modest — projections can denormalize the first hop if rendering latency matters, but the authoritative data stays single-sourced.

---

## 8. Provider Contract

```ts
type Provider = (request: ProviderRequest, runtime: ProviderRuntime) =>
  AsyncIterable<ProviderEventBody>;

type ProviderEventBody =
  | { kind: 'progress'; message: string }
  | {
      kind: 'continuity';
      conversationRef: string | null;
      resumable: boolean;
      providerContinuity: unknown;   // opaque provider-private blob
    }
  | {
      kind: 'terminal';
      terminal: JobTerminal;
      diagnostics: JobDiagnostics;
    };

type ProviderMiddleware = (next: Provider) => Provider;

declare function compose(
  ...parts: readonly [...ProviderMiddleware[], Provider]
): Provider;
```

### 8.1 Why a stream

Today's three paths (adapter, session driver, runner) exist because each provider call has three orthogonal concerns: the pure execution, session continuity tracking, and app-server lifecycle. A stream + middleware lets each concern be named once and composed:

```ts
const claudeExecProvider = compose(
  sessionContinuity(claudeExecContinuity),
  adapterParseGuard('claude', isClaudeExecParseError),
  claudeExecKernel,
);

const claudeAppServerProvider = compose(
  sessionContinuity(claudeBrokerContinuity),
  appServerSession(claudeAppServerContract),
  claudeBrokerTurnKernel,
);

const codexThreadProvider = compose(
  sessionContinuity(codexThreadContinuity),
  appServerSession(codexAppServerContract),
  codexTurnKernel,
);
```

Adding a new provider is declaring its middleware stack.

For app-server providers, `sessionContinuity` is the outermost middleware
(not `appServerSession`). This preserves §8.3 invariants #1/#3/#5: a single
continuity authority observes the full downstream stream including
transport-close from `appServerSession` via `runtime.continuityBridge`, so
`continuity` bodies have one emitter. `appServerSession` surfaces typed
close-state through the bridge but never emits `continuity` itself and never
rewrites downstream terminal outcome.

### 8.2 Envelope vs body split

Providers emit **bodies only**. The coordinator wraps each body in an envelope (`seq`, `ts`, `stream`, `refs`) and appends to the journal. This keeps providers pure: they never touch envelopes, seqs, or the journal directly.

### 8.2a Provider terminal vs persisted terminal — `failureCause` materialization

The provider-side terminal carries a different failure shape from the persisted journal terminal because providers cannot construct a `CauseRef` (no Journal seq access). The split:

```ts
// Provider-side body (src/providers/contract.ts)
type ProviderTerminalEventBody = {
  kind: 'terminal';
  terminal: { outcome: ProviderTerminalOutcome; ... };
  diagnostics: JobDiagnostics;
  failureCause?: ProviderFailureCause;   // populated iff outcome.kind === 'failed'
};

type ProviderTerminalOutcome =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason: AbortReason }
  | { kind: 'provider_exit'; code: number; note?: string }
  | { kind: 'failed' }                   // ← no causeRef on provider side; failureCause sibling carries the payload
  | { kind: 'job_fault'; fault: { kind: 'wrapper_lost' } };

type ProviderFailureCause =              // discriminated by 'type' (the domain event name)
  | { type: 'session.adapter_unparseable'; body: { provider, exitCode, stdout, stderr, parseError } }
  | { type: 'session.provider_failed';    body: { provider, reason: 'session_unavailable' | 'request_failed', message } };
```

The coordinator's `terminal-materializer` (`src/coordinator/services/terminal-materializer.ts`) maps provider-side to persisted inside a single `commit(cb)` closure:

1. **`completed` / `aborted` / `provider_exit`** — pass through unchanged; no domain event appended; persisted `JobTerminal.outcome` mirrors provider-side.
2. **`failed`** — `failureCause` is required (the materializer throws `Provider terminal failed without a canonical failureCause` if absent). The materializer routes by `failureCause.type` to the matching domain event constructor (`sessionAdapterUnparseableEvent`, `sessionProviderFailedEvent`), appends the domain event to its owning stream (e.g., `session/<id>`) inside the same commit closure, captures the returned `seq`, and persists `JobTerminal.failed { causeRef: { stream: { kind: 'session', id }, seq } }` on the job stream. Both events share one transaction — the cause and the terminal are durable as a unit or neither is.
3. **`job_fault: wrapper_lost`** — synthesized by `compose()` (§8.3 #1) when the provider stream closes without `terminal`. Materializer plans this as `JobLifecycleFault('wrapper_lost')` directly on the job terminal; no domain event is appended on a foreign stream because there isn't one to point at.

**Why the split**: providers must stay pure (no journal handles). Domain events must stay first-class (no fault payload duplication on the job terminal — invariant #11). The materializer is the only place these two contracts meet, and it does so transactionally.

### 8.3 Invariants

1. Every provider stream emits exactly one `terminal`, and it is last. **`compose()` (`src/providers/contract.ts`) is the home of the enforcement** — it owns the chain end-to-end and synthesizes `JobLifecycleFault('wrapper_lost')` when the kernel closes without `terminal`. Per-middleware defensive checks are not the right home.
2. `continuity` bodies are full snapshots. If `resumable: true`, `conversationRef` must be non-null.
3. Generic middleware never rewrites a downstream terminal outcome.
4. Abort enters once through `runtime.signal`; no extra public interrupt surface.
5. Terminal body never mutates session state — session state is mutated only by `continuity` bodies.
6. A provider terminal with `outcome.kind === 'failed'` MUST carry a non-null `failureCause`; the materializer rejects malformed terminals at the boundary so no malformed `JobTerminal.failed` ever reaches the journal.

---

## 9. Projections and Consumers

Projections are derived read models. Each projection is bound to one authority (Journal or Corpus). Two consumer interfaces reflect the two authorities' different truth shapes.

### 9.1 Journal projections and consumer interface

Journal projections come in two shapes that share authority and cursor mechanics but differ in who runs the reducer:

**Base journal projections** (`projection_jobs`, `projection_sessions`, `projection_discuss`, `projection_workflows`) are written by the commit-time reducer inside `BEGIN IMMEDIATE` (§3.3, §12.1). The consumer is **cursor-only**: it owns no `apply()` body in production — `ConsumerDriver` advances its `consumer_cursors` row directly on `notify(authority, version)`. The consumer's role is to surface freshness through `waitFreshUntil`, not to re-execute the reducer.

**Expansion-tier journal consumers** (added by an installed engine that derives its own state from journal events) use range-based replay through `apply(ctx: { upToSeq, signal })`. They are the only journal consumers that run `apply` in production.

```ts
type JournalConsumer = JournalCursorConsumer | JournalApplyConsumer;

// Base journal projections — production never invokes apply.
interface JournalCursorConsumer {
  id: string;
  kind: 'cursor';
  // No apply body. Cursor advances on notify; the reducer already ran inside commit().
}

// Expansion-tier journal consumers — range replay against the events table.
interface JournalApplyConsumer {
  id: string;
  kind: 'apply';
  apply(ctx: { upToSeq: number; signal: AbortSignal }): Promise<void>;
  // Implementation: SELECT * FROM events WHERE seq > cursor AND seq <= upToSeq; apply in order.
}
```

Projection tables carry materialized read-model columns for stable-at-launch identity fields + lifecycle summary. Event body is authoritative; projection is derived via reducer + replay identity.

Projection types (all maintained in SQLite):

```ts
type JobView = {
  jobId: string;
  sessionId: string | null;
  provider: string | null;
  projectRoot: string;
  backendNamespace: string;
  bundleHash: string | null;
  jobKind: 'provider' | 'workflow' | 'kb';
  phase: 'queued' | 'running' | 'completed' | 'error' | 'aborted';
  terminal: JobTerminal | null;
  diagnostics: JobDiagnostics | null;
  parentWorkflowJobId: string | null;
  workflowSlot: string | null;     // points into the parent workflow's plan
  createdAt: string;
  lastSeq: number;
};

type WorkflowView = {
  workflowId: string;
  plan: WorkflowPlan;
  slotOutcomes: Record<string, SlotOutcome>;   // slotId → outcome derived from child jobs
  outcome: 'running' | 'completed' | 'failed' | 'aborted';
  causeRef: CauseRef | null;
  lastSeq: number;
};

type SlotOutcome = {
  jobId: string | null;
  phase: JobView['phase'];
  causeRef: CauseRef | null;
};

type SessionView = {
  sessionId: string;
  controller: string;
  provider: 'claude' | 'codex';
  resumable: boolean;
  conversationRef: string | null;
  scopeKey: string;
  lastSeq: number;
};

type WaitCursor = { afterSeq: number };   // single global cursor for Journal tailing
```

### 9.2 Corpus projections and consumer interface

Corpus projections are maintained by `CorpusConsumer`s with snapshot-based content-hash diffing. The manifest-diff + atomic-snapshot-swap logic is ported from today's `ensureVectorIndex`; the invocation model inverts from pull (search-time lazy) to push (coordinator notify after Corpus writes). Diff half is a port; trigger half is a rewrite.

```ts
interface CorpusConsumerApplyContext {
  snapshot: CorpusSnapshot;
  journalReader: JournalConsumerReadPort;
  corpusStateReader: CorpusStateReadPort;
  projectionInput: KbProjectionInput;
  signal: AbortSignal;
}

interface CorpusConsumer {
  id: string;
  apply(ctx: CorpusConsumerApplyContext): Promise<void>;
  // Implementation:
  //   1. The coordinator builds `snapshot` while the Corpus mutation lock is held
  //      (§6.4) and notifies after release; `apply` runs OUTSIDE the lock.
  //   2. Read only through typed ports: journalReader, corpusStateReader, projectionInput.
  //   3. Diff against last-applied manifest persisted alongside the consumer's storage.
  //   4. Re-embed / re-index only changed entries (heavy work; never under any lock).
  //   5. Atomic snapshot swap.
  //   6. Return cleanly; ConsumerDriver advances the durable cursor.
}

type CorpusSnapshot = {
  snapshotId: string;            // stable hash over (seqs + manifests); equality across runs
  contentSeq: number;
  metadataSeq: number;
  contentManifestHash: string;   // detects same-seq identity changes (e.g. external rebuild)
  metadataManifestHash: string;
};
```

The concrete `CorpusConsumerApplyContext` carries `journalReader`, `corpusStateReader`, and `projectionInput`; it does not expose a raw SQLite database to Corpus consumers ([`src/store/consumer-contract.ts:113`](../../src/store/consumer-contract.ts#L113)-[`src/store/consumer-contract.ts:132`](../../src/store/consumer-contract.ts#L132)). `ConsumerDriver` owns the cursor rows and advances them only after a clean apply return ([`src/coordinator/consumer-driver.ts:237`](../../src/coordinator/consumer-driver.ts#L237)-[`src/coordinator/consumer-driver.ts:286`](../../src/coordinator/consumer-driver.ts#L286), [`src/coordinator/consumer-driver.ts:1199`](../../src/coordinator/consumer-driver.ts#L1199)-[`src/coordinator/consumer-driver.ts:1218`](../../src/coordinator/consumer-driver.ts#L1218)). `projectionInput` is a typed materialized KB projection input, not an engine-visible authority reader ([`src/kb/projection-input-contract.ts:21`](../../src/kb/projection-input-contract.ts#L21)-[`src/kb/projection-input-contract.ts:42`](../../src/kb/projection-input-contract.ts#L42), [`src/kb/projection-input.ts:95`](../../src/kb/projection-input.ts#L95)-[`src/kb/projection-input.ts:112`](../../src/kb/projection-input.ts#L112)).

**Why `snapshot` and not just `(contentSeq, metadataSeq)`**: consumers diff at the entry level, so they need stable access to the Corpus view at the target versions, not only the version pair. The richer identity (`snapshotId` + manifest hashes) also detects same-seq identity changes that arise from rescan/repair/git-pull paths where seq does not advance but content does. Consumers no longer persist their own cursor through a DB handle; `ConsumerDriver` persists it after the atomic swap succeeds.

Engine-facing `KbRuntime` is narrowed to `KbEngineRuntime`: runtime bindings, projection artifact storage, `corpusProjectionReader`, and typed cursor readers only ([`src/kb/contract.ts:134`](../../src/kb/contract.ts#L134)-[`src/kb/contract.ts:148`](../../src/kb/contract.ts#L148), [`src/expansion/host.ts:65`](../../src/expansion/host.ts#L65)-[`src/expansion/host.ts:78`](../../src/expansion/host.ts#L78)). Engines do not receive `KbRuntime`'s raw DB implementation detail, authority mutation/rebuild methods, authority read methods, or authority path/storage surfaces; those remain KB-domain orchestration surfaces ([`src/kb/contract.ts:155`](../../src/kb/contract.ts#L155)-[`src/kb/contract.ts:219`](../../src/kb/contract.ts#L219)).

**Lock discipline (canonical, see §6.4 and invariant #19)**: the Corpus mutation lock contains only authoritative writes, version bumps, and lightweight metadata/index state. `CorpusConsumer.apply` is invoked AFTER the lock releases. A consumer that promised retrieval freshness participates in `waitFreshUntil('corpus', snapshot, consumerId)` only after its cursor advances to a snapshot whose stable identity ≥ the awaited target.

Projection types:

- FTS projection bound at `kb.fts` (bundled Orama).
- Vector projection bound at `kb.vector` by installed engines (e.g., needle).

The per-consumer manifest (hashes of processed entries) lives beside the consumer's storage — e.g., `~/.coral/data/kb/needle/snapshots/<snapshot>/manifest.json` for installed needle snapshots, with staging under `~/.coral/data/kb/needle-staging/<snapshot>/manifest.json` during rebuild.

### 9.3 Why two consumer interfaces

Journal events are discrete and ordered; range replay is natural. Corpus entries are continuous and mutable; snapshot diff is natural. Forcing one interface on both would distort at least one — replay semantics on mutable files loses atomicity; snapshot semantics on event history discards the causal chain.

Across the journal-cursor, journal-apply, and corpus-apply shapes, the shared properties are:
- Durable cursor (in `consumer_cursors` with `authority` field).
- Condition-variable `waitFreshUntil(authority, version, consumerId)` wake mechanism.
- Fault-isolated execution (consumer failure never blocks authority writes).

`apply()` idempotency (invariant #44) applies to **apply-kind consumers only** — expansion-tier `JournalApplyConsumer`s and `CorpusConsumer`s. Base journal cursor-only consumers do not run `apply()` in production: their projection rows are written by the commit-time reducer inside the same `BEGIN IMMEDIATE` that appends the events (§3.3, §12.1), so no apply/cursor persistence gap exists for them to tolerate.

### 9.4 "Completed" is defined

> A job is **completed** iff: the wait path has observed a `job.terminal.recorded` event for the stream AND the projection after applying that seq has `outcome.kind === 'completed'` or (`outcome.kind === 'provider_exit' && code === 0`).

A workflow is **completed** iff its `workflow.completed` event lands with `outcome: 'completed'`.

No stored "is complete" boolean anywhere. Projections compute it from event presence.

Corpus freshness waits target either `KbCorpusSnapshot` or `{ snapshot: KbCorpusSnapshot; atLeastGeneration: number }`. The generation-bearing target is the readiness side of unchanged-snapshot projection-artifact repair: `forceCorpusApply(snapshot, { reason: 'projection-artifact-lag', consumers })` is synchronous orchestration that schedules targeted applies and returns `{ generation, consumers }`, while the await happens through the same `ConsumerDriver.waitFreshUntil('corpus', { snapshot, atLeastGeneration }, consumerId)` primitive ([`src/coordinator/consumer-driver.ts:68`](../../src/coordinator/consumer-driver.ts#L68)-[`src/coordinator/consumer-driver.ts:85`](../../src/coordinator/consumer-driver.ts#L85), [`src/coordinator/consumer-driver.ts:477`](../../src/coordinator/consumer-driver.ts#L477)-[`src/coordinator/consumer-driver.ts:506`](../../src/coordinator/consumer-driver.ts#L506), [`src/coordinator/consumer-driver.ts:1180`](../../src/coordinator/consumer-driver.ts#L1180)-[`src/coordinator/consumer-driver.ts:1196`](../../src/coordinator/consumer-driver.ts#L1196)). The default timeout and error-code bounds in §16 #41c apply unchanged to both Corpus target variants.

### 9.5 Children are derived, not stored

`JobView` does NOT carry a `children` array. Child jobs are discovered by SQL query:

```sql
SELECT job_id, phase, workflow_slot FROM projection_jobs WHERE parent_workflow_job_id = ?
```

`WorkflowView.slotOutcomes` is built by `workflow/read-queries.ts`: join `projection_workflows.plan` to child rows in `projection_jobs` via `parent_workflow_job_id` / `workflow_slot`, then render each slot outcome from the child `JobView` state. No denormalization onto the parent.

### 9.6 Why a single `WaitCursor.afterSeq`

Journal events have a single global `seq`. One number describes "what I have seen so far" for any Journal tail subscription. Corpus reads don't need a cursor — they observe current state directly.

### 9.7 Why no denormalized child array on `JobView`

With events in a database, joining child jobs onto a parent is a single indexed SQL query — cheaper than carrying a denormalized array that drifts under concurrent child terminations. `JobView` stays lean; `WorkflowView` owns the aggregate read model.

The read model lives in `workflow/read-queries.ts`. Workflow-domain reducers own only workflow stream state (`projection_workflows.plan`, workflow completion), while child job lifecycle state remains in `projection_jobs`.

---

## 10. Topology

This section specifies WHAT each top-level directory owns. It does **not**
prescribe per-file layout — the canonical source of file lists is the
directory itself, and per-domain internal structure follows §10.4
(naming/subdivision policy). Earlier drafts of this section enumerated
every file; that prescription accumulated drift, forced anti-cohesion
splits (e.g., 2-file subdirs), and created competing canonical homes
for the same concept. The ownership table below is the authority; §10.4
governs how each domain shapes itself internally.

### Top-level layout

The tree is rooted at the plugin/repository root:

```
hooks/           ← plugin-root hook scripts; self-contained Node ESM that may
                   duplicate stable path formulas but never import from `src/`
src/
  coordinator/   ← single-writer daemon; live state, cross-domain composition,
                   warm-start lock, projection consumer driver, expansion
                   lifecycle, shutdown sequencing, request/repair services
  store/         ← SQL/Journal substrate over SQLite (event DB, schema loader,
                   transactional append, projection consumer registration)
  causality/     ← cross-domain `CauseRef` vocabulary + chain-walking renderer
                   (imports no domain; describers injected via read-model)
  read-model/    ← product read facade composing per-domain read queries +
                   Corpus reads + cause-ref describer map. No write authority.
  transport/     ← carriage only (HTTP, IPC, JSON-RPC envelope, SSE, RPC
                   catalog dispatch). Imports contracts; never domain shells.
  runtime/       ← `Runtime` port interfaces (time, storage, paths, process,
                   ids, env) + production `createRealRuntime` adapter
  infra/         ← flat low-level helpers with no domain knowledge
                   (paths, errors, fs locks, env sanitizers, identifiers,
                   build-flavor, plugin registry, backend discovery format)
  jobs/          ← domain: job lifecycle events + projections + reconcile +
                   imperative shell (launch/wait/abort)
  sessions/      ← domain: session events + projections + resolve + shell
  discuss/       ← event-sourced discussion (state machine + reducer + four
                   sub-workflow flows + live-session registry)
  workflow/      ← workflow syntax (parser/AST/normalize/compile) + plan +
                   executor + reconcile, owns its own event vocabulary
  kb/            ← Corpus authority — Corpus I/O, curate scheduler,
                   capability surfaces and KB-tier search helpers,
                   user-facing ops (memo/promote/source-import/reindex)
  engines/       ← per-engine source trees (orama, needle, gemini, onnx) under <id>/
  providers/     ← provider plugin boundary (contract, registry, catalog,
                   per-provider adapters: claude/codex/claude-appserver)
  expansion/     ← uniform Expansion contract + bundled-engine manifest
                   registry consumed by `coordinator/expansion/lifecycle.ts`
  cli/           ← Commander CLI client (one-shot process); resolves plugin
                   root, classifies command, dispatches to coordinator IPC
                   or library-direct read paths

tools/
  simulation/    ← debug-only executable harness; never bundled into the
                   coral-cli plugin. Owns its own runtime doubles, scenario
                   schema, deterministic run loop. Production code never
                   imports from here.
  testing/       ← test helpers shared across vitest suites; never imported
                   by production src/.
```

### Cross-domain ownership rules

The full ownership matrix lives in §2.6 (Ownership Matrix). Restated for the
topology lens:

- **Coordinator** is the only layer allowed to compose multiple domains and
  transport at once. It owns no domain vocabulary.
- **Store** owns the Journal SQL substrate; domains own their event
  vocabulary, append validators, and projection reducers.
- **Causality** owns `CauseRef` and the renderer; describers are injected
  from each domain through `read-model/event-describers.ts`.
- **Read-model** composes per-domain read queries; it never writes.
- **Transport** (HTTP/IPC) carries requests; it imports contracts only.
- **Runtime/infra** sit below domains; they import nothing from domains,
  transport, coordinator, or cli.

Per-file lists are *generated* from the actual codebase, not specified
here. When a new responsibility appears, §10.4 governs whether it warrants
a new file, where it goes, and whether a subdirectory is justified.

### 10.1 What is deleted

- `src/execution/` — dissolves into `coordinator/`, `jobs/`, `sessions/`, `transport/`, and debug-only `tools/simulation/`
- `src/shared/` — every file relocates to a domain or `infra/` or `testing/`
- `src/client/` — replaced by domain-owned read queries + `read-model/` + `transport/ipc/client.ts` + `transport/http/client.ts`
- `src/bridge/` transport — replaced by `transport/`
- `recovery-core.ts` — replaced by `jobs/reconcile/` + `store/rebuild.ts`

### 10.1a Large-module decomposition (>500 lines as a review signal)

Current code has several files in the 20K-60K range. The table below records the historical decomposition — destination domains rather than per-file prescriptions, since real decomposition splits by responsibility boundaries (governed by §10.4), not single-file relocation.

The 500-line mark is a **review trigger, not a hard split rule**. A file over that size is acceptable when it is a cohesive unit: one state machine, one domain algorithm, one controller with shared mutable state, or one implementation whose private helpers are only meaningful inside that flow. Splitting such a file can make the design worse by exporting private state, creating artificial seams, or forcing readers to jump across files to understand one concept.

Split when the file has multiple independent reasons to change: persistence plus scheduling, parsing plus transport, policy plus I/O, unrelated command handlers, or runtime functions whose names no longer share a single owner. Prefer a slightly larger cohesive file over many small files connected by vague exports.

| Current | Size | Decomposed destinations |
|---|---|---|
| `src/execution/service.ts` | 56K | `jobs/shell/launch.ts`, `jobs/shell/wait.ts`, `jobs/shell/workflow.ts` (via `workflow/executor.ts`), `sessions/shell/store.ts`, `sessions/resolve.ts`, `coordinator/execution-service.ts`, `coordinator/workflow-cleanup.ts`, `coordinator/contracts.ts`. The god-class dissolves into coordinator service helpers plus domain-shell modules; no unused public facade remains. |
| `src/execution/http-handler.ts` | 51K | `transport/http/handler.ts` (table-driven route dispatch), `transport/http/query-coerce.ts`, `transport/response.ts`, `transport/server-ports.ts`, `transport/validation.ts`, `transport/http/sse-subscribe.ts`. |
| `src/execution/engine.ts` | 34K | `coordinator/live/admission.ts` (launch admission + queue), `coordinator/live/durable-transport.ts` (DurableExecutionTransport seam), `coordinator/live/worker-limits.ts` (MAX_WORKERS / DISCUSS_MAX_WORKERS policy). |
| `src/execution/host-manager.ts` | 16K | `coordinator/live/provider-hosts/` subtree — `pool.ts`, `lease.ts`, `idle.ts`, `drain.ts`, `recovery.ts`, `state.ts`. |
| `src/execution/progress-store.ts` | 24K | REMOVED — job lifecycle events replace six-file progress. `jobs/shell/wait.ts` owns live-tail + SSE. `jobs/reconcile/` owns startup classification. |
| `src/execution/runtime.ts` | 22K | `runtime/ports.ts` (interface) + `runtime/real.ts` (production implementation). Current composition stays roughly this size; no further split needed since it is interface + single implementation. |
| `src/workflow/pipe-executor.ts` | 37K | Decompose along the natural seams in the current code (atom launch/retry coupling at `launchAtomWithRetry`, wait-state at `createAwaitStepState`, stale recovery at `recoverStaleAtom`, multi-atom wait at `waitForAtoms`): `workflow/executor.ts` (top-level orchestration), `workflow/launch.ts` (atom launch + retry — they are intertwined, not separable), `workflow/wait.ts` (await-step state + multi-atom wait + cascade), `workflow/recover.ts` (stale-atom recovery). Fault mapping lives inside whichever module emits the fault, not in a separate `error.ts`. |
| `src/providers/claude-appserver/session.ts` | 35K | `SingleSessionController` is a coherent unit — turn lifecycle, interrupt handling, and child binding share mutable state (`activeTurn`, `childBinding`, `bootstrapSignature`). Forcing a 4-way split would recouple through exported state. Natural split is 2-way: `providers/claude-appserver/controller.ts` (the controller class — turn + interrupt + child lifecycle as one unit) and `providers/claude-appserver/protocol.ts` (wire/control protocol handling). Continuity snapshot logic is a method on the controller, not a separate file. |
| `src/kb/curate/community-detection.ts` | 37K | Same file; algorithm cohesion > arbitrary split. Sub-routines stay here. |
| `src/kb/curate/classification.ts` | 34K | Same file. Domain algorithm. |
| `src/kb/curate/state.ts` | 31K | REDUCED — curate state moves to `kb_curate_scheduler` + `kb_curate_retry_queue` SQLite tables (§3.1). Remaining in-memory state logic collapses to ~5K. |
| `src/execution/simulation/world.ts` + `core/*` | ~80K | `tools/simulation/runtime.ts`, `tools/simulation/runner.ts`, `tools/simulation/recording.ts`, `tools/simulation/adversarial.ts`, `tools/simulation/core/memory-storage.ts`, `tools/simulation/core/mock-app-server.ts`, `tools/simulation/core/mock-process.ts`, `tools/simulation/core/virtual-time.ts`. Simulation is a debug-only executable harness outside `src`; production code never imports it. |
| `src/execution/discuss/subflows.ts` | 26K | `discuss/shell/bid-flow.ts`, `discuss/shell/speech-flow.ts`, `discuss/shell/followup-flow.ts`, `discuss/shell/synthesis-flow.ts`. One file per sub-workflow. |
| `src/execution/discuss/session-store.ts` | 18K | `discuss/shell/session-store.ts` (persistence glue) + `discuss/shell/live-registry.ts` (attached-session + watch buffers). |

**Principle**: file size is an input to review, not the architecture. Decompose only along real responsibility boundaries and name each extracted file after the responsibility it owns. See §10.4 for the full naming and subdivision policy.

### 10.2 Layering invariants

1. `src/runtime/*` and `src/infra/*` import nothing from domains, transport, coordinator, or cli.
2. Domain contract modules (`jobs/events.ts`, `sessions/events.ts`, `providers/contract.ts`, etc.) import only `infra/*`, `runtime/*`, and each other explicitly.
3. Domain `X/shell/*` may import `X/*` (its own contracts) but not `Y/shell/*` (sibling shells).
4. `src/transport/*` imports domain contracts only, never domain shells or coordinator.
5. `src/coordinator/*` is the only layer allowed to import broadly across domains.
6. `tests/helpers/*` is never imported by production files.
7. Content-blank filenames are forbidden anywhere in `src/` — `helper.ts`, `helpers.ts`, `utils.ts`, `shared.ts`, `shared-utils.ts`. These names describe nothing about content and act as magnets. See §10.4 for the broader naming policy (including which conventional names ARE allowed and why).

### 10.3 Type ownership principles

These principles prevent `shared/` re-emergence without introducing a central registry or CI gate. Enforcement is the architecture-boundary test plus TypeScript's own import graph.

1. Every exported type is declared in exactly one file. No re-declaration, no sibling duplication.
2. A type belongs to its **owning domain** — the domain whose semantics the type encodes. Other domains reference it by import, never redefine it.
3. When a concept genuinely spans two domains, it belongs in the lower domain on the import DAG. If no domain is clearly lower, split the concept.
4. `infra/*` owns only utility types (paths, errors, ids). Domain types never live there.
5. `runtime/*` owns only port interfaces. Concrete implementations do not add to this layer.
6. The only cross-cutting reference vocabulary is `CauseRef` (`{stream, seq}`), declared in `src/causality/cause-ref.ts` and re-exported where domain APIs need it. All other fault information lives on domain events — there is no central fault union.

The architecture-boundary test verifies: (a) no type declared in two places, (b) no content-blank filenames anywhere in `src/` (`helper.ts`, `helpers.ts`, `utils.ts`, `shared.ts`, `shared-utils.ts` — see §10.4), (c) layer import rules (§10.2) hold, (d) per-file size invariants on specific magnet-prone files (e.g., `providers/contract.ts` capped at 450 lines). That is the whole enforcement surface — no normative registry, no CI gate on a map.

### 10.4 Naming and subdivision policy

The Source Tree (§10) is shaped by two complementary forces: every file declares its scope, and cohesive subsystems get their own directory. The rules below are how we keep both true as the codebase grows.

**Forbidden filenames (content-blank)** — describe nothing about what the file holds, accumulate unrelated logic, become magnets:
- `helper.ts`, `helpers.ts`, `utils.ts`, `shared.ts`, `shared-utils.ts`
- Enforced by `tests/invariants/architecture-boundary.test.ts`.

**Allowed filenames (scope-bound)** — discipline is on *content/size*, not *name*:
- `index.ts` — conventional entry/orchestrator for a cohesive subsystem dir (mainstream JS/TS pattern). Allowed at any depth. Don't use it to hide internal coupling — it's the public surface, not a barrel that re-exports everything.
- `types.ts` — type vocabulary for the parent dir. Allowed at any depth; the directory provides scope. If the file grows beyond cohesion (unrelated types accumulate), MUST split.
- Domain canonicals like `events.ts`, `reducer.ts`, `projections.ts`, `read-queries.ts`, `paths.ts`, `errors.ts`, `contracts.ts`, `protocol.ts`, `client.ts`, `server.ts` — the directory provides scope (e.g., `kb/contracts.ts` ≠ `coordinator/contracts.ts`).
- Domain-prefixed siblings like `exec-types.ts`, `manifest-types.ts`, `driver-types.ts` — the prefix declares scope independent of dir.

**Magnet vs registry**: when a file holds a *typed-identifier registry* (HTTP status codes, POSIX errno, `CoralSetupError` documented codes), accumulation is the *correct* shape — that is what a canonical registry looks like. Don't split it per-domain just because the codes name domain things; the codes are wire-level identifiers, not domain logic. The magnet anti-pattern only applies when a file absorbs *unrelated logic* through a content-blank name. (Counter-example we got wrong once: an early attempt split `runtime/errors.ts` into per-domain catalogs to "avoid magnet" — it created a cycle and proliferated files. The catalog stays as one registry; it is not a magnet, it is a registry.)

**Filename honesty** — a file's name must describe what it actually does, not what its history suggests:
- A "`client.ts`" that doesn't talk to a transport but routes a classified verb is named wrong (real example: `cli/command-client.ts` → `cli/dispatch.ts`).
- A "`main.ts`" that exports `buildProgram` and isn't the actual process entry is named wrong (`cli/main.ts` → `cli/program.ts`; `bootstrap.ts` IS the entry).
- Redundant scope qualifiers within an already-scoped directory are noise (`cli/read-coral-store.ts` → `cli/read-store.ts`).
- When in doubt, ask: would a reader who never opened this file guess its role from the name alone?

**Subdivision triggers** — promote an implicit prefix cluster to an explicit subdirectory when:
- ≥4 sibling files share a prefix and form a cohesive subsystem (one bounded responsibility split into facets), AND
- The cohesion is real (each file owns a distinct facet of the same subsystem; the prefix isn't just "files involved in the same general topic"), AND
- The shared prefix becomes redundant under the subdir (`community-detection.ts` → `community/detection.ts` reads identically).

When subdividing:
- Strip the now-redundant prefix from each file.
- If one file is the orchestrator/public-API, name it `<subdir>/index.ts`.
- If the cluster has no single orchestrator, all files are siblings under the subdir.
- Update intra-cluster imports to `./X.js` (sibling), parent-dir imports to `../X.js`, grandparent and beyond to `../../X.js` (or absolute via `#src/...`).

3 files = borderline (subdivide only if cohesion is unmistakable and the cluster is clearly bounded — e.g., needle equipment in `src/engines/needle/`). 2 files = no.

**Subdivision rejection** — a few cases where subdividing makes the tree *worse*:
- `infra/` is the canonical low-level dump by design; subdividing into `infra/paths/`, `infra/errors/`, etc. creates competing canonical homes inside a layer that should stay flat.
  - *Exception*: `infra/path/` is permitted as a cohesive path-composition subsystem (already 5 files: `compose`, `coordinator`, `engine`, `root`, `store`). The exception applies to subsystems where the directory name names a clear internal concept and the file count justifies a subdir; it does NOT permit `infra/utils/`, `infra/helpers/`, or other content-blank groupings.
- The 4 Journal-stream domains (`jobs`, `sessions`, `discuss`, `workflow`) share a *minimum* shape — `events.ts` (event vocabulary + DomainEventRegistry) and `read-queries.ts` (query API) at the domain root, plus `event-describers.ts` for cause-ref rendering. Beyond that minimum, each domain adds files to fit its own complexity, not a forced template:
  - `projections.ts` exists when the domain projects events to SQL tables and owns DB-write reducers (sessions/discuss/workflow). When it exists, it ALSO holds view builders and projection reads.
  - `reducer.ts` exists only when the domain reconstructs in-memory state from events (a state-machine pattern — currently only `discuss/`). Domains that project directly to SQL don't need a separate pure reducer.
  - `paths.ts` exists when the domain owns filesystem paths (currently only `jobs/` for scratch job artifacts being phased out).
  Don't gratuitously add files just to mirror discuss/'s shape across domains that don't have the same concerns. Don't subdivide one domain differently from the others *for its core projection surface* — but the per-domain extras above (parser/, recover/, etc.) are fine when they reflect actual responsibility, not invented uniformity.
- "Pure label" subdirs (e.g., grouping unrelated files into `gateway/` or `io/` because they "feel related") add navigation cost without scope clarity.

**Lifecycle/process-flow naming** — when a directory owns a pipeline, name files for the stage they sit at so the directory reads top-down as the request flow. Example: `cli/` reads `bootstrap → program → commands/ → flags → parse → classify → dispatch → format → emit → follow`. Each filename answers "what stage am I at?" without ambiguity.

**Discipline is content/size, not name** — when a file *does* drift (unrelated logic absorbed, file grows large, cohesion lost), the response is to split it; the response is not to invent a new mechanical naming rule. Add a per-file size invariant to `tests/invariants/architecture-boundary.test.ts` if a specific file is at risk (precedent: `providers/contract.ts` capped at 450 lines).

---

## 11. Transport Semantics

Not topology-based (no `--local` flag); **command-class-based**:

| Class | Transport | Example commands |
|---|---|---|
| Read-only, fresh-enough | Library-direct (in-proc `CoralStore`) | `jobs list`, `jobs detail`, `kb search`, `kb read`, historical `discuss read` |
| Mutating or live-stream | IPC (Unix socket → coordinator RPC) | `codex`, `claude`, `resume`, `fork`, `workflow`, `abort`, `wait`, live `discuss` |

**The CLI has exactly these two command classes.** There is no third "remote" class. The HTTP gateway (§11.3) exposes the same coordinator RPC to **non-CLI consumers** — `coral-reef` and any future browser/external client. The `coral-cli` CLI itself never dispatches over HTTP. Remote-CLI — `coral-cli` on machine A talking to a coordinator on machine B — is **not a supported scenario by principle**, not represented in `CommandClass`, and not planned. Cross-host invocation uses SSH (`ssh user@host coral-cli ...`), the standard Unix answer; Coral declines to introduce a parallel network-routing path inside its own CLI to duplicate what SSH already provides. The architectural seam between local user (CLI) and networked consumer (gateway) lives at the *server* — IPC and HTTP both serve coordinator RPC — not at the client.

### 11.1 Why command-class routing

"If daemon is running, use it; otherwise bypass" is wrong because the same command means different things based on daemon presence. Every command declares its class; transport follows. A read that went library-direct yesterday still goes library-direct today.

### 11.2 Single-writer discipline preserved

Only the coordinator may:
- Append events to the journal.
- Mutate live session state.
- Acquire provider hosts.
- Admit launches.

Direct readers observe projections at `seq N`. Coordinated calls acknowledge after journal append. Two terminals launching `codex` simultaneously serialize through the coordinator; launched-in-shell-A + waited-in-shell-B stays coherent because both go through the same `afterSeq` cursor.

Local IPC bootstrap is discover-or-launch via `coordinator.json` plus socket readiness. The coordinator singleton lock (`coordinator.lock`) is a launch gate and ownership handoff mechanism for replacement; it is not the readiness detector. CLI-side `ensure` logic must not poll a lock file as a health signal.

The IPC ensure path is a reconciler, not a lock-file poller. `reconcile(observation, desired, controllerState)` dispatches over `observation.type` and returns an `action.type` plus next controller state ([`src/transport/ipc/ensure.ts:431`](../../src/transport/ipc/ensure.ts#L431)).

Vocabulary is the implementation vocabulary:
- `DaemonObservation`: `absent | starting | sick | healthyCompatible | healthyIncompatible | staleLock | corruptLock` ([`src/transport/ipc/ensure.ts:87`](../../src/transport/ipc/ensure.ts#L87)).
- `DaemonAction`: `wait | requestShutdown | ensureReplacement | clearStaleLock | forceReplace | failUnsafeReplacement | quarantineCorruptLock | converged` ([`src/transport/ipc/ensure.ts:101`](../../src/transport/ipc/ensure.ts#L101)).
- `ControllerState`: `sickSince`, `sickPid`, `unverifiedSince`, `shutdownRequestedFor`, `corruptLockRetries`, `corruptLockQuarantined`, `replacedInstanceId`, `replacementPending`, `verifiedSickOwnership` ([`src/transport/ipc/ensure.ts:115`](../../src/transport/ipc/ensure.ts#L115)).

Transition diagram (`observation.type` → `action.type`):

| Observation | Action | Case arm |
|---|---|---|
| `absent` | `ensureReplacement` | [`src/transport/ipc/ensure.ts:444`](../../src/transport/ipc/ensure.ts#L444)-[`src/transport/ipc/ensure.ts:451`](../../src/transport/ipc/ensure.ts#L451) |
| `starting` with `replacementPending` | `ensureReplacement` | [`src/transport/ipc/ensure.ts:453`](../../src/transport/ipc/ensure.ts#L453)-[`src/transport/ipc/ensure.ts:460`](../../src/transport/ipc/ensure.ts#L460) |
| `starting` without `replacementPending` | `wait` | [`src/transport/ipc/ensure.ts:461`](../../src/transport/ipc/ensure.ts#L461) |
| `healthyCompatible` | `converged` | [`src/transport/ipc/ensure.ts:464`](../../src/transport/ipc/ensure.ts#L464)-[`src/transport/ipc/ensure.ts:468`](../../src/transport/ipc/ensure.ts#L468) |
| `healthyIncompatible` first observation for an instance | `requestShutdown` | [`src/transport/ipc/ensure.ts:471`](../../src/transport/ipc/ensure.ts#L471)-[`src/transport/ipc/ensure.ts:477`](../../src/transport/ipc/ensure.ts#L477) |
| `healthyIncompatible` after shutdown already requested | `ensureReplacement` | [`src/transport/ipc/ensure.ts:479`](../../src/transport/ipc/ensure.ts#L479)-[`src/transport/ipc/ensure.ts:482`](../../src/transport/ipc/ensure.ts#L482) |
| `staleLock` | `clearStaleLock` | [`src/transport/ipc/ensure.ts:485`](../../src/transport/ipc/ensure.ts#L485)-[`src/transport/ipc/ensure.ts:490`](../../src/transport/ipc/ensure.ts#L490) |
| `corruptLock` before retry limit | `wait` | [`src/transport/ipc/ensure.ts:493`](../../src/transport/ipc/ensure.ts#L493)-[`src/transport/ipc/ensure.ts:501`](../../src/transport/ipc/ensure.ts#L501) |
| `corruptLock` at retry limit | `quarantineCorruptLock` | [`src/transport/ipc/ensure.ts:496`](../../src/transport/ipc/ensure.ts#L496)-[`src/transport/ipc/ensure.ts:500`](../../src/transport/ipc/ensure.ts#L500) |
| `sick` inside grace window | `wait` | [`src/transport/ipc/ensure.ts:504`](../../src/transport/ipc/ensure.ts#L504)-[`src/transport/ipc/ensure.ts:541`](../../src/transport/ipc/ensure.ts#L541) |
| `sick` after grace with verified ownership | `forceReplace` | [`src/transport/ipc/ensure.ts:524`](../../src/transport/ipc/ensure.ts#L524)-[`src/transport/ipc/ensure.ts:533`](../../src/transport/ipc/ensure.ts#L533) |
| `sick` after grace without verified ownership | `failUnsafeReplacement` | [`src/transport/ipc/ensure.ts:536`](../../src/transport/ipc/ensure.ts#L536)-[`src/transport/ipc/ensure.ts:538`](../../src/transport/ipc/ensure.ts#L538) |

Sick-incumbent detection is: health probe fails or times out, `readRawCoordinatorHealth` returns `null`, discovery still names a live pid, and observation becomes `sick` with `ownership: verifySickOwnership(...)` ([`src/transport/ipc/ensure.ts:242`](../../src/transport/ipc/ensure.ts#L242)-[`src/transport/ipc/ensure.ts:248`](../../src/transport/ipc/ensure.ts#L248), [`src/transport/ipc/ensure.ts:377`](../../src/transport/ipc/ensure.ts#L377)-[`src/transport/ipc/ensure.ts:383`](../../src/transport/ipc/ensure.ts#L383)). The reconciler then waits `SICK_VERIFICATION_WINDOW_MS` and only issues `forceReplace` for verified ownership or `failUnsafeReplacement` for unverified ownership ([`src/transport/ipc/ensure.ts:522`](../../src/transport/ipc/ensure.ts#L522)-[`src/transport/ipc/ensure.ts:538`](../../src/transport/ipc/ensure.ts#L538)).

PID-reuse fencing is PID + `processStartedAt` only. `verifySickOwnership` compares `BackendInfo`, lock record, and the live `probeProcessStartedAtSeconds(pid)` result ([`src/transport/ipc/ensure.ts:300`](../../src/transport/ipc/ensure.ts#L300)-[`src/transport/ipc/ensure.ts:350`](../../src/transport/ipc/ensure.ts#L350)). Missing `processStartedAt` on either side fails closed with `kind: 'unverified', reason: 'missing-processStartedAt'` ([`src/transport/ipc/ensure.ts:313`](../../src/transport/ipc/ensure.ts#L313)-[`src/transport/ipc/ensure.ts:317`](../../src/transport/ipc/ensure.ts#L317)); a null live probe fails closed with `reason: 'live-processStartedAt-unavailable'` ([`src/transport/ipc/ensure.ts:328`](../../src/transport/ipc/ensure.ts#L328)-[`src/transport/ipc/ensure.ts:330`](../../src/transport/ipc/ensure.ts#L330)); mismatch fails closed with `reason: 'processStartedAt-mismatch'` ([`src/transport/ipc/ensure.ts:333`](../../src/transport/ipc/ensure.ts#L333)-[`src/transport/ipc/ensure.ts:338`](../../src/transport/ipc/ensure.ts#L338)). There is no file-mtime fallback and no handshake roundtrip; `forceReplace` is gated by verified ownership and never enters a fallback path ([`src/transport/ipc/ensure.ts:524`](../../src/transport/ipc/ensure.ts#L524)-[`src/transport/ipc/ensure.ts:538`](../../src/transport/ipc/ensure.ts#L538)). Any future fallback is a separate code phase, not Phase 1 spec.

Time budgets are the current exported constants: `STARTUP_POLL_MS = 200`, `STARTUP_TIMEOUT_MS = 60_000`, `SICK_VERIFICATION_WINDOW_MS = 10_000`, `CORRUPT_LOCK_RETRY_LIMIT = 3`, and `HEALTH_TIMEOUT_MS = SHARED_HEALTH_TIMEOUT_MS` ([`src/transport/ipc/ensure.ts:20`](../../src/transport/ipc/ensure.ts#L20)-[`src/transport/ipc/ensure.ts:24`](../../src/transport/ipc/ensure.ts#L24)). Forced replacement gives SIGKILL at most `5_000` ms before failing the ensure attempt ([`src/transport/ipc/ensure.ts:715`](../../src/transport/ipc/ensure.ts#L715)). Phase 1 is docs-only; no new `INVARIANT.<name>` constants exist unless a later code phase adds them.

Verified today: `tests/unit/transport/ipc/ensure.test.ts` covers launch-on-absent and poll cadence ([`tests/unit/transport/ipc/ensure.test.ts:170`](../../tests/unit/transport/ipc/ensure.test.ts#L170)), compatible reuse ([`tests/unit/transport/ipc/ensure.test.ts:223`](../../tests/unit/transport/ipc/ensure.test.ts#L223)), incompatible replacement ([`tests/unit/transport/ipc/ensure.test.ts:249`](../../tests/unit/transport/ipc/ensure.test.ts#L249)), stale lock clearing ([`tests/unit/transport/ipc/ensure.test.ts:298`](../../tests/unit/transport/ipc/ensure.test.ts#L298)), socket-race waiting ([`tests/unit/transport/ipc/ensure.test.ts:328`](../../tests/unit/transport/ipc/ensure.test.ts#L328)), verified sick force-replacement ([`tests/unit/transport/ipc/ensure.test.ts:409`](../../tests/unit/transport/ipc/ensure.test.ts#L409)), unsafe unverified sick refusal ([`tests/unit/transport/ipc/ensure.test.ts:566`](../../tests/unit/transport/ipc/ensure.test.ts#L566)), and corrupt lock quarantine ([`tests/unit/transport/ipc/ensure.test.ts:595`](../../tests/unit/transport/ipc/ensure.test.ts#L595)). Future PID-reuse edge-case tests for missing `processStartedAt`, live-probe-null, and mismatch land in `tests/unit/transport/ipc/ensure-pid-fencing.test.ts`.

### 11.3 HTTP is a gateway

**The HTTP gateway exposes coordinator RPC to non-CLI consumers only.** `coral-reef` and any future browser/external client speak this gateway; `coral-cli` does not. The CLI dispatches solely through library-direct reads (read class) or local IPC (mutate / subscribe classes) per §11. There is no `remote` CommandClass, no `--backend <url>` flag, and no plan to add one — remote CLI dispatch is, by principle, **not implemented and not a goal**. The server-side IPC/HTTP symmetry exists because the coordinator may legitimately serve non-CLI consumers; mirroring that symmetry into the CLI client would re-introduce the transport-topology routing that §11.1 explicitly rejects.

`http://127.0.0.1:<port>` is not the architectural boundary — it is a *carriage* for coordinator RPC. IPC and HTTP share identical command semantics; only wire format differs. Local security is filesystem ownership on the socket; HTTP auth applies to network gateways.

**Token comparison MUST be constant-time.** `X-Coral-Backend-Token` is checked via `node:crypto.timingSafeEqual` over Buffer-encoded inputs (with a length-prefix pre-check). String `===` is forbidden because the network-exposed coordinator gateway leaks token prefix length under timing attack. Transport is allowed direct ambient `node:crypto` access per §16 #50 (transport is not a domain module).

Route dispatch is table-driven (array at `src/transport/http/handler.ts`), but the route table is projected from a single catalog at `src/transport/rpc/catalog.ts`. IPC server dispatch and HTTP handler dispatch both derive from that catalog through `rpcPorts` injected by coordinator composition, so semantic parity is structural rather than aspirational. Operational `/health`, `/admin/shutdown`, and `/events/stream` remain explicit transport-local carveouts rather than catalog entries.

**Coral does not ship an HTTP client class.** The catalog is the source of truth for routes and request schemas; non-CLI consumers (`coral-reef`, future browser/external clients) build their own thin client against `rpcCatalog` rather than importing a hand-coded helper class from coral. A "convenience" HTTP client class would maintain a parallel route table that drifts from the catalog — the same asymmetry that motivated the catalog in the first place. Response shape types are exported from coral for consumer reuse, but no wire-encoding class is.

Interactive/live subscriptions use the same transport primitive in both carriages. `src/transport/json-rpc.ts` defines unary + subscription envelopes with a reserved `subscriptionId` field; HTTP projects notifications to SSE and IPC carries notifications directly. The steady state is one active subscription per connection; multiplexing is a transparent future optimization, not a second protocol.

---

## 12. Recovery Model

Two authorities, two recovery paths. Each authority recovers from its own truth.

### 12.1 Journal recovery — co-transactional projections + reconciliation

**Step 1: projection alignment (co-transactional during normal operation)**

Journal-domain projections (`projection_jobs`, `projection_sessions`, `projection_discuss`, `projection_workflows`) live in SQL tables alongside events. They are maintained incrementally inside every `commit(cb)` transaction (§3.3), so production recovery never invokes rebuild as a startup step. The rebuild utility exists solely as a regression-test tool at `tests/helpers/rebuild-projections.ts`, where it verifies reducer equivalence (`live append = DROP + replay-from-events`).

```sql
DELETE FROM projection_jobs;
DELETE FROM projection_sessions;
DELETE FROM projection_discuss;
DELETE FROM projection_workflows;

-- Iterate events in seq order, apply reducers:
INSERT/UPDATE projection_* rows for each event.
```

Invariants:
- Rebuild is pure — no PID checks, no filesystem reads, no clock decisions.
- Events are read in strict `seq` order.
- After `DROP` + rebuild, projection contents are byte-identical to their live-maintained counterparts (tested by the `projection_rebuild_equivalence` regression test).

**Step 2: imperative reconciliation (live world vs. projected state)**

During reconciliation, compare projected state to the observed world:

```ts
type ReconciliationPlan = {
  register: JobIdentity[];     // jobs to re-register in live state
  cleanup: Orphan[];           // processes without projected jobs
  commitFacts: CoralEvent[];   // new facts to durably record divergence
};
```

When reality disagrees (e.g., a projected `running` job whose process is gone), reconciliation commits new events in one transaction:

```sql
BEGIN IMMEDIATE;
  INSERT INTO events (...) VALUES (...);   -- job.terminal.recorded: outcome = job_fault { wrapper_lost }
  UPDATE projection_jobs SET phase = 'error' WHERE job_id = ?;
COMMIT;
```

Reconciliation never rewrites history. Divergence is resolved by appending, preserving causality and audit trail. This replaces today's `recovery-core.ts` file-presence classifier (10+ row table).

### 12.2 Corpus recovery — rescan + rebuild indexes

The Corpus authority (markdown filesystem) has no event history. Recovery depends on **both** substrates:
- Filesystem (`~/.coral/kb/`) holds the authoritative content.
- Journal substrate (`store.db`) holds the `kb_corpus_state` row (current `contentSeq` / `metadataSeq`) and `consumer_cursors` for Corpus consumers.

Neither alone is sufficient: the filesystem cannot tell us what version consumers have processed, and the SQLite tables cannot reconstitute Corpus content. Coral's full recovery requires both present. This is an honest consequence of SQLite being the substrate for Corpus-related metadata even though the Corpus authority itself is the filesystem.

**Step 1: Corpus rescan**

On coordinator startup (or explicit `kb reindex`):
1. Enumerate all entries under `~/.coral/kb/{notes,sources,principles,communities}/`.
2. For each entry, compute current `content_hash` and capture frontmatter.
3. Compare to `kb_corpus_state.content_seq` / `metadata_seq`.
4. If drift detected, bump `kb_corpus_state.content_seq` / `metadata_seq`.

**Step 2: Projection rebuild (per-Corpus-consumer)**

Each Corpus consumer (Orama, needle) maintains a cursor in `consumer_cursors` (`authority = 'corpus'`). On startup:
- Consumer compares its cursor to current `contentSeq`.
- If behind, triggers snapshot-based diff (`ensureVectorIndex` pattern):
  - Capture text snapshot under mutation lock.
  - Build desired manifest (content hashes per entry).
  - Diff against consumer's last manifest (persisted alongside consumer storage).
  - Re-embed / re-index only changed entries.
  - Atomic snapshot swap.

The Corpus recovery model is **intrinsically idempotent**: rescanning a clean Corpus produces no changes; rescanning after external edits produces exactly the drift set. If SQLite's `kb_corpus_state` or `consumer_cursors` are missing/reset, recovery treats the Corpus as fully new (full rebuild). Never wrong, occasionally expensive.

### 12.3 External mutation absorption

Obsidian edits, `git pull`, or direct filesystem changes are the **normal** path for knowledge editing. The coordinator does NOT own them; the filesystem + git own them. Coral observes and re-indexes:

- **Startup scan**: coordinator boot compares filesystem to the current corpus snapshot and bumps `contentSeq` / `metadataSeq` for any drift; CorpusConsumers (Orama, needle) catch up via manifest diff.
- **Lazy non-blocking rescan**: Corpus mutation absorption is lazy on read. KB read paths call `KbRuntime.ensureCorpusFreshness({ wait: false })` on every invocation; if the index is stale and no rebuild is already in flight, a background rebuild is dispatched. Concurrent reads share one in-flight `Promise<void>` (promise dedup) — the second caller is a no-op rather than a duplicate rescan. Reads return immediately with the current index; stale results may be served during the rebuild window. Readiness, boot, and curate paths use `{ wait: true }` (the blocking variant) so they never observe a stale index. The coordinator owns an `AbortController` whose signal is passed to boot's blocking call; on shutdown the signal aborts further background rebuild kicks so a draining instance does not start fresh KB work — the next coordinator's blocking boot picks up any drift. There is no periodic timer.
- **git-sync auto-commit**: after coordinator-mediated mutations (e.g., `kb promote`), git-sync debounces and commits the markdown changes. External edits made via Obsidian remain visible in the git working tree; the user's normal git workflow (or `kb` commands that trigger auto-commit) brings them into history.

External edits never synthesize backfilled Journal events. They are first-class Corpus mutations observable via version counters. Entity re-extraction (curate's community/principle/graph update) is **independent** of edit detection — curate runs on its own scheduler against the current Corpus state; external edits affect what the next curate pass sees but do not themselves trigger curate.

### 12.4 Simulation

`SimulationRuntime` is an alternative `Runtime` implementation that reproduces the entire system deterministically. The 6 ports (`time`, `ids`, `storage`, `process`, `paths`, `env`) are the injection surface; every byte of behavior traces to either port input or injected events/corpus state. Repeated runs with identical inputs produce byte-identical Journal rows, projections, and exports.

#### 12.4.1 Coverage

| Subsystem | Input | Verification |
|---|---|---|
| Jobs | `job.launch.requested` + scripted provider bodies | `JobView` at each `seq` |
| Sessions | `session.opened` + `session.continuity.checkpointed` | `SessionView` resumability + ref |
| Discuss | Discuss event sequence | `DiscussView` round/turn/outcome |
| KB (Corpus) | Simulated markdown filesystem + scripted rescan drift | `kb_corpus_state` + Orama/needle retrieval artifact consistency via CorpusConsumer drain |
| Workflow | `workflow.plan.declared` + child launches (with `refs.workflowSlotId`) + child terminals | `WorkflowView.slotOutcomes`, causeRef chains |
| Provider middleware | `ScriptedProvider` replacing kernel | Middleware stack produces expected journal events |
| Coordinator live | Virtual process table + host-pool events | Admission, lease, idle determinism |
| Reconciliation | Journal ≠ process table | Correct fault events appended |

#### 12.4.2 ScriptedProvider

```ts
type ScriptedProvider = Provider & { script: readonly ProviderEventBody[] };
function scriptedProvider(script: readonly ProviderEventBody[]): Provider;
```

Middleware composition wraps it unchanged, exercising the full stack without real CLI invocations.

#### 12.4.3 Recording and cross-authority scenarios

`tools/simulation/recording.ts` captures Journal event traces and Corpus snapshot states. A recorded run replays byte-identical across both authorities. Cross-authority scenarios — a discuss synthesis that references a KB entry, a workflow that promotes a memo, abort-during-app-server-turn that interrupts a KB operation — all expressible as a combination of injected Journal events and injected Corpus state snapshots. Executable scenario YAML belongs with the debug harness under `tools/simulation/scenarios/`, not under `tests/` and not at the repository root. `npm run build` runs `check:simulation` (typecheck + sealing), so a production change that blocks simulation fails before bundling.

---

## 13. Worked Example: `[A] | [B, C]` where `C` fails

### 13.1 Events

All events for this workflow land in the SQLite `events` table. Transactions group causally-related appends.

Slot ids in this section follow the production format `${workflowId}:${stepIndex}:${atomIndex}` — `wf-1:0:0` for "A", `wf-1:1:0` for "B", `wf-1:1:1` for "C". The slotId encodes step+atom position so renderers can reconstruct presentation without storing it. Slot labels (e.g. "A", "B", "C") are derived from `slot.agent ?? prompt#${atomIndex}(${truncated instruction})` at render time, not stored on the plan as a separate labels map or on child launch events; completion `stepDetails` records the label with the completed atom output.

**Transaction 1** — workflow plan declared + workflow job launched:
```
seq=41  workflow/wf-1   workflow.plan.declared   plan: { slots: [
                                                   {slotId:'wf-1:0:0', deps:[],            provider:'codex', instruction:'A', agent:'A'},
                                                   {slotId:'wf-1:1:0', deps:['wf-1:0:0'],  provider:'codex', instruction:'B', agent:'B'},
                                                   {slotId:'wf-1:1:1', deps:['wf-1:0:0'],  provider:'codex', instruction:'C', agent:'C'},
                                                 ] }
seq=42  job/wf-1        job.launch.requested     refs.workflowId=wf-1
seq=43  job/wf-1        job.queue.admitted
seq=44  job/wf-1        job.runtime.started
```

**Transaction 2** — slot A launched and completed:
```
seq=45  job/a-1  job.launch.requested   refs.parentJobId=wf-1, refs.workflowId=wf-1, refs.workflowSlotId=wf-1:0:0
seq=46  job/a-1  job.queue.admitted
seq=47  job/a-1  job.runtime.started
seq=48  job/a-1  job.terminal.recorded  outcome={kind:'completed'}
```

**Transaction 3** — slots B and C launched:
```
seq=49  job/b-1  job.launch.requested   refs.parentJobId=wf-1, refs.workflowId=wf-1, refs.workflowSlotId=wf-1:1:0
seq=50  job/c-1  job.launch.requested   refs.parentJobId=wf-1, refs.workflowId=wf-1, refs.workflowSlotId=wf-1:1:1
seq=51  job/b-1  job.queue.admitted
seq=52  job/c-1  job.queue.admitted
seq=53  job/b-1  job.runtime.started
seq=54  job/c-1  job.runtime.started
```

**Transaction 4** — B completes:
```
seq=55  job/b-1  job.terminal.recorded  outcome={kind:'completed'}
```

**Transaction 5** — C fails and the whole workflow fails (atomic chain):
```
seq=56  job/c-1         job.terminal.recorded    outcome={kind:'provider_exit', code:1}
seq=57  workflow/wf-1   workflow.completed       outcome:'failed',
                                                 causeRef:{stream:{kind:'job',id:'c-1'}, seq:56},
                                                 stepDetails:[
                                                   {stepIndex:0, atomIndex:0, kind:'agent',
                                                    label:'A', provider:'codex', tagName:'agent',
                                                    output:'A result'},
                                                   {stepIndex:1, atomIndex:0, kind:'agent',
                                                    label:'B', provider:'codex', tagName:'agent',
                                                    output:'B result'}
                                                 ]
seq=58  job/wf-1        job.terminal.recorded    outcome={kind:'failed',
                                                          causeRef:{stream:{kind:'workflow',id:'wf-1'}, seq:57}}
```

All three events in Transaction 5 commit atomically. A coordinator crash between `seq=56` and `seq=57` would roll back; replay sees pre-C-failure state and reconciliation (§12.2) detects the dead child process and produces the same chain again.

### 13.2 Projection evolution

`JobView(wf-1)` at `seq=56` (C has failed but workflow terminal not yet committed — this state is never externally observable because everything commits atomically):
```
phase: running
terminal: null
lastSeq: 54     -- only pre-txn-5 events have been observed by readers
```

`JobView(wf-1)` at `seq=58` (Transaction 5 committed):
```
phase: error
terminal: {
  content: '',
  outcome: {
    kind: 'failed',
    causeRef: { stream: {kind:'workflow', id:'wf-1'}, seq: 57 }
  },
  durationMs: 48_123
}
diagnostics: { warnings: [], ... }
// stable launch identity omitted for brevity: sessionId, provider, projectRoot,
// backendNamespace, bundleHash, jobKind, createdAt
parentWorkflowJobId: null
workflowSlot: null
lastSeq: 58
```

`WorkflowView(wf-1)` at `seq=58`:
```
plan: { slots: [wf-1:0:0, wf-1:1:0, wf-1:1:1] }   // plan stores agent/instruction, not a labels map
slotOutcomes: {
  'wf-1:0:0': { jobId: 'a-1', phase: 'completed', causeRef: null },
  'wf-1:1:0': { jobId: 'b-1', phase: 'completed', causeRef: null },
  'wf-1:1:1': { jobId: 'c-1', phase: 'error',
                causeRef: null /* c-1 ended via provider_exit, not a failed-with-causeRef */ },
}
outcome: 'failed'
causeRef: { stream: {kind:'job', id:'c-1'}, seq: 56 }
lastSeq: 58
```

### 13.3 CLI wait rendering (walks the causal chain)

```
$ coral-cli wait --jobs wf-1

Job wf-1 failed
  → Workflow wf-1 failed (slot "C" wf-1:1:1)
    → Job c-1 exited with code 1

  ✓ A  wf-1:0:0 completed
  ✓ B  wf-1:1:0 completed
  ✗ C  wf-1:1:1 provider_exit 1
```

Traversal:
1. `JobView(wf-1).terminal.outcome` = `failed` with `causeRef → workflow/wf-1@57`.
2. Event at `workflow/wf-1@57` is `workflow.completed { outcome:'failed', causeRef → job/c-1@56, stepDetails }`.
3. Event at `job/c-1@56` is `job.terminal.recorded { outcome: provider_exit(1) }`.
4. Chain terminates at a non-`failed` outcome; render the chain.
5. Slot labels (`"A"`, `"B"`, `"C"`) are derived from each slot's `agent` field (or a truncated `instruction`) at render time — the plan stores no `labels` map, the slot is the single source of truth.
6. Nothing on the causal chain carries labels or step/atom indices — those are recoverable from `slotId` (production format `${workflowId}:${stepIndex}:${atomIndex}`) and `agent`.

### 13.4 What each pioneer contributed

- **A**: workflow execution lives in `workflow/executor.ts`, not in a god service.
- **B**: child jobs are independent top-level streams with `parentJobId` + `workflowSlotId` pointers.
- **C**: provider output is `progress` / `continuity` / `terminal` bodies, not adapter return blobs.
- **D**: the journal and projections are the only durable truth.
- **E**: outcome types live under `jobs/`, continuity under `sessions/`, contracts under domains.
- **F**: CLI writes and live waits go through IPC to the coordinator; read models come from `CoralStore`.
- **B-v2**: stream identity is truth, labels are presentation — workflow labels live on the plan, not on launches or faults.
- **Pioneer-final**: SQLite event DB unifies segments/checkpoints/projections; causal graph replaces wrapped fault union; workflow plan is a first-class aggregate.

---

## 14. Current → Final Mapping

This section documents the **design delta** between today's codebase and the endpoint. It is a reference for reviewers to understand what is being left behind; it is **not** a migration guide. Clean-slate rewrite: old files are deleted outright, new files are written from scratch, and there is no intermediate state where both coexist.

### 14.1 What disappears

| Today | Endpoint form |
|---|---|
| `src/execution/` | `coordinator/` + `jobs/` + `sessions/` + `transport/` + `tools/simulation/` |
| `src/shared/` | Every file relocates to a domain or `infra/` or `testing/` |
| `src/client/` | Domain-owned read queries + `read-model/` + `transport/ipc/client.ts` + `transport/http/client.ts` |
| `src/bridge/` transport | `transport/` |
| `status.json`, `launch.json`, `runtime.json`, `exit.json`, `progress.jsonl` | SQLite `events` + `projection_*` tables |
| Custom segment rotation, checkpoint files, Journal writer lockfile | SQLite WAL + `BEGIN IMMEDIATE` transactions |
| `result.md` (authority) | `~/.coral/exports/jobs/<id>/result.md` in prod; `~/.coral/exports-dev/jobs/<id>/result.md` in dev. Tmp job dirs are scratch only (stdout/stderr/intermediates). |
| `TerminalResult` (single struct) | `JobTerminal` + `JobDiagnostics` + `JobView` (three concerns) |
| `TerminalResult.exitCode` | `outcome.provider_exit.code` |
| `TerminalResult.nonResumable` | `SessionView.resumable` |
| `TerminalResult.warnings`, `usage` | `JobDiagnostics` |
| `TerminalResult.workflow` | `WorkflowView.slotOutcomes` (plan + children join) |
| `workflow_atom_failed` with `step`/`atom` labels | `failed { causeRef }` + labels derived at render time from `slotId` (`${workflowId}:${stepIndex}:${atomIndex}`) and `slot.agent` |
| Multi-variant `CoralFault` union across domains | Three-variant `JobLifecycleFault` + `causeRef` pointers to domain events |
| `composition.childJobIds` on parent | SQL query on `projection_jobs WHERE parent_workflow_job_id = ?` |
| `SessionContinuityPatch` | Full `session.continuity.checkpointed` snapshot event |
| `WaitCursor.jobs[jobId → eventId]` | `WaitCursor { afterSeq }` |
| `recovery-core.ts` classifier (10+ rows) | Projection rebuild + reconciliation appends |
| `event-bus.ts` + durable progress log + wait replay cursor | SQLite `events` table + `afterSeq` SELECT |
| `execution/kb-tools.ts`, `execution/discuss-tools.ts` (HTTP-layer handlers) | `transport/http/kb-routes.ts`, `transport/http/discuss-routes.ts` thin routers + calls into `kb/ops/` and `discuss/shell/` |
| `execution/discuss/persistence.ts` + `session-store.ts` | `discuss/shell/persistence.ts` + `discuss/shell/session-store.ts` + `discuss/shell/live-registry.ts` (decomposed per §10.1a) |
| `curate-state.json` | `kb_curate_scheduler` + `kb_curate_retry_queue` SQLite tables (§3.1) |
| `ensureBackend()` HTTP-first | Command-class routing (library-direct for reads, IPC for live) |
| `WorkflowCheckpoint` file | `workflow.plan.declared` event on `workflow/<id>` stream |
| `--local` flag | Semantic command-class routing |
| `WorkflowRef { stepIndex, atomIndex, label }` on launches | `refs.workflowSlotId` → plan lookup for slot; labels/step/atom derived from `slotId` + `slot.agent` at render time |
| Hosted KB operation metadata | Recorded on `job/<id>` as `job.progress.emitted` with `body.detail.operation`; the targeted KB slug is the caller's input and is not durably re-persisted into the Journal envelope (§2.4). |

### 14.2 Bugs eliminated as a side effect

Concrete pathologies in today's codebase that disappear structurally when this architecture lands. Preserved here so they are not forgotten between now and the refactor.

#### 14.2.1 Bundle-swap orphan adoption failure

**Observation (2026-04-18)**: during a bundle reinstall mid-flight, jobs launched by the previous backend instance become orphaned and `jobs --all` does not see them.

**Trigger**:
1. Old backend (bundle at previous cache path) launches a job → `/tmp/coral-jobs/<id>/` + pid recorded.
2. Bundle is reinstalled: new bundle copied to a new cache path (e.g., `0.5.1` → `0.5.2`).
3. Old backend is still running but at the old bundle path.
4. Next CLI invocation goes through `ensureBackend()`, which starts a **new** backend instance from the new bundle path (does not recognize the old instance's lock or identity).
5. New backend's `planRecovery()` sees the job directories but refuses adoption — namespace/project/ownership check diverges.
6. Job remains running on disk but invisible to CLI queries.

**Current blast radius**: `src/execution/recovery-core.ts`, `src/execution/lifecycle/recovery-actions.ts`, `src/execution/lifecycle/cross-namespace-adoption.ts`, `src/execution/lifecycle/ownership-checker.ts`, `src/execution/lifecycle/claim-protocol.ts`.

**Why this architecture eliminates it**:
- The per-flavor coordinator singleton lock (`~/.coral/run[-dev]/coordinator.lock`) is the launch gate, and `coordinator.json` + socket readiness is the discovery signal. Two compatible backend instances cannot both complete bootstrap for the same flavor; the contender waits, requests handoff, or replaces only after verified ownership.
- Backend identity is not tied to the bundle path. It is tied to the coordinator discovery record, process identity, bundle hash, and flavor. Reinstalling the bundle does not create a parallel live instance — only one compatible coordinator serves a flavor at a time.
- Recovery = pure `replay()` over the single global journal. There is no "other backend's jobs" category to adopt — there is only the journal.
- Reconciliation compares projected running state to the process table and appends new facts (e.g., `wrapper_lost`) when reality disagrees. No classifier over file-presence matrices.
- If the bundle-swap handoff is desired (old coordinator shuts down, new one takes over), the sequence is: old coordinator closes → removes discovery/lock ownership → new coordinator writes its discovery record after socket readiness → replays journal → reconciles against process table. Jobs never become invisible.

Lifecycle clarifications:
- Lock probe result is cached per `(pid, snapshot.processStartedAt)` within the acquire loop; cache invalidates when the observed snapshot key changes.
- Shutdown drain budget is a shared deadline: the first phase consumes from the remaining budget, and the second phase must finish within the remainder.

Tag for future reference: resolves during step 5 of derivation order (see §15) when `jobs/reconcile/` replaces the current lifecycle classifier.

### 14.3 What survives unchanged (in concept; location may move)

- The 6-subport `Runtime` abstraction (production port boundary; debug simulation supplies an alternate implementation from `tools/simulation`).
- `TerminalOutcome` **reshapes** (not a rename). The old 4-variant shape (`completed | aborted | provider_exit | coral_fault{fault: CoralFault}`) becomes a 5-variant shape (`completed | aborted | provider_exit | failed{causeRef} | job_fault{JobLifecycleFault}`). The `coral_fault` variant disappears; its 12-member payload union is replaced by `causeRef` pointers into the Journal and a 3-variant `JobLifecycleFault` for wrapper-local failures. Location moves from `src/shared/` to `src/jobs/outcome.ts`. All existing call sites must cut over; this is a breaking change under the clean-slate rewrite.
- `JobLifecycleFault` (3 variants: `ghost_launch`, `wrapper_lost`, `wrapper_crashed`) — lives at `src/jobs/outcome.ts`.
- Discuss reducer + projections — location unchanged; envelope now global.
- Provider `catalog` allowlist — workflow-provider boundary preserved.
- Zod-based validation discipline.
- Hook scripts as Node.js ESM, fail-open. **Path references require update** — see §14.4.
- Atomic write pattern — at the database level, via SQLite transactions (no per-file `.tmp` + rename for jobs; Corpus writes still use `.tmp` + rename for markdown files).

### 14.4 Downstream surfaces that require coordinated update

The rewrite changes paths and output shapes that external surfaces (hooks, skills) currently parse. Flagged here so they are not forgotten during the rewrite — they update in lockstep with the source changes (same plugin artifact).

**Hook scripts** (`~/.claude/plugins/cache/coral/coral/.../hooks/*.mjs`):
- `hooks/post-compact.mjs` reads the exports-root result path (`~/.coral/exports/jobs/<jobId>/result.md` for prod, `~/.coral/exports-dev/jobs/<jobId>/result.md` for dev). The prior dependency on `status.json` is gone (replaced by Journal `events` + `projection_jobs`, which the coordinator materializes `result.md` from).
- `hooks/pre-compact.mjs` reads the same exports-root result path for the same reason — `status.json` is no longer parsed by any hook.
- `hooks/cli-resolve.mjs` rewrites bare `coral-cli` invocations. CLI bundle path is unaffected; the rewrite regex stays valid.

Mitigation: this update landed alongside the rewrite; hooks ship as part of the plugin artifact, so a first deploy includes hooks matching the materialized-export contract.

**Skill contracts** (CLI output formats currently parsed by `skills/*/SKILL.md`):
- Every skill parses the launch text: `Job <jobId> <launchState> (session <sessionId>)`.
- Every skill parses wait output: `Result path: <path>`.
- `skills/equip/SKILL.md` routes to `coral-cli expansion ...` and parses the shared expansion JSON contract (`InstallResult` / `InstallError`, including catalog/info status tables).

Skills and CLI ship in the **same plugin artifact** and update together — no cross-version compatibility requirement. The rewrite may change CLI output shapes as the design warrants; skill files are updated in lockstep. Claude reads skill content dynamically on invocation, so rigid parsing in skills is itself legacy and the rewrite is free to move toward skills that query CLI help (`coral-cli <cmd> --help`) rather than parsing specific format strings where that improves clarity.

**Installation namespace** (per-flavor):
- Current: `~/.claude/coral/installations/<sha256>/` for multi-install handoff.
- Rewrite: per-flavor store (§3, §A.9). Dev and prod coexist via `CORAL_FLAVOR`; cross-flavor coordinator handoff continues to use `bundleHash` + `flavor` gating (§10 `coordinator/lock.ts`).
- No multi-install-per-flavor coexistence — simplification accepted under clean-slate.

---

## 15. Derivation Order

Truth-first, not tractability-first:

1. **D wins first**: journal + replay + projections define what reality is.
2. **E wins second**: once Journal stream kinds are `job`, `session`, `discuss`, `workflow` (KB lives in the Corpus authority, not the Journal), payload ownership is domain-local — no `shared/`.
3. **A wins third**: once ownership is explicit, `execution/` dissolves into coordinator + transport + domain shells.
4. **C wins fourth**: provider output must match the journal's canonical body vocabulary, not invent a parallel result model.
5. **B wins fifth, and only as read-model logic**: child jobs are independent by pointer; composition is a projection, not a stored record.
6. **F wins last**: transport sits on top of the finished truth/ownership model, exposing `CoralStore` and `CoralCoordinator`.
7. **B-v2 correction**: faults name streams, not rendered labels.
8. **Pioneer-final**: SQLite event DB unifies storage tiers; causal graph replaces wrapped fault union; workflow plan is first-class; `slotId` replaces syntax-shaped `WorkflowRef`.

This ordering is logical dependency, not implementation difficulty. A real implementation might start with E (cheap domain-split warmup) or A (enables downstream) for tractability — but the logical order above is what makes the final shape coherent.

### 15.1 Why B is absorbed into D, not sequenced as a separate step

Original Pioneer B proposed a standalone `JobResult` refactor as a waypoint before event-sourced persistence. The All-6 meta-pioneer flagged this as a cost-axis violation: B called the journal "a strictly larger change" and positioned its record-shaped result as a "correct waypoint" — that is tractability-first reasoning dressed as architecture.

Under cost-unconstrained selection:

1. **B's final form is a projection over events** (`JobView` over `job.terminal.recorded`). A stored `JobResult` record is strictly redundant with the projection — it stores once what replay can derive.
2. **The intermediate form (B stored as authority, D deferred) is not a stable waypoint**. Every consumer of B-the-record has to be rewritten again when D lands. The "B first, D later" path pays the rewrite twice.
3. **B's insight survives as projection logic**, not as a storage step. Child jobs as independent streams, parent pointer via `refs.parentJobId`, composition as projection — these are B's contributions and they land with D simultaneously.
4. **The only B-specific artifacts** are `JobTerminal` / `JobDiagnostics` / `JobView` type shapes and the reducer that builds children from child launch events. Both are consumed together with the journal substrate and domain schema evolution; neither needs a standalone step.

Therefore the architecture recognizes **no "Pioneer B" phase**. The type shapes land with the journal substrate, and projections become authoritative when the domains are migrated. B's contributions are distributed across those steps, not sequenced separately.

### 15.2 Implementation cadence

Solo-developer, full-freeze execution. Feature work is halted for the entire duration of the rewrite, not only between phases. This removes the need for dual-write windows, backward-compat stubs, and short-freeze ceremony.

**Phase-boundary discipline (non-negotiable)**:
- Build clean (`tsc` + esbuild, zero errors).
- Test suite green (unit + integration).
- Zero WIP markers (`it.skip`, `@ts-expect-error`, `TODO rewrite`) remain.
- Architecture-boundary test + type-ownership DAG test pass.

**Phase-interior discipline (relaxed)**:
- Red build and failing tests are acceptable within a phase's working window.
- Big atomic commits preferred over incremental staging — solo work, no rebase contention.
- Integration tests (`backend-warm-start`, `follow`, `lifecycle-recovery`) are kept green as long as possible — they are the last line of E2E defense against silent semantic regression during unit-level churn.

**Pause-point rubric (apply before starting phase N+1)**:
- Does the repository after phase N read as structurally coherent from a cold start, without reference to the prior phase?
- Have the invariants from §16 that are in-scope for phase N held under real load (exercise the CLI, not just tests)?
- Has any crack emerged that requires revising a later phase's plan?
- Are the type ownership rules (§10.3) still intact?
- Does the codebase after phase N still match this document, or has the document drifted?

If any answer is no, resolve it before phase N+1. The risk profile of a solo rewrite is architectural drift and echo-chamber design, not merge contention — the rubric targets drift.

---

## 16. Invariants (Consolidated)

Every invariant the design rests on, numbered for reference. Grouped by authority where applicable.

**Authority model**:
1. Exactly one coordinator holds write authority across both Journal and Corpus per Coral installation. IPC bootstrap preserves the singleton through the `DaemonObservation` → `DaemonAction` reconciler in `src/transport/ipc/ensure.ts`: observations are `absent | starting | sick | healthyCompatible | healthyIncompatible | staleLock | corruptLock` ([`src/transport/ipc/ensure.ts:87`](../../src/transport/ipc/ensure.ts#L87)); actions are `wait | requestShutdown | ensureReplacement | clearStaleLock | forceReplace | failUnsafeReplacement | quarantineCorruptLock | converged` ([`src/transport/ipc/ensure.ts:101`](../../src/transport/ipc/ensure.ts#L101)); controller state is `sickSince`, `sickPid`, `unverifiedSince`, `shutdownRequestedFor`, `corruptLockRetries`, `corruptLockQuarantined`, `replacedInstanceId`, `replacementPending`, `verifiedSickOwnership` ([`src/transport/ipc/ensure.ts:115`](../../src/transport/ipc/ensure.ts#L115)). Sick replacement is fenced by PID + `processStartedAt` verification only; unverified ownership fails closed and does not force-replace ([`src/transport/ipc/ensure.ts:300`](../../src/transport/ipc/ensure.ts#L300), [`src/transport/ipc/ensure.ts:524`](../../src/transport/ipc/ensure.ts#L524)-[`src/transport/ipc/ensure.ts:538`](../../src/transport/ipc/ensure.ts#L538)).
2. Every domain declares **one authoritative substrate**. Journal domains (`job`, `session`, `discuss`, `workflow`): the `events` table. Corpus domain (`kb`): the markdown filesystem at `~/.coral/kb/`.
3. Projections and indexes are **rebuildable from their domain's authority alone**. Never from "events alone" as a blanket rule — the rule is per-authority.
4. Exports (`result.md`) live outside any authority; deleting them never loses truth. KB markdown files are NOT exports — they are the Corpus authority itself.

**Journal invariants**:
5. Every Journal fact is a row in the `events` table. All Journal facts append via `commit(cb)`, and the substrate uses SQLite `BEGIN IMMEDIATE`.
6. Multi-event Journal commits commit atomically by construction; the closure scope IS the transaction scope. Replay never sees partial truth.
7. Journal recovery = co-transactional projection state + reconciliation (imperative, append-only); rebuild is a regression-test replay tool, not a production recovery step.
8. Every provider stream emits exactly one terminal body, and it is last.
9. `continuity` bodies are full snapshots, never patches.
10. Child jobs are independent top-level streams; parents reference via `refs.parentJobId` + `refs.workflowSlotId`, never embed.
11. Fault truth lives on the originating stream as a domain event; job terminals point via `causeRef`, never duplicate payload. `CauseRefToken` resolution preserves the renderer chain-walk contract — the renderer at `src/causality/render.ts` never sees a token; it walks fully-resolved `CauseRef { stream, seq }` pointers identical to today's vocabulary.
12. Labels, step indices, atom indices live on `workflow.plan.declared`; launches carry only `slotId`. Labels are presentation.
13. `WaitCursor` is a single global `afterSeq` (Journal).
14. Every fault-bearing event type has exactly one producer.
15. Journal schema evolution is per-`type` via `bodyVersion` + upcaster chain. Upcasters are pure and kept forever.
16. Every Journal event type has exactly one definition; no re-declaration across domains. `workflow.lifecycle_fault` is a single workflow event definition, defined once in `src/workflow/events.ts`.

**Corpus invariants**:
17. KB markdown corpus is authoritative. No synthetic events reconstruct KB content.
18. `contentSeq` and `metadataSeq` are freshness/version counters only, never event history.
19. The Corpus mutation lock contains only authority writes, Corpus version bumps, and lightweight Corpus metadata/index state. Retrieval artifacts (Orama and needle) are CorpusConsumers and are never built inside the authoritative critical section: Orama search-side loading uses `loadReadOnly()` and reports `fts_index_uninitialized`, while durable `persist(...)` is only reached through `CorpusConsumer.apply` ([`src/engines/orama/backend.ts:126`](../../src/engines/orama/backend.ts#L126)-[`src/engines/orama/backend.ts:150`](../../src/engines/orama/backend.ts#L150), [`src/engines/orama/backend.ts:248`](../../src/engines/orama/backend.ts#L248)-[`src/engines/orama/backend.ts:250`](../../src/engines/orama/backend.ts#L250), [`src/engines/orama/snapshot.ts:82`](../../src/engines/orama/snapshot.ts#L82)-[`src/engines/orama/snapshot.ts:108`](../../src/engines/orama/snapshot.ts#L108)).
19a. KB direct read/query paths cannot persist derived artifacts. The read-side DB surface is `KbReadPort` / `ReadonlyDatabase`, opened with `readonly: true`, and the `src/kb/read-port.ts` import graph must not reach `ensureCorpusFreshness`, Orama `persist`, `removeSnapshot`, or the auto-rebuild `loadIfPresent` path ([`src/kb/read-port.ts:22`](../../src/kb/read-port.ts#L22)-[`src/kb/read-port.ts:40`](../../src/kb/read-port.ts#L40), [`src/kb/read-port.ts:51`](../../src/kb/read-port.ts#L51)-[`src/kb/read-port.ts:65`](../../src/kb/read-port.ts#L65), [`src/kb/query-runtime.ts:107`](../../src/kb/query-runtime.ts#L107)-[`src/kb/query-runtime.ts:130`](../../src/kb/query-runtime.ts#L130)). The invariant test is `tests/invariants/kb-read-port-shape.test.ts`.
20. External Corpus edits (Obsidian, git pull, direct filesystem) are first-class; scans/rebuilds absorb them without backfilling synthetic events.
21. Corpus recovery = rescan + index rebuild (no history to replay).
22. Cross-authority references are deliberately absent. `journalEventRefsSchema` carries Journal-stream pointers only (`jobId`, `sessionId`, `parentJobId`, `workflowId`, `workflowSlotId`, `discussSessionId`); there is no typed pointer from a Journal event to a Corpus entry (§2.4). If a future surface needs cross-authority references, that surface introduces the shape together with its consumer.
22a. `kb source import` is a job-owned ingest attempt. Its job terminal records execution/readiness success or failure; the imported source is authoritative only when the Corpus markdown file exists.

**Coordinator & transport**:
23. Local read-only CLI commands do not require a coordinator (SQLite readers use separate DB handles; Corpus reads are direct filesystem), but their roots are explicit adapter inputs, not implicit cwd/home fallbacks inside domain/read-model code.
24. Local mutating or live CLI commands always go through the coordinator over **IPC**. The HTTP gateway is server-side exposure for non-CLI consumers (`coral-reef`, future browser/external clients) and is **not** a CLI dispatch path; remote CLI dispatch is not supported (§11, §11.3). `CommandClass` enumerates exactly three values: `read | mutate | subscribe`.
25. IPC and HTTP share identical coordinator RPC semantics; only wire format differs.
26. Operational facts (index rebuilds, WAL checkpoints, snapshot rotations) are NOT domain events or Corpus mutations; they are logs.

**Layering**:
27. `src/runtime/*` and `src/infra/*` import nothing from domains, transport, coordinator, or cli.
28. `src/transport/*` imports domain contracts only, never domain shells or coordinator.
29. `src/coordinator/*` is the only layer allowed broad cross-domain imports.
30. `tests/helpers/*` is never imported by production files.
31. No generic filenames (`utils.ts`, `shared.ts`, `types.ts`, `schemas.ts`) at any domain root — ownership must be explicit.

**Expansion**:
32. Expansion never writes to any authority. Expansion adds or replaces projection backends only, and its public registration type cannot represent cursor-only Journal consumers: `ExpansionConsumerRegistration` admits journal apply, corpus apply, and stateless lifecycle registrations only, with host-derived `registrationKind` ([`src/expansion/contract.ts:15`](../../src/expansion/contract.ts#L15)-[`src/expansion/contract.ts:22`](../../src/expansion/contract.ts#L22), [`src/expansion/host.ts:58`](../../src/expansion/host.ts#L58)-[`src/expansion/host.ts:63`](../../src/expansion/host.ts#L63), [`src/expansion/host.ts:109`](../../src/expansion/host.ts#L109)-[`src/expansion/host.ts:120`](../../src/expansion/host.ts#L120)).
33. Every Expansion-backed projection is rebuildable from the authority of the domain it serves (Journal events OR Corpus contents).
34. The base tier is **fully functional** after plugin install for all zero-config commands. Commands that intrinsically need additional resources (vector search needs a `kb.vector` engine and a `kb.embedding` engine) declare their setup in README/onboarding. Every CLI command available in equipped tier is also available in base tier — missing prerequisites surface as structured errors with setup guidance, not silent failure.
35. Expansion **replaces specific query paths** with higher-quality implementations. It never adds new command surfaces.
36. Unequipping an Expansion returns the replaced path to the base backend without data loss and without command availability changes.
37. An Expansion loads via dynamic import; its heavy dependencies enter the process only after `/equip` completes.
38. Expansion is **never prompted or nagged**. Base-tier commands never surface "equip X to unlock" hints. Discovery is curiosity-driven (`/equip --list`, internally `coral-cli expansion list`; docs), not system-driven.
39. Expansion catalog entries are **tool-named** (`needle`), not capability-named (`kb`).
40. Projection consumers carry durable cursors in `consumer_cursors`. Two journal-consumer shapes plus the corpus-consumer shape: **base journal projection consumers** (`projection_jobs`, `projection_sessions`, `projection_discuss`, `projection_workflows`) are **cursor-only** — their projection rows are written by the commit-time reducer inside `BEGIN IMMEDIATE` (§3.3, §12.1), and `ConsumerDriver.notify(authority, version)` advances the cursor directly with no `apply()` body in production; **expansion-tier journal consumers** use range-based replay through `apply({ upToSeq, db, signal })`; **corpus consumers** use snapshot-based content-hash diff through `apply({ snapshot, journalReader, corpusStateReader, projectionInput, signal })`, where `snapshot: CorpusSnapshot` carries `snapshotId`, both seq counters, and per-lane manifest hashes (§9.2). Cursor advancement is `ConsumerDriver`-owned after clean apply return ([`src/store/consumer-contract.ts:122`](../../src/store/consumer-contract.ts#L122)-[`src/store/consumer-contract.ts:132`](../../src/store/consumer-contract.ts#L132), [`src/coordinator/consumer-driver.ts:1199`](../../src/coordinator/consumer-driver.ts#L1199)-[`src/coordinator/consumer-driver.ts:1218`](../../src/coordinator/consumer-driver.ts#L1218)). Updates flow via in-process async push (`ConsumerDriver.notify(authority, version)` after authoritative write).
40a. Engine artifact freshness is engine-owned parsing plus KB-owned comparison. Engines register `EngineArtifactPort`s through `ExpansionHost.registerArtifactPort`, descriptors carry `targetConsumerIds`, and KB compares normalized freshness against the Corpus snapshot/projection identity without parsing Orama JSON or needle native files ([`src/kb/corpus/artifact-port.ts:26`](../../src/kb/corpus/artifact-port.ts#L26)-[`src/kb/corpus/artifact-port.ts:38`](../../src/kb/corpus/artifact-port.ts#L38), [`src/kb/corpus/artifact-registry.ts:59`](../../src/kb/corpus/artifact-registry.ts#L59)-[`src/kb/corpus/artifact-registry.ts:71`](../../src/kb/corpus/artifact-registry.ts#L71), [`src/kb/corpus/rescan/drift.ts:348`](../../src/kb/corpus/rescan/drift.ts#L348)-[`src/kb/corpus/rescan/drift.ts:373`](../../src/kb/corpus/rescan/drift.ts#L373)). The invariant test is `tests/invariants/engine-artifact-port-blindness.test.ts`.
41a. Journal consumer freshness is eventually consistent relative to journal projections. Strict-freshness reads use `waitFreshUntil('journal', version, consumerId)` — a condition-variable wake, never a polling loop. `waitFreshUntil` targets only journal/corpus authorities; stateless provider lifecycle ids are rejected structurally (no cursor row, no version axis to wait on — the registration is not a freshness target).
41b. Corpus consumer freshness is eventually consistent relative to Corpus writes. Commands with explicit retrieval readiness use `waitFreshUntil('corpus', snapshot, consumerId)` where `snapshot: CorpusSnapshot` (§9.2); unchanged-snapshot artifact repair uses `waitFreshUntil('corpus', { snapshot, atLeastGeneration }, consumerId)` as the readiness side of `forceCorpusApply(...)` ([`src/coordinator/consumer-driver.ts:68`](../../src/coordinator/consumer-driver.ts#L68)-[`src/coordinator/consumer-driver.ts:85`](../../src/coordinator/consumer-driver.ts#L85), [`src/coordinator/consumer-driver.ts:477`](../../src/coordinator/consumer-driver.ts#L477)-[`src/coordinator/consumer-driver.ts:506`](../../src/coordinator/consumer-driver.ts#L506)). `listExpansion` is status observation, not a readiness waiter.
41c. **`waitFreshUntil` operational bounds**: the call has a **default 30-second timeout** (`timeoutMs?: number`, default `30000`); callers with heavier readiness contracts (e.g. `kb source import`, `kb reindex`) pass an explicit longer value. Errors surface as documented `CoralSetupError` codes, never thrown raw: `consumer_not_registered` (unknown id), `consumer_wait_fresh_invalid_target` (target is a stateless lifecycle id), `consumer_authority_mismatch` (id registered against a different authority), `consumer_wait_unsupported` (target shape mismatches the registered authority — number for journal, `CorpusSnapshot` or `{ snapshot: CorpusSnapshot; atLeastGeneration: number }` for corpus). On timeout the call rejects with a dedicated `FreshnessTimeout` Error (`src/coordinator/consumer-driver.ts`) whose message includes `consumerId`, the rendered target, and `timeoutMs`; rejection removes only that waiter and does not invalidate the consumer cursor, abort `apply()`, or affect subsequent `waitFreshUntil` calls. `waitFreshUntil` never wakes spuriously: the wake is driven by `ConsumerDriver.notify` after authoritative writes, with no polling fallback.
42. Expansion failure never blocks coordinator writes. A failed `apply()` retains the last-successful cursor; next `notify` or startup recovery retries the gap. If a caller explicitly waits for that consumer as part of a readiness contract, the wait/job reports the readiness failure while the Corpus commit remains durable.
43. Each `RuntimeBinding<T>` accepts at most one bound value at a time. Attempting to bind a binding currently held by another scope fails with structured `CoralSetupError('binding_occupied', { heldBy })`. Single-occupancy is enforced inside the binding primitive (`runtime/binding.ts`), not by lifecycle bookkeeping. The error surfaces to the user as: "binding `<name>` is held by `<holder>` — run `/equip uninstall <holder>` first" (skill grammar; routes internally to `coral-cli expansion unequip <holder>`).
43a. Bundled engines are Expansions that auto-equip as a fallback pass at coordinator boot, after installed-engine recovery, filling only empty slots. Every binding is filled by an Expansion under a scope; no binding is created with an initial value. Tier (bundled vs installed) controls lifecycle (when equipped, who can unequip), not invocation mechanism.
43b. An `Expansion` is a function `(host: ExpansionHost) => void | Promise<void>`. Expansions do not export `id`, `priority`, `slots`, `requires`, `install`, `uninstall`, `activate`, or `deactivate` fields on a contract object. Identity is the import specifier; priority is registration order; binding fill is `host.bind(binding, backed)`; capability deps are `host.require(binding)`; install is a CLI-tier concern that runs before the Expansion is loaded; deactivation is `scope.dispose()`.
43c. `Backed<T>` readiness is a comparison: `backed.consumer.cursor ≥ <authority version>`. No `Backed<T>` exposes a boolean `isReady()` or `waitForReady()` method on its public contract. The only readiness primitive in the system is the coordinator-owned `ConsumerDriver.waitFreshUntil(authority, version, consumerId)` from §9.4 (see invariants #41a/#41b). Routing the wait through ConsumerDriver — rather than a per-authority accessor on `Runtime` — keeps freshness coordination a single-writer concern owned by the layer that already owns `notify(authority, version)` fan-out; expansion-tier consumers receive the same primitive without a parallel access path.
43d. `kb.embedding` is a peer-category slot. All three KB slots (`kb.fts`, `kb.vector`, `kb.embedding`) start empty; embedders are bundled or installed engines like any other. Switching embedders requires `coral-cli expansion unequip <current>` then `coral-cli expansion equip <new>` (structural single-occupancy via `binding_occupied`). `BUNDLED_ENGINES` carries ≥1 entry whose Expansion body fills `kb.embedding` so the binding is fillable.
44. **Apply-kind** consumer `apply(ctx)` must be **idempotent**. Apply-kind covers expansion-tier journal consumers and corpus consumers; for them the cursor advances only after `apply()` resolves successfully, and a crash between apply and cursor persistence causes the same range to be re-applied on startup, so implementations must tolerate replay (`upsert` semantics, not `insert`). Base journal cursor-only consumers are out of scope for this invariant — they run no `apply()` outside the commit transaction (§3.3, §9.1) and therefore have no apply/cursor persistence gap.
45. Read-side event body decode routes through upcast-aware helpers. Outside `src/store/body-codec.ts`, `src/store/append.ts`, `tests/helpers/rebuild-projections.ts`, and `src/store/envelope.ts`, `schema.parse(decodeEventBody(...))`, `.parse(...)` on values sourced from `decodeEventBody(...)`, and the one-arg `rowToCoralEvent(row)` overload are forbidden.
46. Unused public facades stay deleted. Tests and integration code import the real contract or owner module directly instead of preserving `api.ts` barrels that production never imports.
47. Raw `job.terminal.recorded` object construction is owned by `src/jobs/terminal/recording.ts`. Other producers finalize through that builder.
48. `coordinator/services/**` consumes domain ports/contracts, not domain shell implementation classes. Shell implementations are wired at composition roots.
49. Launch/admission vocabulary is jobs-owned. `LaunchPool`, admission handles, queue read ports, and recovery launch ports are defined under `src/jobs/*`; coordinator contracts may compose those ports but must not redefine `ExecutionLaunch*` mirrors.
50. Domain/provider modules do not read host time, environment, or randomness directly. Current time, env, and ids enter through runtime/domain ports; direct ambient access is restricted to infra/runtime/CLI/bootstrap adapters and explicit parsers.
51. KB availability is encoded in `runtimeState.kbStatus: { kind: 'ok' } | { kind: 'unavailable'; reason }` set exactly once at boot by the KB-init aggregator. Curate publish-health is a separate concept (`runtimeState.curateHealth`); curate degradation does NOT block KB IPC ops. `withKb` reads `kbStatus`; `/health` exposes both `subsystems.kb` (from `kbStatus`) and `subsystems.kbCurate` (from `curateHealth`).
52. Concurrent `RuntimeBinding<T>.bind()` calls to the same binding are linearized inside the binding primitive (`src/runtime/binding.ts`) — exactly one wins, all others receive `binding_occupied`. Tier (bundled vs installed) does not affect race ordering; installed-tier engines are recovered first by lifecycle ordering (§2.8a), not by binding-level priority. Engine-level mutex (`coordinator/expansion/lifecycle.ts:engineMutex`) is reserved for state-row pairing only — it does not police binding occupancy.
53. Long-running operations carry an `AbortSignal` in their context (`apply(ctx)` for apply-kind journal/corpus consumers, `withMutationLock(fn, { signal })` for KB mutations, `KbJobRecorder.startInternalJob` for KB internal jobs). The abort vocabulary — `AbortError` / `isAbortError(err)` / `throwIfAborted(signal, stage)` — has a single home at `src/runtime/abort.ts` (re-exported from `src/runtime/errors.ts`); ad-hoc local abort helpers are forbidden by invariant test. `coral-cli abort <jobId>` is a best-effort fence: recipients are obligated to honor the signal at the next checkpoint; recipients that do not honor it surface as wrapper-class faults via reconciliation, not as silent ignores. Authority writes (Journal commits, Corpus mutations) complete or rollback as a unit — cancellation cuts at boundaries, not mid-mutation.
54. Numeric constants split into two bins: **design invariants** (numbers that, if changed, would invalidate spec reasoning) live as `INVARIANT.<name>` members on a per-file `INVARIANT` const object in the layer that owns them and are documented in §16; **operator knobs** (numbers reasonable users may want to tune for their environment) follow the `worker-limits.ts` pattern with `CORAL_<NAME>` env override (a separate `runtime/config.ts` registry has not been needed and is not pre-declared). Triage rule: 'If a user changed this number to 5, would the system still match spec? Yes → operator knob; No → design invariant.' Existing invariants applied under this convention: `INVARIANT.MAX_CONSECUTIVE_FAILURES = 10` ([`src/kb/curate/state/model.ts`](../../src/kb/curate/state/model.ts), curate lane-disable), `INVARIANT.MAX_STALE_RECOVERY_RETRIES = 2` ([`src/workflow/stale-recovery.ts`](../../src/workflow/stale-recovery.ts), workflow recovery). The IPC-ensure timing constants (`STARTUP_POLL_MS`, `STARTUP_TIMEOUT_MS`, `SICK_VERIFICATION_WINDOW_MS`, `CORRUPT_LOCK_RETRY_LIMIT`, `HEALTH_TIMEOUT_MS` at [`src/transport/ipc/ensure.ts:20-24`](../../src/transport/ipc/ensure.ts#L20)) are deliberately left as plain `export const` per §11.2 — neither yet promoted to `INVARIANT.<name>` nor surfaced as `CORAL_*` env knobs; that classification is deferred to a follow-up phase rather than guessed.

---

## 17. Glossary

- **Coordinator**: the single-writer daemon. Mediates writes to both authorities (Journal + Corpus), owns live state (admission, host pool, subscriptions), and is the only layer that opens writable handles.
- **Journal authority**: the `events` table inside `~/.coral/data/store/store.db`. The authoritative source for process-like domains (`job`, `session`, `discuss`, `workflow`). Append-only; truth is the ordered history of events.
- **Corpus authority**: the markdown filesystem at `~/.coral/kb/` (git-tracked). The authoritative source for knowledge content (notes, sources, principles, communities, entity graph). Truth is the current file contents; no event history.
- **Journal substrate**: SQLite database (`store.db`) — holds the events table, base projection tables, and `consumer_cursors`. Not a "global store"; it is the substrate for Journal authority only.
- **Corpus substrate**: filesystem directory tree under `~/.coral/kb/`. Git-tracked; Obsidian-editable.
- **Store**: the single SQLite database at `~/.coral/data/store/store.db` in prod and `~/.coral/data-dev/store/store.db` in dev. Holds events + projections for Journal domains. KB indexes are projections too but live under `~/.coral/data/kb/` (prod) or `~/.coral/data-dev/kb/` (dev) since they derive from Corpus, not Journal.
- **Events table**: append-only SQL table keyed by `seq` (auto-increment). The only durable truth.
- **Projection tables**: SQL read models (`projection_jobs`, `projection_sessions`, `projection_workflows`, etc.) maintained incrementally by event reducers in the same transaction that appends events.
- **CoralStore**: unified read API covering **both authorities**, implemented in `read-model/coral-store.ts`. Journal reads go through domain-owned query modules over SQLite (`events` + `projection_*` tables); Corpus reads go to explicitly resolved filesystem roots plus KB-owned query helpers. Consumers call `store.jobs.detail(id)` or `store.kb.read(slug)` without knowing which authority backs the query, but the adapter constructing `CoralStore` must provide the project/plugin context for KB reads. Multiple read handles can coexist; single writer (coordinator) owns mutations.
- **CoralCoordinator**: the single-writer daemon. Owns live state (admission, host pool, subscriptions) and is the only layer that opens a writable DB handle.
- **Stream**: a logical sub-sequence of the events table identified by `(stream_kind, stream_id)` — e.g., `job/wf-1`, `session/s-42`, `workflow/wf-1`. Ordering is global via `seq`.
- **Envelope**: the event header — `seq`, `ts`, `type`, `stream`, `namespace`, `refs`, `correlationId`, `causationSeq`, `bodyVersion`. Wraps a `body`.
- **Body**: the domain-owned payload. Validated by the domain's Zod schema at the current `bodyVersion` (with upcaster chain for older versions).
- **bodyVersion**: per-event-type schema version. Each event type starts at 1; bumps require registering an upcaster.
- **Upcaster**: pure function that lifts an older-version body into the current shape at read time. Old events are never rewritten.
- **CauseRef**: `{ stream: {kind,id}, seq }`. A pointer to the event that caused this outcome. Used by `TerminalOutcome.failed` and `workflow.completed`.
- **Projection rebuild**: `DROP` + repopulate `projection_*` tables from the events table. Pure, deterministic, bounded by events count.
- **Reconciliation**: imperative post-startup phase that compares projected state to observed world (processes, DB state) and appends new events when they disagree.
- **Export**: a materialized file outside its authority, such as a Journal job's `result.md`. Rebuildable from the relevant authority. KB markdown is not an export; it is the Corpus authority.
- **JobView**: the projected read shape for a job — stable launch identity (`sessionId`, `provider`, `projectRoot`, `backendNamespace`, `bundleHash`, `jobKind`), lifecycle summary (`phase`, `terminal`, `diagnostics`), workflow linkage (`parentWorkflowJobId`, `workflowSlot`), `createdAt`, `lastSeq`. Children derived by SQL query, not embedded.
- **WorkflowView**: the projected read shape for a workflow — plan, slot outcomes, overall outcome, causeRef, lastSeq.
- **WorkflowPlan**: `{ slots: WorkflowSlot[] }`. Declared once per workflow via `workflow.plan.declared`. The workflow stream identity (`event.stream.id`) is the plan's id; labels are derived at render time from `slot.agent ?? prompt#${atomIndex}(${truncated instruction})`. Neither workflowId nor labels live on the plan body.
- **WorkflowSlot**: `{ slotId, dependencies, provider, instruction, agent? }`. The durable unit of work composition.
- **WaitCursor**: `{ afterSeq }`. A single global position for subscribers.
- **TerminalOutcome**: 5-variant union — `completed | aborted | provider_exit | failed{causeRef} | job_fault{JobLifecycleFault}`.
- **JobLifecycleFault**: 3-variant union — `ghost_launch | wrapper_lost | wrapper_crashed`. The only fault ADT in the system; all other failures are domain events referenced via `causeRef`.
- **Middleware**: `(next: Provider) => Provider`. Composable layer around a provider kernel.
- **Provider kernel**: the leaf `Provider` function for a specific CLI/app-server — the pure execution unit.
- **Host pool**: coordinator-owned pool of long-running app-server subprocesses (Claude, Codex).
- **Namespace**: caller/emitter identity on an event. Not the same as `stream.kind`.
- **Engine**: the installable noun and source/data identity. Engine source lives under `src/engines/<id>/`; rebuildable local engine state lives under `~/.coral/data/engines/<id>/` when the engine owns such state.
- **Expansion**: lifecycle pattern and user verb. An engine ships one Expansion body, and users equip installed engines through `/equip <name>` / `coral-cli expansion equip <name>`. Expansions may bind one or more runtime bindings to sharpen an existing query path; they never write authorities or add new commands.
- **Base tier**: the default runtime after plugin install (~3MB bundle, no native deps). Zero-config surface works immediately through bundled FTS. Vector retrieval is unavailable until `kb.vector` and `kb.embedding` are both filled by equipped engines.
- **Equipment metaphor (Zelda UX)**: curiosity-driven discovery, never enforced. Base tier always works; equipping is a reward for looking, not a gate to close. Equipment sharpens existing capabilities, never unlocks new commands.
- **`/equip <name>`**: skill verb that routes to `coral-cli expansion equip <name>` and equips an Expansion. `/equip uninstall <name>` preserves the user grammar while routing internally to `coral-cli expansion unequip <name>`.
- **Orama**: bundled KB FTS engine. Fills `kb.fts` only. Pure JS, auto-equipped by the bundled fallback pass.
- **coral-needle**: installed vector engine. C++ N-API addon at `../coral-needle` providing DuckDB-backed ScanANN vector search (exact / USearch HNSW / ScaNN tree-AH, auto-selected). Fills `kb.vector` when equipped and requires `kb.embedding` to be filled by a peer engine. Distributed as prebuilt binaries via GitHub Releases.
- **base-search**: source-import/readiness level that waits on the consumer currently bound to `kb.fts`. In normal startup this is the bundled Orama FTS consumer, but callers use the binding's `consumer.id` rather than hardcoding an engine id.
- **active-vector**: source-import/readiness level that waits on the consumer currently bound to `kb.vector`. If the binding is empty, readiness fails with `binding_empty` instead of falling back to FTS.
- **Retrieval capability surfaces**: `FtsRetrieval` and `VectorRetrieval` live in `src/kb/contract.ts`; engines adapt to these surfaces before binding `kb.fts` or `kb.vector`.
- **ConsumerDriver**: in-process driver that handles `notify(authority, version)` signals for registered consumers and exposes the condition-variable wake for `waitFreshUntil(authority, version, consumerId)`. Two flows by registration kind: **cursor-only** (base journal projection consumers — projection rows already written by the commit-time reducer in §3.3; the driver advances `consumer_cursors` directly and resolves waiters), and **apply-kind** (expansion-tier journal consumers and corpus consumers — the driver invokes `apply(ctx)` with single-in-flight guarantee for backpressure safety, persists the cursor only after success, and re-runs on the next notify if apply fails). Lives at `src/coordinator/consumer-driver.ts`.
- **`waitFreshUntil(authority, version, consumerId)`**: blocks until the named consumer's cursor reaches the target authority version. Journal callers pass `events.seq`; Corpus callers pass `contentSeq` or `metadataSeq`. Implemented as condition-variable wake, not polling.
- **`consumer_cursors`**: SQLite table that persists each consumer's cursor (per authority). Source of truth for "where is each projection consumer caught up to".
- **JournalConsumer**: projection consumer subscribing to Journal authority. Two shapes: `JournalCursorConsumer` (cursor-only, used by all four base journal projections — production runs no `apply()` because the commit-time reducer already wrote the projection rows in the same `BEGIN IMMEDIATE`; `ConsumerDriver` advances the cursor directly on notify) and `JournalApplyConsumer` (range-based — `apply({ upToSeq, signal })` reads events from `seq > cursor AND seq <= upToSeq` and applies them in order; used by expansion-tier consumers that derive their own state from journal events).
- **CorpusConsumer**: projection consumer subscribing to Corpus authority. Snapshot-based: `apply({ contentSeq, metadataSeq, signal })` captures a corpus snapshot, diffs content hashes against its last manifest, applies only changes. **Reuses the manifest-diff + atomic-snapshot-swap logic from today's `ensureVectorIndex`, but inverts the invocation model** — today pull-driven (called lazily before search), tomorrow push-driven (driven by ConsumerDriver after Corpus writes). The diff half is a port; the trigger half is a rewrite.
- **Corpus mutation lock**: single-writer lock around the Corpus authority. Coordinator-mediated CLI writes acquire it for markdown atomic writes, Corpus version bumps, and lightweight Corpus metadata/index state. Retrieval projections such as Orama and needle run as CorpusConsumers after the lock releases.
- **contentSeq / metadataSeq**: monotonic version counters for the Corpus authority. Two lanes because content and metadata changes have different freshness semantics. Analogous to `events.seq` on the Journal side, but versioning the whole corpus rather than counting discrete events.

---

## 18. Verdict

Six pioneers + All-6 unifier + B-v2 reëxamination + Pioneer-final + KB-pioneer converge on one form: **One coordinator, two authorities.** Every piece is load-bearing:

- **Journal authority** (SQLite `events` table) is truth for process-like domains: `job`, `session`, `discuss`, `workflow`. ACID transactions + range replay.
- **Corpus authority** (markdown filesystem at `~/.coral/kb/`, git-tracked) is truth for knowledge content: `kb`. Atomic rename + content-hash diff.
- **CoralCoordinator** is the single writer across both authorities — not for gatekeeping but because live-state ownership (admission, host pool, subscriptions) naturally pools there.
- **Two independent authorities, no cross-pointers** — Journal events do not embed typed references to Corpus entries (§2.4). KB recovery (rescan, retry queue, baseline rebuild) consumes its own substrate; job lifecycle records hosted-KB attempts on the hosting `job/<id>` stream without re-persisting the targeted slug into the envelope.
- **Canonical event bodies** are the provider contract for Journal writes.
- **WorkflowPlan on `workflow/<id>`** is the durable composition aggregate. Child launches reference slots by `slotId`; labels and step/atom indices are derived from the slot for launch/render identity. Completion `stepDetails` stores execution summaries for completed atoms.
- **Causal graph** (CauseRef pointers) is the fault model within Journal. Failures live once on the originating stream; terminals dereference, never wrap.
- **Three-variant `JobLifecycleFault`** is the only fault ADT — reserved for wrapper-local failures with no domain origin.
- **Two consumer interfaces** match the two authorities: `JournalConsumer` (range replay) + `CorpusConsumer` (snapshot content-hash diff). Both share `ConsumerDriver` mechanics (cursor, idempotent apply, condition-var wake).
- **Zelda-style equipment model**: base tier always functional for zero-config FTS through the bundled `kb.fts` binding. `kb.vector` remains empty until a vector engine is equipped; `/equip needle` fills that binding for scale without adding commands. Curiosity-driven, never prompted.
- **Command-class routing** replaces transport-topology assumptions.
- **Journal recovery** = projection rebuild + reconciliation. **Corpus recovery** = rescan + per-consumer snapshot diff. Each authority recovers from its own truth.
- **Schema evolution** via per-`type` `bodyVersion` + upcasters (Journal) or ordered SQL schema scripts (projection tables); Corpus evolves through markdown format changes that the frontmatter parser accommodates.

The two-authority model is not an asymmetry to apologize for — it is Coral's **duality**. Process-like state lives on time (Journal). Knowledge-like state lives in space (Corpus). Forcing one substrate on both would distort one; naming them separately reveals the structure honestly.

Five elegance axes hold (inevitable / self-evident / essential / natural / resonant) with zero cost-axis residue. Adversarial review rounds have converged; the design now resists further sharpening without violating one of the axes.

This document's canonical body and invariants are the sole design reference for any `/coral:plan` session implementing this architecture. Implementation-time corrections are folded into the relevant sections above; they are not maintained as standing amendments.
