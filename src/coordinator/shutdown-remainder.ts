import { join } from 'node:path';
import { z } from 'zod';

import { persistedProcessIncarnationSchema } from '../infra/persisted-scalar-contracts.js';
import type { StoragePort, TimePort } from '../infra/port-types.js';
import { nowIsoString } from '../infra/time.js';
import type { ShutdownMode, ShutdownReason } from './shutdown.js';
import type { ShutdownUndischarged, SuccessorRecoveryEvidence, UndischargedRemainder } from './shutdown-settlement.js';

const SHUTDOWN_REMAINDER_VERSION = 1;
const MAX_SHUTDOWN_REMAINDER_RECORDS = 32;

type ShutdownRemainderRuntime = Readonly<{
  storage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'writeAtomicDurableSync'>;
  time: Pick<TimePort, 'now'>;
  runDir: string;
}>;

const settlementCauseSchema = z.enum(['rejected', 'timed-out', 'budget-exhausted', 'unconfirmed', 'aborted']);
const successorRecoveryEvidenceSchema: z.ZodType<SuccessorRecoveryEvidence> = z.discriminatedUnion('kind', [
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
]);
const undischargedRemainderSchema: z.ZodType<UndischargedRemainder> = z.discriminatedUnion('owner', [
  z.object({ owner: z.literal('process-exit') }).passthrough(),
  z
    .object({
      owner: z.literal('successor-recovery'),
      evidence: successorRecoveryEvidenceSchema,
    })
    .passthrough(),
]);
const shutdownRemainderEntrySchema: z.ZodType<ShutdownUndischarged> = z
  .object({
    label: z.string(),
    remainder: undischargedRemainderSchema,
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
const shutdownRemainderRecordInstanceSchema = z.object({ instanceId: z.string() }).passthrough();
const shutdownRemainderStatusEnvelopeSchema = z
  .object({
    version: z.literal(SHUTDOWN_REMAINDER_VERSION),
    records: z.array(z.unknown()).readonly(),
  })
  .passthrough();

export type ShutdownRemainderRecord = Readonly<{
  instanceId: string;
  recordedAt: string;
  reason: string;
  mode: ShutdownMode;
  entries: readonly ShutdownUndischarged[];
}>;

export type ShutdownRemainderStatus = Readonly<{
  version: typeof SHUTDOWN_REMAINDER_VERSION;
  records: readonly ShutdownRemainderRecord[];
}>;

export type ShutdownRemainderStatusRead =
  | Readonly<{
      kind: 'available';
      path: string;
      status: ShutdownRemainderStatus;
      skippedEntries: number;
      skippedRecords: number;
    }>
  | Readonly<{ kind: 'absent'; path: string }>
  | Readonly<{ kind: 'unreadable'; path: string; detail: string }>;

export type ShutdownRemainderRecordInput = Readonly<{
  instanceId: string;
  reason: ShutdownReason;
  mode: ShutdownMode;
  undischarged: readonly ShutdownUndischarged[];
}>;

type ReadableShutdownRemainderDocument = Readonly<{
  document: z.infer<typeof shutdownRemainderStatusEnvelopeSchema>;
  status: ShutdownRemainderStatus;
  skippedEntries: number;
  skippedRecords: number;
}>;

function decodeShutdownRemainderDocument(
  value: unknown,
):
  | Readonly<{ kind: 'readable'; value: ReadableShutdownRemainderDocument }>
  | Readonly<{ kind: 'unreadable'; detail: string }> {
  const envelope = shutdownRemainderStatusEnvelopeSchema.safeParse(value);
  if (!envelope.success) return { kind: 'unreadable', detail: envelope.error.message };

  const records: ShutdownRemainderRecord[] = [];
  let skippedEntries = 0;
  let skippedRecords = 0;
  for (const rawRecord of envelope.data.records) {
    const parsedRecord = shutdownRemainderRecordEnvelopeSchema.safeParse(rawRecord);
    if (!parsedRecord.success) {
      skippedRecords += 1;
      continue;
    }

    const entries: ShutdownUndischarged[] = [];
    for (const rawEntry of parsedRecord.data.entries) {
      const parsedEntry = shutdownRemainderEntrySchema.safeParse(rawEntry);
      if (parsedEntry.success) entries.push(parsedEntry.data);
      else skippedEntries += 1;
    }
    records.push({
      instanceId: parsedRecord.data.instanceId,
      recordedAt: parsedRecord.data.recordedAt,
      reason: parsedRecord.data.reason,
      mode: parsedRecord.data.mode,
      entries,
    });
  }

  return {
    kind: 'readable',
    value: {
      document: envelope.data,
      status: { version: SHUTDOWN_REMAINDER_VERSION, records },
      skippedEntries,
      skippedRecords,
    },
  };
}

export function shutdownRemainderPath(runDir: string): string {
  return join(runDir, `shutdown-remainder.v${SHUTDOWN_REMAINDER_VERSION}.json`);
}

export function readShutdownRemainderStatus(
  runtime: Pick<ShutdownRemainderRuntime, 'storage' | 'runDir'>,
): ShutdownRemainderStatusRead {
  const path = shutdownRemainderPath(runtime.runDir);
  if (!runtime.storage.existsSync(path)) return { kind: 'absent', path };
  try {
    const decoded = decodeShutdownRemainderDocument(JSON.parse(runtime.storage.readFileSync(path, 'utf-8')));
    return decoded.kind === 'readable'
      ? {
          kind: 'available',
          path,
          status: decoded.value.status,
          skippedEntries: decoded.value.skippedEntries,
          skippedRecords: decoded.value.skippedRecords,
        }
      : { kind: 'unreadable', path, detail: decoded.detail };
  } catch (error: unknown) {
    return {
      kind: 'unreadable',
      path,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function namesInstance(record: unknown, instanceId: string): boolean {
  const probe = shutdownRemainderRecordInstanceSchema.safeParse(record);
  return probe.success && probe.data.instanceId === instanceId;
}

/** A record this build cannot decode is carried forward verbatim; only an unreadable envelope refuses the write. */
export function recordShutdownRemainder(
  runtime: ShutdownRemainderRuntime,
  input: ShutdownRemainderRecordInput,
): boolean {
  const path = shutdownRemainderPath(runtime.runDir);
  let document: ReadableShutdownRemainderDocument['document'] = {
    version: SHUTDOWN_REMAINDER_VERSION,
    records: [],
  };
  if (runtime.storage.existsSync(path)) {
    try {
      const decoded = decodeShutdownRemainderDocument(JSON.parse(runtime.storage.readFileSync(path, 'utf-8')));
      if (decoded.kind === 'unreadable') return false;
      document = decoded.value.document;
    } catch {
      return false;
    }
  }

  const record: ShutdownRemainderRecord = {
    instanceId: input.instanceId,
    recordedAt: nowIsoString(runtime.time),
    reason: input.reason,
    mode: input.mode,
    entries: input.undischarged,
  };
  const records = [...document.records.filter((existing) => !namesInstance(existing, input.instanceId)), record].slice(
    -MAX_SHUTDOWN_REMAINDER_RECORDS,
  );
  return runtime.storage.writeAtomicDurableSync(
    path,
    `${JSON.stringify({ ...document, version: SHUTDOWN_REMAINDER_VERSION, records }, null, 2)}\n`,
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  );
}
