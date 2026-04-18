# Core Modules

A high-level map of what each area of the codebase is for. This document describes stable seams — composition roots, domain facades, and public contracts. Implementation files evolve inside each area without requiring doc updates.

## Composition Roots

| Entry | Bundle | Role |
| --- | --- | --- |
| Backend composition root | `bridge/coral-backend.cjs` | Backend daemon bootstrap. Wires runtime ports, identity metadata, domain facades, lifecycle, and HTTP routes. |
| CLI entrypoint | `bridge/coral-cli.cjs` | Commander-based CLI client that talks to the backend over HTTP + SSE. |
| Claude appserver helper | `bridge/coral-claude-appserver.cjs` | Runtime for the Claude appserver-hosted provider lane. |

## CLI and Client

The CLI parses commands, follows detached launches via SSE, and formats output for humans and machines. The client layer owns backend startup, HTTP dispatch, and wait/admin helpers, and exposes a public barrel for external consumers.

## Backend

The backend is a composition root, not a domain. It resolves identity metadata, sets up the Runtime world, instantiates per-caller execution services, wires the domain facades, applies the startup projection drain and reconcile sequence, and registers HTTP routes. Post-Phase 2 the `src/execution/` tree holds composition, transport, simulation, and KB residue awaiting handoff to `src/coordinator/**` (Phase 3), `src/transport/**` (Phase 4), and `src/simulation/**` (Phase 7). New domain logic does not land in `src/execution/`.

## Runtime

The backend uses a **single Runtime world** pattern: one interface with a fixed set of I/O subports (time, storage, paths, process, ids, env), swapped once at composition. Every I/O-touching module routes through it. The real runtime is used in production; a deterministic counterpart powers the simulation lane.

## Journal

The Journal is the event-sourced truth spine for all domain state. It provides append, rebuild, envelope + upcaster, and projection-reducer dispatch primitives backed by SQLite in WAL mode. The read surface is publicly exported; write primitives stay internal to the substrate. Upcasters run on read, not on write — stored bytes are raw input bytes at their declared body version.

## Domains

Each domain is self-contained: its own contract (events, projection, read-models), its own functional core (pure state transitions), its own imperative shell (persistence, loop control, external effects), and a single coordinator-facing facade (commands / queries / reconcile or the domain-appropriate equivalent). Domains do not import each other; cross-domain composition happens at the backend layer only.

| Domain | Responsibility |
| --- | --- |
| Jobs | Job lifecycle truth — launch, admit, wait, abort, terminal outcome, cause references, startup reconciliation, cross-namespace adoption. |
| Sessions | Session persistence and continuity — open, checkpoint, interrupt, provider failure, close, atomic storage, lookup by id or ref. |
| Workflow | DSL parsing, plan compilation, pipeline execution (launch and retry intertwined), drain handling, resume-from-projection. |
| Discuss | Multi-agent discussion loop — pure state machine at the core, imperative shell around it for persistence, bids, speeches, follow-ups, synthesis, and snapshots. |

## Provider Adapters

Provider adapters translate between the domain contract and external CLIs (Codex, Claude, the Claude appserver helper). Adapter-level changes must preserve wire-compatibility with the adapted provider. Renamed `Legacy*` compat types bridge the adapter seam until the matching phase retires them.

## Knowledge Base

The KB domain owns text and vector search, note mutation, memo and source lifecycle, and background curation (community detection, entity consolidation). HTTP routing for `/kb/*` lives at the backend layer and delegates to the domain.

## Coordinator

The coordinator layer owns Journal consumer driving (stream-kind authority, cursor management, drain coalescing) and, from Phase 3 onward, the live-coordinator shells extracted from the backend composition.

## Shared and Infrastructure

Shared helpers sit below every domain — schemas, utilities, SSE parsing, cross-process locking, file tailing, child-env construction, legacy compat bridges. Infrastructure resolves canonical paths, build flavor, and backend connection info.

## Dependency Outline

```text
CLI
  -> client helpers
     -> backend HTTP routes

backend HTTP routes
  -> execution service (dispatcher)
  -> domain facades (workflow / discuss / KB)

execution service
  -> jobs domain facade
  -> sessions domain facade
  -> provider adapters
  -> launch engine (pool mechanics only)
  -> provider host manager

lifecycle startup
  -> Journal open
  -> projection rebuild (one-shot drain)
  -> domain reconcile surfaces (in sequence)

discuss shell
  -> discuss pure core
  -> Journal append via the domain's store-registry

KB bridge
  -> KB domain

shared / infra
  -> lowest common layer reused everywhere
```

## Stable Seams

These are the load-bearing boundaries that must not leak:

- The Runtime interface is the only channel for I/O inside the backend.
- Each domain facade is the only coordinator-facing surface for its domain.
- The Journal read surface (`CoralStore`) is publicly exported; write primitives are internal.
- Hooks never import from `src/`; shared hook logic lives alongside the hooks themselves.
- Renamed `Legacy*` compat bridges live at the provider seam with declared retirement phases.
