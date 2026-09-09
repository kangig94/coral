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
  type HeldProviderServerSpawn,
  type ProviderContainmentAcceptance,
  type ProviderServerFailedSpawnCleanupAcceptor,
  type ProviderResponseObservationSink,
  type SpawnProviderServerOptions,
  spawnProviderServerTransport,
} from '../../providers/app-server-transport.js';
import { CliBusyError } from '../../runtime/cli-busy.js';
import { getActiveLimit, parsePositiveInt } from './worker-limits.js';
import type {
  AdmissionResult,
  LaunchCoordinatorPort,
  LaunchPermit,
  LaunchPool,
  LaunchRelease,
  LaunchReservationView,
  OperationBindingResult,
  PermitHolder,
  QueueCancellation,
  QueuedHandle,
} from '../../jobs/contracts/admission.js';
import type {
  ProviderOperationBindingIdentity,
  ProviderOperationBindingPort,
  ProviderOperationBindingState,
} from '../../jobs/contracts/provider-operation-lifecycle.js';
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
  reservationId: string;
  jobId: string;
  provider: string;
  executionOwner: ExecutionOwner;
  targetHolder: PermitHolder;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  admittedPermit: LaunchPermit | null;
  claimedPermit: LaunchPermit | null;
  permitPromise: Promise<LaunchPermit> | null;
  cancellation: QueueCancellation | null;
};

type ActiveLaunchReservation = Readonly<{
  permit: LaunchPermit;
  executionOwner: ExecutionOwner;
}>;

type PoolState = { active: Map<string, ActiveLaunchReservation>; queued: QueuedLaunchEntry[] };

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

type CleanupAttemptState =
  | Readonly<{ kind: 'running'; task: Promise<DurableProcessCleanupOutcome> }>
  | Readonly<{
      kind: 'settled';
      task: Promise<DurableProcessCleanupOutcome>;
      outcome: PromiseSettledResult<DurableProcessCleanupOutcome>;
    }>;

type CleanupOutcomeConsumption = Readonly<{ kind: 'observed-absent' }> | Readonly<{ kind: 'retained' }>;

export class LaunchCoordinator implements LaunchCoordinatorPort, ProviderOperationBindingPort {
  private readonly cleanupHandles = new Map<symbol, DurableProcessCleanup>();
  private readonly cleanupRetentions = new Map<DurableProcessCleanup, DurableProcessRetention>();
  private readonly cleanupAttempts = new Map<DurableProcessCleanup, CleanupAttemptState>();
  private readonly pendingDurableLaunches = new Set<PendingDurableLaunch>();
  private nextProviderServerGeneration = 1;
  private readonly pools: Record<LaunchPool, PoolState> = {
    default: { active: new Map(), queued: [] },
    discuss: { active: new Map(), queued: [] },
    curate: { active: new Map(), queued: [] },
  };
  private readonly operationBindings = new Map<string, ProviderOperationBindingState>();
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

  requestLaunch(jobId: string, provider: string, executionOwner: ExecutionOwner, pool: LaunchPool): AdmissionResult {
    if (this.shutdownRequested) throw new Error(SHUTDOWN_LAUNCH_REJECTED_MESSAGE);
    const activeLaunches = this.getActiveMap(pool);
    const queuedLaunches = this.getQueue(pool);
    this.rejectDuplicateReservation(jobId);

    if (queuedLaunches.length === 0 && this.hasLaunchCapacity(pool)) {
      const permit = this.createPermit({
        reservationId: this.runtime.ids.uuid(),
        jobId,
        pool,
        provider,
        holder: { kind: 'local-execution' },
      });
      activeLaunches.set(jobId, { permit, executionOwner });
      return { type: 'immediate', permit };
    }

    if (queuedLaunches.length >= getMaxQueueSize(this.runtime.env)) return 'queue_full';

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });

    const entry: QueuedLaunchEntry = {
      reservationId: this.runtime.ids.uuid(),
      jobId,
      provider,
      executionOwner,
      targetHolder: { kind: 'local-execution' },
      promise,
      resolve,
      reject,
      admittedPermit: null,
      claimedPermit: null,
      permitPromise: null,
      cancellation: null,
    };
    queuedLaunches.push(entry);
    return this.queuedHandle(entry, pool);
  }

  releaseLaunch(permit: LaunchPermit): LaunchRelease {
    const activeLaunches = this.getActiveMap(permit.pool);
    const active = activeLaunches.get(permit.jobId);
    if (active === undefined || active.permit.reservationId !== permit.reservationId) {
      return { kind: 'already-released', pool: permit.pool };
    }
    if (!this.sameHolder(active.permit.holder, permit.holder)) {
      return { kind: 'transferred', pool: permit.pool, holder: active.permit.holder };
    }
    activeLaunches.delete(permit.jobId);
    return { kind: 'released', pool: permit.pool, admittedNext: this.admitQueueHead(permit.pool) };
  }

  cancelQueued(jobId: string, pool: LaunchPool): boolean {
    const queuedLaunches = this.getQueue(pool);
    const index = queuedLaunches.findIndex((entry) => entry.jobId === jobId);
    if (index === -1) return false;
    const entry = queuedLaunches[index];
    if (entry === undefined) return false;
    return this.cancelQueuedEntry(entry, pool).kind === 'cancelled';
  }

  queueDepth(pool: LaunchPool = 'default'): number {
    return this.getQueue(pool).length;
  }

  queuePosition(jobId: string, pool: LaunchPool): number | null {
    const index = this.getQueue(pool).findIndex((entry) => entry.jobId === jobId);
    return index === -1 ? null : index + 1;
  }

  getActiveJobIds(pool: LaunchPool = 'default'): string[] {
    return [...this.getActiveMap(pool).keys()];
  }

  reservationFor(jobId: string): LaunchReservationView | null {
    for (const [pool, state] of Object.entries(this.pools) as Array<[LaunchPool, PoolState]>) {
      const active = state.active.get(jobId);
      if (active !== undefined) {
        return {
          kind: 'active',
          pool,
          provider: active.permit.provider,
          executionOwner: active.executionOwner,
          holder: active.permit.holder,
          heldForMs: Math.max(0, this.runtime.time.now() - active.permit.acquiredAt),
        };
      }
      const position = state.queued.findIndex((entry) => entry.jobId === jobId);
      const queued = state.queued[position];
      if (queued !== undefined) {
        return {
          kind: 'queued',
          pool,
          provider: queued.provider,
          executionOwner: queued.executionOwner,
          position: position + 1,
        };
      }
    }
    return null;
  }

  private rejectedPermitPromise(error: unknown): Promise<never> {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  async spawnProviderServer(
    options: SpawnProviderServerOptions,
    observeProviderResponse: ProviderResponseObservationSink = () => {},
    generation = this.allocateProviderServerGeneration(),
    recordContainment:
      | ((containment: ContainedProviderServerHandle['containmentIdentity']) => ProviderContainmentAcceptance)
      | undefined,
    acceptFailedSpawnCleanup: ProviderServerFailedSpawnCleanupAcceptor,
  ): Promise<ContainedProviderServerHandle | HeldProviderServerSpawn> {
    if (this.shutdownRequested) throw new Error(SHUTDOWN_LAUNCH_REJECTED_MESSAGE);
    assertProviderHostPlatformSupported(this.runtime.env.platform());
    return spawnProviderServerTransport({
      runtime: this.runtime,
      options,
      generation,
      observeProviderResponse,
      detached: true,
      acceptFailedSpawnCleanup,
      ...(recordContainment === undefined ? {} : { recordContainment }),
    });
  }

  allocateProviderServerGeneration(): number {
    return this.nextProviderServerGeneration++;
  }

  spawnDurableJob(options: SpawnDurableJobOptions): Promise<CliExecResult> {
    if (this.shutdownRequested) return this.rejectedPermitPromise(new Error(SHUTDOWN_LAUNCH_REJECTED_MESSAGE));
    const pool = options.pool ?? 'default';
    let internalPermit: LaunchPermit | null;
    try {
      internalPermit = this.reserveInternalPermitOrThrow(options, pool, 'spawndurable');
    } catch (error: unknown) {
      return this.rejectedPermitPromise(error);
    }

    return spawnDurableJobTransport({
      runtime: this.runtime,
      options,
      pool,
      internalPermit,
      cleanupHandles: this.cleanupHandles,
      cleanupRetentions: this.cleanupRetentions,
      pendingLaunches: this.pendingDurableLaunches,
      releaseLaunch: (permit) => this.releaseLaunch(permit),
    });
  }

  restoreActiveLaunch(
    jobId: string,
    provider: string,
    executionOwner: ExecutionOwner,
    pool: LaunchPool,
  ): LaunchPermit {
    this.rejectDuplicateReservation(jobId);
    const permit = this.createPermit({
      reservationId: this.runtime.ids.uuid(),
      jobId,
      pool,
      provider,
      holder: { kind: 'recovery' },
    });
    this.getActiveMap(pool).set(jobId, { permit, executionOwner });
    return permit;
  }

  restoreQueuedLaunch(
    jobId: string,
    provider: string,
    executionOwner: ExecutionOwner,
    pool: LaunchPool,
  ): QueuedHandle {
    this.rejectDuplicateReservation(jobId);
    const queuedLaunches = this.getQueue(pool);

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });

    const entry: QueuedLaunchEntry = {
      reservationId: this.runtime.ids.uuid(),
      jobId,
      provider,
      executionOwner,
      targetHolder: { kind: 'recovery' },
      promise,
      resolve,
      reject,
      admittedPermit: null,
      claimedPermit: null,
      permitPromise: null,
      cancellation: null,
    };
    queuedLaunches.push(entry);

    return this.queuedHandle(entry, pool);
  }

  prepareProviderOperationBinding(
    permit: LaunchPermit,
    identity: ProviderOperationBindingIdentity,
  ): OperationBindingResult {
    if (identity.jobId !== permit.jobId) {
      return { kind: 'refused', reason: 'The operation identity does not name the permit job.' };
    }
    if (permit.holder.kind !== 'local-execution' && permit.holder.kind !== 'recovery') {
      return { kind: 'refused', reason: 'The source permit holder cannot publish a proxy operation.' };
    }

    const key = this.operationBindingKey(identity);
    const current = this.operationBindings.get(key);
    if (current?.kind === 'settled-unbound') {
      if (!this.permitIsCurrent(permit)) {
        return { kind: 'refused', reason: 'The source permit is not the active reservation.' };
      }
      this.operationBindings.set(key, { kind: 'settled', reservationId: permit.reservationId });
      this.releaseLaunch(permit);
      return { kind: 'already-settled' };
    }
    if (current?.kind === 'settled') {
      return current.reservationId === permit.reservationId
        ? { kind: 'already-settled' }
        : { kind: 'refused', reason: 'The operation identity already settled a different reservation.' };
    }
    if (current?.kind === 'prepared') {
      return current.sourcePermit.reservationId === permit.reservationId &&
        this.sameHolder(current.sourcePermit.holder, permit.holder)
        ? { kind: 'prepared' }
        : { kind: 'refused', reason: 'The operation identity is prepared for a different reservation.' };
    }
    if (current?.kind === 'bound') {
      return current.proxyPermit.reservationId === permit.reservationId
        ? { kind: 'bound', successorPermit: current.proxyPermit }
        : { kind: 'refused', reason: 'The operation identity is bound to a different reservation.' };
    }
    if (!this.permitIsCurrent(permit)) {
      return { kind: 'refused', reason: 'The source permit is not the active reservation.' };
    }

    this.operationBindings.set(key, { kind: 'prepared', sourcePermit: permit });
    return { kind: 'prepared' };
  }

  cancelProviderOperationBinding(
    permit: LaunchPermit,
    identity: ProviderOperationBindingIdentity,
  ): OperationBindingResult {
    if (identity.jobId !== permit.jobId) {
      return { kind: 'refused', reason: 'The operation identity does not name the permit job.' };
    }
    const key = this.operationBindingKey(identity);
    const current = this.operationBindings.get(key);
    if (
      current?.kind !== 'prepared' ||
      current.sourcePermit.reservationId !== permit.reservationId ||
      !this.sameHolder(current.sourcePermit.holder, permit.holder)
    ) {
      return { kind: 'refused', reason: 'No matching prepared operation binding exists.' };
    }
    this.operationBindings.delete(key);
    return { kind: 'cancelled' };
  }

  commitProviderOperationBinding(identity: ProviderOperationBindingIdentity): OperationBindingResult {
    const key = this.operationBindingKey(identity);
    const current = this.operationBindings.get(key);
    if (current?.kind === 'settled-unbound' || current?.kind === 'settled') {
      return { kind: 'already-settled' };
    }
    if (current?.kind === 'bound') {
      return { kind: 'bound', successorPermit: current.proxyPermit };
    }
    if (current?.kind !== 'prepared') {
      return { kind: 'refused', reason: 'The operation identity has no prepared reservation.' };
    }

    const sourcePermit = current.sourcePermit;
    const active = this.getActiveMap(sourcePermit.pool).get(sourcePermit.jobId);
    if (active === undefined || active.permit.reservationId !== sourcePermit.reservationId) {
      return { kind: 'refused', reason: 'The prepared source reservation is no longer active.' };
    }
    if (!this.sameHolder(active.permit.holder, sourcePermit.holder)) {
      return { kind: 'refused', reason: 'The prepared source reservation has transferred to another holder.' };
    }

    const successorPermit = {
      ...sourcePermit,
      holder: { kind: 'proxy-operation', operationId: identity.operationId },
    } satisfies LaunchPermit;
    this.getActiveMap(sourcePermit.pool).set(sourcePermit.jobId, {
      permit: successorPermit,
      executionOwner: active.executionOwner,
    });
    this.operationBindings.set(key, { kind: 'bound', proxyPermit: successorPermit });
    return { kind: 'bound', successorPermit };
  }

  settleProviderOperationBinding(identity: ProviderOperationBindingIdentity): OperationBindingResult {
    const key = this.operationBindingKey(identity);
    const current = this.operationBindings.get(key);
    if (current === undefined) {
      this.operationBindings.set(key, { kind: 'settled-unbound' });
      return { kind: 'settled-unbound' };
    }
    if (current.kind === 'settled-unbound' || current.kind === 'settled') {
      return { kind: 'already-settled' };
    }

    const permit = current.kind === 'prepared' ? current.sourcePermit : current.proxyPermit;
    this.operationBindings.set(key, { kind: 'settled', reservationId: permit.reservationId });
    this.releaseLaunch(permit);
    return { kind: 'settled', reservationId: permit.reservationId };
  }

  retireProviderOperationBinding(identity: ProviderOperationBindingIdentity): boolean {
    const key = this.operationBindingKey(identity);
    const current = this.operationBindings.get(key);
    if (current?.kind !== 'settled' && current?.kind !== 'settled-unbound') return false;
    return this.operationBindings.delete(key);
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
    const consumeOutcome = (
      cleanup: DurableProcessCleanup,
      task: Promise<DurableProcessCleanupOutcome>,
      outcome: PromiseSettledResult<DurableProcessCleanupOutcome>,
    ): CleanupOutcomeConsumption => {
      const state = this.cleanupAttempts.get(cleanup);
      if (state?.task === task) this.cleanupAttempts.delete(cleanup);
      if (outcome.status === 'rejected') {
        failures.set(cleanup, outcome.reason);
        return { kind: 'retained' };
      }
      if (outcome.value.kind !== 'observed-absent') {
        unsettled.set(cleanup, outcome.value);
        return { kind: 'retained' };
      }
      failures.delete(cleanup);
      unsettled.delete(cleanup);
      for (const [key, registeredCleanup] of this.cleanupHandles) {
        if (registeredCleanup === cleanup) this.cleanupHandles.delete(key);
      }
      this.cleanupRetentions.delete(cleanup);
      return { kind: 'observed-absent' };
    };
    const startAttempt = (
      cleanup: DurableProcessCleanup,
      task: Promise<DurableProcessCleanupOutcome>,
    ): Promise<DurableProcessCleanupOutcome> => {
      const running = { kind: 'running', task } as const;
      this.cleanupAttempts.set(cleanup, running);
      void task.then(
        (value) => {
          if (this.cleanupAttempts.get(cleanup) === running) {
            this.cleanupAttempts.set(cleanup, { kind: 'settled', task, outcome: { status: 'fulfilled', value } });
          }
        },
        (reason: unknown) => {
          if (this.cleanupAttempts.get(cleanup) === running) {
            this.cleanupAttempts.set(cleanup, { kind: 'settled', task, outcome: { status: 'rejected', reason } });
          }
        },
      );
      return task;
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
        const seen = new Set<DurableProcessCleanup>();
        for (const cleanup of this.cleanupHandles.values()) {
          if (seen.has(cleanup)) continue;
          seen.add(cleanup);
          try {
            const state = this.cleanupAttempts.get(cleanup);
            if (state?.kind === 'settled') {
              if (consumeOutcome(cleanup, state.task, state.outcome).kind === 'observed-absent') continue;
            }
            const running = this.cleanupAttempts.get(cleanup);
            const task = running?.kind === 'running' ? running.task : startAttempt(cleanup, cleanup());
            attempts.push({ cleanup, task });
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
          consumeOutcome(attempt.cleanup, attempt.task, outcome);
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

  private getActiveMap(pool: LaunchPool): Map<string, ActiveLaunchReservation> {
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
  ): LaunchPermit | null {
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
    this.rejectDuplicateReservation(internalPermitJobId);
    const permit = this.createPermit({
      reservationId: this.runtime.ids.uuid(),
      jobId: internalPermitJobId,
      pool,
      provider: options.provider,
      holder: { kind: 'system-task', id: internalPermitJobId },
    });
    activeLaunches.set(internalPermitJobId, {
      permit,
      executionOwner: { kind: 'system-task', id: internalPermitJobId },
    });
    return permit;
  }

  private queuedHandle(entry: QueuedLaunchEntry, pool: LaunchPool): QueuedHandle {
    const queuePosition = this.queuePosition(entry.jobId, pool) ?? this.getQueue(pool).length;
    return {
      type: 'queued',
      queuePosition,
      waitForPermit: () => {
        entry.permitPromise ??= entry.promise.then(() => this.claimQueuedPermit(entry, pool));
        return entry.permitPromise;
      },
      cancel: () => this.cancelQueuedEntry(entry, pool),
    };
  }

  private cancelQueuedEntry(entry: QueuedLaunchEntry, pool: LaunchPool): QueueCancellation {
    if (entry.cancellation !== null) return entry.cancellation;
    const queuedLaunches = this.getQueue(pool);
    const index = queuedLaunches.indexOf(entry);
    if (index !== -1) {
      queuedLaunches.splice(index, 1);
      entry.cancellation = { kind: 'cancelled' };
      entry.reject(new Error(QUEUE_CANCELED_MESSAGE));
      this.admitQueueHead(pool);
      return entry.cancellation;
    }
    const permit = entry.claimedPermit ?? entry.admittedPermit;
    if (permit === null) {
      entry.cancellation = { kind: 'cancelled' };
      return entry.cancellation;
    }
    entry.cancellation = { kind: 'admitted', permit };
    return entry.cancellation;
  }

  private rejectDuplicateReservation(jobId: string): void {
    for (const [existingPool, state] of Object.entries(this.pools) as Array<[LaunchPool, PoolState]>) {
      if (state.active.has(jobId) || state.queued.some((entry) => entry.jobId === jobId)) {
        throw new DuplicateLaunchReservationError(jobId, existingPool);
      }
    }
  }

  private admitQueueHead(pool: LaunchPool): boolean {
    const queue = this.getQueue(pool);
    const head = queue[0];
    if (!head) return false;
    if (!this.hasLaunchCapacity(pool)) return false;
    queue.shift();
    this.rejectDuplicateReservation(head.jobId);
    const permit = this.createPermit({
      reservationId: head.reservationId,
      jobId: head.jobId,
      pool,
      provider: head.provider,
      holder: { kind: 'queue-handoff' },
    });
    this.getActiveMap(pool).set(head.jobId, { permit, executionOwner: head.executionOwner });
    head.admittedPermit = permit;
    head.resolve();
    return true;
  }

  private drainQueuedLaunches(message: string): void {
    const error = new Error(message);
    for (const state of Object.values(this.pools)) {
      const drained = state.queued.splice(0, state.queued.length);
      for (const entry of drained) {
        entry.cancellation = { kind: 'cancelled' };
        entry.reject(error);
      }
    }
  }

  private claimQueuedPermit(entry: QueuedLaunchEntry, pool: LaunchPool): LaunchPermit {
    if (entry.claimedPermit !== null) return entry.claimedPermit;
    if (entry.cancellation?.kind === 'admitted') return entry.cancellation.permit;
    const admittedPermit = entry.admittedPermit;
    const active = this.getActiveMap(pool).get(entry.jobId);
    if (
      admittedPermit === null ||
      active === undefined ||
      active.permit.reservationId !== entry.reservationId ||
      active.permit.holder.kind !== 'queue-handoff'
    ) {
      throw new Error('Launch permit was released before the queued waiter claimed it.');
    }
    const claimedPermit = { ...admittedPermit, holder: entry.targetHolder } satisfies LaunchPermit;
    this.getActiveMap(pool).set(entry.jobId, { permit: claimedPermit, executionOwner: entry.executionOwner });
    entry.claimedPermit = claimedPermit;
    return claimedPermit;
  }

  private createPermit(input: Omit<LaunchPermit, 'acquiredAt'>): LaunchPermit {
    return { ...input, acquiredAt: this.runtime.time.now() };
  }

  private operationBindingKey(identity: ProviderOperationBindingIdentity): string {
    return `${identity.jobId}\u0000${identity.operationId}`;
  }

  private permitIsCurrent(permit: LaunchPermit): boolean {
    const active = this.getActiveMap(permit.pool).get(permit.jobId);
    return (
      active !== undefined &&
      active.permit.reservationId === permit.reservationId &&
      this.sameHolder(active.permit.holder, permit.holder)
    );
  }

  private sameHolder(left: PermitHolder, right: PermitHolder): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === 'system-task' && right.kind === 'system-task') return left.id === right.id;
    if (left.kind === 'proxy-operation' && right.kind === 'proxy-operation') {
      return left.operationId === right.operationId;
    }
    return true;
  }
}
