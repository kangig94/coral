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

**Why it exists**:
The current Coral architecture has six well-documented pain points: `src/execution/` is a god-directory, `TerminalResult` mixes concerns, the provider layer has three overlapping paths, persistence is fragmented across six files per job, `src/shared/` is a catch-all, and the CLI always pretends coordination is HTTP even locally. Each is a symptom of the same disease: there is no canonical boundary for *what is truth* and *who owns live state*. This design establishes that boundary — and recognizes that Coral has two distinct truths, not one.

**What changes**:
- **Journal authority** = SQLite `events` table in `~/.coral/data/store/store.db`. Truth for `job`, `session`, `discuss`, `workflow`. Append-only; ordered by `seq`; ACID transactions for multi-event operations.
- **Corpus authority** = markdown filesystem at `~/.coral/kb/`, git-tracked. Truth for `kb` (notes, sources, principles, communities, entity graph). Obsidian-editable; freshness tracked by `contentSeq` / `metadataSeq`.
- **CoralCoordinator** = single writer across both authorities. Sole owner of live state (admission, host pool, subscriptions).
- **Read authorities**:
  - Journal: `CoralStore` thin SQL query layer.
  - Corpus: direct filesystem reads + `projection_kb` for metadata lookup.
- **Providers** emit canonical event bodies; the coordinator wraps them in envelopes and appends to the Journal in transactions.
- **Workflow** = durable plan declared once on `workflow/<id>` stream; child jobs reference slots by `slotId`.
- **Failures (Journal)** = domain events on their originating stream; job terminals carry `causeRef: {stream, seq}` pointers. No wrapped fault union. The only fault ADT is `JobLifecycleFault` (3 variants).
- **Cross-authority references** = `KbRef = { entryId, contentHash? }`. `contentHash` optional for point-in-time semantics.
- **Schema evolution** = per-`type` `bodyVersion` + upcaster chain for Journal events; SQL migrations for projection schema; markdown format evolution via frontmatter parser flexibility.
- **Equipment** (Zelda UX) = opt-in `/equip needle` enhances specific query paths. Base tier fully functional with Orama (FTS zero-config, vector with embedding provider config per README). No native deps in base bundle.
- Everything else (`status.json`, `result.md` as authority, `WorkflowCheckpoint`, `LaunchState` files, segment rotation, checkpoint files, advisory `writer.lock`, multi-variant `CoralFault` union, unified "everything is an event" thesis) either becomes a projection/export or disappears outright.

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

### 2.6 Extension Model (Equipment)

Coral ships as a lightweight plugin (~3MB bundle): install gives a fully functional system for its zero-config surface (CLI, jobs, sessions, discuss, workflow, KB FTS). Features that intrinsically need external resources (vector search needs an embedding provider; ANN at scale needs a native addon) are documented in README with a one-line setup per feature. Users opt into heavier capabilities via explicit `/equip <name>` commands.

**UX philosophy — Zelda-style**:
Equipment is **curiosity-driven**, never enforced. A user scanning the CLI notices `/equip` exists, reads what's in the catalog (`/equip --list`), and picks something interesting if they want to. Nothing prompts, nags, or requires them to equip. The base tier remains fully functional forever — equipping is a **reward for curiosity**, not a completion requirement.

The metaphor: Link's base sword always works. Finding the bow is exciting because it opens new play, but Link was never broken without it. Coral's base tier always works. Finding needle is exciting because it sharpens KB search, but KB was never broken without it.

**Two-tier runtime**:
- **Base tier** — the default after plugin install. Zero-config surface (CLI, jobs, sessions, discuss, workflow, KB FTS) works immediately. Vector search additionally requires an embedding provider (Google Gemini API key is the documented default; one-line README setup).
- **Equipped tier** — one or more equipments active. Same commands, sharper implementations on specific query paths.

**Equipment principles**:
1. Equipment **replaces a specific projection backend**, it does not add new commands. The CLI surface is identical in both tiers.
2. Equipment **never writes events**. Events are truth; equipment maintains additional or replacement projections.
3. Every equipped projection is **rebuildable from events alone**. Equipping = install + subscribe + replay to build local state.
4. Unequipping **returns the replaced path to the base backend** without data loss and without command availability changes.
5. Equipment is loaded via **dynamic import** — the heavy dependency enters the process only after `/equip` completes.
6. Equipment is **never prompted** — the base tier must never display "equip X to unlock this" suggestions. Discovery is through `/equip --list` or documentation, not through nagging.

**First equipment: `/equip needle`** (catalog id: `needle`):
- C++ N-API addon at `../coral-needle` (sibling repo). Prebuilt binaries via GitHub Releases for 5 platforms.
- Provides DuckDB-backed ScanANN vector search: exact brute-force, USearch HNSW, Google ScaNN tree-AH (auto-selected by dataset size).
- Replaces the KB vector search backend: Orama's base-tier cosine search → needle's ANN search.
- FTS (Orama BM25) is unchanged in both tiers.
- Hybrid RRF uses whichever vector backend is active.
- Onboarding: embedding provider setup (local ONNX model or manual config) — see `skills/equip/SKILL.md`.

The `/equip` slash command is already implemented at `skills/equip/` with a catalog-driven installer (`install.mjs`). The post-refactor catalog uses tool-named entries (`needle`, and future tools by tool name) rather than capability-named entries, matching the Zelda equipment metaphor.

The equipment slot for vector search exists in base tier (§10 `kb/search/orama-backend.ts` implements the interface). Orama's base-tier vector implementation lands alongside the refactor — it is part of the first deploy, not a post-deploy follow-up. The "post-refactor feature" framing used elsewhere means "after the architecture refactor is complete, before first deploy," not "after users are running the new version." Per the solo-development model (§0), all declared capabilities are present at first deploy.

**Projection freshness model**:
Equipment consumers subscribe to an **authority** (Journal or Corpus, §2). Each authority has its own monotonic version:
- Journal authority → version is `events.seq`; consumers use range-based replay.
- Corpus authority → version is `contentSeq` (or `metadataSeq` for metadata-only changes); consumers use snapshot-based content-hash diff.

Both use the same `ConsumerDriver` mechanics: receive `notify(authority, version)` signals after an authoritative write, drain in a single-in-flight microtask (backpressure-safe), persist the cursor only after successful `apply()` completes. Strict-freshness reads use `waitFreshUntil(version, consumerId)`, implemented as a condition-variable wake (not polling). Consumer `apply()` must be **idempotent** — a crash between apply and cursor persistence causes the same range to be re-applied on startup; consumer implementations must tolerate this (`upsert` semantics, not `insert`).

For coordinator-mediated KB writes: the Corpus mutation lock wraps markdown write + base index update (Orama) synchronously; equipment consumers (needle) are notified after the lock releases and drain asynchronously.

This decouples equipment latency from authoritative write latency: a slow or failing equipment projection never blocks a `promote` call from returning. Failed drains retain the last-successful cursor for retry on next `notify` or startup. Fault isolation is structural.

---

## 3. Journal Substrate (SQLite)

The Journal authority (§2.1) is backed by a **single transactional event database**. Path depends on build flavor (hook isolation requires flavor-gated paths):
- prod: `~/.coral/data/store/store.db`
- dev: `~/.coral/data/store-dev/store.db`

SQLite in WAL mode is the reference implementation: it provides append-only write semantics, ACID transactions across multiple events, concurrent readers, and a single-writer discipline via `BEGIN IMMEDIATE` — all properties the Journal requires, without reinventing them.

The Corpus authority (§2.2, §6.4) uses the filesystem directly and is documented separately. This section covers only the Journal substrate.

### 3.1 Schema

```sql
-- The journal: append-only event log
CREATE TABLE events (
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
CREATE INDEX events_stream ON events(stream_kind, stream_id, seq);
CREATE INDEX events_type   ON events(type, seq);
CREATE INDEX events_refs_parent ON events(json_extract(refs, '$.parentJobId'), seq);

-- Projection tables (read models). Rebuildable from events.
CREATE TABLE projection_jobs (
  job_id         TEXT PRIMARY KEY,
  phase          TEXT NOT NULL,
  terminal       TEXT,            -- JSON { outcome, durationMs } or NULL
  diagnostics    TEXT,
  parent_job_id  TEXT,
  workflow_slot  TEXT,            -- slotId on parent's plan
  last_seq       INTEGER NOT NULL
);
CREATE INDEX projection_jobs_parent ON projection_jobs(parent_job_id);

CREATE TABLE projection_sessions (
  session_id       TEXT PRIMARY KEY,
  controller       TEXT NOT NULL,
  provider         TEXT NOT NULL,
  resumable        INTEGER NOT NULL,
  conversation_ref TEXT,
  last_seq         INTEGER NOT NULL
);

CREATE TABLE projection_discuss (
  discuss_id TEXT PRIMARY KEY,
  state      TEXT NOT NULL,        -- JSON (reducer output)
  last_seq   INTEGER NOT NULL
);

-- KB metadata projection (derived from Corpus, not Journal).
-- Refreshed by CorpusConsumer sync from markdown files; `content_seq` tracks
-- the Corpus version (see §6.4), not the Journal's events.seq.
CREATE TABLE projection_kb (
  entry_id    TEXT PRIMARY KEY,
  title       TEXT,
  content     TEXT,                -- cached for rebuild; Corpus markdown is authoritative
  frontmatter TEXT,                -- JSON
  content_seq INTEGER NOT NULL     -- Corpus version at last refresh
);

CREATE TABLE projection_workflows (
  workflow_id TEXT PRIMARY KEY,
  plan        TEXT NOT NULL,       -- JSON: { slots: [{slotId, label, provider, instruction, ...}] }
  last_seq    INTEGER NOT NULL
);

-- Metadata
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Rows: schema_version, journal_version, coordinator_id, created_ts

-- Corpus version state (KB authority — see §6.4)
-- Single row. contentSeq/metadataSeq are monotonic counters on the Corpus.
CREATE TABLE corpus_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  content_seq   INTEGER NOT NULL,
  metadata_seq  INTEGER NOT NULL,
  last_mutation TEXT    NOT NULL    -- ISO 8601
);

-- Equipment projection cursors (async push model; see §2.6)
-- Cursor interpretation depends on the consumer's authority:
-- - Journal consumers: cursor is events.seq
-- - Corpus consumers: cursor is corpus contentSeq (or metadataSeq)
CREATE TABLE equipment_cursors (
  consumer_id TEXT PRIMARY KEY,      -- 'orama-fts', 'orama-vector', 'needle-vector'
  authority   TEXT NOT NULL,         -- 'journal' | 'corpus'
  cursor      INTEGER NOT NULL,      -- last successfully-applied seq/contentSeq
  equipped_at TEXT    NOT NULL       -- ISO 8601 of most recent equip
);

-- Curate scheduler bookkeeping (replaces today's curate-state.json).
-- Single row. Worker claim is omitted (coordinator single-writer covers it);
-- migration_version is omitted (meta.schema_version handles schema evolution).
CREATE TABLE curate_scheduler (
  id                         INTEGER PRIMARY KEY CHECK (id = 1),
  processed_through          TEXT,                        -- JSON: CurateCursor
  discovery_high_seq         INTEGER,
  discovery_offset           INTEGER,
  last_run_day               TEXT,
  consecutive_failures       INTEGER NOT NULL DEFAULT 0,
  community_topology_hash    TEXT
);

-- Curate retry queue (pendingRepair[] in today's JSON state).
-- Each entry has its own retry schedule; indexed by retry_not_before for
-- O(log n) "who is due now" scans.
CREATE TABLE curate_retry_queue (
  entry_id                   TEXT PRIMARY KEY,
  reason                     TEXT NOT NULL,
  observed_at                TEXT NOT NULL,
  retry_not_before           TEXT NOT NULL,
  retry_count                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX curate_retry_by_time ON curate_retry_queue(retry_not_before);
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
~/.coral/exports/
  jobs/<jobId>/result.md             (materialized from job.terminal.recorded)
```

Deleting `~/.coral/exports/` never loses truth — rebuild from Journal events.

Note: KB markdown files at `~/.coral/kb/` are **not exports**. They are the Corpus authority itself (§2.2, §6.4). Derived KB indexes (Orama, needle) live at `~/.coral/data/kb/` and are rebuildable from the Corpus.

### 3.5 Replay identity

Pure reconstruction holds: for any `seq_cutoff`, the projection rows derived by replaying events `[1..seq_cutoff]` are byte-identical to the projection rows SQLite would hold after committing those events. This is why `DROP TABLE projection_*` + full rebuild is a valid recovery path.

### 3.6 What this buys

| Current design (residue) | SQLite substrate | Gain |
|---|---|---|
| Segment rotation logic | None — SQLite WAL checkpointing is automatic | Delete code |
| Standalone checkpoint files | None — projections ARE the live state | Delete code |
| Advisory `writer.lock` file | SQLite `BEGIN IMMEDIATE` | Delete code |
| Projection versioning / invalidation files | `meta.schema_version` row + SQL migration | Simpler |
| Log-scan queries for cross-domain lookups | SQL JOIN | Faster, less code |
| Cross-stream atomicity gap | `BEGIN..COMMIT` transaction | Correct by construction |
| Custom JSONL segment readers/parsers | Parameterized SQL queries | Delete code |

The `CoralStore` becomes a thin SQL query layer. The `CoralCoordinator` is the sole owner of a writable DB connection.

**Terminology note**: "SQL migration" and the `migrations/` directory (§10) refer to **schema-change scripts** (CREATE/ALTER/DROP statements applied as Coral evolves) — the standard SQL ecosystem convention. They are **never** about migrating user data from a prior coral version, which does not exist (clean-slate rewrite, §0). If you read "migration" in this document, it always means SQL schema evolution, never data migration.

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

**`bodyVersion`**: per-type schema version. Each event type starts at `bodyVersion: 1`. When a type's body shape evolves, the new version increments and an **upcaster** is registered that lifts older-version payloads into the current shape at read time (§4.2). There is no single envelope `v:` field — envelope evolution uses SQL migration on the `events` table itself (rare; a major surgery).

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

Rules:
- Additive fields (new optional field): no version bump; keep schema backward-compatible.
- Structural changes (removed field, renamed field, type narrowed): version bump + upcaster.
- Upcasters are kept forever — the store may contain any historical version.

This is the endpoint's evolution story. "Clean-slate rewrite" starts every event at `v:1`; upcasters are zero on day one. But the **mechanism** exists, so the first real evolution is cheap.

---

## 5. Journal Stream Kinds

The Journal authority (§2) carries **four** stream kinds, one per process-like domain. KB is NOT a Journal stream — it lives in the Corpus authority and is documented in §6.4.

### 5.1 `job/<id>`
Events about a single job's lifecycle: launch request, queue admission, runtime start, progress ticks, terminal outcome.
Projection: `JobView` (phase, terminal, diagnostics, parent, workflowSlotId, lastSeq).

### 5.2 `session/<id>`
Events about a provider session: opened, continuity checkpointed (full snapshots), interrupted, closed.
Projection: `SessionView` (controller, provider, resumable, conversationRef, lastSeq).

### 5.3 `discuss/<id>`
Events about a multi-agent discussion: existing vocabulary preserved (seed, speak, bid, synthesis, etc.).
Projection: `DiscussView`.

### 5.4 `workflow/<id>`
Events about a workflow's durable plan and execution shape: plan declared, revised, completed. A workflow is a first-class aggregate, distinct from the jobs that execute its slots. Child jobs reference their slot via `refs.workflowSlotId`; they do NOT carry `stepIndex`/`atomIndex`/`label` (those are plan-owned).
Projection: `WorkflowView` (plan + slot outcomes aggregated from child jobs).

### 5.5 Why four Journal kinds

Every Journal event must tell projections which dispatch table applies. Collapsing to a single kind forces every projection to filter on `type` string prefixes — fragile, string-typed. Four kinds = four natural boundaries, each owning a genuinely different process-like vocabulary.

### 5.6 Why KB is not a Journal stream

KB entries are **knowledge artifacts**, not process events. They accumulate, get edited (often externally via Obsidian), and reference each other through entity graphs. The filesystem is the natural substrate: atomic rename, git-backed sync, direct human editability. Forcing a `kb/<id>` Journal stream would require bi-directional sync between filesystem and events, with race resolution for Obsidian edits — complexity with no compensating elegance.

KB's authority is the Corpus (§6.4). Journal events referencing KB entries use `KbRef` (§2.4).

---

## 6. Event Families

### 6.1 Jobs (`stream.kind = 'job'`)

```ts
job.launch.requested   { instruction, agent }
job.queue.queued       { reason: 'seat_exhausted' | 'host_locked' }
job.queue.admitted     { admittedAt }
job.runtime.started    { pid, hostKey? }
job.progress.emitted   { message, stage?, detail? }
job.terminal.recorded  { terminal: JobTerminal, diagnostics: JobDiagnostics }
```

**Why the queue split (`queued` vs `admitted`)**: queueing is a first-class state, not an implementation detail. `queued` names the reason (host lock, seat exhaustion) for observability; `admitted` names the transition. Projections can answer "how long was this job queued" without log-grepping.

**`job.progress.emitted` carries domain-specific failure detail**: when a job performs a domain operation (KB promote, KB curation step, etc.) and hits a failure, the failure is recorded as a rich progress event. `stage` names the semantic stage (e.g., `kb_operation_failed`); `detail` carries domain payload (e.g., `{ operation, entryId, cause }`). The terminal outcome then uses `failed { causeRef }` pointing back at this progress event on the same stream — self-stream causeRef is the normal pattern for job-local failure chains. This is why there is no separate `kb/<id>` stream: coordinator-mediated KB operations are jobs, and their failures live on the job stream.

**Workflow context lives on envelope refs, not in body**:
A child job launched by a workflow carries envelope-level references, not body fields:
- `refs.workflowId` — points to the workflow stream that owns the plan.
- `refs.workflowSlotId` — points to the specific slot within that plan.
- `refs.parentJobId` — points to the workflow job (a distinct job that materializes the workflow's execution).

The child launch event's **body** is identical to any other job launch (`{ instruction, agent }`). Syntax-shaped metadata like `stepIndex`, `atomIndex`, and `label` do not appear on the launch event — they are plan-owned (§6.5) and derived via `refs.workflowSlotId` at render time. This is the strict application of "stream identity is truth, labels are presentation" to workflow composition.

### 6.2 Sessions (`stream.kind = 'session'`)

```ts
session.opened                   { controller, provider }
session.continuity.checkpointed  { conversationRef, resumable, providerContinuity }
session.closed                   { reason }
```

**Why continuity is a full snapshot, not a patch**:
Today's design would have us emit "conversationRef changed from X to Y". A future reader would need every prior patch to know the current state. Full snapshots are idempotent: the latest one is the truth. This matches Pioneer C's stream model and eliminates a replay-order-dependency bug class.

**What `providerContinuity: unknown` is**:
Each provider stores opaque continuation data — Codex stores a `threadId`, Claude stores an `appServerSessionId` and control cursor. The coordinator does not interpret this; it round-trips it. The `unknown` type is intentional: it is the provider's private state.

### 6.3 Discuss (`stream.kind = 'discuss'`)

Preserves the existing discuss event vocabulary (`discuss.seeded`, `discuss.speech.posted`, `discuss.synthesis.recorded`, etc.). The reducer and projections in `src/discuss/` are already correct; only the envelope wraps them now.

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
  orama-index.json                  ← Orama serialized index (base-tier FTS + vector)
  vec/                              ← needle's DuckDB (equipment-tier vector)
  equipment_cursors                 ← in store.db (SQLite); tracked per Corpus consumer
```

**Freshness counters** (versions, not events):

- `contentSeq` — monotonic counter; increments on any content mutation (promote, update, source-import).
- `metadataSeq` — monotonic counter; increments on metadata-only changes (tags, frontmatter).

These are analogous to `events.seq` on the Journal side but version the whole Corpus rather than counting discrete events. Consumers track their cursor against these counters and catch up via manifest diff (not event replay).

**Mutations** (coordinator-mediated, via CLI):

All coordinator KB operations follow the same pattern inside a single **Corpus mutation lock**:

1. `writeFileAtomic` — markdown `.tmp` + rename (atomic at filesystem level).
2. Bump `contentSeq` (or `metadataSeq`) in the corpus version state.
3. `commitIndexUpdate` — update base index (Orama) synchronously in the same lock.
4. Release lock.
5. Notify Corpus consumers (e.g., needle) — they run their apply loop asynchronously (§9).

External edits (Obsidian, manual filesystem ops, `git pull`) bypass the coordinator entirely. They are detected by startup scans and periodic rescans; the next `ensureVectorIndex` picks up the drift via manifest diff.

**Projections / search backends** (all rebuildable from the Corpus alone):

| Backend | Role | Tier | Substrate |
|---|---|---|---|
| `projection_kb` (SQLite) | metadata lookup (slug, title, content for rebuild) | base, always | Journal substrate (shares `store.db`) |
| **Orama** (JS-native) | FTS (BM25) + vector (cosine) | base, always | `~/.coral/data/kb/orama-index.json` |
| **coral-needle** (C++ DuckDB ScanANN) | ANN vector at scale; replaces Orama's vector path | equipment (`/equip needle`) | `~/.coral/data/kb/vec/*.duckdb` |

`projection_kb` lives in SQLite alongside Journal projections for convenience (unified query surface), but its authoritative source is the Corpus, not the Journal. Its rebuild reads markdown, not events.

**Equipment principle applied**:
- Command surface is identical in both tiers: `kb search "query"`, `kb search --vector <emb>`, `kb search --hybrid "query"` all exist.
- Base tier: Orama FTS (zero-config) + Orama vector (cosine brute-force). Vector requires embedding provider config — register Google Gemini API key per README, one line in `~/.coral/.env`.
- Equipped (`/equip needle`): vector and hybrid paths upgrade to ScanANN for scale. Uses the same embedding provider as base. FTS unchanged.
- No new commands appear from equipping. The needle sharpens existing blades, it does not add new weapons.
- Why not bundle ONNX for zero-config local embeddings? `onnxruntime-node` is ~82MB compressed / 210MB unpacked — roughly 40× the current plugin size. Bundling breaks the "click-install, just works" UX premise. A Google Gemini API key is a one-line README step; the free tier covers personal-scale KB use indefinitely. Users who need fully offline embedding can opt in via `/equip` onboarding which installs the local ONNX runtime alongside the needle addon.

**Why Orama is architecturally load-bearing** (not replaceable by SQLite FTS5):
Orama's value is NOT just FTS quality — it is the combination of (1) pure JS, zero native dependencies, and (2) dual-modal support (FTS + basic vector search) in one library. These together enable the Zelda-style base tier: full KB search functionality with zero install friction. Replacing Orama with SQLite FTS5 is superficially attractive (unified storage, FTS co-transactional with metadata) but collapses on the vector axis: SQLite has no native vector search; `sqlite-vec` requires a loadable C extension (native binary, kills the zero-dep premise); custom SQL cosine is slow and worse than Orama. Every alternative forces losing base-tier vector search or compromising the zero-native-dep base tier. **Orama is the only option that satisfies both constraints simultaneously.** The Corpus + indexes layout is role-specialization, not accidental complexity.

**Operational facts are not Corpus mutations.** Events like "Orama index rebuilt", "needle index snapshot rotated", "WAL checkpointed" are coordinator-local operational telemetry — they belong in structured logs, not on any authority.

**Curate state location**: the curation pipeline (discovery, classification, community detection, entity consolidation, retry scheduling) maintains operational state in `curate_scheduler` + `curate_retry_queue` SQLite tables (§3.1), not in `curate-state.json`. The curate scheduler runs as a coordinator-live component (§10 `coordinator/live/curate-scheduler.ts`), not as a Corpus domain leaf — single-writer discipline requires it inside the coordinator process. Its cursors are device-local operational state, not authoritative content.

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
| **Needs manual** | Queue the entry in `curate_retry_queue` with a repair hint. User sees a diagnostic (`coral-cli kb diagnose` or dashboard). |
| **Unrecoverable** | Log + skip. Entry absent from projections until user fixes the source file. |

**Status note**: the current codebase has a partial, ad-hoc repair mechanism (`kb/curate/text-artifacts.ts`: `rebuildTextArtifactsAndPersistRepairState`, `detectTextArtifactRebuildInfo`, `pendingRepair[]`) that handles specific cases encountered during initial development. The refactor **redesigns** this from scratch — not porting the existing ad-hoc code but building a proper classification-driven repair pipeline. Coverage of the detected-issue taxonomy is a deliverable of the refactor, not a best-effort outcome.

Repair operations that mutate the Corpus go through the standard Corpus mutation lock (§6.4 mutations). No special substrate.

### 6.5 Workflow (`stream.kind = 'workflow'`)

```ts
workflow.plan.declared  { plan: WorkflowPlan }
workflow.completed      { outcome: 'completed' | 'failed' | 'aborted'; causeRef? }
```

```ts
type WorkflowPlan = {
  slots: WorkflowSlot[];
  labels: Record<string, string>;   // slotId → human label
};

type WorkflowSlot = {
  slotId: string;                    // stable id, e.g. "sl-0-0", "sl-1-2"
  dependencies: string[];            // slotIds this slot waits for
  provider: string;                  // e.g. 'codex', 'claude'
  instruction: string;
  agent?: string;
};
```

**Why plan as a separate stream-kind**:
- Plan is a durable aggregate with semantics (dependencies, labels, slot IDs) independent of any single job execution.
- Child jobs reference `refs.workflowSlotId` and `refs.workflowId`; the plan lives ONCE on the workflow stream, not duplicated on every child launch.
- `workflow.plan.revised` (future) can add/modify slots without touching child events — plans evolve without rewriting history.
- Syntax-shaped metadata (`stepIndex`, `atomIndex`, `label`) live on the plan slot, not on individual launches. Labels are presentation; `slotId` is truth.
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
- `kb_operation_failed` — replaced by `job.progress.emitted { stage: 'kb_operation_failed', detail }` on the **hosting job's own stream** (coordinator-mediated KB operations run as jobs); job terminal uses `failed { causeRef }` pointing self-stream to that progress event. KB is not a Journal stream (§5.5, §6.4). `discuss_moderator_failed`, etc. — replaced by `discuss.moderator.failed` on `discuss/<id>`; job terminal uses `failed { causeRef }`.

The **composable union with domain-owned variants** was itself residue — ADT-shaped thinking on top of journal-native causal references. A journal already gives us stream+seq as durable identities; wrapping each fault kind into a union was reinventing pointers as enums.

### 7.3 Domain fault events

Every domain that can surface failure emits domain-owned events on its own stream. Representative event types (each domain defines its own body schema):

```
job/<id>                  job.launch.rejected              { provider, reason, message, globalActive, globalLimit }
job/<id>                  job.progress.emitted             { message, stage?, detail? }  — carries coordinator-mediated
                                                                                            domain failures (e.g., KB op
                                                                                            errors inside a kb-promote job)
session/<id>              session.interrupted              { trigger, continuity }
session/<id>              session.provider_failed          { provider, reason, message }
session/<id>              session.adapter_unparseable      { provider, stdout, stderr, parseError }
discuss/<id>              discuss.moderator.failed         { cause }
discuss/<id>              discuss.synthesis.failed         { cause }
workflow/<id>             workflow.completed               { outcome: 'failed' | 'aborted', causeRef? }
```

KB failures have no dedicated Journal stream. Coordinator-mediated KB operations run AS jobs; their failures are recorded on the job's own stream as rich progress events (`stage: 'kb_operation_failed' | 'kb_curation_failed' | ...`), and the job terminal's `causeRef` points to that progress event. Background curate failures are operational logs, not events — retry is scheduled via `curate_retry_queue` (§3.1). External edits themselves are the **normal** path (Obsidian + git + rescan auto-handle them, see §12.3); only **malformed** content (git conflict markers left in a file, invalid frontmatter) is treated as a skip + log case during rescan, not as an event.

These are NOT declared in a central `CoralFault` union. They are regular domain events with well-known type strings. A renderer that wants to describe a `causeRef` reads the referenced event's type and dispatches to the domain's describer function:

```ts
// src/rendering/fault.ts
export function describeCauseRef(ref: CauseRef, store: CoralStore): string {
  const event = store.getEvent(ref.stream, ref.seq);
  switch (`${event.stream.kind}:${event.type}`) {
    case 'job:job.launch.rejected':         return describeLaunchRejected(event.body);
    case 'job:job.progress.emitted':        return describeJobProgressFault(event.body);  // KB and other in-job failures
    case 'session:session.interrupted':     return describeSessionInterrupted(event.body);
    case 'session:session.provider_failed': return describeProviderFailed(event.body);
    case 'workflow:workflow.completed':     return describeWorkflowFailed(event.body);
    // ... each domain contributes describers for its own fault-bearing event types
  }
}
```

Adding a new domain with failure modes: implement the domain's events with describer functions, register them in `describeCauseRef`. The domain defines its own body schemas; no central fault union to edit.

### 7.4 Fault ownership (single-producer per event type)

Each fault-bearing event type has one producer:

| Event | Stream | Producer |
|---|---|---|
| `job.launch.rejected` | `job/<id>` | `coordinator/live/admission.ts` |
| `job.progress.emitted` (with `stage: 'kb_operation_failed'`/etc.) | `job/<id>` | `kb/ops/` (via coordinator-mediated operation; detail captured inside the hosting job) |
| `session.interrupted` | `session/<id>` | `coordinator/live/provider-hosts.ts` |
| `session.provider_failed` | `session/<id>` | provider leaf kernel |
| `session.adapter_unparseable` | `session/<id>` | `providers/middleware/adapter-parse-guard.ts` |
| `discuss.moderator.failed`, `discuss.synthesis.failed` | `discuss/<id>` | `discuss/shell/` |
| `workflow.completed { outcome: 'failed' | 'aborted' }` | `workflow/<id>` | `workflow/executor.ts` |
| `job.terminal.recorded { outcome: { kind: 'job_fault', ... } }` | `job/<id>` | `jobs/reconcile/` (for ghost/lost) or job wrapper (for crashed) |

KB curation background failures and malformed-content detection during rescan are NOT on the Journal — they are operational logs + entries in `curate_retry_queue` + corpus repair pipeline. Successful external edits (the common case) are transparent: rescan picks up the change, projections reindex, git-sync auto-commits. No events, no errors. Malformed markdown (conflict markers, invalid frontmatter, missing required fields, entrySeq collisions) enters the **corpus repair pipeline** (§6.4.1) — auto-fix where safe, queue manual cases, log unrecoverable.

No layer rewrites another layer's event.

### 7.5 Fault propagation — end-to-end with causal graph

Any subsystem fault reaches any end consumer uniformly by walking the causal graph. No duplication; no wrapping; no re-encoding.

**End-to-end example — KB curation failure inside a workflow**:

All events land in ONE transaction (SQLite `BEGIN IMMEDIATE..COMMIT`):

```
seq=101  job/kb-1      job.progress.emitted
                       { message: 'KB promote failed during Orama index write',
                         stage: 'kb_operation_failed',
                         detail: { operation: 'promote', entryId: 'entry-x',
                                   cause: { message: 'orama index corrupted' } } }

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
  → Workflow wf-1 failed (slot sl-1-0 "kb-promote")
    → Job kb-1 failed
      → KB entry-x: promote failed at orama_index_write — index corrupted

  ✓ analyze      sl-0-0 completed
  ✗ kb-promote   sl-1-0 failed   [kb_operation_failed]
```

The renderer:
1. Reads `JobView(wf-1).terminal.outcome` → `failed` with `causeRef` to `workflow/wf-1@103`.
2. Reads event at `workflow/wf-1@103` → `workflow.completed { outcome: 'failed', causeRef: job/kb-1@102 }`.
3. Reads event at `job/kb-1@102` → terminal with `causeRef: job/kb-1@101` (self-stream progress event).
4. Reads event at `job/kb-1@101` → `job.progress.emitted { stage: 'kb_operation_failed', detail: { entryId: 'entry-x', cause: {...} } }` — the origin fact.
5. Dispatches each event type to its describer function; concatenates the rendered chain.

Slot labels (`"kb-promote"`) come from the workflow plan projection (§6.5), not from any fault payload.

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
  appServerSession(buildClaudeProviderServerSpec, mapClaudeInterrupt),
  sessionContinuity(claudeBrokerContinuity),
  claudeBrokerTurnKernel,
);

const codexThreadProvider = compose(
  appServerSession(buildCodexProviderServerSpec, mapCodexInterrupt),
  sessionContinuity(codexThreadContinuity),
  codexTurnKernel,
);
```

Adding a new provider is declaring its middleware stack.

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

Projection types (all maintained in SQLite):

```ts
type JobView = {
  jobId: string;
  phase: 'queued' | 'running' | 'completed' | 'error' | 'aborted';
  terminal: JobTerminal | null;
  diagnostics: JobDiagnostics | null;
  parentJobId: string | null;
  workflowId: string | null;
  workflowSlotId: string | null;   // points into the parent workflow's plan
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
  providerContinuity: unknown;
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

- `projection_kb` (SQLite) — metadata lookup (slug, title, cached content, frontmatter, `content_seq` at last refresh).
- Orama serialized index (base-tier FTS + future vector).
- needle DuckDB ANN index (equipment-tier vector).

The per-consumer manifest (hashes of processed entries) lives beside the consumer's storage — e.g., `~/.coral/data/kb/vec/<snapshot>/manifest.json` for needle.

### 9.3 Why two consumer interfaces

Journal events are discrete and ordered; range replay is natural. Corpus entries are continuous and mutable; snapshot diff is natural. Forcing one interface on both would distort at least one — replay semantics on mutable files loses atomicity; snapshot semantics on event history discards the causal chain.

Both interfaces share:
- Durable cursor (in `equipment_cursors` with `authority` field).
- Idempotent `apply()` (invariant #44).
- Condition-variable `waitFreshUntil(version, consumerId)` wake mechanism.
- Fault-isolated execution (consumer failure never blocks authority writes).

### 9.4 "Completed" is defined

> A job is **completed** iff: the wait path has observed a `job.terminal.recorded` event for the stream AND the projection after applying that seq has `outcome.kind === 'completed'` or (`outcome.kind === 'provider_exit' && code === 0`).

A workflow is **completed** iff its `workflow.completed` event lands with `outcome: 'completed'`.

No stored "is complete" boolean anywhere. Projections compute it from event presence.

### 9.5 Children are derived, not stored

`JobView` does NOT carry a `children` array. Child jobs are discovered by SQL query:

```sql
SELECT job_id, phase, workflow_slot FROM projection_jobs WHERE parent_job_id = ?
```

`WorkflowView.slotOutcomes` is built by the projection reducer from child job events + the workflow plan. No denormalization onto the parent.

### 9.6 Why a single `WaitCursor.afterSeq`

Journal events have a single global `seq`. One number describes "what I have seen so far" for any Journal tail subscription. Corpus reads don't need a cursor — they observe current state directly.

### 9.7 Why no denormalized child array on `JobView`

With events in a database, joining child jobs onto a parent is a single indexed SQL query — cheaper than carrying a denormalized array that drifts under concurrent child terminations. `JobView` stays lean; `WorkflowView` owns the aggregate read model.

---

## 10. Topology

```
src/
  coordinator/                       ← single-writer daemon; owns live state
    coordinator.ts                   — composition root (factory + world + state + lifecycle)
    api.ts                           — public coordinator RPC surface
    control.ts                       — control-plane commands (shutdown, drain)
    lock.ts                          — coordinator singleton lock. Implements warm-start handoff between
                                       plugin-install versions: STARTUP_DEADLINE (30s), CONTENDER_BUDGET (90s),
                                       bundleHash + flavor gating. Feature rationale: when user updates the
                                       plugin, old coordinator detects new bundle and hands off cleanly so
                                       CLI stays usable without manual intervention. This is process-identity
                                       locking (one coordinator per flavor), separate from SQLite's BEGIN
                                       IMMEDIATE (which serializes writes within one coordinator).
    discovery.ts                     — coordinator discovery record I/O (renamed from info.ts in Phase 3 — name now matches §10.3 intent-revealing rule; see Amendments)
    log.ts                           — coordinator-local structured logging
    caller-context.ts                — per-request caller identity scope
    consumer-driver.ts               — projection consumer driver: push-triggered,
                                       single-in-flight drain, condition-var waitFreshUntil
    shutdown/
      mode.ts                        — graceful / drain / immediate
      network.ts                     — socket/HTTP teardown
      sequence.ts                    — ordered shutdown steps
    live/
      admission.ts                   — launch admission (seat/host pool)
      provider-hosts/                — app-server host pool (lease, idle, drain, recovery; 16K file decomposed here)
        pool.ts, lease.ts, idle.ts, drain.ts, recovery.ts
      idle.ts                        — idle-daemon eviction policy
      curate-scheduler.ts            — periodic Corpus curation (discovery, community detection, repair retry).
                                       Coordinator-owned: curate is a background scheduler, not a Corpus domain leaf,
                                       because single-writer discipline requires it run inside the coordinator process.
    recording/
      observer.ts                    — journal append subscriber for telemetry

  store/                             ← SQL query layer over SQLite event DB
    db.ts                            — SQLite connection factory (WAL mode)
    schema.sql                       — table definitions (events, projection_*, meta)
    schema.ts                        — TypeScript types mirroring the schema
    envelope.ts                      — Zod validator for event envelope + upcaster registry
    migrations/                      — numbered SQL migration files
      001_initial.sql
    append.ts                        — transactional append primitive (single-writer gate)
    reducers.ts                      — per-domain event-to-projection reducers
    index.ts                         — public barrel
    queries/
      jobs.ts                        — JobView + child job queries
      sessions.ts                    — SessionView queries
      discuss.ts                     — DiscussView queries
      kb.ts                          — KbIndex queries
      workflows.ts                   — WorkflowView queries (plan + slot outcomes)
      events.ts                      — raw event lookup by (stream, seq) for causeRef deref

  transport/                         ← carriage only; imports only contracts
    json-rpc.ts                      — shared RPC encoding
    ipc/
      server.ts                      — Unix socket server
      client.ts                      — Unix socket client
      ensure.ts                      — "start coordinator if needed" bootstrap helper (CLI-side)
    http/
      server.ts                      — HTTP gateway server
      gateway.ts                     — gateway adapter onto coordinator RPC
      client.ts                      — HTTP client
      sse.ts                         — SSE encoding/decoding
      query.ts                       — query-param coercion
      contracts.ts                   — HTTP wire schemas
      tool-response.ts               — MCP-style response wrapper
      errors.ts                      — HTTP error mapping
      health.ts                      — /health endpoint

  runtime/                           ← 6-subport Runtime; simulation substrate
    ports.ts                         — time, storage, paths, process, ids, env
    real.ts                          — production implementations

  infra/                             ← fs/process/time/ids; no domain knowledge
    project-source.ts                — project root + scoping
    plugin-registry.ts               — installed plugin discovery
    ids/                             — id generation + patterns
    fs/                              — atomic writes, directory locks, file tails
    process/                         — child-env, alive-checks, constants, errors
    json/                            — parse guards, type guards
    text/                            — truncation, formatting
    time.ts                          — clock abstraction (real impl)

  jobs/                              ← domain: jobs events + projections + shell
    events.ts                        — jobs event body schemas
    outcome.ts                       — TerminalOutcome + JobLifecycleFault + CauseRef + describers
    phase.ts                         — JobPhase + phaseForOutcome
    launch.ts                        — LaunchDecision + launch body types
    result.ts                        — JobTerminal + JobDiagnostics
    wait.ts                          — WaitCursor + wait body types
    projections.ts                   — JobView reducer (SQL reducers for projection_jobs)
    exports/
      result-markdown.ts             — materialize result.md from terminal events
    reconcile/                       — imperative reconciliation (not pure replay)
      plan.ts                        — classify world-state divergence
      registry.ts                    — known classifications
      snapshot.ts                    — world-state capture
      actions.ts                     — reconciliation actions (append recovery events)
      coordinator.ts                 — orchestrate reconciliation phases
      cross-namespace-adoption.ts    — cross-ns orphan adoption
      claim-protocol.ts              — adoption claim handshake
      ownership-checker.ts           — ownership verification
      job-helpers.ts                 — shared helpers
      errors.ts                      — reconciliation-local error types
    shell/                           — imperative I/O over jobs domain
      abort-registry.ts              — in-memory abort signal registry
      agent-resolution.ts            — resolve agent by id
      instruction.ts                 — instruction parsing
      launch.ts                      — launch job helper
      abort.ts                       — abort job helper
      wait.ts                        — wait stream helper

  sessions/                          ← domain: session events + projections
    types.ts                         — SessionEntry + controller profiles
    events.ts                        — session event body schemas
    continuity.ts                    — continuity snapshot type
    projections.ts                   — SessionView reducer
    shell/
      store.ts                       — session store helpers
      resolve.ts                     — session resolution by id/ref

  discuss/                           ← unchanged domain core; template
    state-machine.ts, reducer.ts, events.ts, projections.ts, schemas.ts
    shell/                           — imperative shell (moved from execution/discuss/)

  kb/                                ← Corpus-authority domain (markdown is truth)
    contracts.ts                     — public KB types
    types.ts                         — KB entity types (Note, Source, Principle, Community, EntityGraph)
    validation.ts                    — entry validation
    read.ts                          — load entry from markdown
    read-contract.ts                 — read interface
    corpus/                          — Corpus authority: markdown I/O
      paths.ts                       — resolve note/source/principle/community paths under ~/.coral/kb
      frontmatter.ts                 — parse/serialize YAML frontmatter
      markdown-entries.ts            — markdown ↔ entry conversion
      mutation-lock.ts               — single-writer lock around the Corpus
      mutation-helpers.ts            — writeFileAtomic + commitIndexUpdate + contentSeq bumps
      entry-seq-guard.ts             — entrySeq upgrade guard
    runtime-state.ts                 — in-memory Corpus state (contentSeq, metadataSeq, index handles)
    projections.ts                   — projection_kb reducer (Corpus snapshot → projection_kb)
    search/                          — search backend abstraction (equipment-aware)
      contract.ts                    — SearchBackend interface (fts, vector, hybrid)
      router.ts                      — picks active backend per query type; detects equipment
      chunking.ts                    — text chunking (shared by vector backends)
      embedding.ts                   — embedding provider abstraction (shared)
      orama-backend.ts               — base tier: FTS + vector (both at first deploy)
      orama-factory.ts, orama-schema.ts
      needle-backend.ts              — equipment: dynamic import of ../coral-needle; replaces vector
      hybrid.ts                      — RRF fusion over active FTS + vector backends
    ops/                             — user-facing operations (coordinator-mediated writes)
      memo.ts, promote.ts, update.ts, delete.ts
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
      claim-io.ts, shared.ts, types.ts, operations.ts, usage-budget.ts

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
      shared-utils.ts
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
    normalize.ts                     — AST normalization (desugaring) → WorkflowPlan
    plan.ts                          — WorkflowPlan + WorkflowSlot types + validation
    command.ts                       — workflow command schema
    events.ts                        — workflow event body schemas (plan.declared, completed)
    projections.ts                   — WorkflowView reducer (plan + slot outcomes)
    executor.ts                      — top-level orchestration: declares plan, schedules launches, emits workflow.completed
    launch.ts                        — atom launch + retry (intertwined per current code; §10.1a)
    wait.ts                          — await-step state + multi-atom wait + cascade
    recover.ts                       — stale-atom recovery paths

  simulation/                        ← promoted top-level
    runtime.ts                       — SimulationRuntime (Runtime impl)
    runner.ts                        — deterministic run loop
    recording.ts                     — event recording for replay tests
    adversarial.ts                   — adversarial scenario helpers

  testing/                           ← test helpers; never imported by production
    deferred.ts                      — test-only async primitive
    hooks/                           — hook test helpers + hook tests
    skills/                          — skill test helpers

  cli/                               ← Commander CLI client (preserved)
    bootstrap.ts, + subcommand modules

  hooks/                             ← Node.js ESM hook scripts (preserved)
```

### 10.1 What is deleted

- `src/execution/` — dissolves into `coordinator/`, `jobs/`, `sessions/`, `transport/`, `simulation/`
- `src/shared/` — every file relocates to a domain or `infra/` or `testing/`
- `src/client/` — replaced by `store/queries/` + `transport/ipc/client.ts` + `transport/http/client.ts`
- `src/bridge/` transport — replaced by `transport/`
- `recovery-core.ts` — replaced by `jobs/reconcile/` + `store/replay.ts`

### 10.1a Large-module decomposition (source of >500 lines today)

Current code has several files in the 20K-60K range. §10 names their destinations but real decomposition splits them by responsibility boundaries, not single-file relocation. A §10 file that would exceed 500 lines must be split further per the guidance below.

| Current | Size | Decomposed destinations |
|---|---|---|
| `src/execution/service.ts` | 56K | `jobs/shell/launch.ts`, `jobs/shell/wait.ts`, `jobs/shell/abort.ts`, `jobs/shell/workflow.ts` (via `workflow/executor.ts`), `sessions/shell/store.ts`, `sessions/shell/resolve.ts`, `coordinator/api.ts` (service composition). The god-class dissolves into seven domain-shell modules. |
| `src/execution/http-handler.ts` | 51K | `transport/http/server.ts` (route table only), `transport/http/query.ts`, `transport/http/contracts.ts`, `transport/http/tool-response.ts`, `transport/http/errors.ts`, `transport/http/sse.ts` + per-resource route files (`jobs-routes.ts`, `discuss-routes.ts`, `kb-routes.ts`, `workflow-routes.ts`). |
| `src/execution/engine.ts` | 34K | `coordinator/live/admission.ts` (launch admission + queue), `coordinator/live/durable-transport.ts` (DurableExecutionTransport seam), `coordinator/live/worker-limits.ts` (MAX_WORKERS / DISCUSS_MAX_WORKERS policy). |
| `src/execution/host-manager.ts` | 16K | `coordinator/live/provider-hosts/` subtree — `pool.ts`, `lease.ts`, `idle.ts`, `drain.ts`, `recovery.ts` (see §10 coordinator entry). |
| `src/execution/progress-store.ts` | 24K | REMOVED — job lifecycle events replace six-file progress. `jobs/shell/wait.ts` owns live-tail + SSE. `jobs/reconcile/` owns startup classification. |
| `src/execution/runtime.ts` | 22K | `runtime/ports.ts` (interface) + `runtime/real.ts` (production implementation). Current composition stays roughly this size; no further split needed since it is interface + single implementation. |
| `src/workflow/pipe-executor.ts` | 37K | Decompose along the natural seams in the current code (atom launch/retry coupling at `launchAtomWithRetry`, wait-state at `createAwaitStepState`, stale recovery at `recoverStaleAtom`, multi-atom wait at `waitForAtoms`): `workflow/executor.ts` (top-level orchestration), `workflow/launch.ts` (atom launch + retry — they are intertwined, not separable), `workflow/wait.ts` (await-step state + multi-atom wait + cascade), `workflow/recover.ts` (stale-atom recovery). Fault mapping lives inside whichever module emits the fault, not in a separate `error.ts`. |
| `src/providers/claude-appserver/session.ts` | 35K | `SingleSessionController` is a coherent unit — turn lifecycle, interrupt handling, and child binding share mutable state (`activeTurn`, `childBinding`, `bootstrapSignature`). Forcing a 4-way split would recouple through exported state. Natural split is 2-way: `providers/claude-appserver/controller.ts` (the controller class — turn + interrupt + child lifecycle as one unit) and `providers/claude-appserver/protocol.ts` (wire/control protocol handling). Continuity snapshot logic is a method on the controller, not a separate file. |
| `src/kb/curate/community-detection.ts` | 37K | Same file; algorithm cohesion > arbitrary split. Sub-routines stay here. |
| `src/kb/curate/classification.ts` | 34K | Same file. Domain algorithm. |
| `src/kb/curate/state.ts` | 31K | REDUCED — curate state moves to `curate_scheduler` + `curate_retry_queue` SQLite tables (§3.1). Remaining in-memory state logic collapses to ~5K. |
| `src/execution/simulation/world.ts` + `core/*` | ~80K | `simulation/runtime.ts`, `simulation/runner.ts`, `simulation/recording.ts`, `simulation/adversarial.ts`, `simulation/core/memory-storage.ts`, `simulation/core/mock-app-server.ts`, `simulation/core/mock-process.ts`, `simulation/core/virtual-time.ts`. Simulation substrate intact; internal decomposition matches current `core/` structure. |
| `src/execution/discuss/subflows.ts` | 26K | `discuss/shell/bid-flow.ts`, `discuss/shell/speech-flow.ts`, `discuss/shell/followup-flow.ts`, `discuss/shell/synthesis-flow.ts`. One file per sub-workflow. |
| `src/execution/discuss/session-store.ts` | 18K | `discuss/shell/session-store.ts` (persistence glue) + `discuss/shell/live-registry.ts` (attached-session + watch buffers). |

**Principle**: any §10 file name that would exceed 500 lines in reality decomposes to sub-files named by the responsibility it carries. No "utils.ts" or "helpers.ts" fallbacks — every split must be a named responsibility.

### 10.2 Layering invariants

1. `src/runtime/*` and `src/infra/*` import nothing from domains, transport, coordinator, or cli.
2. Domain contract modules (`jobs/events.ts`, `sessions/events.ts`, `providers/contract.ts`, etc.) import only `infra/*`, `runtime/*`, and each other explicitly.
3. Domain `X/shell/*` may import `X/*` (its own contracts) but not `Y/shell/*` (sibling shells).
4. `src/transport/*` imports domain contracts only, never domain shells or coordinator.
5. `src/coordinator/*` is the only layer allowed to import broadly across domains.
6. `src/testing/*` is never imported by production files.
7. No generic filenames (`utils.ts`, `types.ts`, `schemas.ts`) at the top of any domain — force ownership.

### 10.3 Type ownership principles

These principles prevent `shared/` re-emergence without introducing a central registry or CI gate. Enforcement is the architecture-boundary test plus TypeScript's own import graph.

1. Every exported type is declared in exactly one file. No re-declaration, no sibling duplication.
2. A type belongs to its **owning domain** — the domain whose semantics the type encodes. Other domains reference it by import, never redefine it.
3. When a concept genuinely spans two domains, it belongs in the lower domain on the import DAG. If no domain is clearly lower, split the concept.
4. `infra/*` owns only utility types (paths, errors, ids). Domain types never live there.
5. `runtime/*` owns only port interfaces. Concrete implementations do not add to this layer.
6. The only cross-cutting union type is `CauseRef` (`{stream, seq}`), declared in `src/jobs/outcome.ts` alongside `TerminalOutcome`. All other fault information lives on domain events — there is no central fault union.

The architecture-boundary test verifies: (a) no type declared in two places, (b) no `utils.ts`/`types.ts`/`schemas.ts` at domain roots, (c) layer import rules (§10.2) hold. That is the whole enforcement surface — no normative registry, no CI gate on a map.

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

### 11.3 HTTP is a gateway

`http://127.0.0.1:<port>` is not the architectural boundary — it is a *carriage* for coordinator RPC. IPC and HTTP share identical command semantics; only wire format differs. Local security is filesystem ownership on the socket; HTTP auth applies to network gateways.

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
- Journal substrate (`store.db`) holds the `corpus_state` row (current `contentSeq` / `metadataSeq`) and `equipment_cursors` for Corpus consumers.

Neither alone is sufficient: the filesystem cannot tell us what version consumers have processed, and the SQLite tables cannot reconstitute Corpus content. Coral's full recovery requires both present. This is an honest consequence of SQLite being the substrate for Corpus-related metadata even though the Corpus authority itself is the filesystem.

**Step 1: Corpus rescan**

On coordinator startup (or explicit `kb reindex`):
1. Enumerate all entries under `~/.coral/kb/{notes,sources,principles,communities}/`.
2. For each entry, compute current `content_hash` and capture frontmatter.
3. Compare to `projection_kb.content_seq` state in SQLite.
4. If drift detected, bump `corpus_state.content_seq` / `metadata_seq`.

**Step 2: Projection rebuild (per-Corpus-consumer)**

Each Corpus consumer (Orama, needle) maintains a cursor in `equipment_cursors` (`authority = 'corpus'`). On startup:
- Consumer compares its cursor to current `contentSeq`.
- If behind, triggers snapshot-based diff (`ensureVectorIndex` pattern):
  - Capture text snapshot under mutation lock.
  - Build desired manifest (content hashes per entry).
  - Diff against consumer's last manifest (persisted alongside consumer storage).
  - Re-embed / re-index only changed entries.
  - Atomic snapshot swap.

The Corpus recovery model is **intrinsically idempotent**: rescanning a clean Corpus produces no changes; rescanning after external edits produces exactly the drift set. If SQLite's `corpus_state` or `equipment_cursors` are missing/reset, recovery treats the Corpus as fully new (full rebuild). Never wrong, occasionally expensive.

### 12.3 External mutation absorption

Obsidian edits, `git pull`, or direct filesystem changes are the **normal** path for knowledge editing. The coordinator does NOT own them; the filesystem + git own them. Coral observes and re-indexes:

- **Startup scan**: coordinator boot compares filesystem to `projection_kb` and bumps `contentSeq` for any drift; CorpusConsumers (Orama, needle) catch up via manifest diff.
- **Periodic rescan**: ongoing scheduled task absorbs changes between boots.
- **git-sync auto-commit**: after coordinator-mediated mutations (e.g., `kb promote`), git-sync debounces and commits the markdown changes. External edits made via Obsidian remain visible in the git working tree; the user's normal git workflow (or `kb` commands that trigger auto-commit) brings them into history.

External edits never synthesize backfilled Journal events. They are first-class Corpus mutations observable via version counters. Entity re-extraction (curate's community/principle/graph update) is **independent** of edit detection — curate runs on its own scheduler against the current Corpus state; external edits affect what the next curate pass sees but do not themselves trigger curate.

### 12.4 Simulation

`SimulationRuntime` is an alternative `Runtime` implementation that reproduces the entire system deterministically. The 6 ports (`time`, `ids`, `storage`, `process`, `paths`, `env`) are the injection surface; every byte of behavior traces to either port input or injected events/corpus state. Repeated runs with identical inputs produce byte-identical journal segments, projections, and exports.

#### 12.4.1 Coverage

| Subsystem | Input | Verification |
|---|---|---|
| Jobs | `job.launch.requested` + scripted provider bodies | `JobView` at each `seq` |
| Sessions | `session.opened` + `session.continuity.checkpointed` | `SessionView` resumability + ref |
| Discuss | Discuss event sequence | `DiscussView` round/turn/outcome |
| KB (Corpus) | Simulated markdown filesystem + scripted rescan drift | `projection_kb` + Orama index consistency via CorpusConsumer drain |
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

`simulation/recording.ts` captures Journal event traces and Corpus snapshot states. A recorded run replays byte-identical across both authorities. Cross-authority scenarios — a discuss synthesis that references a KB entry, a workflow that promotes a memo, abort-during-app-server-turn that interrupts a KB operation — all expressible as a combination of injected Journal events and injected Corpus state snapshots.

---

## 13. Worked Example: `[A] | [B, C]` where `C` fails

### 13.1 Events

All events for this workflow land in the SQLite `events` table. Transactions group causally-related appends.

**Transaction 1** — workflow plan declared + workflow job launched:
```
seq=41  workflow/wf-1   workflow.plan.declared   plan: { slots: [
                                                   {slotId:'sl-0-0', deps:[],     provider:'codex', instruction:'A'},
                                                   {slotId:'sl-1-0', deps:['sl-0-0'], provider:'codex', instruction:'B'},
                                                   {slotId:'sl-1-1', deps:['sl-0-0'], provider:'codex', instruction:'C'},
                                                 ], labels: { 'sl-0-0':'A', 'sl-1-0':'B', 'sl-1-1':'C' } }
seq=42  job/wf-1        job.launch.requested     refs.workflowId=wf-1
seq=43  job/wf-1        job.queue.admitted
seq=44  job/wf-1        job.runtime.started
```

**Transaction 2** — slot A launched and completed:
```
seq=45  job/a-1  job.launch.requested   refs.parentJobId=wf-1, refs.workflowId=wf-1, refs.workflowSlotId=sl-0-0
seq=46  job/a-1  job.queue.admitted
seq=47  job/a-1  job.runtime.started
seq=48  job/a-1  job.terminal.recorded  outcome={kind:'completed'}
```

**Transaction 3** — slots B and C launched:
```
seq=49  job/b-1  job.launch.requested   refs.parentJobId=wf-1, refs.workflowId=wf-1, refs.workflowSlotId=sl-1-0
seq=50  job/c-1  job.launch.requested   refs.parentJobId=wf-1, refs.workflowId=wf-1, refs.workflowSlotId=sl-1-1
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
parentJobId: null
workflowId: null
workflowSlotId: null
lastSeq: 58
```

`WorkflowView(wf-1)` at `seq=58`:
```
plan: { slots: [sl-0-0, sl-1-0, sl-1-1], labels: {...} }
slotOutcomes: {
  'sl-0-0': { jobId: 'a-1', phase: 'completed', causeRef: null },
  'sl-1-0': { jobId: 'b-1', phase: 'completed', causeRef: null },
  'sl-1-1': { jobId: 'c-1', phase: 'error',
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
  → Workflow wf-1 failed (slot "C" sl-1-1)
    → Job c-1 exited with code 1

  ✓ A  sl-0-0 completed
  ✓ B  sl-1-0 completed
  ✗ C  sl-1-1 provider_exit 1
```

Traversal:
1. `JobView(wf-1).terminal.outcome` = `failed` with `causeRef → workflow/wf-1@57`.
2. Event at `workflow/wf-1@57` is `workflow.completed { outcome:'failed', causeRef → job/c-1@56 }`.
3. Event at `job/c-1@56` is `job.terminal.recorded { outcome: provider_exit(1) }`.
4. Chain terminates at a non-`failed` outcome; render the chain.
5. Slot labels (`"A"`, `"B"`, `"C"`) come from the `WorkflowView(wf-1).plan.labels` projection, keyed by `slotId`.
6. Nothing on the causal chain carried labels or step/atom indices — those live on the plan.

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
| `src/execution/` | `coordinator/` + `jobs/` + `sessions/` + `transport/` + `simulation/` |
| `src/shared/` | Every file relocates to a domain or `infra/` or `testing/` |
| `src/client/` | `store/queries/` + `transport/ipc/client.ts` + `transport/http/client.ts` |
| `src/bridge/` transport | `transport/` |
| `status.json`, `launch.json`, `runtime.json`, `exit.json`, `progress.jsonl` | SQLite `events` + `projection_*` tables |
| Custom segment rotation, checkpoint files, advisory lockfile | SQLite WAL + `BEGIN IMMEDIATE` transactions |
| `result.md` (authority) | `~/.coral/exports/jobs/<id>/result.md` (materialized view) |
| `TerminalResult` (single struct) | `JobTerminal` + `JobDiagnostics` + `JobView` (three concerns) |
| `TerminalResult.exitCode` | `outcome.provider_exit.code` |
| `TerminalResult.nonResumable` | `SessionView.resumable` |
| `TerminalResult.warnings`, `usage` | `JobDiagnostics` |
| `TerminalResult.workflow` | `WorkflowView.slotOutcomes` (plan + children join) |
| `workflow_atom_failed` with `step`/`atom` labels | `failed { causeRef }` + plan-owned labels via `slotId` |
| Multi-variant `CoralFault` union across domains | Three-variant `JobLifecycleFault` + `causeRef` pointers to domain events |
| `composition.childJobIds` on parent | SQL query on `projection_jobs WHERE parent_job_id = ?` |
| `SessionContinuityPatch` | Full `session.continuity.checkpointed` snapshot event |
| `WaitCursor.jobs[jobId → eventId]` | `WaitCursor { afterSeq }` |
| `recovery-core.ts` classifier (10+ rows) | Projection rebuild + reconciliation appends |
| `event-bus.ts` + durable progress log + wait replay cursor | SQLite `events` table + `afterSeq` SELECT |
| `execution/kb-tools.ts`, `execution/discuss-tools.ts` (HTTP-layer handlers) | `transport/http/kb-routes.ts`, `transport/http/discuss-routes.ts` thin routers + calls into `kb/ops/` and `discuss/shell/` |
| `execution/discuss/persistence.ts` + `session-store.ts` | `discuss/shell/persistence.ts` + `discuss/shell/session-store.ts` + `discuss/shell/live-registry.ts` (decomposed per §10.1a) |
| `curate-state.json` | `curate_scheduler` + `curate_retry_queue` SQLite tables (§3.1) |
| `ensureBackend()` HTTP-first | Command-class routing (library-direct for reads, IPC for live) |
| `WorkflowCheckpoint` file | `workflow.plan.declared` event on `workflow/<id>` stream |
| `--local` flag | Semantic command-class routing |
| `WorkflowRef { stepIndex, atomIndex, label }` on launches | `refs.workflowSlotId` → plan lookup for labels |
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
- `~/.coral/store/writer.lock` is a single filesystem advisory lock. Two backend instances cannot both hold it; the second one blocks or fails fast.
- Backend identity is not tied to the bundle path. It is tied to the journal directory and its lock. Reinstalling the bundle does not create a new "instance" — only one coordinator exists per store, regardless of which bundle path spawned it.
- Recovery = pure `replay()` over the single global journal. There is no "other backend's jobs" category to adopt — there is only the journal.
- Reconciliation compares projected running state to the process table and appends new facts (e.g., `wrapper_lost`) when reality disagrees. No classifier over file-presence matrices.
- If the bundle-swap handoff is desired (old coordinator shuts down, new one takes over), the sequence is: old coordinator closes → releases `writer.lock` → new coordinator acquires lock → replays journal → reconciles against process table. Jobs never become invisible.

Tag for future reference: resolves during step 5 of derivation order (see §15) when `jobs/reconcile/` replaces the current lifecycle classifier.

### 14.3 What survives unchanged (in concept; location may move)

- The 6-subport `Runtime` abstraction (simulation substrate).
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
- `hooks/post-compact.mjs` reads `<JOBS_DIR>/<jobId>/result.md` and parses `<JOBS_DIR>/<jobId>/status.json`. Both paths change: `result.md` moves to `~/.coral/exports/jobs/<jobId>/result.md`, `status.json` disappears entirely (replaced by `events` + `projection_jobs`).
- `hooks/pre-compact.mjs` similarly parses `status.json`.
- `hooks/cli-resolve.mjs` rewrites bare `coral-cli` invocations. CLI bundle path is unaffected; the rewrite regex stays valid.

Mitigation: update these hooks alongside the source rewrite. They are part of the plugin artifact; a first deploy includes updated hooks matching updated paths.

**Skill contracts** (CLI output formats currently parsed by `skills/*/SKILL.md`):
- Every skill parses the launch text: `Job <jobId> <launchState> (session <sessionId>)`.
- Every skill parses wait output: `Result path: <path>`.
- `skills/equip/SKILL.md` parses `install.mjs` JSON output status codes.

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
4. **The only B-specific artifacts** are `JobTerminal` / `JobDiagnostics` / `JobView` type shapes and the reducer that builds children from child launch events. Both are consumed together with the journal substrate and domain migrations; neither needs a standalone step.

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
19. Base KB read models (`projection_kb`, Orama) update synchronously under the Corpus mutation lock for coordinator-owned mutations.
20. External Corpus edits (Obsidian, git pull, direct filesystem) are first-class; scans/rebuilds absorb them without backfilling synthetic events.
21. Corpus recovery = rescan + index rebuild (no history to replay).
22. Cross-authority references use `KbRef = { entryId, contentHash? }`. `contentHash` is optional, captured at write time when point-in-time semantics matter.

**Coordinator & transport**:
23. Local read-only CLI commands do not require a coordinator (SQLite readers use separate DB handles; Corpus reads are direct filesystem).
24. Local mutating or live CLI commands always go through the coordinator (IPC or HTTP gateway).
25. IPC and HTTP share identical coordinator RPC semantics; only wire format differs.
26. Operational facts (index rebuilds, WAL checkpoints, snapshot rotations) are NOT domain events or Corpus mutations; they are logs.

**Layering**:
27. `src/runtime/*` and `src/infra/*` import nothing from domains, transport, coordinator, or cli.
28. `src/transport/*` imports domain contracts only, never domain shells or coordinator.
29. `src/coordinator/*` is the only layer allowed broad cross-domain imports.
30. `src/testing/*` is never imported by production files.
31. No generic filenames (`utils.ts`, `types.ts`, `schemas.ts`) at any domain root — ownership must be explicit.

**Equipment**:
32. Equipment never writes to any authority. Equipment adds or replaces projection backends only.
33. Every equipped projection is rebuildable from the authority of the domain it serves (Journal events OR Corpus contents).
34. The base tier is **fully functional** after plugin install for all zero-config commands. Commands that intrinsically need external resources (vector search needs an embedding provider) declare their one-line setup in README. Every CLI command available in equipped tier is also available in base tier — at potentially lower quality but never unavailable; missing prerequisites surface as structured errors with setup guidance, not silent failure.
35. Equipment **replaces specific query paths** with higher-quality implementations. It never adds new command surfaces.
36. Unequipping returns the replaced path to the base backend without data loss and without command availability changes.
37. Equipment loads via dynamic import; its heavy dependencies enter the process only after `/equip` completes.
38. Equipment is **never prompted or nagged**. Base-tier commands never surface "equip X to unlock" hints. Discovery is curiosity-driven (`/equip --list`, docs), not system-driven.
39. Equipment catalog entries are **tool-named** (`needle`), not capability-named (`kb`).
40. Equipment projections are maintained by registered consumers with durable cursors in `equipment_cursors`. Journal consumers use range-based replay; Corpus consumers use snapshot-based content-hash diff. Updates flow via in-process async push (`ConsumerDriver.notify(authority, version)` after authoritative write).
41. Equipment freshness is eventually consistent relative to base projections. Strict-freshness reads use `waitFreshUntil(version, consumerId)` — a condition-variable wake, never a polling loop.
42. Equipment failure never blocks coordinator writes. A failed `apply()` retains the last-successful cursor; next `notify` or startup recovery retries the gap.
43. Each query path has **at most one active equipment**. Attempting `/equip X` for a path already owned by equipment Y fails with an explicit error instructing the user to `/unequip Y` first.
44. Consumer `apply(signal)` must be **idempotent**. The cursor advances only after `apply()` resolves successfully; a crash between apply and cursor persistence causes the same range to be re-applied on startup. Consumer implementations must tolerate this (`upsert` semantics, not `insert`).

---

## 17. Glossary

- **Coordinator**: the single-writer daemon. Mediates writes to both authorities (Journal + Corpus), owns live state (admission, host pool, subscriptions), and is the only layer that opens writable handles.
- **Journal authority**: the `events` table inside `~/.coral/data/store/store.db`. The authoritative source for process-like domains (`job`, `session`, `discuss`, `workflow`). Append-only; truth is the ordered history of events.
- **Corpus authority**: the markdown filesystem at `~/.coral/kb/` (git-tracked). The authoritative source for knowledge content (notes, sources, principles, communities, entity graph). Truth is the current file contents; no event history.
- **Journal substrate**: SQLite database (`store.db`) — holds the events table, base projection tables, and `equipment_cursors`. Not a "global store"; it is the substrate for Journal authority only.
- **Corpus substrate**: filesystem directory tree under `~/.coral/kb/`. Git-tracked; Obsidian-editable.
- **Store**: the single SQLite database at `~/.coral/data/store/store.db`. Holds events + projections for Journal domains. KB indexes are projections too but live at `~/.coral/data/kb/` (device-local) since they derive from Corpus, not Journal.
- **Events table**: append-only SQL table keyed by `seq` (auto-increment). The only durable truth.
- **Projection tables**: SQL read models (`projection_jobs`, `projection_sessions`, `projection_workflows`, etc.) maintained incrementally by event reducers in the same transaction that appends events.
- **CoralStore**: unified read API covering **both authorities**. Journal reads go to SQLite (`events` + `projection_*` tables); Corpus reads go to the filesystem (`~/.coral/kb/`) with `projection_kb` providing metadata lookup. Consumers call `store.jobs.get(id)` or `store.kb.read(slug)` without knowing which authority backs the query. Internally decomposed into `store/queries/{jobs,sessions,discuss,workflow,kb}.ts`. Multiple read handles can coexist; single writer (coordinator) owns mutations.
- **CoralCoordinator**: the single-writer daemon. Owns live state (admission, host pool, subscriptions) and is the only layer that opens a writable DB handle.
- **Stream**: a logical sub-sequence of the events table identified by `(stream_kind, stream_id)` — e.g., `job/wf-1`, `session/s-42`, `workflow/wf-1`. Ordering is global via `seq`.
- **Envelope**: the event header — `seq`, `ts`, `type`, `stream`, `namespace`, `refs`, `correlationId`, `causationSeq`, `bodyVersion`. Wraps a `body`.
- **Body**: the domain-owned payload. Validated by the domain's Zod schema at the current `bodyVersion` (with upcaster chain for older versions).
- **bodyVersion**: per-event-type schema version. Each event type starts at 1; bumps require registering an upcaster.
- **Upcaster**: pure function that lifts an older-version body into the current shape at read time. Old events are never rewritten.
- **CauseRef**: `{ stream: {kind,id}, seq }`. A pointer to the event that caused this outcome. Used by `TerminalOutcome.failed` and `workflow.completed`.
- **Projection rebuild**: `DROP` + repopulate `projection_*` tables from the events table. Pure, deterministic, bounded by events count.
- **Reconciliation**: imperative post-startup phase that compares projected state to observed world (processes, DB state) and appends new events when they disagree.
- **Export**: a materialized file outside the database (`result.md`, KB markdown). Rebuildable from events.
- **JobView**: the projected read shape for a job — phase, terminal, diagnostics, parentJobId, workflowId, workflowSlotId, lastSeq. Children derived by SQL query, not embedded.
- **WorkflowView**: the projected read shape for a workflow — plan, slot outcomes, overall outcome, causeRef, lastSeq.
- **WorkflowPlan**: `{ slots: WorkflowSlot[], labels: Record<slotId, label> }`. Declared once per workflow via `workflow.plan.declared`.
- **WorkflowSlot**: `{ slotId, dependencies, provider, instruction, agent? }`. The durable unit of work composition.
- **WaitCursor**: `{ afterSeq }`. A single global position for subscribers.
- **TerminalOutcome**: 5-variant union — `completed | aborted | provider_exit | failed{causeRef} | job_fault{JobLifecycleFault}`.
- **JobLifecycleFault**: 3-variant union — `ghost_launch | wrapper_lost | wrapper_crashed`. The only fault ADT in the system; all other failures are domain events referenced via `causeRef`.
- **Middleware**: `(next: Provider) => Provider`. Composable layer around a provider kernel.
- **Provider kernel**: the leaf `Provider` function for a specific CLI/app-server — the pure execution unit.
- **Host pool**: coordinator-owned pool of long-running app-server subprocesses (Claude, Codex).
- **Namespace**: caller/emitter identity on an event. Not the same as `stream.kind`.
- **Equipment**: an opt-in runtime enhancement. Installs dependencies, subscribes to events, maintains a replacement projection backend for a specific query path. Never writes events.
- **Base tier**: the default runtime after plugin install (~3MB bundle, no native deps). Zero-config surface works immediately; vector search additionally needs a one-line embedding provider setup per README (Google Gemini API key default).
- **Equipped tier**: one or more equipments active. Same commands, sharper implementations.
- **Equipment metaphor (Zelda UX)**: curiosity-driven discovery, never enforced. Base tier always works; equipping is a reward for looking, not a gate to close. Equipment sharpens existing capabilities, never unlocks new commands.
- **`/equip <name>`**: slash command that installs and activates an equipment. `/unequip <name>` deactivates and removes.
- **Orama**: base-tier KB search engine. Provides FTS (BM25) and vector search (cosine brute-force). Pure JS, always present. Vector path requires embedding provider config.
- **coral-needle**: first equipment. C++ N-API addon at `../coral-needle` providing DuckDB-backed ScanANN vector search (exact / USearch HNSW / ScaNN tree-AH, auto-selected). Replaces Orama's vector path when equipped; FTS stays with Orama. Distributed as prebuilt binaries via GitHub Releases.
- **SearchBackend**: interface at `src/kb/search/contract.ts` that both Orama and needle implement. `router.ts` picks the active backend per query type based on equipment state.
- **ConsumerDriver**: in-process driver that turns `notify(authority, version)` signals into `apply(signal)` calls for a registered consumer (Journal or Corpus). Single-in-flight guarantee (backpressure-safe), cursor persistence after success, condition-variable wake for `waitFreshUntil`. Lives at `src/coordinator/consumer-driver.ts`.
- **`waitFreshUntil(seq, consumerId)`**: blocks until the named consumer's cursor reaches `seq`. Implemented as condition-variable wake, not polling. Used by strict-freshness reads; rarely needed.
- **`equipment_cursors`**: SQLite table that persists each consumer's cursor (per authority). Source of truth for "where is each equipment projection caught up to".
- **JournalConsumer**: projection consumer subscribing to Journal authority. Range-based: `apply({ upToSeq })` reads events from `seq > cursor AND seq <= upToSeq` and applies them in order.
- **CorpusConsumer**: projection consumer subscribing to Corpus authority. Snapshot-based: `apply({ contentSeq, metadataSeq })` captures a corpus snapshot, diffs content hashes against its last manifest, applies only changes. **Reuses the manifest-diff + atomic-snapshot-swap logic from today's `ensureVectorIndex`, but inverts the invocation model** — today pull-driven (called lazily before search), tomorrow push-driven (driven by ConsumerDriver after Corpus writes). The diff half is a port; the trigger half is a rewrite.
- **KbRef**: `{ entryId, contentHash? }`. Cross-authority reference shape for Journal events pointing at Corpus entries. `entryId` alone = late-bound (resolves to current content); with `contentHash` = point-in-time (preserves historical meaning across subsequent Corpus edits).
- **Corpus mutation lock**: single-writer lock around the Corpus authority. Coordinator-mediated CLI writes acquire it; base KB indexes (e.g., Orama) update synchronously inside the lock.
- **contentSeq / metadataSeq**: monotonic version counters for the Corpus authority. Two lanes because content and metadata changes have different freshness semantics. Analogous to `events.seq` on the Journal side, but versioning the whole corpus rather than counting discrete events.

---

## 18. Verdict

Six pioneers + All-6 unifier + B-v2 reëxamination + Pioneer-final + KB-pioneer converge on one form: **One coordinator, two authorities.** Every piece is load-bearing:

- **Journal authority** (SQLite `events` table) is truth for process-like domains: `job`, `session`, `discuss`, `workflow`. ACID transactions + range replay.
- **Corpus authority** (markdown filesystem at `~/.coral/kb/`, git-tracked) is truth for knowledge content: `kb`. Atomic rename + content-hash diff.
- **CoralCoordinator** is the single writer across both authorities — not for gatekeeping but because live-state ownership (admission, host pool, subscriptions) naturally pools there.
- **Cross-authority references** use `KbRef = { entryId, contentHash? }` — the only admitted asymmetry, honest about Corpus mutability.
- **Canonical event bodies** are the provider contract for Journal writes.
- **WorkflowPlan on `workflow/<id>`** is the durable composition aggregate. Child launches reference slots by `slotId`; labels live on the plan.
- **Causal graph** (CauseRef pointers) is the fault model within Journal. Failures live once on the originating stream; terminals dereference, never wrap.
- **Three-variant `JobLifecycleFault`** is the only fault ADT — reserved for wrapper-local failures with no domain origin.
- **Two consumer interfaces** match the two authorities: `JournalConsumer` (range replay) + `CorpusConsumer` (snapshot content-hash diff). Both share `ConsumerDriver` mechanics (cursor, idempotent apply, condition-var wake).
- **Zelda-style equipment model**: base tier always functional (FTS zero-config, vector with one-line embedding setup); `/equip needle` sharpens the vector path for scale without adding commands. Curiosity-driven, never prompted.
- **Command-class routing** replaces transport-topology assumptions.
- **Journal recovery** = projection rebuild + reconciliation. **Corpus recovery** = rescan + per-consumer snapshot diff. Each authority recovers from its own truth.
- **Schema evolution** via per-`type` `bodyVersion` + upcasters (Journal) or SQL migrations (projection tables); Corpus evolves through markdown format changes that the frontmatter parser accommodates.

The two-authority model is not an asymmetry to apologize for — it is Coral's **duality**. Process-like state lives on time (Journal). Knowledge-like state lives in space (Corpus). Forcing one substrate on both would distort one; naming them separately reveals the structure honestly.

Five elegance axes hold (inevitable / self-evident / essential / natural / resonant) with zero cost-axis residue. Adversarial review rounds have converged; the design now resists further sharpening without violating one of the axes.

This document is the sole design reference for any `/coral:plan` session implementing this architecture.

---

## Amendments

Tracked deviations from the original design adopted during implementation. Each entry names the change, the phase that adopted it, and the binding rationale.

- **`coordinator/info.ts` → `coordinator/discovery.ts`** (Phase 3, tag `phase-3-complete`). The original §10 topology named this module `info.ts` with the comment "coordinator discovery record I/O". Phase 3 implementation renamed it to `discovery.ts` so the filename matches the responsibility, satisfying invariant #31 (no generic filenames at any domain root) and the §10.3 type-ownership / intent-revealing principle. Same reasoning that drove the Phase 2 `src/sessions/entry.ts` decision over the implementation-plan's `types.ts`. Responsibility is unchanged: read/write `~/.coral/run{,-dev}/coordinator.json` plus the process-identity probe.
- **`coordinator/bootstrap.ts` introduced as the main-process entry sibling of `coordinator.ts`** (Phase 3). The original §10 topology folded main-process startup, argv parsing, and `--smoke-open-store` into `coordinator.ts`. Phase 3 split these into a separate `bootstrap.ts` so `coordinator.ts` stays a pure composition root invokable from tests without argv plumbing. `bootstrap.ts` is the bundle entrypoint targeted by `scripts/build-server.mjs` and `scripts/verify-native-binding.sh`.
