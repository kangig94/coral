import { z } from 'zod';

import { isRecord } from '../infra/json.js';

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

export function renderCauseRefFallback(ref: CauseRef): string {
  return `${ref.stream.kind}/${ref.stream.id}#${ref.seq}`;
}

export function parseCauseRef(value: unknown): CauseRef | null {
  const parsed = causeRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function extractCauseRef(body: unknown): CauseRef | null {
  if (!isRecord(body)) return null;
  const direct = parseCauseRef(body.causeRef);
  if (direct) return direct;
  if (isRecord(body.reason) && body.reason.kind === 'failed') {
    return parseCauseRef(body.reason.causeRef);
  }
  if (!isRecord(body.terminal) || !isRecord(body.terminal.outcome)) return null;
  return body.terminal.outcome.kind === 'failed' ? parseCauseRef(body.terminal.outcome.causeRef) : null;
}
