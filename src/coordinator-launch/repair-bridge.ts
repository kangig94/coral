import { type ChildProcess, type SendHandle } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { probeProcessIncarnation } from '../infra/node-process.js';
import { type SentinelTiming } from '../infra/sentinel-timing.js';
import { launchSuccessionAttempt } from './attempt-launch.js';
import { retireOwnedChild, type RunningChild } from './child-process.js';
import { type WatchResult } from './child-watch.js';
import { closeHandle } from '../infra/ipc-handle.js';
import { type OwnerHandle } from './ownership.js';
import {
  type SupervisorLaunchMemory,
  type ChildRetirement,
  type LaunchOwner,
  type LaunchReservation,
} from './state.js';
import { POLL_MS } from './timing.js';

export type RepairChild = Readonly<{
  attemptId: string;
  reservation: LaunchReservation;
  running: RunningChild;
  retirement: ChildRetirement;
  watch: Promise<WatchResult>;
}>;

type RepairBridgeState = {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  runDir: string;
  timing: SentinelTiming;
  startupBudgetMs: number;
  children: Map<string, RepairChild>;
  starting: boolean;
};

function servingRepairChild({ record, children }: RepairBridgeState): RepairChild | null {
  const launchId = record.read().launch?.id;
  return launchId === undefined ? null : (children.get(launchId) ?? null);
}

function replyToServingChild(state: RepairBridgeState, message: unknown, handle?: unknown): void {
  const recipient = servingRepairChild(state)?.running.child;
  if (recipient?.connected)
    recipient.send(message as Parameters<ChildProcess['send']>[0], handle as SendHandle, () => closeHandle(handle));
  else if (process.connected)
    process.send?.(message as Parameters<NonNullable<typeof process.send>>[0], handle as SendHandle, () =>
      closeHandle(handle),
    );
  else closeHandle(handle);
}

async function forwardAfterRepairPromotion({
  state: { owner, record },
  authority,
  launchId,
  connected,
  forward,
  handle,
}: {
  state: RepairBridgeState;
  authority: LaunchOwner;
  launchId: string;
  connected: () => boolean;
  forward: () => void;
  handle: unknown;
}): Promise<void> {
  while (
    !owner.lost &&
    record.hasAuthority(authority) &&
    (record.read().launch?.id !== launchId || record.read().launch?.phase !== 'serving') &&
    connected()
  )
    await sleep(POLL_MS);
  if (
    !owner.lost &&
    record.hasAuthority(authority) &&
    record.read().launch?.id === launchId &&
    record.read().launch?.phase === 'serving'
  )
    forward();
  else closeHandle(handle);
}

function routeRepairChild(
  state: RepairBridgeState,
  authority: LaunchOwner,
  attemptId: string,
  running: RunningChild,
  childMessage: unknown,
  childHandle: unknown,
): boolean {
  const { record } = state;
  if (servingRepairChild(state)?.running.child === running.child)
    receiveRepairMessage(state, childMessage, childHandle);
  else {
    const successor = record.read().attempt;
    if (
      (successor?.phase === 'admitted' || successor?.phase === 'serving') &&
      successor.child?.pid === running.identity.pid &&
      successor.child.incarnation === running.identity.incarnation &&
      typeof childMessage === 'object' &&
      childMessage !== null &&
      'kind' in childMessage &&
      childMessage.kind === 'coral-supervisor-start-attempt'
    ) {
      void forwardAfterRepairPromotion({
        state,
        authority,
        launchId: successor.id,
        handle: childHandle,
        connected: () => running.child.exitCode === null && running.child.signalCode === null,
        forward: () => receiveRepairMessage(state, childMessage, childHandle),
      });
    } else
      replyToServingChild(
        state,
        { kind: 'coral-supervisor-attempt-message', attemptId, message: childMessage },
        childHandle,
      );
  }
  return true;
}

function startRepairAttempt(
  state: RepairBridgeState,
  authority: LaunchOwner,
  attemptId: string,
  bundleDir: string,
): void {
  const { record, owner, runDir, timing, startupBudgetMs, children } = state;
  if (state.starting) {
    replyToServingChild(state, {
      kind: 'coral-supervisor-attempt-error',
      attemptId,
      reason: 'Succession attempt is already active',
    });
    return;
  }
  state.starting = true;
  void launchSuccessionAttempt({
    record,
    owner,
    runDir,
    bundleDir,
    attemptId,
    timing,
    startupBudgetMs,
    forwardParentMessages: false,
    repair: true,
    route: (running, childMessage, childHandle) =>
      routeRepairChild(state, authority, attemptId, running, childMessage, childHandle),
    onExit: (attempt, result) => {
      replyToServingChild(state, {
        kind: 'coral-supervisor-attempt-exit',
        attemptId,
        exitCode: result.exitCode,
        signal: result.signal,
      });
      children.delete(attempt.reservation.id);
    },
  })
    .then((attempt) => {
      children.set(attempt.reservation.id, { ...attempt, attemptId });
      replyToServingChild(state, {
        kind: 'coral-supervisor-attempt-spawned',
        attemptId,
        pid: attempt.running.identity.pid,
      });
    })
    .catch((error: unknown) => {
      replyToServingChild(state, { kind: 'coral-supervisor-attempt-error', attemptId, reason: String(error) });
    })
    .finally(() => {
      state.starting = false;
    });
}

function receiveRepairMessage(state: RepairBridgeState, message: unknown, handle: unknown): void {
  const { record, owner, children, timing } = state;
  const authority = owner.current;
  if (owner.lost || !record.hasAuthority(owner.current)) {
    closeHandle(handle);
    return;
  }
  if (typeof message !== 'object' || message === null || !('kind' in message)) {
    closeHandle(handle);
    return;
  }
  if (
    message.kind === 'coral-supervisor-start-attempt' &&
    'attemptId' in message &&
    typeof message.attemptId === 'string' &&
    'bundleDir' in message &&
    typeof message.bundleDir === 'string'
  ) {
    const predecessor = record.read().launch;
    const successor = record.read().attempt;
    if (
      successor?.child?.pid === process.ppid &&
      probeProcessIncarnation(process.ppid) === successor.child.incarnation &&
      predecessor !== null &&
      predecessor.phase !== 'exited'
    ) {
      const child = successor.child;
      void forwardAfterRepairPromotion({
        state,
        authority,
        launchId: successor.id,
        handle,
        connected: () => process.connected && process.ppid === child.pid,
        forward: () => receiveRepairMessage(state, message, handle),
      });
      return;
    }
    closeHandle(handle);
    startRepairAttempt(state, authority, message.attemptId, message.bundleDir);
    return;
  }
  const attemptId = record.read().attempt?.id;
  const attempt = attemptId === undefined ? null : (children.get(attemptId) ?? null);
  if (attempt === null || !('attemptId' in message) || message.attemptId !== attempt.attemptId) {
    closeHandle(handle);
    return;
  }
  if (message.kind === 'coral-supervisor-retire-attempt') {
    closeHandle(handle);
    retireOwnedChild(record, owner, attempt.reservation, attempt.running, attempt.retirement, timing.graceMs);
    return;
  }
  if (message.kind !== 'coral-supervisor-relay') {
    closeHandle(handle);
    return;
  }
  const payload = 'message' in message ? message.message : null;
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'kind' in payload &&
    payload.kind === 'coral-sentinel-retire-child'
  ) {
    closeHandle(handle);
    retireOwnedChild(record, owner, attempt.reservation, attempt.running, attempt.retirement, timing.graceMs);
  } else if (attempt.running.child.connected)
    attempt.running.child.send(payload as Parameters<ChildProcess['send']>[0], handle as SendHandle, () =>
      closeHandle(handle),
    );
  else closeHandle(handle);
}

export function createRepairBridge(
  record: SupervisorLaunchMemory,
  owner: OwnerHandle,
  runDir: string,
  timing: SentinelTiming,
  startupBudgetMs: number,
): Readonly<{ child: (launchId: string | undefined) => RepairChild | null; close: () => void }> {
  const state: RepairBridgeState = {
    record,
    owner,
    runDir,
    timing,
    startupBudgetMs,
    children: new Map(),
    starting: false,
  };
  const onMessage = (message: unknown, handle: unknown): void => receiveRepairMessage(state, message, handle);
  process.on('message', onMessage);
  return {
    child: (launchId) => (launchId === undefined ? null : (state.children.get(launchId) ?? null)),
    close: () => process.off('message', onMessage),
  };
}
