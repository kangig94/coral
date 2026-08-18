import { DEFAULT_DISCOVERY_HOST, readDiscoveryRecordDisposition } from '../../../infra/backend-discovery.js';
import { readBuildFlavor } from '../../../infra/bundle-manifest.js';
import { observeProcessLiveness } from '../../../infra/node-process.js';
import { createRealRuntime } from '../../../runtime/real.js';
import { HEALTH_TIMEOUT_MS, parseJsonResponse } from '../sse.js';
import { errorMessage } from '../../../infra/error-format.js';
import { isRecord } from '../../../infra/json.js';
import { isCoralChildEnvironment } from '../../../security/child-principal-env.js';

/**
 * `reason` is a stable token the CLI renders; `detail` is the observed cause behind it, when there is one.
 *
 * They are separate because the two `ok: false` cases an operator most needs told apart used to share a
 * spelling: `not_running` was returned both for a socket that refused the connection and for a request that
 * never finished, and the disposition split above was flattened into a raw enum name at the render layer.
 */
export type ShutdownResult = { ok: true; alreadyDraining?: true } | { ok: false; reason: string; detail?: string };

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
      reason:
        "this nested Coral process cannot shut down its parent coordinator; return to the top-level Coral session and run 'coral-cli backend shutdown' there",
    };
  }
  const discoveryRuntime = { storage: runtime.storage, env: runtime.env, paths: runtime.paths };

  // A record that cannot be decoded is not an absent coordinator, and reporting `not_running` here would skip
  // a shutdown request a live daemon is waiting for. Same split as `getBackendStatusFull`.
  const read = readDiscoveryRecordDisposition(discoveryRuntime);
  if (read.kind === 'undecodable') {
    return { ok: false, reason: 'unreadable_record', detail: read.reason };
  }

  // The decoded record, not `readBackendInfo`. That helper additionally returns `null` when `version` or
  // `instanceId` is absent, which nothing here reads — the request needs `host`, `port` and `bootToken`, and
  // a record from a build that predates those two fields carries all three. Routing through it meant an
  // incumbent old enough to omit them was reported as not running and never asked to stop.
  // Three different things used to answer `not_running`, and only one of them had dialled the socket. The
  // reasons are separate so the sentence an operator reads names what was actually observed: no record at
  // all, a recorded process seen to be gone, or a connection this process made and had refused.
  const record = read.kind === 'record' ? read.record : null;
  if (record === null) {
    return { ok: false, reason: 'no_record' };
  }
  // Only an observed absence skips the shutdown request. Unknown still tries, which is the safe direction.
  if (observeProcessLiveness(record.pid) === 'absent') {
    return { ok: false, reason: 'recorded_process_absent', detail: String(record.pid) };
  }
  const info = { ...record, host: record.host ?? DEFAULT_DISCOVERY_HOST };

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
      return { ok: false, reason: 'manual shutdown required: shutdown capability was rejected' };
    }
    return { ok: false, reason: `${response.status} ${response.statusText}` };
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
