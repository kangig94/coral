import { z } from 'zod';
import { dirname, join } from 'node:path';
import type { StoragePort } from '../infra/port-types.js';
import { STORE_LOCK_FILE_NAME } from '../store/epoch/index.js';
import type { SourceReadDisposition } from './wait/session.js';

export class HistoricalDecodeError extends Error {}

/** Only the job decoder can settle a read; source failures belong to the epoch's maintenance owner. */
export function sourceReadFailureDisposition(error: unknown): Exclude<SourceReadDisposition, 'readable' | 'retired'> {
  return error instanceof z.ZodError || error instanceof SyntaxError || error instanceof HistoricalDecodeError
    ? 'settled-unreadable'
    : 'transient-unknown';
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
