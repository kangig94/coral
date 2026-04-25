# Final Unified Architecture — 2026-04-18

**Status**: Self-contained design specification. No prior documents required.
**Synthesized from**: six pioneer verdicts (A–F), the All-6 meta-pioneer unifier, Pioneer B-v2's reëxamination under event-sourcing, and Pioneer-final's ground-up critique. Cost was explicitly excluded from selection.

**This is a clean-slate rewrite, not a migration.** Existing `~/.coral/` state is assumed destroyed before the new build runs. No migration path exists or is planned. The document describes only the endpoint; transitional constructs, backward-compat fields, and dual-write windows are out of scope.

**Solo-development model, no transition period.** Coral is developed by a single author. No deployment happens until the refactor is complete AND all declared features (including post-refactor items like the Orama vector backend) land. There is no window in which users run "refactor done but feature X pending." The doc therefore does not specify transition-period behavior, partial-feature error paths, or compatibility shims for in-flight development. Every capability the doc declares is available at first deploy.

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
- **Cross-authority references** = `KbRef = { entryId, contentHash? }`. `contentHash` optional for point-in-time semantics.
- **Schema evolution** = per-`type` `bodyVersion` + upcaster chain for Journal events; ordered SQL schema scripts for projection schema; markdown format evolution via frontmatter parser flexibility.
- **Equipment** (Zelda UX) = opt-in `/equip needle` enhances specific query paths. Base tier fully functional with Orama (FTS zero-config, vector with embedding provider config per README). No native deps in base bundle.
- Everything else (`status.json`, `result.md` as authority, `WorkflowCheckpoint`, `LaunchState` files, segment rotation, checkpoint files, advisory `writer.lock`, multi-variant `CoralFault` union, unified "everything is an event" thesis) either becomes a projection/export or disappears outright.

Flavor-gated data families use sibling top-level roots: production data under `~/.coral/data/<family>/`, development data under `~/.coral/data-dev/<family>/`. Do not encode flavor into the family name (`data/<family>-dev/`). This applies to the Journal store, Corpus-derived retrieval artifacts, equipment runtime artifacts, and any future device-local rebuildable state. The Corpus authority itself remains `~/.coral/kb/` for production and `~/.coral/kb-dev/` for development.

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

### 1.4 Six files per job
Per `<os-tmpdir>/coral-jobs/<jobId>/`: `status.json`, `progress.jsonl`, `launch.json`, `runtime.json`, `exit.json`, `result.md`. `recovery-core.ts` has a 10+ row classifier table because each file-presence combination carries different meaning. The classifier is a symptom of fragmentation.

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

### 2.4 Cross-authority references

Journal events referencing KB entries use `KbRef = { entryId, contentHash? }`:
- `entryId` alone → **late-bound** (resolves to current Corpus content).
- `entryId + contentHash` → **point-in-time** (preserves historical meaning even if the Corpus entry is later edited).

This is the sole asymmetry the two-authority model admits, and it is honest: Journal events are immutable, Corpus entries are mutable. The reference shape acknowledges the gap rather than pretending it does not exist.

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
| `kb/` | Corpus markdown authority and KB query semantics | Corpus files under mutation lock | Equipment view through KB runtime port | Equipment slot ownership, coordinator startup |
| `coordinator/` | Live state, startup order, equipment slots, ConsumerDriver, cross-domain assembly | Authority writes through domain shells/substrates | Broad domain owner modules/contracts | Domain vocabulary or wire formatting |
| `transport/` | No truth; carriage only | Nothing authoritative | Coordinator ports and domain contracts | Business behavior, startup, recovery |
| `cli/` | User command surface and local startup/activation glue | No domain truth directly | IPC/HTTP clients and `read-model/CoralStore` | Backend/domain truth |
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
| Projection freshness wait | Orama/needle catch-up after Corpus commit | `ConsumerDriver.waitFreshUntil(...)` | Freshness is not authority; failure is reported by the hosting command/job. |

`kb source import` is job-backed because document conversion, staging, Corpus commit, and retrieval readiness can take real time even before needle is installed. `kb search`, `kb read`, memo operations, and note writes remain direct because their expected path is immediate and their authority changes are small. Direct KB list/read paths do not lazily repair or rebuild durable text artifacts; explicit `kb reindex` owns that durable work. If a future direct command gains long-running recovery semantics, the job boundary moves for that command only; the whole KB surface does not become job/wait by default.

Direct reads are not ambient reads. The CLI/bootstrap edge resolves plugin root, build flavor, project root, Corpus markdown root, and KB runtime root before invoking KB/read-model code. KB path helpers and `CoralStore` do not silently choose `cwd`, `HOME`, or the user's default KB; that choice belongs at the local command/composition edge.

**Flavor is a runtime input, not ambient state.** The build flavor (`prod` / `dev`) is resolved once at the bootstrap edge from `CORAL_FLAVOR` or the bundle manifest, then **passed as an argument** to `createRealRuntime(flavor)`. Once constructed, the runtime's `paths.coral` exposes the resolved path families (`store`, `coordinator`, `corpus`, `exports`, `equipment`); domains and coordinator services consume paths through this port. There is no `setBuildFlavor` / `currentBuildFlavor` global, no `getSettledBuildFlavor` accessor, no lazy port construction guarded by `E_FLAVOR_NOT_SETTLED`. A process-wide singleton would force lazy port resolution, which would force defensive `try/catch` fallbacks at every consumer, which would invite parallel access paths (factory + port) that drift apart. Threading flavor as input collapses all of that. Module-level helpers like `composeCoralPaths(flavor, opts?)` and `coordinatorPaths(flavor, env, opts?)` exist for the bootstrap edge that does the resolution; downstream code reads paths from `runtime.paths.coral`, never by recomputing from a global.

### 2.8 Extension Model (Equipment)

Coral ships as a lightweight plugin (~3MB bundle): install gives a fully functional system for its zero-config surface (CLI, jobs, sessions, discuss, workflow, KB FTS). Features that intrinsically need external resources (vector search needs an embedding provider; ANN at scale needs a native addon) are documented in README with a one-line setup per feature. Users opt into heavier capabilities via the `/equip <name>` skill, which routes to `coral-cli expansion equip <name>`.

**UX philosophy — Zelda-style**:
Equipment is **curiosity-driven**, never enforced. A user scanning the CLI notices `/equip` exists, reads what's in the catalog (`/equip --list`, internally `coral-cli expansion list`), and picks something interesting if they want to. Nothing prompts, nags, or requires them to equip. The base tier remains fully functional forever — equipping is a **reward for curiosity**, not a completion requirement.

The metaphor: Link's base sword always works. Finding the bow is exciting because it opens new play, but Link was never broken without it. Coral's base tier always works. Finding needle is exciting because it sharpens KB search, but KB was never broken without it.

**Three-layer taxonomy**:
- **Skill** (`/equip`) = the user verb and onboarding surface.
- **Expansion** (`src/expansion/`) = the installable noun (`needle`, `cgc`, ...).
- **Equipment** (`src/coordinator/equipment/`) = the coordinator slot where an active expansion runs.

**Two-tier runtime**:
- **Base tier** — the default after plugin install. Zero-config surface (CLI, jobs, sessions, discuss, workflow, KB FTS) works immediately. Vector search additionally requires an embedding provider (Google Gemini API key is the documented default; one-line README setup).
- **Equipped tier** — one or more equipments active. Same commands, sharper implementations on specific query paths.

**Equipment principles**:
1. Equipment **replaces a specific projection backend**, it does not add new commands. The CLI surface is identical in both tiers.
2. Equipment **never writes an authority**. Journal events and Corpus markdown remain truth; equipment maintains additional or replacement projections.
3. Every equipped projection is **rebuildable from the authority it serves**. Journal equipment replays events; Corpus equipment diffs Corpus snapshots. Equipping = install + subscribe + build local projection state.
4. **`coral-cli expansion unequip <name>`** (surfaced to users as `/equip uninstall <name>`) returns the replaced path to the base backend without data loss and without command availability changes.
5. Equipment is loaded via **dynamic import** — the heavy dependency enters the process only after `/equip` completes.
6. Equipment is **never prompted** — the base tier must never display "equip X to unlock this" suggestions. Discovery is through `/equip --list` (internally `coral-cli expansion list`) or documentation, not through nagging.

**First equipment: `/equip needle`** (catalog id: `needle`):
- C++ N-API addon at `../coral-needle` (sibling repo). Prebuilt binaries via GitHub Releases for 5 platforms.
- Provides DuckDB-backed ScanANN vector search: exact brute-force, USearch HNSW, Google ScaNN tree-AH (auto-selected by dataset size).
- Replaces the KB vector search backend: Orama's base-tier cosine search → needle's ANN search.
- FTS (Orama BM25) is unchanged in both tiers.
- Hybrid RRF uses whichever vector backend is active.
- Onboarding: embedding provider setup (local ONNX model or manual config) — see `skills/equip/SKILL.md`.

The `/equip` skill now lives at `skills/equip/SKILL.md` only. The deleted helper files `skills/equip/install.mjs`, `skills/equip/coordinator-client.mjs`, `skills/equip/equipment-paths.mjs`, and `skills/equip/fs-lock.mjs` are replaced by the `coral-cli expansion list|equip|unequip|update|info` surface plus pure expansion workflow/install modules, CLI-owned activation (`src/cli/expansion-activation.ts`), `src/coordinator/discovery-api.ts`, `src/expansion/paths.ts`, and `src/infra/fs-lock.ts`. The post-refactor catalog uses tool-named entries (`needle`, and future tools by tool name) rather than capability-named entries, matching the Zelda equipment metaphor.

Equipment activation is tracked in an explicit durable slot registry, not by implicit boot-time registration. In the clean-slate rewrite, `001_initial.sql` includes `equipment_state`; slot `kb.vector` defaults to owner `orama` and may be reassigned to equipped owner `needle`. The KB router reads slot ownership through `KbRuntime.getEquipmentView()` (no coordinator import), and boot-time needle auto-registration is removed: the addon enters the process only via `/equip needle` activation routed through `coral-cli expansion equip needle`. Orama's base-tier vector implementation lands alongside the refactor, so first deploy already has a working default owner for `kb.vector`.

**Equipment paths are per-name closures, not per-name standalone functions.** `runtime.paths.coral.equipment` exposes `dataDir(name)`, `addonPath(name)`, and `installLockPath(name)` — closures bound to the resolved `EquipmentPaths` family. Equipment consumers (lifecycle, expansion install/activate, retrieval backends) call these closures with the equipment name and never recompute paths from `coralRoot()` or compose the path family themselves. This keeps path-shape decisions (e.g., "data lives under `data/equipment/<name>/`") in one place — the `equipmentPaths` composer — and prevents per-call sites from quietly diverging on naming or layout. Wrapper helpers like a former `createExpansionPathHelpers(name)` that re-derived paths per call are an anti-pattern: the closure form already provides the same ergonomics with one less layer of indirection.

**Projection freshness model**:
Equipment consumers subscribe to an **authority** (Journal or Corpus, §2). Each authority has its own monotonic version:
- Journal authority → version is `events.seq`; consumers use range-based replay.
- Corpus authority → version is `contentSeq` (or `metadataSeq` for metadata-only changes); consumers use snapshot-based content-hash diff.

Both use the same `ConsumerDriver` mechanics: receive `notify(authority, version)` signals after an authoritative write, drain in a single-in-flight microtask (backpressure-safe), persist the cursor only after successful `apply()` completes, and expose `waitFreshUntil(authority, version, consumerId)` as a condition-variable wake (not polling). Journal waiters target `events.seq`; Corpus waiters target `contentSeq` / `metadataSeq`. `listEquipment` is status observation, not the freshness primitive. Consumer `apply()` must be **idempotent** — a crash between apply and cursor persistence causes the same range to be re-applied on startup; consumer implementations must tolerate this (`upsert` semantics, not `insert`).

For coordinator-mediated KB writes: the Corpus mutation lock wraps only authoritative markdown writes, Corpus version bumps, and lightweight Corpus metadata/index state. Retrieval projections are CorpusConsumers: the base Orama consumer (FTS + vector over one shared snapshot) and the equipment-tier needle vector consumer both receive the post-commit notify and drain asynchronously.

This decouples projection latency from authoritative write latency: a slow or failing retrieval projection never blocks the Corpus commit. A caller that needs strict retrieval readiness waits after commit via `waitFreshUntil`; if the wait fails, the Corpus commit remains durable and the running job reports the readiness failure. Failed drains retain the last-successful cursor for retry on next `notify` or startup. Fault isolation is structural.

---

## 3. Journal Substrate (SQLite)

The Journal authority (§2.1) is backed by a **single transactional event database**. Path depends on build flavor (hook isolation requires flavor-gated paths):
- prod: `~/.coral/data/store/store.db`
- dev: `~/.coral/data-dev/store/store.db`

This is the general flavor layout rule for device-local rebuildable data: `data/<family>/` in prod and `data-dev/<family>/` in dev, never `data/<family>-dev/`.

SQLite in WAL mode is the reference implementation: it provides append-only write semantics, ACID transactions across multiple events, concurrent readers, and a single-writer discipline via `BEGIN IMMEDIATE` — all properties the Journal requires, without reinventing them.

The Corpus authority (§2.2, §6.4) uses the filesystem directly and is documented separately. This section covers only the Journal substrate.

### 3.1 Schema

```sql
-- The journal: append-only event log
CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,  -- global total order
  ts             TEXT    NOT NULL,                   -- ISO 8601
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

-- Equipment projection cursors (async push model; see §2.8).
-- Cursor interpretation depends on the consumer's authority:
-- - Journal consumers: `cursor` is the last applied events.seq.
-- - Corpus consumers: snapshot_id + the seq/hash columns describe the last
--   applied snapshot. `corpus_interest` declares which lane the consumer
--   subscribes to ('content' for vector/FTS that depend on body text,
--   'metadata' for tag-only changes, 'both' otherwise) so a metadata-only
--   bump never wakes a content consumer. `lane` is a hint used to short-
--   circuit fan-out when a publication carries a single lane.
CREATE TABLE IF NOT EXISTS equipment_cursors (
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
  equipped_at            TEXT    NOT NULL,      -- ISO 8601 of most recent equip
  registration_kind      TEXT    NOT NULL DEFAULT 'base'  -- 'base' | 'equipment'
);

-- Equipment activation registry (durable slot ownership; see §2.8).
-- Tracks which expansion currently owns each equipment slot and its
-- install/error state for diagnostics. The KB router reads this through
-- KbRuntime.getEquipmentView().
CREATE TABLE IF NOT EXISTS equipment_state (
  name               TEXT PRIMARY KEY,
  state              TEXT NOT NULL,
  installed_at       TEXT,
  last_error_code    TEXT,
  last_error_message TEXT
);

-- Curate scheduler bookkeeping (replaces today's curate-state.json).
-- Scalar scheduler state lives here; the active in-flight claim moves to
-- kb_curate_active_claim so the scheduler row stays single-row idempotent.
-- Two `processed_through_*` columns store the cursor as discrete fields
-- rather than opaque JSON so SQL can compare/order them.
-- `last_attempted_through_*` lets the scheduler back off without losing
-- the last successfully-processed checkpoint. The two
-- consecutive_*_failures counters drive exponential backoff.
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

Every coordinator-side operation that touches multiple streams runs as **one SQL transaction**:

```sql
BEGIN IMMEDIATE;
  INSERT INTO events (...) VALUES (...);    -- e.g. session.provider_failed on session/s-1
  INSERT INTO events (...) VALUES (...);    -- e.g. job.terminal.recorded on job/kb-1 with causeRef
  UPDATE projection_jobs SET ... WHERE job_id = 'kb-1';
  UPDATE projection_sessions SET ... WHERE session_id = 's-1';
COMMIT;
```

Either all appends land and all projections update, or none do. Replay never sees partial truth — this is the atomicity commit groups need (§12.3).

### 3.4 Journal-domain exports

Materialized files for Journal domains (e.g., `result.md` per job) live outside the database and are rebuildable:

```
~/.coral/data/store/store.db                    (Journal substrate)
<os-tmpdir>/coral-jobs/
  <jobId>/result.md                  (materialized from job.terminal.recorded)
```

Deleting `<os-tmpdir>/coral-jobs/<jobId>/result.md` never loses truth — rebuild from Journal events. The
`~/.coral/exports/jobs/<jobId>/` path remains reserved for future tooling, but it is not the durable wait/follow
artifact.

Note: KB markdown files at `~/.coral/kb/` are **not exports**. They are the Corpus authority itself (§2.2, §6.4). Derived KB indexes (Orama, needle) live at `~/.coral/data/kb/` and are rebuildable from the Corpus.

### 3.5 Replay identity

Pure reconstruction holds: for any `seq_cutoff`, the projection rows derived by replaying events `[1..seq_cutoff]` are byte-identical to the projection rows SQLite would hold after committing those events. This is why `DROP TABLE projection_*` + full rebuild is a valid recovery path.

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
    kbRefs: z.array(z.object({              // cross-authority references to Corpus entries
      entryId: z.string(),
      contentHash: z.string().optional(),   // optional: point-in-time capture
    })).optional(),
  }).strict().optional(),
  bodyVersion: z.number().int().positive(),  // per-type schema version (starts at 1)
  body: z.unknown(),                         // domain payload
}).strict();
```

### 4.1 Why this shape

**`seq`**: global total order. SQLite ROWID provides this naturally. Every subscriber tracks a single `afterSeq` cursor.

**Four Journal stream kinds**: `job`, `session`, `discuss`, **`workflow`**. Workflow is its own kind because a workflow owns a durable plan separate from the jobs it spawns (§6.5). KB is NOT a Journal stream — it lives in the Corpus authority (§2.2, §6.4).

**`stream.kind` vs `namespace`**: two different concepts. `stream.kind` is *what this event mutates*; `namespace` is *who emitted it*. Conflating them would break sessions that cross namespaces and force per-namespace logs that fragment natural cross-domain references (a discuss event referring to a job across namespaces becomes a distributed join).

**`refs`**: typed dereferences. `refs.workflowSlotId` on a child job launch points into the parent workflow's plan (§6.5); `refs.parentJobId` points to the workflow job. `refs.kbRefs[]` is the cross-authority reference shape (§2.4) — each `KbRef = { entryId, contentHash? }` points at a Corpus entry with optional point-in-time hash. Typed shape avoids string-id-in-body anti-patterns.

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

`store.appendEvents()` remains a domain-neutral transaction substrate; it runs any composed append validators inside the same `BEGIN IMMEDIATE` transaction before the first insert, parses each input body through the registry schema before assigning a `seq`, and only then calls reducers. Reducers therefore can rely on `event.body` matching the registered schema, which is why a reducer never re-parses; the rebuild and consumer-apply paths route bodies through the same upcaster + schema before dispatch.

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

### 5.5 Why four Journal kinds

Every Journal event must tell projections which dispatch table applies. Collapsing to a single kind forces every projection to filter on `type` string prefixes — fragile, string-typed. Four kinds = four natural boundaries, each owning a genuinely different process-like vocabulary.

### 5.6 Why KB is not a Journal stream

KB entries are **knowledge artifacts**, not process events. They accumulate, get edited (often externally via Obsidian), and reference each other through entity graphs. The filesystem is the natural substrate: atomic rename, git-backed sync, direct human editability. Forcing a `kb/<id>` Journal stream would require bi-directional sync between filesystem and events, with race resolution for Obsidian edits — complexity with no compensating elegance.

KB's authority is the Corpus (§6.4). Journal events referencing KB entries use `KbRef` (§2.4).

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

Each job stream records **exactly one** `job.terminal.recorded` body, and that body is last on that job stream. `job.launch.rejected` and `job.aborted` are causal/domain events that can precede the terminal body; they are not substitutes for the terminal body.

**`job.progress.emitted` carries domain-specific failure detail**: when a job performs a domain operation (KB source import, KB curation step, provider-hosted KB mutation, etc.) and hits a failure, the failure is recorded as a rich progress event. In the implementation's discriminated progress body this is `kind: 'domain'`; `stage` names the semantic stage (e.g., `kb_operation_failed`); `detail` carries domain payload (e.g., `{ operation, entryId, cause }`). The terminal outcome then uses `failed { causeRef }` pointing back at this progress event on the same stream — self-stream causeRef is the normal pattern for job-local failure chains. This is why there is no separate `kb/<id>` stream: KB content is Corpus authority, while slow process-like KB attempts and KB work hosted by a running job report their failures on the hosting `job/<id>` stream. Fast direct KB commands that do not create a job return structured command errors instead of becoming Journal truth.

**Source import is a job-owned ingest attempt, not a KB stream**: importing a source may include PDF conversion, staging, Corpus commit, and retrieval freshness waits. Those are temporal process facts, so they belong on `job/<id>`. The imported source itself belongs only to the Corpus (`~/.coral/kb/sources/<slug>.md`). A source-import job completes according to an explicit readiness contract:

```ts
type SourceImportReadiness =
  | 'commit'        // source markdown is durably written to the Corpus
  | 'base-search'   // Orama FTS/base search consumer is fresh for the commit
  | 'active-vector' // current kb.vector slot owner (Orama or needle) is fresh
  | 'all-equipped'; // every installed Corpus consumer is fresh
```

The default CLI experience may create the job and wait internally, but the underlying contract is job/wait. The default readiness is `base-search`: after `kb source import paper.pdf` returns, `kb search paper` should observe the document. Stricter readiness (`active-vector` or `all-equipped`) is explicit because it binds the command to embedding and equipment latency.

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
session.closed                   { entry?, reason }
```

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
  orama/                            ← Orama snapshot directory (base-tier FTS + vector)
    orama-index.json                ← Orama serialized index
  needle/                           ← needle runtime storage (equipment-tier vector)
  needle-staging/                   ← needle staging area for snapshot builds
  equipment_cursors                 ← in store.db (SQLite); tracked per Corpus consumer
```

Project memos are deliberately outside this tree. They live under the project data directory as scratch capture artifacts for review/promotion. A memo becomes long-term KB only when promoted into a Corpus note/source; until then it is neither Corpus authority nor a CorpusConsumer input.

**Freshness counters** (versions, not events):

- `contentSeq` — monotonic counter; increments on any content mutation (promote, update, source-import).
- `metadataSeq` — monotonic counter; increments on metadata-only changes (tags, frontmatter).

These are analogous to `events.seq` on the Journal side but version the whole Corpus rather than counting discrete events. Consumers track their cursor against these counters and catch up via manifest diff (not event replay).

**Mutations** (coordinator-mediated, via CLI):

Fast coordinator KB operations follow the same pattern inside a single **Corpus mutation lock**:

1. `writeFileAtomic` — markdown `.tmp` + rename (atomic at filesystem level).
2. Bump `contentSeq` (or `metadataSeq`) in the corpus version state.
3. Update lightweight Corpus metadata/index state (`index.json`, manifest authority records) needed to describe the Corpus itself.
4. Release lock.
5. Notify Corpus consumers (`orama-base` for FTS+vector, `needle-vector` for equipment-tier vector, etc.) — they run their apply loop asynchronously (§9).

Retrieval artifacts are not built inside the authoritative critical section. A command that promises retrieval freshness captures the committed `contentSeq` / `metadataSeq` and waits for the relevant consumer cursor after the lock releases. This keeps the Corpus write small while still giving long-running commands a precise readiness contract.

External edits (Obsidian, manual filesystem ops, `git pull`) bypass the coordinator entirely. They are detected by startup scans and periodic rescans; CorpusConsumers pick up the drift via manifest diff.

**Source import readiness**:
`kb source import` is the one KB mutation whose shell is process-like by default. It stages/converts the external document, commits the resulting markdown source to the Corpus, then optionally waits for retrieval consumers according to the readiness contract defined in §6.1:

| Readiness | Completion condition |
|---|---|
| `commit` | Corpus source markdown is durable and `contentSeq` advanced. |
| `base-search` | `commit` + Orama FTS/base-search consumer cursor reached the committed `contentSeq`. |
| `active-vector` | `commit` + the current `kb.vector` slot owner (`orama` or `needle`) reached the committed `contentSeq`. |
| `all-equipped` | `commit` + every installed Corpus consumer reached the committed Corpus version. |

The command surface is identical in base and equipped tiers. Equipping needle changes only which consumer satisfies `active-vector`; it does not create a separate import command.
Retrieval readiness is observed through `waitFreshUntil('corpus', version, consumerId)` after the Corpus commit. If that wait fails, the source markdown and Corpus version remain durable; the hosting job records the readiness failure instead of rolling back knowledge content.

**Projections / search backends** (all rebuildable from the Corpus alone):

| Backend | Consumer ID | Role | Tier | Substrate |
|---|---|---|---|---|
| KB runtime/query layer | — (direct read, no consumer) | direct markdown read + list/diagnose helpers | base, always | `~/.coral/kb/` + `~/.coral/data/kb/` |
| **Orama** (JS-native) | `orama-base` | FTS (BM25) + vector (cosine), one consumer over one in-memory index | base, always | `~/.coral/data/kb/orama/orama-index.json` |
| **coral-needle** (C++ DuckDB ScanANN) | `needle-vector` | ANN vector at scale; replaces Orama's vector path | equipment (`/equip needle`) | `~/.coral/data/kb/needle/` |

**Why one Orama consumer, not two**: FTS and vector share the same Orama instance, the same on-disk snapshot, and the same atomic snapshot-swap lifecycle. Splitting them into `orama-fts` and `orama-vector` consumers would force two parallel apply paths over one underlying index — one in-flight `apply()` could swap the snapshot out from under the other. Treating Orama as a single consumer is structurally honest about what is one piece of state. `needle-vector` is a separate consumer because needle is a separate process-side index with its own snapshot store.

KB has no SQLite content projection in the steady state. Markdown remains authoritative; Orama/needle are rebuildable retrieval artifacts; SQLite stores only control state (`kb_corpus_state`, curate scheduler/retry tables, and equipment cursors).

**Equipment principle applied**:
- Command surface is identical in both tiers: `kb search "query"`, `kb search --vector <emb>`, `kb search --hybrid "query"` all exist.
- Base tier: Orama FTS (zero-config) + Orama vector (cosine brute-force). Vector requires embedding provider config — register Google Gemini API key per README, one line in `~/.coral/.env`.
- Equipped (`/equip needle`): vector and hybrid paths upgrade to ScanANN for scale. Uses the same embedding provider as base. FTS unchanged.
- No new commands appear from equipping. The needle sharpens existing blades, it does not add new weapons.
- Why not bundle ONNX for zero-config local embeddings? `onnxruntime-node` is ~82MB compressed / 210MB unpacked — roughly 40× the current plugin size. Bundling breaks the "click-install, just works" UX premise. A Google Gemini API key is a one-line README step; the free tier covers personal-scale KB use indefinitely. Users who need fully offline embedding can opt in via `/equip` onboarding which installs the local ONNX runtime alongside the needle addon.

**Why Orama is architecturally load-bearing** (not replaceable by SQLite FTS5):
Orama's value is NOT just FTS quality — it is the combination of (1) pure JS, zero native dependencies, and (2) dual-modal support (FTS + basic vector search) in one library. These together enable the Zelda-style base tier: full KB search functionality with zero install friction. Replacing Orama with SQLite FTS5 is superficially attractive (unified storage, FTS co-transactional with metadata) but collapses on the vector axis: SQLite has no native vector search; `sqlite-vec` requires a loadable C extension (native binary, kills the zero-dep premise); custom SQL cosine is slow and worse than Orama. Every alternative forces losing base-tier vector search or compromising the zero-native-dep base tier. **Orama is the only option that satisfies both constraints simultaneously.** The Corpus + indexes layout is role-specialization, not accidental complexity.

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

**Status note**: the current codebase has a partial, ad-hoc repair mechanism (`kb/curate/text-artifacts.ts`: `rebuildTextArtifactsAndPersistRepairState`, `detectTextArtifactRebuildInfo`, `pendingRepair[]`) that handles specific cases encountered during initial development. The refactor **redesigns** this from scratch — not porting the existing ad-hoc code but building a proper classification-driven repair pipeline. Coverage of the detected-issue taxonomy is a deliverable of the refactor, not a best-effort outcome.

Repair operations that mutate the Corpus go through the standard Corpus mutation lock (§6.4 mutations). No special substrate.

### 6.5 Workflow (`stream.kind = 'workflow'`)

```ts
workflow.plan.declared  { plan: WorkflowPlan }
workflow.plan.revised   { plan: WorkflowPlan }
workflow.drain.entered  { firstFailureSlotId, drainDeadline }
workflow.completed      { outcome: 'completed' | 'failed' | 'aborted'; causeRef? }
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
```

**Plan body owns no `workflowId` field** — the workflow stream identity (`event.stream.id`) is the truth. Storing it inside the body would be a duplicate that can drift from the stream id; helpers receive `workflowId` separately when they need it. This is the same "stream identity is truth" principle that keeps `stepIndex`/`atomIndex`/`label` off the launch event.

**Plan body owns no `labels` field** — labels are presentation, derived at render time from `slot.agent ?? prompt#${atomIndex}(${truncated instruction})`. Storing them separately would create a second source of truth that the `agent`/`instruction` fields could drift from. The `slotId` format above lets the renderer recover step/atom position without lookup.

**Why plan as a separate stream-kind**:
- Plan is a durable aggregate with semantics (dependencies, slot IDs) independent of any single job execution.
- Child jobs reference `refs.workflowSlotId` and `refs.workflowId`; the plan lives ONCE on the workflow stream, not duplicated on every child launch.
- `workflow.plan.revised` (future) can add/modify slots without touching child events — plans evolve without rewriting history.
- Syntax-shaped metadata (`stepIndex`, `atomIndex`, label) is encoded in `slotId` and `agent`, not stored as separate fields. `slotId` is truth; everything visible to a user is derived.
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
- `workflow_aborted` — replaced by `workflow.completed { outcome: 'aborted', causeRef? }` on the workflow stream; job terminal uses `aborted { reason: 'user_abort' }` or `failed { causeRef }` to the workflow completion event.
- `launch_rejected` — `job.launch.rejected` event on the job's own stream; `job.terminal.recorded` on the same stream uses `failed { causeRef }` pointing backward to the rejected event (self-stream causeRef is fine and common).
- `app_server_interrupted` — `session.interrupted` event on the `session/<id>` stream; job terminal uses `failed { causeRef }`.
- `adapter_output_unparseable`, `provider_session_unavailable`, `provider_request_failed` — each emitted on the `session/<id>` stream as `session.adapter_unparseable`, `session.provider_failed`, etc. Job terminal uses `failed { causeRef }`.
- `kb_operation_failed` — replaced by `job.progress.emitted { kind: 'domain', stage: 'kb_operation_failed', detail }` on the **hosting job's own stream** (slow KB attempts such as source import, or KB work performed inside an already-running job); job terminal uses `failed { causeRef }` pointing self-stream to that progress event. KB is not a Journal stream (§5.5, §6.4). Discuss provider/facilitator attempts record their operational outcome as `discuss.agent.job.finished` on `discuss/<id>`; any external terminal that needs to explain a discuss-origin failure points at that event with `causeRef`.

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
workflow/<id>             workflow.completed               { outcome: 'failed' | 'aborted', causeRef? }
```

KB failures have no dedicated Journal stream. Slow process-like KB attempts (source import, explicit reindex/curation jobs) and KB work performed inside an existing provider/workflow job record failures on the hosting job's own stream as rich progress events (`kind: 'domain'`, `stage: 'kb_operation_failed' | 'kb_curation_failed' | ...`), and the job terminal's `causeRef` points to that progress event. Fast direct KB commands that do not create a job return structured command errors. Background curate failures are operational logs, not events — retry is scheduled via `kb_curate_retry_queue` (§3.1). External edits themselves are the **normal** path (Obsidian + git + rescan auto-handle them, see §12.3); only **malformed** content (git conflict markers left in a file, invalid frontmatter) is treated as a skip + log case during rescan, not as an event.

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
| `job.progress.emitted` (with `kind: 'domain'`, `stage: 'kb_operation_failed'`/etc.) | `job/<id>` | hosting job shell; domain leaf (`kb/ops/`, `discuss/shell/`, etc.) supplies detail |
| `session.interrupted` | `session/<id>` | `coordinator/live/provider-hosts.ts` |
| `session.provider_failed` | `session/<id>` | provider leaf kernel |
| `session.adapter_unparseable` | `session/<id>` | `providers/middleware/adapter-parse-guard.ts` |
| `discuss.agent.job.finished` (failed/recovery outcomes) | `discuss/<id>` | `discuss/shell/` |
| `workflow.completed { outcome: 'failed' | 'aborted' }` | `workflow/<id>` | `workflow/executor.ts` |
| `job.terminal.recorded { outcome: { kind: 'job_fault', ... } }` | `job/<id>` | `jobs/reconcile/` (for ghost/lost) or job wrapper (for crashed) |

KB curation background failures and malformed-content detection during rescan are NOT on the Journal — they are operational logs + entries in `kb_curate_retry_queue` + corpus repair pipeline. Successful external edits (the common case) are transparent: rescan picks up the change, retrieval artifacts reindex, git-sync auto-commits. No events, no errors. Malformed markdown (conflict markers, invalid frontmatter, missing required fields, entrySeq collisions) enters the **corpus repair pipeline** (§6.4.1) — auto-fix where safe, queue manual cases, log unrecoverable.

No layer rewrites another layer's event.

### 7.5 Fault propagation — end-to-end with causal graph

Any subsystem fault reaches any end consumer uniformly by walking the causal graph. No duplication; no wrapping; no re-encoding.

**End-to-end example — KB source import failure inside a workflow**:

All events land in ONE transaction (SQLite `BEGIN IMMEDIATE..COMMIT`):

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
                         causeRef: { stream: {kind: 'job', id: 'kb-1'}, seq: 102 } }

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
2. Reads event at `workflow/wf-1@103` → `workflow.completed { outcome: 'failed', causeRef: job/kb-1@102 }`.
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

### 8.3 Invariants

1. Every provider stream emits exactly one `terminal`, and it is last.
2. `continuity` bodies are full snapshots. If `resumable: true`, `conversationRef` must be non-null.
3. Generic middleware never rewrites a downstream terminal outcome.
4. Abort enters once through `runtime.signal`; no extra public interrupt surface.
5. Terminal body never mutates session state — session state is mutated only by `continuity` bodies.

---

## 9. Projections and Consumers

Projections are derived read models. Each projection is bound to one authority (Journal or Corpus). Two consumer interfaces reflect the two authorities' different truth shapes.

### 9.1 Journal projections and consumer interface

Journal projections are maintained by `JournalConsumer`s with range-based replay:

```ts
interface JournalConsumer {
  id: string;
  apply(signal: { upToSeq: number }): Promise<void>;
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
interface CorpusConsumer {
  id: string;
  apply(signal: { contentSeq: number; metadataSeq: number }): Promise<void>;
  // Implementation:
  //   1. Acquire Corpus mutation lock, capture text snapshot at target versions.
  //   2. Build desired manifest (per-entry content hashes).
  //   3. Diff against last-applied manifest persisted alongside the consumer's storage.
  //   4. Re-embed / re-index only changed entries.
  //   5. Atomic snapshot swap.
  //   6. Release lock; persist new cursor after swap.
}
```

Projection types:

- Orama serialized index (base-tier FTS + cosine vector).
- needle DuckDB ANN index (equipment-tier vector).

The per-consumer manifest (hashes of processed entries) lives beside the consumer's storage — e.g., `~/.coral/data/kb/needle/snapshots/<snapshot>/manifest.json` for installed needle snapshots, with staging under `~/.coral/data/kb/needle-staging/<snapshot>/manifest.json` during rebuild.

### 9.3 Why two consumer interfaces

Journal events are discrete and ordered; range replay is natural. Corpus entries are continuous and mutable; snapshot diff is natural. Forcing one interface on both would distort at least one — replay semantics on mutable files loses atomicity; snapshot semantics on event history discards the causal chain.

Both interfaces share:
- Durable cursor (in `equipment_cursors` with `authority` field).
- Idempotent `apply()` (invariant #44).
- Condition-variable `waitFreshUntil(authority, version, consumerId)` wake mechanism.
- Fault-isolated execution (consumer failure never blocks authority writes).

### 9.4 "Completed" is defined

> A job is **completed** iff: the wait path has observed a `job.terminal.recorded` event for the stream AND the projection after applying that seq has `outcome.kind === 'completed'` or (`outcome.kind === 'provider_exit' && code === 0`).

A workflow is **completed** iff its `workflow.completed` event lands with `outcome: 'completed'`.

No stored "is complete" boolean anywhere. Projections compute it from event presence.

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

```
src/
  coordinator/                       ← single-writer daemon; owns live state
    bootstrap.ts                     — bundle entrypoint; argv parsing + `--smoke-open-store` bootstrap
    coordinator.ts                   — composition root (factory + world + state + lifecycle)
    contracts.ts                     — coordinator request/launch/wait/recovery port types
    execution-service.ts             — request-scoped launch/resume/fork/workflow orchestration
    workflow-cleanup.ts              — workflow-session artifact cleanup dispatch
    event-bus.ts                     — typed in-process event bus (`job:*`, `session:released`,
                                       `discuss:updated`)
    control.ts                       — control-plane commands (shutdown, drain)
    lock.ts                          — coordinator singleton lock. Implements warm-start handoff between
                                       plugin-install versions: STARTUP_DEADLINE (30s), CONTENDER_BUDGET (90s),
                                       bundleHash + flavor gating. Feature rationale: when user updates the
                                       plugin, old coordinator detects new bundle and hands off cleanly so
                                       CLI stays usable without manual intervention. This is process-identity
                                       locking (one coordinator per flavor), separate from SQLite's BEGIN
                                       IMMEDIATE (which serializes writes within one coordinator).
    discovery-api.ts                 — passive reads of the coordinator discovery record for non-owner callers
    invocation-scope.ts              — per-invocation event metadata scope
    consumer-driver.ts               — projection consumer driver: push-triggered,
                                       single-in-flight drain, condition-var waitFreshUntil
    composition/                     — coordinator assembly helpers split out of the former execution root
      backend-control.ts, backend-core-types.ts, backend-defaults.ts,
      backend-world.ts, create-backend-core.ts, execution-services.ts
    services/                        — request/repair services factored out of coordinator.ts
      job-launch-service.ts, job-wait-service.ts, job-abort-service.ts,
      kb-source-import-service.ts, kb-reindex-service.ts,
      workflow-execution-service.ts, recovery-service.ts,
      recovery-actions.ts, recovery-coordinator.ts, recovery-snapshot.ts,
      execution-policies.ts
    equipment/                       — active equipment slot lifecycle + RPC surface
      slots.ts, lifecycle.ts, rpc.ts, runtime-activation.ts
    corpus-notify.ts                 — notify bridge from Corpus publication into ConsumerDriver
    shutdown/
      mode.ts                        — graceful / drain / immediate
      sequence.ts                    — ordered shutdown steps
    live/
      admission.ts                   — launch admission (seat/host pool)
      provider-hosts/                — app-server host pool (lease, idle, drain, recovery; 16K file decomposed here)
        pool.ts, lease.ts, idle.ts, drain.ts, recovery.ts, state.ts
      durable-transport.ts           — DurableExecutionTransport seam for cli-runner durable spawns
      provider-server-transport.ts   — provider-server transport seam over the host pool
      process-helpers.ts             — per-launch process helpers shared by transports
      idle.ts                        — idle-daemon eviction policy
      worker-limits.ts               — per-provider launch concurrency clamps
      curate-scheduler.ts            — periodic Corpus curation (discovery, community detection, repair retry).
                                       Coordinator-owned: curate is a background scheduler, not a Corpus domain leaf,
                                       because single-writer discipline requires it run inside the coordinator process.
    recording/
      observer.ts                    — journal append subscriber for telemetry

  store/                             ← SQL/Journal substrate over SQLite event DB
    db.ts                            — SQLite connection factory (WAL mode)
    schema.ts                        — narrow TypeScript row contracts used by store helpers
    schema-loader.ts                 — locates and applies numbered SQL schema files
    envelope.ts                      — Zod validator for event envelope + upcaster registry
    schemas/                         — SQL schema authority; numbered files applied in order
      001_initial.sql                — clean-slate baseline (events, projection_*, meta)
    append.ts                        — transactional append primitive (single-writer gate + composed validator runner)
    reducers.ts                      — per-domain event schemas, append validators, and projection reducers
    consumer-contract.ts             — neutral consumer error/kind vocabulary
    projection-consumer.ts           — journal projection registration factory
    index.ts                         — public Journal substrate barrel
    queries/
      events.ts                      — raw event lookup by (stream, seq) for causeRef deref

  causality/                         ← cross-domain event-reference vocabulary
    cause-ref.ts                     — cross-stream causeRef schema below jobs/sessions/discuss/workflow
    render.ts                        — cause-ref renderer (chain walk + dispatcher); imports no domain.
                                       Domains inject their describers via EventDescriberMap; composition
                                       happens at read-model layer.

  read-model/                        ← product read facade; no write authority
    coral-store.ts                   — composed local read API across Journal projections + Corpus reads
    read-context.ts                  — domain registry composition for upcast-aware reads
    event-describers.ts              — composes default EventDescriberMap from per-domain describer maps
                                       for the cause-ref renderer (mirrors how CoralStore composes
                                       per-domain read queries).

  transport/                         ← carriage only; imports only contracts
    json-rpc.ts                      — unary + subscription envelope codec; `subscriptionId` reserved for future multiplexing
    rpc-catalog.ts                   — single coordinator RPC catalog shared by HTTP + IPC carriage
    rpc-ports.ts                     — typed request-port surface projected from coordinator composition
    context-profile.ts               — transport-context field ↔ CORAL env mapping
    invocation-context.ts            — request/query → runtime InvocationContext builder
    dispatch.ts                      — catalog method dispatch over injected request ports
    response.ts                      — transport response mapping shared by IPC + HTTP
    server-ports.ts                  — coordinator-composed server ports shared by IPC + HTTP
    validation.ts                    — Zod validation formatting shared by IPC + HTTP
    ipc/
      server.ts                      — Unix socket server
      client.ts                      — Unix socket client
      ensure.ts                      — "start coordinator if needed" bootstrap helper (CLI-side)
    http/
      client.ts                      — HTTP client for CLI/tooling call-sites that speak HTTP directly
      handler.ts                     — HTTP gateway handler; table-driven route array, auth gate, SSE endpoints
      query-coerce.ts                — query-param coercion
      sse-subscribe.ts               — shared `subscribeAll` helper for SSE subscriptions

  runtime/                           ← port interfaces + concrete runtime adapters
    invocation-context.ts            — transport-independent project/plugin/env invocation input
    ports.ts                         — time, storage, paths, process, ids, env
    real.ts                          — production implementations
    durable-runtime.ts               — durable child-process runtime result contracts
    spawn.ts, exec-builder.ts        — spawn/exec construction helpers
    cli-busy.ts, errors.ts           — runtime-local process/error helpers

  infra/                             ← flat low-level helpers; no domain knowledge
    build-flavor.ts                  — BuildFlavor + CORAL_FLAVOR resolution authority
    backend-discovery.ts             — coordinator discovery record read/write
    backend-log.ts                   — backend-local structured logging
    plugin-registry.ts               — installed plugin discovery
    paths.ts, store-paths.ts         — path/flavor layout
    identifiers.ts                   — id generation + patterns
    fs-errors.ts, fs-lock.ts         — low-level filesystem errors/locks
    child-env.ts, process/           — child env and process helpers
    json.ts, error-format.ts         — parse guards and error rendering
    time.ts, format-progress.ts      — time and small formatting helpers

  jobs/                              ← domain: jobs events + projections + shell
    consumer.ts                      — Journal projection consumer registration for jobs
    job-store.ts                     — journal append/read seam over jobsRegistry; sole owner of raw
                                       `job.terminal.recorded` construction (invariant #47)
    events.ts                        — jobs event body schemas + terminal-order append validator + projection_jobs reducers
    outcome.ts                       — TerminalOutcome + JobLifecycleFault + CauseRef-aware describers
    event-describers.ts              — per-event-type describer map for `job:*` events (consumed by the
                                       cause-ref renderer through read-model composition)
    read/queries.ts                  — JobView queries + progress/event lookup over the Journal substrate
    read-contracts.ts                — read-side contract types shared by jobs/read and consumers
    phase.ts                         — JobPhase + phaseForOutcome
    launch.ts                        — LaunchDecision + launch body types
    launch-readiness.ts              — readiness predicates over launch+queue events
    launch-rejection.ts              — LaunchDecision rejection helper
    admission-contract.ts            — launch admission/queue port contract
    agent-resolution.ts              — resolve agent by id
    abort-registry-contract.ts       — abort signal registry port
    abort-result.ts                  — abort outcome shape consumed by abort handlers
    job-runner-contract.ts           — provider/workflow/recovery lifecycle ports
    progress-store-contract.ts       — progress-store port consumed by coordinator services
    provider-request.ts              — persisted launch → ProviderRequest mapper
    session-claim.ts                 — session job-claim error/options owned by jobs
    continuity.ts                    — provider continuity snapshot type owned by jobs (mirrors sessions/continuity)
    terminal-write-error.ts          — terminal append failure error
    result.ts                        — JobTerminal + JobDiagnostics
    terminal-materializer.ts         — provider/session/recovery terminal cause materialization
    wait.ts                          — WaitCursor + wait body types + terminal wait defaults
    wait-port.ts                     — wait coordinator port contract
    wait-stream-event.ts             — wait stream envelope shape (progress / queued / waiting / terminal)
    records.ts                       — job record DTOs shared across readers and shells
    event-bus.ts                     — typed in-process bus for `job:*` lifecycle notifications
                                       (in-memory only; not the durable progress log retired in §1.4)
    startup.ts                       — jobs-domain startup helpers consumed by coordinator boot
    exports/
      result-artifact.ts             — canonical `<os-tmpdir>/coral-jobs/<jobId>/result.md` path + atomic writes
      result-markdown.ts             — materialize/rebuild result.md from terminal events
    reconcile/                       — imperative reconciliation (not pure replay)
      contracts.ts                   — recovery plan contracts shared by recovery services
      plan.ts                        — classify world-state divergence
      registry.ts                    — known classifications
      cross-namespace-adoption.ts    — cross-ns orphan adoption
      recovery-effects.ts            — recovery-only job transitions
      errors.ts                      — reconciliation-local error types
      (world snapshot/actions/orchestration live under coordinator/services/recovery-*.ts)
    shell/                           — imperative I/O over jobs domain
      abort-registry.ts              — in-memory abort signal registry
      continuity-consumer.ts         — provider stream continuity checkpoint consumer
      launch.ts                      — launch job helper
      event-subscription.ts          — journal-backed wait/reconnect event streaming
      wait.ts                        — wait stream helper

  sessions/                          ← domain: session events + projections
    entry.ts                         — SessionEntry + controller profiles
    allocation-contract.ts           — session allocation input contract
    command-schemas.ts               — sessions transport/CLI request schemas
    events.ts                        — session event body schemas
    event-describers.ts              — per-event-type describer map for `session:*` events
    continuity.ts                    — continuity snapshot type
    execution-contract.ts            — coordinator-facing session execution/recovery ports
    job-release.ts                   — session-owned job claim release helper
    job-claim-contract.ts            — session-owned job claim/read port consumed by jobs shell
    projections.ts                   — SessionView reducer
    resolve.ts                       — session resolution by id/ref
    shell/
      store.ts                       — session store helpers

  discuss/                           ← event-sourced discussion domain
    state-machine.ts, reducer.ts, events.ts, projections.ts, command-schemas.ts
    consumer.ts                      — Journal projection consumer registration for discuss
    store-registry.ts                — discuss DomainEventRegistry (per-kind strict body schemas)
    event-describers.ts              — per-event-type describer map for `discuss:*` events
    recovery-contract.ts             — shell-free live-boundary predicate
    shell/                           — imperative shell (moved from execution/discuss/)
      recovery.ts                    — recovered resume contract + startup recovery + shutdown abort persistence
      bid-flow.ts, speech-flow.ts, followup-flow.ts, synthesis-flow.ts
                                       — sub-workflow loops (one per discuss phase, decomposed per §10.1a)
      session-store.ts               — persistence glue for discuss sessions
      live-registry.ts               — attached-session + watch buffers
      persistence.ts                 — atomic session-state persistence helpers
      registry.ts                    — DiscussContextRegistry (live session map owned by coordinator)
      session-read-service.ts        — read-side service collecting attached sessions for queries
      runtime-build.ts               — discuss runtime composition (services + ports)
      runtime-services.ts            — service surface consumed by coordinator composition
      context.ts                     — per-session DiscussContext value
      flow-primitives.ts             — shared step primitives across the four flows
      loop.ts                        — top-level discuss loop driving the flows
      operations.ts                  — discuss-domain operations (start, seed, end, …)
      prompts.ts                     — discuss prompt templates and assembly
      tools.ts                       — discuss-tool dispatch helpers

  kb/                                ← Corpus-authority domain (markdown is truth)
    contracts.ts                     — public KB types
    entry-types.ts                   — KB entity types (Note, Source, Principle, Community, EntityGraph)
    validation.ts                    — entry validation
    read.ts                          — load entry from markdown
    read-contract.ts                 — read interface
    corpus/                          — Corpus authority: markdown I/O
      consumer-contract.ts           — Corpus consumer registration/apply contract
      snapshot.ts                    — Corpus freshness snapshot identity
      frontmatter.ts                 — parse/serialize YAML frontmatter
      markdown-entries.ts            — markdown ↔ entry conversion
      mutation-lock.ts               — single-writer lock around the Corpus
      file-atomic.ts                 — atomic writes for markdown authority files
      index-mutations.ts             — content/metadata sequence commits
      index-records.ts               — markdown entry → index record builders
      manifest-authority.ts          — manifest hash/delta authority checks
      repair/                        — Corpus repair detection and remediation
        corpus-scan.ts               — scan/incident types plus filesystem scan
        classify.ts, fix.ts, incident-ids.ts
    runtime-state.ts                 — in-memory Corpus state mirror (`kb_corpus_state`, index handles)
    state/
      corpus-state.ts                — persisted Corpus snapshot cursors
      schema.ts                      — Corpus state row contracts
    queries.ts                       — Corpus read/search/list/diagnose owner module for read paths
    direct-read-index.ts             — transient/persisted list index selection for no-mutation reads
    orama-factory.ts, orama-schema.ts — Orama construction/schema shared by base retrieval surfaces
    search/                          — search backend abstraction (equipment-aware)
      contract.ts                    — SearchBackend interface (fts, vector, hybrid)
      router.ts                      — picks active backend per query type; detects equipment
      chunking.ts                    — text chunking (shared by vector backends)
      embedding.ts                   — embedding provider abstraction (shared)
      orama-backend.ts               — base tier: FTS + vector (both at first deploy)
      needle-contract.ts             — lightweight needle constants/types safe for coordinator imports
      needle-backend.ts              — equipment implementation; dynamically imported by lifecycle activation
      hybrid.ts                      — RRF fusion over active FTS + vector backends
    ops/                             — user-facing operations (coordinator-mediated writes)
      memo.ts, principles-list.ts, promote.ts, update.ts, delete.ts
      source-import.ts, source-store.ts
      reindex.ts                     — full Corpus rescan + projection rebuild
      search.ts                      — search entrypoint (routes via search/router.ts)
    curate/                          — background curation (graph + communities + principles)
      runner.ts, scheduler.ts        — orchestration
      discovery.ts                   — new-entry discovery
      classification.ts              — entity classification
      community-detection.ts         — community clustering
      entity-consolidation.ts        — merge/refine entities
      principles.ts                  — principle extraction
      tags.ts                        — tag normalization
      text-artifacts.ts              — text snapshot capture under mutation lock
      metadata-commit.ts             — metadata-only lane commits
      git-sync.ts                    — git integration (auto-commit, push, pull)
      state.ts                       — curate-frontier + cursors (Corpus-side scheduler state)
      claim-io.ts, content-normalize.ts, types.ts, operations.ts, usage-budget.ts

  providers/                         ← plugin boundary
    contract.ts                      — Provider + ProviderEventBody + middleware types
    catalog.ts                       — provider catalog (workflow-facing allowlist)
    registry.ts                      — registered provider instances
    bootstrap.ts                     — provider wiring at coordinator start
    cli-runner.ts                    — generic CLI runner
    cli-detection.ts                 — detect installed CLIs
    terminal.ts                      — provider-side terminal builder
    inject.ts                        — provider dependency injection
    middleware/
      app-server-session.ts          — app-server lifecycle middleware
      session-continuity.ts          — continuity tracking middleware
      adapter-parse-guard.ts         — adapter output parse-guard middleware
    app-server/
      driver.ts                      — app-server driver (JSON-RPC lifecycle)
      types.ts                       — app-server local types
    claude/
      exec-provider.ts               — compose claude exec kernel + middleware
      exec-kernel.ts                 — pure claude exec call
      session-kernel.ts              — claude app-server turn kernel
      control-protocol.ts            — claude control messages
      output-parser.ts               — claude JSON parsing
      progress.ts                    — claude progress extraction
      request-mapping.ts             — request → claude args
      request-prep.ts
      types.ts
    claude-appserver/
      server.ts                        — appserver daemon entry
      controller.ts                    — SingleSessionController (turn + interrupt + child lifecycle, coherent unit)
      protocol.ts                      — wire/control protocol handling
                                         (35K `session.ts` decomposed to 2 responsibility files; §10.1a)
    codex/
      thread-provider.ts             — compose codex thread kernel + middleware
      thread-kernel.ts               — pure codex turn kernel
      protocol.ts                    — codex protocol types
      request-mapping.ts             — request → codex thread/turn messages

  workflow/                          ← owns syntax, plan, and execution semantics
    parser.ts                        — pipe syntax parser
    ast.ts                           — workflow AST types
    input.ts                         — pipeline input → AST entrypoint
    normalize.ts                     — AST normalization (desugaring) → WorkflowPlan
    compile.ts                       — compile WorkflowPlan into atom launch sequence
    plan.ts                          — WorkflowPlan + WorkflowSlot types + validation
    command.ts                       — workflow command schema
    consumer.ts                      — Journal projection consumer registration for workflow
    dispatch.ts                      — workflow command dispatch entrypoint
    events.ts                        — workflow event body schemas + projection_workflows reducers
    event-describers.ts              — per-event-type describer map for `workflow:*` events
    projections.ts                   — workflow journal append helper for tests/recovery over workflowRegistry
    read-queries.ts                  — WorkflowView queries (plan + slot outcomes derived from child jobs)
    executor.ts                      — top-level orchestration: declares plan, schedules launches, emits workflow.completed
    launch.ts                        — atom launch + retry (intertwined per current code; §10.1a)
    wait.ts                          — await-step state + multi-atom wait + cascade
    recover.ts                       — workflow recovery + step resumption
    stale-recovery.ts                — stale-atom recovery paths (split from recover.ts for cohesion)
    internal/                        — workflow-internal contracts not exported to other domains
      execution-contract.ts          — workflow execution port + WorkflowExecutionError
      format.ts                      — workflow-local rendering helpers

  tools/testing/                     ← test helpers; never imported by production
    deferred.ts                      — test-only async primitive
    hooks/                           — hook test helpers + hook tests
    skills/                          — skill test helpers

  cli/                               ← Commander CLI client (preserved)
    bootstrap.ts, + subcommand modules

  hooks/                             ← Node.js ESM hook scripts (preserved)
```

```
tools/
  simulation/                        ← debug-only executable harness; never user-facing, never bundled into coral-cli
    cli.ts                           — `npm run simulate -- tools/simulation/scenarios/<scenario.yaml>` entrypoint
    scenarios/*.yaml                 — executable debug scenario corpus
    runtime.ts                       — SimulationRuntime (Runtime impl)
    runner.ts                        — deterministic run loop
    recording.ts                     — event recording for replay diagnostics
    adversarial.ts                   — adversarial lifecycle/recovery scenario helpers
    no-real-io.ts                    — sealing gate that fails on real-io leakage at type-check time
    scenario-schema.ts               — Zod schema for scenario YAML
    scenario-normalize.ts            — normalize parsed scenarios into runner input
    scenario-http.ts                 — HTTP-shaped scenario step decoder
    core/
      backend.ts                     — simulation backend composition
      constants.ts                   — simulation defaults/limits
      memory-storage.ts              — in-memory StoragePort
      mock-app.ts                    — generic mock app harness
      mock-app-server.ts             — claude app-server mock
      mock-process.ts                — process port double
      mock-script-types.ts           — scripted-step value types shared by mocks
      runtime-doubles.ts             — runtime port doubles
      virtual-time.ts                — deterministic virtual TimePort
```

### 10.1 What is deleted

- `src/execution/` — dissolves into `coordinator/`, `jobs/`, `sessions/`, `transport/`, and debug-only `tools/simulation/`
- `src/shared/` — every file relocates to a domain or `infra/` or `testing/`
- `src/client/` — replaced by domain-owned read queries + `read-model/` + `transport/ipc/client.ts` + `transport/http/client.ts`
- `src/bridge/` transport — replaced by `transport/`
- `recovery-core.ts` — replaced by `jobs/reconcile/` + `store/rebuild.ts`

### 10.1a Large-module decomposition (>500 lines as a review signal)

Current code has several files in the 20K-60K range. §10 names their destinations but real decomposition splits them by responsibility boundaries, not single-file relocation.

The 500-line mark is a **review trigger, not a hard split rule**. A file over that size is acceptable when it is a cohesive unit: one state machine, one domain algorithm, one controller with shared mutable state, or one implementation whose private helpers are only meaningful inside that flow. Splitting such a file can make the design worse by exporting private state, creating artificial seams, or forcing readers to jump across files to understand one concept.

Split when the file has multiple independent reasons to change: persistence plus scheduling, parsing plus transport, policy plus I/O, unrelated command handlers, or runtime functions whose names no longer share a single owner. Prefer a slightly larger cohesive file over many small files connected by vague exports.

| Current | Size | Decomposed destinations |
|---|---|---|
| `src/execution/service.ts` | 56K | `jobs/shell/launch.ts`, `jobs/shell/wait.ts`, `jobs/shell/workflow.ts` (via `workflow/executor.ts`), `sessions/shell/store.ts`, `sessions/resolve.ts`, `coordinator/execution-service.ts`, `coordinator/workflow-cleanup.ts`, `coordinator/contracts.ts`. The god-class dissolves into coordinator service helpers plus domain-shell modules; no unused public facade remains. |
| `src/execution/http-handler.ts` | 51K | `transport/http/handler.ts` (table-driven route dispatch), `transport/http/query-coerce.ts`, `transport/response.ts`, `transport/server-ports.ts`, `transport/validation.ts`, `transport/http/sse-subscribe.ts`. |
| `src/execution/engine.ts` | 34K | `coordinator/live/admission.ts` (launch admission + queue), `coordinator/live/durable-transport.ts` (DurableExecutionTransport seam), `coordinator/live/worker-limits.ts` (MAX_WORKERS / DISCUSS_MAX_WORKERS policy). |
| `src/execution/host-manager.ts` | 16K | `coordinator/live/provider-hosts/` subtree — `pool.ts`, `lease.ts`, `idle.ts`, `drain.ts`, `recovery.ts`, `state.ts` (see §10 coordinator entry). |
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

3 files = borderline (subdivide only if cohesion is unmistakable and the cluster is clearly bounded — e.g., needle equipment in `kb/search/needle/`). 2 files = no.

**Subdivision rejection** — a few cases where subdividing makes the tree *worse*:
- `infra/` is the canonical low-level dump by design; subdividing into `infra/paths/`, `infra/errors/`, etc. creates competing canonical homes inside a layer that should stay flat.
- The 4 Journal-stream domains (`jobs`, `sessions`, `discuss`, `workflow`) follow the same shape — events.ts, reducer.ts, projections.ts, read-queries.ts at the domain root. Don't subdivide one of them differently than the others; the cross-domain mirror is load-bearing.
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
| Networked / browser | HTTP or WebSocket gateway → same coordinator RPC | `coral-reef`, remote coral, explicit server exposure |

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

### 11.3 HTTP is a gateway

`http://127.0.0.1:<port>` is not the architectural boundary — it is a *carriage* for coordinator RPC. IPC and HTTP share identical command semantics; only wire format differs. Local security is filesystem ownership on the socket; HTTP auth applies to network gateways.

Route dispatch is table-driven (array at `src/transport/http/handler.ts`), but the route table is projected from a single catalog at `src/transport/rpc-catalog.ts`. IPC server dispatch and HTTP handler dispatch both derive from that catalog through `rpcPorts` injected by coordinator composition, so semantic parity is structural rather than aspirational. Operational `/health`, `/admin/shutdown`, and `/events/stream` remain explicit transport-local carveouts rather than catalog entries.

Interactive/live subscriptions use the same transport primitive in both carriages. `src/transport/json-rpc.ts` defines unary + subscription envelopes with a reserved `subscriptionId` field; HTTP projects notifications to SSE and IPC carries notifications directly. The steady state is one active subscription per connection; multiplexing is a transparent future optimization, not a second protocol.

---

## 12. Recovery Model

Two authorities, two recovery paths. Each authority recovers from its own truth.

### 12.1 Journal recovery — projection rebuild + reconciliation

**Step 1: projection rebuild (pure replay over events table)**

Journal-domain projections (`projection_jobs`, `projection_sessions`, `projection_discuss`, `projection_workflows`) live in SQL tables alongside events. They are maintained incrementally during live writes (§3.3), but they are **derivative** — rebuildable at any time from the events table alone:

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

After rebuild, compare projected state to the observed world:

```ts
type ReconciliationPlan = {
  register: JobIdentity[];     // jobs to re-register in live state
  cleanup: Orphan[];           // processes without projected jobs
  appendEvents: CoralEvent[];  // new facts to durably record divergence
};
```

When reality disagrees (e.g., a projected `running` job whose process is gone), reconciliation **appends new events** in one transaction:

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
- Journal substrate (`store.db`) holds the `kb_corpus_state` row (current `contentSeq` / `metadataSeq`) and `equipment_cursors` for Corpus consumers.

Neither alone is sufficient: the filesystem cannot tell us what version consumers have processed, and the SQLite tables cannot reconstitute Corpus content. Coral's full recovery requires both present. This is an honest consequence of SQLite being the substrate for Corpus-related metadata even though the Corpus authority itself is the filesystem.

**Step 1: Corpus rescan**

On coordinator startup (or explicit `kb reindex`):
1. Enumerate all entries under `~/.coral/kb/{notes,sources,principles,communities}/`.
2. For each entry, compute current `content_hash` and capture frontmatter.
3. Compare to `kb_corpus_state.content_seq` / `metadata_seq`.
4. If drift detected, bump `kb_corpus_state.content_seq` / `metadata_seq`.

**Step 2: Projection rebuild (per-Corpus-consumer)**

Each Corpus consumer (Orama, needle) maintains a cursor in `equipment_cursors` (`authority = 'corpus'`). On startup:
- Consumer compares its cursor to current `contentSeq`.
- If behind, triggers snapshot-based diff (`ensureVectorIndex` pattern):
  - Capture text snapshot under mutation lock.
  - Build desired manifest (content hashes per entry).
  - Diff against consumer's last manifest (persisted alongside consumer storage).
  - Re-embed / re-index only changed entries.
  - Atomic snapshot swap.

The Corpus recovery model is **intrinsically idempotent**: rescanning a clean Corpus produces no changes; rescanning after external edits produces exactly the drift set. If SQLite's `kb_corpus_state` or `equipment_cursors` are missing/reset, recovery treats the Corpus as fully new (full rebuild). Never wrong, occasionally expensive.

### 12.3 External mutation absorption

Obsidian edits, `git pull`, or direct filesystem changes are the **normal** path for knowledge editing. The coordinator does NOT own them; the filesystem + git own them. Coral observes and re-indexes:

- **Startup scan**: coordinator boot compares filesystem to the current corpus snapshot and bumps `contentSeq` / `metadataSeq` for any drift; CorpusConsumers (Orama, needle) catch up via manifest diff.
- **Periodic rescan**: ongoing scheduled task absorbs changes between boots.
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

Slot ids in this section follow the production format `${workflowId}:${stepIndex}:${atomIndex}` — `wf-1:0:0` for "A", `wf-1:1:0` for "B", `wf-1:1:1` for "C". The slotId encodes step+atom position so renderers can reconstruct presentation without storing it. Slot labels (e.g. "A", "B", "C") are derived from `slot.agent ?? prompt#${atomIndex}(${truncated instruction})` at render time, never stored on the plan or its events.

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
                                                 causeRef:{stream:{kind:'job',id:'c-1'}, seq:56}
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
plan: { slots: [wf-1:0:0, wf-1:1:0, wf-1:1:1] }   // labels are derived at render time, not stored
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
2. Event at `workflow/wf-1@57` is `workflow.completed { outcome:'failed', causeRef → job/c-1@56 }`.
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
| `result.md` (authority) | `<os-tmpdir>/coral-jobs/<id>/result.md` (materialized view; job-directory contract) |
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
| (new surface) | `refs.kbRefs[] = { entryId, contentHash? }` added — cross-authority Corpus references. No current-code equivalent (no Journal-side code references KB entries today); this is a new API, not a migration target. |

### 14.2 Bugs eliminated as a side effect

Concrete pathologies in today's codebase that disappear structurally when this architecture lands. Preserved here so they are not forgotten between now and the refactor.

#### 14.2.1 Bundle-swap orphan adoption failure

**Observation (2026-04-18)**: during a plugin reinstall mid-flight, jobs launched by the previous backend instance become orphaned and `jobs --all` does not see them.

**Trigger**:
1. Old backend (bundle at previous cache path) launches a job → `/tmp/coral-jobs/<id>/` + pid recorded.
2. Plugin is reinstalled: new bundle copied to a new cache path (e.g., `0.5.1` → `0.5.2`).
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
- `hooks/post-compact.mjs` reads `<JOBS_DIR>/<jobId>/result.md` and parses `<JOBS_DIR>/<jobId>/status.json`. The `result.md` path stays under the job directory contract; `status.json` disappears entirely (replaced by `events` + `projection_jobs`).
- `hooks/pre-compact.mjs` similarly parses `status.json`.
- `hooks/cli-resolve.mjs` rewrites bare `coral-cli` invocations. CLI bundle path is unaffected; the rewrite regex stays valid.

Mitigation: update these hooks alongside the source rewrite. They are part of the plugin artifact; a first deploy includes updated hooks matching updated paths.

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
1. Exactly one coordinator holds write authority across both Journal and Corpus per Coral installation.
2. Every domain declares **one authoritative substrate**. Journal domains (`job`, `session`, `discuss`, `workflow`): the `events` table. Corpus domain (`kb`): the markdown filesystem at `~/.coral/kb/`.
3. Projections and indexes are **rebuildable from their domain's authority alone**. Never from "events alone" as a blanket rule — the rule is per-authority.
4. Exports (`result.md`) live outside any authority; deleting them never loses truth. KB markdown files are NOT exports — they are the Corpus authority itself.

**Journal invariants**:
5. Every Journal fact is a row in the `events` table. Journal writes use SQLite `BEGIN IMMEDIATE`.
6. Multi-event Journal operations commit atomically in one SQLite transaction. Replay never sees partial truth.
7. Journal recovery = projection rebuild (pure replay) + reconciliation (imperative, append-only).
8. Every provider stream emits exactly one terminal body, and it is last.
9. `continuity` bodies are full snapshots, never patches.
10. Child jobs are independent top-level streams; parents reference via `refs.parentJobId` + `refs.workflowSlotId`, never embed.
11. Fault truth lives on the originating stream as a domain event; job terminals point via `causeRef`, never duplicate payload.
12. Labels, step indices, atom indices live on `workflow.plan.declared`; launches carry only `slotId`. Labels are presentation.
13. `WaitCursor` is a single global `afterSeq` (Journal).
14. Every fault-bearing event type has exactly one producer.
15. Journal schema evolution is per-`type` via `bodyVersion` + upcaster chain. Upcasters are pure and kept forever.
16. Every Journal event type has exactly one definition; no re-declaration across domains.

**Corpus invariants**:
17. KB markdown corpus is authoritative. No synthetic events reconstruct KB content.
18. `contentSeq` and `metadataSeq` are freshness/version counters only, never event history.
19. The Corpus mutation lock contains only authority writes, Corpus version bumps, and lightweight Corpus metadata/index state. Retrieval artifacts (Orama and needle) are CorpusConsumers and are never built inside the authoritative critical section.
20. External Corpus edits (Obsidian, git pull, direct filesystem) are first-class; scans/rebuilds absorb them without backfilling synthetic events.
21. Corpus recovery = rescan + index rebuild (no history to replay).
22. Cross-authority references use `KbRef = { entryId, contentHash? }`. `contentHash` is optional, captured at write time when point-in-time semantics matter.
22a. `kb source import` is a job-owned ingest attempt. Its job terminal records execution/readiness success or failure; the imported source is authoritative only when the Corpus markdown file exists.

**Coordinator & transport**:
23. Local read-only CLI commands do not require a coordinator (SQLite readers use separate DB handles; Corpus reads are direct filesystem), but their roots are explicit adapter inputs, not implicit cwd/home fallbacks inside domain/read-model code.
24. Local mutating or live CLI commands always go through the coordinator (IPC or HTTP gateway).
25. IPC and HTTP share identical coordinator RPC semantics; only wire format differs.
26. Operational facts (index rebuilds, WAL checkpoints, snapshot rotations) are NOT domain events or Corpus mutations; they are logs.

**Layering**:
27. `src/runtime/*` and `src/infra/*` import nothing from domains, transport, coordinator, or cli.
28. `src/transport/*` imports domain contracts only, never domain shells or coordinator.
29. `src/coordinator/*` is the only layer allowed broad cross-domain imports.
30. `tests/helpers/*` is never imported by production files.
31. No generic filenames (`utils.ts`, `shared.ts`, `types.ts`, `schemas.ts`) at any domain root — ownership must be explicit.

**Equipment**:
32. Equipment never writes to any authority. Equipment adds or replaces projection backends only.
33. Every equipped projection is rebuildable from the authority of the domain it serves (Journal events OR Corpus contents).
34. The base tier is **fully functional** after plugin install for all zero-config commands. Commands that intrinsically need external resources (vector search needs an embedding provider) declare their one-line setup in README. Every CLI command available in equipped tier is also available in base tier — at potentially lower quality but never unavailable; missing prerequisites surface as structured errors with setup guidance, not silent failure.
35. Equipment **replaces specific query paths** with higher-quality implementations. It never adds new command surfaces.
36. Unequipping returns the replaced path to the base backend without data loss and without command availability changes.
37. Equipment loads via dynamic import; its heavy dependencies enter the process only after `/equip` completes.
38. Equipment is **never prompted or nagged**. Base-tier commands never surface "equip X to unlock" hints. Discovery is curiosity-driven (`/equip --list`, internally `coral-cli expansion list`; docs), not system-driven.
39. Equipment catalog entries are **tool-named** (`needle`), not capability-named (`kb`).
40. Equipment projections are maintained by registered consumers with durable cursors in `equipment_cursors`. Journal consumers use range-based replay; Corpus consumers use snapshot-based content-hash diff. Updates flow via in-process async push (`ConsumerDriver.notify(authority, version)` after authoritative write).
41a. Journal consumer freshness is eventually consistent relative to journal projections. Strict-freshness reads use `waitFreshUntil('journal', version, consumerId)` — a condition-variable wake, never a polling loop.
41b. Corpus consumer freshness is eventually consistent relative to Corpus writes. Commands with explicit retrieval readiness use `waitFreshUntil('corpus', version, consumerId)`; `listEquipment` is status observation, not a readiness waiter.
42. Equipment failure never blocks coordinator writes. A failed `apply()` retains the last-successful cursor; next `notify` or startup recovery retries the gap. If a caller explicitly waits for that consumer as part of a readiness contract, the wait/job reports the readiness failure while the Corpus commit remains durable.
43. Each query path has **at most one active equipment**. Attempting `/equip X` for a path already owned by equipment Y fails with an explicit error instructing the user to unequip Y first (internal route `coral-cli expansion unequip Y`; user-facing skill grammar `/equip uninstall Y`).
44. Consumer `apply(signal)` must be **idempotent**. The cursor advances only after `apply()` resolves successfully; a crash between apply and cursor persistence causes the same range to be re-applied on startup. Consumer implementations must tolerate this (`upsert` semantics, not `insert`).
45. Read-side event body decode routes through upcast-aware helpers. Outside `src/store/body-codec.ts`, `src/store/append.ts`, `src/store/rebuild.ts`, and `src/store/envelope.ts`, `schema.parse(decodeEventBody(...))`, `.parse(...)` on values sourced from `decodeEventBody(...)`, and the one-arg `rowToCoralEvent(row)` overload are forbidden.
46. Unused public facades stay deleted. Tests and integration code import the real contract or owner module directly instead of preserving `api.ts` barrels that production never imports.
47. Raw `job.terminal.recorded` object construction is owned by `jobs/job-store.ts`. All other producers finalize through jobs-owned append/materialization APIs.
48. `coordinator/services/**` consumes domain ports/contracts, not domain shell implementation classes. Shell implementations are wired at composition roots.
49. Launch/admission vocabulary is jobs-owned. `LaunchPool`, admission handles, queue read ports, and recovery launch ports are defined under `src/jobs/*`; coordinator contracts may compose those ports but must not redefine `ExecutionLaunch*` mirrors.
50. Domain/provider modules do not read host time, environment, or randomness directly. Current time, env, and ids enter through runtime/domain ports; direct ambient access is restricted to infra/runtime/CLI/bootstrap adapters and explicit parsers.

---

## 17. Glossary

- **Coordinator**: the single-writer daemon. Mediates writes to both authorities (Journal + Corpus), owns live state (admission, host pool, subscriptions), and is the only layer that opens writable handles.
- **Journal authority**: the `events` table inside `~/.coral/data/store/store.db`. The authoritative source for process-like domains (`job`, `session`, `discuss`, `workflow`). Append-only; truth is the ordered history of events.
- **Corpus authority**: the markdown filesystem at `~/.coral/kb/` (git-tracked). The authoritative source for knowledge content (notes, sources, principles, communities, entity graph). Truth is the current file contents; no event history.
- **Journal substrate**: SQLite database (`store.db`) — holds the events table, base projection tables, and `equipment_cursors`. Not a "global store"; it is the substrate for Journal authority only.
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
- **Equipment**: an opt-in runtime enhancement and coordinator slot. An expansion installs the bits; when activated it runs through `src/coordinator/equipment/` as the active implementation for a specific query path. Equipment never writes events.
- **Expansion**: an installable noun in `src/expansion/` (`needle`, `cgc`, ...). The skill layer routes user verbs to expansion verbs; activation may then bind the expansion into an equipment slot.
- **Base tier**: the default runtime after plugin install (~3MB bundle, no native deps). Zero-config surface works immediately; vector search additionally needs a one-line embedding provider setup per README (Google Gemini API key default).
- **Equipped tier**: one or more equipments active. Same commands, sharper implementations.
- **Equipment metaphor (Zelda UX)**: curiosity-driven discovery, never enforced. Base tier always works; equipping is a reward for looking, not a gate to close. Equipment sharpens existing capabilities, never unlocks new commands.
- **`/equip <name>`**: skill verb that routes to `coral-cli expansion equip <name>` and installs an expansion, then activates equipment when that expansion declares `activation='equipment'`. `/equip uninstall <name>` preserves the user grammar while routing internally to `coral-cli expansion unequip <name>`.
- **Orama**: base-tier KB search engine. Provides FTS (BM25) and vector search (cosine brute-force). Pure JS, always present. Vector path requires embedding provider config.
- **coral-needle**: first equipment. C++ N-API addon at `../coral-needle` providing DuckDB-backed ScanANN vector search (exact / USearch HNSW / ScaNN tree-AH, auto-selected). Replaces Orama's vector path when equipped; FTS stays with Orama. Distributed as prebuilt binaries via GitHub Releases.
- **SearchBackend**: interface at `src/kb/search/contract.ts` that both Orama and needle implement. `router.ts` picks the active backend per query type based on equipment state.
- **ConsumerDriver**: in-process driver that turns `notify(authority, version)` signals into `apply(signal)` calls for a registered consumer (Journal or Corpus). Single-in-flight guarantee (backpressure-safe), cursor persistence after success, condition-variable wake for `waitFreshUntil(authority, version, consumerId)`. Lives at `src/coordinator/consumer-driver.ts`.
- **`waitFreshUntil(authority, version, consumerId)`**: blocks until the named consumer's cursor reaches the target authority version. Journal callers pass `events.seq`; Corpus callers pass `contentSeq` or `metadataSeq`. Implemented as condition-variable wake, not polling.
- **`equipment_cursors`**: SQLite table that persists each consumer's cursor (per authority). Source of truth for "where is each equipment projection caught up to".
- **JournalConsumer**: projection consumer subscribing to Journal authority. Range-based: `apply({ upToSeq })` reads events from `seq > cursor AND seq <= upToSeq` and applies them in order.
- **CorpusConsumer**: projection consumer subscribing to Corpus authority. Snapshot-based: `apply({ contentSeq, metadataSeq })` captures a corpus snapshot, diffs content hashes against its last manifest, applies only changes. **Reuses the manifest-diff + atomic-snapshot-swap logic from today's `ensureVectorIndex`, but inverts the invocation model** — today pull-driven (called lazily before search), tomorrow push-driven (driven by ConsumerDriver after Corpus writes). The diff half is a port; the trigger half is a rewrite.
- **KbRef**: `{ entryId, contentHash? }`. Cross-authority reference shape for Journal events pointing at Corpus entries. `entryId` alone = late-bound (resolves to current content); with `contentHash` = point-in-time (preserves historical meaning across subsequent Corpus edits).
- **Corpus mutation lock**: single-writer lock around the Corpus authority. Coordinator-mediated CLI writes acquire it for markdown atomic writes, Corpus version bumps, and lightweight Corpus metadata/index state. Retrieval projections such as Orama and needle run as CorpusConsumers after the lock releases.
- **contentSeq / metadataSeq**: monotonic version counters for the Corpus authority. Two lanes because content and metadata changes have different freshness semantics. Analogous to `events.seq` on the Journal side, but versioning the whole corpus rather than counting discrete events.

---

## 18. Verdict

Six pioneers + All-6 unifier + B-v2 reëxamination + Pioneer-final + KB-pioneer converge on one form: **One coordinator, two authorities.** Every piece is load-bearing:

- **Journal authority** (SQLite `events` table) is truth for process-like domains: `job`, `session`, `discuss`, `workflow`. ACID transactions + range replay.
- **Corpus authority** (markdown filesystem at `~/.coral/kb/`, git-tracked) is truth for knowledge content: `kb`. Atomic rename + content-hash diff.
- **CoralCoordinator** is the single writer across both authorities — not for gatekeeping but because live-state ownership (admission, host pool, subscriptions) naturally pools there.
- **Cross-authority references** use `KbRef = { entryId, contentHash? }` — the only admitted asymmetry, honest about Corpus mutability.
- **Canonical event bodies** are the provider contract for Journal writes.
- **WorkflowPlan on `workflow/<id>`** is the durable composition aggregate. Child launches reference slots by `slotId`; labels and step/atom indices are derived from the slot at render time, never stored.
- **Causal graph** (CauseRef pointers) is the fault model within Journal. Failures live once on the originating stream; terminals dereference, never wrap.
- **Three-variant `JobLifecycleFault`** is the only fault ADT — reserved for wrapper-local failures with no domain origin.
- **Two consumer interfaces** match the two authorities: `JournalConsumer` (range replay) + `CorpusConsumer` (snapshot content-hash diff). Both share `ConsumerDriver` mechanics (cursor, idempotent apply, condition-var wake).
- **Zelda-style equipment model**: base tier always functional (FTS zero-config, vector with one-line embedding setup); `/equip needle` sharpens the vector path for scale without adding commands. Curiosity-driven, never prompted.
- **Command-class routing** replaces transport-topology assumptions.
- **Journal recovery** = projection rebuild + reconciliation. **Corpus recovery** = rescan + per-consumer snapshot diff. Each authority recovers from its own truth.
- **Schema evolution** via per-`type` `bodyVersion` + upcasters (Journal) or ordered SQL schema scripts (projection tables); Corpus evolves through markdown format changes that the frontmatter parser accommodates.

The two-authority model is not an asymmetry to apologize for — it is Coral's **duality**. Process-like state lives on time (Journal). Knowledge-like state lives in space (Corpus). Forcing one substrate on both would distort one; naming them separately reveals the structure honestly.

Five elegance axes hold (inevitable / self-evident / essential / natural / resonant) with zero cost-axis residue. Adversarial review rounds have converged; the design now resists further sharpening without violating one of the axes.

This document's canonical body and invariants are the sole design reference for any `/coral:plan` session implementing this architecture. Implementation-time corrections are folded into the relevant sections above; they are not maintained as standing amendments.
