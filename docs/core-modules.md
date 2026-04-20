# Core Modules

A high-level map of what each area of the codebase is for. This document describes stable seams — composition roots, domain facades, and public contracts. Implementation files evolve inside each area without requiring doc updates.

## Composition Roots

| Entry | Bundle | Role |
| --- | --- | --- |
| Backend composition root | `bridge/coral-backend.cjs` | Backend daemon bootstrap. Wires runtime ports, identity metadata, domain facades, lifecycle, and IPC/HTTP transport routes. |
| CLI entrypoint | `bridge/coral-cli.cjs` | Commander-based CLI client that uses IPC for mutating/live work, reads `CoralStore` directly for no-coordinator paths, and retains HTTP for the remote gateway plus operational carveouts. |
| Claude appserver helper | `bridge/coral-claude-appserver.cjs` | Runtime for the Claude appserver-hosted provider lane. |

## CLI and Client

The CLI parses commands, follows detached launches via the `jobs.wait` IPC subscription, and formats output for humans and machines. The client layer owns backend startup, IPC dispatch/subscriptions, direct `CoralStore` read helpers for no-coordinator paths, and the HTTP gateway/admin helpers exposed through the public barrel.

## Backend

The backend is a composition root, not a domain. Phase 3 splits that root into a coordinator layer and a transport layer: the coordinator owns lifecycle, startup recovery, projection freshness, corpus notify publication, and cross-domain assembly; transport owns IPC plus HTTP/SSE parsing, validation, and wire formatting. New domain logic does not land in either layer; it stays in its owning domain and is reached through an explicit facade.

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

The coordinator layer owns process lifecycle, startup reconcile sequencing, ConsumerDriver freshness, provider-host coordination, and the corpus notify seam. It is the only place allowed to compose multiple domains together and the only place that speaks to both transport and domain facades at once.

## Shared and Infrastructure

Shared helpers sit below every domain — schemas, utilities, SSE parsing, cross-process locking, file tailing, child-env construction, legacy compat bridges. Infrastructure resolves canonical paths, build flavor, and backend connection info.

## Dependency Outline

```text
CLI
  -> client helpers
     -> transport IPC/HTTP routes
  -> CoralStore library reads (read-only no-coordinator commands)

transport IPC/HTTP routes
  -> coordinator API + control ports
  -> domain facades (workflow / discuss / KB)

coordinator API
  -> jobs domain facade
  -> sessions domain facade
  -> provider adapters
  -> live launch / host management
  -> provider host manager

coordinator startup
  -> Journal open
  -> consumer-driver freshness drain
  -> domain reconcile surfaces (in sequence)

discuss shell
  -> discuss pure core
  -> Journal append via the domain's store-registry

KB runtime
  -> corpus publication + notify seam

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
