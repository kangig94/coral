import { type ChildProcess, type SendHandle } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { type SentinelTiming } from '../infra/sentinel-timing.js';
import { retireOwnedChild, type RunningChild } from './child-process.js';
import { type WatchResult } from './child-watch.js';
import { closeHandle } from '../infra/ipc-handle.js';
import { type OwnerHandle } from './ownership.js';
import { type SupervisorLaunchMemory, type ChildRetirement, type LaunchReservation } from './state.js';
import { POLL_MS } from './timing.js';

export type PendingAttempt = Readonly<{
  attemptId?: string;
  reservation: LaunchReservation;
  running: RunningChild;
  retirement: ChildRetirement;
  watch: Promise<WatchResult>;
}>;

type ActiveChildRouting = {
  owner: OwnerHandle;
  record: SupervisorLaunchMemory;
  pending: { value: PendingAttempt | null };
  current: () => RunningChild;
  timing: SentinelTiming;
  startAttempt: (source: ChildProcess, attemptId: string, bundleDir: string) => void;
};

function routeCurrentChild(
  { owner, record, pending, timing, startAttempt }: ActiveChildRouting,
  source: ChildProcess,
  message: { kind: unknown },
  handle: unknown,
): boolean {
  const attempt = pending.value;
  if (
    message.kind === 'coral-supervisor-start-attempt' &&
    'attemptId' in message &&
    typeof message.attemptId === 'string' &&
    'bundleDir' in message &&
    typeof message.bundleDir === 'string'
  ) {
    closeHandle(handle);
    startAttempt(source, message.attemptId, message.bundleDir);
    return true;
  }
  if (
    message.kind === 'coral-supervisor-relay' &&
    'attemptId' in message &&
    attempt !== null &&
    attempt.attemptId === message.attemptId
  ) {
    const target = attempt.running.child;
    const payload = 'message' in message ? message.message : null;
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'kind' in payload &&
      payload.kind === 'coral-sentinel-retire-child'
    ) {
      closeHandle(handle);
      retireOwnedChild(record, owner, attempt.reservation, attempt.running, attempt.retirement, timing.graceMs);
    } else if (target.connected)
      target.send(payload as Parameters<typeof target.send>[0], handle as SendHandle, () => closeHandle(handle));
    else closeHandle(handle);
    return true;
  }
  if (
    message.kind === 'coral-supervisor-retire-attempt' &&
    'attemptId' in message &&
    attempt !== null &&
    attempt.attemptId === message.attemptId
  ) {
    closeHandle(handle);
    retireOwnedChild(record, owner, attempt.reservation, attempt.running, attempt.retirement, timing.graceMs);
    return true;
  }
  return false;
}

function routeAttemptChild(
  { owner, record, current, startAttempt }: ActiveChildRouting,
  attempt: PendingAttempt,
  source: ChildProcess,
  message: { kind: unknown },
  handle: unknown,
): boolean {
  const authority = owner.current;
  if (
    message.kind === 'coral-supervisor-start-attempt' &&
    'attemptId' in message &&
    typeof message.attemptId === 'string' &&
    'bundleDir' in message &&
    typeof message.bundleDir === 'string'
  ) {
    closeHandle(handle);
    const { attemptId, bundleDir } = message;
    void (async () => {
      while (
        !owner.lost &&
        record.hasAuthority(authority) &&
        current().child !== source &&
        source.connected &&
        source.exitCode === null &&
        source.signalCode === null
      )
        await sleep(POLL_MS);
      if (!owner.lost && record.hasAuthority(authority) && current().child === source)
        startAttempt(source, attemptId, bundleDir);
      else closeHandle(handle);
    })();
    return true;
  }
  if (attempt.attemptId === undefined) {
    closeHandle(handle);
    return true;
  }
  if (current().child.connected)
    current().child.send(
      {
        kind: 'coral-supervisor-attempt-message',
        attemptId: attempt.attemptId,
        message,
      },
      handle as SendHandle,
      () => closeHandle(handle),
    );
  else closeHandle(handle);
  return true;
}

export function createActiveChildRouter(
  input: ActiveChildRouting,
): (source: ChildProcess, message: unknown, handle: unknown) => boolean {
  return (source, message, handle) => {
    const { owner, record, pending, current } = input;
    if (owner.lost || !record.hasAuthority(owner.current)) {
      closeHandle(handle);
      return true;
    }
    if (typeof message !== 'object' || message === null || !('kind' in message)) return false;
    if (source === current().child) return routeCurrentChild(input, source, message, handle);
    const attempt = pending.value;
    if (attempt !== null && source === attempt.running.child)
      return routeAttemptChild(input, attempt, source, message, handle);
    return false;
  };
}
