declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { backendInfoPath, backendLockPath, installationDir, pluginRootNamespace } from '../infra/paths.js';
import { isBackendHealth, type BackendHealth } from './backend-health.js';
import { readBackendInfo, type BackendInfo } from '../infra/backend-info.js';
import { dirname } from 'node:path';
import { isNoEntryError, isRecord, readBuildFlavor, readBundleHash } from '../shared/utils.js';
import { isProcessAlive } from '../shared/node-process.js';
import { HEALTH_TIMEOUT_MS } from '../shared/sse-parser.js';

const STARTUP_POLL_MS = 200;
const STARTUP_TIMEOUT_MS = 60_000;
const REPLACEMENT_TIMEOUT_MS = 45_000;
const CORRUPT_LOCK_RETRY_LIMIT = 3;

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
  if (
    health.namespace !== expectedNamespace ||
    health.namespace !== info.namespace ||
    health.bundleHash !== info.bundleHash ||
    health.flavor !== info.flavor ||
    health.instanceId !== info.instanceId
  ) {
    return null;
  }

  return info;
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

function tryAcquireReplacementLock(
  root: string,
  version: string,
  bundleHash: string,
  flavor: 'prod' | 'dev',
): ReplacementLock | null {
  const payload = JSON.stringify({
    instanceId: `proxy-replacement-${process.pid}-${Date.now()}`,
    pid: process.pid,
    version,
    bundleHash,
    flavor,
    startedAt: Date.now(),
  });
  const lockPath = backendLockPath(root);
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    writeFileSync(lockPath, payload, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
  if (process.platform !== 'win32') {
    try { chmodSync(lockPath, 0o600); } catch { /* best-effort */ }
  }
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

function tryRemoveStaleLock(root: string): 'missing' | 'active' | 'removed' | 'corrupt' {
  const lockPath = backendLockPath(root);
  try {
    const content = readFileSync(lockPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return 'corrupt';
    }
    if (!isRecord(parsed) || typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid)) {
      return 'corrupt';
    }
    if (isProcessAlive(parsed.pid)) return 'active';
    unlinkSync(lockPath);
    return 'removed';
  } catch (error: unknown) {
    if (isNoEntryError(error)) return 'missing';
    throw error;
  }
}

function quarantineCorruptLock(root: string): void {
  try {
    unlinkSync(backendLockPath(root));
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
  expectedFlavor: 'prod' | 'dev',
  deadline: number,
): Promise<BackendInfo> {
  while (Date.now() < deadline) {
    const info = await readHealthyBackendInfo(root);
    if (
      info &&
      info.bundleHash === expectedHash &&
      info.flavor === expectedFlavor &&
      (oldInstanceId === null || info.instanceId !== oldInstanceId)
    ) {
      return info;
    }
    await delay(STARTUP_POLL_MS);
  }

  throw new Error(
    'Timed out waiting for Coral backend startup. Use the backend tool with op: "status" to check backend health.',
  );
}

export async function ensureBackend(pluginRoot?: string): Promise<BackendHandle> {
  let root: string;
  if (pluginRoot) {
    root = pluginRoot;
  } else if (typeof __PLUGIN_ROOT__ === 'string') {
    root = __PLUGIN_ROOT__;
  } else if (typeof __dirname === 'string') {
    root = join(__dirname, '..', '..');
  } else {
    root = process.cwd();
  }

  const backendBin = join(root, 'bridge', 'coral-backend.cjs');
  const existingInfo = readBackendInfo(root);
  const existingHealthy = await readHealthyBackendInfo(root, existingInfo);
  const expectedHash = readBundleHash(root);
  const expectedFlavor = readBuildFlavor(root);
  if (existingHealthy && existingHealthy.bundleHash === expectedHash && existingHealthy.flavor === expectedFlavor) {
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
  let corruptLockRetries = 0;
  while (Date.now() < startupDeadline) {
    const healthy = await readHealthyBackendInfo(root);
    if (healthy) {
      if (
        healthy.bundleHash === expectedHash &&
        healthy.flavor === expectedFlavor &&
        (replacedInstanceId === null || healthy.instanceId !== replacedInstanceId)
      ) {
        return summarizeBackend(healthy);
      }

      if (
        (healthy.bundleHash !== expectedHash || healthy.flavor !== expectedFlavor) &&
        !shutdownRequestedFor.has(healthy.instanceId)
      ) {
        shutdownRequestedFor.add(healthy.instanceId);
        await requestBackendShutdown(healthy);
      }
    }

    const replacementLock = tryAcquireReplacementLock(root, version, expectedHash, expectedFlavor);
    if (!replacementLock) {
      const lockState = tryRemoveStaleLock(root);
      if (lockState === 'corrupt') {
        corruptLockRetries += 1;
        if (corruptLockRetries >= CORRUPT_LOCK_RETRY_LIMIT) {
          quarantineCorruptLock(root);
          corruptLockRetries = 0;
        }
      } else {
        corruptLockRetries = 0;
      }
      await delay(STARTUP_POLL_MS);
      continue;
    }

    corruptLockRetries = 0;
    try {
      removeStaleBackendInfo(root);
      spawnBackend(backendBin);
      const replacementDeadline = Math.min(startupDeadline, Date.now() + REPLACEMENT_TIMEOUT_MS);
      return summarizeBackend(
        await waitForReplacementBackend(root, replacedInstanceId, expectedHash, expectedFlavor, replacementDeadline),
      );
    } finally {
      releaseReplacementLock(root, replacementLock);
    }
  }

  throw new Error(
    'Timed out waiting for Coral backend startup. Use the backend tool with op: "status" to check backend health.',
  );
}
