import type { Runtime } from '../../runtime/ports.js';
import {
  type CliExecResult,
  type DurableProcessRetention,
  type DurableProcessCleanup,
  type DurableProcessCleanupOutcome,
  type PendingDurableLaunch,
  type PendingDurableLaunchIdentity,
  type SpawnDurableJobOptions,
  spawnDurableJobTransport,
} from './durable-transport.js';
import {
  type ContainedProviderServerHandle,
  type ProviderResponseObservationSink,
  type SpawnProviderServerOptions,
  spawnProviderServerTransport,
} from '../../providers/app-server-transport.js';
import { CliBusyError } from '../../runtime/cli-busy.js';
import { getActiveLimit, parsePositiveInt } from './worker-limits.js';
import type { AdmissionResult, LaunchPool, QueuedHandle } from '../../jobs/contracts/admission.js';
import type { ExecutionOwner } from '../../runtime/execution-owner.js';
import { assertProviderHostPlatformSupported } from '../../providers/host-admission.js';

/**
 * Admission queue capacity per pool. Operator knob — see §16(d) triage rule:
 * default 20 is reasonable for all environments tested; large deployments may
 * raise it via `CORAL_MAX_QUEUE_SIZE`. Clamped to [1, 1000] to keep memory
 * pressure bounded.
 */
export function getMaxQueueSize(env: Pick<Runtime['env'], 'get'>): number {
  return Math.min(Math.max(parsePositiveInt(env.get('CORAL_MAX_QUEUE_SIZE'), 20), 1), 1000);
}

type QueuedLaunchEntry = {
  jobId: string;
  provider: string;
  owner: ExecutionOwner;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PoolState = { active: Map<string, { provider: string; owner: ExecutionOwner }>; queued: QueuedLaunchEntry[] };

const QUEUE_CANCELED_MESSAGE = 'Launch canceled while queued';
const QUEUE_DRAINED_MESSAGE = 'Launch canceled while queue was drained';
const SHUTDOWN_LAUNCH_REJECTED_MESSAGE = 'Launch rejected because shutdown has begun';
const TERMINATION_RETRY_INTERVAL_MS = 50;

function unknownLaunchPool(pool: never): never {
  throw new Error(`Launch admission invariant violated: unknown pool ${JSON.stringify(pool)}.`);
}

export class DuplicateLaunchReservationError extends Error {
  constructor(jobId: string, pool: LaunchPool) {
    super(`Launch reservation already exists for job ${jobId} in pool ${pool}.`);
    this.name = 'DuplicateLaunchReservationError';
  }
}

export type TerminateAllDisposition =
  | Readonly<{ kind: 'all-observed-absent' }>
  | Readonly<{
      kind: 'unresolved-at-deadline';
      processes: readonly Exclude<DurableProcessCleanupOutcome, { kind: 'observed-absent' }>[];
      pendingLaunches: number;
      retainedLaunches: readonly PendingDurableLaunchIdentity[];
      cleanupHandles: number;
      retainedProcesses: readonly DurableProcessRetention[];
      cleanupFailures: number;
      owner: 'launch-coordinator';
    }>;

export class LaunchCoordinator {
  private readonly cleanupHandles = new Map<symbol, DurableProcessCleanup>();
  private readonly cleanupRetentions = new Map<DurableProcessCleanup, DurableProcessRetention>();
  private readonly pendingDurableLaunches = new Set<PendingDurableLaunch>();
  private nextProviderServerGeneration = 1;
  private readonly pools: Record<LaunchPool, PoolState> = {
    default: { active: new Map(), queued: [] },
    discuss: { active: new Map(), queued: [] },
    curate: { active: new Map(), queued: [] },
  };
  private shutdownRequested = false;
  private readonly runtime: Runtime;

  constructor(options: { runtime: Runtime }) {
    this.runtime = options.runtime;
  }

  get active(): number {
    let total = 0;
    for (const state of Object.values(this.pools)) {
      total += state.active.size;
    }
    return total;
  }

  requestLaunch(jobId: string, provider: string, owner: ExecutionOwner, pool: LaunchPool = 'default'): AdmissionResult {
    if (this.shutdownRequested) throw new Error(SHUTDOWN_LAUNCH_REJECTED_MESSAGE);
    const activeLaunches = this.getActiveMap(pool);
    const queuedLaunches = this.getQueue(pool);
    this.rejectDuplicateReservation(jobId);

    if (queuedLaunches.length === 0 && this.hasLaunchCapacity(pool)) {
      activeLaunches.set(jobId, { provider, owner });
      return { type: 'immediate' };
    }

    if (queuedLaunches.length >= getMaxQueueSize(this.runtime.env)) return 'queue_full';

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });

    const entry: QueuedLaunchEntry = { jobId, provider, owner, promise, resolve, reject };
    queuedLaunches.push(entry);
    return this.queuedHandle(entry, pool);
  }

  releaseLaunch(jobId: string, pool: LaunchPool = 'default'): void {
    const activeLaunches = this.getActiveMap(pool);
    if (!activeLaunches.delete(jobId)) return;
    this.admitQueueHead(pool);
  }

  cancelQueued(jobId: string, pool: LaunchPool = 'default'): boolean {
    const queuedLaunches = this.getQueue(pool);
    const index = queuedLaunches.findIndex((entry) => entry.jobId === jobId);
    if (index === -1) return false;
    const entry = queuedLaunches[index];
    return entry === undefined ? false : this.cancelQueuedEntry(entry, pool);
  }

  queueDepth(pool: LaunchPool = 'default'): number {
    return this.getQueue(pool).length;
  }

  queuePosition(jobId: string, pool: LaunchPool = 'default'): number | null {
    const index = this.getQueue(pool).findIndex((entry) => entry.jobId === jobId);
    return index === -1 ? null : index + 1;
  }

  getActiveJobIds(pool: LaunchPool = 'default'): string[] {
    return [...this.getActiveMap(pool).keys()];
  }

  private rejectedPermitPromise(error: unknown): Promise<never> {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  async spawnProviderServer(
    options: SpawnProviderServerOptions,
    observeProviderResponse: ProviderResponseObservationSink = () => {},
    generation = this.allocateProviderServerGeneration(),
    recordContainment?: (containment: ContainedProviderServerHandle['containmentIdentity']) => void,
  ): Promise<ContainedProviderServerHandle> {
    if (this.shutdownRequested) throw new Error(SHUTDOWN_LAUNCH_REJECTED_MESSAGE);
    assertProviderHostPlatformSupported(this.runtime.env.platform());
    return spawnProviderServerTransport({
      runtime: this.runtime,
      options,
      generation,
      observeProviderResponse,
      detached: true,
      ...(recordContainment === undefined ? {} : { recordContainment }),
    });
  }

  allocateProviderServerGeneration(): number {
    return this.nextProviderServerGeneration++;
  }

  spawnDurableJob(options: SpawnDurableJobOptions): Promise<CliExecResult> {
    if (this.shutdownRequested) return this.rejectedPermitPromise(new Error(SHUTDOWN_LAUNCH_REJECTED_MESSAGE));
    const pool = options.pool ?? 'default';
    let internalPermitJobId: string | null;
    try {
      internalPermitJobId = this.reserveInternalPermitOrThrow(options, pool, 'spawndurable');
    } catch (error: unknown) {
      return this.rejectedPermitPromise(error);
    }

    return spawnDurableJobTransport({
      runtime: this.runtime,
      options,
      pool,
      internalPermitJobId,
      cleanupHandles: this.cleanupHandles,
      cleanupRetentions: this.cleanupRetentions,
      pendingLaunches: this.pendingDurableLaunches,
      releaseLaunch: (jobId, nextPool) => this.releaseLaunch(jobId, nextPool),
    });
  }

  restoreActiveLaunch(jobId: string, provider: string, owner: ExecutionOwner, pool: LaunchPool = 'default'): void {
    this.rejectDuplicateReservation(jobId);
    this.getActiveMap(pool).set(jobId, { provider, owner });
  }

  restoreQueuedLaunch(
    jobId: string,
    provider: string,
    owner: ExecutionOwner,
    pool: LaunchPool = 'default',
  ): QueuedHandle {
    this.rejectDuplicateReservation(jobId);
    const queuedLaunches = this.getQueue(pool);

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });

    const entry: QueuedLaunchEntry = { jobId, provider, owner, promise, resolve, reject };
    queuedLaunches.push(entry);

    return this.queuedHandle(entry, pool);
  }

  async terminateAll(signal?: AbortSignal): Promise<TerminateAllDisposition> {
    this.shutdownRequested = true;
    this.drainQueuedLaunches(QUEUE_DRAINED_MESSAGE);
    const failures = new Map<DurableProcessCleanup, unknown>();
    const unsettled = new Map<
      DurableProcessCleanup,
      Exclude<DurableProcessCleanupOutcome, { kind: 'observed-absent' }>
    >();
    const aborted = Symbol('aborted');
    let resolveAborted: ((value: typeof aborted) => void) | null = null;
    const abort =
      signal === undefined
        ? null
        : new Promise<typeof aborted>((resolve) => {
            resolveAborted = resolve;
          });
    const onAbort = (): void => resolveAborted?.(aborted);
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const dispositionAtDeadline = (): TerminateAllDisposition =>
      this.pendingDurableLaunches.size === 0 && this.cleanupHandles.size === 0
        ? { kind: 'all-observed-absent' }
        : {
            kind: 'unresolved-at-deadline',
            processes: [...unsettled.values()],
            pendingLaunches: this.pendingDurableLaunches.size,
            retainedLaunches: [...this.pendingDurableLaunches].map((launch) => launch.retainedIdentity()),
            cleanupHandles: this.cleanupHandles.size,
            retainedProcesses: [...new Set(this.cleanupHandles.values())].flatMap((cleanup) => {
              const retention = this.cleanupRetentions.get(cleanup);
              return retention === undefined ? [] : [retention];
            }),
            cleanupFailures: failures.size,
            owner: 'launch-coordinator',
          };

    try {
      while (this.pendingDurableLaunches.size > 0 || this.cleanupHandles.size > 0) {
        if (this.pendingDurableLaunches.size > 0) {
          const pendingSettlements = Promise.all([...this.pendingDurableLaunches].map((launch) => launch.settled));
          const joined = abort === null ? await pendingSettlements : await Promise.race([pendingSettlements, abort]);
          if (joined === aborted) return dispositionAtDeadline();
          continue;
        }

        const attempts: Array<{ cleanup: DurableProcessCleanup; task: Promise<DurableProcessCleanupOutcome> }> = [];
        for (const cleanup of this.cleanupHandles.values()) {
          try {
            attempts.push({ cleanup, task: cleanup() });
          } catch (error: unknown) {
            failures.set(cleanup, error);
          }
        }
        const pendingOutcomes = Promise.allSettled(attempts.map(({ task }) => task));
        const outcomes = abort === null ? await pendingOutcomes : await Promise.race([pendingOutcomes, abort]);
        if (outcomes === aborted) return dispositionAtDeadline();
        for (const [index, outcome] of outcomes.entries()) {
          const attempt = attempts[index];
          if (attempt === undefined) continue;
          if (outcome.status === 'rejected') {
            failures.set(attempt.cleanup, outcome.reason);
            continue;
          }
          if (outcome.value.kind !== 'observed-absent') {
            unsettled.set(attempt.cleanup, outcome.value);
            continue;
          }
          failures.delete(attempt.cleanup);
          unsettled.delete(attempt.cleanup);
          for (const [key, registeredCleanup] of this.cleanupHandles) {
            if (registeredCleanup === attempt.cleanup) this.cleanupHandles.delete(key);
          }
          this.cleanupRetentions.delete(attempt.cleanup);
        }

        if (this.pendingDurableLaunches.size > 0 || this.cleanupHandles.size > 0) {
          const retryDelay = this.runtime.time.sleep(TERMINATION_RETRY_INTERVAL_MS).then(() => undefined);
          const retry = abort === null ? await retryDelay : await Promise.race([retryDelay, abort]);
          if (retry === aborted) return dispositionAtDeadline();
        }
      }

      return { kind: 'all-observed-absent' };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private getActiveMap(pool: LaunchPool): Map<string, { provider: string; owner: ExecutionOwner }> {
    return this.getPoolState(pool).active;
  }

  private getQueue(pool: LaunchPool): QueuedLaunchEntry[] {
    return this.getPoolState(pool).queued;
  }

  private getPoolState(pool: LaunchPool): PoolState {
    switch (pool) {
      case 'default':
        return this.pools.default;
      case 'discuss':
        return this.pools.discuss;
      case 'curate':
        return this.pools.curate;
      default:
        return unknownLaunchPool(pool);
    }
  }

  private hasLaunchCapacity(pool: LaunchPool): boolean {
    return this.getActiveMap(pool).size < getActiveLimit(pool, this.runtime.env);
  }

  private reserveInternalPermitOrThrow(
    options: Pick<SpawnDurableJobOptions, 'permitGranted' | 'provider'>,
    pool: LaunchPool,
    prefix: string,
  ): string | null {
    const poolState = this.getPoolState(pool);
    const usingReservedPermit = options.permitGranted === true;
    if (usingReservedPermit) {
      return null;
    }

    const activeLaunches = poolState.active;
    const queuedLaunches = poolState.queued;
    const globalActive = activeLaunches.size;
    const globalLimit = getActiveLimit(pool, this.runtime.env);
    if (queuedLaunches.length > 0 || globalActive >= globalLimit) {
      throw new CliBusyError({
        error: 'busy',
        provider: options.provider,
        globalActive,
        globalLimit,
      });
    }

    const internalPermitJobId = `${prefix}-${this.runtime.ids.uuid()}`;
    activeLaunches.set(internalPermitJobId, {
      provider: options.provider,
      owner: { kind: 'system-task', id: internalPermitJobId },
    });
    return internalPermitJobId;
  }

  private queuedHandle(entry: QueuedLaunchEntry, pool: LaunchPool): QueuedHandle {
    const queuePosition = this.queuePosition(entry.jobId, pool) ?? this.getQueue(pool).length;
    return {
      type: 'queued',
      queuePosition,
      waitForPermit: () => entry.promise,
      cancel: () => this.cancelQueuedEntry(entry, pool),
    };
  }

  private cancelQueuedEntry(entry: QueuedLaunchEntry, pool: LaunchPool): boolean {
    const queuedLaunches = this.getQueue(pool);
    const index = queuedLaunches.indexOf(entry);
    if (index === -1) return false;
    queuedLaunches.splice(index, 1);
    entry.reject(new Error(QUEUE_CANCELED_MESSAGE));
    this.admitQueueHead(pool);
    return true;
  }

  private rejectDuplicateReservation(jobId: string): void {
    for (const [existingPool, state] of Object.entries(this.pools) as Array<[LaunchPool, PoolState]>) {
      if (state.active.has(jobId) || state.queued.some((entry) => entry.jobId === jobId)) {
        throw new DuplicateLaunchReservationError(jobId, existingPool);
      }
    }
  }

  private admitQueueHead(pool: LaunchPool): void {
    const queue = this.getQueue(pool);
    const head = queue[0];
    if (!head) return;
    if (!this.hasLaunchCapacity(pool)) return;
    queue.shift();
    this.getActiveMap(pool).set(head.jobId, { provider: head.provider, owner: head.owner });
    head.resolve();
  }

  private drainQueuedLaunches(message: string): void {
    const error = new Error(message);
    for (const state of Object.values(this.pools)) {
      const drained = state.queued.splice(0, state.queued.length);
      for (const entry of drained) {
        entry.reject(error);
      }
    }
  }
}
