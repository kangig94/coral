import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { TimePort, TimerHandle } from '../../infra/port-types.js';
import { backendLog } from '../../infra/backend-log.js';
import { durableRequestIdentity } from '../../runtime/request-lease-identity.js';
import type { AbandonedRequestStatus } from '../../infra/abandoned-request-status.js';

export type RequestLease = Readonly<{
  run<T>(execute: (signal: AbortSignal) => Promise<T>): Promise<T>;
}>;

export type RequestLeaseIdentity = Readonly<{
  jobId?: string;
  operationId?: string;
}>;

export type RequestLeaseTiming = Readonly<{
  defaultMs: number;
  kbMutationMs: number;
  settleMs: number;
  checkMs: number;
  schedulingGapMs: number;
}>;

export const REQUEST_LEASE_TIMING: RequestLeaseTiming = Object.freeze({
  defaultMs: 60_000,
  kbMutationMs: 60 * 60_000,
  settleMs: 5_000,
  checkMs: 1_000,
  schedulingGapMs: 5_000,
});

export function validRequestLeaseTiming(timing: RequestLeaseTiming): boolean {
  return (
    Object.values(timing).every((value) => Number.isSafeInteger(value) && value > 0) &&
    timing.checkMs < timing.schedulingGapMs &&
    timing.schedulingGapMs < timing.defaultMs &&
    timing.settleMs < timing.defaultMs &&
    timing.defaultMs < timing.kbMutationMs
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

type RequestLeaseOwnerOptions = Readonly<{
  begin(): void;
  end(): void;
  abandon?(request: AbandonedRequestStatus): void;
  owner?: AbandonedRequestStatus['owner'];
  newRecordId(): string;
  time: TimePort;
  timing?: RequestLeaseTiming;
}>;

export function createRequestLeaseOwner(
  options: RequestLeaseOwnerOptions,
): Readonly<{ begin(method: string, requestId: string, identity?: RequestLeaseIdentity): RequestLease }> {
  const timing = options.timing ?? REQUEST_LEASE_TIMING;
  if (!validRequestLeaseTiming(timing)) throw new Error('Invalid request lease timing');
  return {
    begin: (method, requestId, identity) => beginRequestLease(options, timing, method, requestId, identity),
  };
}

function abandonedRequestStatus(
  options: RequestLeaseOwnerOptions,
  recordId: string,
  method: string,
  requestId: string,
  startedAt: string,
  outcome: AbandonedRequestStatus['outcome'],
  currentIdentity: () => RequestLeaseIdentity | undefined,
): AbandonedRequestStatus {
  return {
    recordId,
    method,
    requestId,
    startedAt,
    outcome,
    identity: currentIdentity(),
    ...(options.owner === undefined ? {} : { owner: options.owner }),
  };
}

function beginRequestLease(
  options: RequestLeaseOwnerOptions,
  timing: RequestLeaseTiming,
  method: string,
  requestId: string,
  identity?: RequestLeaseIdentity,
): RequestLease {
  const { time } = options;
  options.begin();
  const startedAt = new Date(time.now()).toISOString();
  const recordId = options.newRecordId();
  const controller = new AbortController();
  const currentIdentity = (): RequestLeaseIdentity | undefined => durableRequestIdentity(controller.signal) ?? identity;
  let deadline =
    Number(time.monotonicNow()) +
    (method === 'kb.source.create' || method === 'kb.reindex' ? timing.kbMutationMs : timing.defaultMs);
  let lastWake = Number(time.monotonicNow());
  let expired = false;
  let settled = false;
  let released = false;
  let abandoned = false;
  let recordingFailed = false;
  let grace: TimerHandle | null = null;
  let rejectUnsettled: ((error: Error) => void) | null = null;
  const unsettled = new Promise<never>((_resolve, reject) => {
    rejectUnsettled = reject;
  });
  const deadlineError = (outcome: 'cancelled' | 'unknown') =>
    documentedCoralSetupError('request_deadline_exceeded', {
      method,
      requestId,
      recordId,
      ...currentIdentity(),
      outcome,
    });
  const check = (): void => {
    const current = Number(time.monotonicNow());
    const gap = current - lastWake;
    lastWake = current;
    if (gap > timing.schedulingGapMs) deadline += gap;
    if (settled) return;
    if (recordingFailed) {
      try {
        if (options.abandon === undefined) throw new Error('Abandoned request status writer is unavailable');
        options.abandon?.(
          abandonedRequestStatus(options, recordId, method, requestId, startedAt, 'continuing', currentIdentity),
        );
        recordingFailed = false;
        abandoned = true;
        release();
      } catch (error: unknown) {
        backendLog.error('Could not retry abandoned request recording', error);
      }
      return;
    }
    if (expired || current < deadline) return;
    expired = true;
    controller.abort(deadlineError('unknown'));
    grace = time.setTimeout(() => {
      if (settled) return;
      try {
        if (options.abandon === undefined) throw new Error('Abandoned request status writer is unavailable');
        options.abandon?.(
          abandonedRequestStatus(options, recordId, method, requestId, startedAt, 'continuing', currentIdentity),
        );
        abandoned = true;
      } catch (error: unknown) {
        backendLog.error('Could not record abandoned request', error);
        recordingFailed = true;
      }
      if (!recordingFailed) release();
      rejectUnsettled?.(
        documentedCoralSetupError('request_deadline_exceeded', {
          method,
          requestId,
          ...(recordingFailed ? {} : { recordId }),
          ...currentIdentity(),
          outcome: recordingFailed ? 'recording_failed' : 'continuing',
        }),
      );
    }, timing.settleMs);
  };
  const interval = time.setInterval(check, timing.checkMs);
  interval.unref?.();
  const release = (): void => {
    if (released) return;
    released = true;
    time.clearInterval(interval);
    if (grace !== null) time.clearTimeout(grace);
    options.end();
  };
  const settle = (outcome: 'completed' | 'failed' | 'cancelled'): void => {
    if (settled) return;
    settled = true;
    if (expired || abandoned) {
      try {
        options.abandon?.(
          abandonedRequestStatus(options, recordId, method, requestId, startedAt, outcome, currentIdentity),
        );
      } catch (error: unknown) {
        backendLog.error('Could not reconcile abandoned request', error);
      }
    }
    release();
  };
  return {
    run: <T>(execute: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const work = Promise.resolve().then(() => execute(controller.signal));
      const observed = work.then(
        (value) => {
          settle('completed');
          return value;
        },
        (error: unknown) => {
          settle(isAbort(error) ? 'cancelled' : 'failed');
          if (expired) throw deadlineError(isAbort(error) ? 'cancelled' : 'unknown');
          throw error;
        },
      );
      return Promise.race([observed, unsettled]);
    },
  };
}
