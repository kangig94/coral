import { dirname, join } from 'node:path';
import { z } from 'zod';

import { backendLog } from '../../infra/backend-log.js';
import { resolveRunningBundleDir, type StrictBundleManifest } from '../../infra/bundle-manifest.js';
import { verifyChildPrincipalRecoveryGrant } from '../../infra/child-principal-nonce-ledger.js';
import { formatError } from '../../infra/error-format.js';
import { inspectValidatedHandoffTarget, type ValidatedHandoffTarget } from '../../infra/handoff-target.js';
import {
  createRecordedProcessObserver,
  observeProcessLiveness,
  probeProcessIncarnation,
  type ProcessIncarnation,
  type ProcessLiveness,
} from '../../infra/node-process.js';
import { retainedBuildRoot } from '../../infra/retained-build-root.js';
import {
  readUpgradeIntent,
  retryUpgradeIntentCas,
  revalidateUpgradeIntentTarget,
  type UpgradeIntent,
} from '../../infra/upgrade-intent.js';
import type { Runtime } from '../../runtime/ports.js';
import { readCustodyLedger } from '../../store/custody-ledger.js';
import { raiseStoredProductVersion, type Database } from '../../store/db.js';
import {
  decodeResolvedStoreEpoch,
  encodeResolvedStoreEpoch,
  inspectCurrentStore,
  mintRetiredStoreEpoch,
  observeResolvedStoreEpoch,
  observeResolvedStoreEpochKey,
  type ResolvedStoreEpoch,
} from '../../store/epoch.js';
import type { StoreFormatDescription } from '../../store/format-fingerprint.js';
import {
  openCommittedBackendStoreAtStartup,
  prepareCommittedBackendStoreAtStartup,
} from '../../store/startup-store-routing.js';
import {
  advanceSuccessionWriterGeneration,
  handbackSuccessionWriterGeneration,
  joinSuccessionWriterGeneration,
  observeSuccessionServing,
  observeSuccessionWriterGeneration,
  recordSuccessionServing,
  type SuccessionWriterGeneration,
} from '../../store/succession-writer-generation.js';
import { decodeChildPrincipalTransfer } from '../child-principal-registry.js';
import { decodeDurableCliTransfer, verifyDurableCliRecoveryGrant } from '../services/durable-cli-transfer.js';
import type { IpcListener } from '../../transport/ipc/server.js';
import type { SuccessionAttemptChild } from './attempt-child.js';
import type { SuccessionInterposition } from './interposition.js';
import {
  PROVIDER_OPERATIONS_OWNER,
  PROVIDER_PROXY_SETS_OWNER,
  providerHostRecoveryGrantVerifies,
} from './provider-host-transfer.js';
import { readSuccessionCapabilities, successionPreparationSchema, type SuccessionPreparation } from './protocol.js';
import { observeRetirementDisposition, type RetirementDisposition } from './retirement-disposition.js';

/** Startups a hold on an incomplete attempt may span before the attempt is abandoned for ordinary startup. */
const SUCCESSION_STARTUP_PATIENCE = 3;

export class SuccessionAttemptStartupHoldError extends Error {
  readonly hold: SuccessionStartupHold | null;

  constructor(reason: string, hold: SuccessionStartupHold | null = null) {
    super(`Succession attempt startup holds: ${reason}`);
    this.name = 'SuccessionAttemptStartupHoldError';
    this.hold = hold;
  }
}

/**
 * Why a startup could not resolve an incomplete succession attempt. Each disposition is distinct: an
 * unreadable record can never become decisive by waiting, while unproven deaths may, and a positively
 * observed live owner ends only when that process exits.
 */
export type SuccessionStartupHold =
  | Readonly<{ kind: 'attempt-record-unreadable'; attemptId: string }>
  | Readonly<{ kind: 'deaths-unproven'; attemptId: string; alive: boolean }>
  | Readonly<{ kind: 'recovery-grants-unverified'; attemptId: string }>
  | Readonly<{ kind: 'grant-controller-unavailable'; attemptId: string }>;

export function startupHoldError(hold: SuccessionStartupHold): SuccessionAttemptStartupHoldError {
  return new SuccessionAttemptStartupHoldError(describeStartupHold(hold), hold);
}

function describeStartupHold(hold: SuccessionStartupHold): string {
  switch (hold.kind) {
    case 'attempt-record-unreadable':
      return 'incomplete attempt record is unreadable';
    case 'deaths-unproven':
      return hold.alive ? 'a process of the attempt is still alive' : 'attempt process deaths are unproven';
    case 'recovery-grants-unverified':
      return 'unserved transferred obligations lack recovery grants';
    case 'grant-controller-unavailable':
      return 'grant-authorized old controller is unavailable';
  }
}

/** Every recorded process is absent, any is alive, or else the answer is unknown. */
function observeRecordedDeaths(
  recorded: readonly Readonly<{ pid: number; incarnation: ProcessIncarnation | null }>[],
): ProcessLiveness {
  const observations = recorded.map(observeRecordedDeath);
  if (observations.includes('alive')) return 'alive';
  return observations.includes('unknown') ? 'unknown' : 'absent';
}

/** A record carrying no incarnation cannot tell its process from a reuse of its pid, so `alive` is unknown. */
function observeRecordedDeath(
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
  })
  .passthrough();

/**
 * Counts the startups a hold on `hold.attemptId` has spanned; true once patience is exhausted. A startup
 * repeated within one process counts once. A live owner is never counted: its exit is what ends that hold.
 */
async function exhaustStartupPatience(
  runtime: Runtime,
  startupId: string,
  hold: SuccessionStartupHold,
  intent: UpgradeIntent | null,
): Promise<boolean> {
  if (hold.kind === 'deaths-unproven' && hold.alive) return false;
  const path = join(
    runtime.paths.coral.coordinator.runDir,
    'succession-startup-patience.v1',
    `${runtime.ids.sha256(hold.attemptId)}.json`,
  );
  let previous: z.infer<typeof startupPatienceSchema> | null = null;
  try {
    const parsed = startupPatienceSchema.safeParse(JSON.parse(runtime.storage.readFileSync(path, 'utf-8')) as unknown);
    if (parsed.success && parsed.data.attemptId === hold.attemptId) previous = parsed.data;
  } catch {
    // An absent or unreadable record starts the count; it can only delay abandonment, never cause it.
  }
  const startups = previous?.startupId === startupId ? previous.startups : (previous?.startups ?? 0) + 1;
  runtime.storage.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record = { version: 'v1', attemptId: hold.attemptId, startupId, startups };
  if (!runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })) {
    throw new SuccessionAttemptStartupHoldError(`${describeStartupHold(hold)}; patience could not be recorded`, hold);
  }
  const exhausted = startups >= SUCCESSION_STARTUP_PATIENCE;
  if (intent !== null) await recordStartupHold(runtime, intent, hold, startups, exhausted);
  return exhausted;
}

/** The hold and its patience are durable status on the intent; abandonment also releases the attempt. */
async function recordStartupHold(
  runtime: Runtime,
  intent: UpgradeIntent,
  hold: SuccessionStartupHold,
  startups: number,
  exhausted: boolean,
): Promise<void> {
  const reason = exhausted
    ? `abandoned after ${startups} startups: ${describeStartupHold(hold)}`
    : `${describeStartupHold(hold)} (startup ${startups} of ${SUCCESSION_STARTUP_PATIENCE})`;
  const outcome = await retryUpgradeIntentCas(runtime.paths.coral.coordinator.runDir, (observed) => {
    if (observed.kind !== 'readable' || observed.intent.attemptId !== intent.attemptId) {
      return { kind: 'settle', value: undefined };
    }
    const blocker = { owner: 'succession-startup', reason };
    return {
      kind: 'write',
      expectedRevision: observed.intent.revision,
      change: exhausted
        ? {
            ...observed.intent,
            disposition: 'deferred',
            attemptId: null,
            attemptChild: null,
            attemptOwner: null,
            attemptDeadline: null,
            recoveryAttemptId: null,
            recoveryBuildSetId: null,
            successionPreparation: null,
            blockers: [blocker],
            retryCondition: { kind: 'target-change', evidence: 'abandoned incomplete succession attempt' },
          }
        : {
            ...observed.intent,
            blockers: [...observed.intent.blockers.filter((entry) => entry.owner !== blocker.owner), blocker],
          },
      settle: () => undefined,
    };
  });
  if (outcome.kind !== 'settled' && exhausted) {
    throw new SuccessionAttemptStartupHoldError(
      `${describeStartupHold(hold)}; abandonment could not be recorded`,
      hold,
    );
  }
}

export type DeadAttemptRecovery = Readonly<{ epochKey: string; force: boolean; discardAttemptId?: string }>;

export type IncompleteSuccessionResolution =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'recover'; attempt: DeadAttemptRecovery; preferredEpochKey: string | null }>
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
      if (receipt.owner === 'child-principals') {
        const transfer = decodeChildPrincipalTransfer(receipt.payload);
        return (
          transfer !== null &&
          transfer.recoveryGrantId === receipt.recoveryGrantId &&
          verifyChildPrincipalRecoveryGrant(
            runtime.storage,
            runtime.paths.coral.coordinator.runDir,
            attemptId,
            receipt.recoveryGrantId,
            transfer.authorityGeneration,
            transfer.consumedNonceCheckpoint,
          )
        );
      }
      return false;
    })
  );
}

/**
 * With no incumbent serving, an incomplete attempt takes precedence over ordinary store selection. Every hold
 * here is bounded: a startup that cannot resolve the attempt holds, and once patience is exhausted the attempt
 * is abandoned so ordinary startup reaches service.
 */
export async function resolveIncompleteSuccessionAtStartup(
  options: IncompleteSuccessionOptions,
): Promise<IncompleteSuccessionResolution> {
  const { runtime } = options;
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  if (observed.kind !== 'readable') return { kind: 'none' };
  const intent = observed.intent;
  const holdOrAbandon = async (hold: SuccessionStartupHold): Promise<IncompleteSuccessionResolution> => {
    if (!(await exhaustStartupPatience(runtime, options.startupId, hold, intent))) return { kind: 'hold', hold };
    backendLog.warn(`Abandoned an incomplete succession attempt for ordinary startup: ${describeStartupHold(hold)}`);
    return { kind: 'none' };
  };
  const deathsUnproven = (
    attemptId: string,
    processes: readonly Readonly<{ pid: number; incarnation: ProcessIncarnation | null }>[],
  ): SuccessionStartupHold | null => {
    const deaths = observeRecordedDeaths(processes);
    return deaths === 'absent' ? null : { kind: 'deaths-unproven', attemptId, alive: deaths === 'alive' };
  };

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
    const unproven = deathsUnproven(
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
      attempt: { epochKey: preparation.data.epochKey, force: preparation.data.receipts.length > 0 },
      preferredEpochKey: preparation.data.epochKey,
    };
  }

  // A waiter-owned attempt carries no receipts or grants; the target's own startup decides it.
  const attemptId = intent.attemptId;
  if (
    intent.disposition !== 'attempting' ||
    intent.attemptOwner?.kind !== 'incumbent' ||
    attemptId === null ||
    observeSuccessionServing(runtime, attemptId) !== null
  ) {
    return { kind: 'none' };
  }
  const preparation = successionPreparationSchema.safeParse(intent.successionPreparation);
  const owner = intent.attemptOwner;
  const child = intent.attemptChild;
  if (!preparation.success || child === undefined || child === null) {
    return holdOrAbandon({ kind: 'attempt-record-unreadable', attemptId });
  }
  const unproven = deathsUnproven(attemptId, [owner, child]);
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
    recovery = { epochKey: preparation.data.epochKey, force: true };
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
    recovery = { epochKey: preparation.data.epochKey, force: recovery?.force ?? false, discardAttemptId: attemptId };
  }
  return recovery === null ? { kind: 'none' } : { kind: 'recover', attempt: recovery, preferredEpochKey };
}

export function handBackDeadAttemptGeneration(runtime: Runtime, epochKey: string, force = false): void {
  const oldEpoch = decodeResolvedStoreEpoch(runtime, epochKey);
  const generation = observeSuccessionWriterGeneration(runtime);
  if (oldEpoch === undefined || generation === null) return;
  const storeRoot = oldEpoch.canonicalStoreRoot ?? oldEpoch.storeRoot;
  if (generation.storeRoot !== storeRoot) {
    throw new SuccessionAttemptStartupHoldError('unserved writer generation belongs to another store root');
  }
  if (generation.epoch === oldEpoch.epoch && !force) return;
  if (generation.epoch !== oldEpoch.epoch && BigInt(generation.epoch) !== BigInt(oldEpoch.epoch) + 1n) {
    throw new SuccessionAttemptStartupHoldError('unserved writer generation is not the retiring successor');
  }
  handbackSuccessionWriterGeneration(runtime, generation, { storeRoot, epoch: oldEpoch.epoch });
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
      preparation.data.epochKey !== child.epochKey ||
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
    preparation.data.epochKey !== child.epochKey ||
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
        (entry.intent.epochKey === epoch.lineageKey || entry.intent.epoch === dirname(epoch.path))),
  );
}

export type CommittedSuccessorRecovery =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'recover'; store: ResolvedStoreEpoch; intent: UpgradeIntent }>
  | Readonly<{ kind: 'handoff'; target: ValidatedHandoffTarget }>
  | Readonly<{ kind: 'hold'; hold: SuccessionStartupHold }>;

export async function prepareCommittedSuccessorRecovery(
  runtime: Runtime,
  identity: Readonly<{ pluginRoot: string; instanceId: string }>,
  storeFormat: StoreFormatDescription,
  currentBuild: StrictBundleManifest,
  epochHasLiveJobs: (epochKey: string) => boolean,
): Promise<CommittedSuccessorRecovery> {
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  if (observed.kind !== 'readable' || observed.intent.disposition !== 'completed') return { kind: 'none' };
  const intent = observed.intent;
  const receipt = intent.completionReceipt;
  if (receipt === null) return { kind: 'none' };
  const current = inspectCurrentStore(runtime);
  if (current.kind !== 'current' || observeResolvedStoreEpochKey(runtime, current.epoch) !== receipt.epochKey)
    return { kind: 'none' };
  const serving = observeSuccessionServing(runtime, receipt.attemptId);
  const writer = observeSuccessionWriterGeneration(runtime);
  if (
    writer === null ||
    writer.generation < receipt.controlGeneration ||
    (writer.generation === receipt.controlGeneration && serving === null) ||
    (serving !== null &&
      (serving.epochKey !== receipt.epochKey || serving.controlGeneration < receipt.controlGeneration))
  ) {
    throw new SuccessionAttemptStartupHoldError('committed successor generation cannot be attributed');
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
    const hold: SuccessionStartupHold = {
      kind: 'deaths-unproven',
      attemptId: receipt.attemptId,
      alive: deaths === 'alive',
    };
    // A completed intent is not rewritten: exhausted patience leaves the committed successor's work to
    // ordinary startup instead of holding every boot on a death nothing can prove.
    return (await exhaustStartupPatience(runtime, identity.instanceId, hold, null))
      ? { kind: 'none' }
      : { kind: 'hold', hold };
  }
  if (
    serving !== null &&
    serving.controlGeneration === receipt.controlGeneration &&
    serving.successorInstanceId !== receipt.successor.instanceId
  ) {
    throw new SuccessionAttemptStartupHoldError('committed successor identity does not match its writer');
  }
  const runsTargetBuild =
    intent.target.build.buildSetId === currentBuild.buildSetId &&
    intent.target.build.bundleHash === currentBuild.bundleHash;
  if (!runsTargetBuild && !committedSuccessorMayControlWork(runtime, receipt.epochKey, epochHasLiveJobs))
    return { kind: 'none' };
  // A committed successor controls live work, so its own retained root stands in for an uninstalled one.
  const installed = revalidateUpgradeIntentTarget(intent);
  const targetRoot =
    installed.kind === 'validated'
      ? intent.target.pluginRootLabel
      : retainedBuildRoot(runtime, intent.target.build.buildSetId);
  const target = installed.kind === 'validated' ? installed : revalidateUpgradeIntentTarget(intent, targetRoot);
  if (target.kind !== 'validated') {
    throw new SuccessionAttemptStartupHoldError('committed successor build no longer validates');
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
  if (prepared.kind === 'holding') throw new SuccessionAttemptStartupHoldError(prepared.reason);
  return { kind: 'recover', store: prepared.store, intent };
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

/**
 * A waiter launches its target without a gate of its own, so the target that reaches serving under the
 * waiter's attempt id is the only process that can prove completion. A refusal leaves the intent to the
 * waiter's attempt deadline.
 */
export async function completeWaiterLaunchedUpgrade(
  runtime: Runtime,
  currentBuild: StrictBundleManifest,
  openedStore: ResolvedStoreEpoch,
  instanceId: string,
  pid: number,
  incarnation: ProcessIncarnation | null,
): Promise<void> {
  const attemptId = runtime.env.get('CORAL_STARTUP_ATTEMPT_ID');
  if (attemptId === undefined || incarnation === null) return;
  const unchanged = { kind: 'settle', value: undefined } as const;
  void (await retryUpgradeIntentCas(runtime.paths.coral.coordinator.runDir, (observed) => {
    if (observed.kind !== 'readable') return unchanged;
    const intent = observed.intent;
    if (
      intent.disposition !== 'attempting' ||
      intent.attemptId !== attemptId ||
      intent.attemptOwner?.kind !== 'waiter' ||
      intent.target.build.buildSetId !== currentBuild.buildSetId ||
      intent.target.build.bundleHash !== currentBuild.bundleHash
    ) {
      return unchanged;
    }
    const generation = observeSuccessionWriterGeneration(runtime);
    if (generation === null) return unchanged;
    let serving: ReturnType<typeof recordSuccessionServing>;
    try {
      serving = recordSuccessionServing(runtime, generation, {
        attemptId,
        epochKey: encodeResolvedStoreEpoch(runtime, openedStore),
        successorInstanceId: instanceId,
        controlGeneration: generation.generation,
        recordedAt: new Date(runtime.time.now()).toISOString(),
      });
    } catch (error: unknown) {
      backendLog.warn(`Waiter-launched upgrade could not record serving: ${formatError(error)}`);
      return unchanged;
    }
    return {
      kind: 'write',
      expectedRevision: intent.revision,
      change: {
        ...intent,
        disposition: 'completed',
        attemptChild: { attemptId, pid, incarnation },
        completionReceipt: {
          kind: 'serving',
          attemptId,
          successor: { instanceId, pid, incarnation, build: intent.target.build },
          epochKey: serving.epochKey,
          controlGeneration: serving.controlGeneration,
          acceptedObligations: [],
          recordedAt: serving.recordedAt,
        },
      },
      settle: () => undefined,
    };
  }));
}

/** What a succession startup needs to open or mint its committed store. */
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

/** Reopens a dead committed successor's exact epoch under a fresh generation this recovery process owns. */
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
  if (
    priorGeneration.generation > priorReceipt.controlGeneration &&
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
    (preparation.data.epochKey !== completionReceipt.epochKey &&
      (retirement?.kind !== 'recorded' || retirement.disposition.incumbentEpochKey !== preparation.data.epochKey))
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

/** The historical-job evidence a retirement disposition was certified against. */
export type RetirementCertificatePort = Readonly<{
  certificate(epochKey: string): Readonly<{ revision: number; jobIds: readonly string[] }> | null;
  resultsReleased(epochKey: string): boolean;
}>;

/**
 * Takes the incumbent's parked epoch as the attempt child: advances the writer generation, then opens that
 * exact epoch, or mints its successor only under the incumbent's recorded retirement disposition.
 */
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
  const generation = advanceSuccessionWriterGeneration(runtime, priorGeneration, prepared.store);
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
    disposition.incumbentEpochKey !== child.epochKey ||
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
  /** Receives every accepted receipt's new controller once serving is durable. */
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
  if (Date.parse(intentAtCommit.intent.attemptDeadline) <= runtime.time.now()) {
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
    recordedAt: new Date(runtime.time.now()).toISOString(),
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

/** Records this recovery process as the committed successor's serving controller under its fresh generation. */
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
}
