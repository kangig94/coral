# Architecture Elegance Diagnosis — 2026-04-18

Following the CoralFault ADT refactor (commit `b0c8c910`), a structural review of where the current Coral architecture still feels inelegant and what radically simpler forms might exist. Compiled at user request after drawing the current runtime graph.

This is **diagnostic**, not a plan. Each finding includes current-state file:line evidence, the "ugly" characterization, a vision of the elegant form, and an ROI note. Use this as a seed for future `/coral:plan` sessions.

---

## 1. `src/execution/` is a god-directory

**Current evidence**:
One directory carries 6+ concerns:
- HTTP routing — `src/execution/http-handler.ts`, `src/execution/server.ts`
- Business orchestration — `src/execution/service.ts` (**1603 lines**)
- Job lifecycle — `src/execution/job-lifecycle.ts`, `src/execution/lifecycle/*`
- Persistence — `src/execution/progress-store.ts`, `src/execution/session-manager.ts`
- Recovery — `src/execution/recovery-core.ts` + `src/execution/lifecycle/recovery-actions.ts`
- Simulation — `src/execution/simulation/*`
- Discuss / KB glue — `src/execution/discuss-tools.ts`, `src/execution/kb-tools.ts`

`.claude/rules/design-philosophy.md` labels all of this "L1" in the layering rules, but it is really 3–4 sub-layers welded together. `service.ts:ExecutionService` is a god class — orchestrates launch + workflow + app-server continuity + interruption + error handling + session mutation in one place. The CoralFault refactor placed `handleWorkflowError` (lines 1585-1603) next to `handleInterruptedAppServer` (lines 516-655), highlighting how loosely related concerns co-habitate.

**Elegant form**:
```
src/
  ├─ http/          ← pure HTTP routing (imports service)
  ├─ orchestration/ ← launch, workflow, queue (lean)
  ├─ lifecycle/     ← job state machine (partial exists today)
  ├─ recovery/      ← recovery-core + recovery-actions (relocated)
  ├─ persistence/   ← progress-store, session-manager, atomic io
  └─ simulation/    ← as-is
```

Each directory single-responsibility, boundary obvious to readers and to `architecture-boundary.test.ts`.

**ROI**: ⭐⭐⭐⭐⭐ (high, medium cost)
**Cost**: mostly file relocation + import path updates; 2–3 days work; every future refactor inherits the cleaner layering.

---

## 2. `TerminalResult` still has mixed-concern fields

**Current evidence** (`src/shared/types.ts:194-211`):
```ts
interface TerminalResult {
  content: string;           // payload
  outcome: TerminalOutcome;  // state (this refactor made it typed)
  durationMs?: number;       // metadata
  nonResumable?: boolean;    // ⚠ resumability policy in result shape
  exitCode?: number | null;  // ⚠ redundant with outcome.provider_exit.code
  warnings?: string[];       // sidecar
  usage?: UsageSummary;      // sidecar
  workflow?: WorkflowResultMeta; // ⚠ provider-vs-workflow bifurcation residue
}
```

**Ugliness points**:
- `exitCode` — plan flagged it as "no longer load-bearing for outcome decision" yet kept it. Now redundant with `outcome.provider_exit.code`. Two fields carry the same information with subtly different semantics.
- `nonResumable` — a session policy bit that survives in the result shape only because recovery/discuss/wait readers consume it after completion. Belongs on `SessionEntry`, not `TerminalResult`.
- `workflow?: WorkflowResultMeta` — "is this job a workflow" flag. Job polymorphism leaking into the generic contract.

**Elegant form** (Vision B — "a job is a tree"):
```ts
interface JobResult {
  content: string;
  outcome: TerminalOutcome;
  durationMs: number;
  children?: JobResult[]; // present for workflow jobs
}
```

- Leaf jobs = provider execution; internal nodes = workflow atoms.
- `nonResumable` moves to `SessionEntry.isResumable()` (or a dedicated `SessionState`).
- `exitCode` lives only on `outcome.provider_exit.code`.
- `warnings`/`usage` move to a separate `JobDiagnostics` sidecar loaded on demand.
- Workflow executor + `handleWorkflowError` collapse into the same error path (typed `workflow_atom_failed` already carries `step`/`atom`).

**ROI**: ⭐⭐⭐⭐ (high, medium cost)
**Cost**: touches every TerminalResult consumer; recovery and session-manager need reshape; migration story needs care (but non-legacy discipline from recent refactor applies here too).

---

## 3. Provider layer has three overlapping paths

**Current evidence**:
Same "provider call" is implemented three ways:
- `src/providers/claude/adapter.ts` (exec adapter) — single-shot CLI run
- `src/providers/claude/session-driver.ts` (session driver) — appserver JSON-RPC
- `src/providers/app-server/runner.ts` (lifecycle runner) — session lifecycle + interruption

Each provider picks a combination. `runner.ts:66-83` **overwrites** `driver.finalize`'s outcome to ensure uniform `provider_request_failed` mapping (introduced in this refactor). That overwrite is an architectural hint: two layers compete for failure-mapping ownership.

**Elegant form** (Provider = `AsyncIterable<ProviderEvent>` + middleware stack):
```ts
type Provider = (req: ProviderRequest, rt: ProviderRuntime) =>
  AsyncIterable<ProviderEvent>;

const claudeProvider = compose(
  appServerMiddleware,    // JSON-RPC lifecycle (optional)
  sessionContinuity,      // conversationRef tracking
  adapterParseGuard,      // adapter_output_unparseable mapping
  claudeExec,             // pure execution kernel
);
```

- The three current paths collapse into one contract.
- App-server session continuity, abort, parse-guard become standalone middlewares.
- `finalize` / outcome-overwrite contention disappears.
- `provider_request_failed` / `provider_session_unavailable` / `adapter_output_unparseable` are emitted by the middleware that owns the concern — no cross-layer coupling.
- Adding a new provider is declaring its middleware stack, not authoring three parallel modules.

The CoralFault ADT landed in this refactor **is the right substrate** for this vision: failures are now typed values, so middleware composition is tractable.

**Pattern precedent**: Redux middleware, Express router, React Server Components composition.

**ROI**: ⭐⭐⭐⭐ (high, high cost)
**Cost**: major rewrite of provider contract; but possible to prototype on one provider (codex?) first and converge incrementally.

---

## 4. Persistence = 6 files per job → complexity

**Current evidence** (per `<os-tmpdir>/coral-jobs/<jobId>/`):
```
status.json      ← phase + result
progress.jsonl   ← append-only event stream
launch.json      ← request snapshot
runtime.json     ← wrapper process info
exit.json        ← exit metadata
result.md        ← durable artifact
```

Six files, each encoding a partial view. `recovery-core.ts:74-140` has a 10+ row classifier table because each combination of file presence/absence carries different meaning. The classifier's complexity is a symptom of the fragmentation.

**Elegant form** (Vision A — event-sourced single log):
```
~/.coral/namespaces/<ns>/events.jsonl     (append-only)
~/.coral/namespaces/<ns>/snapshots/       (periodic projection cache)
```

- All state (job, session, discuss, KB) projected from the log.
- Recovery = "replay events since last snapshot" — not a classifier.
- Time-travel debugging is free.
- Cross-job queries (e.g., "all jobs in project X that errored in the last hour") become projection queries.
- `src/discuss/` already demonstrates this pattern — pure reducer + events + projections. Generalize.

**Costs**:
- Log compaction strategy required.
- Query performance depends on projection cache architecture.
- Big rewrite of progress-store + session-manager.

**ROI**: ⭐⭐⭐ (very high ceiling, very high cost)
**Why not ⭐⭐⭐⭐**: the rewrite is weeks of work; the current multi-file model works. But this is the structural answer to "why is recovery complicated?" — and deserves serious thought for coral's next major version.

---

## 5. `src/shared/` is a catch-all

**Current evidence** (`src/shared/` contents):
```
types.ts                 (600+ lines, multi-domain)
utils.ts
schemas.ts
sse-parser.ts
persistence-parsers.ts   (NEW this refactor)
coral-fault.ts           (NEW this refactor)
execution-contracts.ts
request-context.ts
env-sanitize.ts
node-process.ts
test-deferred.ts
```

Anything that did not fit elsewhere ended up here. `types.ts` mixes TerminalResult, PersistedStatusRecord, WaitStreamEvent, JobPhase, LaunchState across multiple domains.

**Elegant form** — split by domain:
```
src/contracts/
  ├── job/           job, outcome, coral-fault (from this refactor)
  ├── session/       session types, runtime
  ├── wait/          SSE types, cursor
  └── provider/      ProviderResult, ProviderRequest
src/infra/
  ├── atomic-io/
  ├── sse-parser/
  └── process/
```

Types live with their domain; utilities live with infra.

**ROI**: ⭐⭐⭐⭐ (medium elegance gain, low cost)
**Cost**: one day of file relocation + import rewrites. Great easy win that makes finding #1 (`src/execution/` split) easier by establishing the "domain vs infra" pattern.

---

## 6. CLI ↔ Backend always HTTP, even locally

**Current evidence**: every CLI invocation goes through `localhost` HTTP with auth token. `ensureBackend()` spins up a daemon on first contact. Good for future multi-client support (coral-reef); costly for one-shot synchronous ops.

**Elegant form**: backend becomes a library. CLI links directly in local mode; `--server` flag flips to HTTP for multi-client scenarios.
```
CLI (local mode)         → ExecutionService (direct library call)
CLI --server             → HTTP client → HTTP server → ExecutionService
```

The split already exists at the code level (`src/execution/service.ts` is a pure API). Every CLI path currently *forces* HTTP, though.

**Tradeoff**: the daemon's persistent state (live jobs, session cache, provider host pool) is load-bearing for multi-CLI-invocation workflows (e.g., `codex -d` then `wait`). Removing HTTP for these loses that coordination.

**ROI**: ⭐⭐ (low — latency gain only; multi-client future is already designed)
**Why track it**: worth noting the trade is explicit, not accidental.

---

## Priority Summary

| # | Improvement | Elegance gain | Cost | Priority |
|---|-------------|--------------|------|----------|
| A | Split `src/execution/` | Medium | Medium (relocation) | ⭐⭐⭐⭐⭐ |
| B | TerminalResult cleanup (drop `exitCode`, relocate `nonResumable`, job tree) | Large | Medium | ⭐⭐⭐⭐ |
| C | Provider = AsyncIterable + middleware composition | Very large | Large | ⭐⭐⭐⭐ |
| D | Event-sourced unified persistence | Maximum | Very large | ⭐⭐⭐ |
| E | `src/shared/` domain split | Medium | Low | ⭐⭐⭐⭐ |
| F | CLI direct-link mode | Low | Low | ⭐⭐ |

**Immediate candidates (extending the current refactor arc)**:
- **E** (`shared/` decomposition): one day, file moves + imports. Makes A easier.
- **A** (`execution/` split): 2–3 days. Foundational for everything downstream.

**Long-term vision items**:
- **C** (provider middleware): the CoralFault ADT laid the foundation. Failures are now typed, so middleware composition is tractable. Could prototype on one provider first.
- **D** (event sourcing): the structural answer to "why is recovery complex?". Discuss already proves the pattern works in-repo. Weeks of work; coral's next major version material.

**Consider but skip for now**:
- **F**: real win is latency only; multi-client future is already designed.

---

## One unifying idea — "Discuss is the template"

Coral already contains an event-sourced pure domain: `src/discuss/`. state-machine, reducer, events, projections are all pure. The imperative shell lives at `src/execution/discuss/`. This *is* the model for the CoralFault refactor's success and points to a broader pattern.

**Vision: converge every subsystem to this shape.**
```
src/<domain>/            ← pure L0 core (reducer, events, types)
src/execution/<domain>/  ← imperative shell (I/O, persistence glue)
src/<domain>-contracts/  ← wire schemas (Zod)
```

If applied universally:
- Every subsystem has the same shape — readability compounds.
- Adding a new subsystem is copying the template.
- Testing strategy unifies: pure = unit, shell = integration.
- Event sourcing comes for free.
- `recovery-core.ts`'s complexity disperses into per-domain reducers.

Today's reality:
- **discuss** — full fit ✓
- **kb** — pure core + glue, not event-sourced
- **provider** — no pure core; three overlapping impl paths
- **workflow** — parser pure-ish; executor deeply imperative
- **job lifecycle** — lifecycle is imperative, no pure core

Gap between current and this vision is where the biggest structural improvements live. Finding #3 (provider middleware) and finding #4 (event-sourced persistence) are both partial expressions of this unification.

---

## Next moves

Use this doc as seed for future `/coral:plan` sessions. Suggested sequence if taking on gradually:

1. `/coral:plan` on **E** (shared/ split) — quick win, clears the ground.
2. `/coral:plan` on **A** (execution/ split) — foundational, unlocks rest.
3. `/coral:plan --deep --codex` on **B** (TerminalResult cleanup + job tree) — largest immediate elegance gain in the result model.
4. Consider **C** and **D** when there's appetite for a structural bet.

End of diagnosis.
