import { isNoEntryError, tryExclusiveWrite } from '../shared/utils.js';
import { backendLog } from '../shared/backend-log.js';
import type { Runtime, RuntimeStoragePort } from './runtime.js';

export { backendLockPath } from '../infra/paths.js';
export const STARTUP_DEADLINE = 30_000;
export const CONTENDER_BUDGET = 90_000;

const RETRY_DELAY_MS = 200;

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

export type BackendOwnershipState = 'healthy' | 'contended' | 'stale';

export type VerifyBackendOwnershipFn = (options: {
  pluginRoot: string;
  record: LockRecord;
}) => Promise<BackendOwnershipState>;

type BackendLockRuntime = Pick<Runtime, 'env' | 'storage' | 'time'> & {
  verifyOwnership: VerifyBackendOwnershipFn;
};

type BackendLockStorage = Pick<
  RuntimeStoragePort,
  'backendLockPath' | 'tryExclusiveWriteSync' | 'readFileSync' | 'renameSync' | 'unlinkSync'
>;

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

function readLockSnapshot(pluginRoot: string, storage: Pick<BackendLockStorage, 'backendLockPath' | 'readFileSync'>): LockSnapshot | null {
  try {
    const raw = storage.readFileSync(storage.backendLockPath(pluginRoot), 'utf-8');
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

function writeLockFile(
  pluginRoot: string,
  record: LockRecord,
  storage: Pick<BackendLockStorage, 'backendLockPath' | 'tryExclusiveWriteSync'>,
): boolean {
  return tryExclusiveWrite(storage.backendLockPath(pluginRoot), JSON.stringify(record), storage);
}

function removeLockIfSnapshotMatches(
  pluginRoot: string,
  snapshot: LockSnapshot,
  storage: Pick<BackendLockStorage, 'backendLockPath' | 'readFileSync' | 'renameSync' | 'unlinkSync'>,
): boolean {
  const lockPath = storage.backendLockPath(pluginRoot);
  const stagePath = `${lockPath}.removing`;

  // Atomically move the lock aside, verify ownership, then delete.
  // If a replacement wrote between our read and rename, rename fails (ENOENT)
  // or the staged content won't match — we restore in that case.
  try {
    storage.renameSync(lockPath, stagePath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return true; // already gone
    throw error;
  }

  try {
    const staged = storage.readFileSync(stagePath, 'utf-8');
    if (staged !== snapshot.raw) {
      // Content changed between our read and rename — restore it
      try {
        storage.renameSync(stagePath, lockPath);
      } catch {
        /* best effort */
      }
      return false;
    }
    storage.unlinkSync(stagePath);
    return true;
  } catch (error: unknown) {
    // Cleanup staged file on unexpected error
    try {
      storage.unlinkSync(stagePath);
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
  runtime: BackendLockRuntime,
): Promise<void> {
  const record: LockRecord = {
    instanceId,
    pid: runtime.env.pid(),
    version,
    bundleHash,
    flavor,
    startedAt: runtime.time.now(),
  };

  let observedKey: string | null = null;
  let observedAt = runtime.time.now();
  const contenderStartedAt = runtime.time.now();

  while (true) {
    if (runtime.time.now() - contenderStartedAt >= CONTENDER_BUDGET) {
      backendLog.error(`Lock acquisition timed out after ${CONTENDER_BUDGET}ms`);
      throw new Error('Coral backend lock acquisition timed out');
    }

    if (writeLockFile(pluginRoot, record, runtime.storage)) return;

    const snapshot = readLockSnapshot(pluginRoot, runtime.storage);
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
        await runtime.time.sleep(RETRY_DELAY_MS);
        continue;
      }
    } else if (!deadlineExpired) {
      await runtime.time.sleep(RETRY_DELAY_MS);
      continue;
    }

    if (removeLockIfSnapshotMatches(pluginRoot, snapshot, runtime.storage)) {
      observedKey = null;
      observedAt = runtime.time.now();
      continue;
    }

    await runtime.time.sleep(RETRY_DELAY_MS);
  }
}

export function removeLockIfOwner(
  pluginRoot: string,
  instanceId: string,
  storage: Pick<BackendLockStorage, 'backendLockPath' | 'readFileSync' | 'renameSync' | 'unlinkSync'>,
): void {
  const lockPath = storage.backendLockPath(pluginRoot);
  const stagePath = `${lockPath}.removing`;

  // Atomically stage the lock, verify ownership, then delete.
  try {
    storage.renameSync(lockPath, stagePath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }

  try {
    const raw = storage.readFileSync(stagePath, 'utf-8');
    const record = parseLockRecord(raw);
    if (!record || record.instanceId !== instanceId) {
      // Not ours — restore it
      try {
        storage.renameSync(stagePath, lockPath);
      } catch {
        /* best effort */
      }
      return;
    }
    storage.unlinkSync(stagePath);
  } catch (error: unknown) {
    try {
      storage.unlinkSync(stagePath);
    } catch {
      /* best effort */
    }
    if (isNoEntryError(error)) return;
    throw error;
  }
}
