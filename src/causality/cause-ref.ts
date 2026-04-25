import { z } from 'zod';

export interface CauseRef {
  stream: {
    kind: 'job' | 'session' | 'discuss' | 'workflow';
    id: string;
  };
  seq: number;
}

export const causeRefSchema = z
  .object({
    stream: z
      .object({
        kind: z.enum(['job', 'session', 'discuss', 'workflow']),
        id: z.string().min(1),
      })
      .strict(),
    seq: z.number().int().positive(),
  })
  .strict();
