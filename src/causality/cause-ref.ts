import { z } from 'zod';

const CAUSE_REF_TOKEN: unique symbol = Symbol('CauseRefToken');

export interface CauseRef {
  stream: {
    kind: 'job' | 'session' | 'discuss' | 'workflow';
    id: string;
  };
  seq: number;
}

export type CauseRefToken<Scope> = {
  readonly [CAUSE_REF_TOKEN]: {
    readonly slot: number;
    readonly consume: (scope: Scope) => void;
    readonly produce: () => Scope;
  };
};

export type ResolvableCauseRef<Scope> = [Scope] extends [never] ? CauseRef : CauseRef | CauseRefToken<Scope>;

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
