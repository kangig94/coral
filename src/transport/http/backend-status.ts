import { readBackendInfo } from '../../infra/backend-discovery.js';
import { isProcessAlive } from '../../infra/node-process.js';
import {
  HEALTH_TIMEOUT_MS,
  parseJsonResponse,
} from '../../transport/http/sse.js';
import { isBackendHealth } from './backend-health.js';
import { TransientHttpError } from '../../infra/http-errors.js';
import { isRecord } from '../../infra/json.js';

export type BackendStatus = {
  status: 'ok';
  version: string;
  bundleHash: string;
  instanceId: string;
  uptimeMs: number;
  active: number;
  activeJobs: number;
  inflightRequests: number;
} | {
  status: 'shutting_down';
};

export type BackendStatusFull =
  | { status: 'ok'; health: Extract<BackendStatus, { status: 'ok' }> }
  | { status: 'shutting_down' | 'unauthorized' | 'not_running' };

export async function getBackendStatus(pluginRoot: string): Promise<BackendStatus | null> {
  const status = await getBackendStatusFull(pluginRoot);
  if (status.status === 'ok') {
    return status.health;
  }
  if (status.status === 'shutting_down') {
    return { status: 'shutting_down' };
  }
  return null;
}

export async function getBackendStatusFull(pluginRoot: string): Promise<BackendStatusFull> {
  const info = readBackendInfo(pluginRoot);
  if (!info || !isProcessAlive(info.pid)) return { status: 'not_running' };

  try {
    const response = await fetch(`http://${info.host}:${info.port}/health`, {
      method: 'GET',
      headers: { 'X-Coral-Backend-Token': info.token },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body = await parseJsonResponse(response);
    if (response.status === 200) {
      if (!isBackendHealth(body) || body.namespace !== info.namespace || body.flavor !== info.flavor) {
        return { status: 'not_running' };
      }

      const { namespace: _namespace, queueDepth: _queueDepth, ...health } = body;
      return { status: 'ok', health };
    }
    if (response.status === 503 || TransientHttpError.isTransientStatus(response.status)) {
      return { status: 'shutting_down' };
    }
    if (response.status === 401) return { status: 'unauthorized' };
    return { status: 'not_running' };
  } catch {
    return { status: 'not_running' };
  }
}

export function isBackendStatus(value: unknown): value is BackendStatus {
  return isRecord(value) && typeof value.status === 'string' && (value.status === 'ok' || value.status === 'shutting_down');
}
