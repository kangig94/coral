import { join } from 'node:path';

import { SUCCESSION_CAPABILITY_VERSION } from '../../../infra/bundle-manifest-address.js';
import { SUCCESSION_PROTOCOL_VERSION } from '../../../infra/succession-address.js';
import {
  revalidateUpgradeIntentTarget,
  type UpgradeIntent,
  type UpgradeIntentCasStep,
  type UpgradeIntentChange,
  type UpgradeIntentRead,
} from '../../../infra/upgrade-intent.js';
import {
  readSuccessionCapabilities,
  successionPreparationSchema,
  successionTargetKey,
  type SuccessionCapabilities,
  type SuccessionPreparation,
} from '../protocol.js';
import {
  incumbentKey,
  recordsSelf,
  classifyTargetCustody,
  settle,
  committing,
  holdsRecovery,
  LAUNCH_IN_FLIGHT,
  RECOVERY_HOLDS_INTENT,
} from '../intent-transitions.js';
import { REQUIRED_SUCCESSION_OWNERS, prepareOwnerObligations } from '../obligations.js';
import type { SuccessionDecision, SuccessionReconcilerOptions } from './index.js';

export function readPreparation(intent: UpgradeIntent): SuccessionPreparation | null {
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

export function currentPreparation(
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

export function staleCause(
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

export function emptyCapabilities(intent: UpgradeIntent): SuccessionCapabilities {
  return {
    version: SUCCESSION_CAPABILITY_VERSION,
    buildSetId: intent.target.build.buildSetId,
    bundleHash: intent.target.build.bundleHash,
    protocols: [],
    accepts: [],
  };
}

type PreparationWrite = (
  intent: UpgradeIntent,
  change: UpgradeIntentChange,
  decision: SuccessionDecision,
) => UpgradeIntentCasStep<SuccessionDecision>;

type PreparedTarget = Readonly<{
  kind: 'target';
  capabilities: SuccessionCapabilities;
  declared: ReturnType<typeof readSuccessionCapabilities>;
  epochKey: string;
  formatChanges: boolean;
}>;

function inspectPreparationTarget(
  intent: UpgradeIntent,
  options: SuccessionReconcilerOptions,
  writeThen: PreparationWrite,
): PreparedTarget | UpgradeIntentCasStep<SuccessionDecision> {
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
  return { kind: 'target', capabilities, declared, epochKey, formatChanges };
}

async function prepareAttemptObligations(input: {
  intent: UpgradeIntent;
  target: PreparedTarget;
  options: SuccessionReconcilerOptions;
  heldAttempts: Set<string>;
  preparingAttempts: Map<string, number>;
  attemptFor: (intent: UpgradeIntent) => string;
  clearPendingAttempt: () => void;
  writeThen: PreparationWrite;
}): Promise<
  | UpgradeIntentCasStep<SuccessionDecision>
  | Readonly<{ kind: 'prepared'; attemptId: string; receipts: readonly SuccessionPreparation['receipts'][number][] }>
> {
  const { intent, target, options, heldAttempts, preparingAttempts, attemptFor, clearPendingAttempt, writeThen } =
    input;
  const { capabilities, formatChanges } = target;
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
      target.declared.kind === 'absent' || !capabilities.protocols.includes('prepare')
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
  return { kind: 'prepared', attemptId, receipts: obligations.receipts };
}

/** Preparation cannot release an owner until its receipt and recovery grant are durably bound to the attempt. */
export async function prepareObservedIntent({
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
  const target = inspectPreparationTarget(intent, options, writeThen);
  if (target.kind !== 'target') return target;
  const { capabilities, formatChanges, epochKey } = target;
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
  const preparedOwners = await prepareAttemptObligations({
    intent,
    target,
    options,
    heldAttempts,
    preparingAttempts,
    attemptFor,
    clearPendingAttempt,
    writeThen,
  });
  if (preparedOwners.kind !== 'prepared') return preparedOwners;
  const { attemptId, receipts } = preparedOwners;
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
    receipts: [...receipts],
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
