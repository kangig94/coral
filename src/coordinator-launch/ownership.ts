import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { closeHandle } from '../infra/ipc-handle.js';
import { writeAuditEvent } from '../infra/audit-log.js';
import { type StrictBundleManifest } from '../infra/bundle-manifest.js';
import {
  attemptExclusiveFileLockSync,
  createSharedFileLockSync,
  repairMalformedFileLockSync,
  type FileLockLease,
} from '../infra/fs-lock.js';
import { currentLaunchStatus, updateLaunchStatus } from '../infra/launch-status.js';
import { probeProcessIncarnation } from '../infra/node-process.js';
import { supervisorLockPath } from '../infra/path/index.js';
import { readUpgradeIntent } from '../infra/upgrade-intent.js';
import { replacementServing } from './health.js';
import { observedLaunchIncumbent } from './incumbent.js';
import { recordLegacyUpgradeIntent } from './request.js';
import { SupervisorLaunchMemory, type LaunchOwner } from './state.js';
import { POLL_MS } from './timing.js';

export type OwnerHandle = { current: LaunchOwner; lost: boolean; release: FileLockLease };

type OwnershipAcquisition =
  | Readonly<{ kind: 'finished'; exitCode: 0 | 1 }>
  | Readonly<{
      kind: 'owned';
      record: SupervisorLaunchMemory;
      owner: OwnerHandle;
      incarnation: NonNullable<ReturnType<typeof probeProcessIncarnation>>;
      replacement: boolean;
      recoveryChallenge: string | undefined;
    }>;

function upgradeOutstanding(runDir: string, buildSetId: string): boolean {
  const observed = readUpgradeIntent(runDir);
  if (
    observed.kind !== 'readable' ||
    observed.intent.disposition === 'completed' ||
    observed.intent.disposition === 'closed'
  )
    return false;
  return (
    observed.intent.target.build.buildSetId === buildSetId ||
    observed.intent.nextTarget?.target.build.buildSetId === buildSetId
  );
}

function attemptLaunchLock(
  path: string,
  holdLock: (cause: unknown) => void,
): { kind: 'acquired'; lease: FileLockLease } | { kind: 'contended' } | { kind: 'retry'; immediate: boolean } {
  if (!existsSync(path)) {
    try {
      createSharedFileLockSync(path)();
    } catch (cause: unknown) {
      holdLock(cause);
      return { kind: 'retry', immediate: false };
    }
  }
  const attempt = attemptExclusiveFileLockSync(path);
  if (attempt.kind === 'acquired') return attempt;
  if (attempt.kind === 'malformed') {
    const repair = repairMalformedFileLockSync(path);
    if (repair.kind === 'unobservable') holdLock(repair.cause);
    else if (repair.kind !== 'moved-aside') holdLock(repair.kind);
    if (repair.kind === 'moved-aside') {
      writeAuditEvent('supervisor_lock_moved_aside', { path, quarantinePath: repair.quarantinePath }, 'warn');
      return { kind: 'retry', immediate: true };
    }
    return { kind: 'retry', immediate: false };
  }
  if (attempt.kind === 'unobservable') {
    holdLock(attempt.cause);
    return { kind: 'retry', immediate: false };
  }
  return { kind: 'contended' };
}

function claimLaunchOwnership(
  runDir: string,
  manifest: StrictBundleManifest,
  incarnation: NonNullable<ReturnType<typeof probeProcessIncarnation>>,
  replacement: boolean,
  recoveryChallenge: string | undefined,
  lease: FileLockLease,
): OwnershipAcquisition {
  try {
    updateLaunchStatus(runDir, (status) => ({ ...status, lockHold: undefined }));
    const record = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, manifest.buildSetId);
    if (replacement) process.send?.({ kind: 'coral-recovery-owned', challenge: recoveryChallenge });
    else if (process.env.CORAL_OBSERVATION_CHALLENGE !== undefined)
      process.send?.({ kind: 'coral-observation-owned', challenge: process.env.CORAL_OBSERVATION_CHALLENGE });
    return {
      kind: 'owned',
      record,
      owner: { current: record.read().owner, lost: false, release: record.authorityLease(lease) },
      incarnation,
      replacement,
      recoveryChallenge,
    };
  } catch (error: unknown) {
    lease();
    throw error;
  }
}

async function requestContendedUpgrade(
  runDir: string,
  executable: string,
  manifest: StrictBundleManifest,
): Promise<'finished' | 'waiting' | 'retry'> {
  const incumbent = observedLaunchIncumbent(runDir, manifest.flavor);
  if (incumbent !== null && incumbent.version === manifest.version && incumbent.bundleHash === manifest.bundleHash) {
    if ((await replacementServing(runDir, manifest.flavor, incumbent.pid)) === true) return 'finished';
  } else if (incumbent !== null) {
    const recorded = await recordLegacyUpgradeIntent({
      runDir,
      requestId: randomUUID(),
      incumbent,
      target: { build: manifest, pluginRootLabel: dirname(dirname(executable)) },
    });
    if (recorded.kind !== 'refused' || recorded.disposition !== 'deferred') {
      if (recorded.kind !== 'waiting') return 'finished';
      return 'waiting';
    }
  }
  return 'retry';
}

function observeReplacementLaunchOffer() {
  const sourcePid = Number(process.env.CORAL_RECOVERY_SOURCE_PID);
  const recoveryChallenge = process.env.CORAL_RECOVERY_CHALLENGE;
  const sourceIncarnation = process.env.CORAL_RECOVERY_SOURCE_INCARNATION;
  const replacement =
    Number.isSafeInteger(sourcePid) &&
    sourcePid > 0 &&
    recoveryChallenge !== undefined &&
    sourceIncarnation !== undefined;
  let offered = false;
  const onOffer = (message: unknown, handle: unknown): void => {
    closeHandle(handle);
    if (
      !replacement ||
      process.ppid !== sourcePid ||
      probeProcessIncarnation(sourcePid) !== sourceIncarnation ||
      typeof message !== 'object' ||
      message === null ||
      !('kind' in message) ||
      message.kind !== 'coral-recovery-offer' ||
      !('challenge' in message) ||
      message.challenge !== recoveryChallenge
    )
      return;
    offered = true;
  };
  if (replacement) {
    process.on('message', onOffer);
    process.send?.({ kind: 'coral-recovery-ready', challenge: recoveryChallenge });
  }
  return {
    replacement,
    sourcePid,
    recoveryChallenge,
    offered: () => offered,
    release: () => {
      if (replacement) process.off('message', onOffer);
    },
  };
}

function launchParentAuthorityLost({
  replacement,
  sourcePid,
}: ReturnType<typeof observeReplacementLaunchOffer>): boolean {
  return (
    ((replacement || process.env.CORAL_OBSERVATION_CHALLENGE !== undefined) && !process.connected) ||
    (replacement && process.ppid !== sourcePid)
  );
}

function recordLaunchLockHold(
  runDir: string,
  path: string,
  { replacement, recoveryChallenge }: ReturnType<typeof observeReplacementLaunchOffer>,
  cause: unknown,
): void {
  updateLaunchStatus(runDir, (status) => ({
    ...status,
    lockHold: { path, disposition: 'supervisor-lock-unobservable', observation: String(cause) },
  }));
  const status = currentLaunchStatus(runDir);
  if (replacement && status !== undefined)
    process.send?.({ kind: 'coral-launch-status', challenge: recoveryChallenge, status });
}

type LaunchOwnershipAttempt = Readonly<{
  runDir: string;
  manifest: StrictBundleManifest;
  incarnation: NonNullable<ReturnType<typeof probeProcessIncarnation>>;
  gate: ReturnType<typeof observeReplacementLaunchOffer>;
  path: string;
  holdLock: (cause: unknown) => void;
}>;

function attemptLaunchOwnership(
  { runDir, manifest, incarnation, gate: { replacement, recoveryChallenge }, path, holdLock }: LaunchOwnershipAttempt,
  requested: boolean,
): OwnershipAcquisition | { kind: 'retry'; immediate: boolean } | { kind: 'contended' } {
  if (requested && !upgradeOutstanding(runDir, manifest.buildSetId)) return { kind: 'finished', exitCode: 0 };
  const attempt = attemptLaunchLock(path, holdLock);
  if (attempt.kind === 'acquired')
    return claimLaunchOwnership(runDir, manifest, incarnation, replacement, recoveryChallenge, attempt.lease);
  if (attempt.kind === 'retry') return attempt;
  if (!replacement && process.env.CORAL_OBSERVATION_CHALLENGE !== undefined) {
    process.send?.({ kind: 'coral-observation-owned', challenge: process.env.CORAL_OBSERVATION_CHALLENGE });
    return { kind: 'finished', exitCode: 0 };
  }
  if (replacement || requested) return { kind: 'retry', immediate: false };
  return { kind: 'contended' };
}

export async function acquireLaunchOwnership(
  runDir: string,
  executable: string,
  manifest: StrictBundleManifest,
): Promise<OwnershipAcquisition> {
  const incarnation = probeProcessIncarnation(process.pid);
  if (incarnation === null) return { kind: 'finished', exitCode: 1 };
  const gate = observeReplacementLaunchOffer();
  try {
    const path = supervisorLockPath(runDir);
    const holdLock = (cause: unknown): void => recordLaunchLockHold(runDir, path, gate, cause);
    const context = { runDir, manifest, incarnation, gate, path, holdLock };
    let requested = false;
    for (let retry = 0; !gate.replacement || retry < 150; retry += 1) {
      if (launchParentAuthorityLost(gate)) return { kind: 'finished', exitCode: 1 };
      if (gate.replacement && !gate.offered()) {
        await sleep(POLL_MS);
        continue;
      }
      const attempt = attemptLaunchOwnership(context, requested);
      if (attempt.kind === 'owned' || attempt.kind === 'finished') return attempt;
      if (attempt.kind === 'retry') {
        if (!attempt.immediate) await sleep(POLL_MS);
        continue;
      }
      const negotiation = await requestContendedUpgrade(runDir, executable, manifest);
      if (negotiation === 'finished') return { kind: 'finished', exitCode: 0 };
      if (negotiation === 'waiting') {
        requested = true;
        continue;
      }
      await sleep(POLL_MS);
    }
    return { kind: 'finished', exitCode: 1 };
  } finally {
    gate.release();
  }
}
