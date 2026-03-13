import { readFileSync, unlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { backendLockPath } from '../client/paths.js';
import { readBackendInfo } from './backend-info.js';
import { isNoEntryError, isProcessAlive, tryExclusiveWrite } from '../shared/mcp-utils.js';

export { backendLockPath } from '../client/paths.js';
export const STARTUP_DEADLINE = 30_000;

const RETRY_DELAY_MS = 200;
const HEALTHCHECK_TIMEOUT_MS = 1_000;

export type LockRecord = {
  instanceId: string;
  pid: number;
  version: string;
  bundleHash: string;
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
  return typeof record.instanceId === 'string'
    && record.instanceId.length > 0
    && Number.isInteger(record.pid)
    && (record.pid as number) > 0
    && typeof record.version === 'string'
    && record.version.length > 0
    && typeof record.bundleHash === 'string'
    && record.bundleHash.length > 0
    && Number.isFinite(record.startedAt)

    && (record.startedAt as number) > 0;
}

function parseLockRecord(raw: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isLockRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readLockSnapshot(): LockSnapshot | null {
  try {
    const raw = readFileSync(backendLockPath(), 'utf-8');
    return { raw, record: parseLockRecord(raw) };
  } catch (error: unknown) {
    if (isNoEntryError(error)) return null;
    throw error;
  }
}

function snapshotKey(snapshot: LockSnapshot): string {
  if (snapshot.record) {
    return `${snapshot.record.instanceId}:${snapshot.record.pid}:${snapshot.record.version}:${snapshot.record.startedAt}`;
  }
  return `invalid:${snapshot.raw}`;
}

function writeLockFile(record: LockRecord): boolean {
  return tryExclusiveWrite(backendLockPath(), JSON.stringify(record));
}

async function isMatchingHealthyBackend(record: LockRecord): Promise<boolean> {
  const info = readBackendInfo();
  if (!info) return false;
  if (info.instanceId !== record.instanceId || info.pid !== record.pid || info.bundleHash !== record.bundleHash) {
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
    return payload.status === 'ok'
      && payload.bundleHash === record.bundleHash
      && payload.instanceId === record.instanceId;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function removeLockIfSnapshotMatches(snapshot: LockSnapshot): boolean {
  const current = readLockSnapshot();
  if (!current) return true;
  if (current.raw !== snapshot.raw) return false;

  try {
    unlinkSync(backendLockPath());
    return true;
  } catch (error: unknown) {
    if (isNoEntryError(error)) return true;
    throw error;
  }
}

export async function acquireLock(instanceId: string, version: string, bundleHash: string): Promise<void> {
  const record: LockRecord = {
    instanceId,
    pid: process.pid,
    version,
    bundleHash,
    startedAt: Date.now(),
  };

  let observedKey: string | null = null;
  let observedAt = Date.now();

  while (true) {
    if (writeLockFile(record)) return;

    const snapshot = readLockSnapshot();
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
      if (await isMatchingHealthyBackend(snapshot.record)) {
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

    if (removeLockIfSnapshotMatches(snapshot)) {
      observedKey = null;
      observedAt = Date.now();
      continue;
    }

    await delay(RETRY_DELAY_MS);
  }
}

export function removeLockIfOwner(instanceId: string): void {
  const snapshot = readLockSnapshot();
  if (!snapshot?.record || snapshot.record.instanceId !== instanceId) return;

  try {
    unlinkSync(backendLockPath());
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}
