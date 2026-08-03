import {
  RecoveryContainment,
  type RecoveryPolicy,
  type RecoveryReceipt,
  type RecoverySource,
} from '../../recovery/containment.js';

export interface DiscussionCandidateSettlement<Coordinate> {
  settle(receipts: readonly RecoveryReceipt<Coordinate>[]): Promise<void>;
}

export type DiscussionStartupRecoveryPlan<Raw, Coordinate> = {
  readonly source: RecoverySource<Raw>;
  readonly sourcePolicy: RecoveryPolicy<Raw, Coordinate>;
  readonly candidates: DiscussionCandidateSettlement<Coordinate>;
};

/** Runs source discovery before handing only sealed coordinates to the candidate boundary. */
export async function runDiscussionStartupRecovery<Raw, Coordinate>(
  plan: DiscussionStartupRecoveryPlan<Raw, Coordinate>,
): Promise<void> {
  const sourceReport = await RecoveryContainment.each(plan.source, plan.sourcePolicy);
  await plan.candidates.settle(sourceReport.receipts);
}
