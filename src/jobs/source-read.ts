import { z } from 'zod';
import { dirname, join } from 'node:path';
import type { StoragePort } from '../infra/port-types.js';
import { STORE_LOCK_FILE_NAME } from '../store/epoch/index.js';
import type { SourceReadDisposition } from './wait/session.js';

/** Permission, identity and format failures require intervention; contention has an automatic exit. */
export function sourceReadFailureDisposition(error: unknown): Exclude<SourceReadDisposition, 'readable' | 'retired'> {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'settled-unreadable';
  if (error instanceof Error) {
    const code = 'code' in error ? error.code : undefined;
    if (
      code === 'EACCES' ||
      code === 'EPERM' ||
      code === 'ENOENT' ||
      /not a database|database disk image is malformed|no such (table|column)|malformed|cannot be decoded|identity|unsupported/i.test(
        error.message,
      )
    )
      return 'settled-unreadable';
  }
  return 'transient-unknown';
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
