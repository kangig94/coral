import { observeCoordinator } from './coordinator-observation.js';
import { readBuildFlavor } from '../../../infra/bundle-manifest.js';
import { createRealRuntime } from '../../../runtime/real.js';
import { HEALTH_TIMEOUT_MS, parseJsonResponse } from '../sse.js';
import { errorMessage, thrownErrnoCode } from '../../../infra/error-format.js';
import { isRecord } from '../../../infra/json.js';
import { isCoralChildEnvironment } from '../../../security/child-principal-env.js';

/**
 * `reason` is a closed set the CLI renders; `detail` carries whatever was observed behind it.
 *
 * Adding a literal here alone fails to compile in `SHUTDOWN_REFUSAL_EXIT_CODES` (`cli/commands/backend.ts`), a
 * `Record` keyed on every `ShutdownReason` — `ShutdownResult`'s variants each name their own reason
 * independently of this type, so `formatShutdown`'s exhaustiveness switch only reacts once a matching
 * `ShutdownResult` variant is added too. `_shutdownReasonsStaySynced` below is what keeps this union and
 * `ShutdownResult`'s reasons from drifting apart silently in the meantime. A producer with something to say
 * puts it in `detail`; `reason` is never prose.
 */
export type ShutdownReason =
  | 'nested_child'
  | 'unreadable_record'
  | 'no_record'
  | 'no_record_socket_present'
  | 'recorded_process_absent'
  | 'socket_refused'
  | 'refused_by_response'
  | 'no_response'
  | 'capability_rejected';

/** `observeCoordinator`'s own prior finding — never `'absent'` here, because an absent pid short-circuits to `recorded_process_absent` before any request is sent. */
type PidLiveness = 'alive' | 'unknown';

/**
 * `pidLiveness` is scoped to exactly the two members that need it, not carried as an optional field on the
 * shared `ok: false` shape:
 *
 * - `capability_rejected`: a 401 proves a coordinator answers at the recorded address and rejected our token;
 *   it proves nothing about the recorded pid specifically beyond what `observeCoordinator` already found before
 *   this request was sent, so the render layer must not promise more certainty about the pid than that.
 * - `socket_refused`: the opposite observation — nothing answered at all — and the pid was already known not
 *   to be `'absent'` (see above), so a refused connection is never grounds for "not running" on its own: the
 *   deterministic window is a coordinator's HTTP listener closing at the top of its drain while its process,
 *   already confirmed alive, keeps running through IPC close and the store finalizers — see
 *   `src/coordinator/shutdown.ts` for the drain ordering that opens this window.
 *
 * A member split on a *subset* of `reason`'s literals does not defeat exhaustiveness narrowing: `formatShutdown`
 * calls `assertNever(result)` — the whole, already-narrowed result, as `formatBackendStatus` already does five
 * lines above it — not `assertNever(result.reason)`. Verified against this repo's own `tsc --strict`:
 * `assertNever(result.reason)` fails to compile in the `default` arm with `TS2339: Property 'reason' does not
 * exist on type 'never'` — narrowing already collapsed `result` itself to `never` there, so reading `.reason`
 * off it is the error, not a live exhaustiveness gap. `assertNever(result)` compiles clean today and still
 * fails to compile the moment a new `reason` literal is added without a case for it.
 */
export type ShutdownResult =
  | { ok: true; alreadyDraining?: true }
  | { ok: false; reason: 'nested_child' }
  | { ok: false; reason: 'unreadable_record'; detail: string }
  | { ok: false; reason: 'no_record' }
  | { ok: false; reason: 'no_record_socket_present' }
  | { ok: false; reason: 'recorded_process_absent'; detail: string }
  | { ok: false; reason: 'socket_refused'; pidLiveness: PidLiveness }
  | { ok: false; reason: 'refused_by_response'; detail: string }
  | { ok: false; reason: 'no_response'; detail: string }
  | { ok: false; reason: 'capability_rejected'; detail: string; pidLiveness: PidLiveness };

/**
 * `formatShutdown`'s `assertNever(result)` (`cli/format/backend.ts`) catches a `ShutdownReason` missing its
 * sentence; nothing catches these two literal unions themselves drifting apart, since each is declared by
 * hand. `_shutdownReasonsStaySynced` fails to compile the moment either one names a reason the other does not.
 */
type ShutdownResultReason = Exclude<ShutdownResult, { ok: true }>['reason'];
type ReasonSetsMatch<A extends string, B extends string> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _shutdownReasonsStaySynced: ReasonSetsMatch<ShutdownReason, ShutdownResultReason> = true;

function isShuttingDownError(value: unknown): value is { code: 'backend_shutting_down' } {
  return isRecord(value) && value.code === 'backend_shutting_down';
}

function isShutdownAccepted(value: unknown): boolean {
  return isRecord(value) && (value.status === 'draining' || value.status === 'shutting_down');
}

/**
 * What a resolved (non-throwing) `fetch` to `/admin/shutdown` means, once its body has been read. Split out of
 * `shutdownBackend` because this is the half that fans out over HTTP status/body shape; the exception half
 * below it is a different kind of evidence (no response at all) and reads better kept apart from it.
 */
function classifyShutdownResponse(
  response: Response,
  body: unknown,
  info: { readonly pid: number },
  pidLiveness: PidLiveness,
): ShutdownResult {
  if (response.status === 200 && isShutdownAccepted(body)) {
    return { ok: true };
  }
  if (response.status === 503 && isShuttingDownError(body)) {
    return { ok: true, alreadyDraining: true };
  }
  if (response.status === 401) {
    // The pid travels with the refusal because it is the only thing an operator can act on here. A coordinator
    // answered and rejected the token from our own discovery record, so nothing this command offers will get
    // in — and a refusal that names no exit is the shape §11 forbids. `pidLiveness` is `observeCoordinator`'s
    // own prior finding: the 401 confirms the address, not that pid specifically.
    return { ok: false, reason: 'capability_rejected', detail: String(info.pid), pidLiveness };
  }
  // Something answered at the address our own record names and did not accept the shutdown. That is the same
  // observation `getBackendStatusFull` reports as `unreachable` for a resolved response.
  return { ok: false, reason: 'refused_by_response', detail: `${response.status} ${response.statusText}` };
}

export async function shutdownBackend(pluginRoot: string): Promise<ShutdownResult> {
  const runtime = createRealRuntime(readBuildFlavor(pluginRoot));
  if (isCoralChildEnvironment(runtime.env.fullSnapshot())) {
    return {
      ok: false,
      reason: 'nested_child',
    };
  }
  const observed = observeCoordinator({ storage: runtime.storage, env: runtime.env, paths: runtime.paths });
  switch (observed.kind) {
    case 'unreadable-record':
      // Not an absent coordinator: reporting one would skip a shutdown request a live daemon is waiting for.
      return { ok: false, reason: 'unreadable_record', detail: observed.reason };
    case 'no-record':
      return { ok: false, reason: 'no_record' };
    case 'no-record-socket-present':
      // Refuses rather than guesses: there is no host/port/bootToken to dial without a decoded record, and the
      // evidence does not distinguish a coordinator mid-boot from a stale socket a killed one left behind.
      return { ok: false, reason: 'no_record_socket_present' };
    case 'process-absent':
      return { ok: false, reason: 'recorded_process_absent', detail: String(observed.pid) };
    case 'addressed':
      break;
  }
  const info = observed.coordinator;

  // Reached only for a record this build could read, naming a pid it did not observe absent.
  try {
    const response = await fetch(`http://${info.host}:${info.port}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Boot-Token': info.bootToken },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body = await parseJsonResponse(response);
    return classifyShutdownResponse(response, body, info, observed.pidLiveness);
  } catch (error: unknown) {
    // The request not completing is not the coordinator not being there. A refused connection says nothing was
    // listening on that socket; a timeout, a DNS failure or an aborted request says only that this attempt did
    // not finish. Neither says anything the prior `pidLiveness` observation didn't already say, because an
    // absent pid was already excluded before this request was ever sent (see `case 'process-absent'` above).
    //
    // Node's `fetch` rejects a refused connection with a `TypeError` whose own `.code` is `undefined`; the
    // errno travels on `.cause` instead (measured: `error.cause.code === 'ECONNREFUSED'`). A timeout rejects
    // with a `DOMException` whose `.code` is the *number* `23` — not an errno, and not safe to print as one.
    const code = thrownErrnoCode(error);
    if (code === 'ECONNREFUSED') {
      return { ok: false, reason: 'socket_refused', pidLiveness: observed.pidLiveness };
    }
    return { ok: false, reason: 'no_response', detail: code ?? errorMessage(error) };
  }
}
