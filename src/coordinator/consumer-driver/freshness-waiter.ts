import type { KbCorpusSnapshot } from '../../kb/contract.js';
import { isSnapshotFresherForInterest } from '../../kb/state/corpus-state.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { ConsumerApplyError } from '../../store/consumer-contract.js';
import type { ConsumerCursorRepository } from './persistence.js';
import type {
  Authority,
  ConsumerDriverTimers,
  ConsumerState,
  CorpusConsumerState,
  ForcedCorpusFreshnessTarget,
  JournalConsumerState,
  Waiter,
} from './state.js';
import {
  consumerAuthorityMismatchError,
  consumerNotRegisteredError,
  corpusSnapshotFromTarget,
  isForcedCorpusFreshnessTarget,
  isKbCorpusSnapshot,
  renderConsumerId,
} from './state.js';

export interface WaitFreshUntilDeps {
  readonly consumers: ReadonlyMap<string, ConsumerState>;
  readonly repository: ConsumerCursorRepository;
  readonly timers: ConsumerDriverTimers;
}

export class FreshnessTimeout extends Error {
  constructor(consumerId: string, target: number | KbCorpusSnapshot | ForcedCorpusFreshnessTarget, timeoutMs: number) {
    const snapshot = typeof target !== 'number' ? corpusSnapshotFromTarget(target) : null;
    const renderedTarget =
      typeof target === 'number'
        ? String(target)
        : `${snapshot?.snapshotId}:${snapshot?.contentSeq}/${snapshot?.metadataSeq}${
            isForcedCorpusFreshnessTarget(target) ? `#${target.atLeastGeneration}` : ''
          }`;
    super(`waitFreshUntil timed out (consumer=${consumerId}, target=${renderedTarget}, timeoutMs=${timeoutMs})`);
    this.name = 'FreshnessTimeout';
    Object.setPrototypeOf(this, FreshnessTimeout.prototype);
  }
}

export class FreshnessApplyFailure extends Error {
  readonly consumerId: string;
  readonly applyError: ConsumerApplyError;

  constructor(consumerId: string, applyError: ConsumerApplyError) {
    super(
      [
        'waitFreshUntil rejected because consumer apply failed',
        `(consumer=${consumerId}, message=${applyError.message}, at=${applyError.at})`,
      ].join(' '),
    );
    this.name = 'FreshnessApplyFailure';
    this.consumerId = consumerId;
    this.applyError = applyError;
    Object.setPrototypeOf(this, FreshnessApplyFailure.prototype);
  }
}

export function waitFreshUntilImpl(
  authority: Authority,
  target: number | KbCorpusSnapshot | ForcedCorpusFreshnessTarget,
  consumerId: string,
  timeoutMs: number,
  deps: WaitFreshUntilDeps,
): Promise<void> {
  if (consumerId.length === 0) {
    throw documentedCoralSetupError('consumer_not_registered', { id: renderConsumerId(consumerId) });
  }

  const state = deps.consumers.get(consumerId);
  if (!state) {
    throw consumerNotRegisteredError(consumerId);
  }
  if (state.kind === 'stateless') {
    throw documentedCoralSetupError('consumer_wait_fresh_invalid_target', { id: consumerId });
  }
  if (state.kind !== authority) {
    throw consumerAuthorityMismatchError(consumerId, authority, state.kind);
  }
  if (state.stopped) {
    throw documentedCoralSetupError('consumer_wait_unsupported', { id: consumerId });
  }

  if (state.kind === 'journal') {
    if (typeof target !== 'number') {
      throw documentedCoralSetupError('consumer_wait_unsupported', { id: consumerId });
    }
    const current = deps.repository.readJournalCursor(consumerId);
    if (current >= target) {
      return Promise.resolve();
    }
  } else {
    if (!isKbCorpusSnapshot(target) && !isForcedCorpusFreshnessTarget(target)) {
      throw documentedCoralSetupError('consumer_wait_unsupported', { id: consumerId });
    }
    const current = deps.repository.readCorpusCursor(consumerId);
    if (corpusTargetReached(state, target, current)) {
      return Promise.resolve();
    }
  }

  return new Promise<void>((resolve, reject) => {
    const waiter = {
      target,
      resolve,
      reject,
      timeoutHandle: deps.timers.setTimeout(() => {
        if (waiter.settled) {
          return;
        }

        waiter.settled = true;
        state.waiters.delete(waiter);
        waiter.reject(new FreshnessTimeout(consumerId, target, timeoutMs));
      }, timeoutMs),
      settled: false,
    };

    state.waiters.add(waiter);
  });
}

export function rejectWaitersForApplyFailure(
  state: ConsumerState,
  applyError: ConsumerApplyError,
  timers: ConsumerDriverTimers,
): void {
  if (state.kind === 'stateless') {
    return;
  }

  rejectWaiters(state, new FreshnessApplyFailure(state.reg.id, applyError), timers);
}

export function rejectWaiters(state: ConsumerState, err: Error, timers: ConsumerDriverTimers): void {
  if (state.kind === 'stateless') {
    return;
  }

  for (const waiter of [...state.waiters]) {
    if (waiter.settled) {
      continue;
    }

    waiter.settled = true;
    timers.clearTimeout(waiter.timeoutHandle);
    state.waiters.delete(waiter);
    waiter.reject(err);
  }
}

export function corpusTargetReached(
  state: ConsumerState,
  target: KbCorpusSnapshot | ForcedCorpusFreshnessTarget,
  current: KbCorpusSnapshot,
): boolean {
  if (state.kind !== 'corpus') {
    return false;
  }

  const snapshot = corpusSnapshotFromTarget(target);
  if (isSnapshotFresherForInterest(snapshot, current, state.reg.corpusInterest)) {
    return false;
  }
  return !isForcedCorpusFreshnessTarget(target) || state.lastAppliedForceGeneration >= target.atLeastGeneration;
}

export function resolveWaiters(
  state: ConsumerState,
  newCursor: number | KbCorpusSnapshot,
  timers: ConsumerDriverTimers,
): void {
  if (state.kind === 'stateless') {
    return;
  }

  for (const waiter of [...state.waiters]) {
    if (waiter.settled) {
      continue;
    }
    const reached = waiterTargetReached(state, waiter, newCursor);
    if (!reached) {
      continue;
    }

    waiter.settled = true;
    state.waiters.delete(waiter);
    timers.clearTimeout(waiter.timeoutHandle);
    waiter.resolve();
  }
}

function waiterTargetReached(
  state: JournalConsumerState | CorpusConsumerState,
  waiter: Waiter,
  newCursor: number | KbCorpusSnapshot,
): boolean {
  if (state.kind === 'journal' && typeof waiter.target === 'number' && typeof newCursor === 'number') {
    return waiter.target <= newCursor;
  }

  if (state.kind === 'corpus' && typeof waiter.target !== 'number' && typeof newCursor !== 'number') {
    return corpusTargetReached(state, waiter.target, newCursor);
  }

  return false;
}
