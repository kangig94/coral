import { raceTimeout } from '../../../infra/async.js';
import type { ContainedProviderServerHandle } from '../../../providers/app-server-transport.js';
import type { ProviderServerSpec } from '../../../providers/contract.js';
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
import { clearIdleTimer } from './idle.js';
import type { ProviderHostEntry } from './state.js';
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
) => Promise<void>;

type ProviderHostContainmentRuntime = Pick<Runtime, 'env' | 'process'>;
type ProviderHostContainmentRuntimeWithTime = Pick<Runtime, 'env' | 'process' | 'time'>;

function containmentReaperWithClock<Scope extends symbol>(
  runtime: ProviderHostContainmentRuntime,
  clock: MonotonicClock<Scope>,
  readProcessStartedAtSeconds: (pid: number, platform: NodeJS.Platform) => number | null,
): ProviderHostContainmentReaper {
  return (containment, signal) =>
    reapRecordedContainment(containment, [], clock.shiftMilliseconds(clock.now(), PROVIDER_HOST_REAP_DEADLINE_MS), {
      maxRecordedRoots: 0,
      clock,
      process: runtime.process,
      platform: runtime.env.platform() as NodeJS.Platform,
      readProcessStartedAtSeconds,
      ...(signal === undefined ? {} : { signal }),
    });
}

/** Creates the coordinator-local adapter around the shared recorded-containment primitive. */
export function createProviderHostContainmentReaper(
  runtime: ProviderHostContainmentRuntimeWithTime,
): ProviderHostContainmentReaper;
export function createProviderHostContainmentReaper<Scope extends symbol>(
  runtime: ProviderHostContainmentRuntime,
  options: {
    clock: MonotonicClock<Scope>;
    readProcessStartedAtSeconds?: (pid: number, platform: NodeJS.Platform) => number | null;
  },
): ProviderHostContainmentReaper;
export function createProviderHostContainmentReaper<Scope extends symbol>(
  runtime: ProviderHostContainmentRuntime,
  options?: {
    clock: MonotonicClock<Scope>;
    readProcessStartedAtSeconds?: (pid: number, platform: NodeJS.Platform) => number | null;
  },
): ProviderHostContainmentReaper {
  const readProcessStartedAtSeconds =
    options?.readProcessStartedAtSeconds ?? runtime.process.readProcessStartedAtSeconds;
  if (options !== undefined) {
    return containmentReaperWithClock(runtime, options.clock, readProcessStartedAtSeconds);
  }
  const runtimeWithTime = runtime as ProviderHostContainmentRuntimeWithTime;
  return containmentReaperWithClock(
    runtime,
    createMonotonicClock(providerHostContainmentClockScope, {
      readMilliseconds: () => runtimeWithTime.time.monotonicNow(),
      sleep: (milliseconds) => runtimeWithTime.time.sleep(milliseconds),
    }),
    readProcessStartedAtSeconds,
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
    ) => Promise<void>;
    reapContainment: ProviderHostContainmentReaper;
    signal?: AbortSignal;
  },
): Promise<void> {
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
    await options.shutdownHandle(handle, entry.spec, containment, options.signal);
  }

  if (entry.containment === containment) entry.containment = null;
}

export async function shutdownHandle(
  handle: ContainedProviderServerHandle,
  spec: ProviderServerSpec,
  containment: RecordedContainmentIdentity,
  time: Pick<Runtime['time'], 'setTimeout' | 'clearTimeout'>,
  reapContainment: ProviderHostContainmentReaper,
  signal?: AbortSignal,
): Promise<void> {
  if (signal !== undefined) throwIfAborted(signal, 'provider_host_shutdown');
  const capability = spec.shutdownCapability;
  if (capability) {
    await tryGracefulShutdown(handle, capability, time, signal);
  } else {
    handle.markExpectedClose();
  }

  await reapContainment(containment, signal);
  if (signal !== undefined) throwIfAborted(signal, 'provider_host_finish_close');
  await handle.finishCloseAfterReap();
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
