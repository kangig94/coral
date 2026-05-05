import type { Runtime } from '../../runtime/ports.js';
import {
  type CliExecResult,
  type SpawnCliOptions,
  type SpawnDurableJobOptions,
  spawnCliTransport,
  spawnDurableJobTransport,
} from './durable-transport.js';
import { type SpawnProviderServerOptions, spawnProviderServerTransport } from './provider-server-transport.js';
import { CliBusyError } from '../../runtime/cli-busy.js';
import { getActiveLimit, parsePositiveInt } from './worker-limits.js';
import type { AdmissionResult, AdmittedHandle, LaunchPool, QueuedHandle } from '../../jobs/contracts/admission.js';

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
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PoolState = { active: Map<string, string>; queued: QueuedLaunchEntry[] };

const IMMEDIATE_ADMISSION: AdmittedHandle = { type: 'immediate' };
const QUEUE_CANCELED_MESSAGE = 'Launch canceled while queued';
const QUEUE_DRAINED_MESSAGE = 'Launch canceled while queue was drained';

export class LaunchCoordinator {
  private readonly cleanupHandles = new Map<symbol, () => void>();
  private nextProviderServerGeneration = 1;
  private readonly pools: Map<LaunchPool, PoolState> = new Map<LaunchPool, PoolState>();
  private readonly signalLaunchPermits = new WeakMap<AbortSignal, { jobId: string; pool: LaunchPool }>();
  private readonly runtime: Runtime;

  constructor(options: { runtime: Runtime }) {
    this.runtime = options.runtime;
    this.pools.set('default', { active: new Map<string, string>(), queued: [] });
    this.pools.set('discuss', { active: new Map<string, string>(), queued: [] });
    this.pools.set('curate', { active: new Map<string, string>(), queued: [] });
  }

  get active(): number {
    let total = 0;
    for (const state of this.pools.values()) {
      total += state.active.size;
    }
    return total;
  }

  requestLaunch(jobId: string, provider: string, pool: LaunchPool = 'default'): AdmissionResult {
    const activeLaunches = this.getActiveMap(pool);
    const queuedLaunches = this.getQueue(pool);
    if (activeLaunches.has(jobId)) return IMMEDIATE_ADMISSION;

    const existingQueued = this.findQueuedLaunch(jobId, pool);
    if (existingQueued) return this.queuedHandle(existingQueued, pool);

    if (queuedLaunches.length === 0 && this.hasLaunchCapacity(pool)) {
      activeLaunches.set(jobId, provider);
      return IMMEDIATE_ADMISSION;
    }

    if (queuedLaunches.length >= getMaxQueueSize(this.runtime.env)) return 'queue_full';

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });

    const entry: QueuedLaunchEntry = { jobId, provider, promise, resolve, reject };
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
    const [entry] = queuedLaunches.splice(index, 1);
    entry.reject(new Error(QUEUE_CANCELED_MESSAGE));
    this.admitQueueHead(pool);
    return true;
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

  bindLaunchPermit(jobId: string, signal: AbortSignal, pool: LaunchPool = 'default'): void {
    this.signalLaunchPermits.set(signal, { jobId, pool });
  }

  private rejectedPermitPromise(error: unknown): Promise<never> {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  spawnCli(options: SpawnCliOptions): Promise<CliExecResult> {
    const pool = options.pool ?? 'default';
    let internalPermitJobId: string | null;
    try {
      internalPermitJobId = this.reserveInternalPermitOrThrow(options, pool, 'spawncli');
    } catch (error: unknown) {
      return this.rejectedPermitPromise(error);
    }

    return spawnCliTransport({
      runtime: this.runtime,
      options,
      pool,
      internalPermitJobId,
      cleanupHandles: this.cleanupHandles,
      releaseLaunch: (jobId, nextPool) => this.releaseLaunch(jobId, nextPool),
    });
  }

  spawnProviderServer(options: SpawnProviderServerOptions) {
    return spawnProviderServerTransport({
      runtime: this.runtime,
      options,
      generation: this.nextProviderServerGeneration++,
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
    });
  }

  restoreActiveLaunch(jobId: string, provider: string, pool: LaunchPool = 'default'): void {
    this.getActiveMap(pool).set(jobId, provider);
  }

  restoreQueuedLaunch(jobId: string, provider: string, pool: LaunchPool = 'default'): QueuedHandle {
    const queuedLaunches = this.getQueue(pool);

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });

    const entry: QueuedLaunchEntry = { jobId, provider, promise, resolve, reject };
    queuedLaunches.push(entry);

    return this.queuedHandle(entry, pool);
  }

  terminateAll(): void {
    this.drainQueuedLaunches(QUEUE_DRAINED_MESSAGE);
    for (const cleanup of this.cleanupHandles.values()) {
      cleanup();
    }
    this.cleanupHandles.clear();
  }

  private getActiveMap(pool: LaunchPool): Map<string, string> {
    return this.pools.get(pool)?.active ?? new Map<string, string>();
  }

  private getQueue(pool: LaunchPool): QueuedLaunchEntry[] {
    return this.pools.get(pool)?.queued ?? [];
  }

  private hasLaunchCapacity(pool: LaunchPool): boolean {
    return this.getActiveMap(pool).size < getActiveLimit(pool, this.runtime.env);
  }

  private reserveInternalPermitOrThrow(
    options: Pick<SpawnCliOptions, 'permitGranted' | 'signal' | 'provider'>,
    pool: LaunchPool,
    prefix: string,
  ): string | null {
    const usingReservedPermit =
      options.permitGranted === true ||
      (options.signal ? this.consumeSignalPermit(options.signal, options.provider) : false);
    if (usingReservedPermit) {
      return null;
    }

    const activeLaunches = this.getActiveMap(pool);
    const queuedLaunches = this.getQueue(pool);
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
    activeLaunches.set(internalPermitJobId, options.provider);
    return internalPermitJobId;
  }

  private queuedHandle(entry: QueuedLaunchEntry, pool: LaunchPool): QueuedHandle {
    const queuePosition = this.queuePosition(entry.jobId, pool) ?? this.getQueue(pool).length;
    return {
      type: 'queued',
      queuePosition,
      waitForPermit: () => entry.promise,
      cancel: () => {
        this.cancelQueued(entry.jobId, pool);
      },
    };
  }

  private findQueuedLaunch(jobId: string, pool: LaunchPool): QueuedLaunchEntry | null {
    for (const entry of this.getQueue(pool)) {
      if (entry.jobId === jobId) return entry;
    }
    return null;
  }

  private admitQueueHead(pool: LaunchPool): void {
    const queue = this.getQueue(pool);
    const head = queue[0];
    if (!head) return;
    if (!this.hasLaunchCapacity(pool)) return;
    queue.shift();
    this.getActiveMap(pool).set(head.jobId, head.provider);
    head.resolve();
  }

  private drainQueuedLaunches(message: string): void {
    const error = new Error(message);
    for (const state of this.pools.values()) {
      const drained = state.queued.splice(0, state.queued.length);
      for (const entry of drained) {
        entry.reject(error);
      }
    }
  }

  private consumeSignalPermit(signal: AbortSignal, provider: string): boolean {
    const permit = this.signalLaunchPermits.get(signal);
    if (!permit) return false;
    this.signalLaunchPermits.delete(signal);
    return this.getActiveMap(permit.pool).get(permit.jobId) === provider;
  }
}
