import { join } from 'node:path';

import { type SentinelTiming } from '../infra/sentinel-timing.js';
import { type RunningChild, spawnAdmittedChild } from './child-process.js';
import { watchChild, type WatchResult } from './child-watch.js';
import { validatedExecutable } from './executable.js';
import { replacementServing } from './health.js';
import { type OwnerHandle } from './ownership.js';
import { type SupervisorLaunchMemory, type ChildRetirement, type LaunchReservation } from './state.js';

type SuccessionAttemptLaunch = Readonly<{
  reservation: LaunchReservation;
  running: RunningChild;
  retirement: ChildRetirement;
  watch: Promise<WatchResult>;
}>;

export async function launchSuccessionAttempt(input: {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  runDir: string;
  bundleDir: string;
  attemptId: string;
  timing: SentinelTiming;
  startupBudgetMs: number;
  repair?: boolean;
  beforeReserve?: () => Promise<void>;
  route: (running: RunningChild, message: unknown, handle: unknown) => boolean;
  forwardParentMessages: boolean;
  onExit: (attempt: SuccessionAttemptLaunch, result: WatchResult) => void;
}): Promise<SuccessionAttemptLaunch> {
  const authority = input.owner.current;
  if (input.owner.lost || !input.record.hasAuthority(authority)) throw new Error('Launch ownership was lost');
  const executable = join(input.bundleDir, 'coral-backend.cjs');
  const manifest = validatedExecutable(executable);
  if (manifest === null) throw new Error('Succession target is unavailable');
  await input.beforeReserve?.();
  if (input.owner.lost || !input.record.hasAuthority(authority)) throw new Error('Launch ownership was lost');
  const launch = input.record.read().launch;
  if (launch?.phase === 'admitted' && launch.child !== undefined) {
    const healthy = await replacementServing(input.runDir, manifest.flavor, launch.child.pid);
    if (!input.record.hasAuthority(authority)) throw new Error('Launch ownership was lost');
    if (healthy) input.record.serving(launch, launch.child);
  }
  const active = input.record.read().attempt;
  if (active !== null && active.phase !== 'exited') throw new Error('Succession attempt is already active');
  const reservation =
    input.repair && launch?.child !== undefined
      ? input.record.reserveRepairSuccession(input.owner.current, manifest.buildSetId, launch.child)
      : input.record.reserve(input.owner.current, manifest.buildSetId, 'succession');
  if (reservation === null) throw new Error('Succession reservation was refused');
  const running = spawnAdmittedChild(
    input.record,
    input.owner.current,
    reservation,
    executable,
    [],
    input.runDir,
    input.attemptId,
  );
  if (running === null) throw new Error('Succession child did not spawn');
  const retirement = input.record.childRetirement(reservation);
  const watch = watchChild({
    running,
    reservation,
    record: input.record,
    runDir: input.runDir,
    owner: input.owner,
    timing: input.timing,
    startupBudgetMs: input.startupBudgetMs,
    retirement,
    route: (message, handle) => input.route(running, message, handle),
    forwardParentMessages: input.forwardParentMessages,
  });
  const attempt = { reservation, running, retirement, watch };
  void watch.then((result) => input.onExit(attempt, result));
  return attempt;
}
