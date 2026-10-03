import { type ChildProcess, type SendHandle } from 'node:child_process';

import { type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { attemptExclusiveFileLockSync } from '../infra/fs-lock.js';
import { readLaunchAdmission } from '../infra/launch-admission-record.js';
import { currentLaunchStatus } from '../infra/launch-status.js';
import { observeProcessLiveness, probeProcessIncarnation } from '../infra/node-process.js';
import { supervisorLockPath } from '../infra/path/index.js';
import { type SentinelTiming } from '../infra/sentinel-timing.js';
import { type RunningChild, terminationCommitted } from './child-process.js';
import { childIsUninterruptible } from './child-state.js';
import { replacementServing } from './health.js';
import { removeExitedChildDiscovery } from './incumbent.js';
import { closeHandle } from '../infra/ipc-handle.js';
import { type OwnerHandle } from './ownership.js';
import {
  type SupervisorLaunchMemory,
  type ChildRetirement,
  type ChildWatchState,
  type LaunchProcess,
  type LaunchReservation,
} from './state.js';
import { POLL_MS } from './timing.js';

export type WatchResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  served: boolean;
  wedged: boolean;
}>;

type WatchChildContext = Readonly<{
  running: RunningChild;
  reservation: LaunchReservation;
  record: SupervisorLaunchMemory;
  runDir: string;
  owner: OwnerHandle;
  timing: SentinelTiming;
  startupBudgetMs: number;
  retirement: ChildRetirement;
  route?: (message: unknown, handle: unknown) => boolean;
  forwardParentMessages?: boolean;
}>;

function monitorChildHeartbeat(input: {
  child: ChildProcess;
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  reservation: LaunchReservation;
  identity: LaunchProcess;
  timing: SentinelTiming;
  retirement: ChildRetirement;
  state: ChildWatchState;
  escalateChild: () => 'sent' | 'absent' | 'held' | 'refused';
}): void {
  const { child, record, owner, reservation, identity, timing, retirement, state, escalateChild } = input;
  const now = Number(process.hrtime.bigint() / 1_000_000n);
  const gap = now - state.lastWake;
  state.lastWake = now;
  if (gap > timing.schedulingGapMs) {
    state.lastAnswer = now;
    state.outstanding = null;
    state.startupDeadline += gap;
  }
  if (record.read().owner.id !== owner.current.id) {
    owner.lost = true;
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (owner.lost || !record.hasAuthority(owner.current)) return;
  state.escalationAt ??= retirement.at;
  if (state.escalationAt !== null) {
    if (!state.killed && now - state.lastKillAttemptAt >= 1_000) {
      state.lastKillAttemptAt = now;
      if (escalateChild() === 'sent') state.killed = true;
    }
    return;
  }
  state.disconnectedAt = child.connected ? null : (state.disconnectedAt ?? now);
  if (state.dStateSince !== null && child.pid !== undefined && !childIsUninterruptible(child.pid)) {
    state.dStateSince = null;
    state.lastAnswer = now;
    state.outstanding = null;
  }
  if (
    (!state.served && state.servingObservation !== 'unknown' && now >= state.startupDeadline) ||
    (state.disconnectedAt !== null && now - state.disconnectedAt >= timing.lapseMs) ||
    (child.connected &&
      state.pendingHello &&
      (now - state.lastAnswer >= timing.lapseMs ||
        (state.dStateSince !== null && now - state.dStateSince >= timing.dStateDeferralMs)))
  ) {
    if (child.pid !== undefined && childIsUninterruptible(child.pid) && state.dStateSince === null)
      state.dStateSince = now;
    if (state.dStateSince !== null && now - state.dStateSince < timing.dStateDeferralMs) {
      state.lastAnswer = now;
    } else {
      state.wedged = true;
      if (now - state.lastKillAttemptAt < 1_000) return;
      if (!record.commitTermination(owner.current, reservation, identity, Date.now(), timing.graceMs)) {
        state.lastKillAttemptAt = now;
        if (!record.hasAuthority(owner.current)) owner.lost = true;
        else record.holdSignalRefusal(owner.current, reservation, identity);
        return;
      }
      if (
        terminationCommitted(record, owner.current, reservation, identity) &&
        probeProcessIncarnation(identity.pid) === identity.incarnation
      ) {
        try {
          if (child.kill('SIGTERM')) record.recordTerminationDelivery(owner.current, reservation, 'SIGTERM');
        } catch {
          record.holdSignalRefusal(owner.current, reservation, identity);
        }
      }
      state.escalationAt = now;
    }
    return;
  }
  if (state.wedged && probeProcessIncarnation(identity.pid) === identity.incarnation) {
    record.reconcileAdmissions();
    const current = record.currentChild(reservation, identity);
    if (current !== null && record.supervisionEligible(current)) {
      state.wedged = false;
      record.clearSignalRefusal(reservation);
    }
  }
  const status = currentLaunchStatus(record.runDir);
  if (status !== undefined && child.connected) child.send({ kind: 'coral-launch-status', status });
  if (state.admitted && state.armed && state.pendingHello && state.outstanding === null && child.connected) {
    state.outstanding = ++state.sequence;
    child.send({ kind: 'coral-sentinel-challenge', id: state.outstanding });
  }
}

function relayWatchedChildMessage(input: {
  message: unknown;
  handle: unknown;
  child: ChildProcess;
  reservation: LaunchReservation;
  identity: LaunchProcess;
  runDir: string;
  sentinelId: string;
  owner: OwnerHandle;
  record: SupervisorLaunchMemory;
  state: ChildWatchState;
  route: (message: unknown, handle: unknown) => boolean;
}): void {
  const { message, handle, child, reservation, identity, runDir, sentinelId, owner, record, state, route } = input;
  if (owner.lost || !record.hasAuthority(owner.current)) {
    closeHandle(handle);
    return;
  }
  if (typeof message === 'object' && message !== null && 'kind' in message) {
    if (
      message.kind === 'coral-launch-admitted' &&
      'pid' in message &&
      message.pid === child.pid &&
      'launchId' in message &&
      message.launchId === reservation.id
    ) {
      const admission = readLaunchAdmission(runDir, message.launchId);
      if (
        admission.kind === 'readable' &&
        admission.admission.build.buildSetId === reservation.buildSetId &&
        admission.admission.purpose === reservation.purpose &&
        admission.admission.child.pid === child.pid &&
        admission.admission.child.incarnation === identity.incarnation &&
        admission.admission.parent.pid === process.pid &&
        admission.admission.parent.incarnation === owner.current.process.incarnation &&
        record.admit(reservation, owner.current.process, identity, admission.admission.admittedAt)
      ) {
        state.admitted = true;
        child.send({ kind: 'coral-launch-acknowledged', launchId: reservation.id });
      }
    }
    if (
      message.kind === 'coral-launch-discovered' &&
      state.admitted &&
      'pid' in message &&
      message.pid === child.pid &&
      'launchId' in message &&
      message.launchId === reservation.id
    )
      state.discovered = true;
    if (message.kind === 'coral-sentinel-hello' && 'id' in message && message.id === sentinelId) {
      state.pendingHello = true;
      state.lastAnswer = Number(process.hrtime.bigint() / 1_000_000n);
      if (state.armed) child.send({ kind: 'coral-sentinel-armed', id: sentinelId });
    }
    if (message.kind === 'coral-sentinel-answer' && 'id' in message && message.id === state.outstanding) {
      state.outstanding = null;
      state.lastAnswer = Number(process.hrtime.bigint() / 1_000_000n);
    }
    if (route(message, handle)) return;
    if (String(message.kind).startsWith('coral-')) {
      closeHandle(handle);
      return;
    }
  } else if (route(message, handle)) return;
  if (process.connected)
    process.send?.(message as Parameters<NonNullable<typeof process.send>>[0], handle as SendHandle, () =>
      closeHandle(handle),
    );
  else closeHandle(handle);
}

function escalateWatchedChild(input: {
  child: ChildProcess;
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  reservation: LaunchReservation;
  identity: LaunchProcess;
  timing: SentinelTiming;
}): 'sent' | 'absent' | 'held' | 'refused' {
  const { child, record, owner, reservation, identity, timing } = input;
  if (owner.lost || !record.commitTermination(owner.current, reservation, identity, Date.now(), timing.graceMs))
    return 'refused';
  const current = record.currentChild(reservation, identity);
  const signal = current?.termDelivered === true ? 'SIGKILL' : 'SIGTERM';
  if (signal === 'SIGKILL' && !record.terminationGraceElapsed(reservation)) return 'refused';
  if (
    terminationCommitted(record, owner.current, reservation, identity) &&
    probeProcessIncarnation(identity.pid) === identity.incarnation
  ) {
    let sent: boolean;
    try {
      sent = child.kill(signal);
    } catch {
      sent = false;
    }
    if (sent) {
      record.recordTerminationDelivery(owner.current, reservation, signal);
      record.clearSignalRefusal(reservation);
      return signal === 'SIGKILL' ? 'sent' : 'held';
    }
  }
  if (observeProcessLiveness(identity.pid) === 'absent') {
    record.settleAbsentChild(reservation);
    return 'absent';
  }
  return record.holdSignalRefusal(owner.current, reservation, identity) ? 'held' : 'refused';
}

function pollWatchedChildServing(input: {
  child: ChildProcess;
  manifest: StrictBundleManifest;
  reservation: LaunchReservation;
  identity: LaunchProcess;
  record: SupervisorLaunchMemory;
  runDir: string;
  state: ChildWatchState;
}): void {
  const { child, manifest, reservation, identity, record, runDir, state } = input;
  if (!state.admitted || child.pid === undefined) return;
  const launchState = record.read();
  const authority = launchState.owner;
  if (!record.hasAuthority(authority)) return;
  if (state.served) {
    if (authority.mode === 'recovering') record.reconcileAdmissions();
    return;
  }
  if (
    ![launchState.launch, launchState.attempt].some(
      (launch) => launch?.id === reservation.id && launch.phase === 'admitted',
    )
  )
    return;
  void replacementServing(runDir, manifest.flavor, child.pid).then((ready) => {
    if (!record.hasAuthority(authority)) return;
    state.servingObservation = ready;
    if (ready === true && record.hasAuthority(authority) && record.serving(reservation, identity)) state.served = true;
  });
}

function watchDetachedChild({
  child,
  manifest,
  identity,
  reservation,
  record,
  runDir,
  owner,
  timing,
  state,
}: {
  child: ChildProcess;
  manifest: StrictBundleManifest;
  identity: LaunchProcess;
  reservation: LaunchReservation;
  record: SupervisorLaunchMemory;
  runDir: string;
  owner: OwnerHandle;
  timing: SentinelTiming;
  state: ChildWatchState;
}): ReturnType<typeof setInterval> {
  let handoffReleasedAt: number | null = null;
  return setInterval(() => {
    if (child.connected || owner.lost) return;
    if (handoffReleasedAt !== null) {
      const attempt = attemptExclusiveFileLockSync(supervisorLockPath(runDir));
      if (attempt.kind === 'contended') {
        record.suspendAuthority();
        owner.lost = true;
      } else if (attempt.kind === 'acquired') {
        if (Number(process.hrtime.bigint() / 1_000_000n) - handoffReleasedAt < timing.lapseMs / 2) attempt.lease();
        else {
          record.resumeAuthority();
          owner.current = record.read().owner;
          owner.release = record.authorityLease(attempt.lease);
          handoffReleasedAt = null;
        }
      }
      return;
    }
    const authority = owner.current;
    void replacementServing(runDir, manifest.flavor, identity.pid).then((healthy) => {
      if (
        !record.hasAuthority(authority) ||
        healthy !== true ||
        child.connected ||
        owner.lost ||
        handoffReleasedAt !== null
      )
        return;
      if (!state.served && record.serving(reservation, identity)) state.served = true;
      owner.release();
      handoffReleasedAt = Number(process.hrtime.bigint() / 1_000_000n);
    });
  }, POLL_MS);
}

type WatchedChildContext = WatchChildContext & {
  state: ChildWatchState;
  route: (message: unknown, handle: unknown) => boolean;
  forwardParentMessages: boolean;
};

function forwardWatchedParentMessages(input: WatchedChildContext) {
  const {
    running: { child },
    owner,
    record,
    forwardParentMessages,
  } = input;
  const parentMessage = (message: unknown, handle: unknown): void => {
    if (owner.lost || !record.hasAuthority(owner.current)) {
      closeHandle(handle);
      return;
    }
    if (child.connected)
      child.send(message as Parameters<typeof child.send>[0], handle as SendHandle, () => closeHandle(handle));
    else closeHandle(handle);
  };
  if (forwardParentMessages) process.on('message', parentMessage);
  return parentMessage;
}

function admitWatchedChildOnSpawn(input: WatchedChildContext): void {
  const {
    running: { child, manifest, sentinelId },
    reservation,
    record,
    runDir,
    owner,
    state,
  } = input;
  const spawnAuthority = owner.current;
  child.once('spawn', () => {
    if (!record.hasAuthority(spawnAuthority)) return;
    child.send({
      kind: 'coral-launch-admit',
      runDir,
      launchId: reservation.id,
      build: {
        version: manifest.version,
        buildSetId: manifest.buildSetId,
        bundleHash: manifest.bundleHash,
        flavor: manifest.flavor,
      },
      purpose: reservation.purpose,
      parent: owner.current.process,
    });
    state.armed = true;
    if (state.pendingHello) child.send({ kind: 'coral-sentinel-armed', id: sentinelId });
  });
}

function observeWatchedChildEvents(input: WatchedChildContext) {
  const {
    running: { child, identity, sentinelId },
    reservation,
    record,
    runDir,
    owner,
    state,
    route,
  } = input;
  const childExit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  child.on('message', (message: unknown, handle: unknown) =>
    relayWatchedChildMessage({
      message,
      handle,
      child,
      reservation,
      identity,
      runDir,
      sentinelId,
      owner,
      record,
      state,
      route,
    }),
  );
  return childExit;
}

function startChildWatch(input: WatchedChildContext) {
  const {
    running: { child, manifest, identity },
    reservation,
    record,
    runDir,
    owner,
    timing,
    retirement,
    state,
  } = input;
  const childExit = observeWatchedChildEvents(input);
  const parentMessage = forwardWatchedParentMessages(input);
  const escalateChild = (): 'sent' | 'absent' | 'held' | 'refused' =>
    escalateWatchedChild({ child, record, owner, reservation, identity, timing });
  const interval = setInterval(
    () =>
      monitorChildHeartbeat({ child, record, owner, reservation, identity, timing, retirement, state, escalateChild }),
    timing.challengeMs,
  );
  admitWatchedChildOnSpawn(input);
  const servingPoll = setInterval(
    () => pollWatchedChildServing({ child, manifest, reservation, identity, record, runDir, state }),
    POLL_MS,
  );

  const detachedHealthPoll = watchDetachedChild({
    child,
    manifest,
    identity,
    reservation,
    record,
    runDir,
    owner,
    timing,
    state,
  });
  return { childExit, interval, servingPoll, detachedHealthPoll, parentMessage };
}

function settleExitedChildWatch(input: WatchedChildContext, watch: ReturnType<typeof startChildWatch>): void {
  const {
    running: { identity },
    reservation,
    record,
    runDir,
    owner,
    forwardParentMessages,
  } = input;
  const { interval, servingPoll, detachedHealthPoll, parentMessage } = watch;
  clearInterval(interval);
  clearInterval(servingPoll);
  clearInterval(detachedHealthPoll);
  if (forwardParentMessages) process.off('message', parentMessage);
  if (record.hasAuthority(owner.current)) {
    removeExitedChildDiscovery(runDir, identity);
    if (!record.exited(reservation, identity)) record.cancelReservation(reservation);
    record.reconcileAdmissions();
  }
}

export async function watchChild({
  route = () => false,
  forwardParentMessages = true,
  ...input
}: WatchChildContext): Promise<WatchResult> {
  const state = input.record.childWatch(input.reservation, input.startupBudgetMs);
  const context = { ...input, route, forwardParentMessages, state };
  const watch = startChildWatch(context);
  const { exitCode, signal } = await watch.childExit;
  settleExitedChildWatch(context, watch);
  return { exitCode, signal, served: state.served || (state.discovered && exitCode === 0), wedged: state.wedged };
}
