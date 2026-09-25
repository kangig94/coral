import { dirname, join } from 'node:path';
import { z } from 'zod';

import { acquireSharedFileLockSync } from '../infra/fs-lock.js';
import type { Runtime } from '../runtime/ports.js';
import type { ResolvedStoreEpoch } from './epoch.js';

const lineageSchema = z.object({ version: z.literal('v1'), lineageId: z.string().uuid() }).passthrough();
const LINEAGE_FILE = '.coral-lineage.v1.json';

export function readEpochKey(runtime: Pick<Runtime, 'storage'>, epoch: ResolvedStoreEpoch): string | null {
  let release: (() => void) | null = null;
  let key: string | null;
  try {
    release = acquireSharedFileLockSync(join(dirname(epoch.path), '.lock'));
    const lineage = lineageSchema.parse(
      JSON.parse(runtime.storage.readFileSync(join(dirname(epoch.path), LINEAGE_FILE), 'utf-8')) as unknown,
    );
    key = `${lineage.lineageId}:${epoch.epoch}`;
  } catch {
    key = null;
  }
  try {
    release?.();
  } catch {
    return null;
  }
  return key;
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
