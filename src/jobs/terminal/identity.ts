import { sameEpoch } from '../../store/epoch/identity.js';
import type { JobLocation } from '../location-index.js';
import { z } from 'zod';
import { jobTerminalSchema } from './result.js';
import { isDeepStrictEqual } from 'node:util';
import type { JobDetailResponse, JobTerminal, JobTerminalEvent } from '../records.js';
import { phaseForOutcome } from '../outcome.js';
import { isTerminalPhase } from '../phase.js';

function commonSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject)
    return z.object(
      Object.fromEntries(
        Object.entries(schema.shape).map(([key, value]) => [key, commonSchema(value as z.ZodTypeAny)]),
      ),
    );
  if (schema instanceof z.ZodDiscriminatedUnion)
    return z.union(
      schema.options.map((option: z.ZodTypeAny) => commonSchema(option)) as [
        z.ZodTypeAny,
        z.ZodTypeAny,
        ...z.ZodTypeAny[],
      ],
    );
  if (schema instanceof z.ZodOptional) return commonSchema(schema.unwrap()).optional();
  if (schema instanceof z.ZodNullable) return commonSchema(schema.unwrap()).nullable();
  if (schema instanceof z.ZodArray) return z.array(commonSchema(schema.element));
  return schema;
}
const commonTerminalSchema = commonSchema(jobTerminalSchema);

/** Additive reader fields are not part of the common terminal identity. */
export function sameTerminal(left: JobTerminal, right: JobTerminal): boolean {
  const a = commonTerminalSchema.safeParse(left);
  const b = commonTerminalSchema.safeParse(right);
  return (
    a.success &&
    b.success &&
    Number.isFinite(left.durationMs) &&
    Number.isFinite(right.durationMs) &&
    isDeepStrictEqual(a.data, b.data)
  );
}

/** A terminal is recorded only when every copy its detail carries agrees with it. */
export function validatedTerminal(
  detail: JobDetailResponse,
  jobId: string,
  epochKey: string,
  seq: number,
): JobTerminalEvent | null {
  const terminals = detail.events.filter((event): event is JobTerminalEvent => event.type === 'terminal');
  const terminal = terminals.find((event) => event.seq === seq);
  if (
    !terminal ||
    !detail.exit ||
    detail.status.jobId !== jobId ||
    (detail.epochKey !== undefined && !sameEpoch(detail.epochKey, epochKey)) ||
    detail.status.phase !== phaseForOutcome(terminal.result.outcome) ||
    (detail.status.lastSeq !== undefined && detail.status.lastSeq !== seq) ||
    detail.status.updatedAt !== terminal.ts ||
    terminal.jobId !== jobId ||
    terminal.sessionId !== detail.status.sessionId ||
    terminal.ts !== detail.exit.endTime ||
    !Number.isFinite(Date.parse(terminal.ts)) ||
    !sameTerminal(terminal.result, detail.exit) ||
    (detail.status.result !== undefined && !sameTerminal(terminal.result, detail.status.result)) ||
    terminals.some(
      (copy) =>
        copy.jobId !== jobId ||
        copy.sessionId !== terminal.sessionId ||
        copy.seq !== seq ||
        copy.ts !== terminal.ts ||
        !sameTerminal(copy.result, terminal.result),
    )
  )
    return null;
  return terminal;
}

/** A record's retained terminal, read structurally: its copies were checked against each other when it was recorded. */
export function retainedTerminal(location: JobLocation): JobTerminalEvent | null {
  if (location.disposition !== 'terminal' || location.terminalSeq === undefined || location.detail.kind !== 'recorded')
    return null;
  const { status, events, exit } = location.detail.value;
  if (status.jobId !== location.jobId || !isTerminalPhase(status.phase) || exit === null) return null;
  return (
    events.find(
      (event): event is JobTerminalEvent =>
        event.type === 'terminal' && event.jobId === location.jobId && event.seq === location.terminalSeq,
    ) ?? null
  );
}

export function hasReadableTerminalDetail(location: JobLocation): boolean {
  return retainedTerminal(location) !== null;
}
