import {
  RecoveryContainment,
  type RecoveryPolicy,
  type RecoveryReport,
  type RecoverySource,
} from '../../../recovery/containment.js';

export type CoordinatorJobRecoveryPlan<Raw, Item> = {
  readonly source: RecoverySource<Raw>;
  readonly policy: RecoveryPolicy<Raw, Item>;
};

/** Names the AC3 seal anchor for coordinator job reachability before delegating to shared containment. */
export function runCoordinatorJobRecovery<Raw, Item>(
  plan: CoordinatorJobRecoveryPlan<Raw, Item>,
): Promise<RecoveryReport<Item>> {
  return RecoveryContainment.each(plan.source, plan.policy);
}
