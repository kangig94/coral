import type { AppServerRuntime, JobTerminal } from '../../../jobs/records.js';
import type { DurableCliRuntimeRecord, DurableProcessExit } from '../../../runtime/durable-runtime.js';
import type {
  ProviderRecoveryAuthority,
  ProviderRecoveryLaunch,
  ProviderRecoverySession,
} from '../../../jobs/reconcile/contracts.js';
import type { RecoveredAppServerFinalizationReason } from '../../../jobs/reconcile/interrupted-reason.js';
import type { ProviderContinuityBlob } from '../../../sessions/continuity.js';
import { readContinuityRef } from '../../../sessions/continuity.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';

export type ProviderOperationCarrierRecord = Extract<
  ProviderOperationRecord,
  { phase: 'executing' | 'settlement-pending' }
>;

type InterruptedRecoveryPlanBase = Readonly<{
  launchRecord: ProviderRecoveryLaunch;
  session: ProviderRecoverySession;
  runtimeRecord: AppServerRuntime;
  reason: RecoveredAppServerFinalizationReason;
  continuity: ProviderContinuityBlob | undefined;
  preservedConversationRef: string | undefined;
  expectedSessionVersion: number;
}>;

export type AppServerInterruptedRecoveryPlan =
  | (InterruptedRecoveryPlanBase & Readonly<{ kind: 'unsupported' }>)
  | (InterruptedRecoveryPlanBase & Readonly<{ kind: 'interrupted' }>)
  | (InterruptedRecoveryPlanBase &
      Readonly<{
        kind: 'carrier-detached';
        carrier: ProviderOperationCarrierRecord;
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

export function planInterruptedAppServerRecovery(
  authority: ProviderRecoveryAuthority,
  runtimeRecord: AppServerRuntime,
  reason: RecoveredAppServerFinalizationReason,
  capabilities: Readonly<{ recovery: boolean }>,
  providerOperation: ProviderOperationCarrierRecord | null,
): AppServerInterruptedRecoveryPlan {
  const { launchRecord, session } = authority;
  const continuity = session.providerContinuity ?? undefined;
  const common = {
    launchRecord,
    session,
    runtimeRecord,
    reason,
    continuity,
    preservedConversationRef: readContinuityRef(session.conversationRef),
    expectedSessionVersion: session.version,
  } as const;

  if (!capabilities.recovery) return Object.freeze({ ...common, kind: 'unsupported' });
  if (providerOperation !== null) {
    return Object.freeze({ ...common, kind: 'carrier-detached', carrier: providerOperation });
  }
  return Object.freeze({ ...common, kind: 'interrupted' });
}

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
