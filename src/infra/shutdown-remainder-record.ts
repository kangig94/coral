import { join } from 'node:path';
import { z } from 'zod';

import type { ProcessIncarnation } from './node-process.js';
import { persistedProcessIncarnationSchema } from './persisted-scalar-contracts.js';
import type { StoragePort } from './port-types.js';

export const SHUTDOWN_REMAINDER_RECORD_VERSION = 1;

type ShutdownRemainderSuccessorRecoveryEvidence =
  | Readonly<{
      kind: 'startup-adoption';
      processes: readonly Readonly<{
        kind: 'durable-cli-runtime';
        jobId: string;
        pid: number;
        leaderIncarnation: ProcessIncarnation;
      }>[];
    }>
  | Readonly<{ kind: 'startup-store-recovery' }>
  | Readonly<{ kind: 'startup-liveness-recovery' }>;

type ShutdownRemainderEntry = Readonly<{
  label: string;
  remainder:
    | Readonly<{ owner: 'process-exit' }>
    | Readonly<{ owner: 'successor-recovery'; evidence: ShutdownRemainderSuccessorRecoveryEvidence }>;
  settlement: Readonly<{
    cause: 'rejected' | 'timed-out' | 'budget-exhausted' | 'unconfirmed' | 'aborted';
    detail: string;
  }>;
}>;

export type ShutdownRemainderRecord = Readonly<{
  instanceId: string;
  recordedAt: string;
  reason: string;
  mode: 'handoff' | 'hard';
  entries: readonly ShutdownRemainderEntry[];
}>;

export type ShutdownRemainderRecordScan = Readonly<{
  records: readonly ShutdownRemainderRecord[];
  skippedEntries: number;
  skippedRecords: number;
}>;

export function shutdownRemainderRecordDirectory(runDir: string): string {
  return join(runDir, `shutdown-remainder.v${SHUTDOWN_REMAINDER_RECORD_VERSION}`);
}

const settlementCauseSchema = z.enum(['rejected', 'timed-out', 'budget-exhausted', 'unconfirmed', 'aborted']);
const successorRecoveryEvidenceSchema: z.ZodType<ShutdownRemainderSuccessorRecoveryEvidence> = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('startup-adoption'),
        processes: z.array(
          z
            .object({
              kind: z.literal('durable-cli-runtime'),
              jobId: z.string(),
              pid: z.number().int().positive(),
              leaderIncarnation: persistedProcessIncarnationSchema,
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    z.object({ kind: z.literal('startup-store-recovery') }).passthrough(),
    z.object({ kind: z.literal('startup-liveness-recovery') }).passthrough(),
  ],
);
const shutdownRemainderEntrySchema: z.ZodType<ShutdownRemainderEntry> = z
  .object({
    label: z.string(),
    remainder: z.discriminatedUnion('owner', [
      z.object({ owner: z.literal('process-exit') }).passthrough(),
      z
        .object({
          owner: z.literal('successor-recovery'),
          evidence: successorRecoveryEvidenceSchema,
        })
        .passthrough(),
    ]),
    settlement: z
      .object({
        cause: settlementCauseSchema,
        detail: z.string(),
      })
      .passthrough(),
  })
  .passthrough();
const shutdownRemainderRecordEnvelopeSchema = z
  .object({
    instanceId: z.string().min(1),
    recordedAt: z.string().datetime(),
    reason: z.string().min(1),
    mode: z.enum(['handoff', 'hard']),
    entries: z.array(z.unknown()).readonly(),
  })
  .passthrough();

export function decodeShutdownRemainderRecord(
  value: unknown,
):
  | Readonly<{ kind: 'readable'; record: ShutdownRemainderRecord; skippedEntries: number }>
  | Readonly<{ kind: 'unreadable'; detail: string }> {
  const parsedRecord = shutdownRemainderRecordEnvelopeSchema.safeParse(value);
  if (!parsedRecord.success) return { kind: 'unreadable', detail: parsedRecord.error.message };

  const entries: ShutdownRemainderEntry[] = [];
  let skippedEntries = 0;
  for (const rawEntry of parsedRecord.data.entries) {
    const parsedEntry = shutdownRemainderEntrySchema.safeParse(rawEntry);
    if (parsedEntry.success) entries.push(parsedEntry.data);
    else skippedEntries += 1;
  }

  return {
    kind: 'readable',
    record: {
      instanceId: parsedRecord.data.instanceId,
      recordedAt: parsedRecord.data.recordedAt,
      reason: parsedRecord.data.reason,
      mode: parsedRecord.data.mode,
      entries,
    },
    skippedEntries,
  };
}

export function scanShutdownRemainderRecords(
  storage: Pick<StoragePort, 'readFileSync' | 'readdirSync' | 'statSync'>,
  directory: string,
): ShutdownRemainderRecordScan {
  const records: ShutdownRemainderRecord[] = [];
  let skippedEntries = 0;
  let skippedRecords = 0;
  const recordFiles = storage
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return { name, mtimeMs: storage.statSync(join(directory, name)).mtimeMs };
      } catch {
        return { name, mtimeMs: Number.NEGATIVE_INFINITY };
      }
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));

  for (const { name } of recordFiles) {
    try {
      const decoded = decodeShutdownRemainderRecord(JSON.parse(storage.readFileSync(join(directory, name), 'utf-8')));
      if (decoded.kind === 'unreadable') {
        skippedRecords += 1;
        continue;
      }
      records.push(decoded.record);
      skippedEntries += decoded.skippedEntries;
    } catch {
      skippedRecords += 1;
    }
  }

  return { records, skippedEntries, skippedRecords };
}
