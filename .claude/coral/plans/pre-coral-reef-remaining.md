# Pre-plan: coral-reef-remaining

## Problem Statement
- Current state: coral-reef dashboard infrastructure is complete (EventBus, SSE, DiscussBridge tailer, event-log module, REST API) but three integration seams remain disconnected: (1) discuss event log is never populated because 13 `store.save()` sites bypass the mutation wrapper, (2) `SessionEntry` lacks `projectRoot` so session events and API responses carry no project provenance, (3) `/api/jobs` returns all jobs with no filtering.
- Desired state: All three gaps closed — discuss events flow end-to-end through the SSE pipeline, sessions carry authoritative project provenance, and the jobs API supports phase filtering.

## Success Criteria
- [ ] All 13 `store.save()` call sites in production code (`server-handlers.ts`: 3, `handlers/step.ts`: 8, `handlers/bid.ts`: 2) replaced with `store.persistMutation()` calls that construct appropriate `machineEvents[]` and `WatermarkMeta`
- [ ] `store.save()` removed or made private/test-only — production discuss code has a single persistence path through `persistMutation()`
- [ ] Discuss event log (`events.jsonl`) is populated with correct `kind`, `seq`, `sessionId`, `topic`, `projectRoot`, `ts`, and `payload` for every state transition
- [ ] DiscussBridge tailer picks up events written by `persistMutation()` and they appear on the SSE stream as `discuss:event`
- [ ] `SessionEntry` interface includes `projectRoot?: string`
- [ ] `SessionManager.allocate()` accepts and persists `projectRoot`
- [ ] `session:updated` EventBus event carries `projectRoot`
- [ ] `/api/sessions` response includes `projectRoot` for new sessions (legacy sessions without it show `provenanceState: 'legacy_unresolved'` via lenient reader — already implemented)
- [ ] `GET /api/jobs` supports `?phase=running` (and other phase values) query parameter
- [ ] All existing discuss tests pass without modification (state machine logic unchanged)
- [ ] All existing execution tests pass
- [ ] Build clean in both coral and coral-reef

## Scope
- **Included**:
  - `src/discuss/session-store.ts` — restrict `save()` to test-only or remove
  - `src/discuss/server-handlers.ts` — 3 `store.save()` → `store.persistMutation()` with events
  - `src/discuss/handlers/step.ts` — 8 sites
  - `src/discuss/handlers/bid.ts` — 2 sites
  - `src/discuss/event-log.ts` — `WatermarkMeta` management helpers if needed
  - `src/execution/session-manager.ts` — add `projectRoot` to interface and `allocate()`
  - `src/execution/service.ts` — pass `projectRoot` to `allocate()` calls (3 sites)
  - `src/execution/server.ts` — add `?phase=` filter to `/api/jobs`
  - Tests for new behavior
- **Excluded**:
  - Discuss state machine logic (`state-machine.ts`) — zero changes
  - coral-reef repo — no changes needed (it already consumes events generically)
  - Discuss discovery metadata — out of scope
  - Watermark drift detection on load/rescan — deferred to separate task

## Assumptions
- `store.persistMutation()` already exists and works correctly (confirmed: `session-store.ts:113-134`)
- `appendEvents()` in `event-log.ts` works correctly (confirmed: unit tested)
- The `WatermarkMeta` type is already defined (`event-log.ts:33-37`)
- Each `store.save()` site has enough context to construct the appropriate `DiscussMachineEvent` — the state-machine pure functions return enough information about what transition occurred
- Changing `allocate()` signature from 4 args to 5 is safe because all 3 call sites in `service.ts` already have `ctx.projectRoot` available
- Test files use `store.save()` for setup convenience — these can remain as-is (test-only path)

## Affected Systems
- **Discuss MCP server** (`server-handlers.ts`, `handlers/step.ts`, `handlers/bid.ts`): every mutation site changes from `store.save()` to `store.persistMutation()`. The state machine functions themselves are untouched.
- **SessionStore** (`session-store.ts`): `save()` may be restricted to test-only visibility
- **SessionManager** (`session-manager.ts`): `SessionEntry` interface gains `projectRoot`; `allocate()` signature changes
- **ExecutionService** (`service.ts`): passes `projectRoot` to `allocate()`
- **Backend server** (`server.ts`): `listAllJobs()` gains phase filter; `session:updated` EventBus payloads gain `projectRoot`
- **DiscussBridge** (`discuss-bridge.ts`): no changes needed (already tails `events.jsonl`)
- **coral-reef indexer** (`cold-scan.ts`, `sse-client.ts`): no changes needed (already handles `discuss:event` and session fields)

## Constraints
- **Discuss core logic untouched**: `state-machine.ts` must not be modified. All changes are at the persistence boundary (between state-machine pure functions and `SessionStore`).
- **Event kind mapping must be explicit**: Each `store.save()` site must explicitly declare which `DiscussMachineEventKind` it represents. No inference from state diffs.
- **Backward compatibility**: Existing `state.json` files without `_watermark` must still load correctly (already handled in `SessionStore.load()` at line 93-96).
- **Existing sessions without `projectRoot`**: Must not break `SessionManager.readEntry()` strict validation — field is optional.

## Approach Direction
- Convert all 13 production `store.save()` calls to `store.persistMutation()` with explicit `machineEvents[]` construction at each call site
- Each call site knows what transition it represents (e.g., `applyBid` → `bid_recorded`, `applySpeechTimeout` → `speech_timeout`, `applyEnd` → `session_ended`)
- Manage `WatermarkMeta.lastDurableSeq` via a helper that reads current max seq from event-log before each mutation batch
- Keep `store.save()` accessible for tests but not for production code paths

## Additional Context
- The `readMaxSeq()` function in `event-log.ts` already reads the current high-water mark, which can seed `WatermarkMeta.lastDurableSeq` for each mutation.
- The 13 mutation sites break down by semantic kind:
  - `created` (1): `server-handlers.ts:209` — session init
  - `bidding_started` (1): `step.ts:71` — setup → bidding transition
  - `bid_recorded` (1): `bid.ts:120` — agent bid applied
  - `speech_recorded` (1): `bid.ts:166` — agent speech applied
  - `round_resolved` (2): `step.ts:248,253` — winner resolved / epoch transition
  - `speech_timeout` (1): `step.ts:120` — force_stop timeout
  - `agents_expelled` (1): `step.ts:173` — expel pending bidders
  - `session_ended` (3): `step.ts:61,266` + `server-handlers.ts:77` — various end reasons
  - `epoch_summary_recorded` (1): `server-handlers.ts:247` — epoch summary
  - `pending_since_update` (1): `step.ts:180` — sets `pending_since_ts`, may not need an event (bookkeeping only)
- The `step.ts:180` site (`store.save(ctx.sessionDir, next)`) is a `pending_since_ts` bookkeeping write. Not a semantic state transition, but must persist across `_3_step` calls for expel TTL calculation. Converted to `persistMutation()` with empty `machineEvents[]` for consistent single persistence path.
