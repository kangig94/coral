import { dirname, join } from 'node:path';
import { z } from 'zod';

import { acquireSharedFileLockNoRepairSync, acquireSharedFileLockSync } from '../../infra/fs-lock.js';
import type { Runtime } from '../../runtime/ports.js';
import type { ResolvedStoreEpoch } from './types.js';

const lineageSchema = z.object({ version: z.literal('v1'), lineageId: z.string().uuid() }).passthrough();
const LINEAGE_FILE = '.coral-lineage.v1.json';

/** `absent` is only a missing marker read under the epoch lock; every other failure is `unreadable`. */
export type EpochKeyObservation =
  | Readonly<{ kind: 'present'; key: string }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unreadable' }>;

export function observeEpochKey(
  runtime: Pick<Runtime, 'storage'>,
  epoch: ResolvedStoreEpoch,
  busyTimeoutMs = 0,
): EpochKeyObservation {
  const lockPath = join(dirname(epoch.path), '.lock');
  let release: (() => void) | null = null;
  let observed: EpochKeyObservation;
  try {
    const lockEntry = runtime.storage.lstatSync(lockPath, { bigint: true });
    release = acquireSharedFileLockNoRepairSync(lockPath, busyTimeoutMs);
    try {
      const lineage = lineageSchema.parse(
        JSON.parse(runtime.storage.readFileSync(join(dirname(epoch.path), LINEAGE_FILE), 'utf-8')) as unknown,
      );
      observed = { kind: 'present', key: `${lineage.lineageId}:${epoch.epoch}` };
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      // The directory moves only under an exclusive epoch lock, so the held lock still at its path pins the read.
      const heldEntry = runtime.storage.lstatSync(lockPath, { bigint: true });
      observed =
        heldEntry.dev === lockEntry.dev && heldEntry.ino === lockEntry.ino
          ? { kind: 'absent' }
          : { kind: 'unreadable' };
    }
  } catch {
    observed = { kind: 'unreadable' };
  }
  try {
    release?.();
  } catch {
    return { kind: 'unreadable' };
  }
  return observed;
}

export function readEpochKey(
  runtime: Pick<Runtime, 'storage'>,
  epoch: ResolvedStoreEpoch,
  busyTimeoutMs = 0,
): string | null {
  const observed = observeEpochKey(runtime, epoch, busyTimeoutMs);
  return observed.kind === 'present' ? observed.key : null;
}

/** Inspection may not open the epoch lock: a SQLite open of a crashed WAL lock creates sidecar files. */
export function inspectEpochKey(runtime: Pick<Runtime, 'storage'>, epoch: ResolvedStoreEpoch): string | null {
  try {
    const lineage = lineageSchema.parse(
      JSON.parse(runtime.storage.readFileSync(join(dirname(epoch.path), LINEAGE_FILE), 'utf-8')) as unknown,
    );
    return `${lineage.lineageId}:${epoch.epoch}`;
  } catch {
    return null;
  }
}

export function readOrCreateEpochKey(
  runtime: Pick<Runtime, 'storage' | 'ids' | 'env'>,
  epoch: ResolvedStoreEpoch,
): string {
  const release = acquireSharedFileLockSync(join(dirname(epoch.path), '.lock'));
  try {
    return readOrCreateEpochKeyUnderLock(runtime, epoch);
  } finally {
    release();
  }
}

function readOrCreateEpochKeyUnderLock(
  runtime: Pick<Runtime, 'storage' | 'ids' | 'env'>,
  epoch: ResolvedStoreEpoch,
): string {
  const directory = dirname(epoch.path);
  const marker = join(directory, LINEAGE_FILE);
  let lineage: z.infer<typeof lineageSchema>;
  try {
    lineage = lineageSchema.parse(JSON.parse(runtime.storage.readFileSync(marker, 'utf-8')) as unknown);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const value = { version: 'v1', lineageId: runtime.ids.uuid() } as const;
    const stage = `${marker}.stage.${runtime.env.pid()}.${runtime.ids.uuid()}`;
    let fd: number | null = null;
    try {
      fd = runtime.storage.openSync(stage, 'wx', 0o600);
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      runtime.storage.writeSync(fd, bytes, 0, bytes.length, null);
      runtime.storage.fdatasyncSync(fd);
      runtime.storage.closeSync(fd);
      fd = null;
      runtime.storage.linkSync(stage, marker);
      lineage = value;
    } catch (createError: unknown) {
      if (!(createError instanceof Error && 'code' in createError && createError.code === 'EEXIST')) {
        throw createError;
      }
      lineage = lineageSchema.parse(JSON.parse(runtime.storage.readFileSync(marker, 'utf-8')) as unknown);
    } finally {
      if (fd !== null) runtime.storage.closeSync(fd);
      runtime.storage.rmSync(stage, { force: true });
    }
    if (!runtime.storage.syncDirectoryDurableSync(directory)) {
      throw new Error('Epoch lineage directory sync failed.', { cause: error });
    }
  }
  return `${lineage.lineageId}:${epoch.epoch}`;
}
