import {
  RecoveryContainment,
  type RecoveryPolicy,
  type RecoveryReport,
  type RecoverySource,
} from '../recovery/containment.js';

export type WorkflowStartupRecoveryPlan<Raw, Item> = {
  readonly source: RecoverySource<Raw>;
  readonly policy: RecoveryPolicy<Raw, Item>;
};

/** Names the AC3 seal anchor for P6/P7 workflow reachability before delegating to shared containment. */
export function runWorkflowStartupRecovery<Raw, Item>(
  plan: WorkflowStartupRecoveryPlan<Raw, Item>,
): Promise<RecoveryReport<Item>> {
  return RecoveryContainment.each(plan.source, plan.policy);
}
