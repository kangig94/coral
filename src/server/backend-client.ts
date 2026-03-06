declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKEND_INFO_PATH, readBackendInfo, type BackendInfo } from '../backend/backend-info.js';
import { BACKEND_LOCK_PATH } from '../backend/backend-lock.js';
import { isNoEntryError, isRecord, type McpResult, textResult } from '../shared/mcp-utils.js';

const STARTUP_POLL_MS = 200;
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 3_000;
const REPLACEMENT_TIMEOUT_MS = 45_000;
const TOOL_TIMEOUT_MS = 300_000;
const CURRENT_VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0';
const pluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..', '..');
const BACKEND_BIN = join(pluginRoot, 'bridge', 'coral-backend.cjs');

type BackendHealth = {
  status: 'ok';
  version: string;
  instanceId: string;
};

type ReplacementLock = {
  payload: string;
};

function summarizeBackend(info: BackendInfo): { port: number; token: string; instanceId: string } {
  return { port: info.port, token: info.token, instanceId: info.instanceId };
}

function isBackendHealth(value: unknown): value is BackendHealth {
  return isRecord(value)
    && value.status === 'ok'
    && typeof value.version === 'string'
    && typeof value.instanceId === 'string';
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
  if (!existsSync(BACKEND_BIN)) {
    throw new Error(`Coral backend binary not found: ${BACKEND_BIN}`);
  }

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

function isMcpResult(value: unknown): value is McpResult {
  if (!isRecord(value) || typeof value.isError !== 'boolean' || !Array.isArray(value.content)) return false;
  return value.content.every((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string');
}

export async function ensureBackend(): Promise<{ port: number; token: string; instanceId: string }> {
  const existingInfo = readBackendInfo();
  const existingHealthy = await readHealthyBackendInfo(existingInfo);
  if (existingHealthy && existingHealthy.version === CURRENT_VERSION) {
    return summarizeBackend(existingHealthy);
  }

  const replacedInstanceId = existingHealthy?.version === CURRENT_VERSION ? null : existingHealthy?.instanceId ?? null;
  let shutdownRequestedFor = existingHealthy?.version === CURRENT_VERSION ? null : existingHealthy?.instanceId ?? null;
  if (existingHealthy && existingHealthy.version !== CURRENT_VERSION) {
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
  projectRoot: string,
): Promise<McpResult> {
  try {
    const { port, token } = await ensureBackend();
    const body = JSON.stringify({ name, args, context: { projectRoot } });
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

      if (response.status === 503) return textResult('Backend shutting down, retry', true);
      if (response.status === 401) return textResult('Backend auth failure — stale token', true);
      if (!response.ok) {
        return textResult(`Backend request failed: ${response.status} ${response.statusText}`, true);
      }

      const result: unknown = await response.json();
      if (isMcpResult(result)) return result;
      return textResult(`Backend returned invalid response: ${JSON.stringify(result)}`, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return textResult(`Backend communication error: ${message}`, true);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult(`Backend communication error: ${message}`, true);
  }
}
