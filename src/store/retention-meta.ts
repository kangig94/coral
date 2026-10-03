import { z } from 'zod';
import { backendLog } from '../infra/backend-log.js';
import type { Database } from './db.js';
import type { RetentionRunBudget } from './retention-outcome.js';

/** Invalid bookkeeping is preserved separately; deletion authority must be reconstructed by its owner. */
export function readRetentionMeta<Value>(input: {
  db: Database;
  key: string;
  decode(value: string): Value;
  fresh(reset: boolean): Value;
  mutate<T>(operation: () => T): T;
  record: RetentionRunBudget['record'];
}): { value: Value; reset: boolean } {
  const saved = input.db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get(input.key);
  if (saved === undefined) return { value: input.fresh(false), reset: false };
  let value: Value;
  try {
    value = input.decode(saved.value);
  } catch {
    const quarantineKey = `storage-retention.quarantine.v1.${input.key}`;
    const previous = input.db
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get(quarantineKey);
    input.mutate(() => {
      input.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(quarantineKey, saved.value);
      input.db.prepare('DELETE FROM meta WHERE key = ?').run(input.key);
    });
    if (previous?.value !== saved.value) {
      backendLog.warn(`Storage retention quarantined ${input.key}; restarting with fresh evidence.`);
      input.record({ kind: 'kept', subject: input.key, reason: 'metadata-quarantined-restarted', pending: false });
    }
    return { value: input.fresh(true), reset: true };
  }
  return { value, reset: false };
}

export function isRetentionChildName(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !/[\\/\0]/u.test(value);
}

/** Raw scan cursors carry identifiers rather than JSON; an invalid cursor restarts enumeration. */
export function readRetentionCursor(input: {
  db: Database;
  key: string;
  mutate<T>(operation: () => T): T;
  record: RetentionRunBudget['record'];
}): string {
  return readRetentionMeta({
    ...input,
    decode: (value) =>
      z
        .string()
        .refine((cursor) => cursor === '' || isRetentionChildName(cursor))
        .parse(value),
    fresh: () => '',
  }).value;
}
