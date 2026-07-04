import { readBackendInfo } from '../../../infra/backend-discovery.js';
import { readBuildFlavor } from '../../../infra/bundle-manifest.js';
import { isProcessAlive } from '../../../infra/node-process.js';
import { createRealRuntime } from '../../../runtime/real.js';
import { HEALTH_TIMEOUT_MS, parseJsonResponse } from '../sse.js';
import { isBackendHealth, isBackendPing, type BackendHealth } from './health.js';
import { TransientHttpError } from '../../../infra/http-errors.js';

type BackendStatus =
  | {
      // CLI-level verdict. The daemon-side coarse lifecycle field
      // (`'starting' | 'ok' | 'draining'`) is preserved as `health.status`
      // inside the nested `BackendHealth` payload via `BackendStatusFull`.
      status: 'ok';
      version: string;
      bundleHash: string;
      instanceId: string;
      uptimeMs: number;
      active: number;
      activeJobs: number;
      inflightRequests: number;
      queueDepth?: number;
      kernel: BackendHealth['kernel'];
      textProjectionState: BackendHealth['textProjectionState'];
      components: BackendHealth['components'];
      diagnostics?: BackendHealth['diagnostics'];
    }
  | {
      status: 'shutting_down';
    };

export type BackendStatusFull =
  | { status: 'ok'; health: Extract<BackendStatus, { status: 'ok' }> }
  | { status: 'shutting_down' | 'unauthorized' | 'not_running' };

export async function getBackendStatusFull(pluginRoot: string): Promise<BackendStatusFull> {
  const runtime = createRealRuntime(readBuildFlavor(pluginRoot));
  const info = readBackendInfo({
    storage: runtime.storage,
    env: runtime.env,
    paths: runtime.paths,
  });
  if (!info || !isProcessAlive(info.pid)) return { status: 'not_running' };

  try {
    const pingResponse = await fetch(`http://${info.host}:${info.port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const pingBody = await parseJsonResponse(pingResponse);
    if (pingResponse.status === 200) {
      if (!isBackendPing(pingBody) || pingBody.namespace !== info.namespace || pingBody.flavor !== info.flavor) {
        return { status: 'not_running' };
      }
      if (pingBody.status === 'draining') {
        return { status: 'shutting_down' };
      }
    } else if (pingResponse.status === 503 || TransientHttpError.isTransientStatus(pingResponse.status)) {
      return { status: 'shutting_down' };
    } else {
      return { status: 'not_running' };
    }

    const healthResponse = await fetch(`http://${info.host}:${info.port}/health?detailed=1`, {
      method: 'GET',
      headers: { 'X-Coral-Boot-Token': info.bootToken },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body = await parseJsonResponse(healthResponse);
    if (healthResponse.status === 200) {
      if (!isBackendHealth(body) || body.namespace !== info.namespace || body.flavor !== info.flavor) {
        return { status: 'not_running' };
      }
      if (body.status === 'draining') {
        return { status: 'shutting_down' };
      }
      const { namespace: _namespace, status: _status, ...rest } = body;
      return { status: 'ok', health: { ...rest, status: 'ok' as const } };
    }
    if (healthResponse.status === 503 || TransientHttpError.isTransientStatus(healthResponse.status)) {
      return { status: 'shutting_down' };
    }
    if (healthResponse.status === 401) return { status: 'unauthorized' };
    return { status: 'not_running' };
  } catch {
    return { status: 'not_running' };
  }
}
