import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { TimePort, TimerHandle } from '../../infra/port-types.js';
import { backendLog } from '../../infra/backend-log.js';

export type RequestLease = Readonly<{
  run<T>(execute: (signal: AbortSignal) => Promise<T>): Promise<T>;
}>;

export type RequestLeaseIdentity = Readonly<{
  jobId?: string;
  operationId?: string;
}>;

export type AbandonedRequest = Readonly<{
  method: string;
  requestId: string;
  startedAt: string;
  outcome: 'continuing';
  identity?: RequestLeaseIdentity;
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

export function createRequestLeaseOwner(
  options: Readonly<{
    begin(): void;
    end(): void;
    abandon?(request: AbandonedRequest): void;
    time: TimePort;
    timing?: RequestLeaseTiming;
  }>,
): Readonly<{ begin(method: string, requestId: string, identity?: RequestLeaseIdentity): RequestLease }> {
  const timing = options.timing ?? REQUEST_LEASE_TIMING;
  if (!validRequestLeaseTiming(timing)) throw new Error('Invalid request lease timing');
  const { time } = options;
  return {
    begin: (method, requestId, identity) => {
      options.begin();
      const startedAt = new Date(time.now()).toISOString();
      const controller = new AbortController();
      let deadline =
        time.now() +
        (method === 'kb.source.create' || method === 'kb.reindex' ? timing.kbMutationMs : timing.defaultMs);
      let lastWake = time.now();
      let expired = false;
      let settled = false;
      let released = false;
      let grace: TimerHandle | null = null;
      let rejectUnsettled: ((error: Error) => void) | null = null;
      const unsettled = new Promise<never>((_resolve, reject) => {
        rejectUnsettled = reject;
      });
      const deadlineError = (outcome: 'cancelled' | 'unknown') =>
        documentedCoralSetupError('request_deadline_exceeded', { method, requestId, ...identity, outcome });
      const check = (): void => {
        const current = time.now();
        const gap = current - lastWake;
        lastWake = current;
        if (gap > timing.schedulingGapMs) deadline += gap;
        if (settled || expired || current < deadline) return;
        expired = true;
        controller.abort(deadlineError('unknown'));
        grace = time.setTimeout(() => {
          if (settled) return;
          try {
            options.abandon?.({ method, requestId, startedAt, outcome: 'continuing', identity });
          } catch (error: unknown) {
            backendLog.error('Could not record abandoned request', error);
          }
          release();
          rejectUnsettled?.(
            documentedCoralSetupError('request_deadline_exceeded', {
              method,
              requestId,
              ...identity,
              outcome: 'continuing',
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
      const settle = (): void => {
        if (settled) return;
        settled = true;
        release();
      };
      return {
        run: <T>(execute: (signal: AbortSignal) => Promise<T>): Promise<T> => {
          const work = Promise.resolve().then(() => execute(controller.signal));
          const observed = work.then(
            (value) => {
              settle();
              if (expired)
                throw documentedCoralSetupError('request_deadline_exceeded', {
                  method,
                  requestId,
                  ...identity,
                  outcome: 'continuing',
                });
              return value;
            },
            (error: unknown) => {
              settle();
              if (expired) throw deadlineError(isAbort(error) ? 'cancelled' : 'unknown');
              throw error;
            },
          );
          return Promise.race([observed, unsettled]);
        },
      };
    },
  };
}
