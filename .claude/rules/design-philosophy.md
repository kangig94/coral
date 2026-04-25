# Design Philosophy

## Core Principles

1. **Clean-Slate Ownership**: The rewrite branch does not preserve legacy paths, aliases, compatibility shims, or transitional facades for convenience. If ownership moves, the old path is deleted and guarded by invariants.

2. **One Coordinator, Two Authorities**: The coordinator owns live orchestration and recovery. The Journal owns process-like event truth. The Corpus owns KB markdown content. Derived projections and equipment state are rebuildable consumers, not authority.

3. **Functional Core / Imperative Shell**: Domains own pure event vocabulary, reducers, read contracts, and shell-local orchestration. Cross-domain assembly happens only through coordinator composition and explicit owner contracts.

4. **Single Runtime World**: Backend I/O flows through the Runtime ports selected at composition. Domains and coordinator services receive time, storage, paths, process, ids, and env through ports instead of reading ambient state.

5. **Causal Faults**: Failure truth lives once on the originating stream. Job terminals point with `causeRef`; they do not wrap domain fault payloads. `JobLifecycleFault` is reserved for wrapper-local failures with no originating domain event.

6. **Hooks Stay Self-Contained**: Hook scripts are Node.js ESM modules. They read stdin, write `hookSpecificOutput` when active, fail open, and never import from `src/`.

7. **No Ambiguity**: Every concept has exactly one canonical home. Two files that "could" hold the same thing — even if currently different — get forgotten with 100% probability in future development, and the more generic-named file absorbs everything. Apply this both ways:
   - **Never create a content-blank file** (`paths.ts`, `helpers.ts`, `utils.ts`, `shared.ts`) — names that describe nothing about content invite "anything that fits" and accumulate unrelated logic. A *domain-prefixed* sibling (`exec-types.ts`, `manifest-types.ts`, `driver-types.ts`) is allowed: the prefix declares scope, so the file resists drift.
   - **`index.ts` and `types.ts` ARE allowed anywhere** — both are conventional names with clear semantics (entry point, type vocabulary), and the parent directory provides scope. Discipline is on *content*, not *name*: by default split implementation across siblings; when either file grows large or loses cohesion, MUST split. Add a per-file size invariant in `tests/invariants/architecture-boundary.test.ts` when a specific file is at risk (see `providers/contract.ts` 450-line cap as precedent).
   - **Never split a single concept across two files** unless a cycle physically forces the split, and document the cycle when it does (e.g. `manifest-types.ts` exists only to break a `kb/contracts.ts ↔ manifest-authority.ts` cycle).
   - When you find a content-blank file, redistribute its contents to per-domain modules and add an invariant asserting the file does not return (see `tests/invariants/architecture-boundary.test.ts` for the `infra/paths.ts` precedent).

## Source Tree Policy

| Area | Responsibility | Modification Rule |
|------|----------------|-------------------|
| CLI | User command parsing, local startup glue, output formatting | No backend/domain truth. Mutating and live commands go through IPC; no-coordinator reads use explicit read surfaces. |
| Backend composition | Daemon bootstrap | Wires runtime ports, coordinator services, domain owner modules, and transport. New domain behavior does not land here. |
| Domains (`jobs` / `sessions` / `discuss` / `workflow`) | Domain event vocabulary, schemas, reducers, read contracts, and imperative shells | Domains expose explicit owner modules/contracts. Avoid `api.ts` barrels and compatibility facades. |
| Provider adapters | External CLI/appserver protocol adaptation | Preserve provider wire semantics while staying on canonical domain types. |
| Journal / store | SQLite schema, append, rebuild, envelope decode, upcasters, projection dispatch | Store runs composed domain validators; it does not own product read APIs or domain policy. |
| Read model | Product read facade and cause-ref describer composition | No writes, no recovery, no ambient root selection. |
| Causality | `CauseRef` vocabulary and renderer walk | No store access and no domain imports; domains inject describers through read-model composition. |
| Runtime / infra | Low-level paths, flavor, I/O ports, JSON/error/text helpers | No domain concepts and no dumping ground for owner-specific helpers. |
| Coordinator | Lifecycle, startup ordering, ConsumerDriver freshness, equipment slots, provider-host coordination, coordinator-owned KB jobs | The only layer allowed to compose multiple domains and transport at once. It must not own domain vocabulary. |
| Transport | IPC + HTTP/SSE parsing, validation, response mapping | Carriage only. Depends on coordinator/domain contracts, not domain shells. |
| KB | Corpus authority, query semantics, source/memo/note operations, retrieval backend contracts | Does not own coordinator equipment slot assignment. |
| Agents / skills | Claude-native agent definitions and slash-command skills | Invoke CLI surfaces rather than backend internals. |
| Bridge | Generated build artifacts | Do not edit directly. |
| Docs | Architecture and module documentation | Update together with ownership, API, or behavior changes. |

Key rules:

1. Deleted legacy paths stay deleted; do not recreate retired barrels, `src/shared`, `src/client`, or compatibility shims.
2. Lower-level modules do not import entrypoints or composition roots.
3. Cross-domain dependencies must be explicit contracts or coordinator composition, not convenience imports.
4. Domain event schemas, reducers, append validators, and describers are owned by the domain that emits the event.
5. Tests and simulation helpers live under `tests/` or `tools/testing/`, never under production `src/`.

## Module Structure

The backend has one composition root; the CLI has its own entry point; plugin skills and hooks invoke CLI surfaces. The coordinator may assemble domain shells and contracts, but domains do not import coordinator implementation modules.

Each domain follows the same shape: event contracts, reducer/projection logic, read contracts, and shell modules for I/O. Shared vocabulary that truly crosses domains lives in a lower owner such as `causality/`, `runtime/`, `store/`, or `infra/`; otherwise it stays with the domain that owns the behavior.

Cause-ref rendering is deliberately split: `causality/` owns the walk and cycle/missing diagnostics, each domain owns its event describer map, and `read-model/event-describers.ts` composes the default map. Adding a domain fault event means adding a domain event schema and domain describer, not editing a central fault union.
