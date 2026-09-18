import type { Server, ServerResponse } from 'node:http';
import { backendLog } from '../infra/backend-log.js';
import { readBackendInfo, type BackendInfo, type BackendInfoRemovalResult } from '../infra/backend-discovery.js';
import { formatError } from '../infra/error-format.js';
import { type LaunchCoordinator } from './live/admission.js';
import { BOUNDARY_TRANSFER_ATTEMPT_LIMIT } from '../obligation/settlement.js';
import type { RecoveryRegistry } from '../jobs/reconcile/registry.js';
import type { IdleTimer } from './live/idle.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import { canonicalizeWorkDir } from '../runtime/canonical-work-dir.js';
import type { Principal } from '../security/principal.js';
import type { DiscussContext } from '../discuss/shell/types.js';
import type { RecoveredDiscussResume } from '../discuss/shell/recovery.js';
import type { DiscussSessionStore } from '../discuss/shell/session-store.js';
import { type ProviderRegistry } from '../providers/registry.js';
import { isTerminalPhase } from '../jobs/phase.js';
import { parsePositiveInt } from './live/worker-limits.js';
import { createRecoveryCoordinator, type RecoveryCoordinator } from './services/recovery/index.js';
import { createReplacementBackendOwnershipChecker } from './ownership-checker.js';
import type { JobStore } from '../jobs/store.js';
import type { JobStatus } from '../jobs/records.js';
import { jobLaunchRequestBodySchema } from '../jobs/launch.js';
import { decodeProjectionJobExecutionOwner, decodeProjectionJobStoredRow } from '../jobs/projection-row.js';
import { appendJobTerminalRecorded } from '../jobs/terminal/recording.js';
import { deleteDurableCliProcessRuntimeMeta } from '../jobs/runtime-meta-store.js';
import { elapsedDurationMs } from '../jobs/duration.js';
import type { ProviderHostManager } from './live/provider-hosts/index.js';
import type { ProviderProxyAuthorityRegistry } from './live/provider-proxy/authority.js';
import type { Runtime } from '../runtime/ports.js';
import type {
  ProviderOperationReconcilerStopDisposition,
  StartupReconciliationReport,
} from './services/provider-operation-reconciler.js';
import type { RuntimeComponent } from './runtime-components/contract.js';
import type { RuntimeComponentRegistry } from './runtime-components/registry.js';
import { createRecoveryComponent } from './runtime-components/recovery-component.js';
import {
  SHUTDOWN_POLL_MS,
  runShutdownSequence,
  shutdownModeFromReason,
  type LifecycleWiringState,
  type SettlePendingLaunchesFn,
  type ShutdownMode,
  type ShutdownIncident,
  type ShutdownReason,
  type TerminateRegisteredChildrenFn,
  HANDOFF_DRAIN_TIMEOUT_MS,
} from './shutdown.js';
import type {
  ProcessExitRemainder,
  ProcessExitRemainderAcceptance,
  ShutdownHoldExit,
  ShutdownHoldReason,
  ShutdownSequenceDisposition,
  ShutdownUndischarged,
} from './shutdown-settlement.js';
import type { HandoffQuiescePort } from './execution-service.js';
import type { InterruptedAppServerReason } from '../jobs/reconcile/interrupted-reason.js';
import {
  bindWithHandoff,
  BackendAlreadyRunningError,
  createFileHandoffSignalLedger,
  HandoffEscalationError,
  type BoundCoordinator,
} from './handoff.js';
import {
  IncumbentMatchesError,
  type DesiredIncumbentIdentity,
  type IncumbentHealth,
  type IncumbentIdentity,
} from '../transport/ipc/handoff.js';
import {
  probeCoordinator,
  type CoordinatorDiscoveryRecord,
  type CoordinatorProbe,
  type DiscoveryRuntime,
} from '../infra/backend-discovery.js';
import type { RecoveryCapableService } from '../jobs/reconcile/contracts.js';
import type { ProjectRequestPort } from './contracts.js';
import type { TypedEventBus } from './event-bus.js';
import type { IpcListener, ListenIpcServerResult, PublishedIpcSocketAddress } from '../transport/ipc/server.js';
import { resolveRunningBundleDir } from '../infra/bundle-manifest.js';
import type { ValidatedHandoffTarget } from '../infra/handoff-target.js';
import type { Database } from '../store/db.js';
import type { ResolvedStoreEpoch } from '../store/epoch.js';
import {
  acquireProviderOperationMutationAdmission,
  type ProviderOperationMutationAdmission,
} from '../store/provider-operation-journal.js';
import { routeOrOpenBackendStoreAtStartup } from '../store/startup-store-routing.js';
import { ACTIVE_STORE_SELECTION_VERSION } from '../store/active-store-selection.js';
import { validateForeignHandoffTarget } from './handoff-routing/runner.js';
import type { CoordinatorStoreServices, StoreServicesRef } from './composition/store-services-ref.js';
import type { KbDaemonSupervisor } from './live/kb-daemon-supervisor.js';
import type { SystemProviderScope } from '../infra/provider-scope.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { StoreFormatDescription } from '../store/format-fingerprint.js';
import { decodeStoredBody } from '../store/body-codec.js';
import { rowToCoralEvent } from '../store/envelope.js';
import type { EventsRow } from '../store/schema.js';
import type { CommitEventsFn } from '../store/append.js';
import {
  type RecoveryObligationId,
  type RecoveryPolicy,
  type RecoverySettlementFact,
  type RecoverySubject,
} from '../recovery/containment.js';
import type { RecoveryRetryPolicy, RecoverySourceFactoryPlan } from '../recovery/source-registry.js';
import { RecoveryQuarantineStore } from '../recovery/quarantine.js';
import { createCoordinatorSocketAddressClaim } from './socket-address-claim.js';
import {
  crashedJobTerminalizationSource,
  type RawCrashedJobRow,
} from '../jobs/crashed-job-terminalization-recovery-source.js';
import { staleJobCleanupSource, type RawStaleJobCleanupRow } from '../jobs/stale-job-cleanup-recovery-source.js';
import { runShutdownCrashTerminalization } from './shutdown-recovery.js';
import { recordShutdownRemainder } from './shutdown-remainder.js';
import type {
  ShutdownObligationAbandonRequest,
  ShutdownObligationAbandonResult,
} from '../obligation/shutdown-abandonment.js';
import { runStartupStaleArtifactPrune } from './startup-recovery.js';
import type { ProviderOperationStartupOwnership, RunJobsStartupFn } from '../jobs/startup.js';

export type LifecycleState = 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped';

export const STARTUP_STORE_BUSY_TIMEOUT_MS = 750;

export class StartupStoreHandoffError extends Error {
  readonly target: ValidatedHandoffTarget;

  constructor(target: ValidatedHandoffTarget) {
    super('Coordinator startup is continuing in the selected active-store build.');
    this.name = 'StartupStoreHandoffError';
    this.target = target;
  }
}

export type CoordinatorServerInfo = {
  port: number;
  host: string;
  socketPath: string;
  token: string;
  bootToken: string;
  shutdownToken: string;
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  instanceId: string;
  startedAt: number;
};

export interface CoordinatorIdentity {
  readonly pluginRoot: string;
  readonly namespace: string;
  readonly version: string;
  readonly buildSetId: string;
  readonly bundleHash: string;
  readonly cliBundleHash: string;
  readonly claudeAppserverBundleHash: string;
  readonly durableWrapperBundleHash: string;
  readonly flavor: 'prod' | 'dev';
  readonly instanceId: string;
  readonly token: string;
  readonly bootToken: string;
  readonly shutdownToken: string;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

export interface ReadonlyRuntimeState {
  getLifecycle(): LifecycleState;
  getStartedAt(): number;
  getLaunchFenceActive(): boolean;
  readonly components: RuntimeComponentRegistry;
}

export interface MutableRuntimeState extends ReadonlyRuntimeState {
  setLifecycle(state: LifecycleState): void;
  setStartedAt(ts: number): void;
  setLaunchFenceActive(active: boolean): void;
}

export function createRuntimeState(startedAt: number, components: RuntimeComponentRegistry): MutableRuntimeState {
  let lifecycle: LifecycleState = 'starting';
  let currentStartedAt = startedAt;
  let launchFenceActive = false;
  // Startup is strictly ordered; shutdown may enter `draining` from an
  // earlier phase when a handoff or hard stop arrives during startup.
  const allowedTransitions: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
    starting: ['kernel-ready', 'draining', 'stopped'],
    'kernel-ready': ['running', 'draining', 'stopped'],
    running: ['draining', 'stopped'],
    draining: ['stopped'],
    stopped: [],
  };

  return {
    getLifecycle: () => lifecycle,
    getStartedAt: () => currentStartedAt,
    getLaunchFenceActive: () => launchFenceActive,
    components,
    setLifecycle: (state) => {
      if (state === lifecycle) {
        return;
      }
      if (!allowedTransitions[lifecycle].includes(state)) {
        throw new Error(`Invalid lifecycle transition: ${lifecycle} -> ${state}`);
      }
      lifecycle = state;
    },
    setStartedAt: (ts) => {
      currentStartedAt = ts;
    },
    setLaunchFenceActive: (active) => {
      launchFenceActive = active;
    },
  };
}

/**
 * Factory for the KB health component registered with the runtime-state
 * registry. Production supplies a KB daemon health component; lifecycle.ts only
 * registers it and triggers `initAll` after Era II completes.
 */
export type CreateKbHealthComponentFn = () => RuntimeComponent;

export interface LifecycleHooks {
  onShutdown(mode: ShutdownMode, signal: AbortSignal): Promise<void>;
  onIdleCheck(): boolean;
  onRecoveryComplete(resumes: RecoveredDiscussResume[]): Promise<void>;
}

/**
 * Which discovery record counts as the incumbent this contender is contending with.
 *
 * **An incarnation is deliberately not required here.** A coordinator from a build that predates the
 * token writes no such field, and refusing its record would discard the `bootToken` beside it — leaving the
 * contender with no way to ask anyone to stand down, which is the exact deadlock the token exists to end,
 * reinstated for the one upgrade that introduces it. Whether the incumbent's identity is *sufficient to
 * signal* is a separate question, answered separately, in `verifySignalTarget`.
 */
export function verifiedIncumbentFromDiscovery(
  info: CoordinatorDiscoveryRecord | null,
  evidence: Readonly<{ socketPath: string; desired: DesiredIncumbentIdentity; lastHealth: IncumbentHealth | null }>,
): IncumbentIdentity | null {
  const { socketPath, desired, lastHealth } = evidence;
  if (!info) {
    return null;
  }
  if (info.socketPath !== socketPath || info.flavor !== desired.flavor || info.namespace !== desired.namespace) {
    return null;
  }
  if (
    lastHealth &&
    (lastHealth.flavor !== info.flavor ||
      lastHealth.namespace !== info.namespace ||
      (lastHealth.version !== undefined && lastHealth.version !== info.version) ||
      lastHealth.bundleHash !== info.bundleHash ||
      (lastHealth.pid !== undefined && lastHealth.pid !== info.pid) ||
      // A contradiction needs two statements. The record omitting an incarnation is not one: the write probes
      // once and serializes nothing if that probe fails, so a perfectly ordinary current build can publish a
      // record without it. Reading that as disagreement discards the incumbent entirely.
      (lastHealth.incarnation !== undefined &&
        info.incarnation !== undefined &&
        lastHealth.incarnation !== info.incarnation))
  ) {
    return null;
  }
  return {
    pid: info.pid,
    // Health may only supply what the record omits when health also *named the same pid*. Without that the
    // fallback is a way to borrow identity: a stale record naming a recycled pid, plus any live peer on that
    // socket answering with its own incarnation and no pid, yields `{ victimPid, peerIncarnation }` — and the
    // pid is what everything downstream signals. Ping is unauthenticated, so the peer is not required to be
    // the incumbent; the pid agreement is the only thing tying the two statements to one process.
    //
    // Fail closed when health omits its pid, rather than fall back to the record's silence: an incumbent that
    // cannot prove which process it is stays replaceable over IPC and un-signallable, which is the safe half.
    incarnation: info.incarnation ?? (lastHealth?.pid === info.pid ? lastHealth.incarnation : undefined),
    source: 'discovery',
    instanceId: info.instanceId,
    token: info.token,
    bootToken: info.bootToken,
    shutdownToken: info.shutdownToken,
  };
}

/**
 * The switch is exhaustive on purpose. A new `CoordinatorProbe` shape leaves `record` unassigned and fails
 * the typecheck.
 */
export function verifiedIncumbentFromProbe(
  probe: CoordinatorProbe,
  evidence: Readonly<{ socketPath: string; desired: DesiredIncumbentIdentity; lastHealth: IncumbentHealth | null }>,
): IncumbentIdentity | null {
  let record: CoordinatorDiscoveryRecord | null;
  switch (probe.kind) {
    case 'live':
      record = probe.record;
      break;
    case 'unobservable':
      record = probe.reason === 'unreadable-record' ? null : probe.record;
      break;
    case 'absent':
      record = null;
      break;
  }
  return verifiedIncumbentFromDiscovery(record, evidence);
}

export function verifiedIncumbentFromRuntimeProbe(
  runtime: DiscoveryRuntime,
  evidence: Readonly<{ socketPath: string; desired: DesiredIncumbentIdentity; lastHealth: IncumbentHealth | null }>,
): IncumbentIdentity | null {
  return verifiedIncumbentFromProbe(probeCoordinator(runtime), evidence);
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}

export function waitForInflightDrain(
  idleTimer: IdleTimer,
  timeoutMs: number,
  time: Pick<Runtime['time'], 'clearInterval' | 'now' | 'setInterval'>,
): Promise<void> {
  const deadline = time.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      if (idleTimer.inflightRequests === 0 || time.now() >= deadline) {
        time.clearInterval(interval);
        resolve();
      }
    };

    const interval = time.setInterval(check, SHUTDOWN_POLL_MS);
    interval.unref?.();
    check();
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_JOB_RETENTION_DAYS = 14;

export function resolveJobRetentionMs(raw: string | undefined): number {
  return parsePositiveInt(raw, DEFAULT_JOB_RETENTION_DAYS) * DAY_MS;
}

function isAgedOut(updatedAt: string, nowMs: number, retentionMs: number): boolean {
  const terminalMs = Date.parse(updatedAt);
  return Number.isFinite(terminalMs) && nowMs - terminalMs > retentionMs;
}

const STALE_ARTIFACT_PRUNE_OBLIGATION = 'lifecycle.stale-artifact-prune' as RecoveryObligationId;
const CRASH_TERMINALIZATION_OBLIGATION = 'lifecycle.crash-terminalization' as RecoveryObligationId;

type StaleJobCleanupItem = {
  readonly jobId: string;
  readonly phase: JobStatus['phase'];
  readonly bundleHash: string | undefined;
  readonly updatedAt: string;
};

type CrashedJobTerminalizationItem = {
  readonly status: JobStatus;
  readonly launchCreatedAt: string | null;
};

function recoveryFact(
  obligation: RecoveryObligationId,
  outcome: RecoverySettlementFact['outcome'],
  authorityRef?: string,
): RecoverySettlementFact {
  return { obligation, outcome, ...(authorityRef === undefined ? {} : { authorityRef }) };
}

function bestEffortLifecycleLog(log: (message: string) => void, message: string): void {
  try {
    log(message);
  } catch {
    // Recovery reporting cannot change an authoritative item disposition.
  }
}

function bestEffortLifecycleWarning(message: string): void {
  try {
    backendLog.warn(message);
  } catch {
    // Recovery reporting cannot change an authoritative item disposition.
  }
}

function latestStatusEvents(events: readonly EventsRow[], jobId: string): ReadonlyMap<string, EventsRow> {
  const latest = new Map<string, EventsRow>();
  for (const event of events) {
    rowToCoralEvent(event, null);
    if (event.stream_kind !== 'job' || event.stream_id !== jobId) {
      throw new TypeError(`Stale job cleanup event '${event.seq}' names another stream.`);
    }
    const previous = latest.get(event.type);
    if (previous === undefined || event.seq > previous.seq) latest.set(event.type, event);
  }
  return latest;
}

function hydrateStaleJobCleanup(raw: RawStaleJobCleanupRow): StaleJobCleanupItem {
  const projection = decodeProjectionJobStoredRow(raw.projection);
  const events = latestStatusEvents(raw.statusEvents, projection.job_id);
  const updatedAt =
    events.get('job.terminal.recorded')?.ts ??
    events.get('job.runtime.started')?.ts ??
    events.get('job.launch.rejected')?.ts ??
    events.get('job.launch.requested')?.ts ??
    projection.created_at;
  return {
    jobId: projection.job_id,
    phase: projection.phase,
    bundleHash: projection.bundle_hash ?? undefined,
    updatedAt,
  };
}

function hydrateCrashedJob(raw: RawCrashedJobRow, progressStore: JobStore): CrashedJobTerminalizationItem {
  const projection = decodeProjectionJobStoredRow(raw.projection);
  const owner = decodeProjectionJobExecutionOwner(projection);
  let launchCreatedAt: string | null = null;
  if (raw.launchEvent !== null) {
    const launch = jobLaunchRequestBodySchema.parse(decodeStoredBody(raw.launchEvent, progressStore));
    rowToCoralEvent(raw.launchEvent, launch);
    if (raw.launchEvent.stream_kind !== 'job' || raw.launchEvent.stream_id !== projection.job_id) {
      throw new TypeError(`Crash terminalization launch '${raw.launchEvent.seq}' names another job.`);
    }
    const launchWorkDir = launch.jobKind === 'kb' ? null : launch.request.cwd;
    if (
      launch.jobKind !== projection.job_kind ||
      launch.backendNamespace !== projection.backend_namespace ||
      launch.projectRoot !== projection.project_root ||
      launchWorkDir !== projection.work_dir ||
      JSON.stringify(launch.owner) !== JSON.stringify(owner)
    ) {
      throw new TypeError(`Crash terminalization launch for '${projection.job_id}' contradicts its projection.`);
    }
    if (launch.jobKind === 'provider' && launch.sessionId !== projection.session_id) {
      throw new TypeError(`Crash terminalization launch for '${projection.job_id}' names another session.`);
    }
    launchCreatedAt = launch.createdAt;
  }
  return {
    status: {
      jobId: projection.job_id,
      owner,
      sessionId: projection.session_id,
      provider: projection.provider,
      projectRoot: projection.project_root,
      workDir: projection.work_dir,
      backendNamespace: projection.backend_namespace,
      ...(projection.bundle_hash === null ? {} : { bundleHash: projection.bundle_hash }),
      jobKind: projection.job_kind,
      phase: projection.phase,
      updatedAt: raw.launchEvent?.ts ?? projection.created_at,
      lastSeq: projection.last_seq,
    },
    launchCreatedAt,
  };
}

type StaleJobCleanupPolicyContext = {
  readonly progressStore: JobStore;
  readonly currentBundleHash: string;
  readonly log: (message: string) => void;
  readonly storage: Pick<Runtime['storage'], 'rmSync'>;
  readonly nowMs: number;
  readonly retentionMs: number;
};

type CrashedJobTerminalizationPolicyContext = {
  readonly progressStore: JobStore;
  readonly message: string;
  readonly endTimeMs: number;
  readonly coordinatorCommit: CommitEventsFn;
};

const staleJobCleanupRetryContexts = new WeakMap<Database, StaleJobCleanupPolicyContext>();
const crashedJobTerminalizationRetryContexts = new WeakMap<Database, CrashedJobTerminalizationPolicyContext>();

function createStaleJobCleanupPolicy(
  context: StaleJobCleanupPolicyContext,
): RecoveryRetryPolicy<RawStaleJobCleanupRow, StaleJobCleanupItem> {
  const { progressStore, currentBundleHash, log, storage, nowMs, retentionMs } = context;
  return {
    processLocalCleanup: { kind: 'not-required' },
    hydrate: hydrateStaleJobCleanup,
    requiredObligations: () => [STALE_ARTIFACT_PRUNE_OBLIGATION],
    settle: (item) => {
      const fromOldBundle = item.bundleHash !== undefined && item.bundleHash !== currentBundleHash;
      const agedOut = isAgedOut(item.updatedAt, nowMs, retentionMs);
      if (!isTerminalPhase(item.phase) || (!fromOldBundle && !agedOut)) {
        return {
          kind: 'advanced',
          outcome: 'settled',
          facts: [recoveryFact(STALE_ARTIFACT_PRUNE_OBLIGATION, 'not-applicable')],
          detail: 'job artifact is not eligible for cleanup',
        };
      }

      const artifactPath = progressStore.jobDir(item.jobId);
      storage.rmSync(artifactPath, { recursive: true, force: true });
      progressStore.purgeFromCache(item.jobId);
      // The carrier identity captured at launch describes a process, so nothing about the job ending makes it
      // stale — this prune is the only thing that ever removes it. Deleting it here rather than on the
      // terminal event is deliberate: the identity outlives the job for exactly as long as the artifact does,
      // and the two are reclaimed together. Idempotent, and a job that never captured one is a no-op.
      deleteDurableCliProcessRuntimeMeta(progressStore.getDb(), item.jobId);
      bestEffortLifecycleLog(log, `Cleaned up ${fromOldBundle ? 'stale' : 'aged'} job artifact: ${item.jobId}\n`);
      return {
        kind: 'advanced',
        outcome: 'settled',
        facts: [recoveryFact(STALE_ARTIFACT_PRUNE_OBLIGATION, 'done', artifactPath)],
        detail: 'job artifact pruned',
      };
    },
    onFault: (fault) => {
      if (fault.stage === 'scan') return { kind: 'fatal', error: fault.error };
      const subject =
        fault.stage === 'settle' ? `at ${progressStore.jobDir(fault.item.jobId)}` : `for ${fault.subject.key}`;
      bestEffortLifecycleWarning(`Failed to prune job artifact ${subject}: ${formatError(fault.error)}`);
      return { kind: 'quarantine', detail: 'stale job artifact cleanup failed' };
    },
  };
}

function createCrashedJobTerminalizationPolicy(
  context: CrashedJobTerminalizationPolicyContext,
): RecoveryRetryPolicy<RawCrashedJobRow, CrashedJobTerminalizationItem> {
  const { progressStore, message, endTimeMs, coordinatorCommit } = context;
  return {
    processLocalCleanup: { kind: 'not-required' },
    hydrate: (raw) => hydrateCrashedJob(raw, progressStore),
    requiredObligations: () => [CRASH_TERMINALIZATION_OBLIGATION],
    settle: (item) => {
      const { status } = item;
      if (item.launchCreatedAt === null) {
        throw new Error(`Cannot record recovery terminal for ${status.jobId} without its launch record.`);
      }

      const durationMs = elapsedDurationMs(item.launchCreatedAt, endTimeMs, `job ${status.jobId}`);
      coordinatorCommit((c) => {
        appendJobTerminalRecorded(c, {
          jobId: status.jobId,
          sessionId: status.sessionId,
          namespace: status.backendNamespace,
          project: status.projectRoot,
          terminal: {
            content: '',
            durationMs,
            outcome: {
              kind: 'job_fault',
              fault: { kind: 'wrapper_crashed', cause: { message } },
            },
          },
        });
        return undefined;
      });
      // No export is written here on purpose. The terminal committed above already carries the crash
      // fault, so `ensureResultMarkdownArtifact` renders it on the next read. Writing a placeholder
      // instead makes that read a no-op — the file exists, so it is never regenerated — and the
      // operator is handed a path to an empty file for a failure Coral can describe exactly.
      return {
        kind: 'advanced',
        outcome: 'settled',
        facts: [recoveryFact(CRASH_TERMINALIZATION_OBLIGATION, 'done', `job:${status.jobId}:terminal`)],
        detail: 'crashed job terminalized',
      };
    },
    onFault: (fault) => {
      if (fault.stage === 'scan') return { kind: 'fatal', error: fault.error };
      return { kind: 'quarantine', detail: 'crashed job terminalization failed' };
    },
  };
}

export function createStaleJobCleanupRetryPlan(
  db: Database,
  subject: RecoverySubject,
): RecoverySourceFactoryPlan<RawStaleJobCleanupRow, StaleJobCleanupItem> {
  let resolvedPolicy: RecoveryRetryPolicy<RawStaleJobCleanupRow, StaleJobCleanupItem> | undefined;
  const policy = (): RecoveryRetryPolicy<RawStaleJobCleanupRow, StaleJobCleanupItem> => {
    if (resolvedPolicy === undefined) {
      const context = staleJobCleanupRetryContexts.get(db);
      if (context === undefined) throw new Error('Stale job cleanup retry policy is not initialized.');
      resolvedPolicy = createStaleJobCleanupPolicy(context);
    }
    return resolvedPolicy;
  };
  return {
    source: staleJobCleanupSource(db, subject),
    policy: {
      processLocalCleanup: { kind: 'not-required' },
      hydrate: (raw) => policy().hydrate(raw),
      requiredObligations: (item) => policy().requiredObligations(item),
      settle: (item) => policy().settle(item),
      onFault: (fault) => policy().onFault(fault),
    },
  };
}

export function createCrashedJobTerminalizationRetryPlan(
  db: Database,
  subject: RecoverySubject,
): RecoverySourceFactoryPlan<RawCrashedJobRow, CrashedJobTerminalizationItem> {
  let resolvedPolicy: RecoveryRetryPolicy<RawCrashedJobRow, CrashedJobTerminalizationItem> | undefined;
  const policy = (): RecoveryRetryPolicy<RawCrashedJobRow, CrashedJobTerminalizationItem> => {
    if (resolvedPolicy === undefined) {
      const context = crashedJobTerminalizationRetryContexts.get(db);
      if (context === undefined) throw new Error('Crashed job terminalization retry policy is not initialized.');
      resolvedPolicy = createCrashedJobTerminalizationPolicy(context);
    }
    return resolvedPolicy;
  };
  return {
    source: crashedJobTerminalizationSource(db, subject),
    policy: {
      processLocalCleanup: { kind: 'not-required' },
      hydrate: (raw) => policy().hydrate(raw),
      requiredObligations: (item) => policy().requiredObligations(item),
      settle: (item) => policy().settle(item),
      onFault: (fault) => policy().onFault(fault),
    },
  };
}

export async function cleanupStaleJobs(
  progressStore: JobStore,
  currentBundleHash: string,
  log: (message: string) => void,
  storage: Pick<Runtime['storage'], 'rmSync'>,
  nowMs: number,
  retentionMs: number,
  signal: AbortSignal,
): Promise<void> {
  const context = { progressStore, currentBundleHash, log, storage, nowMs, retentionMs };
  staleJobCleanupRetryContexts.set(progressStore.getDb(), context);
  const policy: RecoveryPolicy<RawStaleJobCleanupRow, StaleJobCleanupItem> = {
    signal,
    quarantine: new RecoveryQuarantineStore(progressStore.getDb(), { now: () => nowMs }),
    ...createStaleJobCleanupPolicy(context),
  };
  await runStartupStaleArtifactPrune({
    source: staleJobCleanupSource(progressStore.getDb()),
    policy,
  });
}

export async function markJobsAsError(
  progressStore: JobStore,
  message: string,
  endTimeMs: number,
  signal: AbortSignal,
  coordinatorCommit: CommitEventsFn,
): Promise<void> {
  const context = { progressStore, message, endTimeMs, coordinatorCommit };
  crashedJobTerminalizationRetryContexts.set(progressStore.getDb(), context);
  const policy: RecoveryPolicy<RawCrashedJobRow, CrashedJobTerminalizationItem> = {
    signal,
    quarantine: new RecoveryQuarantineStore(progressStore.getDb(), { now: () => endTimeMs }),
    ...createCrashedJobTerminalizationPolicy(context),
  };
  await runShutdownCrashTerminalization({
    source: crashedJobTerminalizationSource(progressStore.getDb()),
    policy,
  });
}

function resolveClientHost(bindHost: string, advertiseHost?: string): string {
  let host = bindHost;
  if (advertiseHost !== undefined) {
    host = advertiseHost;
  } else if (bindHost === '0.0.0.0') {
    host = '127.0.0.1';
  } else if (bindHost === '::') {
    host = '::1';
  }
  return host.includes(':') ? `[${host}]` : host;
}

export async function listen(
  server: Server,
  bindHost: string,
  advertiseHost?: string,
): Promise<{ port: number; host: string }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, bindHost, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Backend server failed to bind to a TCP port'));
        return;
      }
      resolve({ port: address.port, host: resolveClientHost(bindHost, advertiseHost) });
    });
  });
}

export type RegisterBuiltInProvidersFn = (providerRegistry: ProviderRegistry) => void;

export type RecoverPersistedDiscussDeps = {
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  readonly createInvocationContext: (projectRoot: string) => InvocationContext;
  readonly signal: AbortSignal;
};

export type RecoverPersistedDiscussFn = (deps: RecoverPersistedDiscussDeps) => Promise<RecoveredDiscussResume[]>;

export type StartupRecoveryInputs = {
  readonly identity: CoordinatorIdentity;
  readonly runtime: Runtime;
  readonly progressStore: JobStore;
  readonly providerRegistry: ProviderRegistry;
  readonly getExecutionService: (ctx: InvocationContext) => ProjectRequestPort;
  readonly getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  readonly createInvocationContext: (projectRoot: string) => InvocationContext;
  readonly recoveryCoordinator: RecoveryCoordinator;
  readonly signal: AbortSignal;
  readonly recoverPersistedDiscussFn: RecoverPersistedDiscussFn;
  /**
   * Defaults to `'restart'`; a bound coordinator that replaced an incumbent
   * sets this to `'handoff'`.
   */
  readonly interruptedAppServerReason?: InterruptedAppServerReason;
};

export type RunStartupRecoveryFn = (inputs: StartupRecoveryInputs) => Promise<RecoveredDiscussResume[]>;

export type RunStartupRecoveryOrchestratorFn = (
  inputs: StartupRecoveryInputs,
  runJobsStartup: RunJobsStartupFn,
) => Promise<RecoveredDiscussResume[]>;

export type LifecycleDeps = {
  readonly identity: CoordinatorIdentity;
  readonly runtime: Runtime;
  readonly storeFormat: StoreFormatDescription;
  readonly backendPid: number;
  readonly runtimeState: MutableRuntimeState;
  readonly idleTimer: IdleTimer;
  readonly storeServicesRef: StoreServicesRef;
  readonly createStoreServicesFromDbFn: (storeDb: Database) => CoordinatorStoreServices;
  readonly streamResponses: Set<ServerResponse>;
  readonly discussStores: Map<string, DiscussSessionStore>;
  readonly eventBus: TypedEventBus;
  readonly launchCoordinator: LaunchCoordinator;
  readonly providerRegistry: ProviderRegistry;
  readonly systemProviderScope?: SystemProviderScope;
  readonly server: Server;
  readonly getExecutionService: (ctx: InvocationContext) => ProjectRequestPort;
  readonly getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  readonly listExecutionServices: () => ProjectRequestPort[];
  readonly connectProviderOperationRecovery?: (recoveryCoordinator: RecoveryCoordinator) => void;
  readonly reconcileProviderOperationsAtStartup?: (
    ownership: ProviderOperationStartupOwnership,
    signal: AbortSignal,
  ) => Promise<StartupReconciliationReport>;
  readonly startProviderOperationReconciler?: () => void;
  readonly stopProviderOperationReconciler?: () => ProviderOperationReconcilerStopDisposition;
  /**
   * Optional only for narrow lifecycle harnesses; production composition supplies the sole publishing facet
   * so carrier readers cannot advance the startup boundary themselves.
   */
  readonly startupRecoveryBarrierPublisher?: Readonly<{ publish(): void }>;
  readonly scheduleStoreEpochSweepFn?: (openStore: ResolvedStoreEpoch) => void;
  readonly stopStoreEpochSweepFn?: () => Promise<void>;
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  readonly writeBackendInfoFn: (info: BackendInfo) => boolean | void;
  readonly removeBackendInfoIfOwnerFn: (instanceId: string) => void | BackendInfoRemovalResult;
  readonly cleanupStaleJobsFn: (currentBundleHash: string, signal: AbortSignal) => void | Promise<void>;
  readonly markJobsAsErrorFn: (message: string, signal: AbortSignal) => void | Promise<void>;
  readonly settlePendingLaunchesFn: SettlePendingLaunchesFn;
  readonly terminateRegisteredChildrenFn: TerminateRegisteredChildrenFn;
  readonly providerHostManager: Pick<ProviderHostManager, 'drainForHandoff' | 'shutdown'>;
  /**
   * The live guardian/reaper/proxy sets, absent whenever the composition layer had no real acquisition path
   * to report on (see `CoordinatorWorld.providerProxyAuthority`'s own doc). `runShutdownSequence` treats
   * absence identically to an always-empty registry.
   */
  readonly providerProxyAuthority?: ProviderProxyAuthorityRegistry;
  readonly kbDaemonSupervisor?: KbDaemonSupervisor;
  readonly handoffQuiescePorts: () => readonly HandoffQuiescePort[];
  readonly handoffDrainBudgetMs?: number;
  readonly disposeLifecycleReactor?: () => void | Promise<void>;
  readonly createKbHealthComponentFn: CreateKbHealthComponentFn;
  readonly registerBuiltInProvidersFn: RegisterBuiltInProvidersFn;
  readonly recoverPersistedDiscussFn: RecoverPersistedDiscussFn;
  readonly hooks: LifecycleHooks;
  readonly closeServerFn: (server: Server) => Promise<void>;
  readonly listenFn: (server: Server) => Promise<{ port: number; host: string }>;
  readonly ipcServer?: IpcListener;
  readonly closeIpcServerFn?: (listener: IpcListener) => Promise<void>;
  readonly listenIpcFn?: (
    listener: IpcListener,
    additionalCompatibilitySocketPaths?: readonly string[],
    publishedCompatibilitySocketAddresses?: readonly PublishedIpcSocketAddress[],
  ) => Promise<ListenIpcServerResult>;
  readonly onStopped?: (exitCode: number) => void;
  readonly acceptProcessExitRemainder?: (remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance;
  readonly onFatalShutdownError?: (error: unknown) => void;
};

export type LifecycleController = {
  start(): Promise<CoordinatorServerInfo>;
  shutdown(reason: ShutdownReason, incident?: ShutdownIncident): Promise<LifecycleShutdownDisposition>;
  abandonShutdownObligation(request: ShutdownObligationAbandonRequest): ShutdownObligationAbandonResult;
  requestShutdownRetry(): void;
  waitForShutdown(): Promise<LifecycleShutdownDisposition>;
  getRecoveryRegistry(): RecoveryRegistry | null;
};

// The continuation's last attempt must be the ledger's terminal attempt, or the loop ends on a hold.
const SHUTDOWN_ATTEMPT_LIMIT = BOUNDARY_TRANSFER_ATTEMPT_LIMIT;

/** Lifecycle finalization is forbidden while coordinator authority remains retained. */
type LifecycleShutdownHoldReason = ShutdownHoldReason;

type LifecycleShutdownRecovery = Readonly<{
  kind: 'retry-shutdown';
  exit: ShutdownHoldExit;
  owner: Readonly<{ kind: 'lifecycle-finalization-continuation'; instanceId: string }>;
  automaticRetry: Readonly<{ status: 'scheduled'; attemptsStarted: number; attemptLimit: number }>;
  retainedOwnership: Readonly<{
    kind: 'coordinator-exclusive-authority';
    backendInfo: Readonly<{ kind: 'backend-info'; instanceId: string }>;
    ipcSocket: boolean;
    providerControlProxyInstanceIds: readonly string[];
    cleanupObligations: readonly string[];
  }>;
  retry(): Promise<LifecycleShutdownDisposition>;
}>;

export type LifecycleShutdownDisposition =
  | Readonly<{ disposition: 'finalized' }>
  | Readonly<{ disposition: 'finalized-with-losses'; undischarged: readonly ShutdownUndischarged[] }>
  | Readonly<{
      disposition: 'held';
      reason: LifecycleShutdownHoldReason;
      recovery: LifecycleShutdownRecovery;
    }>;

export type LifecycleShutdownTerminalDisposition = Extract<
  LifecycleShutdownDisposition,
  { disposition: 'finalized' | 'finalized-with-losses' }
>;

export function isLifecycleShutdownTerminal(
  disposition: LifecycleShutdownDisposition,
): disposition is LifecycleShutdownTerminalDisposition {
  return disposition.disposition === 'finalized' || disposition.disposition === 'finalized-with-losses';
}

type LifecycleControlState = LifecycleWiringState & {
  shutdownPromise: Promise<LifecycleShutdownDisposition> | null;
  shutdownContinuations: Set<Promise<void>>;
  shutdownContinuationAbort: AbortController | null;
  shutdownAttemptsStarted: number;
  shutdownRetryAfter: Promise<void> | null;
  shutdownRetry: Readonly<{ reason: ShutdownReason; retry: () => Promise<ShutdownSequenceDisposition> }> | null;
  lastShutdownDisposition: LifecycleShutdownDisposition | null;
  started: boolean;
  recoveryCoordinator: RecoveryCoordinator | null;
  providerOperationMutationAdmission: ProviderOperationMutationAdmission | null;
  startupAbort: AbortController | null;
};

type LifecycleStartupContext = {
  deps: LifecycleDeps;
  runStartupRecovery: RunStartupRecoveryOrchestratorFn;
  state: LifecycleControlState;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  ownershipChecker: ReturnType<typeof createReplacementBackendOwnershipChecker>;
  shutdown: (reason: ShutdownReason) => Promise<LifecycleShutdownDisposition>;
};

async function runLifecycleStartup({
  deps,
  runStartupRecovery,
  state,
  createInvocationContext,
  ownershipChecker,
  shutdown,
}: LifecycleStartupContext): Promise<CoordinatorServerInfo> {
  const {
    identity,
    runtime,
    backendPid,
    runtimeState,
    idleTimer,
    storeServicesRef,
    createStoreServicesFromDbFn,
    launchCoordinator,
    kbDaemonSupervisor,
    providerRegistry,
    server,
    getRecoveryService,
    connectProviderOperationRecovery,
    reconcileProviderOperationsAtStartup,
    startProviderOperationReconciler,
    startupRecoveryBarrierPublisher,
    getDiscussStoreForSource,
    knownDiscussSources,
    getDiscussContext,
    writeBackendInfoFn,
    removeBackendInfoIfOwnerFn,
    cleanupStaleJobsFn,
    createKbHealthComponentFn,
    registerBuiltInProvidersFn,
    recoverPersistedDiscussFn,
    hooks,
    closeServerFn,
    listenFn,
    ipcServer,
    closeIpcServerFn,
    listenIpcFn,
  } = deps;
  const {
    namespace,
    version,
    buildSetId,
    bundleHash,
    cliBundleHash,
    claudeAppserverBundleHash,
    durableWrapperBundleHash,
    flavor,
    instanceId,
    now,
  } = identity;

  if (state.started || runtimeState.getLifecycle() !== 'starting') {
    throw new Error('Backend server already started');
  }

  const startupAbort = new AbortController();
  state.startupAbort = startupAbort;
  const signal = startupAbort.signal;

  try {
    // ===== Era I (kernel) =====
    // Socket-as-lock: bind first, gracefully handing off any incumbent via
    // its own IPC. The lifecycle shutdown callback (composition wires
    // `ipcServer.onShutdownRequest`) is already installed before we reach
    // here, so a contender that arrives while we are still 'starting' triggers
    // immediate shutdown via that path.
    // The address this coordinator publishes is its own canonical one; the claim additionally holds the
    // legacy and published addresses, which are exclusion inputs rather than what this build serves.
    const socketPath = runtime.paths.coral.coordinator.socketPath;
    let bound: BoundCoordinator | null = null;
    if (ipcServer && listenIpcFn) {
      if (closeIpcServerFn === undefined) {
        throw new Error('IPC startup requires a close operation before binding');
      }
      const addressClaim = createCoordinatorSocketAddressClaim(runtime, 'coordinator startup');
      bound = await bindWithHandoff({
        socketPath: addressClaim.initialIncumbentSocketPath,
        desired: { version, bundleHash, flavor, namespace },
        bindAttempt: async () => {
          signal.throwIfAborted();
          const binding = await addressClaim.acquire(async (additionalSocketPaths, publishedSocketAddresses) => {
            const listenResult = await listenIpcFn(ipcServer, additionalSocketPaths, publishedSocketAddresses);
            return listenResult.kind === 'incumbent'
              ? listenResult
              : { kind: 'held' as const, release: () => closeIpcServerFn(ipcServer) };
          });
          return binding.kind === 'incumbent'
            ? { kind: 'addressed-incumbent' as const, socketPath: binding.socketPath }
            : { kind: 'bound' as const };
        },
        runStartupRecovery,
        runtime,
        readVerifiedIncumbentFromDiscovery: (evidence) =>
          verifiedIncumbentFromRuntimeProbe(
            { storage: runtime.storage, env: runtime.env, paths: runtime.paths },
            evidence,
          ),
        signalLedger: createFileHandoffSignalLedger({
          storage: runtime.storage,
          ids: runtime.ids,
          runDir: runtime.paths.coral.coordinator.runDir,
        }),
        signal,
        totalBudgetMs: HANDOFF_DRAIN_TIMEOUT_MS,
      });
    }
    signal.throwIfAborted();

    // Provider configuration is side-effect-free validation and must complete
    // before this process receives authority to quarantine/reset persisted
    // state. A bad system scope must never destroy a usable older store.
    registerBuiltInProvidersFn(providerRegistry);
    if (deps.systemProviderScope !== undefined) {
      const decodedScope = providerRegistry.decodeScope(deps.systemProviderScope);
      if (!decodedScope.ok) {
        throw documentedCoralSetupError('system_provider_scope_invalid', {
          scopeName: deps.systemProviderScope.name,
          reason: decodedScope.failure.reason,
        });
      }
    }

    const currentBuild = {
      version,
      buildSetId,
      bundleHash,
      cliBundleHash,
      claudeAppserverBundleHash,
      durableWrapperBundleHash,
      flavor,
      storeFormatFingerprint: deps.storeFormat.fingerprint,
    };
    const preinjectedStoreServices = storeServicesRef.tryGet();
    const shouldScheduleStoreEpochSweep = preinjectedStoreServices === null;
    let storeDb: Database;
    let openedStore: ResolvedStoreEpoch | null = null;
    if (preinjectedStoreServices !== null) {
      // Production starts with an empty service ref. Test composition may pre-inject an in-memory store, which
      // has no filesystem selection or reset state to coordinate and must not consume deterministic IDs.
      if (preinjectedStoreServices.storeDb.location() !== null) {
        throw new Error('Pre-injected lifecycle store must be non-filesystem-backed.');
      }
      storeDb = preinjectedStoreServices.storeDb;
    } else {
      const currentBundleDir = resolveRunningBundleDir(identity.pluginRoot);
      if (currentBundleDir === null) {
        throw documentedCoralSetupError({
          code: 'startup_bundle_unresolvable',
          pluginRoot: identity.pluginRoot,
        });
      }
      const routing = await routeOrOpenBackendStoreAtStartup({
        runtime,
        validateForeignTarget: validateForeignHandoffTarget,
        options: {
          storeFormat: deps.storeFormat,
          startupBusyTimeoutMs: STARTUP_STORE_BUSY_TIMEOUT_MS,
          currentSelection: {
            version: ACTIVE_STORE_SELECTION_VERSION,
            manifest: currentBuild,
            bundleDir: currentBundleDir,
            activeStoreFingerprint: currentBuild.storeFormatFingerprint,
          },
        },
      });
      if (routing.kind === 'handoff') {
        throw new StartupStoreHandoffError(routing.target);
      }
      if (routing.kind === 'reset-newer-invalid') {
        backendLog.warn(
          `Recovered the newer-incompatible active store after selected bundle ${routing.evidence.bundleDir} failed validation (${routing.evidence.failure}).`,
        );
      }
      storeDb = routing.db;
      openedStore = routing.store;
    }
    let storeServices: CoordinatorStoreServices;
    try {
      storeServices = createStoreServicesFromDbFn(storeDb);
    } catch (error) {
      storeDb.close();
      throw error;
    }
    // clear() then set() so a second startup (test re-init or simulation
    // pre-injection) cleanly replaces the bundle. The set() guard rejects
    // double-set without clear, which catches accidental silent replacement
    // bugs while permitting the legitimate explicit reset pattern.
    storeServicesRef.clear();
    storeServicesRef.set(storeServices);
    const mutationAdmission = acquireProviderOperationMutationAdmission(storeDb, instanceId);
    if (mutationAdmission.kind === 'holding') {
      throw new Error(
        `Provider operation mutation admission remains owned by '${mutationAdmission.predecessorOwner}'; ` +
          `successor '${mutationAdmission.successorOwner}' refused; exit=${mutationAdmission.exit}`,
        { cause: mutationAdmission },
      );
    }
    state.providerOperationMutationAdmission = mutationAdmission.admission;
    const progressStore = storeServices.progressStore;
    const recoveryCoordinator = createRecoveryCoordinator(
      {
        progressStore,
        runtime,
        runtimeState,
        eventBus: deps.eventBus,
        getRecoveryService,
        createInvocationContext,
        log: identity.log,
        startupOwnership: launchCoordinator,
      },
      bound,
    );
    state.recoveryCoordinator = recoveryCoordinator;
    connectProviderOperationRecovery?.(recoveryCoordinator);
    recoveryCoordinator.retireAbsentSupersededProviderOperations();
    signal.throwIfAborted();

    // Bind the HTTP listener and signal kernel-ready BEFORE Era II's
    // recovery work. KB daemon startup cannot gate daemon liveness. The CLI's
    // `waitForBackendReady` resolves on
    // `kernel.phase ∈ { 'kernel-ready', 'running' }` so once we reach this
    // point the CLI returns within `KERNEL_READY_DEADLINE_MS`.
    const { port, host } = await listenFn(server);
    signal.throwIfAborted();
    runtimeState.setStartedAt(now());
    const startedAt = runtimeState.getStartedAt();
    const discoveryPublished = writeBackendInfoFn({
      pid: backendPid,
      port,
      host,
      socketPath,
      token: identity.token,
      bootToken: identity.bootToken,
      shutdownToken: identity.shutdownToken,
      version,
      bundleHash,
      flavor,
      namespace,
      instanceId,
      startedAt,
      ...(openedStore === null ? {} : { storeEpoch: openedStore.epoch }),
    });
    if (discoveryPublished === false) {
      throw new Error('Coordinator discovery publication failed.');
    }
    runtimeState.setLifecycle('kernel-ready');
    runtimeState.setLaunchFenceActive(true);
    if (shouldScheduleStoreEpochSweep && openedStore !== null) deps.scheduleStoreEpochSweepFn?.(openedStore);
    const serverInfo = {
      port,
      host,
      socketPath,
      token: identity.token,
      bootToken: identity.bootToken,
      shutdownToken: identity.shutdownToken,
      version,
      bundleHash,
      flavor,
      namespace,
      instanceId,
      startedAt,
    };

    // ===== Era II (recovery) =====
    // This order is load-bearing: a pending publication contains remote facts that the generic job walk
    // cannot see, so allowing that walk to classify the job first could authorize a contradictory execution.
    const providerOperationStartupSnapshot = recoveryCoordinator.snapshotProviderOperationStartupOwnership();
    const providerOperationStartupOwnership = recoveryCoordinator.hydrateProviderOperationStartupOwnership(
      providerOperationStartupSnapshot,
    );
    signal.throwIfAborted();
    await reconcileProviderOperationsAtStartup?.(providerOperationStartupOwnership, signal);
    signal.throwIfAborted();
    // Per-job isolation: corrupt sessions should not abort recovery.
    // `bound.runStartupRecovery` registers journal cursors then awaits
    // `waitFreshUntil` against `currentMaxSeq`; that wait runs here in Era II
    // because its budget is bounded by the daemon-side
    // `bootFreshnessTimeoutMs` (default 90s), not by either CLI-facing
    // deadline — the CLI has already returned by now.
    // A startup without an IPC listener never bound the coordinator socket, so it holds no bind
    // authority and there is no incumbent's work to recover — it was never the canonical coordinator.
    // This is the absence of a recovery obligation, not a skipped one.
    const recoveredDiscussResumes =
      bound === null
        ? []
        : await bound.runStartupRecovery({
            identity,
            runtime,
            progressStore,
            providerRegistry,
            getExecutionService: deps.getExecutionService,
            getRecoveryService,
            knownDiscussSources,
            getDiscussStoreForSource,
            getDiscussContext,
            createInvocationContext,
            recoveryCoordinator,
            signal,
            recoverPersistedDiscussFn,
            interruptedAppServerReason: bound.acquiredViaHandoff ? 'handoff' : 'restart',
          });
    startupRecoveryBarrierPublisher?.publish();
    startProviderOperationReconciler?.();
    await Promise.resolve(cleanupStaleJobsFn(bundleHash, signal));
    signal.throwIfAborted();
    if (runtimeState.getLaunchFenceActive()) {
      runtimeState.setLaunchFenceActive(false);
    }

    runtimeState.components.register(createRecoveryComponent(storeServices.storeDb));
    try {
      const kbHealthComponent = createKbHealthComponentFn();
      runtimeState.components.register(kbHealthComponent);
    } catch (error: unknown) {
      backendLog.error('Runtime component registration failed — KB will be offline until restart', error);
    }

    runtimeState.setLifecycle('running');
    state.started = true;
    void kbDaemonSupervisor
      ?.start(openedStore ?? undefined)
      .then((health) => {
        if (health.phase !== 'online') {
          return;
        }
        void kbDaemonSupervisor.warmup().catch((error: unknown) => {
          backendLog.warn(`KB daemon supervisor warmup failed: ${formatError(error)}`);
        });
      })
      .catch((error: unknown) => {
        backendLog.warn(`KB daemon supervisor start failed: ${formatError(error)}`);
      });

    idleTimer.startWatching(
      () => {
        const daemonCurateRunning = kbDaemonSupervisor?.read().kbWrite?.curateRunning === true;
        return (
          runtimeState.getLifecycle() === 'running' &&
          launchCoordinator.active === 0 &&
          !recoveryCoordinator.isIdleBlocked() &&
          progressStore.liveJobCount() === 0 &&
          idleTimer.inflightRequests === 0 &&
          !hooks.onIdleCheck() &&
          !daemonCurateRunning
        );
      },
      (reason) => {
        void shutdown(reason).catch(() => {});
      },
    );

    state.ownershipCheckerTeardown = ownershipChecker.install();
    await hooks.onRecoveryComplete(recoveredDiscussResumes);

    // ===== Era III (components — fire-and-forget) =====
    // The KB daemon health component is a daemon-health mirror; init is intentionally a no-op
    // and the daemon supervisor owns actual KB process startup. The registry
    // surfaces child phase via `runtimeState.components.status('kb')`.
    try {
      runtimeState.components.initAll(signal);
    } catch (error: unknown) {
      backendLog.error('Runtime component initialization dispatch failed — KB will be offline until restart', error);
    }

    return serverInfo;
  } catch (error: unknown) {
    const mutationAdmissionDisposition = state.providerOperationMutationAdmission?.close();
    if (
      (error as { name?: string } | null)?.name === 'AbortError' &&
      (state.shutdownPromise !== null || state.shutdownRetry !== null)
    ) {
      // Startup failure must not release authority owned by a shutdown attempt or its retained continuation.
      throw error;
    }
    if (mutationAdmissionDisposition?.kind === 'holding') {
      await mutationAdmissionDisposition.retryAfter;
    }
    if (error instanceof IncumbentMatchesError) {
      // Translate to the existing bootstrap-recognized "redundant contender"
      // signal (info log + exit 0). The socket has not been bound by us, so
      // there is nothing to clean up.
      runtimeState.setLifecycle('stopped');
      throw new BackendAlreadyRunningError();
    }
    runtimeState.setLifecycle('stopped');
    idleTimer.stopWatching();
    state.ownershipCheckerTeardown?.();
    state.ownershipCheckerTeardown = null;
    try {
      let disposal = await kbDaemonSupervisor?.dispose('coordinator startup failed');
      while (disposal?.kind === 'holding') {
        await disposal.retryAfter;
        disposal = await disposal.retry();
      }
    } catch {
      // best effort
    }
    try {
      await closeServerFn(server);
    } catch {
      // best effort
    }
    if (ipcServer && closeIpcServerFn) {
      try {
        await closeIpcServerFn(ipcServer);
      } catch {
        // best effort
      }
    }
    void removeBackendInfoIfOwnerFn(instanceId);

    if (error instanceof HandoffEscalationError) {
      backendLog.error('Handoff escalation failed', error);
    }
    throw error;
  } finally {
    state.startupAbort = null;
  }
}

export function createLifecycle(
  deps: LifecycleDeps,
  runStartupRecovery: RunStartupRecoveryOrchestratorFn,
): LifecycleController {
  const {
    identity,
    runtime,
    runtimeState,
    idleTimer,
    storeServicesRef,
    streamResponses,
    discussStores,
    server,
    removeBackendInfoIfOwnerFn,
    markJobsAsErrorFn,
    settlePendingLaunchesFn,
    terminateRegisteredChildrenFn,
    providerHostManager,
    providerProxyAuthority,
    stopProviderOperationReconciler,
    kbDaemonSupervisor,
    disposeLifecycleReactor = () => {},
    hooks,
    closeServerFn,
    closeIpcServerFn,
    ipcServer,
    onStopped,
    acceptProcessExitRemainder,
    onFatalShutdownError,
  } = deps;

  const { pluginRoot, instanceId, log } = identity;

  const state: LifecycleControlState = {
    shutdownPromise: null,
    shutdownContinuations: new Set(),
    shutdownContinuationAbort: null,
    shutdownAttemptsStarted: 0,
    shutdownRetryAfter: null,
    shutdownRetry: null,
    lastShutdownDisposition: null,
    started: false,
    ownershipCheckerTeardown: null,
    recoveryCoordinator: null,
    providerOperationMutationAdmission: null,
    startupAbort: null,
  };
  const ownershipChecker = createReplacementBackendOwnershipChecker({
    readBackendInfo,
    runtime,
    runtimeState,
    idleTimer,
    pluginRoot,
    instanceId,
  });
  function createInvocationContext(rawProjectRoot: string): InvocationContext {
    const projectRoot = canonicalizeWorkDir(rawProjectRoot, process.cwd());
    const principal: Principal = {
      subject: 'system',
      transport: 'internal',
      credential: { kind: 'internal', id: 'lifecycle' },
      binding: { kind: 'project', root: projectRoot },
    };
    return { projectRoot, pluginRoot, coralEnv: {}, principal };
  }

  async function shutdown(reason: ShutdownReason, incident?: ShutdownIncident): Promise<LifecycleShutdownDisposition> {
    if (state.shutdownPromise) return state.shutdownPromise;
    const ledgerReason = state.shutdownRetry?.reason ?? reason;
    state.shutdownAttemptsStarted += 1;
    state.lastShutdownDisposition = null;

    // Calling `abort()` with no reason sets `signal.reason` to the platform
    // default (a DOMException whose `.name === 'AbortError'`). Downstream
    // `signal.throwIfAborted()` checks throw that reason value, which
    // downstream catches detect via `error?.name === 'AbortError'`. A string
    // reason would propagate as a bare string and lose the `name`
    // discriminator.
    state.startupAbort?.abort();

    const finalizeStoppedLifecycle = (
      terminal: LifecycleShutdownTerminalDisposition,
      onFinalized: ((exitCode: number) => void) | undefined = onStopped,
    ): LifecycleShutdownTerminalDisposition => {
      runtimeState.setLifecycle('stopped');
      const losses: ShutdownUndischarged[] = [...(terminal.disposition === 'finalized' ? [] : terminal.undischarged)];
      const publish = (): void => {
        let refusal: string | null;
        try {
          refusal = recordShutdownRemainder(
            { storage: runtime.storage, time: runtime.time, runDir: runtime.paths.coral.coordinator.runDir },
            {
              instanceId,
              reason: ledgerReason,
              mode: shutdownModeFromReason(ledgerReason),
              undischarged: losses,
            },
          )
            ? null
            : 'record publication returned false';
        } catch (error: unknown) {
          refusal = formatError(error);
        }
        if (refusal !== null) bestEffortLifecycleLog(log, `shutdown remainder write refused (${refusal})\n`);
      };
      const withdraw = (): string | null => {
        try {
          const withdrawal = removeBackendInfoIfOwnerFn(instanceId);
          return withdrawal !== undefined && withdrawal.kind === 'refused' ? withdrawal.detail : null;
        } catch (error: unknown) {
          return formatError(error);
        }
      };

      try {
        if (losses.length > 0) publish();
        const refusal = withdraw();
        if (refusal !== null) {
          bestEffortLifecycleLog(log, `backend discovery withdrawal refused (${refusal})\n`);
          losses.push({
            label: 'backend discovery withdrawal',
            remainder: { owner: 'process-exit' },
            settlement: { cause: 'rejected', detail: refusal },
          });
          publish();
        }
        return losses.length === 0
          ? { disposition: 'finalized' }
          : { disposition: 'finalized-with-losses', undischarged: losses };
      } finally {
        onFinalized?.(losses.length === 0 ? 0 : 1);
      }
    };
    const acceptShutdownDisposition = (disposition: ShutdownSequenceDisposition): LifecycleShutdownDisposition => {
      if (disposition.disposition === 'held') {
        state.shutdownRetryAfter = disposition.retryAfter;
        state.shutdownRetry = { reason: ledgerReason, retry: disposition.retry };
        const recovery: LifecycleShutdownRecovery = {
          kind: 'retry-shutdown',
          exit: disposition.exit,
          owner: {
            kind: 'lifecycle-finalization-continuation',
            instanceId,
          },
          automaticRetry: {
            status: 'scheduled',
            attemptsStarted: state.shutdownAttemptsStarted,
            attemptLimit: SHUTDOWN_ATTEMPT_LIMIT,
          },
          retainedOwnership: {
            kind: 'coordinator-exclusive-authority',
            backendInfo: { kind: 'backend-info', instanceId },
            ipcSocket: disposition.retainedAuthority.ipcSocket,
            providerControlProxyInstanceIds: disposition.retainedAuthority.providerControlProxyInstanceIds,
            cleanupObligations: disposition.retainedAuthority.cleanupObligations,
          },
          retry: () => shutdown(ledgerReason),
        };
        return { disposition: 'held', reason: disposition.reason, recovery };
      }
      state.shutdownRetryAfter = null;
      state.shutdownRetry = null;
      state.shutdownContinuationAbort?.abort();
      state.shutdownContinuationAbort = null;
      switch (disposition.disposition) {
        case 'settled':
          return finalizeStoppedLifecycle({ disposition: 'finalized' });
        case 'delegated':
          return finalizeStoppedLifecycle(
            { disposition: 'finalized-with-losses', undischarged: disposition.undischarged },
            disposition.acceptance.requestExit,
          );
        case 'unaccepted':
          return finalizeStoppedLifecycle({
            disposition: 'finalized-with-losses',
            undischarged: disposition.undischarged,
          });
      }
    };
    const attempt = (async (): Promise<LifecycleShutdownDisposition> => {
      if (runtimeState.getLifecycle() === 'stopped') {
        return { disposition: 'finalized' };
      }
      if (state.shutdownRetry !== null) return state.shutdownRetry.retry().then(acceptShutdownDisposition);
      const stopProviderOperationMutations = (): ProviderOperationReconcilerStopDisposition => {
        const lifecycleDisposition = state.providerOperationMutationAdmission?.close() ?? {
          kind: 'drained' as const,
        };
        const reconcilerDisposition = stopProviderOperationReconciler?.() ?? { kind: 'drained' as const };
        return lifecycleDisposition.kind === 'holding' ? lifecycleDisposition : reconcilerDisposition;
      };
      return acceptShutdownDisposition(
        await runShutdownSequence({
          reason: ledgerReason,
          ...(incident === undefined ? {} : { incident }),
          state,
          teardownRecoveryCoordinator: async () => {
            await state.recoveryCoordinator?.teardown();
          },
          runtimeState,
          idleTimer,
          closeServerFn,
          waitForInflightDrain,
          server,
          closeIpcServerFn,
          ipcServer,
          streamResponses,
          runtime,
          markJobsAsErrorFn,
          providerHostManager,
          providerProxyAuthority,
          stopProviderOperationReconciler: stopProviderOperationMutations,
          kbDaemonSupervisor,
          storeServicesRef,
          settlePendingLaunchesFn,
          terminateRegisteredChildrenFn,
          handoffQuiescePorts: deps.handoffQuiescePorts,
          handoffDrainBudgetMs: deps.handoffDrainBudgetMs,
          disposeLifecycleReactor,
          hooks,
          discussStores,
          stopStoreEpochSweepFn: deps.stopStoreEpochSweepFn,
          log,
          ...(acceptProcessExitRemainder === undefined ? {} : { acceptProcessExitRemainder }),
        }),
      );
    })().catch((error) => {
      onFatalShutdownError?.(error);
      throw error;
    });
    const trackedAttempt = attempt.then(
      (disposition) => {
        state.lastShutdownDisposition = disposition;
        if (!isLifecycleShutdownTerminal(disposition)) {
          state.shutdownPromise = null;
          if (state.shutdownContinuations.size === 0 && state.shutdownAttemptsStarted < SHUTDOWN_ATTEMPT_LIMIT) {
            const continuationAbort = new AbortController();
            state.shutdownContinuationAbort = continuationAbort;
            const cancelled = new Promise<void>((resolve) => {
              continuationAbort.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            const continuation = (async () => {
              while (state.shutdownAttemptsStarted < SHUTDOWN_ATTEMPT_LIMIT) {
                await Promise.race([state.shutdownRetryAfter ?? Promise.resolve(), cancelled]);
                if (continuationAbort.signal.aborted) return;
                const retried = await shutdown(ledgerReason);
                if (isLifecycleShutdownTerminal(retried)) return;
              }
            })()
              .catch((error: unknown) => {
                log(`lifecycle finalization continuation failed (${formatError(error)})\n`);
              })
              .finally(() => {
                state.shutdownContinuations.delete(continuation);
                if (state.shutdownContinuationAbort === continuationAbort) state.shutdownContinuationAbort = null;
              });
            state.shutdownContinuations.add(continuation);
          }
        }
        return disposition;
      },
      (error: unknown) => {
        if (runtimeState.getLifecycle() !== 'stopped') state.shutdownPromise = null;
        throw error;
      },
    );
    state.shutdownPromise = trackedAttempt;
    return trackedAttempt;
  }

  async function start(): Promise<CoordinatorServerInfo> {
    try {
      return await runLifecycleStartup({
        deps,
        runStartupRecovery,
        state,
        createInvocationContext,
        ownershipChecker,
        shutdown,
      });
    } catch (error: unknown) {
      if ((error as { name?: string } | null)?.name === 'AbortError' && state.shutdownPromise !== null) {
        await state.shutdownPromise;
        throw error;
      }
      throw error;
    }
  }

  function requestShutdownRetry(): void {
    const currentAttempt = state.shutdownPromise;
    if (currentAttempt === null) {
      if (state.shutdownRetry === null) return;
      void shutdown(state.shutdownRetry.reason).catch((error: unknown) => {
        log(`operator recovery shutdown retry failed (${formatError(error)})\n`);
      });
      return;
    }
    void currentAttempt
      .then((disposition) => {
        if (!isLifecycleShutdownTerminal(disposition) && state.shutdownRetry !== null) {
          return shutdown(state.shutdownRetry.reason);
        }
      })
      .catch((error: unknown) => {
        log(`operator recovery shutdown retry failed (${formatError(error)})\n`);
      });
  }

  function abandonShutdownObligation(request: ShutdownObligationAbandonRequest): ShutdownObligationAbandonResult {
    const disposition = state.lastShutdownDisposition;
    if (disposition === null || isLifecycleShutdownTerminal(disposition)) {
      return { kind: 'not-held', subject: request.subject };
    }
    return { kind: 'not-offered', subject: request.subject };
  }

  return {
    start,
    shutdown,
    abandonShutdownObligation,
    requestShutdownRetry,
    waitForShutdown: () => {
      if (state.shutdownPromise !== null) return state.shutdownPromise;
      if (state.lastShutdownDisposition !== null) return Promise.resolve(state.lastShutdownDisposition);
      return Promise.reject(new Error('Shutdown has not been requested'));
    },
    getRecoveryRegistry: () => state.recoveryCoordinator?.getRecoveryRegistry() ?? null,
  };
}
