import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Runtime } from '../../runtime/ports.js';
import type { Database } from '../../store/db.js';
import type { JobStore } from '../../jobs/store.js';
import { durableCliProcessRuntimeMetaSchema } from '../../jobs/runtime-meta.js';
import { readDurableCliProcessRuntimeEvidence } from '../../jobs/runtime-meta-store.js';
import { readCustodyLedger } from '../../store/custody-ledger.js';
import { epochPath, type ResolvedStoreEpoch } from '../../store/epoch.js';
import { readOrCreateEpochKey } from '../../store/epoch-key.js';
import {
  appendControllerReceipt,
  appendControllerRecoveryGrant,
  readControllerReceipts,
  readControllerRecoveryGrant,
} from '../../store/controller-receipt-records.js';

const durableCliTransferSchema = z
  .object({
    epochPath: z.string().min(1),
    jobs: z.array(
      z
        .object({
          jobId: z.string().min(1),
          custodyIntentId: z.string().uuid(),
          runtimeMeta: durableCliProcessRuntimeMetaSchema,
        })
        .strict(),
    ),
  })
  .strict();

export type DurableCliTransfer = z.infer<typeof durableCliTransferSchema>;

export function decodeDurableCliTransfer(payload: unknown, epoch: ResolvedStoreEpoch): DurableCliTransfer | null {
  const parsed = durableCliTransferSchema.safeParse(payload);
  const canonicalPath = epochPath(epoch.canonicalStoreRoot ?? epoch.storeRoot, epoch.epoch);
  return parsed.success &&
    (parsed.data.epochPath === epoch.path ||
      (epoch.canonicalStoreRoot !== undefined && parsed.data.epochPath === canonicalPath))
    ? parsed.data
    : null;
}

const durableCliRecoveryGrantSchema = z
  .object({
    version: z.literal('v1'),
    attemptId: z.string().uuid(),
    epochKey: z.string().min(1),
    incumbentInstanceId: z.string().min(1),
    incumbentBuildSetId: z.string().min(1),
    transfer: durableCliTransferSchema,
  })
  .strict();

export function prepareDurableCliRecoveryGrant(
  runtime: Pick<Runtime, 'storage' | 'ids'>,
  runDir: string,
  grant: z.infer<typeof durableCliRecoveryGrantSchema>,
): string {
  const recorded = durableCliRecoveryGrantSchema.parse(grant);
  appendControllerRecoveryGrant(runtime, runDir, recorded.attemptId, JSON.stringify(recorded));
  return `durable-cli:${recorded.attemptId}`;
}

export function verifyDurableCliRecoveryGrant(
  runtime: Pick<Runtime, 'storage'>,
  runDir: string,
  attemptId: string,
  grantId: string,
  epochKey: string,
  incumbentInstanceId: string,
  transfer: DurableCliTransfer,
): boolean {
  if (grantId !== `durable-cli:${attemptId}`) return false;
  try {
    const raw = readControllerRecoveryGrant(runtime, runDir, attemptId);
    if (raw === null) return false;
    const grant = durableCliRecoveryGrantSchema.parse(JSON.parse(raw));
    return (
      grant.attemptId === attemptId &&
      grant.epochKey === epochKey &&
      grant.incumbentInstanceId === incumbentInstanceId &&
      JSON.stringify(grant.transfer) === JSON.stringify(transfer)
    );
  } catch {
    return false;
  }
}

function collectDurableCliTransfer(
  runtime: Runtime,
  db: Database,
  progressStore: Pick<JobStore, 'readRuntimeProjection'>,
  runDir: string,
  epoch: ResolvedStoreEpoch,
  jobIds: readonly string[],
): DurableCliTransfer | null {
  const custody = readCustodyLedger(runtime, runDir);
  let lineageKey: string;
  try {
    lineageKey = epoch.lineageKey ?? readOrCreateEpochKey(runtime, epoch);
  } catch {
    return null;
  }
  const canonicalDirectory = join(epoch.canonicalStoreRoot ?? epoch.storeRoot, `epoch-${epoch.epoch}`);
  const jobs: DurableCliTransfer['jobs'][number][] = [];
  for (const jobId of jobIds) {
    const runtime = progressStore.readRuntimeProjection(jobId);
    if (runtime?.transport !== 'durable-cli') return null;
    const evidence = readDurableCliProcessRuntimeEvidence(db, jobId, runtime.pid);
    if (evidence.kind !== 'current') return null;
    const matches = custody.filter(
      (entry) =>
        entry.kind === 'bound' &&
        entry.intent.owner === 'durable-cli' &&
        entry.intent.operationId === jobId &&
        entry.intent.epochKey === lineageKey &&
        (entry.intent.epoch === dirname(epoch.path) ||
          entry.intent.epoch === canonicalDirectory ||
          entry.intent.epoch === epoch.lineageKey) &&
        entry.binding.process !== null &&
        entry.binding.process.pid === evidence.record.pid &&
        entry.binding.process.incarnation === evidence.record.incarnation &&
        entry.binding.process.processGroupId === evidence.record.processGroupId,
    );
    if (matches.length !== 1 || matches[0]?.kind !== 'bound') return null;
    jobs.push({ jobId, custodyIntentId: matches[0].intent.id, runtimeMeta: evidence.record });
  }
  return { epochPath: epoch.path, jobs };
}

export function prepareDurableCliTransfer(
  runtime: Runtime,
  db: Database,
  progressStore: Pick<JobStore, 'readRuntimeProjection'>,
  runDir: string,
  epoch: ResolvedStoreEpoch,
  jobIds: readonly string[],
): DurableCliTransfer | null {
  if (new Set(jobIds).size !== jobIds.length) return null;
  return collectDurableCliTransfer(runtime, db, progressStore, runDir, epoch, [...jobIds].sort());
}

export function verifyDurableCliTransfer(
  runtime: Runtime,
  payload: unknown,
  db: Database,
  progressStore: Pick<JobStore, 'readRuntimeProjection'>,
  runDir: string,
  epoch: ResolvedStoreEpoch,
): DurableCliTransfer | null {
  const parsed = decodeDurableCliTransfer(payload, epoch);
  if (parsed === null) return null;
  const ids = parsed.jobs.map((job) => job.jobId);
  if (new Set(ids).size !== ids.length) return null;
  const current = collectDurableCliTransfer(runtime, db, progressStore, runDir, epoch, ids);
  if (current === null) return null;
  return current.jobs.every(
    (job, index) =>
      job.custodyIntentId === parsed.jobs[index]?.custodyIntentId &&
      JSON.stringify(job.runtimeMeta) === JSON.stringify(parsed.jobs[index]?.runtimeMeta),
  )
    ? parsed
    : null;
}

const durableCliControllerReceiptSchema = z
  .object({
    version: z.literal('v1'),
    jobId: z.string().min(1),
    epochKey: z.string().min(1),
    lineageEpochKey: z.string().min(1).optional(),
    attemptId: z.string().uuid(),
    controllerInstanceId: z.string().min(1),
    controllerBuildSetId: z.string().min(1),
    controlGeneration: z.number().int().positive(),
    runtimeRecordGeneration: z.literal(2),
    runtimeMeta: durableCliProcessRuntimeMetaSchema,
    custodyIntentId: z.string().uuid(),
    acknowledgedAtMs: z.number().int().nonnegative(),
  })
  .strict();

export type DurableCliControllerReceipt = z.infer<typeof durableCliControllerReceiptSchema>;

export function recordDurableCliControllerReceipts(
  runtime: Pick<Runtime, 'storage' | 'ids'>,
  runDir: string,
  transfer: DurableCliTransfer,
  controller: Readonly<{
    epochKey: string;
    lineageEpochKey?: string;
    attemptId: string;
    instanceId: string;
    buildSetId: string;
    generation: number;
    nowMs: number;
  }>,
): void {
  for (const job of transfer.jobs) {
    const receipt = durableCliControllerReceiptSchema.parse({
      version: 'v1',
      jobId: job.jobId,
      epochKey: controller.epochKey,
      ...(controller.lineageEpochKey === undefined ? {} : { lineageEpochKey: controller.lineageEpochKey }),
      attemptId: controller.attemptId,
      controllerInstanceId: controller.instanceId,
      controllerBuildSetId: controller.buildSetId,
      controlGeneration: controller.generation,
      runtimeRecordGeneration: 2,
      runtimeMeta: job.runtimeMeta,
      custodyIntentId: job.custodyIntentId,
      acknowledgedAtMs: controller.nowMs,
    });
    appendControllerReceipt(
      runtime,
      runDir,
      `${receipt.jobId}.${receipt.attemptId}.${receipt.controlGeneration}`,
      JSON.stringify(receipt),
    );
  }
}

export function readDurableCliControllerReceipts(
  runtime: Pick<Runtime, 'storage'>,
  runDir: string,
): readonly DurableCliControllerReceipt[] | null {
  try {
    return readControllerReceipts(runtime, runDir).map((record) =>
      durableCliControllerReceiptSchema.parse(JSON.parse(record)),
    );
  } catch {
    return null;
  }
}
