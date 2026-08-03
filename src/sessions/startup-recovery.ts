import {
  RecoveryContainment,
  type RecoveryPolicy,
  type RecoveryReceipt,
  type RecoverySource,
} from '../recovery/containment.js';
import type {
  RawPendingContinuationLeaseRow,
  SessionContinuationLeaseComponent,
} from './continuation-lease-recovery-source.js';
import type { RawSessionProjectionEnvelope, SessionProjectionComponent } from './projection-recovery-source.js';
import type {
  RawTerminalRetentionOutcomeRow,
  TerminalRetentionOutcomeComponent,
} from './terminal-retention-outcome-recovery-source.js';
import type {
  RawRetentionReleaseAndTerminalRow,
  RetentionReleasePairComponent,
} from './retention-release-pair-recovery-source.js';
import type { P4RetentionComponent } from './retention-work-item-recovery-source.js';

type ComponentPlan<Raw, Item> = {
  readonly source: RecoverySource<Raw>;
  readonly policy: RecoveryPolicy<Raw, Item>;
};

export interface SessionRetentionWorkSettlement {
  settle(receipts: readonly RecoveryReceipt<P4RetentionComponent>[]): Promise<void>;
}

export type SessionStartupRecoveryPlan = {
  readonly sessions: ComponentPlan<RawSessionProjectionEnvelope, SessionProjectionComponent>;
  readonly continuationLeases: ComponentPlan<RawPendingContinuationLeaseRow, SessionContinuationLeaseComponent>;
  readonly terminalOutcomes: ComponentPlan<RawTerminalRetentionOutcomeRow, TerminalRetentionOutcomeComponent>;
  readonly releasePairs: ComponentPlan<RawRetentionReleaseAndTerminalRow, RetentionReleasePairComponent>;
  readonly retentionWork: SessionRetentionWorkSettlement;
};

/** Walks every P4 component before exposing only their sealed receipts to the retention composite. */
export async function runSessionStartupRecovery(plan: SessionStartupRecoveryPlan): Promise<void> {
  const sessions = await RecoveryContainment.each(plan.sessions.source, plan.sessions.policy);
  const continuationLeases = await RecoveryContainment.each(
    plan.continuationLeases.source,
    plan.continuationLeases.policy,
  );
  const terminalOutcomes = await RecoveryContainment.each(plan.terminalOutcomes.source, plan.terminalOutcomes.policy);
  const releasePairs = await RecoveryContainment.each(plan.releasePairs.source, plan.releasePairs.policy);
  const receipts: readonly RecoveryReceipt<P4RetentionComponent>[] = [
    ...sessions.receipts,
    ...continuationLeases.receipts,
    ...terminalOutcomes.receipts,
    ...releasePairs.receipts,
  ];
  await plan.retentionWork.settle(receipts);
}
