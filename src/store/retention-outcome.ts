/** A kept subject remains pending unless its owner proves it has no eligible work. */
export type RetentionOutcome =
  | Readonly<{ kind: 'deleted'; subject: string; count: number }>
  | Readonly<{ kind: 'kept'; subject: string; reason: string; pending?: boolean }>
  | Readonly<{ kind: 'failed'; subject: string; reason: string }>;

export interface RetentionRunStatus {
  startedAt: number;
  finishedAt: number | null;
  phase: 'running' | 'completed' | 'partial' | 'failed';
  deleted: number;
  kept: number;
  failed: number;
  outcomes: RetentionOutcome[];
}

export interface RetentionRunBudget {
  canContinue(): boolean;
  canMutate?(): boolean;
  canRetry?(): boolean;
  record(outcome: RetentionOutcome): void;
}

export const retentionRunStatusSchema = z.object({
  startedAt: z.number().finite(),
  finishedAt: z.number().finite().nullable(),
  phase: z.enum(['running', 'completed', 'partial', 'failed']),
  deleted: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  outcomes: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('deleted'), subject: z.string(), count: z.number().int().nonnegative() }),
        z.object({ kind: z.literal('kept'), subject: z.string(), reason: z.string(), pending: z.boolean().optional() }),
        z.object({ kind: z.literal('failed'), subject: z.string(), reason: z.string() }),
      ]),
    )
    .max(100),
});
import { z } from 'zod';
import type { Database } from './db.js';
import { readRetentionMeta } from './retention-meta.js';

const pendingSchema = z.object({
  subjects: z.array(z.string()).max(100),
  overflow: z.boolean(),
  rotation: z.number().int().nonnegative().default(0),
});

export function createRetentionPendingSet(
  db: Database,
  key: string,
  mutate: <T>(operation: () => T) => T,
  record: RetentionRunBudget['record'],
) {
  const { value: state, reset } = readRetentionMeta({
    db,
    key,
    mutate,
    record,
    decode: (value) => pendingSchema.parse(JSON.parse(value)),
    fresh: () => ({ subjects: [] as string[], overflow: false, rotation: 0 }),
  });
  if (reset) state.overflow = true;
  const subjects = new Set(state.subjects);
  let rotation = subjects.size === 0 ? 0 : state.rotation % subjects.size;
  const save = (): void => {
    mutate(() => {
      if (subjects.size === 0 && !state.overflow) db.prepare('DELETE FROM meta WHERE key = ?').run(key);
      else
        db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
          key,
          JSON.stringify({ subjects: [...subjects], overflow: state.overflow, rotation }),
        );
    });
  };
  return {
    restarted: reset,
    subjects,
    retryOrder: () => {
      const ids = [...subjects];
      return [...ids.slice(rotation), ...ids.slice(0, rotation)];
    },
    advance: (id: string) => {
      rotation = ([...subjects].indexOf(id) + 1) % subjects.size;
      save();
    },
    add: (id: string): boolean => {
      const admitted = subjects.has(id) || subjects.size < 100;
      if (admitted) subjects.add(id);
      else state.overflow = true;
      save();
      return admitted;
    },
    remove: (id: string) => {
      const index = [...subjects].indexOf(id);
      if (index < 0) return;
      subjects.delete(id);
      if (index < rotation) rotation -= 1;
      rotation = subjects.size === 0 ? 0 : rotation % subjects.size;
      save();
    },
    clearOverflow: () => {
      state.overflow = false;
      save();
    },
    overflow: () => state.overflow,
  };
}
