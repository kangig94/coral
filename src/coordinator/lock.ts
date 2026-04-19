import { readFileSync } from 'node:fs';

import type { BuildFlavor } from '../runtime/flavor.js';
import type { Runtime, RuntimeStoragePort } from '../runtime/ports.js';
import type { LockRecord } from '../shared/lock-types.js';
import { isNoEntryError } from '../shared/utils.js';
import { readBuildFlavor } from '../shared/utils.js';
import { probeCoordinator, probeProcessStartedAtSeconds } from './discovery.js';
import { coordinatorLog } from './log.js';
import { coordinatorPaths } from './paths.js';

const RETRY_DELAY_MS = 200;
const HEALTHCHECK_TIMEOUT_MS = 1_000;
const DEFAULT_HOST = '127.0.0.1';

export const STARTUP_DEADLINE = 30_000;
export const CONTENDER_BUDGET = 90_000;
export type { LockRecord } from '../shared/lock-types.js';
export type BackendOwnershipState = 'healthy' | 'contended' | 'stale';
export type VerifyBackendOwnershipFn = (options: {
  pluginRoot: string;
  record: LockRecord;
}) => Promise<BackendOwnershipState>;

export class BackendAlreadyRunningError extends Error {
  constructor() {
    super('Coral backend already running');
    this.name = 'BackendAlreadyRunningError';
  }
}

export function backendLockPath(pluginRoot: string): string {
  return coordinatorPaths(readBuildFlavor(pluginRoot)).lockFile;
}

type LockSnapshot = {
  raw: string;
  record: LockRecord | null;
};

type CoordinatorLockRuntime = Pick<Runtime, 'env' | 'process' | 'storage' | 'time'>;

type LockState = {
  flavor: BuildFlavor;
  record: LockRecord;
};

type IncumbentState = 'healthy_same' | 'healthy_replacing' | 'contended' | 'stale';

const activeLocks = new Map<string, LockState>();

type CompatBackendLockStorage = Pick<
  RuntimeStoragePort,
  'tryExclusiveWriteSync' | 'readFileSync' | 'renameSync' | 'unlinkSync'
>;
type CompatBackendLockPaths = {
  backendLockPath(pluginRoot: string): string;
};
type CompatBackendLockRuntime = Pick<Runtime, 'env' | 'storage' | 'paths' | 'time'> & {
  verifyOwnership: VerifyBackendOwnershipFn;
};
type LockFileStorage = Pick<RuntimeStoragePort, 'tryExclusiveWriteSync' | 'readFileSync' | 'renameSync' | 'unlinkSync'>;

function sleepForRetry(time: Pick<Runtime['time'], 'setTimeout' | 'sleep'>, ms: number): Promise<void> {
  if (typeof time.setTimeout !== 'function') {
    return time.sleep(ms);
  }
  return new Promise((resolve) => {
    time.setTimeout(resolve, ms);
  });
}

function lockFilePath(flavor: BuildFlavor): string {
  return coordinatorPaths(flavor).lockFile;
}

function isLockRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

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
    (record.startedAt as number) > 0 &&
    (record.processStartedAt === undefined ||
      (Number.isInteger(record.processStartedAt) && (record.processStartedAt as number) > 0))
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

function snapshotKey(snapshot: LockSnapshot): string {
  if (!snapshot.record) {
    return `invalid:${snapshot.raw}`;
  }

  return [
    snapshot.record.instanceId,
    snapshot.record.pid,
    snapshot.record.version,
    snapshot.record.bundleHash,
    snapshot.record.flavor,
    snapshot.record.startedAt,
    snapshot.record.processStartedAt ?? 'na',
  ].join(':');
}

function readLockSnapshotAt(
  lockPath: string,
  storage: Pick<LockFileStorage, 'readFileSync'>,
): LockSnapshot | null {
  try {
    const raw = storage.readFileSync(lockPath, 'utf-8');
    return { raw, record: parseLockRecord(raw) };
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
}

function readLockSnapshot(
  flavor: BuildFlavor,
  storage: Pick<RuntimeStoragePort, 'readFileSync'>,
): LockSnapshot | null {
  return readLockSnapshotAt(lockFilePath(flavor), storage);
}

function writeLockFileAt(
  lockPath: string,
  record: LockRecord,
  storage: Pick<LockFileStorage, 'tryExclusiveWriteSync'>,
): boolean {
  return storage.tryExclusiveWriteSync(lockPath, JSON.stringify(record), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

function writeLockFile(
  flavor: BuildFlavor,
  record: LockRecord,
  storage: Pick<RuntimeStoragePort, 'tryExclusiveWriteSync'>,
): boolean {
  return writeLockFileAt(lockFilePath(flavor), record, storage);
}

function removeLockIfSnapshotMatchesAt(
  lockPath: string,
  snapshot: LockSnapshot,
  storage: Pick<LockFileStorage, 'readFileSync' | 'renameSync' | 'unlinkSync'>,
): boolean {
  const stagePath = `${lockPath}.removing`;

  try {
    storage.renameSync(lockPath, stagePath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return true;
    }
    throw error;
  }

  try {
    const staged = storage.readFileSync(stagePath, 'utf-8');
    if (staged !== snapshot.raw) {
      try {
        storage.renameSync(stagePath, lockPath);
      } catch {
        // Best-effort restore.
      }
      return false;
    }

    storage.unlinkSync(stagePath);
    return true;
  } catch (error: unknown) {
    try {
      storage.unlinkSync(stagePath);
    } catch {
      // Best-effort cleanup.
    }
    if (isNoEntryError(error)) {
      return true;
    }
    throw error;
  }
}

function removeLockIfSnapshotMatches(
  flavor: BuildFlavor,
  snapshot: LockSnapshot,
  storage: Pick<RuntimeStoragePort, 'readFileSync' | 'renameSync' | 'unlinkSync'>,
): boolean {
  return removeLockIfSnapshotMatchesAt(lockFilePath(flavor), snapshot, storage);
}

function readCompatLockSnapshot(
  pluginRoot: string,
  storage: Pick<CompatBackendLockStorage, 'readFileSync'>,
  paths: CompatBackendLockPaths,
): LockSnapshot | null {
  return readLockSnapshotAt(paths.backendLockPath(pluginRoot), storage);
}

function writeCompatLockFile(
  pluginRoot: string,
  record: LockRecord,
  storage: Pick<CompatBackendLockStorage, 'tryExclusiveWriteSync'>,
  paths: CompatBackendLockPaths,
): boolean {
  return writeLockFileAt(paths.backendLockPath(pluginRoot), record, storage);
}

function removeCompatLockIfSnapshotMatches(
  pluginRoot: string,
  snapshot: LockSnapshot,
  storage: Pick<CompatBackendLockStorage, 'readFileSync' | 'renameSync' | 'unlinkSync'>,
  paths: CompatBackendLockPaths,
): boolean {
  return removeLockIfSnapshotMatchesAt(paths.backendLockPath(pluginRoot), snapshot, storage);
}

async function acquireCompatLock(
  pluginRoot: string,
  instanceId: string,
  version: string,
  bundleHash: string,
  flavor: 'prod' | 'dev',
  runtime: CompatBackendLockRuntime,
): Promise<void> {
  const pid = runtime.env.pid();
  const record: LockRecord = {
    instanceId,
    pid,
    version,
    bundleHash,
    flavor,
    startedAt: runtime.time.now(),
    processStartedAt: probeProcessStartedAtSeconds(pid, runtime.env.platform() as NodeJS.Platform) ?? undefined,
  };

  let observedKey: string | null = null;
  let observedAt = runtime.time.now();
  const contenderStartedAt = runtime.time.now();

  while (true) {
    if (runtime.time.now() - contenderStartedAt >= CONTENDER_BUDGET) {
      coordinatorLog.error(`Compat lock acquisition timed out after ${CONTENDER_BUDGET}ms`);
      throw new Error('Coral backend lock acquisition timed out');
    }

    if (writeCompatLockFile(pluginRoot, record, runtime.storage, runtime.paths)) {
      return;
    }

    const snapshot = readCompatLockSnapshot(pluginRoot, runtime.storage, runtime.paths);
    if (!snapshot) {
      observedKey = null;
      observedAt = runtime.time.now();
      continue;
    }

    const currentKey = snapshotKey(snapshot);
    if (currentKey !== observedKey) {
      observedKey = currentKey;
      observedAt = runtime.time.now();
    }

    const deadlineExpired = runtime.time.now() - observedAt >= STARTUP_DEADLINE;
    if (snapshot.record) {
      const ownershipState = await runtime.verifyOwnership({ pluginRoot, record: snapshot.record });
      if (ownershipState === 'healthy') {
        throw new BackendAlreadyRunningError();
      }
      if (ownershipState === 'contended' && !deadlineExpired) {
        await sleepForRetry(runtime.time, RETRY_DELAY_MS);
        continue;
      }
    } else if (!deadlineExpired) {
      await sleepForRetry(runtime.time, RETRY_DELAY_MS);
      continue;
    }

    if (removeCompatLockIfSnapshotMatches(pluginRoot, snapshot, runtime.storage, runtime.paths)) {
      observedKey = null;
      observedAt = runtime.time.now();
      continue;
    }

    await sleepForRetry(runtime.time, RETRY_DELAY_MS);
  }
}

async function readHealth(
  runtime: CoordinatorLockRuntime,
  lockRecord: LockRecord,
): Promise<{ status: string; bundleHash?: string; flavor?: string } | null> {
  const discovery = probeCoordinator(lockRecord.flavor, {
    storage: runtime.storage,
    env: runtime.env,
  });
  if (!discovery) {
    return null;
  }

  if (discovery.pid !== lockRecord.pid || discovery.bundleHash !== lockRecord.bundleHash) {
    return null;
  }

  const controller = new AbortController();
  const timeout = runtime.time.setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);

  try {
    const response = await fetch(`http://${discovery.host ?? DEFAULT_HOST}:${discovery.port}/health`, {
      method: 'GET',
      headers: { 'X-Coral-Backend-Token': discovery.token },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }

    const body: unknown = await response.json();
    return body && typeof body === 'object' ? (body as { status: string; bundleHash?: string; flavor?: string }) : null;
  } catch {
    return null;
  } finally {
    runtime.time.clearTimeout(timeout);
  }
}

async function requestHandoff(runtime: CoordinatorLockRuntime, flavor: BuildFlavor): Promise<void> {
  const discovery = probeCoordinator(flavor, {
    storage: runtime.storage,
    env: runtime.env,
  });
  if (!discovery) {
    return;
  }

  const controller = new AbortController();
  const timeout = runtime.time.setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);

  try {
    await fetch(`http://${discovery.host ?? DEFAULT_HOST}:${discovery.port}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': discovery.token },
      signal: controller.signal,
    });
  } catch {
    // Best-effort request; contender loop handles retries/timeouts.
  } finally {
    runtime.time.clearTimeout(timeout);
  }
}

async function inspectIncumbent(
  requestedBundleHash: string,
  snapshot: LockSnapshot,
  runtime: CoordinatorLockRuntime,
  probeCache: Map<string, number | null>,
): Promise<IncumbentState> {
  const record = snapshot.record;
  if (!record) {
    return 'contended';
  }

  if (!runtime.process.isAlive(record.pid)) {
    return 'stale';
  }

  if (record.processStartedAt !== undefined) {
    const cacheKey = `${record.pid}:${record.processStartedAt}`;
    let probed = probeCache.get(cacheKey);
    if (probed === undefined && !probeCache.has(cacheKey)) {
      probed = probeProcessStartedAtSeconds(record.pid, runtime.env.platform() as NodeJS.Platform);
      probeCache.set(cacheKey, probed);
    }
    if (record.processStartedAt !== probed) {
      return 'stale';
    }
  }

  const health = await readHealth(runtime, record);
  if (!health || health.status === 'draining') {
    return 'contended';
  }

  if (health.bundleHash === record.bundleHash && health.flavor === record.flavor) {
    return record.bundleHash === requestedBundleHash ? 'healthy_same' : 'healthy_replacing';
  }

  return 'contended';
}

async function acquireCoordinatorLock(
  flavor: BuildFlavor,
  bundleHash: string,
  options: {
    instanceId: string;
    version: string;
    runtime: CoordinatorLockRuntime;
  },
): Promise<LockRecord> {
  const { instanceId, version, runtime } = options;
  const pid = runtime.env.pid();
  const record: LockRecord = {
    instanceId,
    pid,
    version,
    bundleHash,
    flavor,
    startedAt: runtime.time.now(),
    processStartedAt: probeProcessStartedAtSeconds(pid, runtime.env.platform() as NodeJS.Platform) ?? undefined,
  };

  let observedKey: string | null = null;
  let observedAt = runtime.time.now();
  const contenderStartedAt = runtime.time.now();
  const probeCache = new Map<string, number | null>();

  while (true) {
    if (runtime.time.now() - contenderStartedAt >= CONTENDER_BUDGET) {
      coordinatorLog.error(`Coordinator lock acquisition timed out after ${CONTENDER_BUDGET}ms`);
      throw new Error('Coordinator lock acquisition timed out');
    }

    if (writeLockFile(flavor, record, runtime.storage)) {
      activeLocks.set(instanceId, { flavor, record });
      return record;
    }

    const snapshot = readLockSnapshot(flavor, runtime.storage);
    if (!snapshot) {
      probeCache.clear();
      observedKey = null;
      observedAt = runtime.time.now();
      continue;
    }

    const currentKey = snapshotKey(snapshot);
    if (currentKey !== observedKey) {
      probeCache.clear();
      observedKey = currentKey;
      observedAt = runtime.time.now();
    }

    const deadlineExpired = runtime.time.now() - observedAt >= STARTUP_DEADLINE;
    const incumbent = await inspectIncumbent(bundleHash, snapshot, runtime, probeCache);
    if (incumbent === 'healthy_same') {
      throw new BackendAlreadyRunningError();
    }

    if (incumbent === 'healthy_replacing') {
      await requestHandoff(runtime, flavor);
      await sleepForRetry(runtime.time, RETRY_DELAY_MS);
      continue;
    }

    if (incumbent === 'contended' && !deadlineExpired) {
      await sleepForRetry(runtime.time, RETRY_DELAY_MS);
      continue;
    }

    if (removeLockIfSnapshotMatches(flavor, snapshot, runtime.storage)) {
      observedKey = null;
      observedAt = runtime.time.now();
      continue;
    }

    await sleepForRetry(runtime.time, RETRY_DELAY_MS);
  }
}

export function acquireLock(
  flavor: BuildFlavor,
  bundleHash: string,
  options: {
    instanceId: string;
    version: string;
    runtime: CoordinatorLockRuntime;
  },
): Promise<LockRecord>;
export function acquireLock(
  pluginRoot: string,
  instanceId: string,
  version: string,
  bundleHash: string,
  flavor: 'prod' | 'dev',
  runtime: CompatBackendLockRuntime,
): Promise<void>;
export async function acquireLock(
  arg1: BuildFlavor | string,
  arg2: string,
  arg3:
    | {
        instanceId: string;
        version: string;
        runtime: CoordinatorLockRuntime;
      }
    | string,
  arg4?: string,
  arg5?: 'prod' | 'dev',
  arg6?: CompatBackendLockRuntime,
): Promise<LockRecord | void> {
  if (typeof arg3 === 'object') {
    return acquireCoordinatorLock(arg1 as BuildFlavor, arg2, arg3);
  }

  return acquireCompatLock(arg1, arg2, arg3, arg4 ?? 'unknown', arg5 ?? 'prod', arg6 as CompatBackendLockRuntime);
}

export function releaseLock(
  instanceId?: string,
  runtime?: Pick<Runtime, 'storage'>,
): void {
  const key = instanceId ?? [...activeLocks.keys()].at(-1);
  if (!key) {
    return;
  }

  const state = activeLocks.get(key);
  if (!state) {
    return;
  }

  const storage = runtime?.storage;
  if (!storage) {
    try {
      readFileSync(lockFilePath(state.flavor), 'utf-8');
    } catch {
      activeLocks.delete(key);
      return;
    }
    throw new Error('releaseLock requires runtime.storage when releasing an acquired coordinator lock');
  }

  removeLockIfSnapshotMatches(
    state.flavor,
    { raw: JSON.stringify(state.record), record: state.record },
    storage,
  );
  activeLocks.delete(key);
}

export function removeLockIfOwner(
  pluginRoot: string,
  instanceId: string,
  storage: Pick<CompatBackendLockStorage, 'readFileSync' | 'renameSync' | 'unlinkSync'>,
  paths: CompatBackendLockPaths,
): void {
  const snapshot = readCompatLockSnapshot(pluginRoot, storage, paths);
  if (!snapshot?.record || snapshot.record.instanceId !== instanceId) {
    return;
  }

  removeCompatLockIfSnapshotMatches(pluginRoot, snapshot, storage, paths);
}
