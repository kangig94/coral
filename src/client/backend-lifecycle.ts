declare const __VERSION__: string;

import { readFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKEND_INFO_PATH, BACKEND_LOCK_PATH } from './paths.js';
import { readBackendInfo, type BackendInfo } from '../execution/backend-info.js';
import { isNoEntryError, isRecord, readBundleHash, tryExclusiveWrite } from '../shared/mcp-utils.js';

const STARTUP_POLL_MS = 200;
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 3_000;
const REPLACEMENT_TIMEOUT_MS = 45_000;

type BackendHealth = {
  status: 'ok';
  version: string;
  bundleHash: string;
  instanceId: string;
};

type ReplacementLock = {
  payload: string;
};

export type BackendHandle = {
  port: number;
  host: string;
  token: string;
  instanceId: string;
};

function summarizeBackend(info: BackendInfo): BackendHandle {
  return { port: info.port, host: info.host, token: info.token, instanceId: info.instanceId };
}

function isBackendHealth(value: unknown): value is BackendHealth {
  return isRecord(value)
    && value.status === 'ok'
    && typeof value.version === 'string'
    && typeof value.bundleHash === 'string'
    && typeof value.instanceId === 'string';
}

function currentBundleHash(root: string): string {
  return readBundleHash(root);
}

function currentVersion(root: string): string {
  const fallbackVersion = typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0';

  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    return isRecord(pkg) && typeof pkg.version === 'string' ? pkg.version : fallbackVersion;
  } catch {
    return fallbackVersion;
  }
}

export async function withAbortTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBackendHealth(info: BackendInfo): Promise<BackendHealth | null> {
  try {
    return await withAbortTimeout(HEALTH_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`http://${info.host}:${info.port}/health`, {
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': info.token },
        signal,
      });
      if (!response.ok) return null;

      const body: unknown = await response.json();
      return isBackendHealth(body) ? body : null;
    });
  } catch {
    return null;
  }
}

async function readHealthyBackendInfo(info = readBackendInfo()): Promise<BackendInfo | null> {
  if (!info) return null;
  const health = await fetchBackendHealth(info);
  if (!health) return null;
  if (health.bundleHash !== info.bundleHash || health.instanceId !== info.instanceId) return null;
  return info;
}

async function requestBackendShutdown(info: BackendInfo): Promise<void> {
  try {
    await withAbortTimeout(HEALTH_TIMEOUT_MS, (signal) => fetch(`http://${info.host}:${info.port}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': info.token },
      signal,
    }));
  } catch {
    /* best effort */
  }
}

function tryAcquireReplacementLock(version: string, bundleHash: string): ReplacementLock | null {
  const payload = JSON.stringify({
    instanceId: `proxy-replacement-${process.pid}-${Date.now()}`,
    pid: process.pid,
    version,
    bundleHash,
    startedAt: Date.now(),
  });
  if (!tryExclusiveWrite(BACKEND_LOCK_PATH, payload)) return null;
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

function spawnBackend(backendBin: string): void {
  const child = spawn(process.execPath, [backendBin], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
}

async function waitForReplacementBackend(
  oldInstanceId: string | null,
  expectedHash: string,
  deadline: number,
): Promise<BackendInfo> {
  while (Date.now() < deadline) {
    const info = await readHealthyBackendInfo();
    if (
      info
      && info.bundleHash === expectedHash
      && (oldInstanceId === null || info.instanceId !== oldInstanceId)
    ) {
      return info;
    }
    await delay(STARTUP_POLL_MS);
  }

  throw new Error('Timed out waiting for Coral backend startup');
}

export async function ensureBackend(pluginRoot?: string): Promise<BackendHandle> {
  function resolvePluginRoot(root?: string): string {
    if (root) return root;
    return fileURLToPath(new URL('../..', import.meta.url));
  }

  const root = resolvePluginRoot(pluginRoot);
  const backendBin = join(root, 'bridge', 'coral-backend.cjs');
  const existingInfo = readBackendInfo();
  const existingHealthy = await readHealthyBackendInfo(existingInfo);
  const expectedHash = currentBundleHash(root);
  if (existingHealthy && existingHealthy.bundleHash === expectedHash) {
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
      && healthy.bundleHash === expectedHash
      && (replacedInstanceId === null || healthy.instanceId !== replacedInstanceId)
    ) {
      return summarizeBackend(healthy);
    }

    if (
      healthy
      && healthy.bundleHash !== expectedHash
      && shutdownRequestedFor !== healthy.instanceId
    ) {
      shutdownRequestedFor = healthy.instanceId;
      await requestBackendShutdown(healthy);
    }

    const replacementLock = tryAcquireReplacementLock(currentVersion(root), expectedHash);
    if (replacementLock) {
      try {
        removeStaleBackendInfo();
      } finally {
        releaseReplacementLock(replacementLock);
      }

      spawnBackend(backendBin);
      const replacementDeadline = Math.min(startupDeadline, Date.now() + REPLACEMENT_TIMEOUT_MS);
      return summarizeBackend(
        await waitForReplacementBackend(replacedInstanceId, expectedHash, replacementDeadline),
      );
    }

    await delay(STARTUP_POLL_MS);
  }

  throw new Error('Timed out waiting for Coral backend startup');
}
