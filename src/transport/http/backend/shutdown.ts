import { readBackendInfo } from '../../../infra/backend-discovery.js';
import { readBuildFlavor } from '../../../infra/bundle-manifest.js';
import { isProcessAlive } from '../../../infra/node-process.js';
import { createRealRuntime } from '../../../runtime/real.js';
import { HEALTH_TIMEOUT_MS, parseJsonResponse } from '../sse.js';
import { isRecord } from '../../../infra/json.js';

export type ShutdownResult = { ok: true; alreadyDraining?: true } | { ok: false; reason: string };

export function isShuttingDownError(value: unknown): value is { code: 'backend_shutting_down' } {
  return isRecord(value) && value.code === 'backend_shutting_down';
}

export async function shutdownBackend(pluginRoot: string): Promise<ShutdownResult> {
  const runtime = createRealRuntime(readBuildFlavor(pluginRoot));
  const info = readBackendInfo({
    storage: runtime.storage,
    env: runtime.env,
    paths: runtime.paths,
  });
  if (!info || !isProcessAlive(info.pid)) {
    return { ok: false, reason: 'not_running' };
  }

  try {
    const headers: Record<string, string> =
      typeof info.shutdownToken === 'string' && info.shutdownToken.length > 0
        ? { 'X-Coral-Shutdown-Token': info.shutdownToken }
        : { 'X-Coral-Backend-Token': info.token };
    const response = await fetch(`http://${info.host}:${info.port}/admin/shutdown`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body = await parseJsonResponse(response);
    if (response.status === 200 && isRecord(body) && body.status === 'shutting_down') {
      return { ok: true };
    }
    if (response.status === 503 && isShuttingDownError(body)) {
      return { ok: true, alreadyDraining: true };
    }
    if (response.status === 401) {
      return { ok: false, reason: 'manual shutdown required: shutdown capability was rejected' };
    }
    return { ok: false, reason: `${response.status} ${response.statusText}` };
  } catch {
    return { ok: false, reason: 'not_running' };
  }
}
