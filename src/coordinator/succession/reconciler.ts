import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { compareProductVersions } from '../../infra/product-version.js';
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
  runDir: string;
  incumbent: IncumbentIdentity;
  owners: readonly SuccessionOwner[];
  requiredOwners?: readonly SuccessionOwnerId[];
  epochKey: () => string | null;
  admissionRevision: () => number;
  newAttemptId?: () => string;
  observeServing?: (attemptId: string) => Readonly<{
    epochKey: string;
    controlGeneration: number;
    successorInstanceId: string;
  }> | null;
  onIntentChanged?: () => void;
  onReconcileError?: (error: unknown) => void;
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
  const declaration = readSuccessionCapabilities(join(intent.target.pluginRootLabel, 'bridge'), intent.target.build);
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
  const newAttemptId = options.newAttemptId ?? randomUUID;
  const schedulePreparation = (requestId: string): void => {
    queueMicrotask(() => {
      void prepare(requestId).catch((error: unknown) => options.onReconcileError?.(error));
    });
  };

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
          schedulePreparation(current.requestId);
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
      schedulePreparation(input.requestId);
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
      const validated = revalidateUpgradeIntentTarget(intent);
      const declared =
        validated.kind === 'validated'
          ? readSuccessionCapabilities(join(intent.target.pluginRootLabel, 'bridge'), intent.target.build)
          : null;
      const targetFailure =
        validated.kind !== 'validated'
          ? 'target build no longer validates'
          : declared?.kind === 'invalid'
            ? 'target succession declaration is invalid'
            : null;
      if (targetFailure !== null) {
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
      const admissionRevision = options.admissionRevision();
      const existing = readPreparation(intent);
      if (existing !== null && currentPreparation(intent, existing, options)) {
        return { kind: 'prepared', preparation: existing };
      }
      const attemptId = newAttemptId();
      const obligations = await prepareOwnerObligations(
        options.owners,
        attemptId,
        capabilities,
        options.requiredOwners,
      );
      if (obligations.kind === 'blocking' || !capabilities.protocols.includes('prepare')) {
        const blockers =
          obligations.kind === 'blocking'
            ? obligations.blockers
            : [{ owner: 'protocol', reason: 'target cannot prepare succession' }];
        const written = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
          ...intent,
          disposition: 'deferred',
          blockers: [...blockers],
          retryCondition:
            declared.kind === 'absent' || !capabilities.protocols.includes('prepare')
              ? { kind: 'target-change', evidence: 'target succession declaration changes' }
              : { kind: 'obligation-change', evidence: 'owner disposition changes' },
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
      if (!currentPreparation(intent, preparation, options)) {
        const declared = readSuccessionCapabilities(join(intent.target.pluginRootLabel, 'bridge'), intent.target.build);
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
      // Commit cannot advance until exact-epoch open, writer fencing, and succession release exist.
      return { kind: 'deferred', reason: 'succession commit capability is not released' };
    }
    return { kind: 'deferred', reason: 'upgrade intent changed concurrently' };
  }

  return { request, prepare, reportReady, commit, abort, status };
}
