declare const __PLUGIN_ROOT__: string;

import { ensureBackend, withAbortTimeout } from '../client/backend-lifecycle.js';
import { isBackendHealth } from '../client/backend-health.js';
import { readBackendInfo } from '../infra/backend-info.js';
import { collectCoralEnv, isProcessAlive, isRecord } from '../shared/mcp-utils.js';
import {
  describeHttpError,
  HEALTH_TIMEOUT_MS,
  MAX_WAIT_FETCH_TIMEOUT_MS,
  parseJsonResponse,
  parseSseBlock,
  parseWaitStreamEvent,
  TOOL_TIMEOUT_MS,
  WAIT_FETCH_MARGIN_MS,
} from '../shared/sse-parser.js';
import type { WaitStreamEvent } from '../shared/types.js';
import type { ToolDomainResult } from '../execution/tool-response.js';

export { ensureBackend } from '../client/backend-lifecycle.js';

export type BackendStatus = {
  status: 'ok';
  version: string;
  bundleHash: string;
  instanceId: string;
  uptimeMs: number;
  activeChildren: number;
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

function isShuttingDownError(value: unknown): value is { error: 'backend_shutting_down' } {
  return isRecord(value) && value.error === 'backend_shutting_down';
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
      if (isBackendHealth(body) && body.namespace === info.namespace) {
        const { namespace: _, queueDepth: _q, ...health } = body;
        return { status: 'ok', health };
      }
      return { status: 'not_running' };
    }
    if (response.status === 503) {
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

export async function proxyToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: { projectRoot: string; pluginRoot: string },
): Promise<ToolDomainResult> {
  const { port, host, token } = await ensureBackend(ctx.pluginRoot);
  const coralEnv = collectCoralEnv();
  const body = JSON.stringify({
    name,
    args,
    context: {
      projectRoot: ctx.projectRoot,
      pluginRoot: ctx.pluginRoot,
      coralEnv,
    },
  });

  try {
    return await withAbortTimeout(TOOL_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`http://${host}:${port}/tool`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': token,
        },
        body,
        signal,
      });

      if (!response.ok) {
        throw new Error(describeHttpError(response.status, response.statusText));
      }

      return (await parseJsonResponse(response)) as ToolDomainResult;
    });
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`Backend communication error: ${String(error)}`, { cause: error });
  }
}

export type WaitCursorRef = { lastEventId?: string };

export async function* streamWait(
  jobIds: string[],
  timeoutSeconds: number | undefined,
  backendInfo: { host: string; port: number; token: string },
  lastEventId?: string,
  signal?: AbortSignal,
  projectRoot?: string,
  cursorRef?: WaitCursorRef,
): AsyncGenerator<WaitStreamEvent> {
  const fetchTimeoutMs = Math.min(
    (timeoutSeconds ?? 600) * 1000 + WAIT_FETCH_MARGIN_MS,
    MAX_WAIT_FETCH_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', onExternalAbort);
  }

  try {
    const response = await fetch(`http://${backendInfo.host}:${backendInfo.port}/wait/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backendInfo.token,
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
      body: JSON.stringify({ jobIds, timeoutSeconds, projectRoot }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await parseJsonResponse(response);
      const message = isRecord(body) && typeof body.message === 'string'
        ? body.message
        : describeHttpError(response.status, response.statusText);
      throw new Error(message);
    }

    if (!response.body) {
      throw new Error('Backend wait stream returned no response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of response.body) {
      const decoded = decoder.decode(chunk, { stream: true });
      buffer += decoded;
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (!parsed) continue;
        if (cursorRef && parsed.id) cursorRef.lastEventId = parsed.id;
        const event = parseWaitStreamEvent(parsed.event, parsed.data);
        if (event) yield event;
      }
    }

    buffer += decoder.decode();
    const finalBlock = parseSseBlock(buffer);
    if (!finalBlock) return;
    if (cursorRef && finalBlock.id) cursorRef.lastEventId = finalBlock.id;
    const finalEvent = parseWaitStreamEvent(finalBlock.event, finalBlock.data);
    if (finalEvent) yield finalEvent;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`Backend communication error: ${String(error)}`, { cause: error });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
