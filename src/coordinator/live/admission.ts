import type { Runtime } from '../../runtime/ports.js';
import { type CliExecResult, type SpawnDurableJobOptions, spawnDurableJobTransport } from './durable-transport.js';
import { type SpawnProviderServerOptions, spawnProviderServerTransport } from '../../providers/app-server-transport.js';
import type { ProviderResponseObservationSink } from '../../providers/host-diagnostics.js';
import { CliBusyError } from '../../runtime/cli-busy.js';
import { getActiveLimit, parsePositiveInt } from './worker-limits.js';
import type { AdmissionResult, LaunchPool, QueuedHandle } from '../../jobs/contracts/admission.js';
import type { ExecutionOwner } from '../../runtime/execution-owner.js';

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

function unknownLaunchPool(pool: never): never {
  throw new Error(`Launch admission invariant violated: unknown pool ${JSON.stringify(pool)}.`);
}

export class DuplicateLaunchReservationError extends Error {
  constructor(jobId: string, pool: LaunchPool) {
    super(`Launch reservation already exists for job ${jobId} in pool ${pool}.`);
    this.name = 'DuplicateLaunchReservationError';
  }
}

export class LaunchCoordinator {
  private readonly cleanupHandles = new Map<symbol, () => void>();
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

  spawnProviderServer(
    options: SpawnProviderServerOptions,
    observeProviderResponse: ProviderResponseObservationSink = () => {},
  ) {
    return spawnProviderServerTransport({
      runtime: this.runtime,
      options,
      generation: this.nextProviderServerGeneration++,
      observeProviderResponse,
    });
  }

  spawnDurableJob(options: SpawnDurableJobOptions): Promise<CliExecResult> {
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
      releaseLaunch: (jobId, nextPool) => this.releaseLaunch(jobId, nextPool),
      shouldTerminateAfterLaunch: () => this.shutdownRequested,
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

  terminateAll(): void {
    this.shutdownRequested = true;
    this.drainQueuedLaunches(QUEUE_DRAINED_MESSAGE);
    const failures: unknown[] = [];
    for (const cleanup of this.cleanupHandles.values()) {
      try {
        cleanup();
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    this.cleanupHandles.clear();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to terminate ${failures.length} active child process cleanup handle(s).`,
      );
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
