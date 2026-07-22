import type { ProviderRequest } from '../../../providers/contract.js';
import type { AppServerRuntime, JobTerminal } from '../../../jobs/records.js';
import type { DurableCliRuntimeRecord, DurableProcessExit } from '../../../runtime/durable-runtime.js';
import type {
  ProviderRecoveryAuthority,
  ProviderRecoveryLaunch,
  ProviderRecoverySession,
} from '../../../jobs/reconcile/contracts.js';
import type { InterruptedAppServerReason } from '../../../jobs/reconcile/interrupted-reason.js';
import type { ProviderContinuityBlob } from '../../../sessions/continuity.js';
import { readContinuityRef } from '../../../sessions/continuity.js';
import { toProviderRequest } from '../../../jobs/provider-request.js';

type InterruptedRecoveryPlanBase = Readonly<{
  launchRecord: ProviderRecoveryLaunch;
  session: ProviderRecoverySession;
  runtimeRecord: AppServerRuntime;
  reason: InterruptedAppServerReason;
  request: ProviderRequest;
  continuity: ProviderContinuityBlob | undefined;
  preservedConversationRef: string | undefined;
  expectedSessionVersion: number;
}>;

export type AppServerInterruptedRecoveryPlan =
  | (InterruptedRecoveryPlanBase & Readonly<{ kind: 'unsupported' }>)
  | (InterruptedRecoveryPlanBase & Readonly<{ kind: 'waiting' }>)
  | (InterruptedRecoveryPlanBase & Readonly<{ kind: 'artifacts' }>)
  | (InterruptedRecoveryPlanBase &
      Readonly<{
        kind: 'probe';
        continuity: ProviderContinuityBlob;
        hostRef: Extract<AppServerRuntime['providerMeta'], { leaseState: 'acquired' }>['hostRef'];
      }>);

type DurableInterruptedRecoveryPlanBase = Readonly<{
  launchRecord: ProviderRecoveryLaunch;
  session: ProviderRecoverySession;
  runtimeRecord: DurableCliRuntimeRecord;
  expectedSessionVersion: number;
}>;

export type DurableInterruptedRecoveryPlan =
  | (DurableInterruptedRecoveryPlanBase & Readonly<{ kind: 'durable-persisted'; terminal: JobTerminal }>)
  | (DurableInterruptedRecoveryPlanBase & Readonly<{ kind: 'durable-artifacts'; exit: DurableProcessExit }>)
  | (DurableInterruptedRecoveryPlanBase & Readonly<{ kind: 'durable-aborted' }>)
  | (DurableInterruptedRecoveryPlanBase & Readonly<{ kind: 'durable-unsupported' }>)
  | (DurableInterruptedRecoveryPlanBase & Readonly<{ kind: 'durable-wrapper-lost' }>);

/** Classifies an interrupted app-server snapshot without performing provider, host, filesystem, or Journal effects. */
export function planInterruptedAppServerRecovery(
  authority: ProviderRecoveryAuthority,
  runtimeRecord: AppServerRuntime,
  reason: InterruptedAppServerReason,
  capabilities: Readonly<{ recovery: boolean; probe: boolean }>,
): AppServerInterruptedRecoveryPlan {
  const { launchRecord, session } = authority;
  const continuity = session.providerContinuity ?? undefined;
  const common = {
    launchRecord,
    session,
    runtimeRecord,
    reason,
    request: toProviderRequest(launchRecord, session.conversationRef),
    continuity,
    preservedConversationRef: readContinuityRef(session.conversationRef),
    expectedSessionVersion: session.version,
  } as const;

  if (!capabilities.recovery) return Object.freeze({ ...common, kind: 'unsupported' });
  if (runtimeRecord.providerMeta.leaseState === 'waiting') {
    return Object.freeze({ ...common, kind: 'waiting' });
  }
  if (!capabilities.probe || continuity === undefined) {
    return Object.freeze({ ...common, kind: 'artifacts' });
  }
  return Object.freeze({
    ...common,
    kind: 'probe',
    continuity,
    hostRef: runtimeRecord.providerMeta.hostRef,
  });
}

/** Selects one immutable durable recovery route from already-persisted observations and captured capabilities. */
export function planInterruptedDurableRecovery(
  authority: ProviderRecoveryAuthority,
  runtimeRecord: DurableCliRuntimeRecord,
  observation: Readonly<{
    exit: DurableProcessExit | null;
    terminal: JobTerminal | null;
    cancelled: boolean;
  }>,
  capabilities: Readonly<{ recovery: boolean }>,
): DurableInterruptedRecoveryPlan {
  const common = {
    launchRecord: authority.launchRecord,
    session: authority.session,
    runtimeRecord,
    expectedSessionVersion: authority.session.version,
  } as const;

  if (observation.terminal !== null) {
    return Object.freeze({ ...common, kind: 'durable-persisted', terminal: observation.terminal });
  }
  if (observation.exit !== null) {
    return capabilities.recovery
      ? Object.freeze({ ...common, kind: 'durable-artifacts', exit: observation.exit })
      : Object.freeze({ ...common, kind: 'durable-unsupported' });
  }
  if (observation.cancelled) {
    return Object.freeze({ ...common, kind: 'durable-aborted' });
  }
  return capabilities.recovery
    ? Object.freeze({ ...common, kind: 'durable-wrapper-lost' })
    : Object.freeze({ ...common, kind: 'durable-unsupported' });
}
