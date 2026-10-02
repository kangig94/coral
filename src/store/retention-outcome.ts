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
