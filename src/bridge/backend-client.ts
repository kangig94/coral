declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKEND_INFO_PATH, readBackendInfo, type BackendInfo } from '../execution/backend-info.js';
import { BACKEND_LOCK_PATH } from '../execution/backend-lock.js';
import { isNoEntryError, isRecord } from '../shared/mcp-utils.js';
import type { WaitStreamEvent } from '../types.js';

const STARTUP_POLL_MS = 200;
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 3_000;
const REPLACEMENT_TIMEOUT_MS = 45_000;
const TOOL_TIMEOUT_MS = 300_000;
const MAX_WAIT_FETCH_TIMEOUT_MS = 30 * 60 * 1000;
const WAIT_FETCH_MARGIN_MS = 30_000;
const CURRENT_VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0';
const pluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..', '..');
const BACKEND_BIN = join(pluginRoot, 'bridge', 'coral-backend.cjs');

type BackendHealth = {
  status: 'ok';
  version: string;
  instanceId: string;
};

export type BackendStatus = {
  status: 'ok';
  version: string;
  instanceId: string;
  uptimeMs: number;
  activeChildren: number;
  activeJobs: number;
  inflightRequests: number;
} | {
  status: 'shutting_down';
};

export type ShutdownResult =
  | { ok: true; alreadyDraining?: true }
  | { ok: false; reason: string };

type ReplacementLock = {
  payload: string;
};

type BackendHandle = {
  port: number;
  token: string;
  instanceId: string;
};

type SseEventBlock = {
  event?: string;
  data: string;
};

function summarizeBackend(info: BackendInfo): BackendHandle {
  return { port: info.port, token: info.token, instanceId: info.instanceId };
}

function isBackendHealth(value: unknown): value is BackendHealth {
  return isRecord(value)
    && value.status === 'ok'
    && typeof value.version === 'string'
    && typeof value.instanceId === 'string';
}

function isBackendStatus(value: unknown): value is Extract<BackendStatus, { status: 'ok' }> {
  return isRecord(value)
    && value.status === 'ok'
    && typeof value.version === 'string'
    && typeof value.instanceId === 'string'
    && Number.isFinite(value.uptimeMs)
    && Number.isInteger(value.activeChildren)
    && Number.isInteger(value.activeJobs)
    && Number.isInteger(value.inflightRequests);
}

function isShuttingDownError(value: unknown): value is { error: 'backend_shutting_down' } {
  return isRecord(value) && value.error === 'backend_shutting_down';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function fetchBackendHealth(info: BackendInfo): Promise<BackendHealth | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      method: 'GET',
      headers: { 'X-Coral-Backend-Token': info.token },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    return isBackendHealth(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readHealthyBackendInfo(info = readBackendInfo()): Promise<BackendInfo | null> {
  if (!info) return null;
  const health = await fetchBackendHealth(info);
  if (!health) return null;
  if (health.version !== info.version || health.instanceId !== info.instanceId) return null;
  return info;
}

async function requestBackendShutdown(info: BackendInfo): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    await fetch(`http://127.0.0.1:${info.port}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': info.token },
      signal: controller.signal,
    });
  } catch {
    /* best effort */
  } finally {
    clearTimeout(timeout);
  }
}

export async function getBackendStatus(): Promise<BackendStatus | null> {
  const info = readBackendInfo();
  if (!info || !isProcessAlive(info.pid)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      method: 'GET',
      headers: { 'X-Coral-Backend-Token': info.token },
      signal: controller.signal,
    });

    const body = await parseJsonResponse(response);
    if (response.status === 200) {
      return isBackendStatus(body) ? body : null;
    }
    if (response.status === 503 && isShuttingDownError(body)) {
      return { status: 'shutting_down' };
    }
    if (response.status === 401) return null;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function shutdownBackend(): Promise<ShutdownResult> {
  const info = readBackendInfo();
  if (!info || !isProcessAlive(info.pid)) {
    return { ok: false, reason: 'not_running' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': info.token },
      signal: controller.signal,
    });

    const body = await parseJsonResponse(response);
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
  } finally {
    clearTimeout(timeout);
  }
}

function tryAcquireReplacementLock(): ReplacementLock | null {
  mkdirSync(dirname(BACKEND_LOCK_PATH), { recursive: true });

  const payload = JSON.stringify({
    instanceId: `proxy-replacement-${process.pid}-${Date.now()}`,
    pid: process.pid,
    version: CURRENT_VERSION,
    startedAt: Date.now(),
  });

  try {
    writeFileSync(BACKEND_LOCK_PATH, payload, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }

  if (process.platform !== 'win32') {
    chmodSync(BACKEND_LOCK_PATH, 0o600);
  }

  return { payload };
}

function releaseReplacementLock(lock: ReplacementLock): void {
  try {
    if (readFileSync(BACKEND_LOCK_PATH, 'utf-8') !== lock.payload) return;
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }

  try {
    unlinkSync(BACKEND_LOCK_PATH);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}

function removeStaleBackendInfo(): void {
  try {
    unlinkSync(BACKEND_INFO_PATH);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}

function spawnBackend(): void {
  const child = spawn(process.execPath, [BACKEND_BIN], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
}

async function waitForReplacementBackend(
  oldInstanceId: string | null,
  deadline: number,
): Promise<BackendInfo> {
  while (Date.now() < deadline) {
    const info = await readHealthyBackendInfo();
    if (
      info
      && info.version === CURRENT_VERSION
      && (oldInstanceId === null || info.instanceId !== oldInstanceId)
    ) {
      return info;
    }
    await delay(STARTUP_POLL_MS);
  }

  throw new Error('Timed out waiting for Coral backend startup');
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
    }
  }

  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
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

export async function ensureBackend(): Promise<BackendHandle> {
  const existingInfo = readBackendInfo();
  const existingHealthy = await readHealthyBackendInfo(existingInfo);
  if (existingHealthy && existingHealthy.version === CURRENT_VERSION) {
    return summarizeBackend(existingHealthy);
  }

  let replacedInstanceId: string | null = null;
  let shutdownRequestedFor: string | null = null;
  if (existingHealthy) {
    replacedInstanceId = existingHealthy.instanceId;
    shutdownRequestedFor = existingHealthy.instanceId;
    await requestBackendShutdown(existingHealthy);
  }

  const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < startupDeadline) {
    const healthy = await readHealthyBackendInfo();
    if (
      healthy
      && healthy.version === CURRENT_VERSION
      && (replacedInstanceId === null || healthy.instanceId !== replacedInstanceId)
    ) {
      return summarizeBackend(healthy);
    }

    if (
      healthy
      && healthy.version !== CURRENT_VERSION
      && shutdownRequestedFor !== healthy.instanceId
    ) {
      shutdownRequestedFor = healthy.instanceId;
      await requestBackendShutdown(healthy);
    }

    const replacementLock = tryAcquireReplacementLock();
    if (replacementLock) {
      try {
        removeStaleBackendInfo();
      } finally {
        releaseReplacementLock(replacementLock);
      }

      spawnBackend();
      const replacementDeadline = Math.min(startupDeadline, Date.now() + REPLACEMENT_TIMEOUT_MS);
      return summarizeBackend(await waitForReplacementBackend(replacedInstanceId, replacementDeadline));
    }

    await delay(STARTUP_POLL_MS);
  }

  throw new Error('Timed out waiting for Coral backend startup');
}

export async function proxyToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: { projectRoot: string; pluginRoot: string },
): Promise<unknown> {
  const { port, token } = await ensureBackend();
  const body = JSON.stringify({
    name,
    args,
    context: {
      projectRoot: ctx.projectRoot,
      pluginRoot: ctx.pluginRoot,
    },
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': token,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(describeHttpError(response.status, response.statusText));
    }

    return await parseJsonResponse(response);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`Backend communication error: ${String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function* streamWait(
  jobIds: string[],
  timeoutSeconds: number | undefined,
  backendInfo: { port: number; token: string },
  lastEventId?: string,
  signal?: AbortSignal,
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
    const response = await fetch(`http://127.0.0.1:${backendInfo.port}/wait/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backendInfo.token,
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
      body: JSON.stringify({ jobIds, timeoutSeconds }),
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
        const event = parseWaitStreamEvent(parsed.event, parsed.data);
        if (event) yield event;
      }
    }

    buffer += decoder.decode();
    const finalBlock = parseSseBlock(buffer.replace(/\r\n/g, '\n'));
    if (!finalBlock) return;
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
