import { readFileSync, renameSync, unlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { backendLockPath, pluginRootNamespace } from '../infra/paths.js';
import { readBackendInfo } from '../infra/backend-info.js';
import { isNoEntryError, isProcessAlive, tryExclusiveWrite } from '../shared/utils.js';
import { backendLog } from '../shared/backend-log.js';

export { backendLockPath } from '../infra/paths.js';
export const STARTUP_DEADLINE = 30_000;
export const CONTENDER_BUDGET = 90_000;

const RETRY_DELAY_MS = 200;
const HEALTHCHECK_TIMEOUT_MS = 1_000;

export type LockRecord = {
  instanceId: string;
  pid: number;
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  startedAt: number;
};

type LockSnapshot = {
  raw: string;
  record: LockRecord | null;
};

export class BackendAlreadyRunningError extends Error {
  constructor() {
    super('Coral backend already running');
    this.name = 'BackendAlreadyRunningError';
  }
}

function isLockRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.instanceId === 'string' &&
    record.instanceId.length > 0 &&
    Number.isInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.version === 'string' &&
    record.version.length > 0 &&
    typeof record.bundleHash === 'string' &&
    record.bundleHash.length > 0 &&
    (record.flavor === 'prod' || record.flavor === 'dev') &&
    Number.isFinite(record.startedAt) &&
    (record.startedAt as number) > 0
  );
}

function parseLockRecord(raw: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isLockRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readLockSnapshot(pluginRoot: string): LockSnapshot | null {
  try {
    const raw = readFileSync(backendLockPath(pluginRoot), 'utf-8');
    return { raw, record: parseLockRecord(raw) };
  } catch (error: unknown) {
    if (isNoEntryError(error)) return null;
    throw error;
  }
}

function snapshotKey(snapshot: LockSnapshot): string {
  if (snapshot.record) {
    return `${snapshot.record.instanceId}:${snapshot.record.pid}:${snapshot.record.version}:${snapshot.record.flavor}:${snapshot.record.startedAt}`;
  }
  return `invalid:${snapshot.raw}`;
}

function writeLockFile(pluginRoot: string, record: LockRecord): boolean {
  return tryExclusiveWrite(backendLockPath(pluginRoot), JSON.stringify(record));
}

async function isMatchingHealthyBackend(pluginRoot: string, record: LockRecord): Promise<boolean> {
  const expectedNamespace = pluginRootNamespace(pluginRoot);
  const info = readBackendInfo(pluginRoot);
  if (!info) return false;
  if (
    info.instanceId !== record.instanceId ||
    info.pid !== record.pid ||
    info.bundleHash !== record.bundleHash ||
    info.flavor !== record.flavor ||
    info.namespace !== expectedNamespace
  ) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);

  try {
    const response = await fetch(`http://${info.host}:${info.port}/health`, {
      method: 'GET',
      headers: { 'X-Coral-Backend-Token': info.token },
      signal: controller.signal,
    });

    if (!response.ok) return false;

    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') return false;

    const payload = body as Record<string, unknown>;
    return (
      payload.status === 'ok' &&
      payload.bundleHash === record.bundleHash &&
      payload.flavor === record.flavor &&
      payload.instanceId === record.instanceId &&
      payload.namespace === expectedNamespace
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function removeLockIfSnapshotMatches(pluginRoot: string, snapshot: LockSnapshot): boolean {
  const lockPath = backendLockPath(pluginRoot);
  const stagePath = `${lockPath}.removing`;

  // Atomically move the lock aside, verify ownership, then delete.
  // If a replacement wrote between our read and rename, rename fails (ENOENT)
  // or the staged content won't match — we restore in that case.
  try {
    renameSync(lockPath, stagePath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return true; // already gone
    throw error;
  }

  try {
    const staged = readFileSync(stagePath, 'utf-8');
    if (staged !== snapshot.raw) {
      // Content changed between our read and rename — restore it
      try {
        renameSync(stagePath, lockPath);
      } catch {
        /* best effort */
      }
      return false;
    }
    unlinkSync(stagePath);
    return true;
  } catch (error: unknown) {
    // Cleanup staged file on unexpected error
    try {
      unlinkSync(stagePath);
    } catch {
      /* best effort */
    }
    if (isNoEntryError(error)) return true;
    throw error;
  }
}

export async function acquireLock(
  pluginRoot: string,
  instanceId: string,
  version: string,
  bundleHash: string,
  flavor: 'prod' | 'dev',
): Promise<void> {
  const record: LockRecord = {
    instanceId,
    pid: process.pid,
    version,
    bundleHash,
    flavor,
    startedAt: Date.now(),
  };

  let observedKey: string | null = null;
  let observedAt = Date.now();
  const contenderStartedAt = Date.now();

  while (true) {
    if (Date.now() - contenderStartedAt >= CONTENDER_BUDGET) {
      backendLog.error(`Lock acquisition timed out after ${CONTENDER_BUDGET}ms`);
      throw new Error('Coral backend lock acquisition timed out');
    }

    if (writeLockFile(pluginRoot, record)) return;

    const snapshot = readLockSnapshot(pluginRoot);
    if (!snapshot) {
      observedKey = null;
      observedAt = Date.now();
      continue;
    }

    const currentKey = snapshotKey(snapshot);
    if (currentKey !== observedKey) {
      observedKey = currentKey;
      observedAt = Date.now();
    }

    const deadlineExpired = Date.now() - observedAt >= STARTUP_DEADLINE;
    const ownerAlive = snapshot.record ? isProcessAlive(snapshot.record.pid) : false;

    if (snapshot.record && ownerAlive) {
      if (await isMatchingHealthyBackend(pluginRoot, snapshot.record)) {
        throw new BackendAlreadyRunningError();
      }
      if (!deadlineExpired) {
        await delay(RETRY_DELAY_MS);
        continue;
      }
    } else if (!snapshot.record && !deadlineExpired) {
      await delay(RETRY_DELAY_MS);
      continue;
    }

    if (removeLockIfSnapshotMatches(pluginRoot, snapshot)) {
      observedKey = null;
      observedAt = Date.now();
      continue;
    }

    await delay(RETRY_DELAY_MS);
  }
}

export function removeLockIfOwner(pluginRoot: string, instanceId: string): void {
  const lockPath = backendLockPath(pluginRoot);
  const stagePath = `${lockPath}.removing`;

  // Atomically stage the lock, verify ownership, then delete.
  try {
    renameSync(lockPath, stagePath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }

  try {
    const raw = readFileSync(stagePath, 'utf-8');
    const record = parseLockRecord(raw);
    if (!record || record.instanceId !== instanceId) {
      // Not ours — restore it
      try {
        renameSync(stagePath, lockPath);
      } catch {
        /* best effort */
      }
      return;
    }
    unlinkSync(stagePath);
  } catch (error: unknown) {
    try {
      unlinkSync(stagePath);
    } catch {
      /* best effort */
    }
    if (isNoEntryError(error)) return;
    throw error;
  }
}
