declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { backendInfoPath, backendLockPath, installationDir, pluginRootNamespace } from '../infra/paths.js';
import { isBackendHealth, type BackendHealth } from './backend-health.js';
import { readBackendInfo, type BackendInfo } from '../infra/backend-info.js';
import { isNoEntryError, isRecord, readBundleHash, tryExclusiveWrite } from '../shared/mcp-utils.js';
import { HEALTH_TIMEOUT_MS } from '../shared/sse-parser.js';

const STARTUP_POLL_MS = 200;
const STARTUP_TIMEOUT_MS = 60_000;
const REPLACEMENT_TIMEOUT_MS = 45_000;

type ReplacementLock = string;

export type BackendHandle = {
  port: number;
  host: string;
  token: string;
  instanceId: string;
};

function summarizeBackend(info: BackendInfo): BackendHandle {
  return { port: info.port, host: info.host, token: info.token, instanceId: info.instanceId };
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

export async function withAbortTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
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

async function readHealthyBackendInfo(root: string, info = readBackendInfo(root)): Promise<BackendInfo | null> {
  if (!info) return null;

  const health = await fetchBackendHealth(info);
  if (!health) return null;

  const expectedNamespace = pluginRootNamespace(root);
  const hasMismatch =
    health.namespace !== expectedNamespace ||
    health.namespace !== info.namespace ||
    health.bundleHash !== info.bundleHash ||
    health.instanceId !== info.instanceId;

  return hasMismatch ? null : info;
}

async function requestBackendShutdown(info: BackendInfo): Promise<void> {
  try {
    await withAbortTimeout(HEALTH_TIMEOUT_MS, (signal) =>
      fetch(`http://${info.host}:${info.port}/admin/shutdown`, {
        method: 'POST',
        headers: { 'X-Coral-Backend-Token': info.token },
        signal,
      }),
    );
  } catch {
    /* best effort */
  }
}

function tryAcquireReplacementLock(root: string, version: string, bundleHash: string): ReplacementLock | null {
  const payload = JSON.stringify({
    instanceId: `proxy-replacement-${process.pid}-${Date.now()}`,
    pid: process.pid,
    version,
    bundleHash,
    startedAt: Date.now(),
  });
  if (!tryExclusiveWrite(backendLockPath(root), payload)) return null;
  return payload;
}

function releaseReplacementLock(root: string, lock: ReplacementLock): void {
  const lockPath = backendLockPath(root);

  try {
    if (readFileSync(lockPath, 'utf-8') !== lock) return;
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }

  try {
    unlinkSync(lockPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}

function removeStaleBackendInfo(root: string): void {
  try {
    unlinkSync(backendInfoPath(root));
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}

function spawnBackend(backendBin: string): void {
  let stderr: 'ignore' | number = 'ignore';
  try {
    const root = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..');
    const logDir = installationDir(root);
    mkdirSync(logDir, { recursive: true });
    stderr = openSync(join(logDir, 'backend.log'), 'a');
  } catch {
    // fail-open: spawn without log if dir creation fails
  }
  try {
    const child = spawn(process.execPath, [backendBin], {
      detached: true,
      stdio: ['ignore', 'ignore', stderr],
    });
    child.unref();
  } finally {
    // Close fd in parent — child inherits its own copy via spawn
    if (typeof stderr === 'number') closeSync(stderr);
  }
}

async function waitForReplacementBackend(
  root: string,
  oldInstanceId: string | null,
  expectedHash: string,
  deadline: number,
): Promise<BackendInfo> {
  while (Date.now() < deadline) {
    const info = await readHealthyBackendInfo(root);
    if (info && info.bundleHash === expectedHash && (oldInstanceId === null || info.instanceId !== oldInstanceId)) {
      return info;
    }
    await delay(STARTUP_POLL_MS);
  }

  throw new Error(
    'Timed out waiting for Coral backend startup. Use the backend tool with op: "status" to check backend health.',
  );
}

export async function ensureBackend(pluginRoot?: string): Promise<BackendHandle> {
  function resolvePluginRoot(root?: string): string {
    if (root) return root;
    if (typeof __PLUGIN_ROOT__ === 'string') return __PLUGIN_ROOT__;
    if (typeof __dirname === 'string') return join(__dirname, '..', '..');
    return process.cwd();
  }

  const root = resolvePluginRoot(pluginRoot);
  const backendBin = join(root, 'bridge', 'coral-backend.cjs');
  const existingInfo = readBackendInfo(root);
  const existingHealthy = await readHealthyBackendInfo(root, existingInfo);
  const expectedHash = readBundleHash(root);
  if (existingHealthy && existingHealthy.bundleHash === expectedHash) {
    return summarizeBackend(existingHealthy);
  }

  let replacedInstanceId: string | null = null;
  const shutdownRequestedFor = new Set<string>();
  if (existingHealthy) {
    replacedInstanceId = existingHealthy.instanceId;
    shutdownRequestedFor.add(existingHealthy.instanceId);
    await requestBackendShutdown(existingHealthy);
  }

  const version = currentVersion(root);
  const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < startupDeadline) {
    const healthy = await readHealthyBackendInfo(root);
    if (healthy) {
      if (
        healthy.bundleHash === expectedHash &&
        (replacedInstanceId === null || healthy.instanceId !== replacedInstanceId)
      ) {
        return summarizeBackend(healthy);
      }

      if (healthy.bundleHash !== expectedHash && !shutdownRequestedFor.has(healthy.instanceId)) {
        shutdownRequestedFor.add(healthy.instanceId);
        await requestBackendShutdown(healthy);
      }
    }

    const replacementLock = tryAcquireReplacementLock(root, version, expectedHash);
    if (!replacementLock) {
      await delay(STARTUP_POLL_MS);
      continue;
    }

    try {
      removeStaleBackendInfo(root);
      spawnBackend(backendBin);
    } finally {
      releaseReplacementLock(root, replacementLock);
    }
    const replacementDeadline = Math.min(startupDeadline, Date.now() + REPLACEMENT_TIMEOUT_MS);
    return summarizeBackend(
      await waitForReplacementBackend(root, replacedInstanceId, expectedHash, replacementDeadline),
    );
  }

  throw new Error(
    'Timed out waiting for Coral backend startup. Use the backend tool with op: "status" to check backend health.',
  );
}
