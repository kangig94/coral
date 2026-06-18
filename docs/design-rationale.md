# Design Rationale

This document captures the **why** behind Coral's architecture: the choices that shape `src/` and the rules in `.claude/rules/design-philosophy.md`. `docs/architecture.md` describes **what** the system is; this file explains **why it is that shape and not another**.

The intended audience is a contributor (or LLM) who already knows the codebase and is about to make a non-trivial change — e.g., adding a domain, splitting an authority, or changing a fault payload — and needs to know which load-bearing assumptions a refactor must preserve.

## 1. One Coordinator, Two Authorities

Coral has **two distinct truths**, not one. Forcing a single substrate on both would distort one of them.

### 1.1 Why a Journal for process-like domains

Jobs, sessions, discussions, and workflows are **temporal**: they have a beginning, unfold in ordered steps, and terminate. The ordered event history *is* the story; replay reconstructs any projection at any past `seq`. Causal references (`causeRef = { stream, seq }`) and cross-stream atomicity fall out naturally from a single global ordering.

Global ordering is cheap: SQLite ROWID is monotonic per database, so every event has a universally comparable `seq`. Cross-log ordering would be expensive — one journal avoids that cost.

### 1.2 Why a Corpus for knowledge-like domains

KB notes, sources, principles, communities, and wiki entries are **spatial**: they accumulate, get edited, reference each other. What matters is the current state, not the sequence of edits. Obsidian-as-editor reinforces this — users edit markdown files directly; the filesystem *is* the truth they see and manipulate. Wiki entries push this further with a strict 2-section body (`## Understanding` rewritable summary, `## Knowledge` self-organizing list of `[[wikilinks]]` where each link owns its own evidence timeline as nested sub-bullets) — link removal physically removes the evidence with it, so no separate sync layer is needed.

Event-sourcing the KB would force bi-directional sync: external edits → synthetic events → reconstructed markdown, with conflict resolution for Obsidian-vs-coordinator races. The filesystem already offers atomic rename; git already provides sync. Reinventing these inside a journal adds complexity without elegance gain.

The same principle applies to Corpus derivatives, not just authored markdown. Expensive LLM derivatives carry their input provenance in the tracked file that owns them: note/source classification writes `inputFingerprint` and peers compare it to the indexed body hash; community summaries write `summaryInputFingerprint`, which a peer recomputes from the community's current input documents and skips the LLM summary when it matches. Token savings and conflict avoidance are one mechanism: sync the derivative with the input it summarizes so another full curator can skip the LLM without asking a leader.

Derivative conflicts are made impossible where the format allows it, not resolved after the fact. The entity graph merge driver canonical-sorts `ours ∪ theirs` and runs `consolidateEntityGraph` to an idempotent fixpoint; the markdown merge driver unions frontmatter set fields (`tags`, `principles`, `related`) and leaves only genuine same-region body prose edits to `git merge-file`. There is no LLM conflict resolver here — the most elegant form of resolve-this-conflict is the conflict cannot exist.

### 1.3 Why one coordinator over two authorities

Single-writer discipline eliminates distributed-consensus machinery. The coordinator:

- Appends events to the Journal (SQLite `BEGIN IMMEDIATE`).
- Mutates the Corpus atomically via `writeFileAtomic` under a per-Corpus mutation lock.
- Owns live state (admission, host pool, subscriptions) that spans both authorities.

The daemon's existence is justified by **live-state ownership**, not by gatekeeping reads — read-only paths access either authority without invoking the coordinator. Library-direct readers open SQLite read-only and read Corpus filesystem directly.

### 1.4 Why no cross-authority references

Journal events do not embed Corpus entries via a typed pointer. The two authorities are independent: process-like state (Journal) does not reference knowledge-like state (Corpus), and the recovery paths of each authority do not consume the other's events as input.

KB has its own retry/rebuild surface (`kb_curate_retry_queue`, Corpus rescan, authority baseline rebuild). Job lifecycle records the *fact* of a hosted KB attempt and its failure on the hosting `job/<id>` stream, but the slug/identity of the targeted KB entry is the caller's input and is not re-persisted into the Journal envelope.

If a future surface ("cited evidence" UI, forensic listener) needs cross-authority references, that surface introduces the shape together with its consumer. The architecture does not pre-declare a placeholder.

## 2. Causal-graph Faults vs Composable Union

An earlier design considered a "composable `CoralFault` union" — each domain contributes variants, and the job terminal wraps them. That design's costs:

1. **Duplication**: the fault's payload would appear twice — once as the domain event, once wrapped in `CoralFault`. Every field on the domain event would be mirrored on the union variant.
2. **Synchronization burden**: adding a field on a domain fault event would require updating the union variant and its describer. Two places to touch per evolution.
3. **TypeScript coupling**: the top-level union would import from every domain, creating a central coupling point readers had to chase.
4. **Loss of atomicity**: even with the union, nothing would tie the domain event and the job terminal into one commit — partial truth was possible.

The causal-graph model solves all four:

1. **Single source**: the fault lives once on the originating stream.
2. **No sync burden**: evolving the domain event requires zero changes at the job level.
3. **No central union**: the job terminal references by `CauseRef = { stream, seq }`.
4. **Atomic by construction**: every event in a causal chain lands in one SQL transaction.

The only price: CLI renderers dereference `causeRef` at read time. This is modest; projections may denormalize the first hop later if rendering latency becomes load-bearing, but the authoritative data stays single-sourced.

`JobLifecycleFault` is the one remaining typed ADT — reserved for wrapper-local failures with no originating domain event (`wrapper_lost`, `wrapper_crashed`, `ghost_launch`).

## 3. Provider Streams over Provider Servers

The pre-rewrite shape had competing implementations of "provider call": direct exec adapters, session drivers, and app-server runners. Current provider calls are composed from three orthogonal concerns:

- pure execution
- session continuity tracking
- provider-server lifecycle

A stream + middleware lets each concern be named once and composed:

```ts
const claudeSessionProvider = compose(
  sessionContinuity('claude', claudeBrokerContinuity),
  appServerSession(claudeAppServerContract),
  claudeSessionKernel,
);
```

For provider-server-backed providers, `sessionContinuity` is the **outermost** middleware so that a single continuity authority observes the full downstream stream — including transport-close events from `appServerSession` via `runtime.continuityBridge`. `appServerSession` surfaces typed close-state through the bridge but never emits `continuity` itself and never rewrites downstream terminal outcome.

Claude is one of these provider-server-backed providers. The broker helper is intentionally PTY-based: it starts interactive `claude`, waits for terminal readiness before writing the first turn, and reads Claude JSONL transcripts for completion. This keeps Coral aligned with terminal Claude behavior as it diverges from `claude -p`.

Adding a new provider is declaring its middleware stack. Provider implementations stay pure: they emit bodies only. The coordinator wraps each body in an envelope (`seq`, `ts`, `stream`, `refs`) and appends to the Journal. Providers never touch envelopes, seqs, or the Journal directly.

## 4. Two Consumer Interfaces

Journal and Corpus consumers are deliberately split:

- **Journal consumers** advance against a single `events.seq` axis. Two flavors:
  - *Cursor-only* base projections (jobs/sessions/discuss/workflows): rows are written by the commit-time reducer inside the same `BEGIN IMMEDIATE` that appends the events; the driver only advances the durable cursor on `notify`.
  - *Apply-kind* expansion-tier consumers: range-based replay through `apply({ upToSeq, signal })`.
- **Corpus consumers** advance against `(contentSeq, metadataSeq)` pairs. Snapshot-based content-hash diff through `apply({ snapshot, journalReader, corpusStateReader, projectionInput, signal })`.

A unified interface would have to embed both shapes; one would always be a no-op for half the consumers. Splitting the interface reflects the different freshness mechanics directly.

`ConsumerDriver` owns both flows: it receives `notify(authority, version)` after authoritative writes and exposes `waitFreshUntil(authority, version, consumerId)` as a condition-variable wake (not polling). For cursor-only registrations, the driver advances the cursor and resolves waiters directly. For apply-kind registrations, the driver drains in a single-in-flight microtask and persists the cursor only after `apply()` returns cleanly — so apply-kind `apply()` must be **idempotent** (a crash between apply and cursor persistence re-applies the same range on next start).

## 5. Single Runtime World

Backend I/O flows through Runtime ports selected at composition. Domains and coordinator services receive `time`, `storage`, `paths`, `process`, `ids`, `env` through ports rather than reading ambient state.

### 5.1 Why flavor is input, not ambient

The build flavor (`prod` / `dev`) is resolved once at the bootstrap edge from `CORAL_FLAVOR` or the bundle manifest, then **passed as an argument** to `createRealRuntime(flavor)`. The runtime's `paths.coral` exposes the resolved path families. Domains and coordinator services consume paths through this port.

There is no `setBuildFlavor`, no `currentBuildFlavor` global, no lazy port construction guarded by `E_FLAVOR_NOT_SETTLED`. A process-wide singleton would force lazy port resolution, which would force defensive `try/catch` fallbacks at every consumer, which would invite parallel access paths (factory + port) that drift apart. Threading flavor as input collapses all of that.

Module-level helpers like `composeCoralPaths(flavor, opts?)` exist for the bootstrap edge; downstream code reads paths from `runtime.paths.coral`, never by recomputing from a global.

### 5.2 Why eager port construction

Port objects are eager constants: `runtime.paths.coral` is composed once at `createRealRuntime(flavor, opts?)` and is referentially stable across accesses. Tests that mock `node:os.homedir()` per-test must construct the runtime *after* the mock is set; do not rely on lazy re-evaluation. Lazy ports invite "did the value change since I read it last?" bugs that don't exist if the port is materialized once.

### 5.3 Per-project data dir is a composed path family, not an ambient read

The per-project data directory is a first-class `CoralPaths` family (`runtime.paths.coral.projects`), flavor-separated like every other family (`projects` for prod, `projects-dev` for dev — enforced by `tests/invariants/flavor-path-separation.test.ts`). `runtime.paths.projectData(projectRoot)` resolves to `<coralRoot>/projects/<source-slug>` by composing the git-derived source (`projectSource`) with the composed root; the KB memo scratch tree then lives at `<projectDataDir>/memo` (the `/memo` subdir is appended by `kb/paths.ts`, not part of the `projects` family shape). KB memo ops and `promote`/`adopt` receive the already-resolved data dir; they never recompute it from a bare `coralRoot()`.

This closed a real gap: the dir was previously computed ad-hoc by a `projectDataDir(projectRoot)` helper co-located with source resolution (since removed from `infra/project-source.ts`, which now owns *only* `resolveProjectSource`), built from a bare `coralRoot()` (ambient `homedir()`) that bypassed the runtime port. That made it impossible to isolate in tests without mocking `node:os` — any test exercising memo paths leaked empty `~/.coral/projects/*` dirs into the developer's real home. Tests now isolate the whole tree via `createRealRuntime(flavor, { baseDir })` or `SimulationRuntime { roots.coralRoot }`; `vitest/no-real-coral-leak.ts` (a vitest `globalSetup` wired into the default, e2e, e2e-lifecycle, and integration configs) fails the run if anything writes into the real `~/.coral/projects` or `~/.coral/projects-dev`.

### 5.4 Config-dir partitions the daemon state tree

A Claude Code plugin installs *inside* the config dir (`<CLAUDE_CONFIG_DIR>/plugins/...`), so the backend daemon binary itself differs per config dir — two config dirs are two independent daemons. The runtime resolves the config dir from `CLAUDE_CONFIG_DIR` (falling back to `~/.claude`) via `resolveClaudeConfigDir`, derives an 8-char `claudeConfigSlot`, and `composeCoralPaths` nests the daemon-owned state families (store, coordinator socket/run-dir, exports, engines, projects) under `coralStateRoot` = `<coralRoot>/by-config/<slot>/` when the slot is set. The default config dir maps to no slot, so existing installs keep their `~/.coral` paths (backward compatible). Like flavor (§5.1), the config dir is resolved once at composition and threaded as a precomputed slot — the path resolvers stay pure (no ambient reads).

Without this, two daemons (one per config dir, same flavor) bind the same `coordinator.sock` and write the same `store.db`: the socket-as-lock contention evicts one via handoff, and concurrent SQLite writers corrupt state. Partitioning by slot makes the two daemons fully isolated.

`CLAUDE_CONFIG_DIR` is the one `CLAUDE_*` var the daemon does **not** shed at startup (`shedInheritedClaudeCodeEnv`): it needs the value to resolve its `.claude` paths and slot, and forwards it to spawned `claude` children so they read the matching settings/credentials/session logs. This is safe precisely because the daemon is config-dir-isolated — every session it serves shares the one config dir. The per-session identity vars (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, …) are still shed; freezing one launcher session's identity onto every child would make each `claude` skip its own session log and hang the broker's turn detection.

The KB **markdown vault** (`corpus` family, `kbVaultRoot`) is intentionally **not** partitioned — knowledge is shared across all of a user's config dirs. Its rebuildable **runtime artifacts** (`kbRuntimeDir` — the FTS index, the wiki touch journal, source-import staging), by contrast, are daemon-owned mutable state and DO partition by slot; otherwise two config-dir daemons against the shared vault would race on the touch-journal drain and `index.json`. Hooks replicate the slot logic (`hooks/lib/hook-utils.mjs` `coralStateRoot`) because hooks cannot import `src/`; the algorithm must stay in lockstep with `claudeConfigSlot` in `infra/path/root.ts`. `tests/invariants/config-dir-separation.test.ts` guards the src side (state families + KB runtime slotted, markdown vault shared).

## 6. Curiosity-Driven Expansion (Zelda Metaphor)

Coral ships as a lightweight plugin (~3MB bundle): install gives a fully functional system for its zero-config surface (CLI, jobs, sessions, discuss, workflow, KB FTS). Features that intrinsically need external resources (vector retrieval needs an embedding engine) are documented in README with a one-line setup per feature. Users opt into heavier capabilities via the `/equip <name>` skill.

### 6.1 UX philosophy

Equipment is **curiosity-driven, never enforced**. A user scanning the CLI notices `/equip` exists, reads what's in the catalog, and picks something interesting if they want to. Nothing prompts, nags, or requires them to equip. The base tier remains fully functional forever — equipping is a **reward for curiosity**, not a completion requirement.

The metaphor: Link's base sword always works. Finding the bow is exciting because it opens new play, but Link was never broken without it. Coral's base tier always works. Finding a specialized engine is exciting because it sharpens KB search, but KB was never broken without it.

### 6.2 Engine vs Expansion

Two terms describe distinct facets, not synonyms:

- **Engine** = data/source identity, the noun: source under `src/engines/<id>/`, rebuildable local state under `~/.coral/data/engines/<id>/`.
- **Expansion** = lifecycle pattern + user verb: the coordinator invokes an `Expansion` body under a scope, and users run `coral-cli expansion equip <name>` (or the `/equip <name>` skill).

One engine ships one Expansion.

### 6.3 Expansion principles

1. An Expansion **replaces a specific projection backend**; it does not add new commands. The CLI surface is identical in both tiers.
2. An Expansion **never writes an authority**. Journal events and Corpus markdown remain truth; an Expansion maintains additional or replacement projections.
3. Every equipped projection is **rebuildable from the authority it serves**. Journal-backed Expansions replay events; Corpus-backed Expansions diff Corpus snapshots.
4. **Unequipping** returns the replaced path to the base backend without data loss and without command availability changes.
5. An Expansion loads via **dynamic import** — the heavy dependency enters the process only after `/equip` completes.
6. An Expansion is **never prompted**. Discovery is through `/equip --list` or documentation, not through nagging.

Each `RuntimeBinding<T>` accepts at most one bound value; binding occupancy is enforced inside the binding primitive, not by lifecycle bookkeeping.

## 7. Recovery Model

### 7.1 Journal recovery

Recovery = **co-transactional projection state + reconciliation**. Base journal projections are written inside the same `BEGIN IMMEDIATE` transaction that appends their source events, so a clean restart resumes from the durable projection state directly. A startup reconciliation pass re-reads any work that did not have time to terminate cleanly and appends new facts when the world disagrees with the projected state.

Replay-from-zero exists as a regression test fixture, not a production recovery path. Production never re-derives projections from events on a clean restart.

### 7.2 Corpus recovery

Recovery = **rescan + index rebuild**. There is no event history to replay; the markdown filesystem *is* the truth. Coordinator startup scans the Corpus, diffs content/metadata hashes against last-known state, and rebuilds retrieval projections via the registered CorpusConsumers.

External edits (Obsidian, git pull, direct filesystem writes) are first-class — the rescan absorbs them without backfilling synthetic events.

## 8. Transport: IPC for CLI, HTTP for Remote

Local CLI commands always go through the coordinator over **IPC** (`coordinator.sock`, authenticated). The HTTP gateway is server-side exposure for non-CLI consumers (`coral-reef`, future browser/external clients) plus the operational carveouts (`/health`, `/admin/shutdown`, `/events/stream`).

HTTP is *not* a CLI dispatch path — remote CLI dispatch is not supported.

### 8.1 Why command-class routing

`CommandClass` enumerates exactly three values: `read`, `mutate`, `subscribe`. The CLI dispatch decides per command:

- `read` (and the command does not need the coordinator) → `read-model/CoralStore` direct library reads.
- `mutate` or `subscribe` → IPC.

Command class is the routing axis, not transport-aware code paths in domain logic. IPC and HTTP share identical coordinator RPC semantics; only wire format differs.

### 8.2 Single-writer discipline

Even with two transports (IPC + HTTP), there is exactly one coordinator per Coral installation; the IPC bootstrap reconciler in `transport/ipc/ensure.ts` enforces the singleton through observation states (`absent | starting | sick | healthyCompatible | ...`) and bounded actions (`wait | requestShutdown | ensureReplacement | ...`). Sick replacement is fenced by PID + `processStartedAt` verification — unverified ownership fails closed, never force-replaces.

## 9. Naming and Subdivision Policy (full)

The `.claude/rules/design-philosophy.md` §7 summarizes load-bearing naming rules. The full policy with rejected anti-patterns and exception rationale lives here.

### 9.1 Forbidden filenames (content-blank)

`helpers.ts`, `helper.ts`, `utils.ts`, `shared.ts`, `shared-utils.ts` — names that describe nothing about what the file holds. They invite "anything that fits" and accumulate unrelated logic. Enforced by `tests/invariants/architecture-boundary.test.ts` as a structural pattern check (any file under `src/` with such a name fails the invariant).

### 9.2 Allowed filenames (scope-bound)

Discipline is on *content/size*, not *name*:

- `index.ts` — conventional entry/orchestrator for a cohesive subsystem dir. Allowed at any depth. Don't use it as a barrel that re-exports everything; it's the public surface, not a hiding mechanism.
- `types.ts` — type vocabulary for the parent dir. Allowed at any depth; the directory provides scope. If unrelated types accumulate, MUST split.
- Domain canonicals like `events.ts`, `reducer.ts`, `projections.ts`, `read-queries.ts`, `paths.ts`, `errors.ts`, `contracts.ts`, `protocol.ts`, `client.ts`, `server.ts` — the directory provides scope (`kb/contracts.ts` ≠ `coordinator/contracts.ts`).
- Domain-prefixed siblings like `exec-types.ts`, `manifest-types.ts`, `driver-types.ts` — the prefix declares scope independent of dir.

### 9.3 Magnet vs registry

When a file holds a *typed-identifier registry* (HTTP status codes, POSIX errno, `CoralSetupError` documented codes), accumulation is the *correct* shape — that is what a canonical registry looks like. Don't split it per-domain just because the codes name domain things; the codes are wire-level identifiers, not domain logic.

The magnet anti-pattern only applies when a file absorbs *unrelated logic* through a content-blank name. **Counter-example we got wrong once**: an early attempt split `runtime/errors.ts` into per-domain catalogs to "avoid magnet" — it created a cycle and proliferated files. The catalog stays as one registry; it is not a magnet, it is a registry.

### 9.4 Filename honesty

A file's name must describe what it actually does, not what its history suggests:

- A "`client.ts`" that doesn't talk to a transport but routes a classified verb is named wrong (real fix: `cli/command-client.ts` → `cli/dispatch.ts`).
- A "`main.ts`" that exports `buildProgram` and isn't the actual process entry is named wrong (`cli/main.ts` → `cli/program.ts`; `bootstrap.ts` IS the entry).
- Redundant scope qualifiers within an already-scoped directory are noise (`cli/read-coral-store.ts` → `cli/read-store.ts`).

When in doubt, ask: would a reader who never opened this file guess its role from the name alone?

### 9.5 Re-export discipline

A module's `import { X } from 'A'; export { X };` block creates a *second* canonical home for `X`. Future contributors then face an ambiguous import path — the same type is reachable from two places, with no rule to pick between them. Both paths stay alive (neither is wrong), and over time grep can no longer tell which is the real home. This is the same anti-pattern as the magnet file (§9.3), one level up: instead of unrelated logic accumulating under a content-blank filename, unrelated *home identities* accumulate under a module's export surface.

The rule:

- **A module exports only what it owns.** Names defined in the module are exported; names imported from elsewhere stay local to the module's own use.
- **Exception — a directory's `index.ts`** may publish that directory's own internal members as the public surface (e.g., `coordinator/index.ts` publishes coordinator-owned exports). It must not republish a *foreign* module's exports as its own.
- When a type belongs to a different layer, callers import it from that layer directly. Don't add a re-export "for convenience" — convenience is exactly what dilutes the canonical home.

**Counter-example we got wrong once**: `runtime/ports.ts` accumulated a re-export block aliasing nine port primitives (`TimePort`, `StoragePort`, `EnvPort`, …) from `infra/port-types.ts`. The module's actual responsibility is *runtime composition* (`Runtime`, `ProcessPort`, `IdPort`, `RuntimeObserver`); the re-export block turned it into a *second* canonical home for the primitives. Imports across the codebase split between the two paths with no consistent rule, and `runtime/ports.ts`'s identity blurred. The fix is to delete the re-export block — primitives must be imported from `infra/port-types.ts` directly.

The pattern to look for: any non-`index.ts` module that contains both `import { … } from '…'` and `export { … }` of the same names. That is always either an `index.ts` re-publishing its own directory (allowed), a re-export aggregator (delete it), or a typedef-rename like `export type Y = X` (allowed — it's a new name, not a second home for the old one).

### 9.6 Subdivision triggers

Promote an implicit prefix cluster to an explicit subdirectory when:

1. ≥4 sibling files share a prefix and form a cohesive subsystem (one bounded responsibility split into facets), AND
2. The cohesion is real (each file owns a distinct facet of the same subsystem; the prefix isn't just "files involved in the same general topic"), AND
3. The shared prefix becomes redundant under the subdir (`community-detection.ts` → `community/detection.ts` reads identically).

When subdividing:

- Strip the now-redundant prefix from each file.
- If one file is the orchestrator/public API, name it `<subdir>/index.ts`.
- If the cluster has no single orchestrator, all files are siblings under the subdir.

Counts: 3 files = borderline (subdivide only if cohesion is unmistakable and the cluster is bounded). 2 files = no.

### 9.7 Subdivision rejection (cases where subdividing makes the tree worse)

- `infra/` is the canonical low-level dump by design; subdividing into `infra/paths/`, `infra/errors/`, etc. creates competing canonical homes inside a layer that should stay flat.
  - **Exception**: `infra/path/` is permitted as a cohesive path-composition subsystem (5 files: `compose`, `coordinator`, `engine`, `root`, `store`). The exception applies to subsystems where the directory name names a clear internal concept and the file count justifies a subdir; it does NOT permit `infra/utils/`, `infra/helpers/`, or other content-blank groupings.
- The 4 Journal-stream domains (`jobs`, `sessions`, `discuss`, `workflow`) share a *minimum* shape — `events.ts` and `read-queries.ts` at the domain root, plus `event-describers.ts` for cause-ref rendering. Beyond that minimum, each domain adds files to fit its own complexity, not a forced template:
  - `projections.ts` exists when the domain projects events to SQL tables (sessions/discuss/workflow).
  - `reducer.ts` exists only when the domain reconstructs in-memory state from events (currently only `discuss/`). Domains that project directly to SQL don't need a separate pure reducer.
  - `paths.ts` exists when the domain owns filesystem paths.
  Don't manufacture files just to mirror discuss's shape across domains that don't have the same concerns.
- "Pure label" subdirs (e.g., grouping unrelated files into `gateway/` or `io/` because they "feel related") add navigation cost without scope clarity.

### 9.8 Lifecycle/process-flow naming

When a directory owns a pipeline, name files for the stage they sit at so the directory reads top-down as the request flow. Example: `cli/` reads `bootstrap → program → commands/ → flags → parse → classify → dispatch → format → emit → follow`. Each filename answers "what stage am I at?" without ambiguity.

### 9.9 Discipline is content/size, not name

When a file *does* drift (unrelated logic absorbed, file grows large, cohesion lost), the response is to split it, not to invent a new mechanical naming rule. Per-file line-count caps were a rewrite-time scaffold and were removed once the rewrite landed; growth discipline now lives in code review.

## 10. Boot Eras and Subsystem Lifecycle

0.7.1 split backend boot into three sequential eras and extracted KB into a first-class `Subsystem<R>`. The shape is load-bearing — a flat boot would push KB's variable init time onto the CLI's critical path, and a one-shot KB init would leave the daemon dead on transient KB failures (orama interest mismatch, embedding provider hiccups, etc.).

### 10.1 Why three eras

Era I (Kernel) and Era II (Recovery) are sequenced because their outputs are prerequisites for everything that follows: the IPC socket must be bound and the Journal must be at-head before the CLI can do anything useful, and recovery must finish before live work can be admitted without colliding with in-flight reconcile decisions. Era III (Subsystems) is parallel/fire-and-forget because subsystems are *consumers* of kernel/recovery state, not contributors to it — making them block the kernel was a 0.7.0 mistake that turned a transient KB failure into a multi-minute CLI hang.

### 10.2 Why Subsystem as a contract, not a bespoke branch

Before 0.7.1, KB boot lived inline in `coordinator/index.ts` with ad-hoc retry counters and a custom `KbStatus` accessor. Each new long-init service would have repeated the pattern with subtle drift. `Subsystem<R>` makes the contract explicit:

- A 5-state phase machine (`pending → initializing → online | degraded | offline`) replaces ad-hoc booleans.
- A registry owns retry, status, error envelopes, and `/health` projection — the subsystem itself only writes init/dispose/resource.
- `SubsystemErrorEnvelope` carries `remediation`, so transient failures (`kb_initializing`) and terminal failures (`kb_offline`) carry actionable hints to the CLI without per-callsite glue.
- Enforced by 5 invariants (`subsystem-contract-singleton`, `subsystem-error-envelope`, `lifecycle-phase-monotonic`, `abort-signal-threading`, `no-kb-status-accessors`) so future subsystems cannot diverge.

### 10.3 Why CLI fail-fast deadlines on Eras I and II only

The CLI's deadline contract is "tell me whether the kernel is alive within 5s and whether the daemon is ready within 15s." Stretching either deadline to accommodate a slow KB init would conflate "daemon won't start" with "subsystem retry in progress" — two failures with different remediation. Subsystems instead surface their own state through `/health` and `503 kb_initializing | kb_offline` for callers that actually need KB, while the CLI's status / non-KB paths return immediately.

### 10.4 Why AbortSignal as the cancellation primitive

`assertStartupStillActive` + `StartupInterruptedError` (the 0.6.x model) was a manual cooperative-cancellation discipline that every author had to remember. `AbortSignal` is platform-standard, threaded through Node APIs (timers, fetch, child_process), and integrates with `await` chains via `signal.throwIfAborted()`.

A subtle gotcha drove a memo: `state.startupAbort?.abort('shutdown')` (string reason) loses the `name: 'AbortError'` discriminator on the thrown reason — Node throws the bare string. Always call `abort()` with no arguments so a real `DOMException` with `name === 'AbortError'` propagates. Enforced by `abort-signal-threading`.

### 10.5 Discuss is not a Subsystem (deliberately)

Discuss has one-shot recovery on boot (`workflowRecover.resumeAll`), no retry, no self-heal. Forcing it into the 5-state machine would create dead states (`degraded` and `offline` that mean nothing). Discuss recovery stays in Era II as a one-shot; only services with a meaningful retry/self-heal lifecycle should register as subsystems.

## 11. Value Semantics and Local Abstraction

The naming policy says every concept has one canonical home. The same rule applies inside values: every state must have one canonical representation, and every mutation intent must be explicit at the boundary where it matters.

The elegant shape is not "no optional fields anywhere". Ingress formats, persistence rows, and third-party adapters naturally carry optional fields. The rule is stricter and more useful: **optional raw shape stops at ingress; domain code receives canonical meaning**.

### 11.1 Boundary normalization

Transport, CLI, provider, and persistence adapters may receive loose shapes such as `string | undefined | null`. They are responsible for normalizing those shapes before crossing into domain logic:

- `undefined` means the field was absent from the incoming shape.
- `null` means the caller intentionally supplied "none" when the contract allows it.
- Empty strings for identifiers, references, paths, tokens, and continuity handles are not silently meaningful. Reject them at ingress or convert them to an explicit domain variant.
- Domain code should prefer non-empty identifier/ref types, explicit `null`, or discriminated update variants over truthy string checks.

This keeps `if (conversationRef)` out of core logic. A reader should see the domain meaning directly: "set this ref", "clear this ref", "preserve the current ref", or "no ref exists".

### 11.2 Patch is not state

State records describe the durable fact. Patch/update records describe caller intent. Do not use one object shape for both.

For state, absence is just absence:

```ts
type SessionEntry = {
  activeJobId?: JobId;
};
```

For mutation, preserve/set/clear are different verbs and should be modeled as different variants:

```ts
type ConversationRefPatch =
  | { kind: 'preserve' }
  | { kind: 'set'; conversationRef: ConversationRef }
  | { kind: 'clear' };
```

Avoid encoding those three meanings with `conversationRef?: string | null` inside domain code. That shape is acceptable at an API boundary, but the boundary should immediately parse it into the canonical patch vocabulary.

The practical test: if code needs to ask whether `undefined` means "leave unchanged", "field was absent", "clear this value", or "unknown", the shape is doing too many jobs.

### 11.3 Truthiness is not domain semantics

Truthiness is acceptable for booleans and process-local flags. It is not acceptable as the semantic test for domain identifiers, references, paths, tokens, or provider continuity fields.

Prefer explicit tests:

- `value !== undefined` for "caller supplied a field".
- `value !== null` for "the nullable domain value exists".
- `value.length > 0` only at validation/normalization boundaries.
- A parsed/branded domain type when non-empty identity is required repeatedly.

This prevents accidental behavior differences between empty strings, absent fields, and explicit clears. It also makes simplification safer: removing a `Boolean(x ?? y)` expression is only mechanical when the normalized types already say what empty values mean.

### 11.4 Local helpers are allowed when they name repeated meaning

The "no manufactured abstractions" rule is about avoiding orphan surfaces and shared dumping grounds. It is not a ban on same-file structure.

Within one file, an unexported helper or constant is appropriate when all of these hold:

1. The repeated code is the same invariant, fallback state, transition, or boundary rule.
2. The helper name says the domain concept, not the implementation trick.
3. The helper stays local and unexported.
4. The helper removes cognitive load without creating a second canonical home.

Examples of acceptable local abstraction:

- A repeated initial state literal becomes `retentionDiscardAttemptState(...)`.
- A repeated comparison rule becomes `waiterTargetReached(...)`.
- A repeated async cleanup boundary becomes a local `runWith...` only when the boundary itself is the concept.

Examples to reject:

- Extracting a one-line property access just to shorten a caller.
- Moving local repetition into `helpers.ts`, `utils.ts`, or a cross-domain convenience module.
- Exporting a helper before another file actually owns the same concept.

Single-use helpers are rare but allowed when the name exposes a domain concept that the inline code hides. They are not allowed merely to make the code look flatter.

### 11.5 `return await` marks an async boundary

`return await` is not a formatting preference. It changes where rejection is observed and when `finally` runs relative to the returned promise. Use it only when that boundary is load-bearing:

- A surrounding `catch` translates or wraps the rejection.
- A surrounding `finally` must run after the returned promise settles, such as lock release, lifecycle finalization, or recorder cleanup.
- The function deliberately owns the async boundary for ordering or cleanup.

Otherwise return the promise directly. If a function's contract requires a fulfilled `Promise<void>` for an immediate path, `Promise.resolve()` is acceptable; if the code needs microtask deferral or to capture synchronous throws into a promise chain, make that intent visible in the surrounding structure.

The review test: deleting `await` must not change catch/finally behavior, lock lifetime, error shape, or caller-observable settlement ordering. If it would, keep it.

### 11.6 The broader rule: ingress is noisy, core is canonical

Coral has several authority boundaries: Journal events, Corpus files, provider streams, CLI input, IPC/HTTP transport, and runtime ports. Each boundary may be noisy because it talks to users, files, processes, or external tools. The core should not inherit that noise.

The pattern is:

1. Accept loose external shape at the edge.
2. Normalize once, close to the edge.
3. Pass canonical domain values inward.
4. Express mutation intent as variants, not overloaded optionals.
5. Keep local helpers near the concept they name.

This mirrors the larger architecture: authorities stay distinct, canonical homes stay singular, and composition happens at explicit seams instead of through convenient ambiguity.

## 12. Cross-References

- Current shape and ownership matrix: [`docs/architecture.md`](architecture.md)
- Module map: [`docs/core-modules.md`](core-modules.md)
- Build pipeline: [`docs/build-system.md`](build-system.md)
- Discuss-domain design: [`docs/discuss.md`](discuss.md)
- HOW system: [`docs/methodology.md`](methodology.md)
- Hooks: [`docs/hooks.md`](hooks.md)
- Skills: [`docs/skills.md`](skills.md)
- Configuration / env vars: [`docs/configuration.md`](configuration.md)
- Rules / principles: [`.claude/rules/design-philosophy.md`](../.claude/rules/design-philosophy.md), [`.claude/rules/conventions.md`](../.claude/rules/conventions.md)
