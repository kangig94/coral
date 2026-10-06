import { sameEpoch } from '../../store/epoch/identity.js';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { backendLog } from '../../infra/backend-log.js';
import { readLaunchAdmission } from '../../infra/launch-admission-record.js';
import { resolveRunningBundleDir, type StrictBundleManifest } from '../../infra/bundle-manifest.js';
import { errorMessage, formatError } from '../../infra/error-format.js';
import { inspectValidatedHandoffTarget, type ValidatedHandoffTarget } from '../../infra/handoff-target.js';
import {
  createRecordedProcessObserver,
  observeProcessLiveness,
  probeProcessIncarnation,
  type ProcessIncarnation,
  type ProcessLiveness,
} from '../../infra/node-process.js';
import { upgradeIntentPath } from '../../infra/path/index.js';
import {
  quarantineCorruptUpgradeIntent,
  compareAndSwapUpgradeIntent,
  readUpgradeIntent,
  parseUpgradeIntentSnapshot,
  retryUpgradeIntentCas,
  revalidateUpgradeIntentTarget,
  type UpgradeIntent,
} from '../../infra/upgrade-intent.js';
import type { Runtime } from '../../runtime/ports.js';
import { readCustodyLedger } from '../../store/custody-ledger.js';
import { raiseStoredProductVersion, type Database } from '../../store/db.js';
import {
  decodeResolvedStoreEpoch,
  discardUnservedRetirementMint,
  encodeResolvedStoreEpoch,
  inspectCurrentStore,
  mintRetiredStoreEpoch,
  observeResolvedStoreEpoch,
  observeResolvedStoreEpochKey,
  type ResolvedStoreEpoch,
  type UnservedMintDiscard,
} from '../../store/epoch/index.js';
import type { StoreFormatDescription } from '../../store/format-fingerprint.js';
import {
  openCommittedBackendStoreAtStartup,
  prepareCommittedBackendStoreAtStartup,
} from '../../store/startup-store-routing.js';
import {
  advanceSuccessionWriterGeneration,
  generationForLegacySuccessor,
  handbackSuccessionWriterGeneration,
  joinSuccessionWriterGeneration,
  observeSuccessionServing,
  observeCurrentSuccessionServing,
  observeSuccessionWriterGeneration,
  readSuccessionWriterGeneration,
  recordSuccessionServing,
  type SuccessionWriterGeneration,
} from '../../store/succession-writer-generation.js';
import { decodeDurableCliTransfer, verifyDurableCliRecoveryGrant } from '../services/durable-cli-transfer.js';
import type { IpcListener } from '../../transport/ipc/server.js';
import type { SuccessionAttemptChild } from './attempt-child.js';
import { failedAttemptRetry, recoveryRetryOf, TRANSIENT_RETRY_BASE_MS } from './attempt-retry.js';
import type { SuccessionInterposition } from './interposition.js';
import {
  PROVIDER_OPERATIONS_OWNER,
  PROVIDER_PROXY_SETS_OWNER,
  providerHostRecoveryGrantVerifies,
} from './provider-host-transfer.js';
import {
  readSuccessionCapabilities,
  successionPreparationSchema,
  successionTargetKey,
  type SuccessionPreparation,
} from './protocol.js';
import { observeRetirementDisposition, type RetirementDisposition } from './retirement-disposition.js';

const SUCCESSION_STARTUP_PATIENCE = 3;

/**
 * Startups closer together than this count as one: a burst of spawns observes the same evidence, and must not
 * spend patience that exists to let a process's exit become provable.
 */
const SUCCESSION_STARTUP_PATIENCE_INTERVAL_MS = 30_000;

export class SuccessionAttemptStartupHoldError extends Error {
  readonly hold: SuccessionStartupHold | null;

  constructor(reason: string, hold: SuccessionStartupHold | null = null) {
    super(`Succession attempt startup holds: ${reason}`);
    this.name = 'SuccessionAttemptStartupHoldError';
    this.hold = hold;
  }
}

/**
 * An unreadable record cannot become decisive by waiting; an unproven death may, and a live owner ends its hold
 * only by exiting.
 */
export type SuccessionStartupHold =
  | Readonly<{ kind: 'unsupported-intent'; attemptId: null; reason: string; fingerprint: string }>
  | Readonly<{ kind: 'unreadable-intent'; attemptId: null; source: 'corrupt' | 'unreadable'; fingerprint: string }>
  | Readonly<{ kind: 'attempt-record-unreadable'; attemptId: string }>
  | Readonly<{ kind: 'archive-retirement-unconfirmed'; attemptId: string | null }>
  | Readonly<{ kind: 'deaths-unproven'; attemptId: string; alive: boolean }>
  | Readonly<{ kind: 'recovery-grants-unverified'; attemptId: string }>
  | Readonly<{ kind: 'grant-controller-unavailable'; attemptId: string }>
  | Readonly<{ kind: 'committed-successor-unattributable'; attemptId: string; reason: string }>
  | Readonly<{ kind: 'committed-successor-build-invalid'; attemptId: string }>
  | Readonly<{ kind: 'committed-store-holding'; attemptId: string; reason: string }>
  | Readonly<{ kind: 'committed-recovery-failed'; attemptId: string; reason: string }>
  | Readonly<{ kind: 'dead-attempt-generation-unattributable'; attemptId: string; reason: string }>
  | Readonly<{ kind: 'preferred-epoch-unopenable'; attemptId: string | null; epochKey: string; reason: string }>
  | Readonly<{ kind: 'unserved-mint-held'; attemptId: string; reason: string }>
  | Readonly<{ kind: 'retirement-mint-withheld'; attemptId: null; reason: string }>;

export function startupHoldError(hold: SuccessionStartupHold): SuccessionAttemptStartupHoldError {
  return new SuccessionAttemptStartupHoldError(describeStartupHold(hold), hold);
}

function describeStartupHold(hold: SuccessionStartupHold): string {
  switch (hold.kind) {
    case 'unsupported-intent':
      return hold.reason;
    case 'unreadable-intent':
      return `upgrade intent is ${hold.source}`;
    case 'attempt-record-unreadable':
      return 'incomplete attempt record is unreadable';
    case 'archive-retirement-unconfirmed':
      return 'archived attempt could not be retired before the next attempt is resolved';
    case 'deaths-unproven':
      return hold.alive ? 'a process of the attempt is still alive' : 'attempt process deaths are unproven';
    case 'recovery-grants-unverified':
      return 'unserved transferred obligations lack recovery grants';
    case 'grant-controller-unavailable':
      return 'grant-authorized old controller is unavailable';
    case 'committed-successor-unattributable':
    case 'dead-attempt-generation-unattributable':
      return hold.reason;
    case 'committed-successor-build-invalid':
      return 'committed successor build no longer validates';
    case 'committed-store-holding':
      return `committed successor epoch is holding (${hold.reason})`;
    case 'committed-recovery-failed':
      return `committed successor recovery failed (${hold.reason})`;
    case 'preferred-epoch-unopenable':
      return `preferred epoch cannot be opened (${hold.reason})`;
    case 'unserved-mint-held':
      return `a dead attempt's unserved retirement mint is still held (${hold.reason}); the next startup retries its discard`;
    case 'retirement-mint-withheld':
      return `retirement patience withheld the store epoch mint twice (${hold.reason}); the next startup observes it again`;
  }
}

function patienceSubject(hold: SuccessionStartupHold): string {
  if (hold.kind === 'unsupported-intent' || hold.kind === 'unreadable-intent')
    return `${hold.kind}:${hold.fingerprint}`;
  if (hold.kind === 'preferred-epoch-unopenable') return hold.attemptId ?? `preferred-epoch:${hold.epochKey}`;
  if (hold.kind === 'retirement-mint-withheld') return hold.kind;
  if (hold.kind === 'archive-retirement-unconfirmed') return hold.attemptId ?? 'archived-attempt';
  return hold.attemptId;
}

function startupIntentFingerprint(runtime: Runtime): string {
  try {
    return runtime.ids.sha256(
      runtime.storage.readFileSync(upgradeIntentPath(runtime.paths.coral.coordinator.runDir), 'utf-8'),
    );
  } catch {
    return 'unreadable';
  }
}

function observeRecordedDeaths(
  recorded: readonly Readonly<{ pid: number; incarnation: ProcessIncarnation | null }>[],
): ProcessLiveness {
  const observations = recorded.map(observeRecordedDeath);
  if (observations.includes('alive')) return 'alive';
  return observations.includes('unknown') ? 'unknown' : 'absent';
}

/** A record carrying no incarnation cannot tell its process from a reuse of its pid, so `alive` is unknown. */
export function observeRecordedDeath(
  recorded: Readonly<{ pid: number; incarnation: ProcessIncarnation | null }>,
): ProcessLiveness {
  const observed = createRecordedProcessObserver({
    readIncarnation: (pid) => probeProcessIncarnation(pid),
    observeLiveness: observeProcessLiveness,
  })({ pid: recorded.pid, ...(recorded.incarnation === null ? {} : { incarnation: recorded.incarnation }) });
  return observed === 'alive' && recorded.incarnation === null ? 'unknown' : observed;
}

const startupPatienceSchema = z
  .object({
    version: z.literal('v1'),
    attemptId: z.string().min(1),
    startupId: z.string().min(1),
    startups: z.number().int().positive(),
    countedAt: z.number().int().nonnegative().optional(),
  })
  .passthrough();

function startupPatiencePath(runtime: Runtime, subject: string): string {
  return join(
    runtime.paths.coral.coordinator.runDir,
    'succession-startup-patience.v1',
    `${runtime.ids.sha256(subject)}.json`,
  );
}

function clearStartupPatience(runtime: Runtime, subject: string): void {
  try {
    runtime.storage.rmSync(startupPatiencePath(runtime, subject), { force: true });
  } catch (error: unknown) {
    backendLog.warn(`Succession startup patience could not be cleared: ${formatError(error)}`);
  }
}

type StartupPatienceRead =
  | Readonly<{ kind: 'recorded'; record: z.infer<typeof startupPatienceSchema> }>
  | Readonly<{ kind: 'absent' | 'corrupt' | 'unreadable' }>;

function readStartupPatience(runtime: Runtime, subject: string): StartupPatienceRead {
  let raw: string;
  try {
    raw = runtime.storage.readFileSync(startupPatiencePath(runtime, subject), 'utf-8');
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable' };
  }
  try {
    const parsed = startupPatienceSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success && parsed.data.attemptId === subject
      ? { kind: 'recorded', record: parsed.data }
      : { kind: 'corrupt' };
  } catch {
    return { kind: 'corrupt' };
  }
}

/**
 * A completed intent is never released by abandonment, so its exhausted patience is the durable record that it was
 * abandoned: cleared, the same unchanged evidence would hold the next startups all over again.
 */
function startupPatienceExhausted(runtime: Runtime, subject: string): boolean {
  const read = readStartupPatience(runtime, subject);
  return read.kind === 'recorded' && read.record.startups >= SUCCESSION_STARTUP_PATIENCE;
}

async function exhaustStartupPatience(
  runtime: Runtime,
  startupId: string,
  hold: SuccessionStartupHold,
): Promise<boolean> {
  if (hold.kind === 'deaths-unproven' && hold.alive) return false;
  const subject = patienceSubject(hold);
  const path = startupPatiencePath(runtime, subject);
  const read = readStartupPatience(runtime, subject);
  // Damaged counters restart the bounded count; uncertainty may delay abandonment, never authorize it.
  const previous = read.kind === 'recorded' ? read.record : null;
  if (previous !== null && previous.startups >= SUCCESSION_STARTUP_PATIENCE) {
    const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (
      hold.attemptId !== null &&
      !(
        observed.kind === 'readable' &&
        observed.intent.attemptId === hold.attemptId &&
        observed.intent.disposition === 'completed'
      )
    ) {
      const recorded = await recordStartupHold(runtime, hold.attemptId, hold, previous.startups, true);
      if (recorded === 'released') clearStartupPatience(runtime, subject);
    }
    return true;
  }
  const now = runtime.time.now();
  const repeated =
    previous !== null &&
    (previous.startupId === startupId ||
      (previous.countedAt !== undefined && now - previous.countedAt < SUCCESSION_STARTUP_PATIENCE_INTERVAL_MS))
      ? previous
      : null;
  const startups = repeated?.startups ?? (previous?.startups ?? 0) + 1;
  const countedAt = repeated === null ? now : (repeated.countedAt ?? now);
  runtime.storage.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record = { ...previous, version: 'v1', attemptId: subject, startupId, startups, countedAt };
  if (!runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })) {
    throw new SuccessionAttemptStartupHoldError(`${describeStartupHold(hold)}; patience could not be recorded`, hold);
  }
  const exhausted = startups >= SUCCESSION_STARTUP_PATIENCE;
  const recorded =
    hold.attemptId === null ? 'released' : await recordStartupHold(runtime, hold.attemptId, hold, startups, exhausted);
  if (exhausted && recorded === 'released' && hold.attemptId !== null) clearStartupPatience(runtime, subject);
  return exhausted;
}

async function recordStartupHold(
  runtime: Runtime,
  attemptId: string,
  hold: SuccessionStartupHold,
  startups: number,
  exhausted: boolean,
): Promise<'released' | 'retained'> {
  const reason = exhausted
    ? `abandoned after ${startups} startups: ${describeStartupHold(hold)}`
    : `${describeStartupHold(hold)} (startup ${startups} of ${SUCCESSION_STARTUP_PATIENCE})`;
  const outcome = await retryUpgradeIntentCas<'released' | 'retained'>(
    runtime.paths.coral.coordinator.runDir,
    (observed) => {
      if (observed.kind !== 'readable') {
        return { kind: 'settle', value: 'released' };
      }
      const blocker = { owner: 'succession-startup', reason };
      if (observed.intent.attemptId !== attemptId) {
        const archived = observed.intent.supersededAttempts;
        const [first, ...remaining] = Array.isArray(archived) ? archived : [];
        const prior = parseUpgradeIntentSnapshot(first);
        if (prior?.attemptId !== attemptId) {
          return { kind: 'settle', value: 'released' };
        }
        const abandoned = Array.isArray(observed.intent.abandonedSupersededAttempts)
          ? observed.intent.abandonedSupersededAttempts
          : [];
        return {
          kind: 'write',
          expectedRevision: observed.intent.revision,
          change: {
            ...observed.intent,
            blockers: [...observed.intent.blockers.filter((entry) => entry.owner !== blocker.owner), blocker],
            ...(exhausted
              ? {
                  supersededAttempts: remaining,
                  abandonedSupersededAttempts: [...abandoned, { ...prior, abandonmentReason: reason }],
                }
              : {}),
          },
          settle: () => (exhausted ? 'released' : 'retained'),
        };
      }
      const releases = exhausted && observed.intent.disposition !== 'completed';
      return {
        kind: 'write',
        expectedRevision: observed.intent.revision,
        change: releases
          ? {
              ...observed.intent,
              disposition: 'deferred',
              attemptId: null,
              attemptChild: null,
              attemptOwner: null,
              attemptDeadline: null,
              recoveryAttemptId: null,
              recoveryBuildSetId: null,
              recoveryRetry: null,
              successionPreparation: null,
              unservedMintDiscard:
                observed.intent.unservedMintDiscard ?? abandonedMintDiscard(runtime, observed.intent.attemptId),
              blockers: [blocker],
              retryCondition: { kind: 'target-change', evidence: 'abandoned incomplete succession attempt' },
            }
          : {
              ...observed.intent,
              blockers: [...observed.intent.blockers.filter((entry) => entry.owner !== blocker.owner), blocker],
            },
        settle: () => (releases ? 'released' : 'retained'),
      };
    },
  );
  if (outcome.kind === 'settled') return outcome.value;
  if (exhausted) {
    throw new SuccessionAttemptStartupHoldError(
      `${describeStartupHold(hold)}; abandonment could not be recorded`,
      hold,
    );
  }
  return 'retained';
}

function abandonedMintDiscard(runtime: Runtime, attemptId: string | null): UpgradeIntent['unservedMintDiscard'] {
  if (attemptId === null) return null;
  const retirement = observeRetirementDisposition(runtime, attemptId);
  if (retirement.kind === 'unreadable') {
    backendLog.warn(`An abandoned attempt's retirement disposition is unreadable; its mint, if any, stays in place.`);
  }
  return retirement.kind === 'recorded'
    ? { attemptId, incumbentEpochKey: retirement.disposition.incumbentEpochKey }
    : null;
}

async function holdUnlessAbandoned(runtime: Runtime, startupId: string, hold: SuccessionStartupHold): Promise<void> {
  if (!(await exhaustStartupPatience(runtime, startupId, hold))) throw startupHoldError(hold);
  backendLog.warn(`Abandoned a succession hold for ordinary store selection: ${describeStartupHold(hold)}`);
}

export type DeadAttemptRecovery = Readonly<{
  attemptId: string;
  epochKey: string;
  force: boolean;
  discardAttemptId?: string;
}>;

export type IncompleteSuccessionResolution =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'recover'; attempt: DeadAttemptRecovery; preferredEpochKey: string | null }>
  | Readonly<{ kind: 'retire'; attemptId: string }>
  | Readonly<{ kind: 'handoff'; target: ValidatedHandoffTarget }>
  | Readonly<{ kind: 'hold'; hold: SuccessionStartupHold }>;

type IncompleteSuccessionOptions = Readonly<{
  runtime: Runtime;
  currentBuild: StrictBundleManifest;
  startupId: string;
  prepareRecoveryGrantHandoff?: (epochKey: string, incumbentInstanceId: string) => ValidatedHandoffTarget | null;
}>;

function runsCurrentBuild(target: ValidatedHandoffTarget, currentBuild: StrictBundleManifest): boolean {
  const build = inspectValidatedHandoffTarget(target).build;
  return build.buildSetId === currentBuild.buildSetId && build.bundleHash === currentBuild.bundleHash;
}

function recoveryGrantsVerify(
  runtime: Runtime,
  flavor: 'prod' | 'dev',
  attemptId: string,
  preparation: SuccessionPreparation,
): boolean {
  const oldEpoch = observeResolvedStoreEpoch(runtime, preparation.epochKey);
  return (
    oldEpoch !== undefined &&
    preparation.receipts.every((receipt) => {
      if (receipt.attemptId !== attemptId) return false;
      if (receipt.owner === 'durable-cli') {
        const transfer = decodeDurableCliTransfer(receipt.payload, oldEpoch);
        return (
          transfer !== null &&
          verifyDurableCliRecoveryGrant(
            runtime,
            runtime.paths.coral.coordinator.runDir,
            attemptId,
            receipt.recoveryGrantId,
            preparation.epochKey,
            preparation.incumbentInstanceId,
            transfer,
          )
        );
      }
      if (receipt.owner === PROVIDER_PROXY_SETS_OWNER || receipt.owner === PROVIDER_OPERATIONS_OWNER) {
        return providerHostRecoveryGrantVerifies(runtime, flavor, preparation, receipt);
      }
      return false;
    })
  );
}

function unprovenSuccessionDeaths(
  attemptId: string,
  processes: readonly Readonly<{ pid: number; incarnation: ProcessIncarnation | null }>[],
): SuccessionStartupHold | null {
  const deaths = observeRecordedDeaths(processes);
  return deaths === 'absent' ? null : { kind: 'deaths-unproven', attemptId, alive: deaths === 'alive' };
}

async function resolveUnservedSuccessionAttempt(
  options: IncompleteSuccessionOptions,
  intent: UpgradeIntent,
  prior: UpgradeIntent | null,
  holdOrAbandon: (hold: SuccessionStartupHold) => Promise<IncompleteSuccessionResolution>,
  retireArchived: (attemptId: string | null) => Promise<IncompleteSuccessionResolution>,
): Promise<IncompleteSuccessionResolution> {
  const { runtime } = options;
  const attemptId = intent.attemptId;
  if (
    intent.attemptOwner?.kind !== 'incumbent' ||
    attemptId === null ||
    observeSuccessionServing(runtime, attemptId) !== null
  ) {
    return { kind: 'none' };
  }
  const owner = intent.attemptOwner;
  const child = intent.attemptChild;
  const preparation = successionPreparationSchema.safeParse(intent.successionPreparation);
  const retirement = observeRetirementDisposition(runtime, attemptId);
  const transferEvidence =
    retirement.kind === 'recorded' ||
    (child !== null &&
      child !== undefined &&
      ((preparation.success && preparation.data.receipts.length > 0) || retirement.kind === 'unreadable'));
  if ((intent.disposition === 'pending' || intent.disposition === 'deferred') && !transferEvidence) {
    const unproven = unprovenSuccessionDeaths(
      attemptId,
      child !== undefined && child !== null && child.attemptId === attemptId ? [owner, child] : [owner],
    );
    return unproven === null
      ? prior === null
        ? { kind: 'retire', attemptId }
        : retireArchived(attemptId)
      : holdOrAbandon(unproven);
  }
  if (intent.disposition !== 'attempting' && !transferEvidence) return { kind: 'none' };
  if (!preparation.success || child === undefined || child === null) {
    return holdOrAbandon({ kind: 'attempt-record-unreadable', attemptId });
  }
  const unproven = unprovenSuccessionDeaths(attemptId, [owner, child]);
  if (unproven !== null) return holdOrAbandon(unproven);
  let recovery: DeadAttemptRecovery | null = null;
  let preferredEpochKey: string | null = null;
  if (preparation.data.receipts.length > 0) {
    if (!recoveryGrantsVerify(runtime, options.currentBuild.flavor, attemptId, preparation.data)) {
      return holdOrAbandon({ kind: 'recovery-grants-unverified', attemptId });
    }
    const recoveryTarget = options.prepareRecoveryGrantHandoff?.(
      preparation.data.epochKey,
      preparation.data.incumbentInstanceId,
    );
    if (recoveryTarget === undefined || recoveryTarget === null) {
      return holdOrAbandon({ kind: 'grant-controller-unavailable', attemptId });
    }
    if (!runsCurrentBuild(recoveryTarget, options.currentBuild)) return { kind: 'handoff', target: recoveryTarget };
    recovery = { attemptId, epochKey: preparation.data.epochKey, force: true };
    preferredEpochKey = preparation.data.epochKey;
  }
  // An unreadable disposition may name a mint this attempt made, so only a proven absence skips the discard.
  if (observeRetirementDisposition(runtime, attemptId).kind !== 'absent') {
    const recoveryTarget = options.prepareRecoveryGrantHandoff?.(
      preparation.data.epochKey,
      preparation.data.incumbentInstanceId,
    );
    if (recoveryTarget !== undefined && recoveryTarget !== null) {
      if (!runsCurrentBuild(recoveryTarget, options.currentBuild)) return { kind: 'handoff', target: recoveryTarget };
      preferredEpochKey = preparation.data.epochKey;
    }
    recovery = {
      attemptId,
      epochKey: preparation.data.epochKey,
      force: recovery?.force ?? false,
      discardAttemptId: attemptId,
    };
  }
  return recovery === null
    ? prior === null
      ? { kind: 'retire', attemptId }
      : retireArchived(attemptId)
    : { kind: 'recover', attempt: recovery, preferredEpochKey };
}

async function resolveUnreadableStartupIntent(
  options: IncompleteSuccessionOptions,
  observed: ReturnType<typeof readUpgradeIntent>,
): Promise<IncompleteSuccessionResolution> {
  const { runtime } = options;
  if (observed.kind === 'corrupt') {
    if ((await quarantineCorruptUpgradeIntent(runtime.paths.coral.coordinator.runDir)) === 'quarantined')
      return { kind: 'none' };
    if (readUpgradeIntent(runtime.paths.coral.coordinator.runDir).kind === 'absent') return { kind: 'none' };
    return {
      kind: 'hold',
      hold: {
        kind: 'unreadable-intent',
        attemptId: null,
        source: 'corrupt',
        fingerprint: startupIntentFingerprint(runtime),
      },
    };
  }
  if (observed.kind === 'unsupported' || observed.kind === 'unreadable') {
    const fingerprint = startupIntentFingerprint(runtime);
    const hold: SuccessionStartupHold =
      observed.kind === 'unsupported'
        ? {
            kind: 'unsupported-intent',
            attemptId: null,
            reason: 'upgrade intent uses unsupported vocabulary',
            fingerprint,
          }
        : { kind: 'unreadable-intent', attemptId: null, source: observed.kind, fingerprint };
    return (await exhaustStartupPatience(runtime, options.startupId, hold)) ? { kind: 'none' } : { kind: 'hold', hold };
  }
  return { kind: 'none' };
}

async function retireArchivedStartupAttempt(
  options: IncompleteSuccessionOptions,
  incumbent: UpgradeIntent['incumbent'],
  attemptId: string | null,
): Promise<IncompleteSuccessionResolution> {
  const { runtime } = options;
  await dischargeDeadSuccessionAttempt(runtime, attemptId, incumbent);
  const next = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  if (
    next.kind === 'readable' &&
    Array.isArray(next.intent.supersededAttempts) &&
    parseUpgradeIntentSnapshot(next.intent.supersededAttempts[0])?.attemptId === attemptId
  ) {
    return { kind: 'hold', hold: { kind: 'archive-retirement-unconfirmed', attemptId } };
  }
  return resolveIncompleteSuccessionAtStartup(options);
}

async function resolveRecoveryStartupAttempt(
  options: IncompleteSuccessionOptions,
  intent: UpgradeIntent,
  holdOrAbandon: (hold: SuccessionStartupHold) => Promise<IncompleteSuccessionResolution>,
): Promise<IncompleteSuccessionResolution | null> {
  const { runtime } = options;
  const recoveryAttemptId = intent.recoveryAttemptId;
  if (
    typeof recoveryAttemptId === 'string' &&
    recoveryAttemptId === intent.attemptId &&
    observeSuccessionServing(runtime, recoveryAttemptId) === null
  ) {
    const preparation = successionPreparationSchema.safeParse(intent.successionPreparation);
    const owner = intent.attemptOwner;
    if (
      !preparation.success ||
      preparation.data.stage !== 'prepared' ||
      preparation.data.attemptId !== recoveryAttemptId ||
      owner === null ||
      owner.kind !== 'incumbent'
    ) {
      return holdOrAbandon({ kind: 'attempt-record-unreadable', attemptId: recoveryAttemptId });
    }
    const child = intent.attemptChild;
    const unproven = unprovenSuccessionDeaths(
      recoveryAttemptId,
      child === undefined || child === null ? [owner] : [owner, child],
    );
    if (unproven !== null) return holdOrAbandon(unproven);
    const recoveryTarget = options.prepareRecoveryGrantHandoff?.(
      preparation.data.epochKey,
      preparation.data.incumbentInstanceId,
    );
    if (recoveryTarget === undefined || recoveryTarget === null) {
      return holdOrAbandon({ kind: 'grant-controller-unavailable', attemptId: recoveryAttemptId });
    }
    if (!runsCurrentBuild(recoveryTarget, options.currentBuild)) return { kind: 'handoff', target: recoveryTarget };
    return {
      kind: 'recover',
      attempt: {
        attemptId: recoveryAttemptId,
        epochKey: preparation.data.epochKey,
        force: preparation.data.receipts.length > 0,
      },
      preferredEpochKey: preparation.data.epochKey,
    };
  }
  return null;
}

export async function resolveIncompleteSuccessionAtStartup(
  options: IncompleteSuccessionOptions,
): Promise<IncompleteSuccessionResolution> {
  const { runtime } = options;
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  if (observed.kind !== 'readable') return resolveUnreadableStartupIntent(options, observed);
  const archived = observed.intent.supersededAttempts;
  const prior = Array.isArray(archived) && archived.length > 0 ? parseUpgradeIntentSnapshot(archived[0]) : null;
  if (Array.isArray(archived) && archived.length > 0 && prior === null) {
    const hold = {
      kind: 'unreadable-intent',
      attemptId: null,
      source: 'corrupt',
      fingerprint: startupIntentFingerprint(runtime),
    } as const;
    return (await exhaustStartupPatience(runtime, options.startupId, hold)) ? { kind: 'none' } : { kind: 'hold', hold };
  }
  const intent = prior ?? observed.intent;
  const holdOrAbandon = async (hold: SuccessionStartupHold): Promise<IncompleteSuccessionResolution> => {
    if (!(await exhaustStartupPatience(runtime, options.startupId, hold))) return { kind: 'hold', hold };
    backendLog.warn(`Abandoned an incomplete succession attempt for ordinary startup: ${describeStartupHold(hold)}`);
    return { kind: 'none' };
  };
  const retireArchived = (attemptId: string | null): Promise<IncompleteSuccessionResolution> =>
    retireArchivedStartupAttempt(options, observed.intent.incumbent, attemptId);
  if (prior !== null && (prior.disposition === 'completed' || prior.disposition === 'closed')) {
    return retireArchived(prior.attemptId);
  }
  const recovery = await resolveRecoveryStartupAttempt(options, intent, holdOrAbandon);
  if (recovery !== null) return recovery;
  return resolveUnservedSuccessionAttempt(options, intent, prior, holdOrAbandon, retireArchived);
}

export async function handBackDeadAttemptGeneration(
  runtime: Runtime,
  startupId: string,
  attempt: DeadAttemptRecovery,
): Promise<'settled' | 'abandoned'> {
  const oldEpoch = decodeResolvedStoreEpoch(runtime, attempt.epochKey);
  const generation = observeSuccessionWriterGeneration(runtime);
  if (oldEpoch === undefined || generation === null) return 'settled';
  const storeRoot = oldEpoch.canonicalStoreRoot ?? oldEpoch.storeRoot;
  const unattributable =
    generation.storeRoot !== storeRoot
      ? 'unserved writer generation belongs to another store root'
      : generation.epoch !== oldEpoch.epoch && BigInt(generation.epoch) !== BigInt(oldEpoch.epoch) + 1n
        ? 'unserved writer generation is not the retiring successor'
        : null;
  if (unattributable !== null) {
    await holdUnlessAbandoned(runtime, startupId, {
      kind: 'dead-attempt-generation-unattributable',
      attemptId: attempt.attemptId,
      reason: unattributable,
    });
    return 'abandoned';
  }
  if (generation.epoch === oldEpoch.epoch && !attempt.force) return 'settled';
  handbackSuccessionWriterGeneration(runtime, generation, { storeRoot, epoch: oldEpoch.epoch });
  return 'settled';
}

export async function openPreferredStoreEpoch(
  context: SuccessionStoreContext,
  startupId: string,
  epochKey: string,
  attemptId: string | null,
): Promise<Readonly<{ db: Database; store: ResolvedStoreEpoch }> | null> {
  const { runtime } = context;
  const preferred = decodeResolvedStoreEpoch(runtime, epochKey);
  const opened =
    preferred === undefined
      ? ({ kind: 'holding', reason: 'preferred epoch is invalid' } as const)
      : openCommittedBackendStoreAtStartup(
          runtime,
          {
            storeFormat: context.storeFormat,
            build: context.currentBuild,
            startupBusyTimeoutMs: context.busyTimeoutMs,
          },
          preferred,
        );
  const hold = { kind: 'preferred-epoch-unopenable', attemptId, epochKey } as const;
  if (opened.kind !== 'holding') {
    clearStartupPatience(runtime, patienceSubject({ ...hold, reason: 'opened' }));
    return { db: opened.db, store: opened.store };
  }
  await holdUnlessAbandoned(runtime, startupId, { ...hold, reason: opened.reason });
  return null;
}

export async function dischargeDeadSuccessionAttempt(
  runtime: Runtime,
  attemptId: string | null,
  incumbent: UpgradeIntent['incumbent'],
): Promise<void> {
  const outcome = await retryUpgradeIntentCas(runtime.paths.coral.coordinator.runDir, (observed) => {
    if (observed.kind === 'readable' && Array.isArray(observed.intent.supersededAttempts)) {
      const [first, ...remaining] = observed.intent.supersededAttempts;
      if (parseUpgradeIntentSnapshot(first)?.attemptId === attemptId) {
        return {
          kind: 'write',
          expectedRevision: observed.intent.revision,
          change: { ...observed.intent, supersededAttempts: remaining },
          settle: () => undefined,
        };
      }
    }
    if (
      attemptId === null ||
      observed.kind !== 'readable' ||
      observed.intent.attemptId !== attemptId ||
      observed.intent.disposition === 'completed'
    ) {
      return { kind: 'settle', value: undefined };
    }
    const intent = observed.intent;
    const restart = intent.recoveryAttemptId === attemptId;
    return {
      kind: 'write',
      expectedRevision: intent.revision,
      change: {
        ...intent,
        incumbent,
        attemptId: null,
        attemptChild: null,
        attemptOwner: null,
        attemptDeadline: null,
        recoveryAttemptId: null,
        recoveryBuildSetId: null,
        recoveryRetry: null,
        successionPreparation: null,
        disposition: 'deferred',
        blockers: [
          {
            owner: 'succession-commit',
            reason: restart
              ? 'same-build restart serves after failed target commit'
              : 'startup recovered an attempt whose incumbent died',
          },
        ],
        ...failedAttemptRetry(
          intent,
          restart ? recoveryRetryOf(intent) : { kind: 'transient', retryAfterMs: TRANSIENT_RETRY_BASE_MS },
          'successor committed-open failure',
          runtime.time.now(),
        ),
      },
      settle: () => undefined,
    };
  });
  if (outcome.kind !== 'settled') {
    backendLog.warn(
      `A dead succession attempt could not be discharged (${outcome.kind}); the next startup acts on it.`,
    );
  }
}

export async function retryRecordedMintDiscard(runtime: Runtime): Promise<UnservedMintDiscard | null> {
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  const pending = observed.kind === 'readable' ? (observed.intent.unservedMintDiscard ?? null) : null;
  if (pending === null) return null;
  const discarded = discardUnservedRetirementMint(runtime, pending.incumbentEpochKey, pending.attemptId);
  if (discarded.kind === 'held') {
    backendLog.warn(`A recorded unserved retirement mint is still held: ${discarded.reason}`);
    return discarded;
  }
  const cleared = await retryUpgradeIntentCas(runtime.paths.coral.coordinator.runDir, (current) =>
    current.kind === 'readable' && current.intent.unservedMintDiscard?.attemptId === pending.attemptId
      ? {
          kind: 'write',
          expectedRevision: current.intent.revision,
          change: { ...current.intent, unservedMintDiscard: null },
          settle: () => undefined,
        }
      : { kind: 'settle', value: undefined },
  );
  if (cleared.kind !== 'settled') {
    backendLog.warn(`A discarded retirement mint record could not be cleared (${cleared.kind}); it is retried.`);
  }
  return discarded;
}

export function heldUnservedMint(runtime: Runtime): SuccessionStartupHold | null {
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  const pending = observed.kind === 'readable' ? (observed.intent.unservedMintDiscard ?? null) : null;
  if (pending === null) return null;
  const incumbent = decodeResolvedStoreEpoch(runtime, pending.incumbentEpochKey);
  const current = inspectCurrentStore(runtime);
  if (
    incumbent !== undefined &&
    current.kind === 'current' &&
    current.epoch.epoch !== (BigInt(incumbent.epoch) + 1n).toString()
  ) {
    return null;
  }
  return {
    kind: 'unserved-mint-held',
    attemptId: pending.attemptId,
    reason: 'a recorded unserved retirement mint may still be read as the current store',
  };
}

export async function prepareSuccessionAttemptStore(
  runtime: Runtime,
  identity: Readonly<{ pluginRoot: string }>,
  storeFormat: StoreFormatDescription,
  currentBuild: StrictBundleManifest,
  child: SuccessionAttemptChild,
): Promise<Readonly<{ store: ResolvedStoreEpoch; retirement: boolean }>> {
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  const bundleDir = resolveRunningBundleDir(identity.pluginRoot);
  const capabilities =
    observed.kind === 'readable' && bundleDir !== null
      ? readSuccessionCapabilities(runtime, bundleDir, observed.intent.target.build)
      : null;
  const preparation =
    observed.kind === 'readable' ? successionPreparationSchema.safeParse(observed.intent.successionPreparation) : null;
  if (child.recovery) {
    if (
      observed.kind !== 'readable' ||
      observed.intent.recoveryAttemptId !== child.attemptId ||
      observed.intent.recoveryBuildSetId !== currentBuild.buildSetId ||
      observed.intent.attemptId !== child.attemptId ||
      observed.intent.attemptOwner?.kind !== 'incumbent' ||
      observed.intent.incumbent.version !== currentBuild.version ||
      observed.intent.incumbent.bundleHash !== currentBuild.bundleHash ||
      observed.intent.incumbent.flavor !== currentBuild.flavor ||
      preparation === null ||
      !preparation.success ||
      preparation.data.stage !== 'prepared' ||
      preparation.data.ready !== null ||
      !sameEpoch(preparation.data.epochKey, child.epochKey) ||
      JSON.stringify(preparation.data.receipts.map((receipt) => receipt.receiptId)) !== JSON.stringify(child.receiptIds)
    ) {
      throw new SuccessionAttemptStartupHoldError('same-build recovery preparation changed');
    }
    const prepared = prepareCommittedBackendStoreAtStartup(
      runtime,
      { storeFormat, build: currentBuild },
      child.epochKey,
    );
    if (prepared.kind === 'holding') throw new SuccessionAttemptStartupHoldError(prepared.reason);
    await child.acknowledge({ kind: 'ready', epochKey: child.epochKey, receiptIds: child.receiptIds });
    return { store: prepared.store, retirement: false };
  }
  if (
    observed.kind !== 'readable' ||
    bundleDir === null ||
    capabilities?.kind !== 'declared' ||
    preparation === null ||
    !preparation.success ||
    preparation.data.stage !== 'prepared' ||
    preparation.data.ready !== null ||
    preparation.data.capabilitiesKey !== JSON.stringify(capabilities.capabilities) ||
    JSON.stringify(preparation.data.accepts.map(({ owner, generation }) => [owner, generation])) !==
      JSON.stringify(capabilities.capabilities.accepts.map(({ owner, generation }) => [owner, generation])) ||
    preparation.data.receipts.some(
      (receipt) =>
        receipt.attemptId !== child.attemptId ||
        !preparation.data.accepts.some(
          (acceptance) => acceptance.owner === receipt.owner && acceptance.generation === receipt.generation,
        ),
    ) ||
    observed.intent.attemptId !== child.attemptId ||
    observed.intent.attemptOwner?.kind !== 'incumbent' ||
    observed.intent.disposition !== 'pending' ||
    observed.intent.target.pluginRootLabel !== identity.pluginRoot ||
    observed.intent.target.build.version !== currentBuild.version ||
    observed.intent.target.build.buildSetId !== currentBuild.buildSetId ||
    observed.intent.target.build.bundleHash !== currentBuild.bundleHash ||
    observed.intent.target.build.cliBundleHash !== currentBuild.cliBundleHash ||
    observed.intent.target.build.claudeAppserverBundleHash !== currentBuild.claudeAppserverBundleHash ||
    observed.intent.target.build.durableWrapperBundleHash !== currentBuild.durableWrapperBundleHash ||
    observed.intent.target.build.flavor !== currentBuild.flavor ||
    observed.intent.target.build.storeFormatFingerprint !== currentBuild.storeFormatFingerprint ||
    revalidateUpgradeIntentTarget(observed.intent).kind !== 'validated' ||
    preparation.data.attemptId !== child.attemptId ||
    preparation.data.requestId !== observed.intent.requestId ||
    preparation.data.incumbentInstanceId !== observed.intent.incumbent.instanceId ||
    preparation.data.incumbentPid !== observed.intent.incumbent.pid ||
    preparation.data.targetKey !==
      JSON.stringify([
        identity.pluginRoot,
        currentBuild.version,
        currentBuild.buildSetId,
        currentBuild.flavor,
        currentBuild.storeFormatFingerprint,
        currentBuild.bundleHash,
        currentBuild.cliBundleHash,
        currentBuild.claudeAppserverBundleHash,
        currentBuild.durableWrapperBundleHash,
      ]) ||
    !sameEpoch(preparation.data.epochKey, child.epochKey) ||
    JSON.stringify(preparation.data.receipts.map((receipt) => receipt.receiptId)) !== JSON.stringify(child.receiptIds)
  ) {
    throw new SuccessionAttemptStartupHoldError('prepared attempt or target changed');
  }
  const prepared = prepareCommittedBackendStoreAtStartup(runtime, { storeFormat, build: currentBuild }, child.epochKey);
  if (
    prepared.kind === 'holding' &&
    (prepared.reason !== 'format-incompatible' || preparation.data.receipts.length > 0)
  ) {
    throw new SuccessionAttemptStartupHoldError(prepared.reason);
  }
  const retirement = prepared.kind === 'holding';
  const store = retirement ? decodeResolvedStoreEpoch(runtime, child.epochKey) : prepared.store;
  if (store === undefined) throw new SuccessionAttemptStartupHoldError('retiring epoch is unproven');
  await child.acknowledge({ kind: 'ready', epochKey: child.epochKey, receiptIds: child.receiptIds });
  return { store, retirement };
}

/**
 * Only work the dead successor may still control justifies bypassing ordinary build selection for its build.
 * An unreadable ledger may name such work, so it counts as control.
 */
function committedSuccessorMayControlWork(
  runtime: Runtime,
  epochKey: string,
  epochHasLiveJobs: (epochKey: string) => boolean,
): boolean {
  if (epochHasLiveJobs(epochKey)) return true;
  const epoch = decodeResolvedStoreEpoch(runtime, epochKey);
  if (epoch === undefined) return true;
  return readCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir).some(
    (entry) =>
      entry.kind === 'unreadable' ||
      (entry.kind !== 'absent' &&
        (sameEpoch(entry.intent.epochKey, epoch.lineageKey) || entry.intent.epoch === dirname(epoch.path))),
  );
}

export type CommittedSuccessorRecovery =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'recover'; store: ResolvedStoreEpoch; intent: UpgradeIntent }>
  | Readonly<{ kind: 'handoff'; target: ValidatedHandoffTarget }>
  | Readonly<{ kind: 'hold'; hold: SuccessionStartupHold }>;

async function reconcileServedAttempt(
  runtime: Runtime,
): Promise<'none' | 'completed' | Readonly<{ kind: 'unattributable'; attemptId: string; revision: number }>> {
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  if (observed.kind !== 'readable') return 'none';
  const { intent } = observed;
  if (intent.disposition === 'completed') return 'completed';
  if (intent.attemptId === null || intent.disposition !== 'attempting' || intent.attemptOwner?.kind !== 'incumbent')
    return 'none';
  const attemptId = intent.attemptId;
  const serving = observeSuccessionServing(runtime, attemptId);
  if (serving === null || intent.recoveryAttemptId === attemptId) return 'none';
  const unattributable = { kind: 'unattributable', attemptId, revision: intent.revision } as const;
  if (
    !Number.isFinite(Date.parse(serving.recordedAt)) ||
    (intent.attemptDeadline !== null && Date.parse(serving.recordedAt) > Date.parse(intent.attemptDeadline))
  )
    return unattributable;

  const preparation = successionPreparationSchema.safeParse(intent.successionPreparation);
  const child = intent.attemptChild;
  const prepared = preparation.success ? preparation.data : null;
  const retirement = observeRetirementDisposition(runtime, intent.attemptId);
  if (
    prepared === null ||
    prepared.attemptId !== intent.attemptId ||
    prepared.ready === null ||
    prepared.targetKey !== successionTargetKey(intent.target) ||
    prepared.ready.attemptId !== intent.attemptId ||
    prepared.ready.targetKey !== prepared.targetKey ||
    !sameEpoch(prepared.ready.epochKey, prepared.epochKey) ||
    JSON.stringify(prepared.ready.receiptIds) !==
      JSON.stringify(prepared.receipts.map((receipt) => receipt.receiptId)) ||
    (!sameEpoch(prepared.epochKey, serving.epochKey) &&
      (retirement.kind !== 'recorded' || !sameEpoch(retirement.disposition.incumbentEpochKey, prepared.epochKey)))
  )
    return unattributable;
  const pid = prepared.ready.successorPid;
  const incarnation = child?.attemptId === intent.attemptId && child.pid === pid ? child.incarnation : null;
  const acceptedObligations = prepared.receipts.map((ownerReceipt) => ({
    owner: ownerReceipt.owner,
    receiptId: ownerReceipt.receiptId,
    controlGeneration: serving.controlGeneration,
  }));
  const receipt: NonNullable<UpgradeIntent['completionReceipt']> = {
    kind: 'serving',
    attemptId: intent.attemptId,
    successor: { instanceId: serving.successorInstanceId, pid, incarnation, build: intent.target.build },
    epochKey: serving.epochKey,
    controlGeneration: serving.controlGeneration,
    acceptedObligations,
    recordedAt: serving.recordedAt,
  };
  const outcome = await retryUpgradeIntentCas(runtime.paths.coral.coordinator.runDir, (current) => {
    if (current.kind !== 'readable' || current.intent.attemptId !== intent.attemptId) {
      return { kind: 'settle', value: false };
    }
    if (current.intent.disposition === 'completed') return { kind: 'settle', value: true };
    if (
      current.intent.disposition !== 'attempting' ||
      current.intent.revision !== intent.revision ||
      observeSuccessionServing(runtime, attemptId) === null
    )
      return { kind: 'settle', value: false };
    return {
      kind: 'write',
      expectedRevision: current.intent.revision,
      change: {
        ...current.intent,
        disposition: 'completed',
        blockers: [],
        retryCondition: null,
        completionReceipt: receipt,
      },
      settle: () => true,
    };
  });
  if (outcome.kind !== 'settled') return unattributable;
  return outcome.value ? 'completed' : 'none';
}

export async function prepareCommittedSuccessorRecovery(
  runtime: Runtime,
  identity: Readonly<{ pluginRoot: string; instanceId: string }>,
  storeFormat: StoreFormatDescription,
  currentBuild: StrictBundleManifest,
  epochHasLiveJobs: (epochKey: string) => boolean,
): Promise<CommittedSuccessorRecovery> {
  const served = await reconcileServedAttempt(runtime);
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  if (
    typeof served === 'object' &&
    observed.kind === 'readable' &&
    observed.intent.attemptId === served.attemptId &&
    observed.intent.revision === served.revision
  ) {
    const hold = {
      kind: 'committed-successor-unattributable',
      attemptId: served.attemptId,
      reason: 'served attempt has no attributable receipt',
    } as const;
    return (await exhaustStartupPatience(runtime, identity.instanceId, hold))
      ? { kind: 'none' }
      : { kind: 'hold', hold };
  }
  if (observed.kind !== 'readable' || observed.intent.disposition !== 'completed') return { kind: 'none' };
  const intent = observed.intent;
  const receipt = intent.completionReceipt;
  if (receipt === null || startupPatienceExhausted(runtime, receipt.attemptId)) return { kind: 'none' };

  const holdOrAbandon = async (hold: SuccessionStartupHold): Promise<CommittedSuccessorRecovery> =>
    (await exhaustStartupPatience(runtime, identity.instanceId, hold)) ? { kind: 'none' } : { kind: 'hold', hold };
  const current = inspectCurrentStore(runtime);
  if (current.kind !== 'current') return { kind: 'none' };
  const currentKey = observeResolvedStoreEpochKey(runtime, current.epoch);
  if (currentKey === null)
    return holdOrAbandon({
      kind: 'committed-successor-unattributable',
      attemptId: receipt.attemptId,
      reason:
        'current epoch identity is temporarily unreadable; startup recovery re-observes it within its bounded patience window',
    });
  if (!sameEpoch(currentKey, receipt.epochKey)) return { kind: 'none' };
  const serving = observeSuccessionServing(runtime, receipt.attemptId);
  const writer = observeSuccessionWriterGeneration(runtime);
  if (
    writer === null ||
    writer.generation < receipt.controlGeneration ||
    (writer.generation === receipt.controlGeneration && serving === null) ||
    (serving !== null &&
      (!sameEpoch(serving.epochKey, receipt.epochKey) || serving.controlGeneration < receipt.controlGeneration))
  ) {
    return holdOrAbandon({
      kind: 'committed-successor-unattributable',
      attemptId: receipt.attemptId,
      reason: 'committed successor generation cannot be attributed',
    });
  }
  const child = intent.attemptChild;
  const deaths = observeRecordedDeaths(
    child !== undefined &&
      child !== null &&
      (child.pid !== receipt.successor.pid || child.incarnation !== receipt.successor.incarnation)
      ? [receipt.successor, child]
      : [receipt.successor],
  );
  if (deaths !== 'absent') {
    return holdOrAbandon({ kind: 'deaths-unproven', attemptId: receipt.attemptId, alive: deaths === 'alive' });
  }
  if (
    serving !== null &&
    serving.controlGeneration === receipt.controlGeneration &&
    serving.successorInstanceId !== receipt.successor.instanceId
  ) {
    return holdOrAbandon({
      kind: 'committed-successor-unattributable',
      attemptId: receipt.attemptId,
      reason: 'committed successor identity does not match its writer',
    });
  }
  const runsTargetBuild =
    intent.target.build.buildSetId === currentBuild.buildSetId &&
    intent.target.build.bundleHash === currentBuild.bundleHash;
  if (!runsTargetBuild && !committedSuccessorMayControlWork(runtime, receipt.epochKey, epochHasLiveJobs))
    return { kind: 'none' };

  const targetRoot = intent.target.pluginRootLabel;
  const target = revalidateUpgradeIntentTarget(intent);
  if (target.kind !== 'validated') {
    return holdOrAbandon({ kind: 'committed-successor-build-invalid', attemptId: receipt.attemptId });
  }
  if (
    targetRoot !== identity.pluginRoot ||
    intent.target.build.version !== currentBuild.version ||
    intent.target.build.buildSetId !== currentBuild.buildSetId ||
    intent.target.build.flavor !== currentBuild.flavor ||
    intent.target.build.storeFormatFingerprint !== currentBuild.storeFormatFingerprint ||
    intent.target.build.bundleHash !== currentBuild.bundleHash ||
    intent.target.build.cliBundleHash !== currentBuild.cliBundleHash ||
    intent.target.build.claudeAppserverBundleHash !== currentBuild.claudeAppserverBundleHash ||
    intent.target.build.durableWrapperBundleHash !== currentBuild.durableWrapperBundleHash
  ) {
    return { kind: 'handoff', target: target.target };
  }
  const prepared = prepareCommittedBackendStoreAtStartup(
    runtime,
    { storeFormat, build: currentBuild },
    receipt.epochKey,
  );
  if (prepared.kind === 'holding') {
    return holdOrAbandon({ kind: 'committed-store-holding', attemptId: receipt.attemptId, reason: prepared.reason });
  }
  return { kind: 'recover', store: prepared.store, intent };
}

export async function holdFailedCommittedRecovery(
  runtime: Runtime,
  startupId: string,
  recovery: Readonly<{ intent: UpgradeIntent }>,
  error: unknown,
): Promise<'abandoned'> {
  const attemptId = recovery.intent.completionReceipt?.attemptId;
  if (attemptId === undefined) throw error;
  const hold = { kind: 'committed-recovery-failed', attemptId, reason: errorMessage(error) } as const;
  if (!(await exhaustStartupPatience(runtime, startupId, hold))) throw startupHoldError(hold);
  backendLog.warn(`Abandoned committed successor recovery for ordinary startup: ${describeStartupHold(hold)}`);
  return 'abandoned';
}

export async function closeServedIntentAtCleanExit(
  runtime: Runtime,
  instanceId: string,
  incumbent: UpgradeIntent['incumbent'],
): Promise<void> {
  const outcome = await retryUpgradeIntentCas(runtime.paths.coral.coordinator.runDir, (observed) =>
    observed.kind === 'readable' &&
    observed.intent.disposition === 'completed' &&
    observed.intent.completionReceipt?.successor.instanceId === instanceId
      ? {
          kind: 'write',
          expectedRevision: observed.intent.revision,
          change: {
            ...observed.intent,
            incumbent,
            disposition: 'closed',
            completionReceipt: null,
            successionPreparation: null,
            attemptId: null,
            attemptOwner: null,
            attemptChild: null,
            attemptDeadline: null,
            blockers: [],
            retryCondition: null,
          },
          settle: () => undefined,
        }
      : { kind: 'settle', value: undefined },
  );
  if (outcome.kind !== 'settled') {
    backendLog.warn(
      `A served upgrade intent could not be closed at exit (${outcome.kind}); committed recovery may act on it.`,
    );
  }
}

export async function recordRecoveryProcess(
  runtime: Runtime,
  intent: UpgradeIntent,
  pid: number,
  incarnation: ProcessIncarnation,
): Promise<void> {
  const receipt = intent.completionReceipt;
  if (receipt === null) throw new Error('Committed successor receipt disappeared before process registration.');
  const outcome = await retryUpgradeIntentCas(runtime.paths.coral.coordinator.runDir, (observed) => {
    if (
      observed.kind !== 'readable' ||
      observed.intent.attemptId !== intent.attemptId ||
      observed.intent.completionReceipt?.successor.instanceId !== receipt.successor.instanceId
    ) {
      throw new Error('Committed successor recovery changed before process registration.');
    }
    return {
      kind: 'write',
      expectedRevision: observed.intent.revision,
      change: { ...observed.intent, attemptChild: { attemptId: receipt.attemptId, pid, incarnation } },
      settle: () => undefined,
    };
  });
  if (outcome.kind === 'refused') {
    throw new Error(`Committed successor recovery registration was ${outcome.problem}.`);
  }
  if (outcome.kind === 'exhausted') {
    throw new Error('Committed successor recovery changed throughout process registration.');
  }
}

export async function publishRecoveredServing(
  runtime: Runtime,
  intent: UpgradeIntent,
  instanceId: string,
  pid: number,
  incarnation: ProcessIncarnation,
  generation: SuccessionWriterGeneration,
): Promise<void> {
  const receipt = intent.completionReceipt;
  if (receipt === null) throw new Error('Committed successor receipt disappeared during recovery.');
  const outcome = await retryUpgradeIntentCas(runtime.paths.coral.coordinator.runDir, (observed) => {
    if (
      observed.kind !== 'readable' ||
      observed.intent.attemptId !== receipt.attemptId ||
      observed.intent.completionReceipt?.successor.instanceId !== receipt.successor.instanceId
    ) {
      throw new Error('Committed successor recovery changed before publication.');
    }
    return {
      kind: 'write',
      expectedRevision: observed.intent.revision,
      settle: () => undefined,
      change: {
        ...observed.intent,
        attemptDeadline: null,
        attemptChild: { attemptId: receipt.attemptId, pid, incarnation },
        completionReceipt: {
          ...receipt,
          successor: { instanceId, pid, incarnation, build: observed.intent.target.build },
          controlGeneration: generation.generation,
          acceptedObligations: receipt.acceptedObligations.map((obligation) => ({
            ...obligation,
            controlGeneration: generation.generation,
          })),
          recordedAt: new Date(runtime.time.now()).toISOString(),
        },
      },
    };
  });
  if (outcome.kind === 'refused') throw new Error(`Committed successor recovery receipt was ${outcome.problem}.`);
  if (outcome.kind === 'exhausted') {
    throw new Error('Committed successor recovery receipt changed throughout publication.');
  }
}

/** A supervised legacy successor must match its admitted child before store opening. */
export async function recordSupervisorLegacyChild(
  runtime: Runtime,
  currentBuild: StrictBundleManifest,
  pid: number,
  incarnation: ProcessIncarnation | null,
): Promise<boolean> {
  if (runtime.env.get('CORAL_LAUNCH_PURPOSE') !== 'legacy-retirement') return false;
  if (incarnation === null) throw new SuccessionAttemptStartupHoldError('legacy launch child identity is unavailable');
  const launchId = runtime.env.get('CORAL_LAUNCH_ID');
  const admission =
    launchId === undefined ? null : readLaunchAdmission(runtime.paths.coral.coordinator.runDir, launchId);
  if (
    admission?.kind !== 'readable' ||
    admission.admission.purpose !== 'legacy-retirement' ||
    admission.admission.child.pid !== pid ||
    admission.admission.child.incarnation !== incarnation ||
    admission.admission.build.buildSetId !== currentBuild.buildSetId
  )
    throw new SuccessionAttemptStartupHoldError('legacy launch admission is no longer current');
  return true;
}

export async function completeSupervisorLegacyUpgrade(
  runtime: Runtime,
  currentBuild: StrictBundleManifest,
  openedStore: ResolvedStoreEpoch,
  instanceId: string,
  pid: number,
  incarnation: ProcessIncarnation | null,
): Promise<{ kind: 'not-legacy' } | { kind: 'completed' }> {
  if (!(await recordSupervisorLegacyChild(runtime, currentBuild, pid, incarnation))) return { kind: 'not-legacy' };
  if (incarnation === null) throw new SuccessionAttemptStartupHoldError('legacy launch child identity is unavailable');
  const runDir = runtime.paths.coral.coordinator.runDir;
  const launchId = runtime.env.get('CORAL_LAUNCH_ID');
  const admission = launchId === undefined ? null : readLaunchAdmission(runDir, launchId);
  const observed = readUpgradeIntent(runDir);
  if (
    admission?.kind !== 'readable' ||
    observed.kind !== 'readable' ||
    observed.intent.legacyRetirement !== true ||
    observed.intent.target.build.buildSetId !== currentBuild.buildSetId
  )
    throw new SuccessionAttemptStartupHoldError('legacy launch admission is no longer current');
  const attemptId = admission.admission.launchId;
  const recordedAt = new Date(runtime.time.now()).toISOString();
  const epochKey = encodeResolvedStoreEpoch(runtime, openedStore);
  let generation = observeSuccessionWriterGeneration(runtime);
  if (generation === null) throw new SuccessionAttemptStartupHoldError('legacy writer generation is unavailable');
  let serving: ReturnType<typeof recordSuccessionServing>;
  try {
    const previous = observeCurrentSuccessionServing(runtime);
    if (previous !== null && previous.attemptId !== attemptId) {
      if (observeRecordedDeaths([observed.intent.incumbent]) !== 'absent')
        throw new Error('Previous serving owner is not proven gone after legacy retirement.');
      const writer = joinSuccessionWriterGeneration(runtime, openedStore);
      writer.park();
      generation = generationForLegacySuccessor(runtime, generation, attemptId, previous.attemptId);
      writer.rebind(generation);
      writer.unpark();
    }
    serving = recordSuccessionServing(runtime, generation, {
      attemptId,
      epochKey,
      successorInstanceId: instanceId,
      controlGeneration: generation.generation,
      recordedAt,
    });
  } catch (error: unknown) {
    backendLog.warn(`Legacy upgrade could not record serving: ${formatError(error)}`);
    throw new SuccessionAttemptStartupHoldError('legacy launch has no serving receipt');
  }
  const completion = await compareAndSwapUpgradeIntent(runDir, observed.intent.revision, {
    ...observed.intent,
    attemptId,
    attemptChild: { attemptId, pid, incarnation },
    attemptOwner: { kind: 'incumbent', ...observed.intent.incumbent },
    disposition: 'completed',
    completionReceipt: {
      kind: 'serving',
      attemptId,
      successor: { instanceId, pid, incarnation, build: currentBuild },
      epochKey: serving.epochKey,
      controlGeneration: serving.controlGeneration,
      acceptedObligations: [],
      recordedAt: serving.recordedAt,
    },
  });
  if (completion.kind !== 'written')
    throw new SuccessionAttemptStartupHoldError('legacy launch has no serving receipt');
  return { kind: 'completed' };
}

export type SuccessionStoreContext = Readonly<{
  runtime: Runtime;
  storeFormat: StoreFormatDescription;
  currentBuild: StrictBundleManifest;
  busyTimeoutMs: number;
}>;

export type SuccessionStoreOpen = Readonly<{
  db: Database;
  store: ResolvedStoreEpoch;
  preparation: SuccessionPreparation;
  generation: SuccessionWriterGeneration;
}>;

export async function openCommittedRecoveryStore(
  context: SuccessionStoreContext,
  recovery: Readonly<{ store: ResolvedStoreEpoch; intent: UpgradeIntent }>,
  process: Readonly<{ pid: number; incarnation: () => ProcessIncarnation | null }>,
): Promise<SuccessionStoreOpen & Readonly<{ incarnation: ProcessIncarnation }>> {
  const { runtime } = context;
  const priorGeneration = joinSuccessionWriterGeneration(runtime, recovery.store).generation;
  const priorReceipt = recovery.intent.completionReceipt;
  if (priorReceipt === null || priorGeneration.generation < priorReceipt.controlGeneration) {
    throw new SuccessionAttemptStartupHoldError('committed successor generation changed before recovery');
  }
  const read = readSuccessionWriterGeneration(runtime);
  const reconstructed =
    read.kind === 'recorded' &&
    read.record.reconstructedGeneration === priorGeneration.generation &&
    read.record.priorServings?.some(
      (serving) =>
        serving.attemptId === priorReceipt.attemptId &&
        sameEpoch(serving.epochKey, priorReceipt.epochKey) &&
        serving.successorInstanceId === priorReceipt.successor.instanceId &&
        serving.controlGeneration === priorReceipt.controlGeneration &&
        serving.recordedAt === priorReceipt.recordedAt,
    ) === true;
  if (
    priorGeneration.generation > priorReceipt.controlGeneration &&
    !reconstructed &&
    (recovery.intent.attemptChild?.pid === priorReceipt.successor.pid ||
      recovery.intent.attemptChild === null ||
      recovery.intent.attemptChild === undefined)
  ) {
    throw new SuccessionAttemptStartupHoldError('advanced recovery generation has no recorded process');
  }
  const incarnation = process.incarnation();
  if (incarnation === null) {
    throw new SuccessionAttemptStartupHoldError('recovery process incarnation is unavailable');
  }
  await recordRecoveryProcess(runtime, recovery.intent, process.pid, incarnation);
  const generation = advanceSuccessionWriterGeneration(runtime, priorGeneration, recovery.store);
  const committed = openCommittedBackendStoreAtStartup(
    runtime,
    { storeFormat: context.storeFormat, build: context.currentBuild, startupBusyTimeoutMs: context.busyTimeoutMs },
    recovery.store,
  );
  if (committed.kind === 'holding') throw new SuccessionAttemptStartupHoldError(committed.reason);
  const preparation = successionPreparationSchema.safeParse(recovery.intent.successionPreparation);
  const completionReceipt = recovery.intent.completionReceipt;
  const retirement =
    completionReceipt === null ? null : observeRetirementDisposition(runtime, completionReceipt.attemptId);
  if (
    !preparation.success ||
    completionReceipt === null ||
    preparation.data.attemptId !== completionReceipt.attemptId ||
    (!sameEpoch(preparation.data.epochKey, completionReceipt.epochKey) &&
      (retirement?.kind !== 'recorded' ||
        !sameEpoch(retirement.disposition.incumbentEpochKey, preparation.data.epochKey)))
  ) {
    throw new SuccessionAttemptStartupHoldError('committed recovery has no matching accepted receipts');
  }
  return {
    db: committed.db,
    store: committed.store,
    preparation: preparation.data,
    generation,
    incarnation,
  };
}

export type RetirementCertificatePort = Readonly<{
  certificate(epochKey: string): Readonly<{ revision: number; jobIds: readonly string[] }> | null;
  resultsReleased(epochKey: string): boolean;
}>;

export async function openSuccessionAttemptStore(
  context: SuccessionStoreContext,
  child: SuccessionAttemptChild,
  prepared: Readonly<{ store: ResolvedStoreEpoch; retirement: boolean }>,
  options: Readonly<{
    interposition: SuccessionInterposition;
    retirementCertificate: RetirementCertificatePort;
    onRetiredEpochOpened?: (epoch: ResolvedStoreEpoch, disposition: RetirementDisposition) => void;
  }>,
): Promise<SuccessionStoreOpen> {
  const { runtime } = context;
  await child.waitForWritersParked();
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  const preparation =
    observed.kind === 'readable' ? successionPreparationSchema.safeParse(observed.intent.successionPreparation) : null;
  if (preparation === null || !preparation.success || preparation.data.attemptId !== child.attemptId) {
    throw new SuccessionAttemptStartupHoldError('accepted receipts changed before committed open');
  }
  const priorGeneration = joinSuccessionWriterGeneration(runtime, prepared.store).generation;
  const generation = advanceSuccessionWriterGeneration(runtime, priorGeneration, prepared.store, child.attemptId);
  const interpositionContext = { recovery: child.recovery };
  await options.interposition.at('successor-writer-fence', interpositionContext);
  await options.interposition.at('successor-committed-open', interpositionContext);
  if (!prepared.retirement) {
    const committed = openCommittedBackendStoreAtStartup(
      runtime,
      {
        storeFormat: context.storeFormat,
        build: context.currentBuild,
        startupBusyTimeoutMs: context.busyTimeoutMs,
        deferProductVersionRaise: true,
      },
      prepared.store,
    );
    if (committed.kind === 'holding') throw new SuccessionAttemptStartupHoldError(committed.reason);
    return { db: committed.db, store: committed.store, preparation: preparation.data, generation };
  }
  const recorded = observeRetirementDisposition(runtime, child.attemptId);
  if (recorded.kind !== 'recorded') {
    throw new SuccessionAttemptStartupHoldError(`retirement disposition is ${recorded.kind}`);
  }
  const disposition = recorded.disposition;
  const certificate = options.retirementCertificate.certificate(child.epochKey);
  if (
    !sameEpoch(disposition.incumbentEpochKey, child.epochKey) ||
    disposition.successorFingerprint !== context.currentBuild.storeFormatFingerprint ||
    certificate === null ||
    certificate.revision !== disposition.certificateRevision ||
    JSON.stringify(certificate.jobIds) !== JSON.stringify(disposition.certificateJobIds) ||
    !options.retirementCertificate.resultsReleased(child.epochKey)
  ) {
    throw new SuccessionAttemptStartupHoldError('retirement disposition or historical certificate changed');
  }
  await options.interposition.at('successor-retirement-mint', interpositionContext);
  const minted = await mintRetiredStoreEpoch(
    runtime,
    { storeFormat: context.storeFormat, build: context.currentBuild, startupBusyTimeoutMs: context.busyTimeoutMs },
    disposition.incumbentEpochKey,
    child.attemptId,
    generation,
    () => options.interposition.at('successor-retirement-generation', interpositionContext),
  );
  const oldEpoch = decodeResolvedStoreEpoch(runtime, disposition.incumbentEpochKey);
  if (oldEpoch === undefined) throw new SuccessionAttemptStartupHoldError('retiring epoch address changed');
  options.onRetiredEpochOpened?.(oldEpoch, disposition);
  return { db: minted.db, store: minted.store, preparation: preparation.data, generation: minted.generation };
}

export type SuccessionServingPublication = Readonly<{
  instanceId: string;
  recordControllerReceipts?: (
    preparation: SuccessionPreparation,
    epochKey: string,
    generation: number,
    recordedAt: string,
  ) => void;
  publishDiscovery: () => void;
}>;

/**
 * The attempt child's commit point. Nothing it admits may precede the durable serving record, and the
 * incumbent is released by that record, never by the acknowledgment sent after it.
 */
export async function publishAttemptServing(
  runtime: Runtime,
  child: SuccessionAttemptChild,
  opened: Readonly<{ db: Database; store: ResolvedStoreEpoch; generation: SuccessionWriterGeneration }>,
  preparation: SuccessionPreparation | null,
  options: SuccessionServingPublication &
    Readonly<{
      listener: IpcListener;
      productVersion: string;
      signal: AbortSignal;
      interposition: SuccessionInterposition;
      onStoreServing?: (attemptId: string, epochKey: string, instanceId: string, controlGeneration: number) => void;
      onServing?: (attemptId: string) => Promise<void>;
    }>,
): Promise<void> {
  const intentAtCommit = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  if (
    intentAtCommit.kind !== 'readable' ||
    intentAtCommit.intent.attemptId !== child.attemptId ||
    intentAtCommit.intent.attemptDeadline === null ||
    Date.parse(intentAtCommit.intent.attemptDeadline) <= runtime.time.now()
  ) {
    throw new SuccessionAttemptStartupHoldError('succession commit deadline or intent changed');
  }
  await options.interposition.at('successor-before-serving', { recovery: child.recovery });
  options.signal.throwIfAborted();
  // The serving record carries the instant this check passed: a completion receipt may never postdate the deadline.
  const servingAt = runtime.time.now();
  if (Date.parse(intentAtCommit.intent.attemptDeadline) <= servingAt) {
    throw new SuccessionAttemptStartupHoldError('succession commit deadline expired');
  }
  if (
    preparation?.receipts.some((receipt) => receipt.owner === 'durable-cli') === true &&
    options.recordControllerReceipts === undefined
  ) {
    throw new SuccessionAttemptStartupHoldError('durable-cli controller receipt writer is unavailable');
  }
  const committed = recordSuccessionServing(runtime, opened.generation, {
    attemptId: child.attemptId,
    epochKey: encodeResolvedStoreEpoch(runtime, opened.store),
    successorInstanceId: options.instanceId,
    controlGeneration: opened.generation.generation,
    recordedAt: new Date(servingAt).toISOString(),
  });
  raiseStoredProductVersion(opened.db, options.productVersion);
  options.onStoreServing?.(
    committed.attemptId,
    committed.epochKey,
    committed.successorInstanceId,
    committed.controlGeneration,
  );
  if (preparation !== null) {
    options.recordControllerReceipts?.(
      preparation,
      committed.epochKey,
      committed.controlGeneration,
      committed.recordedAt,
    );
  }
  child.markServing(options.listener, committed);
  options.publishDiscovery();
  await options.onServing?.(child.attemptId);
  await Promise.resolve()
    .then(() => options.interposition.at('successor-serving-acknowledgment', { recovery: child.recovery }))
    .then(() =>
      child.acknowledge({
        kind: 'serving',
        epochKey: committed.epochKey,
        controlGeneration: committed.controlGeneration,
        successorInstanceId: committed.successorInstanceId,
      }),
    )
    .catch(() => {});
}

export async function publishCommittedRecoveryServing(
  runtime: Runtime,
  recovery: Readonly<{ intent: UpgradeIntent }>,
  opened: Readonly<{ generation: SuccessionWriterGeneration; incarnation: ProcessIncarnation }>,
  preparation: SuccessionPreparation | null,
  options: Omit<SuccessionServingPublication, 'publishDiscovery'> & Readonly<{ pid: number }>,
): Promise<void> {
  const receipt = recovery.intent.completionReceipt;
  if (receipt === null) throw new Error('Committed successor recovery lost its receipt.');
  const recoveredServing = recordSuccessionServing(runtime, opened.generation, {
    attemptId: receipt.attemptId,
    epochKey: receipt.epochKey,
    successorInstanceId: options.instanceId,
    controlGeneration: opened.generation.generation,
    recordedAt: new Date(runtime.time.now()).toISOString(),
  });
  if (preparation !== null) {
    options.recordControllerReceipts?.(
      preparation,
      recoveredServing.epochKey,
      recoveredServing.controlGeneration,
      recoveredServing.recordedAt,
    );
  }
  await publishRecoveredServing(
    runtime,
    recovery.intent,
    options.instanceId,
    options.pid,
    opened.incarnation,
    opened.generation,
  );
  clearStartupPatience(runtime, receipt.attemptId);
}
