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
  storage: Pick<
    StoragePort,
    'existsSync' | 'readFileSync' | 'readdirSync' | 'statSync' | 'unlinkSync' | 'writeAtomicDurableSync'
  >;
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

type ReadableShutdownRemainderRecord = Readonly<{
  record: ShutdownRemainderRecord;
  skippedEntries: number;
}>;

function decodeShutdownRemainderRecord(
  value: unknown,
):
  | Readonly<{ kind: 'readable'; value: ReadableShutdownRemainderRecord }>
  | Readonly<{ kind: 'unreadable'; detail: string }> {
  const parsedRecord = shutdownRemainderRecordEnvelopeSchema.safeParse(value);
  if (!parsedRecord.success) return { kind: 'unreadable', detail: parsedRecord.error.message };

  const entries: ShutdownUndischarged[] = [];
  let skippedEntries = 0;
  for (const rawEntry of parsedRecord.data.entries) {
    const parsedEntry = shutdownRemainderEntrySchema.safeParse(rawEntry);
    if (parsedEntry.success) entries.push(parsedEntry.data);
    else skippedEntries += 1;
  }

  return {
    kind: 'readable',
    value: {
      record: {
        instanceId: parsedRecord.data.instanceId,
        recordedAt: parsedRecord.data.recordedAt,
        reason: parsedRecord.data.reason,
        mode: parsedRecord.data.mode,
        entries,
      },
      skippedEntries,
    },
  };
}

export function shutdownRemainderPath(runDir: string): string {
  return join(runDir, `shutdown-remainder.v${SHUTDOWN_REMAINDER_VERSION}`);
}

export function readShutdownRemainderStatus(
  runtime: Pick<ShutdownRemainderRuntime, 'storage' | 'runDir'>,
): ShutdownRemainderStatusRead {
  const path = shutdownRemainderPath(runtime.runDir);
  if (!runtime.storage.existsSync(path)) return { kind: 'absent', path };
  try {
    const records: ShutdownRemainderRecord[] = [];
    let skippedEntries = 0;
    let skippedRecords = 0;
    const recordFiles = runtime.storage
      .readdirSync(path)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return { name, mtimeMs: runtime.storage.statSync(join(path, name)).mtimeMs };
        } catch {
          return { name, mtimeMs: Number.NEGATIVE_INFINITY };
        }
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));

    for (const { name } of recordFiles) {
      try {
        const decoded = decodeShutdownRemainderRecord(
          JSON.parse(runtime.storage.readFileSync(join(path, name), 'utf-8')),
        );
        if (decoded.kind === 'unreadable') {
          skippedRecords += 1;
          continue;
        }
        records.push(decoded.value.record);
        skippedEntries += decoded.value.skippedEntries;
      } catch {
        skippedRecords += 1;
      }
    }

    return {
      kind: 'available',
      path,
      status: { version: SHUTDOWN_REMAINDER_VERSION, records },
      skippedEntries,
      skippedRecords,
    };
  } catch (error: unknown) {
    return {
      kind: 'unreadable',
      path,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function pruneShutdownRemainderRecords(runtime: ShutdownRemainderRuntime, directory: string): void {
  try {
    const records = runtime.storage
      .readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        try {
          return [{ name, mtimeMs: runtime.storage.statSync(join(directory, name)).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    for (const { name } of records.slice(MAX_SHUTDOWN_REMAINDER_RECORDS)) {
      try {
        runtime.storage.unlinkSync(join(directory, name));
      } catch {
        /* pruning cannot hold process exit */
      }
    }
  } catch {
    /* pruning cannot hold process exit */
  }
}

export function recordShutdownRemainder(
  runtime: ShutdownRemainderRuntime,
  input: ShutdownRemainderRecordInput,
): boolean {
  const directory = shutdownRemainderPath(runtime.runDir);
  const path = join(directory, `${input.instanceId}.json`);
  const record: ShutdownRemainderRecord = {
    instanceId: input.instanceId,
    recordedAt: nowIsoString(runtime.time),
    reason: input.reason,
    mode: input.mode,
    entries: input.undischarged,
  };
  const written = runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  if (written) pruneShutdownRemainderRecords(runtime, directory);
  return written;
}
