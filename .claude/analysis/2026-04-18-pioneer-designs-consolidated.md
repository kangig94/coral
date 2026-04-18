# Pioneer Designs — Consolidated — 2026-04-18

Four `coral:pioneer` agents were spawned (A/B/C/D from the elegance diagnosis at `analysis/2026-04-18-architecture-elegance-diagnosis.md`). Cost-unconstrained, breaking-changes-allowed design exercises. Pioneers E (shared/ decomposition) and F (CLI direct-link transport) were aborted mid-run when the backend was restarted to test the codex `shared: true` fix — they will be re-run later.

This file collects each pioneer's verdict, final forms, and the cross-cutting patterns that emerged. Intended as seed material for subsequent `/coral:plan` sessions.

---

## Pioneer A — `src/execution/` god-directory decomposition (claude)

### Verdict

"Just split `execution/`" is too timid. **Delete it entirely.** What appears to be one layer is actually three: backend composition, transport, and domain-shell glue for multiple domains. The template already exists in-repo as `src/discuss/` (pure core) + `src/execution/discuss/` (shell).

### Final topology

```
src/
├── backend/                       ← composition root + lifecycle
│   ├── server.ts, core.ts, world.ts, defaults.ts, control.ts
│   ├── runtime-state.ts, lifecycle.ts, lock.ts, identity.ts, http-deps.ts
│   ├── recording/
│   └── shutdown/ (sequence, mode, network)
│
├── runtime/                       ← 6-subport Runtime (preserved)
│   ├── runtime.ts, real.ts
│   └── ports/ (time, storage, paths, process, ids, env)
│
├── transport/
│   ├── http/ (router, sse, parse, + one file per resource)
│   └── spawn/ (admission, durable-job, provider-server, idle-timer, host-manager)
│
├── jobs/                          ← domain
│   ├── types.ts, events.ts, store.ts, abort-registry.ts
│   ├── launcher.ts, terminator.ts, waiter.ts, workflow.ts
│   ├── instruction.ts, agent-resolution.ts
│   └── recovery/ (plan, apply, coordinator, snapshot, registry, adopt-cross-ns,
│                  claim-protocol, ownership-checker, recoverer)
│
├── sessions/                      ← domain
│   ├── types.ts, store.ts, coordinator.ts, resolve.ts
│
├── discuss/                       ← unchanged; was template
│   └── shell/ (moved from src/execution/discuss/)
│
├── kb/                            ← unchanged
│   └── shell/ (subsystem + http)
│
├── providers/, workflow/          ← unchanged shapes
│
├── simulation/                    ← promoted to top-level
│
├── infra/, shared/                ← unchanged (shared/ per Finding #5)
└── cli/, client/, hooks/, skills/
```

### `ExecutionService` dissolution

Six domain-owned services replace the god class. No successor facade — callers import the specific service they need.

| Current method | New home |
|---|---|
| `start/resume/fork/*`, `coralDispatch` | `jobs/launcher.ts` → `JobLauncher` |
| `abort` | `jobs/terminator.ts` → `JobTerminator` |
| `waitForJobTerminal`, `awaitLaunch`, `waitStream*` | `jobs/waiter.ts` → `JobWaiter` |
| `executeWorkflow`, `runWorkflowAsync`, `handleWorkflowError`, `finishWorkflowJob` | `jobs/workflow.ts` → `WorkflowCoordinator` |
| `interruptAppServerJob`, `finalizeInterruptedAppServerJob`, `recoverQueuedJob`, `adoptRunningJob`, `completeRecoveredJob`, `checkpointRecovery` | `jobs/recovery/recoverer.ts` → `JobRecoverer` (implements the recovery port) |
| `finalizeProviderSession`, `finalizeSessionContinuityMutation` | `sessions/coordinator.ts` → `SessionCoordinator` |

The telltale is `ExecutionServiceLike` (`backend-contracts.ts:63-66`): a six-method narrow pick already informally names the split. Formalize it.

### Where does `handleInterruptedAppServer` live?

**`src/jobs/recovery/recoverer.ts`** — it classifies a stranded in-flight app-server job (probe, mutate session continuity, write terminal, release permit). That is the recovery-classifier of one branch, not a transport/session/lifecycle concern.

### Cross-directory DAG invariants (each is one sentence)

1. `transport/*` must not import `backend/`
2. `jobs/`, `sessions/`, `discuss/`, `kb/`, `workflow/`, `providers/` must not import `backend/` or `transport/http/`
3. Domain `X` must not import domain `Y/shell/` — only `X/shell/` may reach across
4. `discuss/`, `kb/` (pure cores) must not import from `src/runtime/` or any shell
5. `backend/` is the only module permitted to import from all layers

### Key insight

The directory `execution/` is itself a god-class in directory form — the name is so generic it accretes anything that touches a process. Deleting it forces the question "which domain owns this?" for every file. Preserved as already-elegant: the 6-subport Runtime, `recovery-core.ts:planRecovery()`, `backend-world.ts` as single-point world-build, workflow's sealed `providers/catalog` allowlist.

---

## Pioneer B — Unified `JobResult` (claude)

### Verdict

The nested-tree form (`children?: JobResult[]`) proposed by the diagnosis is **wrong**. The inevitable form is: **a single `JobResult` whose optional `composition` points to child job IDs, and where every workflow atom is an independent top-level job linked by `parentJobId`**. The tree lives in projections, not in the result record.

Key reason: the current codebase already launches each atom as its own independent backend job (`pipe-executor.ts:371-413` + `PersistedLaunchRecord.parentWorkflowJobId` at `types.ts:281`). The graph-of-jobs-by-pointer is the real structure. Embedded children would be shadow copies and cause partial-crash desync.

### Final shape

```ts
// src/shared/job-result.ts — new home

export interface JobResult {
  content: string;
  outcome: TerminalOutcome;          // from CoralFault ADT, unchanged
  durationMs: number;
  composition?: JobComposition;       // present iff this job orchestrated children
}

export interface JobComposition {
  childJobIds: string[];              // in execution order
  steps: WorkflowStepMeta[];          // markdown offsets
}

export interface SessionContinuityPatch {
  conversationRef?: string;
  resumable?: boolean;                // false → session → 'non_resumable'
}

export interface JobDiagnostics {
  warnings: string[];
  usage?: UsageSummary;
  model?: string;
}

export interface ProviderOutput {
  result: JobResult;
  continuity: SessionContinuityPatch;
  diagnostics: JobDiagnostics;
}
```

### Four removed fields

| Removed | Replacement |
|---|---|
| `exitCode` | `outcome.kind === 'provider_exit' ? outcome.code : null` |
| `nonResumable` | `sessionManager.get(sid).state === 'non_resumable'` (via `SessionContinuityPatch.resumable`) |
| `workflow?: WorkflowResultMeta` | `composition?: JobComposition` on coordinator's own result |
| `JobKind` | Deleted; `status.result.composition !== undefined` is the one peephole |

### Why the tree is wrong

1. **Already a graph, not a tree** — the embedded form duplicates data that already lives in independent child job records.
2. **Partial-crash recovery** becomes a special "merge what we have" path with embedded children. Reference form needs nothing: children exist at their own paths.
3. **Aggregation is non-uniform** — `content` is per-node, `usage` sums children, `warnings` is per-node. A tree that doesn't aggregate uniformly is the smell. **Workflow usage is a projection, not a field.**
4. **`exitCode` dead** — every caller reads `outcome.provider_exit.code`.

### Worked example: `[A] | [B, C]` where C fails

- Four jobs on disk: `job-wf` (coordinator), `job-A`, `job-B`, `job-C`.
- `job-C` carries the underlying provider failure, not `workflow_atom_failed` — atom jobs are provider jobs.
- `job-wf` coordinator's result:

```ts
{
  content: "",
  outcome: {
    kind: 'coral_fault',
    fault: { kind: 'workflow_atom_failed', step: 1, atom: 'C', cause: {...} }
  },
  durationMs: 47_231,
  composition: {
    childJobIds: ['job-A', 'job-B', 'job-C'],
    steps: [ { step: 0, atom: 0, agent: 'A', ... }, { step: 1, atom: 0, agent: 'B', ... } ]
    // C absent from steps because its output was not rendered into coordinator's result.md
  }
}
```

Partial success durable: `job-A`, `job-B` independently readable even though parent failed.

### New `handleWorkflowError`

```ts
const fault = aborted
  ? { kind: 'workflow_aborted' }
  : { kind: 'workflow_atom_failed', step: err?.failedStep, atom: err?.failedAtom,
      cause: { message: errorMessage(err) } };

const result: JobResult = {
  content: '',
  outcome: { kind: 'coral_fault', fault },
  durationMs: now() - launchedAt,
  composition: { childJobIds, steps },
};
```

No `finishWorkflowJob` — its branching on `jobKind` goes away. `writeResultMd` is the same code path as any provider job.

### CLI wait

Default `--embed` stays one-header-one-preview. Optional `--tree` adds:

```
Job job-wf coral errored: Workflow step 1 atom 'C' failed. [workflow_atom_failed]
Result path: /tmp/coral-jobs/job-wf/result.md
Composition (3 children):
  ✓ job-A  step 0.0  A   completed        (38 lines)
  ✓ job-B  step 1.0  B   completed        (33 lines)
  ✗ job-C  step 1.1  C   provider_exit 1
```

### Invariants this form guarantees

1. **One source of truth per job** — no shadow-child copies.
2. **Outcome uniformity** — every job terminates with the same four-variant `TerminalOutcome`.
3. **Partial-crash readable** — each child has a valid `status.json` regardless of parent state.
4. **Session mutation atomic** — single session write via `SessionContinuityPatch`.
5. **`composition.childJobIds` is the only cross-job reference structure** — parent graph walked via existing `parentJobId` back-pointer.

### Rejected alternatives

- Event-sourced terminal (Pioneer D's territory): strictly larger change; still needs this reference model at the projection level. This form is the **correct waypoint**.
- No coordinator job at all (atoms as top-level, pointer-only): regresses CLI ergonomics — users want one `jobId` to `wait` on.

---

## Pioneer C — Provider as stream + middleware (codex)

### Verdict

**Provider = `(request, runtime) => AsyncIterable<ProviderEvent>`**, composed via `next`-chained middleware. The three current paths (adapter, session driver, runner) collapse into one kernel per provider wrapped by provider-agnostic middleware.

### Final contract

```ts
type Provider = (request: ProviderRequest, runtime: ProviderRuntime) =>
  AsyncIterable<ProviderEvent>;

const providerEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('progress'), message: z.string() }).strict(),
  z.object({
    kind: z.literal('continuity'),
    conversationRef: z.string().nullable(),
    resumable: z.boolean(),
    providerContinuity: z.record(z.string(), z.unknown()).nullable(),
  }).strict(),
  z.object({ kind: z.literal('terminal'), result: providerTerminalSchema }).strict(),
]);

type ProviderMiddleware = (next: Provider) => Provider;

declare function compose(
  ...parts: readonly [...ProviderMiddleware[], Provider]
): Provider;
```

### Worked compositions

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

### Fault authority (single-owner per kind)

- `adapter_output_unparseable` — only the `adapterParseGuard` middleware
- `provider_session_unavailable` — only `sessionContinuity` middleware (usually after emitting `continuity { conversationRef: null, resumable: false }`)
- `provider_request_failed` — only the leaf kernel (or `appServerSession`) after observing the turn reported failure

Generic "uniformize failure post-hoc" (current `runner.ts:66-83` overwrite) disappears.

### Invariants

1. Every provider stream emits **exactly one** `terminal`, and it is last.
2. `continuity` events are full snapshots, not patches.
3. If `resumable: true`, `conversationRef` must be non-null.
4. Terminal payload never mutates session state.
5. Generic middleware never rewrites a downstream terminal outcome.
6. Abort enters once through `runtime.signal`; no extra public interrupt surface.

### What disappears

- `ProviderResult`, `ProviderProgressEvent`, `runtime.onEvent`, `runtime.checkpointRecovery`, `ProviderResult.nonResumable` (already Pioneer B's target)
- `ProviderExecutor` vs `ProviderAppServerLifecycle` dual interface
- `app-server/runner.ts` (state machine moves into kernels; lifecycle into middleware)

### Migration sketch

1. Execution layer shifts to stream consumption: record progress, persist latest continuity snapshot, stop on one terminal.
2. Port codex first (cleanest proof of concept — app-server-only).
3. Port claude exec (proves parse-guard).
4. Port claude app-server (proves interrupt/probe flows).
5. Rebuild recovery's interrupted-app-server path around persisted continuity snapshots, not a separate role interface.

### Continuity as full snapshot

Session state becomes load-bearing and explicit: the engine persists the latest continuity event; terminal data is only terminal data. Matches Pioneer B's `SessionContinuityPatch` exactly — the stream just delivers it before the terminal event.

### Already elegant

The `CoralFault` + `TerminalOutcome` ADTs (`src/shared/coral-fault.ts`) are the right substrate; the stream carries them unchanged.

---

## Pioneer D — Unified event-sourced persistence (codex)

### Verdict

**Reject "per-namespace log".** Use **one global append-only journal**; `namespace` becomes a field on each event, and the **stream** (domain/id) is the true boundary. Jobs are namespace-owned but sessions cross namespaces; discuss and KB are not namespace-owned. Per-namespace logs make ordinary references into distributed joins.

### Final store shape

```
~/.coral/store/
  segments/
    0000000000000001.jsonl
    0000000000005001.jsonl
  checkpoint/
    state-000000000004921.json
  projections/
    jobs.index.json
    sessions.index.json
    kb.index.json
    discuss.index.json
  exports/
    jobs/<jobId>/result.md
    kb/...
  writer.lock
```

Three storage tiers:
- **Journal** — truth (append-only JSONL segments).
- **Checkpoint** — replay accelerator (full state at `lastSeq`).
- **Projections/exports** — cached reads, rebuildable.

### Event header

```ts
const eventHeader = z.object({
  v: z.literal(1),
  seq: z.number().int().positive(),
  ts: z.string().datetime(),
  type: z.string(),
  stream: z.object({
    kind: z.enum(['job', 'session', 'discuss', 'kb']),
    id: z.string().min(1),
  }),
  namespace: z.string().optional(),
  project: z.string().optional(),
  correlationId: z.string().optional(),
  causationSeq: z.number().optional(),
  refs: z.object({
    jobId, sessionId, parentJobId, discussSessionId, kbEntryIds,
  }).strict().optional(),
}).strict();
```

### Six job files → events

- `launch.json` → `job.launch.requested`
- queue admission → `job.queue.admitted`
- `runtime.json` → `job.wrapper.started`
- `progress.jsonl` entries → `job.progress.emitted`
- `exit.json` → `job.exit.recorded`
- `status.json.result` → `job.terminal.recorded`
- `result.md` → **export**, generated from `job.terminal.recorded`; never authoritative

### Recovery

```ts
type CoralCheckpoint = {
  schemaVersion: 1;
  lastSeq: number;
  state: CoralState;   // jobs + sessions + discuss + kb
};

function replayCoral(checkpoint: CoralCheckpoint | null, tail: readonly CoralEvent[]): CoralCheckpoint;
```

Invariants:
- `tail` strictly ordered by `seq`, starting at `checkpoint.lastSeq + 1`.
- Replay is pure — no PID checks, no filesystem reads, no clock decisions.
- `replay(genesis, fullLog) === replay(checkpoint, tail)`.

**Key split**: replay reconstructs persisted truth; **reconciliation** is separate and imperative. After replay, the daemon compares projected running jobs to the process table and, if reality disagrees, appends *new* facts (e.g., a recovery-generated `job.terminal.recorded`). This replaces the current file-presence-combination heuristics of `recovery-core.ts`.

### Query shape

Fast reads come from `projections/jobs.index.json`, not log scans:

```json
{
  "lastSeq": 106,
  "byId": { "job_42": {...} },
  "byProject": {
    "kangig94/coral": {
      "activeByPhase": { "running": ["job_42"] },
      "recentTerminal": ["job_41", "job_40"]
    }
  }
}
```

"List jobs for project X phase=running": resolve slug → read `byProject[slug].activeByPhase.running` → dereference in `byId`. Zero log scan.

### What disappears

- `recovery-core.ts` classifier table (the 10+ row file-presence matrix).
- `hasLaunch/hasRuntime/hasExit` recovery matrix entirely.
- `ghost_launch` and `stale_dead` as inferred-from-file-absence states.
- `status.json` as a second authority.
- Session continuity scattered across job completion code and standalone session files.

### What appears

- Log segment rotation.
- Checkpoint cadence (every N events + clean shutdown + large burst trigger).
- Projection versioning + invalidation (`schemaVersion`, `projectionVersion`, `lastSeq`; mismatch triggers rebuild).
- Sharper distinction between canonical facts and exported artifacts.
- Global ordering discipline across domains.
- **One explicit choice for KB**: markdown becomes export, not authority.

### Cross-namespace semantics

- `namespace` says who emitted the event, not where state lives.
- Streams are global: `job/<id>`, `session/<id>`, `discuss/<id>`, `kb/<id>`.
- Cross-namespace workflows use `correlationId` and `refs.parentJobId`.
- A session can be released by a different namespace than the one that created it — because the journal order is global.

### Already elegant

**Discuss is the template**, again. Its event envelope + reducer + snapshot-plus-tail recovery are the right shape; only the storage boundary is too local. The other preserved piece: `result.md` as a human artifact — but only as an export derived from `job.terminal.recorded`, never as truth.

---

## Pioneer E — No `src/shared/`, no `src/contracts/` (codex)

### Verdict

**The premise "split shared/ into contracts/ and infra/" is wrong at the top level.** A top-level `src/contracts/` would be the same sink with a better name. The elegant form: **no top-level `shared/` and no top-level `contracts/`**; domains own their contracts.

Top-level roots collapse to real domains + infrastructure: `backend/`, `jobs/`, `sessions/`, `providers/`, `workflow/`, `transport/`, `runtime/`, `infra/`, `testing/`. No junk drawer.

### Final relocation map

Every current `src/shared/*` file gets a real owner:

| Current `src/shared/*` | New home |
|---|---|
| `backend-log.ts` | `src/backend/log.ts` |
| `child-env.ts` | `src/infra/process/child-env.ts` |
| `coral-fault.ts` | `src/jobs/outcome.ts` |
| `env-sanitize.ts` | `src/infra/process/env-budget.ts` |
| `execution-contracts.ts` | split: `src/jobs/abort.ts` + `src/workflow/checkpoint.ts` |
| `file-tail.ts` | `src/infra/fs/file-tail.ts` |
| `format-progress.ts` | split: `src/providers/progress-format.ts` + `src/infra/text/truncate.ts` + `src/jobs/progress-format.ts` |
| `fs-lock.ts` | `src/infra/fs/directory-lock.ts` |
| `identifiers.ts` | `src/infra/ids/patterns.ts` |
| `kb-read-contract.ts` | `src/kb/read-contract.ts` |
| `lock-types.ts` | `src/backend/lock-record.ts` |
| `node-process.ts` | `src/infra/process/alive.ts` |
| `persistence-parsers.ts` | split: `src/jobs/persistence/parse.ts` + `src/discuss/persistence/parse.ts` |
| `persistence-readers.ts` | split: `src/jobs/persistence/read.ts` + `src/discuss/persistence/read.ts` |
| `persistence-types.ts` | `src/discuss/discovery.ts` |
| `process-constants.ts` | `src/infra/process/constants.ts` |
| `request-context.ts` | `src/backend/caller-context.ts` |
| `runtime-ports.ts` | split: `src/runtime/ports.ts` + `src/jobs/paths.ts` + `src/discuss/paths.ts` + `src/backend/paths.ts` |
| `schemas.ts` | split: `src/transport/http/job-contracts.ts` + `src/transport/http/session-contracts.ts` + `src/workflow/command.ts` + `src/providers/model-policy.ts` |
| `session-entry.ts` | `src/sessions/persistence.ts` |
| `sse-parser.ts` | split: `src/transport/http/sse.ts` + `src/jobs/wait.ts` |
| `test-deferred.ts` | `src/testing/deferred.ts` |
| `types.ts` | split: `src/jobs/phase.ts` + `src/jobs/result.ts` + `src/jobs/records.ts` + `src/jobs/wait.ts` + `src/jobs/launch.ts` + `src/sessions/types.ts` + `src/providers/contract.ts` + `src/workflow/checkpoint.ts` |
| `utils.ts` | split: `src/infra/fs/fs-errors.ts` + `src/infra/json/guards.ts` + `src/infra/ids/owner.ts` + `src/infra/time.ts` + `src/transport/http/errors.ts` + `src/transport/json-rpc.ts` + `src/backend/manifest.ts` |

`src/shared/__tests__/*` co-move beside their owning modules. No shared test folder.

### `types.ts` split (the multi-domain mixing ground)

- `src/jobs/outcome.ts`: `CoralFault`, `TerminalOutcome`, `describeCoralFault`
- `src/jobs/phase.ts`: `JobPhase`, `LaunchState`, `JOB_PHASES`, `jobPhaseSchema`, `isLivePhase`, `isTerminalPhase`, `phaseForOutcome`
- `src/jobs/result.ts`: `TerminalResult` (becomes `JobResult` + `JobComposition` + `JobDiagnostics` if Pioneer B lands)
- `src/jobs/records.ts`: `PersistedStatusRecord`, `PersistedLaunchRecord`, `PersistedRuntimeRecord`, `PersistedExitRecord`, `PersistedProgressRecord`
- `src/jobs/wait.ts`: `WaitCursor`, `WaitRequest`, `WaitStreamRequest`, `WaitStreamEvent`
- `src/jobs/launch.ts`: `LaunchDecision`, job ids
- `src/sessions/types.ts`: `SessionEntry`, `SessionState`, `SessionControllerProfile`
- `src/providers/contract.ts`: `ProviderAction`, `ProviderInstruction`, `ProviderRequest`, `ProviderProgressEvent`, `ProviderContinuityBlob`, `ProviderResult`
- `src/workflow/checkpoint.ts`: `WorkflowCheckpoint`, checkpoint writer contract

### Key corrections to the original premise

- **`wait` is not a top-level domain**. It is a jobs projection — belongs under `jobs/wait.ts`.
- **`fault` is not cross-cutting**. It is a jobs outcome — `src/jobs/outcome.ts`.
- **`request-context` is not shared**. It is backend call scope — `src/backend/caller-context.ts`.

### Import DAG

`infra/*` → `runtime/*` → domain contracts (`jobs/*`, `sessions/*`, `providers/contract.ts`, `workflow/*`, `kb/*`, `discuss/*`) → domain shells/implementations → `transport/*` and `client/*`/`cli/*` → `backend/*` as composition root.

### Layering invariants (each one sentence)

- No top-level `src/shared/` and no top-level `src/contracts/`.
- `src/infra/*` must not import from any domain, `transport`, `client`, `cli`, or `backend`.
- `src/runtime/*` must not import from any domain, `transport`, `client`, `cli`, or `backend`.
- Domain contract modules may import only `infra/*`, `runtime/*`, and explicit sibling contract modules — never sibling shells.
- `src/transport/*` may import domain contracts but not domain implementations or `src/backend/*`.
- `src/backend/*` is the only layer allowed to import broadly across domains.
- `src/testing/*` must not be imported by production files.
- Ban generic filenames at top level of a domain root: no new `utils.ts`, `types.ts`, or `schemas.ts` outside an owning domain.

### Interaction with A, B

- Validates Pioneer A: domain-owned contracts are right; a top-level `contracts/` would just recreate `shared/`.
- For Pioneer B, the natural homes:
  - `JobResult`, `JobComposition`, `JobDiagnostics` → `src/jobs/result.ts`
  - `CoralFault`, `TerminalOutcome` → `src/jobs/outcome.ts`
  - `SessionContinuityPatch` → `src/sessions/continuity.ts`
  - `ProviderOutput` / future `ProviderEvent` → `src/providers/contract.ts`
  - `WaitStreamEvent` consuming `JobResult` → `src/jobs/wait.ts`

### Already elegant

- The `CoralFault` ADT itself — only its **location** is wrong.
- The `runtime` port concept — only the domain path types currently mixed into it are wrong.
- `kb-read-contract.ts` — already resonant with its domain, just belongs under `src/kb/`.

---

## Pioneer F — Backend = coordinator, not universal service (codex)

### Verdict

**HTTP is not the boundary; coordination is.** The daemon's role is to coordinate live processes, not to front every call. Split Coral into:

- **`CoralStore`** — durable reads from projections / journal, in-proc, no daemon required.
- **`CoralCoordinator`** — live commands (launches, waits, aborts, session continuity, provider hosts, live streams). Sole writer of live state and sole owner of provider hosts.

### The central reframe

> The daemon is the coordinator, not a universal service.

Two authorities. Durable truth and in-flight ownership are different things. Reads fall onto projections in-proc; writes and live streams go to the coordinator.

### Transport layering

| Layer | When used | Who |
|-------|----------|-----|
| **Library-direct** (no daemon) | Projection reads only: `jobs list/detail`, KB reads/search, historical discuss/session inspection, offline validation | Most read-only CLI calls |
| **IPC** (Unix socket / named pipe) | Local coordinated commands: `codex`, `resume`, `fork`, `workflow`, `abort`, `wait`, live discuss/watch, anything mutating sessions or needing streaming | Most local mutating CLI calls |
| **HTTP / WebSocket gateway** | Networked or browser-based clients | `coral-reef` dashboard, remote coral, explicit server exposure |

HTTP is a *costume*. `http://127.0.0.1:<port>` with auth token pretends a local coordinator is a network service. Replace with real IPC; HTTP becomes a gateway onto the same coordinator RPC.

### Routing is semantic, not topological

**No `--local` flag.** The command declares what authority it needs:
- read-only + fresh-enough → library-direct
- mutating or live-stream → IPC
- networked → HTTP/WebSocket

"If daemon is running, use it; otherwise bypass" is wrong because the same command would mean different things based on daemon presence. Every command declares its class; transport follows.

### Single-writer discipline

**Only the coordinator may:**
- Append command-side events to the journal.
- Mutate live session state.
- Acquire provider hosts.
- Admit launches.

Direct readers observe projections at seq N; coordinated calls acknowledge after journal append. This preserves correctness under two terminals launching `codex` simultaneously and keeps `launch` in one shell + `wait` in another coherent.

### Migration (shape first, then transport)

1. Split today's client into `CoralQueries` and `CoordinatorClient`.
2. Move read commands to projection readers.
3. Define one transport-neutral coordinator RPC; implement local IPC first.
4. Keep HTTP/WebSocket as a gateway onto the same coordinator RPC (for `coral-reef` and remote coral).
5. Let Pioneer D make projections authoritative for reads — transport mostly disappears for read paths.

### Invariants

1. Exactly one coordinator holds write authority for a Coral store.
2. Local read-only CLI commands never require coordinator startup.
3. No local mutating or live command bypasses the coordinator.
4. IPC and HTTP/WebSocket have identical command semantics; only carriage differs.
5. Local security is filesystem ownership on the socket/pipe; HTTP auth is for network gateways.
6. `coral-reef` still works through the HTTP/WebSocket gateway; remote coral still works through network transport or an SSH tunnel onto the same coordinator RPC.

### Already elegant

- `src/execution/service.ts` already shows the domain is not inherently HTTP-shaped.
- `src/execution/composition/create-backend-core.ts` already separates service construction from transport.
- Pioneer D is the right substrate: once journal/projections exist, direct reads are obvious and the daemon's role narrows cleanly.

---

## Cross-cutting patterns

### "Discuss is the template" validated six ways

All six pioneers independently reference `src/discuss/` as the one fully-right subsystem in the codebase:

- **A**: "src/discuss/ + src/execution/discuss/ is the only subsystem that works. Every other concern parked in execution/ is there because no one drew the domain line."
- **B**: the `src/discuss/` event-sourced model validates the reference-not-embedded choice for job composition.
- **C**: preserves the `CoralFault` ADT unchanged because it was built with the discuss pattern in mind.
- **D**: "Discuss is already the template. Its current event envelope, reducer, and snapshot-plus-tail recovery are the right shape; only the storage boundary is too local."
- **E**: validates domain-owned contracts — puts `CoralFault` and `TerminalOutcome` under `src/jobs/outcome.ts`, confirming that even the "cross-cutting" ADT is really jobs-owned. No top-level `contracts/` is needed.
- **F**: reads become in-proc projections from the journal; the coordinator's role shrinks to coordinating live processes — exactly the "imperative shell over pure core" pattern scaled to the whole backend.

**Convergent conclusion**: the coral long-term direction is a repo-wide convergence to:

```
src/<domain>/            ← pure L0 core (reducer, events, types, contracts)
src/<domain>/shell/      ← imperative shell (I/O, persistence glue)
src/transport/<kind>/    ← HTTP, IPC, spawn, SSE — outside domains
src/backend/             ← composition root; coordinator for live state
src/infra/               ← fs, process, time, ids, json — no domain knowledge
```

Applied across jobs/sessions/discuss/kb/providers/workflow. **No `src/shared/`. No `src/contracts/`. No top-level `src/execution/`.**

### Compositional relationships (all 6)

- **A → B**: splitting `execution/` is a prerequisite for moving `handleWorkflowError` into `jobs/workflow.ts` where Pioneer B's `handleWorkflowError` replacement lives.
- **A ↔ E**: A's domain split *is* E's layering target. Pioneer E gives the file-level placement rules that Pioneer A's directory plan needs. They must land together.
- **B → C**: Pioneer C's `SessionContinuityPatch` is exactly Pioneer B's new field shape — the stream just carries it.
- **B ↔ C**: both independently derive the same "continuity is not a result field" invariant.
- **B + E**: E names the exact file placement for B's new types (`src/jobs/result.ts`, `src/jobs/outcome.ts`, `src/sessions/continuity.ts`, `src/providers/contract.ts`).
- **D subsumes B**: event-sourcing terminates at a projection that *is* Pioneer B's `JobResult`. D is B done at the persistence layer.
- **D → F**: once the journal/projections exist, F's library-direct read path becomes obvious; without D, F requires a separate read API.
- **A → D**: the domain split in A matches D's per-stream-kind partitioning (`job/*`, `session/*`, `discuss/*`, `kb/*`).
- **F ↔ D**: F's `CoralStore` is a thin API over D's projections; F's `CoralCoordinator` is the single writer to D's journal. They are two aspects of one design.

### The inevitable long-term shape (all 6 combined)

1. `src/execution/` dissolves into `backend/`, `jobs/`, `sessions/`, `transport/`, `simulation/` (Pioneer A).
2. `src/shared/` dissolves; every file lives under its owning domain or `infra/`/`testing/` (Pioneer E).
3. Every domain is event-sourced via the discuss template — single global journal, per-domain streams, projections cached (Pioneer D).
4. Provider turns are streams of `ProviderEvent` composed from middleware (Pioneer C).
5. `JobResult` is a projection over per-job events; composition is a pointer graph of independent child jobs (Pioneer B).
6. Session continuity is a first-class event, not a field or a patch — same stream item (Pioneers B+C).
7. Recovery is pure replay plus separate imperative reconciliation that appends new facts when the world disagrees with projected state (Pioneer D).
8. Local CLI calls: projection reads go library-direct in-proc, coordinated commands go IPC, HTTP is a gateway for networked clients (Pioneer F).
9. The daemon is **the coordinator**, not a universal service — sole writer of live state, sole owner of provider hosts (Pioneer F).

Each piece reinforces the others. Doing them in isolation is possible but strictly less than doing them together. Pioneers A+E are practically one refactor. B+C are practically one refactor. D is the keystone; F is the capstone.

### Practical sequencing

Even if the eventual shape is the above, these are not all equally tractable. Ordering for a real implementation push:

1. **Pioneer A + E (combined)** — directory and type-placement are one refactor. Do together. Highest ROI, enables everything downstream. 2-3 days.
2. **Pioneer B (JobResult unification)** — removes workflow-vs-provider bifurcation; prepares for event-sourced form. Done over A+E's layout.
3. **Pioneer C (provider middleware)** — prototype on codex alone; CoralFault ADT is the substrate.
4. **Pioneer D (event-sourced persistence)** — the keystone. Largest bet; do after A/B/C/E prepare the ground.
5. **Pioneer F (transport split)** — capstone; requires D's projections to make library-direct reads meaningful. Depends on all prior.

Each is a `/coral:plan --deep --codex` candidate. A+E should be planned as one unit.

---

## References

Source diagnosis: `/home/kang/.coral/projects/kangig94-coral/analysis/2026-04-18-architecture-elegance-diagnosis.md`

Pioneer result artifacts:
- Pioneer A (Claude, foreground): inline in session transcript
- Pioneer B (Claude, background `ad6379aa38773334b`): task-notification result
- Pioneer C (codex, `535dde42-e791-408e-80cf-e0f241b83739`)
- Pioneer D (codex, `bcd2b791-924a-4fd1-8892-2091efc0d81f`)
- Pioneer E (codex, `3fd4f070-a6eb-43fd-93d0-952e5a103209`) — captured at `/tmp/pioneer-E.txt` during this session; reproducible via `coral-cli wait --jobs <id> --embed`
- Pioneer F (codex, `0f7814c4-96e3-4778-ac3e-ca8e01067ae7`) — captured at `/tmp/pioneer-F.txt` during this session

Related commits in scope:
- `b0c8c910` CoralFault ADT refactor (substrate for Pioneer C)
- `461d6b81` CLI text-only output refactor
- `5f0e24c7` Hooks hardening / /jobs contract / wait stream slimdown (PR #196)
- `21827ac8` fix(codex): `shared: true` on provider-server spec — unblocked parallel pioneers E/F
- `e475db19` test(service): drop exclusive-lease defensive tests after codex shared flip

**All six pioneer designs complete.** Ready for `/coral:plan` sessions. Recommended pairing: A+E as a single plan (directory + type placement), then B, then C, then D, then F.
