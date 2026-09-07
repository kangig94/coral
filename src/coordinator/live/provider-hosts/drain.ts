import type { ProcessIncarnation } from '../../../infra/node-process.js';
import { raceTimeout } from '../../../infra/async.js';
import type { ContainedProviderServerHandle } from '../../../providers/app-server-transport.js';
import {
  providerServerShutdownResultSchema,
  type ProviderServerShutdownResult,
  type ProviderServerSpec,
} from '../../../providers/contract.js';
import type { TimePort } from '../../../infra/port-types.js';
import type { Runtime } from '../../../runtime/ports.js';
import { createMonotonicClock, type MonotonicClock } from '../../../infra/monotonic-clock.js';
import {
  ProcessContainmentError,
  reapRecordedContainment,
  type RecordedContainmentIdentity,
} from '../../../infra/process-containment.js';
import {
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS,
  CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from '../../../infra/process-constants.js';
import { liveChildAuthority, type LiveChildAuthority } from '../../../infra/process-supervision.js';
import { clearIdleTimer } from './idle.js';
import type { ProviderHostEntry, ProviderHostShutdownDisposition, ProviderHostShutdownHold } from './state.js';
import { AbortError, throwIfAborted } from '../../../runtime/abort.js';

const GRACEFUL_CLOSE_FOLLOWUP_TIMEOUT_MS = 5_000;
const providerHostContainmentClockScope = Symbol('provider-host-containment');
const PROVIDER_HOST_REAP_DEADLINE_MS =
  SIGTERM_GRACE_MS +
  SIGKILL_GRACE_MS +
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS +
  2 * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS;

/** Reaps one coordinator-owned provider-host group by its recorded identity. */
export type ProviderHostContainmentReaper = (
  containment: RecordedContainmentIdentity,
  signal?: AbortSignal,
  authority?: LiveChildAuthority,
) => Promise<void>;

type ProviderHostContainmentRuntime = Pick<Runtime, 'env' | 'process'>;
type ProviderHostContainmentRuntimeWithTime = Pick<Runtime, 'env' | 'process' | 'time'>;

function containmentReaperWithClock<Scope extends symbol>(
  runtime: ProviderHostContainmentRuntime,
  clock: MonotonicClock<Scope>,
  readProcessIncarnation: (pid: number, platform: NodeJS.Platform) => ProcessIncarnation | null,
): ProviderHostContainmentReaper {
  return async (containment, signal, authority) => {
    const outcome = await reapRecordedContainment(
      containment,
      [],
      clock.shiftMilliseconds(clock.now(), PROVIDER_HOST_REAP_DEADLINE_MS),
      {
        maxRecordedRoots: 0,
        clock,
        process: runtime.process,
        platform: runtime.env.platform() as NodeJS.Platform,
        readProcessIncarnation,
        ...(authority === undefined
          ? {}
          : {
              knownLiveChildFor: (pid: number) => (pid === authority.pid ? authority : undefined),
            }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (outcome.kind === 'recorded-group-unattributable') {
      throw new ProcessContainmentError(
        'process_identity_unverified',
        'The recorded provider-host leader identity is gone, but the surviving process group cannot be attributed.',
        { pid: containment.pid, processGroupId: containment.processGroupId },
      );
    }
    if (outcome.kind === 'signal-authorization-refused') {
      throw new ProcessContainmentError(
        'process_containment_reap_failed',
        'Signal authorization could not be established for the recorded provider-host process group.',
        { pid: containment.pid, processGroupId: containment.processGroupId },
      );
    }
    if (outcome.kind === 'identity-unobservable') {
      throw new ProcessContainmentError(
        outcome.signalDelivered ? 'process_containment_reap_failed' : 'process_identity_unverified',
        outcome.signalDelivered
          ? 'Provider-host identity became unobservable after a containment signal was delivered.'
          : 'Provider-host identity could not be observed before containment signal authorization.',
        { pid: containment.pid, processGroupId: containment.processGroupId },
      );
    }
  };
}

/** Creates the coordinator-local adapter around the shared recorded-containment primitive. */
export function createProviderHostContainmentReaper(
  runtime: ProviderHostContainmentRuntimeWithTime,
): ProviderHostContainmentReaper;
export function createProviderHostContainmentReaper<Scope extends symbol>(
  runtime: ProviderHostContainmentRuntime,
  options: {
    clock: MonotonicClock<Scope>;
    readProcessIncarnation?: (pid: number, platform: NodeJS.Platform) => ProcessIncarnation | null;
  },
): ProviderHostContainmentReaper;
export function createProviderHostContainmentReaper<Scope extends symbol>(
  runtime: ProviderHostContainmentRuntime,
  options?: {
    clock: MonotonicClock<Scope>;
    readProcessIncarnation?: (pid: number, platform: NodeJS.Platform) => ProcessIncarnation | null;
  },
): ProviderHostContainmentReaper {
  const readProcessIncarnation = options?.readProcessIncarnation ?? runtime.process.readProcessIncarnation;
  if (options !== undefined) {
    return containmentReaperWithClock(runtime, options.clock, readProcessIncarnation);
  }
  const runtimeWithTime = runtime as ProviderHostContainmentRuntimeWithTime;
  return containmentReaperWithClock(
    runtime,
    createMonotonicClock(providerHostContainmentClockScope, {
      readMilliseconds: () => runtimeWithTime.time.monotonicNow(),
      sleep: (milliseconds) => runtimeWithTime.time.sleep(milliseconds),
    }),
    readProcessIncarnation,
  );
}

function waitForTimeout<T>(timeoutMs: number, value: T, time: Pick<TimePort, 'setTimeout'>): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = time.setTimeout(() => resolve(value), timeoutMs);
    timer.unref?.();
  });
}

function waitForCloseWithin(
  closed: Promise<Error | void>,
  timeoutMs: number,
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>,
  signal?: AbortSignal,
): Promise<boolean> {
  return waitWhileAuthorized(raceTimeout(closed, timeoutMs, time), signal, 'provider_host_graceful_close_wait');
}

function waitWhileAuthorized<Result>(
  operation: Promise<Result>,
  signal: AbortSignal | undefined,
  stage: string,
): Promise<Result> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    return Promise.reject(new AbortError({ stage, reason: signal.reason }));
  }
  return new Promise<Result>((resolve, reject) => {
    const onAbort = (): void => reject(new AbortError({ stage, reason: signal.reason }));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Provider host close wait failed.', { cause: error }));
      },
    );
  });
}

export async function closeProviderServerEntry(
  entry: ProviderHostEntry,
  detail: string,
  options: {
    runtime: Pick<Runtime, 'time'>;
    entries: Map<string, ProviderHostEntry>;
    shutdownHandle: (
      handle: ContainedProviderServerHandle,
      spec: ProviderServerSpec,
      containment: RecordedContainmentIdentity,
      signal?: AbortSignal,
    ) => Promise<ProviderHostShutdownDisposition>;
    reapContainment: ProviderHostContainmentReaper;
    signal?: AbortSignal;
  },
): Promise<ProviderHostShutdownDisposition> {
  clearIdleTimer(entry, options.runtime.time);
  entry.disposeHostNotifications?.();
  entry.disposeHostNotifications = null;
  entry.hostStats = null;
  entry.closingError ??= new Error(`Provider server ${entry.spec.provider} ${detail}`);
  if (options.entries.get(entry.hostKey) === entry) {
    options.entries.delete(entry.hostKey);
  }

  const installedHandle = entry.handle;
  let spawnedHandle: ContainedProviderServerHandle | null = null;
  if (installedHandle === null && entry.spawnPromise !== null) {
    try {
      spawnedHandle = await waitWhileAuthorized(entry.spawnPromise, options.signal, 'provider_host_spawn_during_close');
    } catch (error: unknown) {
      if (options.signal?.aborted) throw error;
    }
  }
  const handle = installedHandle ?? spawnedHandle ?? entry.handle;
  const containment = entry.containment;
  if (containment === null) {
    if (handle !== null) {
      throw new ProcessContainmentError(
        'process_identity_unverified',
        `Provider server ${entry.spec.provider} has no recorded containment to reap.`,
        { pid: handle.pid },
      );
    }
  } else if (handle === null) {
    await options.reapContainment(containment, options.signal);
  } else {
    const disposition = await options.shutdownHandle(handle, entry.spec, containment, options.signal);
    if (disposition.kind !== 'observed-absent') return disposition;
  }

  if (entry.containment === containment) entry.containment = null;
  return { kind: 'observed-absent' };
}

export async function shutdownHandle(
  handle: ContainedProviderServerHandle,
  spec: ProviderServerSpec,
  containment: RecordedContainmentIdentity,
  time: Pick<Runtime['time'], 'setTimeout' | 'clearTimeout'>,
  reapContainment: ProviderHostContainmentReaper,
  signal?: AbortSignal,
): Promise<ProviderHostShutdownDisposition> {
  if (signal !== undefined) throwIfAborted(signal, 'provider_host_shutdown');
  const capability = spec.shutdownCapability;
  if (capability?.resultDisposition?.kind === 'provider-server-shutdown-v1') {
    const shutdown = await requestDispositionShutdown(handle, spec, time, reapContainment, containment, signal);
    if (shutdown.kind !== 'observed-absent') return shutdown;
  } else if (capability) {
    await tryGracefulShutdown(handle, capability, time, signal);
  } else {
    handle.markExpectedClose();
  }

  await reapContainment(containment, signal, liveChildAuthority(handle.child));
  if (signal !== undefined) throwIfAborted(signal, 'provider_host_finish_close');
  await handle.finishCloseAfterReap();
  return { kind: 'observed-absent' };
}

async function requestDispositionShutdown(
  handle: ContainedProviderServerHandle,
  spec: ProviderServerSpec,
  time: Pick<Runtime['time'], 'setTimeout' | 'clearTimeout'>,
  reapContainment: ProviderHostContainmentReaper,
  containment: RecordedContainmentIdentity,
  signal?: AbortSignal,
): Promise<ProviderHostShutdownDisposition> {
  const capability = spec.shutdownCapability;
  if (capability?.resultDisposition?.kind !== 'provider-server-shutdown-v1') {
    throw new Error('provider_host_shutdown_disposition_missing');
  }
  handle.markExpectedClose();
  let result: ProviderServerShutdownResult | null = null;
  try {
    const outcome = await waitWhileAuthorized(
      Promise.race([
        handle.rpc.request(capability.method, {}).then((value) => ({ kind: 'response' as const, value })),
        handle.closePromise.then(() => ({ kind: 'closed' as const })),
        waitForTimeout(capability.timeoutMs, { kind: 'timeout' as const }, time),
      ]),
      signal,
      'provider_host_disposition_shutdown',
    );
    if (outcome.kind === 'closed') return { kind: 'observed-absent' };
    if (outcome.kind === 'response') result = providerServerShutdownResultSchema.parse(outcome.value);
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
  }

  const expected = capability.resultDisposition;
  if (
    result !== null &&
    result.disposition !== 'observed-absent' &&
    (result.successor.owner !== expected?.successorOwner || result.operatorExit.kind !== expected.operatorExit)
  ) {
    result = null;
  }
  if (result?.disposition === 'observed-absent') return { kind: 'observed-absent' };

  const retry = (): Promise<ProviderHostShutdownDisposition> =>
    shutdownHandle(handle, spec, containment, time, reapContainment);
  const kind =
    result?.disposition === 'held-alive' ? 'provider-shutdown-held-alive' : 'provider-shutdown-held-unobservable';
  const observation = result?.disposition === 'held-alive' ? 'alive' : 'unobservable';
  const operatorExitKind = result?.operatorExit.kind ?? 'retry-provider-shutdown';
  return {
    kind,
    observation,
    subject: { kind: 'provider-server', pid: handle.pid },
    obligations: result?.subjects ?? [],
    successor: result?.successor ?? null,
    retry,
    operatorExit: { kind: operatorExitKind, retry },
  } satisfies ProviderHostShutdownHold;
}

async function tryGracefulShutdown(
  handle: ContainedProviderServerHandle,
  capability: NonNullable<ProviderServerSpec['shutdownCapability']>,
  time: Pick<Runtime['time'], 'setTimeout' | 'clearTimeout'>,
  signal?: AbortSignal,
): Promise<boolean> {
  handle.markExpectedClose();

  try {
    const outcome = await waitWhileAuthorized(
      Promise.race([
        handle.rpc.request(capability.method, {}).then(() => 'rpc' as const),
        handle.closePromise.then(() => 'closed' as const),
        waitForTimeout(capability.timeoutMs, 'timeout' as const, time),
      ]),
      signal,
      'provider_host_graceful_shutdown',
    );
    if (outcome === 'timeout') {
      return false;
    }
    if (outcome === 'rpc') {
      return waitForCloseWithin(handle.closePromise, GRACEFUL_CLOSE_FOLLOWUP_TIMEOUT_MS, time, signal);
    }
    return true;
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return waitForCloseWithin(handle.closePromise, capability.timeoutMs, time, signal);
  }
}
