declare const __PLUGIN_ROOT__: string;

import { withAbortTimeout } from './backend-handle.js';
import { isBackendHealth } from './backend-health.js';
import { BackendToolHttpError } from './client-errors.js';
import { readBackendInfo } from '../../infra/backend-discovery.js';
import { BackendUnreachableError, TransientHttpError } from '../../infra/http-errors.js';
import { errorMessage } from '../../infra/error-format.js';
import { isRecord } from '../../infra/json.js';
import { readBuildFlavor } from '../../infra/bridge-manifest.js';
import { isProcessAlive } from '../../infra/node-process.js';
import {
  HEALTH_TIMEOUT_MS,
  parseJsonResponse,
} from '../../transport/http/sse.js';
import type { WaitStreamEvent } from '../../jobs/wait.js';
import { parseSerializedWaitCursor, serializeWaitCursor } from '../../jobs/wait.js';
import { createIpcClient } from '../ipc/client.js';

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

export type ShutdownResult =
  | { ok: true; alreadyDraining?: true }
  | { ok: false; reason: string };

export type WaitCursorRef = { lastEventId?: string };

function resolvePluginRoot(): string {
  if (typeof __PLUGIN_ROOT__ === 'string') {
    return __PLUGIN_ROOT__;
  }
  if (typeof process.env.CLAUDE_PLUGIN_ROOT === 'string' && process.env.CLAUDE_PLUGIN_ROOT.length > 0) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  return process.cwd();
}

function waitSubscriptionStatusCode(body: Record<string, unknown>): number {
  switch (body.code) {
    case 'scope_mismatch':
      return 403;
    case 'jobs_not_found':
      return 404;
    case 'backend_recovering':
    case 'backend_shutting_down':
      return 503;
    default:
      return 400;
  }
}

function mapWaitSubscriptionError(error: unknown): unknown {
  if (!(error instanceof Error) || !isRecord(error.cause) || typeof error.cause.message !== 'string') {
    return error;
  }

  if (error.cause.code === 'backend_recovering' || error.cause.code === 'backend_shutting_down') {
    return new TransientHttpError(503, error.cause.message);
  }

  return new BackendToolHttpError(
    error.cause.message,
    waitSubscriptionStatusCode(error.cause),
    error.cause,
  );
}

function isBackendUnreachableCause(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current) {
      const code = (current as { code?: unknown }).code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return true;
      }
    }
    current = typeof current === 'object' && current !== null && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return false;
}

export function throwBackendCommunicationError(error: unknown): never {
  if (isBackendUnreachableCause(error)) {
    throw new BackendUnreachableError(errorMessage(error));
  }
  if (error instanceof Error) throw error;
  throw new Error(`Backend communication error: ${String(error)}`, { cause: error });
}

export function isShuttingDownError(value: unknown): value is { code: 'backend_shutting_down' } {
  return isRecord(value) && value.code === 'backend_shutting_down';
}

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
    const { body, response } = await withAbortTimeout(HEALTH_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`http://${info.host}:${info.port}/health`, {
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': info.token },
        signal,
      });

      return {
        response,
        body: await parseJsonResponse(response),
      };
    });
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

export async function shutdownBackend(pluginRoot: string): Promise<ShutdownResult> {
  const info = readBackendInfo(pluginRoot);
  if (!info || !isProcessAlive(info.pid)) {
    return { ok: false, reason: 'not_running' };
  }

  try {
    const { body, response } = await withAbortTimeout(HEALTH_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`http://${info.host}:${info.port}/admin/shutdown`, {
        method: 'POST',
        headers: { 'X-Coral-Backend-Token': info.token },
        signal,
      });

      return {
        response,
        body: await parseJsonResponse(response),
      };
    });
    if (response.status === 200 && isRecord(body) && body.status === 'shutting_down') {
      return { ok: true };
    }
    if (response.status === 503 && isShuttingDownError(body)) {
      return { ok: true, alreadyDraining: true };
    }
    if (response.status === 401) {
      return { ok: false, reason: 'unauthorized' };
    }
    return { ok: false, reason: `${response.status} ${response.statusText}` };
  } catch {
    return { ok: false, reason: 'not_running' };
  }
}

export async function* streamWait(
  jobIds: string[],
  timeoutSeconds: number | undefined,
  backendInfo: { host: string; port: number; token: string; socketPath?: string },
  lastEventId?: string,
  signal?: AbortSignal,
  projectRoot?: string,
  cursorRef?: WaitCursorRef,
): AsyncGenerator<WaitStreamEvent> {
  const inputCursor = parseSerializedWaitCursor(lastEventId);
  if (lastEventId && !inputCursor) {
    throw new BackendToolHttpError('Invalid Last-Event-ID cursor', 400, {
      code: 'invalid_request',
      message: 'Invalid Last-Event-ID cursor',
    });
  }

  try {
    const pluginRoot = resolvePluginRoot();
    const socketPath = backendInfo.socketPath ?? readBackendInfo(pluginRoot)?.socketPath;
    if (!socketPath) {
      throw new BackendUnreachableError(
        `Coral coordinator IPC discovery is unavailable for ${readBuildFlavor(pluginRoot)} mode.`,
      );
    }

    const client = createIpcClient(socketPath);
    const subscription = await client.subscribe<WaitStreamEvent>(
      'jobs.wait',
      {
        jobIds,
        timeoutSeconds,
        projectRoot,
        ...(inputCursor ? { cursor: inputCursor } : {}),
      },
      {
        timeoutMs: HEALTH_TIMEOUT_MS,
        signal,
      },
    );

    try {
      const currentCursor = { jobs: { ...(inputCursor?.jobs ?? {}) } };
      for await (const event of subscription) {
        if (event.type === 'progress') {
          currentCursor.jobs[event.jobId] = event.eventId;
          if (cursorRef) {
            cursorRef.lastEventId = serializeWaitCursor(currentCursor);
          }
        } else if (event.type === 'terminal' && cursorRef) {
          cursorRef.lastEventId = serializeWaitCursor(currentCursor);
        }

        yield event;
      }
    } finally {
      await subscription.close();
    }
  } catch (error) {
    throwBackendCommunicationError(mapWaitSubscriptionError(error));
  }
}
