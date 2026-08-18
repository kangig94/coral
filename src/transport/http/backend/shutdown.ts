import { observeCoordinator } from './coordinator-observation.js';
import { readBuildFlavor } from '../../../infra/bundle-manifest.js';
import { createRealRuntime } from '../../../runtime/real.js';
import { HEALTH_TIMEOUT_MS, parseJsonResponse } from '../sse.js';
import { errorMessage } from '../../../infra/error-format.js';
import { isRecord } from '../../../infra/json.js';
import { isCoralChildEnvironment } from '../../../security/child-principal-env.js';

/**
 * `reason` is a closed set the CLI renders; `detail` carries whatever was observed behind it.
 *
 * Two `ok: false` cases an operator most needs told apart used to share one spelling — `not_running` was
 * returned both for a socket that refused a connection and for a request that never finished — and the split
 * was then flattened again into a raw token at the render layer.
 *
 * The set is closed so that cannot come back. While `reason` was `string`, `formatShutdown` could not use the
 * `assertNever` that keeps `formatBackendStatus` exhaustive, so a seventh token would have compiled, fallen
 * through to a raw-token render, and broken no test. Two producers were also using this field as prose, which
 * is what made it look like it had to stay open; their sentences live in `detail` now.
 */
export type ShutdownReason =
  | 'nested_child'
  | 'unreadable_record'
  | 'no_record'
  | 'recorded_process_absent'
  | 'socket_refused'
  | 'unreachable'
  | 'capability_rejected';

export type ShutdownResult =
  | { ok: true; alreadyDraining?: true }
  | { ok: false; reason: ShutdownReason; detail?: string };

function isShuttingDownError(value: unknown): value is { code: 'backend_shutting_down' } {
  return isRecord(value) && value.code === 'backend_shutting_down';
}

function isShutdownAccepted(value: unknown): boolean {
  return isRecord(value) && (value.status === 'draining' || value.status === 'shutting_down');
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
    if (response.status === 200 && isShutdownAccepted(body)) {
      return { ok: true };
    }
    if (response.status === 503 && isShuttingDownError(body)) {
      return { ok: true, alreadyDraining: true };
    }
    if (response.status === 401) {
      // The pid travels with the refusal because it is the only thing an operator can act on here. The
      // coordinator is alive and rejected the token from our own discovery record, so nothing this command
      // offers will get in — and a refusal that names no exit is the shape §11 forbids.
      return { ok: false, reason: 'capability_rejected', detail: String(info.pid) };
    }
    // Something answered at the address our own record names and did not accept the shutdown. That is the same
    // observation `getBackendStatusFull` reports as `unreachable`; this used to render as a bare
    // `Shutdown failed: 500 Internal Server Error`, so one fact carried opposite implications in two commands.
    return { ok: false, reason: 'unreachable', detail: `${response.status} ${response.statusText}` };
  } catch (error: unknown) {
    // The request not completing is not the coordinator not being there. A refused connection says nothing was
    // listening on that socket, which is the closest thing here to an observed absence; a timeout, a DNS
    // failure or an aborted request says only that this attempt did not finish, and reporting `not_running`
    // for those tells an operator their daemon is stopped at the moment it is least likely to be.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ECONNREFUSED') {
      return { ok: false, reason: 'socket_refused' };
    }
    return { ok: false, reason: 'unreachable', detail: code ?? errorMessage(error) };
  }
}
