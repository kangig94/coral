import { join } from 'node:path';

import type { TimerHandle } from '../../infra/port-types.js';
import type { Runtime } from '../../runtime/ports.js';
import { SUCCESSION_CAPABILITY_VERSION } from '../../infra/bundle-manifest-address.js';
import { SUCCESSION_PROTOCOL_VERSION } from '../../infra/succession-address.js';
import {
  quarantineCorruptUpgradeIntent,
  readUpgradeIntent,
  retryUpgradeIntentCas,
  revalidateUpgradeIntentTarget,
  type UpgradeIntent,
  type UpgradeIntentCasStep,
  type UpgradeIntentChange,
  type UpgradeIntentRead,
} from '../../infra/upgrade-intent.js';
import {
  readSuccessionCapabilities,
  successionPreparationSchema,
  successionTargetKey,
  type SuccessionCapabilities,
  type SuccessionPreparation,
  type SuccessionReady,
} from './protocol.js';
import type { UnservedMintDiscard } from '../../store/epoch.js';
import { attemptRetryAtMs, failedAttemptRetry, recoveryRetryOf } from './attempt-retry.js';
import {
  REQUIRED_SUCCESSION_OWNERS,
  prepareOwnerObligations,
  recertifyUntransferableOwners,
  type SuccessionOwner,
  type SuccessionOwnerId,
} from './obligations.js';
import { observeRecordedDeath } from './startup.js';
import { createSuccessionReconciliationScheduler } from './reconciliation-scheduler.js';
import {
  createIntentTransitionRequests,
  classifyTargetCustody,
  settle,
  decisionOf,
  requestedIntent,
  incumbentKey,
  recordsSelf,
  committing,
  endedUnder,
  holdsRecovery,
  namedAttempts,
  LAUNCH_IN_FLIGHT,
  RECOVERY_HOLDS_INTENT,
  ADOPTION_BLOCKER_OWNER,
  withoutAdoptionBlocker,
  TARGET_CHANGE_HOLD_OWNERS,
  outranks,
} from './intent-transitions.js';

type IncumbentIdentity = UpgradeIntent['incumbent'];
type Target = UpgradeIntent['target'];
type TargetRequest = Readonly<{ requestId: string; target: Target }>;

export type SuccessionReconcilerOptions = Readonly<{
  runtime: Pick<Runtime, 'time' | 'ids' | 'storage'>;
  runDir: string;
  /** Every intent write of this process’s identity must use one source so a late incarnation cannot appear foreign. */
  incumbent: () => IncumbentIdentity;
  runningBuildSetId?: string;
  owners: readonly SuccessionOwner[];
  requiredOwners?: readonly SuccessionOwnerId[];
  liveJobIds?: () => readonly string[];
  storeFormatFingerprint?: string;
  epochKey: () => string | null;
  admissionRevision: () => number;
  newAttemptId?: () => string;
  observeServing?: (attemptId: string) => Readonly<{
    epochKey: string;
    controlGeneration: number;
    successorInstanceId: string;
    recordedAt: string;
  }> | null;
  retirementServing?: (attemptId: string, incumbentEpochKey: string) => boolean;
  onIntentChanged?: () => void;
  onReconcileError?: (error: unknown) => void;
  commitAvailable?: boolean;
  subscribeObligationChanges?: (notify: () => void) => () => void;
  launchPrepared?: (intent: UpgradeIntent, preparation: SuccessionPreparation) => Promise<SuccessionLaunch>;
  discardUnservedMint?: (incumbentEpochKey: string, attemptId: string) => UnservedMintDiscard;
  retryIntervalMs?: number;
}>;

/**
 * `clear-owed` must persist until the write clearing the attempt lands; otherwise the intent claims an
 * unsupervised commit.
 */
export type SuccessionLaunchSettlement =
  | Readonly<{ kind: 'settled' }>
  | Readonly<{ kind: 'clear-owed'; attemptId: string; clear: (intent: UpgradeIntent) => UpgradeIntent }>;

/** A launched attempt belongs to its commit until `settled`; nothing may prepare over or abort it before then. */
export type SuccessionLaunch = Readonly<{ settled: Promise<SuccessionLaunchSettlement> }>;

export type SuccessionDecision =
  | Readonly<{ kind: 'registered'; intent: UpgradeIntent }>
  | Readonly<{ kind: 'prepared'; preparation: SuccessionPreparation }>
  | Readonly<{ kind: 'ready'; preparation: SuccessionPreparation }>
  | Readonly<{ kind: 'committed'; receipt: NonNullable<UpgradeIntent['completionReceipt']> }>
  | Readonly<{ kind: 'deferred'; reason: string; blockers?: readonly { owner: string; reason: string }[] }>
  | Readonly<{ kind: 'refused'; reason: string }>
  | Readonly<{ kind: 'stale'; reason: string; cause: 'target-change' | 'obligation-change' }>
  | Readonly<{ kind: 'aborted' }>;

export type SuccessionStatus =
  | Readonly<{ kind: 'readable'; intent: UpgradeIntent; preparation: SuccessionPreparation | null }>
  | Readonly<{ kind: 'absent' | 'unreadable' | 'corrupt' | 'unsupported' }>;

export type SuccessionReconciler = Readonly<{
  incumbent: () => IncumbentIdentity;
  request: (input: { requestId: string; target: Target }) => Promise<SuccessionDecision>;
  repairSupervision: (input: { requestId: string; target: Target }) => Promise<SuccessionDecision>;
  prepare: (requestId: string) => Promise<SuccessionDecision>;
  reportReady: (report: SuccessionReady) => Promise<SuccessionDecision>;
  commit: (attemptId: string) => Promise<SuccessionDecision>;
  /** `prepared` only while every owner the target cannot accept still completes for the prepared attempt. */
  recertify: (attemptId: string) => Promise<SuccessionDecision>;
  abort: (attemptId: string) => Promise<SuccessionDecision>;
  status: (requestId?: string) => SuccessionStatus;
  reconcile: () => Promise<SuccessionDecision>;
  notifyObligationChange: () => void;
  dispose: () => void;
}>;

function readPreparation(intent: UpgradeIntent): SuccessionPreparation | null {
  const parsed = successionPreparationSchema.safeParse(intent.successionPreparation);
  if (!parsed.success) return null;
  const preparation = parsed.data;
  const grantAttemptId =
    intent.recoveryAttemptId === preparation.attemptId && intent.recoveryBuildSetId !== null
      ? intent.recoveryGrantAttemptId
      : preparation.attemptId;
  if (
    preparation.requestId !== intent.requestId ||
    preparation.attemptId !== intent.attemptId ||
    preparation.receipts.some(
      (receipt) =>
        receipt.attemptId !== grantAttemptId ||
        !preparation.accepts.some((entry) => entry.owner === receipt.owner && entry.generation === receipt.generation),
    ) ||
    new Set(preparation.receipts.map((receipt) => receipt.owner)).size !== preparation.receipts.length ||
    new Set(preparation.receipts.map((receipt) => receipt.receiptId)).size !== preparation.receipts.length
  ) {
    return null;
  }
  if (preparation.stage === 'prepared' && preparation.ready !== null) return null;
  if (
    preparation.stage !== 'prepared' &&
    (preparation.ready === null ||
      preparation.ready.attemptId !== preparation.attemptId ||
      preparation.ready.targetKey !== preparation.targetKey ||
      preparation.ready.epochKey !== preparation.epochKey ||
      preparation.ready.admissionRevision !== preparation.admissionRevision ||
      JSON.stringify([...preparation.ready.receiptIds].sort()) !==
        JSON.stringify(preparation.receipts.map((receipt) => receipt.receiptId).sort()))
  )
    return null;
  return preparation;
}

function currentPreparation(
  intent: UpgradeIntent,
  preparation: SuccessionPreparation,
  options: SuccessionReconcilerOptions,
): boolean {
  if (revalidateUpgradeIntentTarget(intent).kind !== 'validated') return false;
  const declaration = readSuccessionCapabilities(
    options.runtime,
    join(intent.target.pluginRootLabel, 'bridge'),
    intent.target.build,
  );
  if (declaration.kind === 'invalid') return false;
  const capabilities = declaration.kind === 'declared' ? declaration.capabilities : emptyCapabilities(intent);
  const self = options.incumbent();
  return (
    preparation.incumbentInstanceId === self.instanceId &&
    preparation.incumbentPid === self.pid &&
    recordsSelf(intent.incumbent, self) &&
    preparation.incumbentKey === incumbentKey(intent.incumbent) &&
    preparation.targetKey === successionTargetKey(intent.target) &&
    preparation.capabilitiesKey === JSON.stringify(capabilities) &&
    preparation.epochKey === options.epochKey() &&
    preparation.admissionRevision === options.admissionRevision()
  );
}

function staleCause(
  intent: UpgradeIntent,
  preparation: SuccessionPreparation,
  options: SuccessionReconcilerOptions,
): 'target-change' | 'obligation-change' {
  const declared = readSuccessionCapabilities(
    options.runtime,
    join(intent.target.pluginRootLabel, 'bridge'),
    intent.target.build,
  );
  const targetChanged =
    preparation.targetKey !== successionTargetKey(intent.target) ||
    revalidateUpgradeIntentTarget(intent).kind !== 'validated' ||
    declared.kind === 'invalid' ||
    preparation.capabilitiesKey !==
      JSON.stringify(declared.kind === 'declared' ? declared.capabilities : emptyCapabilities(intent));
  return targetChanged ? 'target-change' : 'obligation-change';
}

function emptyCapabilities(intent: UpgradeIntent): SuccessionCapabilities {
  return {
    version: SUCCESSION_CAPABILITY_VERSION,
    buildSetId: intent.target.build.buildSetId,
    bundleHash: intent.target.build.bundleHash,
    protocols: [],
    accepts: [],
  };
}

/** Preparation cannot release an owner until its receipt and recovery grant are durably bound to the attempt. */
async function prepareObservedIntent({
  options,
  requestId,
  heldAttempts,
  observed,
  commit,
  getLaunchedAttempt,
  writeThen,
  attemptFor,
  preparingAttempts,
  clearPendingAttempt,
}: {
  options: SuccessionReconcilerOptions;
  requestId: string;
  heldAttempts: Set<string>;
  observed: UpgradeIntentRead;
  commit: (attemptId: string) => Promise<SuccessionDecision>;
  getLaunchedAttempt: () => string | null;
  writeThen: (
    intent: UpgradeIntent,
    change: UpgradeIntentChange,
    decision: SuccessionDecision,
  ) => UpgradeIntentCasStep<SuccessionDecision>;
  attemptFor: (intent: UpgradeIntent) => string;
  preparingAttempts: Map<string, number>;
  clearPendingAttempt: () => void;
}): Promise<UpgradeIntentCasStep<SuccessionDecision>> {
  if (observed.kind !== 'readable') return settle({ kind: 'refused', reason: `upgrade intent is ${observed.kind}` });
  const intent = observed.intent;
  if (intent.requestId !== requestId || intent.disposition === 'closed' || intent.disposition === 'completed') {
    return settle({ kind: 'refused', reason: 'upgrade request is no longer pending' });
  }
  const self = options.incumbent();
  if (!recordsSelf(intent.incumbent, self)) {
    return settle({ kind: 'refused', reason: 'incumbent identity changed' });
  }
  if (intent.attemptId !== null && (options.observeServing?.(intent.attemptId) ?? null) !== null) {
    return settle(await commit(intent.attemptId));
  }
  if (committing(intent)) return settle({ kind: 'deferred', reason: 'succession attempt is committing' });
  if (intent.attemptId !== null && intent.attemptId === getLaunchedAttempt())
    return settle({ kind: 'deferred', reason: LAUNCH_IN_FLIGHT });
  if (holdsRecovery(intent)) return settle({ kind: 'refused', reason: RECOVERY_HOLDS_INTENT });
  const custody = classifyTargetCustody(intent, options);
  const declared =
    custody.kind === 'validated-target'
      ? readSuccessionCapabilities(options.runtime, join(intent.target.pluginRootLabel, 'bridge'), intent.target.build)
      : null;
  const targetFailure =
    custody.kind === 'invalid-target'
      ? 'target build no longer validates'
      : declared?.kind === 'invalid'
        ? 'target succession declaration is invalid'
        : null;
  if (targetFailure !== null) {
    if (
      intent.disposition === 'deferred' &&
      intent.attemptId === null &&
      intent.blockers.length === 1 &&
      intent.blockers[0]?.owner === 'target' &&
      intent.blockers[0].reason === targetFailure &&
      intent.retryCondition?.kind === 'target-change'
    ) {
      if (intent.nextTarget === null || intent.nextTarget === undefined) {
        let missingRoot = false;
        try {
          options.runtime.storage.statSync(intent.target.pluginRootLabel);
        } catch (error: unknown) {
          missingRoot = error instanceof Error && 'code' in error && error.code === 'ENOENT';
        }
        if (missingRoot) {
          return writeThen(
            intent,
            { ...intent, disposition: 'closed', retryCondition: null, successionPreparation: null },
            { kind: 'refused', reason: targetFailure },
          );
        }
      }
      return settle({ kind: 'refused', reason: targetFailure });
    }
    return writeThen(
      intent,
      {
        ...intent,
        disposition: 'deferred',
        blockers: [{ owner: 'target', reason: targetFailure }],
        retryCondition: { kind: 'target-change', evidence: targetFailure },
        attemptId: null,
        attemptOwner: null,
        successionPreparation: null,
      },
      { kind: 'refused', reason: targetFailure },
    );
  }
  if (custody.kind !== 'validated-target' || declared === null)
    return settle({ kind: 'refused', reason: 'target build no longer validates' });
  const capabilities = declared.kind === 'declared' ? declared.capabilities : emptyCapabilities(intent);
  const epochKey = options.epochKey();
  if (epochKey === null) return settle({ kind: 'deferred', reason: 'exact store epoch is unavailable' });
  const disposition = custody.disposition();
  const formatChanges = disposition.formatChanges;
  if (disposition.kind === 'blocked-by-jobs') {
    const blockers = disposition.liveJobs.map((jobId) => ({ owner: 'jobs', reason: `blocking(format): ${jobId}` }));
    return writeThen(
      intent,
      {
        ...intent,
        disposition: 'deferred',
        blockers,
        retryCondition: { kind: 'obligation-change', evidence: 'format-changing succession awaits job settlement' },
        successionPreparation: null,
        attemptId: null,
        attemptOwner: null,
      },
      { kind: 'deferred', reason: 'format-changing succession awaits job settlement', blockers },
    );
  }
  const admissionRevision = options.admissionRevision();
  const existing = readPreparation(intent);
  if (existing !== null && currentPreparation(intent, existing, options)) {
    const grantedOwners = new Set(existing.receipts.map((receipt) => receipt.owner));
    const current = await prepareOwnerObligations(
      options.owners.filter((owner) => !grantedOwners.has(owner.id)),
      existing.attemptId,
      capabilities,
      (options.requiredOwners ?? REQUIRED_SUCCESSION_OWNERS).filter((owner) => !grantedOwners.has(owner)),
    );
    if (
      current.kind === 'prepared' &&
      current.receipts.length === 0 &&
      (!formatChanges || existing.receipts.length === 0)
    ) {
      return settle({ kind: 'prepared', preparation: existing });
    }
  }
  const attemptId = attemptFor(intent);
  if (!heldAttempts.has(attemptId)) {
    heldAttempts.add(attemptId);
    preparingAttempts.set(attemptId, (preparingAttempts.get(attemptId) ?? 0) + 1);
  }
  const obligations = await prepareOwnerObligations(
    options.owners,
    attemptId,
    capabilities,
    options.requiredOwners,
    options.liveJobIds,
  );
  if (formatChanges && obligations.kind === 'prepared' && obligations.receipts.length > 0) {
    const blockers = obligations.receipts.map((receipt) => ({
      owner: receipt.owner,
      reason: 'blocking(format): obligation requires exact epoch transfer',
    }));
    return writeThen(
      intent,
      {
        ...intent,
        disposition: 'deferred',
        blockers,
        retryCondition: {
          kind: 'obligation-change',
          evidence: 'format-changing succession awaits obligation settlement',
        },
        successionPreparation: null,
        attemptId: null,
        attemptOwner: null,
      },
      { kind: 'deferred', reason: 'format-changing succession awaits obligation settlement', blockers },
    );
  }
  if (obligations.kind === 'blocking' || !capabilities.protocols.includes('prepare')) {
    const blockers =
      obligations.kind === 'blocking'
        ? formatChanges
          ? obligations.blockers.map((blocker) => ({
              ...blocker,
              reason: `blocking(format): ${blocker.reason}`,
            }))
          : obligations.blockers
        : [{ owner: 'protocol', reason: 'target cannot prepare succession' }];
    const retryCondition =
      declared.kind === 'absent' || !capabilities.protocols.includes('prepare')
        ? { kind: 'target-change' as const, evidence: 'target succession declaration changes' }
        : { kind: 'obligation-change' as const, evidence: 'owner disposition changes' };
    const blocked: SuccessionDecision = {
      kind: 'deferred',
      reason: 'succession obligations block preparation',
      blockers,
    };
    clearPendingAttempt();
    if (
      intent.disposition === 'deferred' &&
      intent.attemptId === null &&
      JSON.stringify(intent.blockers) === JSON.stringify(blockers) &&
      JSON.stringify(intent.retryCondition) === JSON.stringify(retryCondition)
    ) {
      return settle(blocked);
    }
    return writeThen(
      intent,
      {
        ...intent,
        disposition: 'deferred',
        blockers: [...blockers],
        retryCondition,
        successionPreparation: null,
        attemptId: null,
        attemptOwner: null,
      },
      blocked,
    );
  }
  const preparation: SuccessionPreparation = {
    version: SUCCESSION_PROTOCOL_VERSION,
    requestId,
    attemptId,
    incumbentInstanceId: self.instanceId,
    incumbentPid: self.pid,
    incumbentKey: incumbentKey(self),
    targetKey: successionTargetKey(intent.target),
    capabilitiesKey: JSON.stringify(capabilities),
    epochKey,
    admissionRevision,
    accepts: capabilities.accepts,
    receipts: [...obligations.receipts],
    stage: 'prepared',
    ready: null,
  };
  const prepared = { ...intent, incumbent: self };
  if (!currentPreparation(prepared, preparation, options)) return { kind: 'retry' };
  return writeThen(
    intent,
    {
      ...prepared,
      disposition: 'pending',
      blockers: [],
      retryCondition: null,
      attemptId,
      attemptOwner: {
        kind: 'incumbent',
        instanceId: self.instanceId,
        pid: self.pid,
        incarnation: self.incarnation,
      },
      successionPreparation: preparation,
    },
    { kind: 'prepared', preparation },
  );
}

export function createSuccessionReconciler(options: SuccessionReconcilerOptions): SuccessionReconciler {
  const newAttemptId = options.newAttemptId ?? (() => options.runtime.ids.uuid());
  let disposed = false;
  // The committer supervises one attempt at a time, so a second preparation while one runs could never launch.
  let launchedAttempt: string | null = null;
  let owedClear: Extract<SuccessionLaunchSettlement, { kind: 'clear-owed' }> | null = null;
  // Reused while the intent's revision stands, so a decide run that repeats records nothing new.
  let pendingAttempt: Readonly<{ requestId: string; revision: number; attemptId: string }> | null = null;
  const preparingAttempts = new Map<string, number>();
  let backoffWake: TimerHandle | null = null;
  const scheduler = createSuccessionReconciliationScheduler({
    time: options.runtime.time,
    retryIntervalMs: options.retryIntervalMs ?? 30_000,
    subscribe: options.subscribeObligationChanges,
    runPass: () => reconcilePending(),
    onError: options.onReconcileError,
  });
  const { reconcile, notifyObligationChange } = scheduler;
  const writeThen = (
    intent: UpgradeIntent,
    change: UpgradeIntentChange,
    decision: SuccessionDecision,
  ): UpgradeIntentCasStep<SuccessionDecision> => ({
    kind: 'write',
    expectedRevision: intent.revision,
    change,
    settle: () => {
      options.onIntentChanged?.();
      return decision;
    },
  });

  /** A backoff ends by this wake, so it never depends on another wake source arriving. */
  function wakeAt(atMs: number): void {
    options.runtime.time.clearTimeout(backoffWake);
    backoffWake = options.runtime.time.setTimeout(
      notifyObligationChange,
      Math.max(0, atMs - options.runtime.time.now()),
    );
    backoffWake.unref?.();
  }

  /**
   * A retirement attempt mints at its incumbent's successor address, so no format-changing attempt can begin while an
   * unserved mint still occupies it; any other target proceeds, because store selection never reads that mint. Each
   * pass retries the discard, and only a discard that leaves nothing of the attempt behind clears the record.
   */
  async function retryUnservedMintDiscard(intent: UpgradeIntent): Promise<SuccessionDecision | null> {
    const pending = intent.unservedMintDiscard ?? null;
    if (pending === null || options.discardUnservedMint === undefined) return null;
    const discarded = options.discardUnservedMint(pending.incumbentEpochKey, pending.attemptId);
    if (discarded.kind === 'held') {
      const formatChanges =
        options.storeFormatFingerprint !== undefined &&
        intent.target.build.storeFormatFingerprint !== options.storeFormatFingerprint;
      return formatChanges
        ? { kind: 'deferred', reason: `unserved retirement mint is not yet discarded (${discarded.reason})` }
        : null;
    }
    const cleared = await retryUpgradeIntentCas<boolean>(options.runDir, (observed) =>
      observed.kind === 'readable' && observed.intent.unservedMintDiscard?.attemptId === pending.attemptId
        ? {
            kind: 'write',
            expectedRevision: observed.intent.revision,
            change: { ...observed.intent, unservedMintDiscard: null },
            settle: () => true,
          }
        : { kind: 'settle', value: false },
    );
    if (cleared.kind !== 'settled' || !cleared.value) return null;
    notifyObligationChange();
    return { kind: 'deferred', reason: `unserved retirement mint was ${discarded.kind}` };
  }

  function attemptFor(intent: UpgradeIntent): string {
    if (pendingAttempt?.requestId !== intent.requestId || pendingAttempt.revision !== intent.revision) {
      pendingAttempt = { requestId: intent.requestId, revision: intent.revision, attemptId: newAttemptId() };
    }
    return pendingAttempt.attemptId;
  }

  /** Grants survive only for attempts the intent names, the launched one, and the one being prepared. */
  function dischargeUnnamedGrants(intent: UpgradeIntent): void {
    const retained = new Set([
      ...namedAttempts(intent),
      ...(launchedAttempt === null ? [] : [launchedAttempt]),
      ...(pendingAttempt === null ? [] : [pendingAttempt.attemptId]),
      ...preparingAttempts.keys(),
    ]);
    for (const owner of options.owners) {
      try {
        owner.dischargeGrants?.(retained);
      } catch (error: unknown) {
        options.onReconcileError?.(error);
      }
    }
  }

  /** Lands the clearing write a settled commit owed; its exit is the next pass, until the intent names another attempt. */
  async function landOwedClear(
    owed: Extract<SuccessionLaunchSettlement, { kind: 'clear-owed' }>,
  ): Promise<SuccessionDecision | null> {
    const outcome = await retryUpgradeIntentCas<boolean>(options.runDir, (observed) =>
      observed.kind === 'readable' && observed.intent.attemptId === owed.attemptId
        ? {
            kind: 'write',
            expectedRevision: observed.intent.revision,
            change: owed.clear(observed.intent),
            settle: () => true,
          }
        : { kind: 'settle', value: false },
    );
    if (outcome.kind !== 'settled') {
      return {
        kind: 'deferred',
        reason: `a settled attempt's clearing write is owed (${outcome.kind === 'refused' ? outcome.problem : 'contended'})`,
      };
    }
    owedClear = null;
    if (!outcome.value) return null;
    options.onIntentChanged?.();
    notifyObligationChange();
    return { kind: 'deferred', reason: 'a settled attempt was cleared from the upgrade intent' };
  }

  async function reconcilePending(): Promise<SuccessionDecision> {
    if (!disposed && owedClear !== null) {
      const owed = await landOwedClear(owedClear);
      if (owed !== null) return owed;
    }
    const observed = status();
    if (!disposed && observed.kind === 'corrupt' && launchedAttempt === null && owedClear === null) {
      if (await quarantineCorruptUpgradeIntent(options.runDir)) {
        options.onIntentChanged?.();
        notifyObligationChange();
        return { kind: 'deferred', reason: 'corrupt upgrade intent was quarantined for a fresh request' };
      }
    }
    if (disposed || observed.kind !== 'readable') return { kind: 'deferred', reason: 'no active upgrade intent' };
    const { intent } = observed;
    const discardHold = await retryUnservedMintDiscard(intent);
    if (discardHold !== null) return discardHold;
    const queued = intent.nextTarget ?? null;
    const self = options.incumbent();
    if (endedUnder(intent, self)) dischargeUnnamedGrants(intent);
    if (intent.disposition === 'closed' || intent.disposition === 'completed') {
      return queued !== null && endedUnder(intent, self)
        ? adoptNextTarget(intent, queued)
        : { kind: 'deferred', reason: 'upgrade intent has ended' };
    }
    // Whichever process serves an attempt owes its receipt, and every later request waits on that receipt.
    if (intent.attemptId !== null && (options.observeServing?.(intent.attemptId) ?? null) !== null) {
      return commit(intent.attemptId);
    }
    if (!recordsSelf(intent.incumbent, self)) return adopt(intent);
    // A target requested while an attempt held the intent supersedes whatever that attempt left behind.
    if (intent.attemptId === null && queued !== null && intent.reason !== 'supervision-repair')
      return adoptNextTarget(intent, queued);
    let applies: boolean;
    try {
      applies = outranks(intent.target, self);
    } catch {
      return { kind: 'deferred', reason: 'target or incumbent version is invalid' };
    }
    if (!applies && intent.reason !== 'supervision-repair' && intent.attemptId === null) return close(intent);
    if (
      intent.disposition === 'deferred' &&
      intent.retryCondition?.kind === 'target-change' &&
      intent.blockers.some((blocker) => TARGET_CHANGE_HOLD_OWNERS.has(blocker.owner))
    ) {
      return { kind: 'deferred', reason: 'successor target must change after failed attempt' };
    }
    const retryAtMs = intent.attemptId === null ? attemptRetryAtMs(intent) : null;
    if (retryAtMs !== null && retryAtMs > options.runtime.time.now()) {
      wakeAt(retryAtMs);
      return {
        kind: 'deferred',
        reason: `failed attempt backs off until ${new Date(retryAtMs).toISOString()}`,
      };
    }
    if (options.commitAvailable !== true) {
      return { kind: 'deferred', reason: 'incumbent needs supervised legacy retirement' };
    }
    if (launchedAttempt !== null) return { kind: 'deferred', reason: LAUNCH_IN_FLIGHT };
    const prepared = await prepare(intent.requestId);
    if (prepared.kind !== 'prepared') return prepared;
    const declaration = readSuccessionCapabilities(
      options.runtime,
      join(intent.target.pluginRootLabel, 'bridge'),
      intent.target.build,
    );
    if (declaration.kind !== 'declared' || !declaration.capabilities.protocols.includes('commit')) {
      return { kind: 'deferred', reason: 'target needs supervised legacy retirement' };
    }
    const current = status(intent.requestId);
    if (current.kind !== 'readable' || current.preparation?.attemptId !== prepared.preparation.attemptId) {
      return { kind: 'deferred', reason: 'prepared attempt changed before launch' };
    }
    if (current.preparation.stage === 'ready') return commit(current.preparation.attemptId);
    if (
      current.intent.attemptDeadline !== null &&
      Date.parse(current.intent.attemptDeadline) <= options.runtime.time.now()
    ) {
      return abort(current.preparation.attemptId);
    }
    if (options.launchPrepared === undefined) {
      return { kind: 'deferred', reason: 'succession launch capability is not installed' };
    }
    if (revalidateUpgradeIntentTarget(current.intent).kind !== 'validated') {
      return { kind: 'deferred', reason: 'target build no longer validates at launch' };
    }
    const attemptId = current.preparation.attemptId;
    launchedAttempt = attemptId;
    let launch: SuccessionLaunch;
    try {
      launch = await options.launchPrepared(current.intent, current.preparation);
    } catch (error: unknown) {
      launchedAttempt = null;
      const aborted = await abort(attemptId);
      if (aborted.kind !== 'aborted') return aborted;
      throw error;
    }
    void launch.settled
      .then(
        (settlement) => {
          if (settlement.kind === 'clear-owed') owedClear = settlement;
        },
        () => undefined,
      )
      .finally(() => {
        launchedAttempt = null;
        notifyObligationChange();
      });
    return { kind: 'deferred', reason: 'successor launch is awaiting readiness' };
  }

  /**
   * The serving incumbent owns an intent whose recorded incumbent is proven gone, keeping its disposition, hold, and
   * retry. An attempt still named belongs to startup. An unproven exit adopts nothing and is recorded as a blocker
   * the adoption removes; the next pass, or the retry interval, looks again.
   */
  async function adopt(intent: UpgradeIntent): Promise<SuccessionDecision> {
    const recorded = intent.incumbent;
    if (intent.attemptId !== null) {
      return { kind: 'deferred', reason: 'upgrade intent names another incumbent and its attempt' };
    }
    if (options.epochKey() === null) {
      return { kind: 'deferred', reason: 'upgrade intent names another incumbent; this process does not serve yet' };
    }
    const unchanged = (observed: UpgradeIntentRead): observed is Extract<UpgradeIntentRead, { kind: 'readable' }> =>
      observed.kind === 'readable' &&
      observed.intent.requestId === intent.requestId &&
      observed.intent.attemptId === null &&
      observed.intent.disposition !== 'closed' &&
      observed.intent.disposition !== 'completed' &&
      incumbentKey(observed.intent.incumbent) === incumbentKey(recorded);
    const liveness = observeRecordedDeath(recorded);
    if (liveness !== 'absent') {
      const reason = `recorded incumbent ${recorded.instanceId} (pid ${recorded.pid}) is ${liveness}; adoption waits until its exit is proven`;
      const held: SuccessionDecision = { kind: 'deferred', reason };
      const blocker = { owner: ADOPTION_BLOCKER_OWNER, reason };
      void (await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) =>
        !unchanged(observed) ||
        observed.intent.blockers.some((entry) => entry.owner === blocker.owner && entry.reason === blocker.reason)
          ? settle(held)
          : writeThen(
              observed.intent,
              {
                ...observed.intent,
                blockers: [...withoutAdoptionBlocker(observed.intent.blockers), blocker],
              },
              held,
            ),
      ));
      return held;
    }
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) => {
      if (!unchanged(observed)) {
        return settle({ kind: 'deferred', reason: 'upgrade intent changed before adoption' });
      }
      return {
        kind: 'write',
        expectedRevision: observed.intent.revision,
        change: {
          ...observed.intent,
          incumbent: options.incumbent(),
          blockers: withoutAdoptionBlocker(observed.intent.blockers),
        },
        settle: (written) => {
          options.onIntentChanged?.();
          notifyObligationChange();
          return { kind: 'registered', intent: written };
        },
      };
    });
    return decisionOf(outcome, 'deferred');
  }

  async function adoptNextTarget(intent: UpgradeIntent, queued: TargetRequest): Promise<SuccessionDecision> {
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) => {
      if (observed.kind !== 'readable' || observed.intent.revision !== intent.revision) {
        return settle({ kind: 'deferred', reason: 'upgrade intent changed before its queued target was adopted' });
      }
      return {
        kind: 'write',
        expectedRevision: intent.revision,
        change: requestedIntent(queued, options.incumbent(), null),
        settle: (written) => {
          options.onIntentChanged?.();
          notifyObligationChange();
          return { kind: 'registered', intent: written };
        },
      };
    });
    return decisionOf(outcome, 'deferred');
  }

  async function close(intent: UpgradeIntent): Promise<SuccessionDecision> {
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) =>
      observed.kind === 'readable' && observed.intent.revision === intent.revision
        ? writeThen(
            intent,
            { ...intent, disposition: 'closed', blockers: [], retryCondition: null, successionPreparation: null },
            { kind: 'refused', reason: 'target does not strictly outrank the incumbent' },
          )
        : settle({ kind: 'deferred', reason: 'upgrade intent changed before it closed' }),
    );
    return decisionOf(outcome, 'deferred');
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    scheduler.dispose();
    options.runtime.time.clearTimeout(backoffWake);
  }

  const { request, repairSupervision } = createIntentTransitionRequests(
    options,
    notifyObligationChange,
    () => launchedAttempt,
  );

  async function prepare(requestId: string): Promise<SuccessionDecision> {
    const heldAttempts = new Set<string>();
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) =>
      prepareObservedIntent({
        options,
        requestId,
        heldAttempts,
        observed,
        commit,
        getLaunchedAttempt: () => launchedAttempt,
        writeThen,
        attemptFor,
        preparingAttempts,
        clearPendingAttempt: () => {
          pendingAttempt = null;
        },
      }),
    ).finally(() => {
      for (const attemptId of heldAttempts) {
        const count = preparingAttempts.get(attemptId);
        if (count === 1) preparingAttempts.delete(attemptId);
        else if (count !== undefined) preparingAttempts.set(attemptId, count - 1);
      }
    });
    return decisionOf(outcome, 'refused');
  }

  function status(requestId?: string): SuccessionStatus {
    const observed = readUpgradeIntent(options.runDir);
    if (observed.kind !== 'readable') return { kind: observed.kind };
    if (requestId !== undefined && observed.intent.requestId !== requestId) return { kind: 'absent' as const };
    return { kind: 'readable' as const, intent: observed.intent, preparation: readPreparation(observed.intent) };
  }

  async function reportReady(report: SuccessionReady): Promise<SuccessionDecision> {
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, () => {
      const observed = status();
      if (observed.kind !== 'readable') return settle({ kind: 'refused', reason: 'upgrade intent unavailable' });
      const { intent, preparation } = observed;
      if (preparation === null || preparation.attemptId !== report.attemptId) {
        return settle({ kind: 'refused', reason: 'attempt is not prepared' });
      }
      if (!currentPreparation(intent, preparation, options)) {
        return settle({
          kind: 'stale',
          reason: 'preparation is stale',
          cause: staleCause(intent, preparation, options),
        });
      }
      const declaration = readSuccessionCapabilities(
        options.runtime,
        join(intent.target.pluginRootLabel, 'bridge'),
        intent.target.build,
      );
      if (declaration.kind !== 'declared' || !declaration.capabilities.protocols.includes('commit')) {
        return settle({ kind: 'deferred', reason: 'target cannot commit succession' });
      }
      if (preparation.stage === 'ready' && JSON.stringify(preparation.ready) === JSON.stringify(report)) {
        return settle({ kind: 'ready', preparation });
      }
      if (
        preparation.stage !== 'prepared' ||
        preparation.ready !== null ||
        report.successorPid === options.incumbent().pid ||
        report.targetKey !== preparation.targetKey ||
        report.epochKey !== preparation.epochKey ||
        report.admissionRevision !== preparation.admissionRevision ||
        JSON.stringify([...report.receiptIds].sort()) !==
          JSON.stringify(preparation.receipts.map((receipt) => receipt.receiptId).sort())
      ) {
        return settle({ kind: 'refused', reason: 'successor ready report does not match the prepared attempt' });
      }
      const next: SuccessionPreparation = { ...preparation, stage: 'ready', ready: report };
      return {
        kind: 'write',
        expectedRevision: intent.revision,
        change: { ...intent, successionPreparation: next },
        settle: () => {
          options.onIntentChanged?.();
          notifyObligationChange();
          return { kind: 'ready', preparation: next };
        },
      };
    });
    return decisionOf(outcome, 'refused');
  }

  async function abort(attemptId: string): Promise<SuccessionDecision> {
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, async (observed) => {
      if (observed.kind !== 'readable')
        return settle({ kind: 'refused', reason: `upgrade intent is ${observed.kind}` });
      const intent = observed.intent;
      if (intent.attemptId !== attemptId) return settle({ kind: 'refused', reason: 'attempt is not current' });
      if (intent.disposition === 'completed') return settle({ kind: 'refused', reason: 'attempt already serves' });
      if ((options.observeServing?.(attemptId) ?? null) !== null) return settle(await commit(attemptId));
      if (committing(intent)) return settle({ kind: 'refused', reason: 'attempt is committing' });
      if (attemptId === launchedAttempt) return settle({ kind: 'refused', reason: LAUNCH_IN_FLIGHT });
      if (holdsRecovery(intent)) return settle({ kind: 'refused', reason: RECOVERY_HOLDS_INTENT });
      return writeThen(
        intent,
        {
          ...intent,
          disposition: 'pending',
          attemptId: null,
          attemptOwner: null,
          attemptDeadline: null,
          blockers: [],
          retryCondition: null,
          successionPreparation: null,
        },
        { kind: 'aborted' },
      );
    });
    return decisionOf(outcome, 'refused');
  }

  async function commit(attemptId: string): Promise<SuccessionDecision> {
    let writeRefusal: 'refused' | 'deferred' = 'refused';
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, () => {
      const observed = status();
      if (observed.kind !== 'readable') return settle({ kind: 'refused', reason: 'upgrade intent unavailable' });
      if (observed.intent.disposition === 'completed' && observed.intent.completionReceipt?.attemptId === attemptId) {
        const receipt = observed.intent.completionReceipt;
        const serving = options.observeServing?.(attemptId);
        return settle(
          serving !== null &&
            serving !== undefined &&
            serving.epochKey === receipt.epochKey &&
            serving.controlGeneration === receipt.controlGeneration &&
            serving.successorInstanceId === receipt.successor.instanceId
            ? { kind: 'committed', receipt }
            : { kind: 'deferred', reason: 'durable serving record is unavailable' },
        );
      }
      const { intent, preparation } = observed;
      if (preparation === null || preparation.attemptId !== attemptId) {
        return settle({ kind: 'refused', reason: 'attempt is not prepared' });
      }
      const serving = options.observeServing?.(attemptId);
      if (serving !== null && serving !== undefined && intent.recoveryAttemptId === attemptId) {
        return recoveryServes(intent, serving.successorInstanceId);
      }
      if (serving !== null && serving !== undefined) {
        if (
          preparation.ready === null ||
          preparation.targetKey !== successionTargetKey(intent.target) ||
          (serving.epochKey !== preparation.epochKey &&
            !options.retirementServing?.(attemptId, preparation.epochKey)) ||
          serving.successorInstanceId.length === 0 ||
          !Number.isSafeInteger(serving.controlGeneration) ||
          serving.controlGeneration < 1 ||
          !Number.isFinite(Date.parse(serving.recordedAt)) ||
          (intent.attemptDeadline !== null && Date.parse(serving.recordedAt) > Date.parse(intent.attemptDeadline))
        ) {
          return settle({ kind: 'deferred', reason: 'durable serving record does not match the prepared attempt' });
        }
        const receipt: NonNullable<UpgradeIntent['completionReceipt']> = {
          kind: 'serving',
          attemptId,
          successor: {
            instanceId: serving.successorInstanceId,
            pid: preparation.ready.successorPid,
            incarnation:
              intent.attemptChild?.attemptId === attemptId && intent.attemptChild.pid === preparation.ready.successorPid
                ? intent.attemptChild.incarnation
                : null,
            build: intent.target.build,
          },
          epochKey: serving.epochKey,
          controlGeneration: serving.controlGeneration,
          acceptedObligations: preparation.receipts.map((ownerReceipt) => ({
            owner: ownerReceipt.owner,
            receiptId: ownerReceipt.receiptId,
            controlGeneration: serving.controlGeneration,
          })),
          recordedAt: serving.recordedAt,
        };
        writeRefusal = 'deferred';
        return {
          kind: 'write',
          expectedRevision: intent.revision,
          change: { ...intent, disposition: 'completed', completionReceipt: receipt },
          settle: () => {
            options.onIntentChanged?.();
            // A target queued behind this attempt is adopted by the pass after its receipt.
            notifyObligationChange();
            return { kind: 'committed', receipt };
          },
        };
      }
      if (!currentPreparation(intent, preparation, options)) {
        if (committing(intent)) return settle({ kind: 'deferred', reason: 'succession attempt is committing' });
        writeRefusal = 'refused';
        return writeThen(
          intent,
          {
            ...intent,
            disposition: 'deferred',
            blockers: [{ owner: 'preparation', reason: 'preparation is stale' }],
            retryCondition:
              staleCause(intent, preparation, options) === 'target-change'
                ? { kind: 'target-change', evidence: 'target identity or capability declaration changed' }
                : { kind: 'obligation-change', evidence: 'epoch or admission revision changed' },
          },
          { kind: 'refused', reason: 'preparation is stale' },
        );
      }
      if (preparation.stage !== 'ready')
        return settle({ kind: 'deferred', reason: 'successor has not reported ready' });
      return settle({ kind: 'deferred', reason: 'awaiting durable serving record' });
    });
    return decisionOf(outcome, writeRefusal);
  }

  /**
   * A same-build recovery stands in for a failed target, so it earns no completion receipt: the target keeps the hold
   * its failed attempt left, and the recovery that serves becomes the incumbent owning the intent. Only that process
   * records it, because no other observer can write its identity.
   */
  function recoveryServes(
    intent: UpgradeIntent,
    successorInstanceId: string,
  ): UpgradeIntentCasStep<SuccessionDecision> {
    const self = options.incumbent();
    if (successorInstanceId !== self.instanceId) {
      return settle({ kind: 'deferred', reason: 'a serving same-build recovery records its own serving' });
    }
    return {
      kind: 'write',
      expectedRevision: intent.revision,
      change: {
        ...intent,
        incumbent: self,
        attemptId: null,
        attemptChild: null,
        attemptOwner: null,
        attemptDeadline: null,
        recoveryAttemptId: null,
        recoveryBuildSetId: null,
        recoveryGrantAttemptId: null,
        recoveryRetry: null,
        successionPreparation: null,
        disposition: 'deferred',
        blockers: [{ owner: 'succession-commit', reason: 'same-build recovery serves after failed target commit' }],
        ...failedAttemptRetry(
          intent,
          recoveryRetryOf(intent),
          'successor committed-open failure',
          options.runtime.time.now(),
        ),
        completionReceipt: null,
      },
      settle: (written) => {
        options.onIntentChanged?.();
        notifyObligationChange();
        return { kind: 'registered', intent: written };
      },
    };
  }

  async function recertify(attemptId: string): Promise<SuccessionDecision> {
    const observed = status();
    if (observed.kind !== 'readable' || observed.preparation?.attemptId !== attemptId) {
      return { kind: 'refused', reason: 'attempt is not prepared' };
    }
    const { intent, preparation } = observed;
    const declared = readSuccessionCapabilities(
      options.runtime,
      join(intent.target.pluginRootLabel, 'bridge'),
      intent.target.build,
    );
    if (declared.kind === 'invalid') return { kind: 'refused', reason: 'target succession declaration is invalid' };
    const capabilities = declared.kind === 'declared' ? declared.capabilities : emptyCapabilities(intent);
    if (JSON.stringify(capabilities) !== preparation.capabilitiesKey) {
      return { kind: 'stale', reason: 'target capabilities changed after preparation', cause: 'target-change' };
    }
    const certified = await recertifyUntransferableOwners(
      options.owners,
      attemptId,
      capabilities,
      options.requiredOwners,
    );
    return certified.kind === 'prepared'
      ? { kind: 'prepared', preparation }
      : { kind: 'deferred', reason: 'succession obligations began after preparation', blockers: certified.blockers };
  }

  return {
    incumbent: options.incumbent,
    request,
    repairSupervision,
    prepare,
    reportReady,
    commit,
    recertify,
    abort,
    status,
    reconcile,
    notifyObligationChange,
    dispose,
  };
}
