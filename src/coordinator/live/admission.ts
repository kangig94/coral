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
import { AbortRegistry } from '../../jobs/shell/abort-registry.js';
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
  LaunchPermitDiagnostic,
  LaunchPermitReclamationDiagnostic,
  LaunchPermitReclamationEvidence,
  LaunchReclamationProbeResult,
  LaunchPool,
  LaunchRelease,
  LaunchReleaseDiagnostic,
  LaunchReservationView,
  PermitHolder,
  QueueCancellation,
  QueuedHandle,
  ReclaimablePermitHolderKind,
} from '../../jobs/contracts/admission.js';
import type {
  ProviderOperationCancellationResult,
  ProviderOperationCommitResult,
  ProviderOperationBindingIdentity,
  ProviderOperationBindingPort,
  ProviderOperationBindingRetirementDisposition,
  ProviderOperationJournalProbeResult,
  ProviderOperationPrepareResult,
  ProviderOperationSettlementResult,
  SettledUnboundStatusHydrationResult,
  SettledUnboundStatusAbsence,
  SettledUnboundStatusOwnership,
  SettledUnboundStatusSubject,
  SettledUnboundStatusPort,
} from '../../jobs/contracts/provider-operation-lifecycle.js';
import type { ExecutionOwner } from '../../runtime/execution-owner.js';
import { assertProviderHostPlatformSupported } from '../../providers/host-admission.js';
import type { TimerHandle } from '../../infra/port-types.js';

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

type ProviderOperationBindingState =
  | Readonly<{
      kind: 'settled-unbound';
      identity: ProviderOperationBindingIdentity;
      unknownObservations: number;
      successor:
        | Readonly<{ kind: 'mailbox' }>
        | Readonly<{ kind: 'provider-operation-journal' }>
        | Readonly<{ kind: 'recovery-quarantine'; ownership: SettledUnboundStatusOwnership }>
        | Readonly<{ kind: 'status-recording-refused' }>;
    }>
  | Readonly<{ kind: 'prepared'; sourcePermit: LaunchPermit }>
  | Readonly<{ kind: 'bound'; proxyPermit: LaunchPermit }>
  | Readonly<{ kind: 'settled'; reservationId: string }>;

const QUEUE_CANCELED_MESSAGE = 'Launch canceled while queued';
const QUEUE_DRAINED_MESSAGE = 'Launch canceled while queue was drained';
const SHUTDOWN_LAUNCH_REJECTED_MESSAGE = 'Launch rejected because shutdown has begun';
const TERMINATION_RETRY_INTERVAL_MS = 50;
export const MAX_LAUNCH_RELEASE_DIAGNOSTICS = 100;
export const MAX_LAUNCH_RECLAMATION_DIAGNOSTICS = 100;
// Admission precedes the first job journal append, so journal absence cannot authorize release inside this window.
export const LAUNCH_RECLAMATION_AGE_FLOOR_MS = 30_000;
export const LAUNCH_RECLAMATION_SWEEP_INTERVAL_MS = 5_000;
export const MAX_SETTLED_UNBOUND_BINDINGS = 1_024;
export const SETTLED_UNBOUND_ABSENCE_CHECK_MS = 30_000;
export const SETTLED_UNBOUND_UNKNOWN_OBSERVATION_LIMIT = 3;

function unknownLaunchPool(pool: never): never {
  throw new Error(`Launch admission invariant violated: unknown pool ${JSON.stringify(pool)}.`);
}

export class DuplicateLaunchReservationError extends Error {
  constructor(jobId: string, pool: LaunchPool) {
    super(`Launch reservation already exists for job ${jobId} in pool ${pool}.`);
    this.name = 'DuplicateLaunchReservationError';
  }
}

export type PendingLaunchSettlementDisposition =
  | Readonly<{ kind: 'all-pending-launches-settled' }>
  | Readonly<{
      kind: 'pending-launches-unresolved-at-deadline';
      pendingLaunches: number;
      retainedLaunches: readonly PendingDurableLaunchIdentity[];
      owner: 'launch-coordinator';
    }>;

export type ChildTerminationDisposition =
  | Readonly<{ kind: 'all-children-observed-absent' }>
  | Readonly<{
      kind: 'children-unresolved-at-deadline';
      processes: readonly Exclude<DurableProcessCleanupOutcome, { kind: 'observed-absent' }>[];
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

type LaunchReclamationOracle<K extends ReclaimablePermitHolderKind = ReclaimablePermitHolderKind> = (
  permit: LaunchPermit & { holder: Extract<PermitHolder, { kind: K }> },
) => LaunchReclamationProbeResult<K>;

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
  private readonly settledUnboundChecks = new Map<string, TimerHandle>();
  private readonly nonReleasedLaunches = new Map<string, LaunchReleaseDiagnostic>();
  private readonly reclaimedLaunches = new Map<string, LaunchPermitReclamationDiagnostic>();
  private readonly launchReclamationOracles = new Map<ReclaimablePermitHolderKind, LaunchReclamationOracle>();
  private readonly internalAbortRegistry: AbortRegistry;
  private shutdownRequested = false;
  private providerOperationJournalProbe:
    | ((identity: ProviderOperationBindingIdentity) => ProviderOperationJournalProbeResult)
    | null = null;
  private settledUnboundStatus: SettledUnboundStatusPort | null = null;
  private readonly runtime: Runtime;

  constructor(options: { runtime: Runtime }) {
    this.runtime = options.runtime;
    this.internalAbortRegistry = new AbortRegistry(options.runtime.ids);
  }

  getInternalAbortRegistry(): AbortRegistry {
    return this.internalAbortRegistry;
  }

  connectProviderOperationBindingJournal(
    probe: (identity: ProviderOperationBindingIdentity) => ProviderOperationJournalProbeResult,
  ): void {
    this.providerOperationJournalProbe = probe;
  }

  connectSettledUnboundStatus(status: SettledUnboundStatusPort): void {
    this.settledUnboundStatus = status;
  }

  connectLaunchReclamationOracle(kind: 'local-execution', oracle: LaunchReclamationOracle<'local-execution'>): void;
  connectLaunchReclamationOracle(kind: 'recovery', oracle: LaunchReclamationOracle<'recovery'>): void;
  connectLaunchReclamationOracle(kind: 'proxy-operation', oracle: LaunchReclamationOracle<'proxy-operation'>): void;
  connectLaunchReclamationOracle(
    kind: 'undecided-provider-operation',
    oracle: LaunchReclamationOracle<'undecided-provider-operation'>,
  ): void;
  connectLaunchReclamationOracle(kind: ReclaimablePermitHolderKind, oracle: unknown): void {
    this.launchReclamationOracles.set(kind, oracle as LaunchReclamationOracle);
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
      return this.recordNonReleasedLaunch(permit, { kind: 'already-released', pool: permit.pool });
    }
    if (!this.sameHolder(active.permit.holder, permit.holder)) {
      return this.recordNonReleasedLaunch(permit, {
        kind: 'transferred',
        pool: permit.pool,
        holder: active.permit.holder,
      });
    }
    activeLaunches.delete(permit.jobId);
    this.cancelPreparedBindingsForPermit(permit);
    return { kind: 'released', pool: permit.pool, admittedNext: this.admitQueueHead(permit.pool) };
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

  activeLaunchPermits(): LaunchPermitDiagnostic[] {
    const now = this.runtime.time.now();
    return (Object.entries(this.pools) as Array<[LaunchPool, PoolState]>).flatMap(([pool, state]) =>
      [...state.active.values()].map(({ permit, executionOwner }) => ({
        reservationId: permit.reservationId,
        jobId: permit.jobId,
        pool,
        provider: permit.provider,
        holder: permit.holder,
        executionOwner,
        heldForMs: Math.max(0, now - permit.acquiredAt),
      })),
    );
  }

  launchReleaseDiagnostics(): LaunchReleaseDiagnostic[] {
    return [...this.nonReleasedLaunches.values()];
  }

  launchReclamationDiagnostics(): LaunchPermitReclamationDiagnostic[] {
    return [...this.reclaimedLaunches.values()];
  }

  sweepStaleLaunchPermits(): void {
    const now = this.runtime.time.now();

    for (const state of Object.values(this.pools)) {
      for (const { permit } of state.active.values()) {
        const heldForMs = Math.max(0, now - permit.acquiredAt);
        if (heldForMs < LAUNCH_RECLAMATION_AGE_FLOOR_MS) continue;

        this.reclaimLaunchPermit(permit);
      }
    }
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
          reservationId: queued.reservationId,
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

    const transport = {
      runtime: this.runtime,
      options,
      pool,
      cleanupHandles: this.cleanupHandles,
      cleanupRetentions: this.cleanupRetentions,
      pendingLaunches: this.pendingDurableLaunches,
      releaseLaunch: (permit: LaunchPermit) => this.releaseLaunch(permit),
    };
    if (internalPermit !== null) {
      return spawnDurableJobTransport({
        ...transport,
        ownership: { kind: 'internal', permit: internalPermit, abortRegistry: this.internalAbortRegistry },
      });
    }
    const callerOwnership = options.callerOwnership;
    if (callerOwnership === undefined || !this.permitIsCurrent(callerOwnership.permit)) {
      return this.rejectedPermitPromise(new Error('Caller-owned durable launch requires its active launch permit.'));
    }
    if (
      callerOwnership.permit.jobId !== options.jobId ||
      callerOwnership.permit.provider !== options.provider ||
      callerOwnership.permit.pool !== pool
    ) {
      return this.rejectedPermitPromise(new Error('Caller-owned durable launch permit does not match the launch.'));
    }
    return spawnDurableJobTransport({
      ...transport,
      ownership: {
        kind: 'caller',
        permit: callerOwnership.permit,
        abortRegistry: callerOwnership.abortHoldOwner,
      },
    });
  }

  restoreActiveLaunch(
    jobId: string,
    provider: string,
    executionOwner: ExecutionOwner,
    pool: LaunchPool,
    holder: Extract<PermitHolder, { kind: 'recovery' | 'undecided-provider-operation' }> = { kind: 'recovery' },
  ): LaunchPermit {
    this.rejectDuplicateReservation(jobId);
    if (holder.kind === 'undecided-provider-operation' && holder.recordKeys.length === 0) {
      throw new Error('Undecided provider-operation ownership must name at least one durable record.');
    }
    const permitHolder: PermitHolder =
      holder.kind === 'undecided-provider-operation'
        ? { kind: holder.kind, recordKeys: [...new Set(holder.recordKeys)] }
        : holder;
    const permit = this.createPermit({
      reservationId: this.runtime.ids.uuid(),
      jobId,
      pool,
      provider,
      holder: permitHolder,
    });
    this.getActiveMap(pool).set(jobId, { permit, executionOwner });
    return permit;
  }

  reclaimLaunchPermit(permit: LaunchPermit): boolean {
    const active = this.getActiveMap(permit.pool).get(permit.jobId);
    if (
      active === undefined ||
      active.permit.reservationId !== permit.reservationId ||
      !this.sameHolder(active.permit.holder, permit.holder)
    ) {
      return false;
    }
    if (permit.holder.kind === 'system-task' || permit.holder.kind === 'queue-handoff') return false;
    const reclaimablePermit = permit as LaunchPermit & {
      holder: Extract<PermitHolder, { kind: ReclaimablePermitHolderKind }>;
    };
    const oracle = this.launchReclamationOracles.get(reclaimablePermit.holder.kind);
    if (oracle === undefined) return false;
    let probe: LaunchReclamationProbeResult<ReclaimablePermitHolderKind>;
    try {
      probe = oracle(reclaimablePermit);
    } catch {
      return false;
    }
    const evidence = this.authorizeLaunchReclamation(reclaimablePermit, probe);
    if (evidence === null) return false;

    const reclaimedAtMs = this.runtime.time.now();
    this.getActiveMap(permit.pool).delete(permit.jobId);
    this.retireOperationBindingsForReclaimedPermit(permit);
    this.recordReclaimedLaunch({
      permit,
      heldForMs: Math.max(0, reclaimedAtMs - permit.acquiredAt),
      evidence,
      reclaimedAtMs,
    });
    this.admitQueueHead(permit.pool);
    return true;
  }

  private authorizeLaunchReclamation(
    permit: LaunchPermit & {
      holder: Extract<PermitHolder, { kind: ReclaimablePermitHolderKind }>;
    },
    probe: LaunchReclamationProbeResult<ReclaimablePermitHolderKind>,
  ): LaunchPermitReclamationEvidence | null {
    if (probe.kind === 'job-live') return null;
    switch (permit.holder.kind) {
      case 'local-execution':
      case 'recovery':
        return probe.kind === 'job-absent' || probe.kind === 'job-terminal' ? probe : null;
      case 'proxy-operation': {
        if (probe.kind !== 'provider-operation-absent') return null;
        return probe.operationId === permit.holder.operationId ? probe : null;
      }
      case 'undecided-provider-operation': {
        if (probe.kind !== 'provider-operation-records-absent') return null;
        return this.sameRecordKeys(probe.recordKeys, permit.holder.recordKeys) ? probe : null;
      }
    }
  }

  private sameRecordKeys(left: readonly string[], right: readonly string[]): boolean {
    const leftKeys = new Set(left);
    const rightKeys = new Set(right);
    if (leftKeys.size !== rightKeys.size) return false;
    return [...leftKeys].every((key) => rightKeys.has(key));
  }

  holdUndecidedProviderOperationLaunch(permit: LaunchPermit, recordKeys: readonly string[]): LaunchPermit | null {
    const active = this.getActiveMap(permit.pool).get(permit.jobId);
    if (
      (permit.holder.kind !== 'recovery' && permit.holder.kind !== 'undecided-provider-operation') ||
      active === undefined ||
      active.permit.reservationId !== permit.reservationId ||
      !this.sameHolder(active.permit.holder, permit.holder)
    ) {
      return null;
    }
    const existingRecordKeys = permit.holder.kind === 'undecided-provider-operation' ? permit.holder.recordKeys : [];
    const heldRecordKeys = [...new Set([...existingRecordKeys, ...recordKeys])];
    if (heldRecordKeys.length === 0) return null;
    const heldPermit = {
      ...active.permit,
      holder: {
        kind: 'undecided-provider-operation',
        recordKeys: heldRecordKeys,
      },
    } satisfies LaunchPermit;
    this.getActiveMap(permit.pool).set(permit.jobId, { ...active, permit: heldPermit });
    return heldPermit;
  }

  restoreQueuedLaunch(jobId: string, provider: string, executionOwner: ExecutionOwner, pool: LaunchPool): QueuedHandle {
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
  ): ProviderOperationPrepareResult {
    if (identity.jobId !== permit.jobId) {
      return { kind: 'refused', reason: 'The operation identity does not name the permit job.' };
    }
    if (
      permit.holder.kind !== 'local-execution' &&
      permit.holder.kind !== 'recovery' &&
      permit.holder.kind !== 'undecided-provider-operation'
    ) {
      return { kind: 'refused', reason: 'The source permit holder cannot publish a proxy operation.' };
    }

    const key = this.operationBindingKey(identity);
    const current = this.operationBindings.get(key);
    if (current?.kind === 'settled-unbound') {
      if (!this.permitIsCurrent(permit)) {
        return { kind: 'refused', reason: 'The source permit is not the active reservation.' };
      }
      if (!this.clearSettledUnboundSuccessor(current)) {
        return { kind: 'refused', reason: 'The durable unsettled settlement status could not be cleared.' };
      }
      this.clearSettledUnboundCheck(key);
      this.operationBindings.set(key, { kind: 'settled', reservationId: permit.reservationId });
      void this.releaseLaunch(permit);
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
  ): ProviderOperationCancellationResult {
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

  commitProviderOperationBinding(identity: ProviderOperationBindingIdentity): ProviderOperationCommitResult {
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

  settleProviderOperationBinding(identity: ProviderOperationBindingIdentity): ProviderOperationSettlementResult {
    const key = this.operationBindingKey(identity);
    const current = this.operationBindings.get(key);
    if (current === undefined) {
      if (!this.scheduleSettledUnboundCheck(key, identity)) {
        return { kind: 'refused', reason: 'The unsettled binding mailbox is at capacity.' };
      }
      this.operationBindings.set(key, {
        kind: 'settled-unbound',
        identity,
        unknownObservations: 0,
        successor: { kind: 'mailbox' },
      });
      return { kind: 'settled-unbound' };
    }
    if (current.kind === 'settled-unbound' || current.kind === 'settled') {
      return { kind: 'already-settled' };
    }

    const permit = current.kind === 'prepared' ? current.sourcePermit : current.proxyPermit;
    this.operationBindings.set(key, { kind: 'settled', reservationId: permit.reservationId });
    void this.releaseLaunch(permit);
    return { kind: 'settled', reservationId: permit.reservationId };
  }

  hydrateSettledUnboundStatus(subject: SettledUnboundStatusSubject): SettledUnboundStatusHydrationResult {
    const ownership = this.settledUnboundStatus?.rebind(subject) ?? null;
    if (ownership === null) {
      return { kind: 'refused', reason: 'The durable unsettled settlement status could not be rebound.' };
    }
    const identity = ownership.identity;
    const key = this.operationBindingKey(identity);
    const current = this.operationBindings.get(key);
    if (current !== undefined) {
      return current.kind === 'settled-unbound'
        ? { kind: 'already-settled' }
        : { kind: 'refused', reason: 'The operation identity already has another binding owner.' };
    }
    if (this.unresolvedSettledUnboundBindingCount() >= MAX_SETTLED_UNBOUND_BINDINGS) {
      return { kind: 'refused', reason: 'The unsettled binding mailbox is at capacity.' };
    }
    this.operationBindings.set(key, {
      kind: 'settled-unbound',
      identity,
      unknownObservations: 0,
      successor: { kind: 'recovery-quarantine', ownership },
    });
    this.scheduleSettledUnboundCheck(key, identity);
    return { kind: 'settled-unbound' };
  }

  retireProviderOperationBinding(
    identity: ProviderOperationBindingIdentity,
  ): ProviderOperationBindingRetirementDisposition {
    const key = this.operationBindingKey(identity);
    const current = this.operationBindings.get(key);
    if (current?.kind !== 'settled' && current?.kind !== 'settled-unbound') return { kind: 'nothing-to-retire' };
    return this.deleteOperationBinding(key)
      ? { kind: 'retired' }
      : { kind: 'refused', reason: 'The durable unsettled settlement status could not be cleared.' };
  }

  releaseSettledUnboundStatusAfterObservedAbsence(absence: SettledUnboundStatusAbsence): boolean {
    const key = this.operationBindingKey(absence.identity);
    const current = this.operationBindings.get(key);
    if (current === undefined) return true;
    if (current.kind !== 'settled-unbound' || current.successor.kind !== 'recovery-quarantine') return false;
    const [ownedSubject] = current.successor.ownership.subjects;
    if (
      current.successor.ownership.subjects.length !== 1 ||
      ownedSubject?.boundary !== absence.subject.boundary ||
      ownedSubject.key !== absence.subject.key ||
      ownedSubject.revision !== absence.subject.revision ||
      ownedSubject.state !== absence.subject.state
    ) {
      return false;
    }
    this.clearSettledUnboundCheck(key);
    return this.operationBindings.delete(key);
  }

  async settlePendingLaunches(signal?: AbortSignal): Promise<PendingLaunchSettlementDisposition> {
    this.shutdownRequested = true;
    this.drainQueuedLaunches(QUEUE_DRAINED_MESSAGE);
    const pendingLaunches = [...this.pendingDurableLaunches];
    if (pendingLaunches.length === 0) return { kind: 'all-pending-launches-settled' };

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

    try {
      const settlements = Promise.all(pendingLaunches.map((launch) => launch.settled));
      const joined = abort === null ? await settlements : await Promise.race([settlements, abort]);
      if (joined !== aborted) return { kind: 'all-pending-launches-settled' };

      const retainedLaunches = pendingLaunches.filter((launch) => this.pendingDurableLaunches.has(launch));
      if (retainedLaunches.length === 0) return { kind: 'all-pending-launches-settled' };
      return {
        kind: 'pending-launches-unresolved-at-deadline',
        pendingLaunches: retainedLaunches.length,
        retainedLaunches: retainedLaunches.map((launch) => launch.retainedIdentity()),
        owner: 'launch-coordinator',
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async terminateRegisteredChildren(signal?: AbortSignal): Promise<ChildTerminationDisposition> {
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
    const dispositionAtDeadline = (): ChildTerminationDisposition =>
      this.cleanupHandles.size === 0
        ? { kind: 'all-children-observed-absent' }
        : {
            kind: 'children-unresolved-at-deadline',
            processes: [...unsettled.values()],
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
      while (this.cleanupHandles.size > 0) {
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
          void consumeOutcome(attempt.cleanup, attempt.task, outcome);
        }

        if (this.cleanupHandles.size > 0) {
          const retryDelay = this.runtime.time.sleep(TERMINATION_RETRY_INTERVAL_MS).then(() => undefined);
          const retry = abort === null ? await retryDelay : await Promise.race([retryDelay, abort]);
          if (retry === aborted) return dispositionAtDeadline();
        }
      }

      return { kind: 'all-children-observed-absent' };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private getActiveMap(pool: LaunchPool): Map<string, ActiveLaunchReservation> {
    return this.getPoolState(pool).active;
  }

  private recordNonReleasedLaunch(
    permit: LaunchPermit,
    disposition: Exclude<LaunchRelease, { kind: 'released' }>,
  ): LaunchRelease {
    this.nonReleasedLaunches.delete(permit.reservationId);
    this.nonReleasedLaunches.set(permit.reservationId, {
      reservationId: permit.reservationId,
      jobId: permit.jobId,
      pool: permit.pool,
      provider: permit.provider,
      attemptedHolder: permit.holder,
      disposition,
      observedAtMs: this.runtime.time.now(),
    });
    if (this.nonReleasedLaunches.size > MAX_LAUNCH_RELEASE_DIAGNOSTICS) {
      const oldestReservationId = this.nonReleasedLaunches.keys().next().value;
      if (oldestReservationId !== undefined) this.nonReleasedLaunches.delete(oldestReservationId);
    }
    return disposition;
  }

  private recordReclaimedLaunch(input: {
    permit: LaunchPermit;
    heldForMs: number;
    evidence: LaunchPermitReclamationEvidence;
    reclaimedAtMs: number;
  }): void {
    const { permit, heldForMs, evidence, reclaimedAtMs } = input;
    this.reclaimedLaunches.delete(permit.reservationId);
    const diagnostic = {
      reservationId: permit.reservationId,
      jobId: permit.jobId,
      pool: permit.pool,
      provider: permit.provider,
      holder: permit.holder,
      heldForMs,
      evidence,
      reclaimedAtMs,
    } as LaunchPermitReclamationDiagnostic;
    this.reclaimedLaunches.set(permit.reservationId, diagnostic);
    if (this.reclaimedLaunches.size > MAX_LAUNCH_RECLAMATION_DIAGNOSTICS) {
      const oldestReservationId = this.reclaimedLaunches.keys().next().value;
      if (oldestReservationId !== undefined) this.reclaimedLaunches.delete(oldestReservationId);
    }
  }

  private cancelPreparedBindingsForPermit(permit: LaunchPermit): void {
    for (const [key, binding] of this.operationBindings) {
      if (binding.kind === 'prepared' && binding.sourcePermit.reservationId === permit.reservationId) {
        this.deleteOperationBinding(key);
      }
    }
  }

  private retireOperationBindingsForReclaimedPermit(permit: LaunchPermit): void {
    for (const [key, binding] of this.operationBindings) {
      const boundPermit =
        binding.kind === 'prepared' ? binding.sourcePermit : binding.kind === 'bound' ? binding.proxyPermit : null;
      if (boundPermit?.reservationId === permit.reservationId) this.deleteOperationBinding(key);
    }
  }

  private scheduleSettledUnboundCheck(key: string, identity: ProviderOperationBindingIdentity): boolean {
    if (
      !this.operationBindings.has(key) &&
      this.unresolvedSettledUnboundBindingCount() >= MAX_SETTLED_UNBOUND_BINDINGS
    ) {
      return false;
    }
    this.clearSettledUnboundCheck(key);
    const timer = this.runtime.time.setTimeout(() => {
      const current = this.operationBindings.get(key);
      if (current?.kind !== 'settled-unbound') {
        this.clearSettledUnboundCheck(key);
        return;
      }
      let observation: ProviderOperationJournalProbeResult;
      try {
        observation = this.providerOperationJournalProbe?.(identity) ?? {
          kind: 'unknown',
          reason: 'The provider-operation journal probe is not connected.',
        };
      } catch (error: unknown) {
        observation = {
          kind: 'unknown',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (observation.kind === 'absent') {
        if (
          current.successor.kind !== 'recovery-quarantine' &&
          this.settledUnboundStatus !== null &&
          !this.settledUnboundStatus.clearAbsent(identity)
        ) {
          this.scheduleSettledUnboundCheck(key, identity);
          return;
        }
        if (this.deleteOperationBinding(key)) return;
        this.scheduleSettledUnboundCheck(key, identity);
        return;
      }
      if (observation.kind === 'present' && current.successor.kind !== 'recovery-quarantine') {
        this.operationBindings.set(key, {
          ...current,
          unknownObservations: 0,
          successor: { kind: 'provider-operation-journal' },
        });
        this.scheduleSettledUnboundCheck(key, identity);
        return;
      }

      let next = current;
      if (observation.kind === 'unknown' && current.successor.kind !== 'recovery-quarantine') {
        const unknownObservations = Math.min(
          current.unknownObservations + 1,
          SETTLED_UNBOUND_UNKNOWN_OBSERVATION_LIMIT,
        );
        next = { ...current, unknownObservations };
        this.operationBindings.set(key, next);
        if (unknownObservations < SETTLED_UNBOUND_UNKNOWN_OBSERVATION_LIMIT) {
          this.scheduleSettledUnboundCheck(key, identity);
          return;
        }
      }

      const successor = this.settledUnboundStatus?.record(identity) ?? {
        kind: 'refused' as const,
        reason: 'The durable unsettled settlement status is not connected.',
      };
      if (successor.kind === 'absent') {
        if (!this.deleteOperationBinding(key)) this.scheduleSettledUnboundCheck(key, identity);
        return;
      }
      if (successor.kind === 'recorded') {
        this.operationBindings.set(key, {
          ...next,
          successor: { kind: 'recovery-quarantine', ownership: successor.ownership },
        });
        this.scheduleSettledUnboundCheck(key, identity);
        return;
      }
      this.operationBindings.set(key, { ...next, successor: { kind: 'status-recording-refused' } });
      this.scheduleSettledUnboundCheck(key, identity);
    }, SETTLED_UNBOUND_ABSENCE_CHECK_MS);
    timer.unref?.();
    this.settledUnboundChecks.set(key, timer);
    return true;
  }

  private unresolvedSettledUnboundBindingCount(): number {
    let count = 0;
    for (const binding of this.operationBindings.values()) {
      if (binding.kind === 'settled-unbound') count += 1;
    }
    return count;
  }

  private clearSettledUnboundCheck(key: string): void {
    const timer = this.settledUnboundChecks.get(key);
    if (timer === undefined) return;
    this.runtime.time.clearTimeout(timer);
    this.settledUnboundChecks.delete(key);
  }

  private deleteOperationBinding(key: string): boolean {
    const current = this.operationBindings.get(key);
    if (current?.kind === 'settled-unbound' && !this.clearSettledUnboundSuccessor(current)) return false;
    this.clearSettledUnboundCheck(key);
    return this.operationBindings.delete(key);
  }

  private clearSettledUnboundSuccessor(
    binding: Extract<ProviderOperationBindingState, { kind: 'settled-unbound' }>,
  ): boolean {
    if (binding.successor.kind === 'status-recording-refused') {
      this.settledUnboundStatus?.clearRefusal(binding.identity);
      return true;
    }
    if (binding.successor.kind !== 'recovery-quarantine') return true;
    if (this.settledUnboundStatus === null) return false;
    return this.settledUnboundStatus.clear(binding.identity, binding.successor.ownership);
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
    options: Pick<SpawnDurableJobOptions, 'callerOwnership' | 'provider'>,
    pool: LaunchPool,
    prefix: string,
  ): LaunchPermit | null {
    const poolState = this.getPoolState(pool);
    const usingReservedPermit = options.callerOwnership !== undefined;
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
    void entry.promise.catch(() => undefined);
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
    if (left.kind === 'undecided-provider-operation' && right.kind === 'undecided-provider-operation') {
      return (
        left.recordKeys.length === right.recordKeys.length &&
        left.recordKeys.every((recordKey) => right.recordKeys.includes(recordKey))
      );
    }
    return true;
  }
}
