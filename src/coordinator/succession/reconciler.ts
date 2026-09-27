import { join } from 'node:path';

import type { TimerHandle } from '../../infra/port-types.js';
import { compareProductVersions } from '../../infra/product-version.js';
import type { Runtime } from '../../runtime/ports.js';
import { SUCCESSION_CAPABILITY_VERSION } from '../../infra/bundle-manifest-address.js';
import { SUCCESSION_PROTOCOL_VERSION } from '../../infra/succession-address.js';
import {
  readUpgradeIntent,
  retryUpgradeIntentCas,
  revalidateUpgradeIntentTarget,
  type UpgradeIntent,
  type UpgradeIntentCasOutcome,
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

type IncumbentIdentity = UpgradeIntent['incumbent'];
type Target = UpgradeIntent['target'];
type TargetRequest = Readonly<{ requestId: string; target: Target }>;

export type SuccessionReconcilerOptions = Readonly<{
  runtime: Pick<Runtime, 'time' | 'ids' | 'storage'>;
  runDir: string;
  /**
   * This process's own identity. Every write of it into the intent reads this one source, so a late-settling
   * incarnation never makes the process mistake its own intent for another incumbent's.
   */
  incumbent: () => IncumbentIdentity;
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
 * How a launched attempt's commit ended while this process lives. `clear-owed` carries the write that clears the
 * attempt from the intent, which the commit could not land after reclaiming in place; until it lands, the intent
 * still claims a commit that nothing supervises.
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
  /** Readiness for a preparation that no longer matches; `cause` names the change that ends the hold. */
  | Readonly<{ kind: 'stale'; reason: string; cause: 'target-change' | 'obligation-change' }>
  | Readonly<{ kind: 'aborted' }>;

export type SuccessionStatus =
  | Readonly<{ kind: 'readable'; intent: UpgradeIntent; preparation: SuccessionPreparation | null }>
  | Readonly<{ kind: 'absent' | 'unreadable' | 'corrupt' | 'unsupported' }>;

export type SuccessionReconciler = Readonly<{
  incumbent: () => IncumbentIdentity;
  request: (input: { requestId: string; target: Target }) => Promise<SuccessionDecision>;
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

function settle(decision: SuccessionDecision): UpgradeIntentCasStep<SuccessionDecision> {
  return { kind: 'settle', value: decision };
}

function decisionOf(
  outcome: UpgradeIntentCasOutcome<SuccessionDecision>,
  refusal: 'refused' | 'deferred',
): SuccessionDecision {
  switch (outcome.kind) {
    case 'settled':
      return outcome.value;
    case 'refused':
      return { kind: refusal, reason: `upgrade intent is ${outcome.problem}` };
    case 'exhausted':
      return { kind: 'deferred', reason: 'upgrade intent changed concurrently' };
  }
}

function sameTarget(left: Target, right: Target): boolean {
  return successionTargetKey(left) === successionTargetKey(right);
}

/** Whether `candidate` is a strictly later build of `than`'s flavor; an unreadable version is never later. */
function supersedes(candidate: Target, than: Target): boolean {
  if (candidate.build.flavor !== than.build.flavor || sameTarget(candidate, than)) return false;
  try {
    return compareProductVersions(candidate.build.version, than.build.version) > 0;
  } catch {
    return false;
  }
}

/**
 * A fresh request replaces every attempt field this build knows, since the intent write keeps whatever a change
 * leaves out. Three survive: a queued target that still supersedes the request, the transient retry count, which is
 * keyed by its own target so a re-request cannot reset that target's bound, and an unserved mint discard, which is
 * owed to the store rather than to any target.
 */
function requestedIntent(
  request: TargetRequest,
  incumbent: IncumbentIdentity,
  queued: TargetRequest | null | undefined,
): UpgradeIntentChange {
  return {
    requestId: request.requestId,
    incumbent,
    target: request.target,
    attemptId: null,
    attemptChild: null,
    attemptOwner: null,
    disposition: 'pending',
    blockers: [],
    retryCondition: null,
    attemptDeadline: null,
    completionReceipt: null,
    successionPreparation: null,
    recoveryAttemptId: null,
    recoveryBuildSetId: null,
    recoveryGrantAttemptId: null,
    recoveryRetry: null,
    obligationRetry: null,
    nextTarget: queued !== null && queued !== undefined && supersedes(queued.target, request.target) ? queued : null,
  };
}

function incumbentKey(incumbent: IncumbentIdentity): string {
  return JSON.stringify([
    incumbent.instanceId,
    incumbent.pid,
    incumbent.incarnation,
    incumbent.version,
    incumbent.bundleHash,
    incumbent.flavor,
  ]);
}

/**
 * Whether `recorded` names the process `self` describes. An instance id is minted per boot, so a record that lacks
 * only the incarnation was written by this process before its incarnation could be read.
 */
function recordsSelf(recorded: IncumbentIdentity, self: IncumbentIdentity): boolean {
  return incumbentKey({ ...recorded, incarnation: recorded.incarnation ?? self.incarnation }) === incumbentKey(self);
}

/** An attempt this incumbent is committing; only its commit may release or clear it. */
function committing(intent: UpgradeIntent): boolean {
  return intent.disposition === 'attempting' && intent.attemptId !== null && intent.attemptOwner?.kind === 'incumbent';
}

/** The process an ended intent leaves serving: the successor its receipt names, or the incumbent that closed it. */
function endedUnder(intent: UpgradeIntent, self: IncumbentIdentity): boolean {
  return intent.disposition === 'completed'
    ? intent.completionReceipt?.successor.instanceId === self.instanceId
    : recordsSelf(intent.incumbent, self);
}

/** A same-build recovery grant stands in for a failed commit; only that recovery, or startup, may clear it. */
function holdsRecovery(intent: UpgradeIntent): boolean {
  return (
    intent.attemptId !== null &&
    intent.attemptOwner?.kind === 'incumbent' &&
    intent.recoveryAttemptId === intent.attemptId
  );
}

/** Startup reads a committing attempt or a same-build recovery grant as evidence of what may have been released. */
function heldByCommit(intent: UpgradeIntent): boolean {
  return committing(intent) || holdsRecovery(intent);
}

/** Every attempt whose grants the intent may still redeem, including those its preparation's receipts name. */
function namedAttempts(intent: UpgradeIntent): string[] {
  const preparation = successionPreparationSchema.safeParse(intent.successionPreparation);
  return [
    intent.attemptId,
    intent.recoveryAttemptId,
    intent.completionReceipt?.attemptId,
    ...(preparation.success
      ? [preparation.data.attemptId, ...preparation.data.receipts.map((receipt) => receipt.attemptId)]
      : []),
  ].filter((attemptId): attemptId is string => typeof attemptId === 'string');
}

const LAUNCH_IN_FLIGHT = 'launched attempt is settled only by its commit';
const RECOVERY_HOLDS_INTENT = 'a same-build recovery attempt is settled only by its recovery or by startup';

/** Reports why the serving incumbent has not adopted an intent another incumbent recorded. */
const ADOPTION_BLOCKER_OWNER = 'succession-adoption';

function withoutAdoptionBlocker(blockers: UpgradeIntent['blockers']): UpgradeIntent['blockers'] {
  return blockers.filter((entry) => entry.owner !== ADOPTION_BLOCKER_OWNER);
}

/** Holds only a newer target can end; a pass that finds one leaves it for that target. */
const TARGET_CHANGE_HOLD_OWNERS = new Set(['succession-commit', 'succession-prepare', 'succession-startup']);

function outranks(target: Target, incumbent: IncumbentIdentity): boolean {
  return (
    target.build.flavor === incumbent.flavor && compareProductVersions(target.build.version, incumbent.version) > 0
  );
}

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

/** A stale preparation whose target still validates with the same declaration was outdated by obligations. */
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
export function createSuccessionReconciler(options: SuccessionReconcilerOptions): SuccessionReconciler {
  const newAttemptId = options.newAttemptId ?? (() => options.runtime.ids.uuid());
  let disposed = false;
  let reconciling: Promise<SuccessionDecision> | null = null;
  // A change that joins a running pass may postdate what that pass read, so it is owed one more pass.
  let changedDuringReconcile = false;
  // The committer supervises one attempt at a time, so a second preparation while one runs could never launch.
  let launchedAttempt: string | null = null;
  let owedClear: Extract<SuccessionLaunchSettlement, { kind: 'clear-owed' }> | null = null;
  // Reused while the intent's revision stands, so a decide run that repeats records nothing new.
  let pendingAttempt: Readonly<{ requestId: string; revision: number; attemptId: string }> | null = null;
  const preparingAttempts = new Map<string, number>();
  let backoffWake: TimerHandle | null = null;
  const notifyObligationChange = (): void => {
    if (disposed) return;
    queueMicrotask(() => {
      void reconcile().catch((error: unknown) => options.onReconcileError?.(error));
    });
  };
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
  const unsubscribe = options.subscribeObligationChanges?.(notifyObligationChange);
  const retryTimer = options.runtime.time.setInterval(notifyObligationChange, options.retryIntervalMs ?? 30_000);
  retryTimer.unref?.();
  queueMicrotask(notifyObligationChange);

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

  function reconcile(): Promise<SuccessionDecision> {
    if (reconciling !== null) {
      changedDuringReconcile = true;
      return reconciling;
    }
    const pending = reconcilePending().finally(() => {
      reconciling = null;
      if (!changedDuringReconcile) return;
      changedDuringReconcile = false;
      notifyObligationChange();
    });
    reconciling = pending;
    return pending;
  }

  async function reconcilePending(): Promise<SuccessionDecision> {
    if (!disposed && owedClear !== null) {
      const owed = await landOwedClear(owedClear);
      if (owed !== null) return owed;
    }
    const observed = status();
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
    if (intent.attemptId === null && queued !== null) return adoptNextTarget(intent, queued);
    let applies: boolean;
    try {
      applies = outranks(intent.target, self);
    } catch {
      return { kind: 'deferred', reason: 'target or incumbent version is invalid' };
    }
    if (!applies && intent.attemptId === null) return close(intent);
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
      return { kind: 'deferred', reason: 'incumbent needs a legacy retirement waiter' };
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
      return { kind: 'deferred', reason: 'target needs a legacy retirement waiter' };
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

  /** Replaces a settled intent with the target queued while its attempt held it; a stale target then closes. */
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

  /** An intent whose target this incumbent already runs, or outranks, has nothing left to apply. */
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
    options.runtime.time.clearInterval(retryTimer);
    options.runtime.time.clearTimeout(backoffWake);
    unsubscribe?.();
  }

  async function request(input: { requestId: string; target: Target }): Promise<SuccessionDecision> {
    const self = options.incumbent();
    try {
      if (
        input.target.build.flavor !== self.flavor ||
        compareProductVersions(input.target.build.version, self.version) <= 0
      ) {
        return { kind: 'refused', reason: 'target does not strictly outrank the incumbent' };
      }
    } catch {
      return { kind: 'refused', reason: 'target or incumbent version is invalid' };
    }
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) => {
      if (observed.kind !== 'absent' && observed.kind !== 'readable') {
        return settle({ kind: 'refused', reason: `upgrade intent is ${observed.kind}` });
      }
      const current = observed.kind === 'readable' ? observed.intent : null;
      if (current !== null && current.disposition !== 'closed' && current.disposition !== 'completed') {
        if (
          current.attemptId !== null &&
          ((options.observeServing?.(current.attemptId) ?? null) !== null ||
            (current.attemptChild?.attemptId === current.attemptId &&
              observeRecordedDeath(current.attemptChild) !== 'absent') ||
            (recordsSelf(current.incumbent, self) && (heldByCommit(current) || current.attemptId === launchedAttempt)))
        ) {
          return queueBehindAttempt(current, input);
        }
        let comparison: number;
        try {
          comparison = compareProductVersions(input.target.build.version, current.target.build.version);
        } catch {
          return settle({ kind: 'refused', reason: 'pending target version is invalid' });
        }
        if (
          sameTarget(current.target, input.target) ||
          (current.target.build.flavor === input.target.build.flavor &&
            comparison <= 0 &&
            revalidateUpgradeIntentTarget(current).kind === 'validated')
        ) {
          notifyObligationChange();
          return settle({ kind: 'registered', intent: current });
        }
        if (current.target.build.flavor !== input.target.build.flavor) {
          return settle({ kind: 'refused', reason: 'pending target has another build flavor' });
        }
      }
      return {
        kind: 'write',
        expectedRevision: current?.revision ?? null,
        change: requestedIntent(input, self, current?.nextTarget),
        settle: (written) => {
          options.onIntentChanged?.();
          notifyObligationChange();
          return { kind: 'registered', intent: written };
        },
      };
    });
    return decisionOf(outcome, 'refused');
  }

  /**
   * Only the attempt's commit may clear an attempt it holds, so a later target is queued beside it rather than
   * replacing it, and the pass after that commit settles adopts it.
   */
  function queueBehindAttempt(current: UpgradeIntent, input: TargetRequest): UpgradeIntentCasStep<SuccessionDecision> {
    notifyObligationChange();
    const queued = current.nextTarget ?? null;
    if (
      !supersedes(input.target, current.target) ||
      (queued !== null && (sameTarget(queued.target, input.target) || !supersedes(input.target, queued.target)))
    ) {
      return settle({ kind: 'registered', intent: current });
    }
    return {
      kind: 'write',
      expectedRevision: current.revision,
      change: { ...current, nextTarget: { requestId: input.requestId, target: input.target } },
      settle: (written) => {
        options.onIntentChanged?.();
        return { kind: 'registered', intent: written };
      },
    };
  }

  async function prepare(requestId: string): Promise<SuccessionDecision> {
    const heldAttempts = new Set<string>();
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, async (observed) => {
      if (observed.kind !== 'readable')
        return settle({ kind: 'refused', reason: `upgrade intent is ${observed.kind}` });
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
      if (intent.attemptId !== null && intent.attemptId === launchedAttempt)
        return settle({ kind: 'deferred', reason: LAUNCH_IN_FLIGHT });
      if (holdsRecovery(intent)) return settle({ kind: 'refused', reason: RECOVERY_HOLDS_INTENT });
      const validated = revalidateUpgradeIntentTarget(intent);
      const declared =
        validated.kind === 'validated'
          ? readSuccessionCapabilities(
              options.runtime,
              join(intent.target.pluginRootLabel, 'bridge'),
              intent.target.build,
            )
          : null;
      const targetFailure =
        validated.kind !== 'validated'
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
      if (declared === null) return settle({ kind: 'refused', reason: 'target build no longer validates' });
      const capabilities = declared.kind === 'declared' ? declared.capabilities : emptyCapabilities(intent);
      const epochKey = options.epochKey();
      if (epochKey === null) return settle({ kind: 'deferred', reason: 'exact store epoch is unavailable' });
      const formatChanges =
        options.storeFormatFingerprint !== undefined &&
        intent.target.build.storeFormatFingerprint !== options.storeFormatFingerprint;
      const liveJobs = formatChanges ? (options.liveJobIds?.() ?? []) : [];
      if (liveJobs.length > 0) {
        const blockers = liveJobs.map((jobId) => ({ owner: 'jobs', reason: `blocking(format): ${jobId}` }));
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
        // A blocked attempt is never named, so the next pass prepares a fresh one and discharges this one's grants.
        pendingAttempt = null;
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
    }).finally(() => {
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
