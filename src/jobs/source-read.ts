import { z } from 'zod';
import { AssertionError } from 'node:assert';
import { dirname, join } from 'node:path';
import type { StoragePort } from '../infra/port-types.js';
import { STORE_LOCK_FILE_NAME } from '../store/epoch/index.js';
import { StoreCodecError, StoreDecodeError } from '../store/body-codec.js';

/** Source reads settle per job.
 * readable: observed success; transient-unknown: busy/lock contention or a retry-scheduled hold;
 * settled-unreadable: decode/parse, unsupported fingerprint or an owner-settled hold;
 * retired: observed source retirement.
 */
export type SourceReadDisposition = 'readable' | 'transient-unknown' | 'settled-unreadable' | 'retired';

export class HistoricalDecodeError extends Error {}

/** Only the job decoder can settle a read; source failures belong to the epoch's maintenance owner. */
export function sourceReadFailureDisposition(error: unknown): Exclude<SourceReadDisposition, 'readable' | 'retired'> {
  return error instanceof z.ZodError ||
    error instanceof SyntaxError ||
    error instanceof HistoricalDecodeError ||
    error instanceof StoreCodecError ||
    error instanceof StoreDecodeError
    ? 'settled-unreadable'
    : 'transient-unknown';
}

/** A code defect is not evidence about a source: a read path propagates it instead of holding a job behind it. */
export function isCodeDefect(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof AssertionError
  );
}

/** Cache only an observed read in its session, and invalidate on journal, guard or identity replacement. */
export function sourceReadStamp(storage: StoragePort, path: string): string | null {
  try {
    return [
      path,
      `${path}-wal`,
      join(dirname(path), STORE_LOCK_FILE_NAME),
      join(dirname(path), '.coral-lineage.v1.json'),
    ]
      .map((file) => {
        try {
          const stat = storage.lstatSync(file, { bigint: true });
          return `${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}`;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return `${file}:absent`;
          throw error;
        }
      })
      .join('|');
  } catch {
    return null;
  }
}
