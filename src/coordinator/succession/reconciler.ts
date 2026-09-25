import { join } from 'node:path';

import { compareProductVersions } from '../../infra/product-version.js';
import type { Runtime } from '../../runtime/ports.js';
import { SUCCESSION_CAPABILITY_VERSION } from '../../infra/bundle-manifest-address.js';
import { SUCCESSION_PROTOCOL_VERSION } from '../../infra/succession-address.js';
import {
  compareAndSwapUpgradeIntent,
  readUpgradeIntent,
  revalidateUpgradeIntentTarget,
  type UpgradeIntent,
} from '../../infra/upgrade-intent.js';
import {
  readSuccessionCapabilities,
  successionPreparationSchema,
  type SuccessionCapabilities,
  type SuccessionPreparation,
  type SuccessionReady,
} from './protocol.js';
import { prepareOwnerObligations, type SuccessionOwner, type SuccessionOwnerId } from './obligations.js';

type IncumbentIdentity = UpgradeIntent['incumbent'];
type Target = UpgradeIntent['target'];

export type SuccessionReconcilerOptions = Readonly<{
  runtime: Pick<Runtime, 'time' | 'ids' | 'storage'>;
  runDir: string;
  incumbent: IncumbentIdentity;
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
  retirementServing?: (attemptId: string, incumbentEpochKey: string, servedEpochKey: string) => boolean;
  onIntentChanged?: () => void;
  onReconcileError?: (error: unknown) => void;
  commitAvailable?: boolean;
  subscribeObligationChanges?: (notify: () => void) => () => void;
  launchPrepared?: (intent: UpgradeIntent, preparation: SuccessionPreparation) => Promise<void>;
  retryIntervalMs?: number;
}>;

export type SuccessionDecision =
  | Readonly<{ kind: 'registered'; intent: UpgradeIntent }>
  | Readonly<{ kind: 'prepared'; preparation: SuccessionPreparation }>
  | Readonly<{ kind: 'ready'; preparation: SuccessionPreparation }>
  | Readonly<{ kind: 'committed'; receipt: NonNullable<UpgradeIntent['completionReceipt']> }>
  | Readonly<{ kind: 'deferred'; reason: string; blockers?: readonly { owner: string; reason: string }[] }>
  | Readonly<{ kind: 'refused'; reason: string }>
  | Readonly<{ kind: 'aborted' }>;

export type SuccessionStatus =
  | Readonly<{ kind: 'readable'; intent: UpgradeIntent; preparation: SuccessionPreparation | null }>
  | Readonly<{ kind: 'absent' | 'unreadable' | 'corrupt' | 'unsupported' }>;

export type SuccessionReconciler = Readonly<{
  request: (input: { requestId: string; target: Target }) => Promise<SuccessionDecision>;
  prepare: (requestId: string) => Promise<SuccessionDecision>;
  reportReady: (report: SuccessionReady) => Promise<SuccessionDecision>;
  commit: (attemptId: string) => Promise<SuccessionDecision>;
  abort: (attemptId: string) => Promise<SuccessionDecision>;
  status: (requestId?: string) => SuccessionStatus;
  reconcile: () => Promise<SuccessionDecision>;
  notifyObligationChange: () => void;
  dispose: () => void;
}>;

function sameTarget(left: Target, right: Target): boolean {
  return targetKey(left) === targetKey(right);
}

function targetKey(target: Target): string {
  const { build } = target;
  return JSON.stringify([
    target.pluginRootLabel,
    build.version,
    build.buildSetId,
    build.flavor,
    build.storeFormatFingerprint,
    build.bundleHash,
    build.cliBundleHash,
    build.claudeAppserverBundleHash,
    build.durableWrapperBundleHash,
  ]);
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

function readPreparation(intent: UpgradeIntent): SuccessionPreparation | null {
  const parsed = successionPreparationSchema.safeParse(intent.successionPreparation);
  if (!parsed.success) return null;
  const preparation = parsed.data;
  if (
    preparation.requestId !== intent.requestId ||
    preparation.attemptId !== intent.attemptId ||
    preparation.receipts.some(
      (receipt) =>
        receipt.attemptId !== preparation.attemptId ||
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
  return (
    preparation.incumbentInstanceId === options.incumbent.instanceId &&
    preparation.incumbentPid === options.incumbent.pid &&
    preparation.incumbentKey === incumbentKey(options.incumbent) &&
    preparation.incumbentKey === incumbentKey(intent.incumbent) &&
    preparation.targetKey === targetKey(intent.target) &&
    preparation.capabilitiesKey === JSON.stringify(capabilities) &&
    preparation.epochKey === options.epochKey() &&
    preparation.admissionRevision === options.admissionRevision()
  );
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
  const launchedAttempts = new Set<string>();
  const notifyObligationChange = (): void => {
    if (disposed) return;
    queueMicrotask(() => {
      void reconcile().catch((error: unknown) => options.onReconcileError?.(error));
    });
  };
  const unsubscribe = options.subscribeObligationChanges?.(notifyObligationChange);
  const retryTimer = options.runtime.time.setInterval(notifyObligationChange, options.retryIntervalMs ?? 30_000);
  retryTimer.unref?.();
  queueMicrotask(notifyObligationChange);

  function reconcile(): Promise<SuccessionDecision> {
    if (reconciling !== null) return reconciling;
    const pending = reconcilePending().finally(() => {
      reconciling = null;
    });
    reconciling = pending;
    return pending;
  }

  async function reconcilePending(): Promise<SuccessionDecision> {
    const observed = status();
    if (disposed || observed.kind !== 'readable') return { kind: 'deferred', reason: 'no active upgrade intent' };
    const { intent } = observed;
    if (intent.disposition === 'closed' || intent.disposition === 'completed') {
      return { kind: 'deferred', reason: 'upgrade intent has ended' };
    }
    if (incumbentKey(intent.incumbent) !== incumbentKey(options.incumbent)) {
      return { kind: 'deferred', reason: 'upgrade intent names another incumbent' };
    }
    if (
      intent.disposition === 'deferred' &&
      intent.retryCondition?.kind === 'target-change' &&
      intent.blockers.some((blocker) => blocker.owner === 'succession-commit' || blocker.owner === 'succession-prepare')
    ) {
      return { kind: 'deferred', reason: 'successor target must change after failed attempt' };
    }
    if (options.commitAvailable !== true) {
      return { kind: 'deferred', reason: 'incumbent needs a legacy retirement waiter' };
    }
    if (intent.attemptId !== null && (options.observeServing?.(intent.attemptId) ?? null) !== null) {
      return commit(intent.attemptId);
    }
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
      launchedAttempts.delete(current.preparation.attemptId);
      return abort(current.preparation.attemptId);
    }
    if (options.launchPrepared === undefined) {
      return { kind: 'deferred', reason: 'succession launch capability is not installed' };
    }
    if (launchedAttempts.has(current.preparation.attemptId)) {
      return { kind: 'deferred', reason: 'successor launch is awaiting readiness' };
    }
    if (revalidateUpgradeIntentTarget(current.intent).kind !== 'validated') {
      return { kind: 'deferred', reason: 'target build no longer validates at launch' };
    }
    launchedAttempts.add(current.preparation.attemptId);
    try {
      await options.launchPrepared(current.intent, current.preparation);
    } catch (error: unknown) {
      launchedAttempts.delete(current.preparation.attemptId);
      const aborted = await abort(current.preparation.attemptId);
      if (aborted.kind !== 'aborted') return aborted;
      throw error;
    }
    return { kind: 'deferred', reason: 'successor launch is awaiting readiness' };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    options.runtime.time.clearInterval(retryTimer);
    unsubscribe?.();
  }

  async function request(input: { requestId: string; target: Target }): Promise<SuccessionDecision> {
    try {
      if (
        input.target.build.flavor !== options.incumbent.flavor ||
        compareProductVersions(input.target.build.version, options.incumbent.version) <= 0
      ) {
        return { kind: 'refused', reason: 'target does not strictly outrank the incumbent' };
      }
    } catch {
      return { kind: 'refused', reason: 'target or incumbent version is invalid' };
    }
    for (let retry = 0; retry < 8; retry++) {
      const observed = readUpgradeIntent(options.runDir);
      if (observed.kind !== 'absent' && observed.kind !== 'readable') {
        return { kind: 'refused', reason: `upgrade intent is ${observed.kind}` };
      }
      const current = observed.kind === 'readable' ? observed.intent : null;
      if (current !== null && current.disposition !== 'closed' && current.disposition !== 'completed') {
        if (current.attemptId !== null && (options.observeServing?.(current.attemptId) ?? null) !== null) {
          notifyObligationChange();
          return { kind: 'registered', intent: current };
        }
        let comparison: number;
        try {
          comparison = compareProductVersions(input.target.build.version, current.target.build.version);
        } catch {
          return { kind: 'refused', reason: 'pending target version is invalid' };
        }
        if (
          sameTarget(current.target, input.target) ||
          (current.target.build.flavor === input.target.build.flavor && comparison <= 0)
        ) {
          notifyObligationChange();
          return { kind: 'registered', intent: current };
        }
        if (current.target.build.flavor !== input.target.build.flavor) {
          return { kind: 'refused', reason: 'pending target has another build flavor' };
        }
      }
      const written = await compareAndSwapUpgradeIntent(options.runDir, current?.revision ?? null, {
        requestId: input.requestId,
        incumbent: options.incumbent,
        target: input.target,
        attemptId: null,
        attemptOwner: null,
        disposition: 'pending',
        blockers: [],
        retryCondition: null,
        attemptDeadline: null,
        completionReceipt: null,
        successionPreparation: null,
      });
      if (written.kind === 'conflict') continue;
      if (written.kind !== 'written') return { kind: 'refused', reason: `upgrade intent is ${written.kind}` };
      options.onIntentChanged?.();
      notifyObligationChange();
      return { kind: 'registered', intent: written.intent };
    }
    return { kind: 'deferred', reason: 'upgrade intent changed concurrently' };
  }

  async function prepare(requestId: string): Promise<SuccessionDecision> {
    for (let retry = 0; retry < 8; retry++) {
      const observed = readUpgradeIntent(options.runDir);
      if (observed.kind !== 'readable') return { kind: 'refused', reason: `upgrade intent is ${observed.kind}` };
      const intent = observed.intent;
      if (intent.requestId !== requestId || intent.disposition === 'closed' || intent.disposition === 'completed') {
        return { kind: 'refused', reason: 'upgrade request is no longer pending' };
      }
      if (incumbentKey(intent.incumbent) !== incumbentKey(options.incumbent)) {
        return { kind: 'refused', reason: 'incumbent identity changed' };
      }
      if (intent.attemptId !== null && (options.observeServing?.(intent.attemptId) ?? null) !== null) {
        return commit(intent.attemptId);
      }
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
          return { kind: 'refused', reason: targetFailure };
        }
        const written = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
          ...intent,
          disposition: 'deferred',
          blockers: [{ owner: 'target', reason: targetFailure }],
          retryCondition: { kind: 'target-change', evidence: targetFailure },
          attemptId: null,
          attemptOwner: null,
          successionPreparation: null,
        });
        if (written.kind === 'conflict') continue;
        if (written.kind !== 'written') return { kind: 'refused', reason: `upgrade intent is ${written.kind}` };
        options.onIntentChanged?.();
        return { kind: 'refused', reason: targetFailure };
      }
      if (declared === null) return { kind: 'refused', reason: 'target build no longer validates' };
      const capabilities = declared.kind === 'declared' ? declared.capabilities : emptyCapabilities(intent);
      const epochKey = options.epochKey();
      if (epochKey === null) return { kind: 'deferred', reason: 'exact store epoch is unavailable' };
      const formatChanges =
        options.storeFormatFingerprint !== undefined &&
        intent.target.build.storeFormatFingerprint !== options.storeFormatFingerprint;
      const liveJobs = formatChanges ? (options.liveJobIds?.() ?? []) : [];
      if (liveJobs.length > 0) {
        const blockers = liveJobs.map((jobId) => ({ owner: 'jobs', reason: `blocking(format): ${jobId}` }));
        const written = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
          ...intent,
          disposition: 'deferred',
          blockers,
          retryCondition: { kind: 'obligation-change', evidence: 'format-changing succession awaits job settlement' },
          successionPreparation: null,
          attemptId: null,
          attemptOwner: null,
        });
        if (written.kind === 'conflict') continue;
        if (written.kind !== 'written') return { kind: 'refused', reason: `upgrade intent is ${written.kind}` };
        options.onIntentChanged?.();
        return { kind: 'deferred', reason: 'format-changing succession awaits job settlement', blockers };
      }
      const admissionRevision = options.admissionRevision();
      const existing = readPreparation(intent);
      if (existing !== null && currentPreparation(intent, existing, options)) {
        const current = await prepareOwnerObligations(
          options.owners,
          existing.attemptId,
          capabilities,
          options.requiredOwners,
          options.liveJobIds,
        );
        if (
          current.kind === 'prepared' &&
          (!formatChanges || current.receipts.length === 0) &&
          JSON.stringify(current.receipts) === JSON.stringify(existing.receipts)
        ) {
          return { kind: 'prepared', preparation: existing };
        }
      }
      const attemptId = newAttemptId();
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
        const written = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
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
        });
        if (written.kind === 'conflict') continue;
        if (written.kind !== 'written') return { kind: 'refused', reason: `upgrade intent is ${written.kind}` };
        options.onIntentChanged?.();
        return { kind: 'deferred', reason: 'format-changing succession awaits obligation settlement', blockers };
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
        if (
          intent.disposition === 'deferred' &&
          intent.attemptId === null &&
          JSON.stringify(intent.blockers) === JSON.stringify(blockers) &&
          JSON.stringify(intent.retryCondition) === JSON.stringify(retryCondition)
        ) {
          return { kind: 'deferred', reason: 'succession obligations block preparation', blockers };
        }
        const written = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
          ...intent,
          disposition: 'deferred',
          blockers: [...blockers],
          retryCondition,
          successionPreparation: null,
          attemptId: null,
          attemptOwner: null,
        });
        if (written.kind === 'conflict') continue;
        if (written.kind !== 'written') return { kind: 'refused', reason: `upgrade intent is ${written.kind}` };
        options.onIntentChanged?.();
        return { kind: 'deferred', reason: 'succession obligations block preparation', blockers };
      }
      const preparation: SuccessionPreparation = {
        version: SUCCESSION_PROTOCOL_VERSION,
        requestId,
        attemptId,
        incumbentInstanceId: options.incumbent.instanceId,
        incumbentPid: options.incumbent.pid,
        incumbentKey: incumbentKey(options.incumbent),
        targetKey: targetKey(intent.target),
        capabilitiesKey: JSON.stringify(capabilities),
        epochKey,
        admissionRevision,
        accepts: capabilities.accepts,
        receipts: [...obligations.receipts],
        stage: 'prepared',
        ready: null,
      };
      if (!currentPreparation(intent, preparation, options)) continue;
      const written = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
        ...intent,
        disposition: 'pending',
        blockers: [],
        retryCondition: null,
        attemptId,
        attemptOwner: {
          kind: 'incumbent',
          instanceId: options.incumbent.instanceId,
          pid: options.incumbent.pid,
          incarnation: options.incumbent.incarnation,
        },
        successionPreparation: preparation,
      });
      if (written.kind === 'conflict') continue;
      if (written.kind !== 'written') return { kind: 'refused', reason: `upgrade intent is ${written.kind}` };
      options.onIntentChanged?.();
      return { kind: 'prepared', preparation };
    }
    return { kind: 'deferred', reason: 'upgrade intent changed concurrently' };
  }

  function status(requestId?: string): SuccessionStatus {
    const observed = readUpgradeIntent(options.runDir);
    if (observed.kind !== 'readable') return { kind: observed.kind };
    if (requestId !== undefined && observed.intent.requestId !== requestId) return { kind: 'absent' as const };
    return { kind: 'readable' as const, intent: observed.intent, preparation: readPreparation(observed.intent) };
  }

  async function reportReady(report: SuccessionReady): Promise<SuccessionDecision> {
    for (let retry = 0; retry < 8; retry++) {
      const observed = status();
      if (observed.kind !== 'readable') return { kind: 'refused', reason: 'upgrade intent unavailable' };
      const { intent, preparation } = observed;
      if (preparation === null || preparation.attemptId !== report.attemptId) {
        return { kind: 'refused', reason: 'attempt is not prepared' };
      }
      if (!currentPreparation(intent, preparation, options)) {
        return { kind: 'refused', reason: 'preparation is stale' };
      }
      const declaration = readSuccessionCapabilities(
        options.runtime,
        join(intent.target.pluginRootLabel, 'bridge'),
        intent.target.build,
      );
      if (declaration.kind !== 'declared' || !declaration.capabilities.protocols.includes('commit')) {
        return { kind: 'deferred', reason: 'target cannot commit succession' };
      }
      if (preparation.stage === 'ready' && JSON.stringify(preparation.ready) === JSON.stringify(report)) {
        return { kind: 'ready', preparation };
      }
      if (
        preparation.stage !== 'prepared' ||
        preparation.ready !== null ||
        report.successorPid === options.incumbent.pid ||
        report.targetKey !== preparation.targetKey ||
        report.epochKey !== preparation.epochKey ||
        report.admissionRevision !== preparation.admissionRevision ||
        JSON.stringify([...report.receiptIds].sort()) !==
          JSON.stringify(preparation.receipts.map((receipt) => receipt.receiptId).sort())
      ) {
        return { kind: 'refused', reason: 'successor ready report does not match the prepared attempt' };
      }
      const next: SuccessionPreparation = { ...preparation, stage: 'ready', ready: report };
      const written = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
        ...intent,
        successionPreparation: next,
      });
      if (written.kind === 'conflict') continue;
      if (written.kind !== 'written') return { kind: 'refused', reason: `upgrade intent is ${written.kind}` };
      options.onIntentChanged?.();
      notifyObligationChange();
      return { kind: 'ready', preparation: next };
    }
    return { kind: 'deferred', reason: 'upgrade intent changed concurrently' };
  }

  async function abort(attemptId: string): Promise<SuccessionDecision> {
    for (let retry = 0; retry < 8; retry++) {
      const observed = readUpgradeIntent(options.runDir);
      if (observed.kind !== 'readable') return { kind: 'refused', reason: `upgrade intent is ${observed.kind}` };
      const intent = observed.intent;
      if (intent.attemptId !== attemptId) return { kind: 'refused', reason: 'attempt is not current' };
      if (intent.disposition === 'completed') return { kind: 'refused', reason: 'attempt already serves' };
      if ((options.observeServing?.(attemptId) ?? null) !== null) return commit(attemptId);
      const written = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
        ...intent,
        disposition: 'pending',
        attemptId: null,
        attemptOwner: null,
        attemptDeadline: null,
        blockers: [],
        retryCondition: null,
        successionPreparation: null,
      });
      if (written.kind === 'conflict') continue;
      if (written.kind !== 'written') return { kind: 'refused', reason: `upgrade intent is ${written.kind}` };
      options.onIntentChanged?.();
      return { kind: 'aborted' };
    }
    return { kind: 'deferred', reason: 'upgrade intent changed concurrently' };
  }

  async function commit(attemptId: string): Promise<SuccessionDecision> {
    for (let retry = 0; retry < 8; retry++) {
      const observed = status();
      if (observed.kind !== 'readable') return { kind: 'refused', reason: 'upgrade intent unavailable' };
      if (observed.intent.disposition === 'completed' && observed.intent.completionReceipt?.attemptId === attemptId) {
        const receipt = observed.intent.completionReceipt;
        const serving = options.observeServing?.(attemptId);
        return serving !== null &&
          serving !== undefined &&
          serving.epochKey === receipt.epochKey &&
          serving.controlGeneration === receipt.controlGeneration &&
          serving.successorInstanceId === receipt.successor.instanceId
          ? { kind: 'committed', receipt }
          : { kind: 'deferred', reason: 'durable serving record is unavailable' };
      }
      const { intent, preparation } = observed;
      if (preparation === null || preparation.attemptId !== attemptId) {
        return { kind: 'refused', reason: 'attempt is not prepared' };
      }
      const serving = options.observeServing?.(attemptId);
      if (serving !== null && serving !== undefined) {
        if (
          preparation.ready === null ||
          preparation.targetKey !== targetKey(intent.target) ||
          (serving.epochKey !== preparation.epochKey &&
            !options.retirementServing?.(attemptId, preparation.epochKey, serving.epochKey)) ||
          serving.successorInstanceId.length === 0 ||
          !Number.isSafeInteger(serving.controlGeneration) ||
          serving.controlGeneration < 1 ||
          !Number.isFinite(Date.parse(serving.recordedAt)) ||
          (intent.attemptDeadline !== null && Date.parse(serving.recordedAt) > Date.parse(intent.attemptDeadline))
        ) {
          return { kind: 'deferred', reason: 'durable serving record does not match the prepared attempt' };
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
        const written = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
          ...intent,
          disposition: 'completed',
          completionReceipt: receipt,
        });
        if (written.kind === 'conflict') continue;
        if (written.kind !== 'written') return { kind: 'deferred', reason: `upgrade intent is ${written.kind}` };
        options.onIntentChanged?.();
        return { kind: 'committed', receipt };
      }
      if (!currentPreparation(intent, preparation, options)) {
        const declared = readSuccessionCapabilities(
          options.runtime,
          join(intent.target.pluginRootLabel, 'bridge'),
          intent.target.build,
        );
        const targetChanged =
          preparation.targetKey !== targetKey(intent.target) ||
          revalidateUpgradeIntentTarget(intent).kind !== 'validated' ||
          declared.kind === 'invalid' ||
          preparation.capabilitiesKey !==
            JSON.stringify(declared.kind === 'declared' ? declared.capabilities : emptyCapabilities(intent));
        const written = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
          ...intent,
          disposition: 'deferred',
          blockers: [{ owner: 'preparation', reason: 'preparation is stale' }],
          retryCondition: targetChanged
            ? { kind: 'target-change', evidence: 'target identity or capability declaration changed' }
            : { kind: 'obligation-change', evidence: 'epoch or admission revision changed' },
        });
        if (written.kind === 'conflict') continue;
        if (written.kind !== 'written') return { kind: 'refused', reason: `upgrade intent is ${written.kind}` };
        options.onIntentChanged?.();
        return { kind: 'refused', reason: 'preparation is stale' };
      }
      if (preparation.stage !== 'ready') return { kind: 'deferred', reason: 'successor has not reported ready' };
      return { kind: 'deferred', reason: 'awaiting durable serving record' };
    }
    return { kind: 'deferred', reason: 'upgrade intent changed concurrently' };
  }

  return { request, prepare, reportReady, commit, abort, status, reconcile, notifyObligationChange, dispose };
}
