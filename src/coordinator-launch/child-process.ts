import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { updateLaunchStatus } from '../infra/launch-status.js';
import { incarnationMayAuthorizeSignal, probeProcessIncarnation } from '../infra/node-process.js';
import { SENTINEL_TIMING } from '../infra/sentinel-timing.js';
import { validatedExecutable } from './executable.js';
import { type OwnerHandle } from './ownership.js';
import {
  type SupervisorLaunchMemory,
  type ChildRetirement,
  type LaunchOwner,
  type LaunchProcess,
  type LaunchReservation,
} from './state.js';

export type RunningChild = Readonly<{
  child: ChildProcess;
  identity: LaunchProcess;
  sentinelId: string;
  executable: string;
  manifest: StrictBundleManifest;
}>;

export function retireOwnedChild(
  record: SupervisorLaunchMemory,
  owner: OwnerHandle,
  reservation: LaunchReservation,
  running: RunningChild,
  retirement: ChildRetirement,
  graceMs: number,
): void {
  const now = Date.now();
  if (!record.commitTermination(owner.current, reservation, running.identity, now, graceMs)) return;
  retirement.at ??= now;
  try {
    if (
      terminationCommitted(record, owner.current, reservation, running.identity) &&
      probeProcessIncarnation(running.identity.pid) === running.identity.incarnation
    )
      if (running.child.kill('SIGTERM')) record.recordTerminationDelivery(owner.current, reservation, 'SIGTERM');
  } catch {
    return;
  }
}

export function terminationCommitted(
  record: SupervisorLaunchMemory,
  owner: LaunchOwner,
  reservation: LaunchReservation,
  identity: LaunchProcess,
): boolean {
  const slot = record.currentChild(reservation, identity);
  return (
    record.canTerminateChild(owner, reservation, identity) &&
    slot?.terminationAt !== undefined &&
    slot.child?.pid === identity.pid &&
    slot.child.incarnation === identity.incarnation
  );
}

export function signalInheritedChild(
  record: SupervisorLaunchMemory,
  owner: LaunchOwner,
  slot: LaunchReservation,
  signal: 'SIGTERM' | 'SIGKILL',
): boolean {
  const child = slot.child;
  if (child === undefined || !record.supervisionEligible(slot) || !incarnationMayAuthorizeSignal(process.platform))
    return false;
  if (!terminationCommitted(record, owner, slot, child) || probeProcessIncarnation(child.pid) !== child.incarnation)
    return false;
  try {
    process.kill(child.pid, signal);
    record.recordTerminationDelivery(owner, slot, signal);
    return true;
  } catch {
    return false;
  }
}

export function spawnAdmittedChild(
  record: SupervisorLaunchMemory,
  owner: LaunchOwner,
  reservation: LaunchReservation,
  executable: string,
  args: readonly string[],
  runDir: string,
  attemptId?: string,
): RunningChild | null {
  if (!record.hasAuthority(owner)) return null;
  const manifest = validatedExecutable(executable);
  if (manifest === null) {
    record.cancelReservation(reservation);
    return null;
  }
  const sentinelId = randomUUID();
  const legacy = !existsSync(join(dirname(executable), 'coral-sentinel.cjs'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CORAL_LAUNCH_ADMISSION: '1',
    CORAL_LAUNCH_PURPOSE: reservation.purpose,
    CORAL_SENTINEL_ID: sentinelId,
    CORAL_SENTINEL_RUN_DIR: runDir,
    CORAL_STARTUP_ATTEMPT_ID: attemptId ?? process.env.CORAL_STARTUP_ATTEMPT_ID ?? randomUUID(),
  };
  delete env.CORAL_LAUNCH_ID;
  if (attemptId === undefined) delete env.CORAL_SUCCESSION_ATTEMPT_ID;
  else env.CORAL_SUCCESSION_ATTEMPT_ID = attemptId;
  const child = spawn(
    process.execPath,
    legacy ? [process.argv[1], '--launch-legacy', executable, ...args] : [executable, ...args],
    {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
  child.on('error', (error) => process.stderr.write(`Coordinator spawn failed: ${String(error)}\n`));
  const pid = child.pid;
  const incarnation = pid === undefined ? null : probeProcessIncarnation(pid);
  if (pid === undefined || incarnation === null) {
    let identity: LaunchProcess | null = null;
    const finish = (): void => {
      clearInterval(retry);
      record.cancelReservation(reservation);
      if (record.hasAuthority(owner)) record.clearSignalRefusal(reservation);
    };
    const retireUnidentifiedChild = (): void => {
      if (!record.hasAuthority(owner) || child.exitCode !== null || child.signalCode !== null) return;
      if (pid === undefined) return;
      const observed = probeProcessIncarnation(pid);
      if (observed === null) {
        updateLaunchStatus(runDir, (status) => ({
          ...status,
          signalHolds: [
            ...status.signalHolds.filter((hold) => hold.launchId !== reservation.id),
            {
              launchId: reservation.id,
              pid,
              incarnation: identity?.incarnation ?? 'unavailable',
              observation: 'unknown',
            },
          ],
        }));
        return;
      }
      identity ??= { pid, incarnation: observed };
      if (record.currentChild(reservation, identity) === null && !record.spawned(reservation, owner.process, identity))
        return;
      if (!record.commitTermination(owner, reservation, identity, Date.now(), SENTINEL_TIMING.graceMs)) return;
      if (
        !terminationCommitted(record, owner, reservation, identity) ||
        probeProcessIncarnation(pid) !== identity.incarnation
      )
        return;
      const current = record.currentChild(reservation, identity);
      const signal = current?.termDelivered === true ? 'SIGKILL' : 'SIGTERM';
      if (signal === 'SIGKILL' && !record.terminationGraceElapsed(reservation)) return;
      try {
        if (child.kill(signal)) {
          record.recordTerminationDelivery(owner, reservation, signal);
          record.clearSignalRefusal(reservation);
        } else record.holdSignalRefusal(owner, reservation, identity);
      } catch {
        record.holdSignalRefusal(owner, reservation, identity);
      }
    };
    const retry = setInterval(retireUnidentifiedChild, 1_000);
    child.once('exit', finish);
    if (pid === undefined) finish();
    return null;
  }
  if (!record.spawned(reservation, owner.process, { pid, incarnation }))
    throw new Error('Spawned child lost its reservation');
  return { child, identity: { pid, incarnation }, sentinelId, executable, manifest };
}
