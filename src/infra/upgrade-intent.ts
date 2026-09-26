import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { acquireDirectoryLock } from './fs-lock.js';
import { writeAuditEvent } from './audit-log.js';
import { createForeignTargetValidator, type ForeignTargetValidationResult } from './handoff-target.js';
import { processIncarnationSchema } from './node-process.js';
import { upgradeIntentPath } from './path/index.js';

const buildIdentitySchema = z
  .object({
    version: z.string().min(1),
    buildSetId: z.string().min(1),
    flavor: z.enum(['dev', 'prod']),
    storeFormatFingerprint: z.string().min(1),
    bundleHash: z.string().min(1),
    cliBundleHash: z.string().min(1),
    claudeAppserverBundleHash: z.string().min(1),
    durableWrapperBundleHash: z.string().min(1),
  })
  .passthrough();

const processIdentitySchema = z
  .object({
    instanceId: z.string().min(1),
    pid: z.number().int().positive(),
    incarnation: processIncarnationSchema.nullable(),
    build: buildIdentitySchema,
  })
  .passthrough();

const incumbentIdentitySchema = z
  .object({
    instanceId: z.string().min(1),
    pid: z.number().int().positive(),
    incarnation: processIncarnationSchema.nullable(),
    version: z.string().min(1),
    bundleHash: z.string().min(1),
    flavor: z.enum(['dev', 'prod']),
  })
  .passthrough();

const attemptOwnerSchema = z
  .object({
    kind: z.enum(['incumbent', 'waiter']),
    instanceId: z.string().min(1),
    pid: z.number().int().positive(),
    incarnation: processIncarnationSchema.nullable(),
  })
  .passthrough();

const blockerSchema = z
  .object({
    owner: z.string().min(1),
    reason: z.string().min(1),
  })
  .passthrough();

const retryConditionSchema = z
  .object({
    kind: z.enum(['obligation-change', 'incumbent-retirement', 'target-change', 'attempt-expiry']),
    evidence: z.string().min(1),
  })
  .passthrough();

const acceptedObligationSchema = z
  .object({
    owner: z.string().min(1),
    receiptId: z.string().min(1),
    controlGeneration: z.number().int().nonnegative(),
  })
  .passthrough();

const servingReceiptSchema = z
  .object({
    kind: z.literal('serving'),
    attemptId: z.string().min(1),
    successor: processIdentitySchema,
    epochKey: z.string().min(1),
    controlGeneration: z.number().int().nonnegative(),
    acceptedObligations: z.array(acceptedObligationSchema),
    recordedAt: z.string().datetime(),
  })
  .passthrough();

/**
 * What ends the hold a failed attempt leaves. A transient failure is retried after a backoff; a decisive one waits
 * for another target, because the same target would fail the same way.
 */
const attemptRetrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('transient'), retryAfterMs: z.number().int().nonnegative() }).passthrough(),
  z.object({ kind: z.literal('target-change') }).passthrough(),
]);

export type AttemptRetry = z.infer<typeof attemptRetrySchema>;

/** Transient failures one target has spent in total, and the earliest time its next attempt may launch. */
const transientRetrySchema = z
  .object({
    targetKey: z.string().min(1),
    failures: z.number().int().positive(),
    retryAfter: z.string().datetime(),
  })
  .passthrough();

const upgradeIntentSchema = z
  .object({
    version: z.literal('v1'),
    requestId: z.string().min(1),
    requestedAt: z.string().datetime().optional(),
    revision: z.number().int().nonnegative(),
    incumbent: incumbentIdentitySchema,
    target: z
      .object({
        build: buildIdentitySchema,
        pluginRootLabel: z.string().min(1),
      })
      .passthrough(),
    attemptId: z.string().min(1).nullable(),
    attemptChild: z
      .object({
        attemptId: z.string().min(1),
        pid: z.number().int().positive(),
        incarnation: processIncarnationSchema,
      })
      .passthrough()
      .nullable()
      .optional(),
    attemptOwner: attemptOwnerSchema.nullable(),
    disposition: z.enum(['pending', 'deferred', 'attempting', 'completed', 'closed']),
    blockers: z.array(blockerSchema),
    retryCondition: retryConditionSchema.nullable(),
    attemptDeadline: z.string().datetime().nullable(),
    completionReceipt: servingReceiptSchema.nullable(),
    // A retry record this build cannot read degrades to absent rather than corrupting the intent: losing it only
    // restarts the backoff count or keeps a recovery grant decisive, while a corrupt intent refuses the upgrade.
    transientRetry: transientRetrySchema.optional().catch(undefined),
    /** The failure a same-build recovery grant stands in for. */
    recoveryRetry: attemptRetrySchema.nullable().optional().catch(undefined),
  })
  .passthrough()
  .superRefine((intent, context) => {
    if (intent.disposition === 'completed') {
      if (
        intent.completionReceipt === null ||
        intent.attemptOwner === null ||
        intent.completionReceipt.attemptId !== intent.attemptId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['completionReceipt'],
          message: 'Completion requires a serving receipt for the current attempt',
        });
      } else if (
        intent.completionReceipt.successor.build.buildSetId !== intent.target.build.buildSetId ||
        intent.completionReceipt.successor.build.version !== intent.target.build.version ||
        intent.completionReceipt.successor.build.flavor !== intent.target.build.flavor ||
        intent.completionReceipt.successor.build.storeFormatFingerprint !==
          intent.target.build.storeFormatFingerprint ||
        intent.completionReceipt.successor.build.bundleHash !== intent.target.build.bundleHash ||
        intent.completionReceipt.successor.build.cliBundleHash !== intent.target.build.cliBundleHash ||
        intent.completionReceipt.successor.build.claudeAppserverBundleHash !==
          intent.target.build.claudeAppserverBundleHash ||
        intent.completionReceipt.successor.build.durableWrapperBundleHash !==
          intent.target.build.durableWrapperBundleHash
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['completionReceipt', 'successor', 'build'],
          message: 'The serving successor must match the requested build',
        });
      } else if (
        intent.completionReceipt.acceptedObligations.some(
          (obligation) => obligation.controlGeneration !== intent.completionReceipt?.controlGeneration,
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['completionReceipt', 'acceptedObligations'],
          message: 'Accepted obligations must be controlled by the serving generation',
        });
      } else if (
        intent.attemptDeadline !== null &&
        Date.parse(intent.completionReceipt.recordedAt) > Date.parse(intent.attemptDeadline)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['completionReceipt', 'recordedAt'],
          message: 'Serving must precede the attempt deadline',
        });
      }
    } else if (intent.completionReceipt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completionReceipt'],
        message: 'Only a completed intent may hold a serving receipt',
      });
    }
  });

export type UpgradeIntent = z.infer<typeof upgradeIntentSchema>;
export type UpgradeIntentChange = Pick<
  UpgradeIntent,
  | 'requestId'
  | 'requestedAt'
  | 'incumbent'
  | 'target'
  | 'attemptId'
  | 'attemptChild'
  | 'attemptOwner'
  | 'disposition'
  | 'blockers'
  | 'retryCondition'
  | 'attemptDeadline'
  | 'completionReceipt'
> &
  Record<string, unknown>;
export type UpgradeIntentVisibility = Readonly<{
  requestId: string;
  disposition: UpgradeIntent['disposition'];
  phase: 'pending' | 'prepared' | 'ready' | 'committing';
  target: Readonly<{
    version: string;
    buildSetId: string;
    flavor: 'dev' | 'prod';
    storeFormatFingerprint: string;
    bundleHash: string;
    cliBundleHash: string;
    claudeAppserverBundleHash: string;
    durableWrapperBundleHash: string;
    pluginRootLabel: string;
  }>;
  blockers: readonly Readonly<{ owner: string; reason: string }>[];
  reason: string;
  since: string | null;
  retryCondition: UpgradeIntent['retryCondition'];
}>;

const upgradeIntentVisibilitySchema = z.object({
  requestId: z.string().min(1),
  disposition: z.enum(['pending', 'deferred', 'attempting', 'completed', 'closed']),
  phase: z.enum(['pending', 'prepared', 'ready', 'committing']),
  target: z.object({
    version: z.string().min(1),
    buildSetId: z.string().min(1),
    flavor: z.enum(['dev', 'prod']),
    storeFormatFingerprint: z.string().min(1),
    bundleHash: z.string().min(1),
    cliBundleHash: z.string().min(1),
    claudeAppserverBundleHash: z.string().min(1),
    durableWrapperBundleHash: z.string().min(1),
    pluginRootLabel: z.string().min(1),
  }),
  blockers: z.array(blockerSchema.pick({ owner: true, reason: true })),
  reason: z.string().min(1),
  since: z.string().datetime().nullable(),
  retryCondition: retryConditionSchema.nullable(),
});

export function parseVisibleUpgradeIntent(value: unknown): UpgradeIntentVisibility | null {
  const parsed = upgradeIntentVisibilitySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function visibleUpgradeIntent(intent: UpgradeIntent): UpgradeIntentVisibility | null {
  if (intent.disposition === 'closed' || intent.disposition === 'completed') return null;
  const preparation = intent.successionPreparation;
  const stage =
    typeof preparation === 'object' && preparation !== null && 'stage' in preparation ? preparation.stage : null;
  const phase =
    intent.disposition === 'attempting'
      ? 'committing'
      : intent.disposition === 'deferred'
        ? 'pending'
        : stage === 'prepared' || stage === 'ready' || stage === 'committing'
          ? stage
          : 'pending';
  return {
    requestId: intent.requestId,
    disposition: intent.disposition,
    phase,
    target: {
      version: intent.target.build.version,
      buildSetId: intent.target.build.buildSetId,
      flavor: intent.target.build.flavor,
      storeFormatFingerprint: intent.target.build.storeFormatFingerprint,
      bundleHash: intent.target.build.bundleHash,
      cliBundleHash: intent.target.build.cliBundleHash,
      claudeAppserverBundleHash: intent.target.build.claudeAppserverBundleHash,
      durableWrapperBundleHash: intent.target.build.durableWrapperBundleHash,
      pluginRootLabel: intent.target.pluginRootLabel,
    },
    blockers: intent.blockers.map(({ owner, reason }) => ({ owner, reason })),
    reason: intent.retryCondition?.evidence ?? intent.blockers[0]?.reason ?? 'awaiting succession reconciliation',
    since: intent.requestedAt ?? null,
    retryCondition: intent.retryCondition,
  };
}

export type UpgradeIntentRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unreadable'; cause: unknown }>
  | Readonly<{ kind: 'corrupt' }>
  | Readonly<{ kind: 'unsupported'; version: unknown }>
  | Readonly<{ kind: 'readable'; intent: UpgradeIntent }>;

export type UpgradeIntentProblem = Extract<UpgradeIntentRead['kind'], 'unreadable' | 'corrupt' | 'unsupported'>;

export function upgradeIntentProblem(read: UpgradeIntentRead): UpgradeIntentProblem | null {
  return read.kind === 'unreadable' || read.kind === 'corrupt' || read.kind === 'unsupported' ? read.kind : null;
}

export type UpgradeIntentWrite =
  | Readonly<{ kind: 'written'; intent: UpgradeIntent }>
  | Readonly<{ kind: 'conflict'; current: UpgradeIntent | null }>
  | Readonly<{ kind: 'unreadable' | 'corrupt' | 'unsupported' }>;

function readUpgradeIntentAtPath(path: string): UpgradeIntentRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (cause: unknown) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', cause };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'corrupt' };
  }
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 'v1') {
    const version = typeof value === 'object' && value !== null && 'version' in value ? value.version : undefined;
    return { kind: 'unsupported', version };
  }
  const parsed = upgradeIntentSchema.safeParse(value);
  return parsed.success ? { kind: 'readable', intent: parsed.data } : { kind: 'corrupt' };
}

/** Unknown generations and malformed records never authorize an overwrite. */
export function readUpgradeIntent(runDir: string): UpgradeIntentRead {
  return readUpgradeIntentAtPath(upgradeIntentPath(runDir));
}

/** A persisted root label is never a launch capability; validate its current manifest at launch. */
export function revalidateUpgradeIntentTarget(
  intent: UpgradeIntent,
  pluginRoot: string = intent.target.pluginRootLabel,
): ForeignTargetValidationResult {
  const {
    version,
    buildSetId,
    flavor,
    storeFormatFingerprint,
    bundleHash,
    cliBundleHash,
    claudeAppserverBundleHash,
    durableWrapperBundleHash,
  } = intent.target.build;
  const manifest = {
    version,
    buildSetId,
    flavor,
    storeFormatFingerprint,
    bundleHash,
    cliBundleHash,
    claudeAppserverBundleHash,
    durableWrapperBundleHash,
  };
  return createForeignTargetValidator()(join(pluginRoot, 'bridge'), manifest);
}

function mergeUnknownKeys(oldValue: unknown, newValue: unknown): unknown {
  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    return newValue.map((entry) => {
      if (typeof entry !== 'object' || entry === null || !('owner' in entry)) return entry;
      const previous = oldValue.find(
        (candidate) =>
          typeof candidate === 'object' &&
          candidate !== null &&
          'owner' in candidate &&
          candidate.owner === entry.owner &&
          (!('receiptId' in entry) || ('receiptId' in candidate && candidate.receiptId === entry.receiptId)),
      );
      return mergeUnknownKeys(previous, entry);
    });
  }
  if (
    typeof oldValue !== 'object' ||
    oldValue === null ||
    Array.isArray(oldValue) ||
    typeof newValue !== 'object' ||
    newValue === null ||
    Array.isArray(newValue)
  ) {
    return newValue;
  }
  const merged: Record<string, unknown> = { ...oldValue };
  for (const [key, value] of Object.entries(newValue)) merged[key] = mergeUnknownKeys(merged[key], value);
  return merged;
}

function writeAtomic(path: string, value: UpgradeIntent): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = `${path}.stage.${process.pid}.${randomUUID()}`;
  let fd: number | null = null;
  try {
    fd = openSync(stage, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(stage, path);
    const directoryFd = openSync(parent, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(stage, { force: true });
  }
}

/** Supply a complete next state before locking; the revision check serializes concurrent writers. */
export async function compareAndSwapUpgradeIntent(
  runDir: string,
  expectedRevision: number | null,
  change: UpgradeIntentChange,
): Promise<UpgradeIntentWrite> {
  const path = upgradeIntentPath(runDir);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const lease = await acquireDirectoryLock(join(runDir, 'upgrade.v1.lock'));
  try {
    const observed = readUpgradeIntentAtPath(path);
    if (observed.kind === 'unreadable' || observed.kind === 'corrupt' || observed.kind === 'unsupported') {
      return { kind: observed.kind };
    }
    const current = observed.kind === 'readable' ? observed.intent : null;
    if (current?.revision !== (expectedRevision ?? undefined)) return { kind: 'conflict', current };
    const next = upgradeIntentSchema.parse(
      mergeUnknownKeys(current, {
        ...change,
        requestedAt:
          current !== null && current.requestId === change.requestId
            ? (current.requestedAt ?? new Date().toISOString())
            : new Date().toISOString(),
        version: 'v1',
        revision: (current?.revision ?? -1) + 1,
      }),
    );
    lease.assertOwned();
    writeAtomic(path, next);
    if (
      current === null ||
      current.requestId !== next.requestId ||
      current.disposition !== next.disposition ||
      JSON.stringify(visibleUpgradeIntent(current)) !== JSON.stringify(visibleUpgradeIntent(next))
    ) {
      writeAuditEvent('upgrade_intent_status_changed', {
        requestId: next.requestId,
        revision: next.revision,
        previous: current?.disposition ?? 'absent',
        disposition: next.disposition,
        targetBuildSetId: next.target.build.buildSetId,
        blockers: next.blockers,
        retryCondition: next.retryCondition,
      });
    }
    return { kind: 'written', intent: next };
  } finally {
    lease();
  }
}

const UPGRADE_INTENT_CAS_ATTEMPTS = 8;

export type UpgradeIntentCasStep<T> =
  | Readonly<{ kind: 'settle'; value: T }>
  | Readonly<{ kind: 'retry' }>
  | Readonly<{
      kind: 'write';
      expectedRevision: number | null;
      change: UpgradeIntentChange;
      settle: (written: UpgradeIntent) => T;
    }>;

export type UpgradeIntentCasOutcome<T> =
  | Readonly<{ kind: 'settled'; value: T }>
  | Readonly<{ kind: 'refused'; problem: UpgradeIntentProblem }>
  | Readonly<{ kind: 'exhausted' }>;

/**
 * A lost revision race re-reads and decides again; a record this build cannot decode refuses rather than being
 * overwritten, and a writer that keeps losing reports exhaustion instead of spinning.
 */
export async function retryUpgradeIntentCas<T>(
  runDir: string,
  decide: (observed: UpgradeIntentRead) => UpgradeIntentCasStep<T> | Promise<UpgradeIntentCasStep<T>>,
): Promise<UpgradeIntentCasOutcome<T>> {
  for (let attempt = 0; attempt < UPGRADE_INTENT_CAS_ATTEMPTS; attempt++) {
    const step = await decide(readUpgradeIntent(runDir));
    if (step.kind === 'settle') return { kind: 'settled', value: step.value };
    if (step.kind === 'retry') continue;
    const written = await compareAndSwapUpgradeIntent(runDir, step.expectedRevision, step.change);
    if (written.kind === 'conflict') continue;
    if (written.kind !== 'written') return { kind: 'refused', problem: written.kind };
    return { kind: 'settled', value: step.settle(written.intent) };
  }
  return { kind: 'exhausted' };
}
