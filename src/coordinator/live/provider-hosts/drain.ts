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

const GRACEFUL_CLOSE_FOLLOWUP_TIMEOUT_MS = 5_000;
const providerHostContainmentClockScope = Symbol('provider-host-containment');
const PROVIDER_HOST_REAP_DEADLINE_MS =
  SIGTERM_GRACE_MS +
  SIGKILL_GRACE_MS +
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS +
  2 * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS;

/** Reaps one coordinator-owned provider-host group by its recorded identity. */
export type ProviderHostContainmentReaper = (containment: RecordedContainmentIdentity) => Promise<void>;

type ProviderHostContainmentRuntime = Pick<Runtime, 'env' | 'process'>;
type ProviderHostContainmentRuntimeWithTime = Pick<Runtime, 'env' | 'process' | 'time'>;

function containmentReaperWithClock<Scope extends symbol>(
  runtime: ProviderHostContainmentRuntime,
  clock: MonotonicClock<Scope>,
  readProcessStartedAtSeconds: (pid: number, platform: NodeJS.Platform) => number | null,
): ProviderHostContainmentReaper {
  return (containment) =>
    reapRecordedContainment(containment, [], clock.shiftMilliseconds(clock.now(), PROVIDER_HOST_REAP_DEADLINE_MS), {
      maxRecordedRoots: 0,
      clock,
      process: runtime.process,
      platform: runtime.env.platform() as NodeJS.Platform,
      readProcessStartedAtSeconds,
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
): Promise<boolean> {
  return raceTimeout(closed, timeoutMs, time);
}

export async function closeAllProviderServerEntries(
  entries: Map<string, ProviderHostEntry>,
  detail: string,
  closeProviderServerEntry: (
    entry: ProviderHostEntry,
    detail: string,
    options?: { signal?: AbortSignal; confirmAbsence?: boolean },
  ) => Promise<void>,
  options: { signal?: AbortSignal; confirmAbsence?: boolean } = {},
): Promise<void> {
  const snapshot = [...entries.values()];
  await Promise.all(snapshot.map((entry) => closeProviderServerEntry(entry, detail, options)));
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
    ) => Promise<void>;
    reapContainment: ProviderHostContainmentReaper;
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
  const spawnedHandle =
    installedHandle === null && entry.spawnPromise !== null ? await entry.spawnPromise.catch(() => null) : null;
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
    await options.reapContainment(containment);
  } else {
    await options.shutdownHandle(handle, entry.spec, containment);
  }

  if (entry.containment === containment) entry.containment = null;
}

export async function shutdownHandle(
  handle: ContainedProviderServerHandle,
  spec: ProviderServerSpec,
  containment: RecordedContainmentIdentity,
  time: Pick<Runtime['time'], 'setTimeout' | 'clearTimeout'>,
  reapContainment: ProviderHostContainmentReaper,
): Promise<void> {
  const capability = spec.shutdownCapability;
  if (capability) {
    await tryGracefulShutdown(handle, capability, time);
  } else {
    handle.markExpectedClose();
  }

  await reapContainment(containment);
  await handle.finishCloseAfterReap();
}

async function tryGracefulShutdown(
  handle: ContainedProviderServerHandle,
  capability: NonNullable<ProviderServerSpec['shutdownCapability']>,
  time: Pick<Runtime['time'], 'setTimeout' | 'clearTimeout'>,
): Promise<boolean> {
  handle.markExpectedClose();

  try {
    const outcome = await Promise.race([
      handle.rpc.request(capability.method, {}).then(() => 'rpc' as const),
      handle.closePromise.then(() => 'closed' as const),
      waitForTimeout(capability.timeoutMs, 'timeout' as const, time),
    ]);
    if (outcome === 'timeout') {
      return false;
    }
    if (outcome === 'rpc') {
      return waitForCloseWithin(handle.closePromise, GRACEFUL_CLOSE_FOLLOWUP_TIMEOUT_MS, time);
    }
    return true;
  } catch {
    return waitForCloseWithin(handle.closePromise, capability.timeoutMs, time);
  }
}
