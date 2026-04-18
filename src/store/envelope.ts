import { z } from 'zod';

import { CoralSetupError } from '../runtime/errors.js';

const journalEventRefsSchema = z
  .object({
    jobId: z.string().optional(),
    sessionId: z.string().optional(),
    parentJobId: z.string().optional(),
    workflowId: z.string().optional(),
    workflowSlotId: z.string().optional(),
    discussSessionId: z.string().optional(),
    kbRefs: z
      .array(
        z
          .object({
            entryId: z.string(),
            contentHash: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const journalEventEnvelopeSchema = z
  .object({
    seq: z.number().int().positive(),
    ts: z.string().datetime(),
    type: z.string(),
    stream: z
      .object({
        kind: z.enum(['job', 'session', 'discuss', 'workflow']),
        id: z.string().min(1),
      })
      .strict(),
    namespace: z.string().optional(),
    project: z.string().optional(),
    correlationId: z.string().optional(),
    causationSeq: z.number().optional(),
    refs: journalEventRefsSchema.optional(),
    bodyVersion: z.number().int().positive(),
    body: z.unknown(),
  })
  .strict();

export type JournalEventEnvelope = z.infer<typeof journalEventEnvelopeSchema>;
export type CoralEvent = JournalEventEnvelope;
export type CoralEventInput = Omit<CoralEvent, 'seq' | 'ts'>;

type Upcaster = (body: unknown) => unknown;

interface UpcasterRecord {
  toVersion: number;
  fn: Upcaster;
}

export class UpcasterRegistry {
  private readonly entries = new Map<string, UpcasterRecord>();

  registerUpcaster(type: string, fromVersion: number, toVersion: number, fn: Upcaster): void {
    const key = `${type}|${fromVersion}`;
    if (this.entries.has(key)) {
      throw new CoralSetupError({
        code: 'upcaster_conflict',
        userMessage: `Upcaster already registered for type '${type}' from v${fromVersion}`,
        remediation: 'Remove the duplicate registerUpcaster call or use a different fromVersion.',
        context: { type, fromVersion },
      });
    }
    this.entries.set(key, { toVersion, fn });
  }

  parseBody<T>(type: string, bodyVersion: number, body: unknown, currentSchema: z.ZodType<T>): T {
    let current = body;
    let version = bodyVersion;

    while (true) {
      const rec = this.entries.get(`${type}|${version}`);
      if (!rec) {
        const parsed = currentSchema.safeParse(current);
        if (parsed.success) {
          return parsed.data;
        }

        throw new CoralSetupError({
          code: 'upcaster_missing',
          userMessage: `No upcaster chain from v${bodyVersion} to current for type '${type}'`,
          remediation: 'Register upcasters to bridge the gap, or verify bodyVersion.',
          context: { type, bodyVersion, stoppedAt: version, error: parsed.error.format() },
        });
      }

      current = rec.fn(current);
      version = rec.toVersion;
    }
  }
}

export function createEmptyRegistry(): UpcasterRegistry {
  return new UpcasterRegistry();
}
