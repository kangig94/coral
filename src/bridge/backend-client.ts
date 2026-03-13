declare const __PLUGIN_ROOT__: string;

import { ensureBackend, withAbortTimeout } from '../client/backend-lifecycle.js';
import { readBackendInfo } from '../execution/backend-info.js';
import { isProcessAlive, isRecord } from '../shared/mcp-utils.js';
import type { WaitStreamEvent } from '../types.js';

const HEALTH_TIMEOUT_MS = 3_000;
const TOOL_TIMEOUT_MS = 300_000;
const MAX_WAIT_FETCH_TIMEOUT_MS = 30 * 60 * 1000;
const WAIT_FETCH_MARGIN_MS = 30_000;

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

type SseEventBlock = {
  event?: string;
  data: string;
  id?: string;
};

type BackendHealthPayload = Extract<BackendStatus, { status: 'ok' }> & {
  namespace: string;
};

function isBackendHealthPayload(
  value: unknown,
  expectedNamespace: string,
): value is BackendHealthPayload {
  return isRecord(value)
    && value.status === 'ok'
    && typeof value.version === 'string'
    && typeof value.bundleHash === 'string'
    && typeof value.instanceId === 'string'
    && typeof value.namespace === 'string'
    && value.namespace === expectedNamespace
    && Number.isFinite(value.uptimeMs)
    && Number.isInteger(value.activeChildren)
    && Number.isInteger(value.activeJobs)
    && Number.isInteger(value.inflightRequests);
}

function toBackendStatus({
  namespace: _namespace,
  ...status
}: BackendHealthPayload): Extract<BackendStatus, { status: 'ok' }> {
  return status;
}

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
      return isBackendHealthPayload(body, info.namespace)
        ? { status: 'ok', health: toBackendStatus(body) }
        : { status: 'not_running' };
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

function parseWaitStreamEvent(eventType: string | undefined, rawData: string): WaitStreamEvent | null {
  if (!eventType) return null;

  const parsed: unknown = JSON.parse(rawData);
  if (!isRecord(parsed) || parsed.type !== eventType) {
    throw new Error(`Invalid wait stream event payload for ${eventType}`);
  }

  switch (eventType) {
    case 'progress':
      if (
        typeof parsed.jobId === 'string'
        && typeof parsed.sessionId === 'string'
        && Number.isInteger(parsed.eventId)
        && typeof parsed.message === 'string'
      ) {
        return parsed as WaitStreamEvent;
      }
      throw new Error('Invalid progress wait stream event');
    case 'terminal':
      if (
        typeof parsed.completedJobId === 'string'
        && typeof parsed.sessionId === 'string'
        && Array.isArray(parsed.remainingJobIds)
        && parsed.remainingJobIds.every((jobId) => typeof jobId === 'string')
        && typeof parsed.resultPath === 'string'
        && isRecord(parsed.result)
      ) {
        return parsed as WaitStreamEvent;
      }
      throw new Error('Invalid terminal wait stream event');
    case 'timeout':
      if (
        Array.isArray(parsed.runningJobIds)
        && parsed.runningJobIds.every((jobId) => typeof jobId === 'string')
      ) {
        return parsed as WaitStreamEvent;
      }
      throw new Error('Invalid timeout wait stream event');
    case 'queued':
      if (
        typeof parsed.jobId === 'string'
        && typeof parsed.sessionId === 'string'
        && typeof parsed.queuePosition === 'number'
        && Array.isArray(parsed.runningJobIds)
        && parsed.runningJobIds.every((jobId) => typeof jobId === 'string')
      ) {
        return parsed as WaitStreamEvent;
      }
      throw new Error('Invalid queued wait stream event');
    default:
      return null;
  }
}

function parseSseBlock(block: string): SseEventBlock | null {
  if (!block.trim()) return null;

  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;

    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';

    switch (field) {
      case 'event':
        event = value;
        break;
      case 'data':
        data.push(value);
        break;
      case 'id':
        id = value;
        break;
    }
  }

  if (data.length === 0) return null;
  return { event, data: data.join('\n'), id };
}

function describeHttpError(status: number, statusText: string): string {
  if (status === 503) return 'Backend shutting down, retry';
  if (status === 401) return 'Backend auth failure - stale token';
  return `Backend request failed: ${status} ${statusText}`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function proxyToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: { projectRoot: string; pluginRoot: string },
): Promise<unknown> {
  const { port, host, token } = await ensureBackend(ctx.pluginRoot);
  const body = JSON.stringify({
    name,
    args,
    context: {
      projectRoot: ctx.projectRoot,
      pluginRoot: ctx.pluginRoot,
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

      return parseJsonResponse(response);
    });
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`Backend communication error: ${String(error)}`);
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
  signal?.addEventListener('abort', onExternalAbort);

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
      const decoded = decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
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
    const finalBlock = parseSseBlock(buffer.replace(/\r\n/g, '\n'));
    if (!finalBlock) return;
    if (cursorRef && finalBlock.id) cursorRef.lastEventId = finalBlock.id;
    const finalEvent = parseWaitStreamEvent(finalBlock.event, finalBlock.data);
    if (finalEvent) yield finalEvent;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`Backend communication error: ${String(error)}`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
