import { RecoveryContainment, type RecoveryPolicy, type RecoverySource } from '../recovery/containment.js';

type LifecycleRecoveryWalk<Raw, Item> = {
  readonly source: RecoverySource<Raw>;
  readonly policy: RecoveryPolicy<Raw, Item>;
};

/** Runs the AC13 crashed-job terminalization walk during hard shutdown. */
export async function runShutdownCrashTerminalization<Raw, Item>(
  walk: LifecycleRecoveryWalk<Raw, Item>,
): Promise<void> {
  await RecoveryContainment.each(walk.source, walk.policy);
}
