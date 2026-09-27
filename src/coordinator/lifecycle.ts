import type { Server, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { backendLog } from '../infra/backend-log.js';
import { readBackendInfo, type BackendInfo, type BackendInfoRemovalResult } from '../infra/backend-discovery.js';
import { errorMessage, formatError, serializeThrown, type SerializedThrown } from '../infra/error-format.js';
import { sha256Hex } from '../infra/hash.js';
import { type LaunchCoordinator } from './live/admission.js';
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
import { type ProcessIncarnation } from '../infra/node-process.js';
import type { UpgradeIntent } from '../infra/upgrade-intent.js';
import {
  describeStartupReconciliationIncident,
  type ProviderOperationReconcilerStopDisposition,
  type StartupReconciliationReport,
} from './services/provider-operation-reconciler.js';
import type { RuntimeComponent } from './runtime-components/contract.js';
import type { RuntimeComponentRegistry } from './runtime-components/registry.js';
import { createRecoveryComponent } from './runtime-components/recovery-component.js';
import {
  SHUTDOWN_POLL_MS,
  runShutdownSequence,
  runSuccessionReleaseSequence,
  shutdownIncidentUndischarged,
  type SuccessionRelease,
  type LifecycleWiringState,
  type SettlePendingLaunchesFn,
  type ShutdownIncidentOccurrence,
  type ShutdownIncident,
  type TerminateRegisteredChildrenFn,
  HANDOFF_DRAIN_TIMEOUT_MS,
} from './shutdown.js';
import {
  shutdownModeFromReason,
  type ShutdownAutomaticRetry,
  type ShutdownHoldExit,
  type ShutdownHoldReason,
  type ShutdownMode,
  type ShutdownReason,
  type ShutdownRemainderObservation,
  type ShutdownRemainderProjection,
  type ShutdownUndischarged,
} from '../infra/shutdown-contract.js';
import type {
  ProcessExitRemainder,
  ProcessExitRemainderAcceptance,
  ShutdownSequenceDisposition,
} from './shutdown-settlement.js';
import type { HandoffQuiescePort } from './execution-service.js';
import type { InterruptedAppServerReason } from '../jobs/reconcile/interrupted-reason.js';
import {
  bindWithHandoff,
  BackendAlreadyRunningError,
  HandoffEscalationError,
  requestUpgradeFromContender,
  settleContenderUpgrade,
  type BoundCoordinator,
} from './handoff.js';
import { recordContenderDeferral, requestLegacyUpgrade } from '../coordinator-launch/request.js';
import {
  IncumbentMatchesError,
  type DesiredIncumbentIdentity,
  type IncumbentHealth,
  type IncumbentIdentity,
} from '../transport/ipc/handoff.js';
import {
  probeCoordinator,
  probeCoordinatorAtAddress,
  type CoordinatorDiscoveryRecord,
  type CoordinatorProbe,
  type DiscoveryRuntime,
} from '../infra/backend-discovery.js';
import type { RecoveryCapableService } from '../jobs/reconcile/contracts.js';
import type { ProjectRequestPort } from './contracts.js';
import type { TypedEventBus } from './event-bus.js';
import type { IpcListener, ListenIpcServerResult, PublishedIpcSocketAddress } from '../transport/ipc/server.js';
import { resolveRunningBundleDir, resolveStrictBundleIdentity } from '../infra/bundle-manifest.js';
import { inspectValidatedHandoffTarget, type ValidatedHandoffTarget } from '../infra/handoff-target.js';
import { type Database } from '../store/db.js';
import {
  decodeResolvedStoreEpoch,
  encodeResolvedStoreEpoch,
  inspectCurrentStore,
  discardUnservedRetirementMint,
  type ResolvedStoreEpoch,
  type StoreEpochOptions,
} from '../store/epoch.js';
import {
  protectStoreEpoch,
  resolveProtectedEpoch,
  restoreProtectedEpoch,
  StoreEpochOpenerHeldError,
} from '../store/epoch-protection.js';
import { asDatabase, openReadOnlyStoreDatabase } from '../store/read-port.js';
import { createRebindableStoreDatabase, type RebindableStoreDatabase } from '../store/rebindable-database.js';
import {
  acquireProviderOperationMutationAdmission,
  type ProviderOperationMutationAdmission,
} from '../store/provider-operation-journal.js';
import {
  openCommittedBackendStoreAtStartup,
  routeOrOpenBackendStoreAtStartup,
} from '../store/startup-store-routing.js';
import {
  ACTIVE_STORE_SELECTION_VERSION,
  classifyActiveStoreSelection,
  readActiveStoreSelection,
  type ActiveStoreSelection,
} from '../store/active-store-selection.js';
import { validateForeignHandoffTarget } from './handoff-routing/runner.js';
import type { CoordinatorStoreServices, StoreServicesRef } from './composition/store-services-ref.js';
import { RETIREMENT_PATIENCE_INTERVAL_MS } from './services/startup-retirement.js';
import { selectProtectedPredecessorFromControllers } from './services/recovery/epoch-closure.js';
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
import { currentSuccessionAttemptChild } from './succession/attempt-child.js';
import type { RetiringStoreProtection, SuccessionShutdownPort } from './succession/commit.js';
import { NO_SUCCESSION_INTERPOSITION, type SuccessionInterposition } from './succession/interposition.js';
import {
  completeSupervisorLegacyUpgrade,
  recordSupervisorLegacyChild,
  dischargeDeadSuccessionAttempt,
  handBackDeadAttemptGeneration,
  openPreferredStoreEpoch,
  prepareCommittedSuccessorRecovery,
  openCommittedRecoveryStore,
  closeServedIntentAtCleanExit,
  holdFailedCommittedRecovery,
  openSuccessionAttemptStore,
  prepareSuccessionAttemptStore,
  publishAttemptServing,
  publishCommittedRecoveryServing,
  resolveIncompleteSuccessionAtStartup,
  retryRecordedMintDiscard,
  heldUnservedMint,
  startupHoldError,
  SuccessionAttemptStartupHoldError,
  type CommittedSuccessorRecovery,
  type DeadAttemptRecovery,
  type SuccessionStartupHold,
} from './succession/startup.js';
import { type SuccessionWriterGeneration } from '../store/succession-writer-generation.js';
import { type SuccessionPreparation } from './succession/protocol.js';
import { type RetirementDisposition } from './succession/retirement-disposition.js';
import { JobLocationIndex } from '../jobs/location-index.js';
import {
  crashedJobTerminalizationSource,
  type RawCrashedJobRow,
} from '../jobs/crashed-job-terminalization-recovery-source.js';
import { staleJobCleanupSource, type RawStaleJobCleanupRow } from '../jobs/stale-job-cleanup-recovery-source.js';
import { runShutdownCrashTerminalization } from './shutdown-recovery.js';
import { recordShutdownRemainder } from './shutdown-remainder.js';
import { runStartupStaleArtifactPrune } from './startup-recovery.js';
import type { ProviderOperationStartupOwnership, RunJobsStartupFn } from '../jobs/startup.js';

export type LifecycleState = 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped';

export const STARTUP_STORE_BUSY_TIMEOUT_MS = 750;

/** EX_TEMPFAIL: this incumbent left for the next startup of its own build to serve its recovery grant. */
const SUCCESSION_RESTART_EXIT_CODE = 75;

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
  // Namespace is not compared with the contender's own: it hashes the plugin root, whose path carries the
  // version, so every upgrade meets an incumbent from another namespace. Refusing that record discards its
  // `bootToken`, and the upgrade then has no credential to ask the previous build to stand down.
  if (info.socketPath !== socketPath || info.flavor !== desired.flavor) {
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
  return verifiedIncumbentFromProbe(probeCoordinatorAtAddress(runtime, evidence.socketPath), evidence);
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

function lifecycleDiagnosticFields(diagnostic: SerializedThrown): string {
  return `errno=${diagnostic.code ?? 'unavailable'} errorName=${diagnostic.kind === 'error' ? diagnostic.name : 'unavailable'}`;
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
): Promise<{ port: number; host: string; bindHost: string }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, bindHost, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Backend server failed to bind to a TCP port'));
        return;
      }
      resolve({ port: address.port, host: resolveClientHost(bindHost, advertiseHost), bindHost: address.address });
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
  /** Jobs whose execution host an accepted receipt handed over; they continue in that host, never finalize. */
  readonly transferredJobIds?: ReadonlySet<string>;
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
  readonly onRecoverySettlement?: (jobId: string) => void;
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
  readonly reconcileCustodyAtStartup?: () => void;
  readonly startProviderOperationReconciler?: () => void;
  readonly stopProviderOperationReconciler?: () => ProviderOperationReconcilerStopDisposition;
  /**
   * Optional only for narrow lifecycle harnesses; production composition supplies the sole publishing facet
   * so carrier readers cannot advance the startup boundary themselves.
   */
  readonly startupRecoveryBarrierPublisher?: Readonly<{ publish(): void }>;
  readonly scheduleStoreEpochSweepFn?: (openStore: ResolvedStoreEpoch) => void;
  readonly onStoreOpened?: (openStore: ResolvedStoreEpoch) => void;
  readonly onStoreServing?: (
    attemptId: string,
    epochKey: string,
    instanceId: string,
    controlGeneration: number,
  ) => void;
  readonly authorizeStartupMint?: StoreEpochOptions['authorizeMint'];
  readonly prepareNoIncumbentHandoff?: () => Readonly<{ target: ValidatedHandoffTarget; epochKey: string }> | null;
  readonly prepareRecoveryGrantHandoff?: (
    epochKey: string,
    incumbentInstanceId: string,
  ) => ValidatedHandoffTarget | null;
  readonly onRetiredEpochOpened?: (epoch: ResolvedStoreEpoch, disposition: RetirementDisposition) => void;
  readonly stopStoreEpochSweepFn?: () => Promise<void>;
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  readonly writeBackendInfoFn: (info: BackendInfo) => boolean | void;
  readonly removeBackendInfoIfOwnerFn: (instanceId: string) => void | BackendInfoRemovalResult;
  readonly cleanupStaleJobsFn: (currentBundleHash: string, signal: AbortSignal) => void | Promise<void>;
  readonly readSelfIncarnationFn: () => ProcessIncarnation | null;
  /** This process's identity in the upgrade intent; the succession reconciler writes it from the same source. */
  readonly successionIncumbent: () => UpgradeIntent['incumbent'];
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
  readonly listenFn: (server: Server) => Promise<{ port: number; host: string; bindHost?: string }>;
  readonly ipcServer?: IpcListener;
  readonly closeIpcServerFn?: (listener: IpcListener) => Promise<void>;
  readonly listenIpcFn?: (
    listener: IpcListener,
    additionalCompatibilitySocketPaths?: readonly string[],
    publishedCompatibilitySocketAddresses?: readonly PublishedIpcSocketAddress[],
  ) => Promise<ListenIpcServerResult>;
  readonly onStopped?: (exitCode: number) => void;
  readonly onSuccessionServing?: (attemptId: string) => Promise<void>;
  /** A reconciler pass before this process serves can act on nothing, so reaching service owes it one. */
  readonly wakeSuccessionReconciler?: () => void;
  readonly verifySuccessionReceipts?: (
    preparation: SuccessionPreparation,
    epoch: ResolvedStoreEpoch,
    committedSuccessorInstanceId: string | null,
  ) => readonly string[];
  /** The jobs an accepted preparation hands over together with the execution host that runs them. */
  readonly transferredHostJobIds?: (preparation: SuccessionPreparation) => readonly string[];
  readonly adoptSuccessionReceipts?: (
    preparation: SuccessionPreparation,
    acceptedJobIds: readonly string[],
    generation: SuccessionWriterGeneration,
    recovery: boolean,
  ) => void;
  readonly recordSuccessionControllerReceipts?: (
    preparation: SuccessionPreparation,
    epochKey: string,
    generation: number,
    recordedAt: string,
  ) => void;
  readonly succession?: SuccessionShutdownPort;
  readonly successionInterposition?: SuccessionInterposition;
  readonly acceptProcessExitRemainder?: (remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance;
  readonly onFatalShutdownError: (error: unknown) => void;
};

export type LifecycleController = {
  start(): Promise<CoordinatorServerInfo>;
  shutdown(reason: ShutdownReason, incident?: ShutdownIncident): Promise<LifecycleShutdownDisposition>;
  observeShutdown(): ShutdownRemainderProjection | undefined;
  requestShutdownRetry(): void;
  waitForShutdown(): Promise<LifecycleShutdownDisposition>;
  getRecoveryRegistry(): RecoveryRegistry | null;
  parkProviderOperationMutations(signal?: AbortSignal): Promise<void>;
  adoptProviderOperationAdmission(admission: ProviderOperationMutationAdmission): void;
  protectRetiringStore(epochKey: string, openerDrainMs: number): RetiringStoreProtection;
  reopenRetiringStore(epochKey: string): void;
  /** Never returns: the process exits once the release sequence settles. */
  releaseAuthority(release: SuccessionRelease): Promise<never>;
};

/** Lifecycle finalization is forbidden while coordinator authority remains retained. */
type LifecycleShutdownHoldReason = ShutdownHoldReason;

type LifecycleShutdownRecovery = Readonly<{
  kind: 'retry-shutdown';
  exit: ShutdownHoldExit;
  owner: Readonly<{ kind: 'lifecycle-finalization-continuation'; instanceId: string }>;
  automaticRetry: ShutdownAutomaticRetry;
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
  shutdownHardConsequencesAbort: AbortController | null;
  shutdownReason: ShutdownReason | null;
  shutdownIncidents: ShutdownIncidentOccurrence[];
  shutdownIncidentCount: number;
  shutdownRetryAfter: Promise<void> | null;
  shutdownRetry: Readonly<{ retry: () => Promise<ShutdownSequenceDisposition> }> | null;
  shutdownObservationReader: (() => ShutdownRemainderObservation) | null;
  lastShutdownDisposition: LifecycleShutdownDisposition | null;
  started: boolean;
  recoveryCoordinator: RecoveryCoordinator | null;
  providerOperationMutationAdmission: ProviderOperationMutationAdmission | null;
  startupAbort: AbortController | null;
  rebindableStoreDb: RebindableStoreDatabase | null;
};

function projectLifecycleShutdownObservation(state: LifecycleControlState): ShutdownRemainderProjection | undefined {
  const reader = state.shutdownObservationReader;
  const reason = state.shutdownReason;
  if (reader === null || reason === null) return undefined;
  const observation = reader();
  const lastDisposition = state.lastShutdownDisposition;
  const automaticRetry =
    lastDisposition !== null && !isLifecycleShutdownTerminal(lastDisposition)
      ? lastDisposition.recovery.automaticRetry
      : undefined;
  const currentAutomaticRetry =
    automaticRetry?.status === 'scheduled' &&
    (automaticRetry.attemptsStarted !== observation.attempt.started ||
      automaticRetry.attemptLimit !== observation.attempt.limit ||
      observation.lastDeclined?.attempt !== observation.attempt.started)
      ? undefined
      : automaticRetry;
  const projection = {
    reason,
    mode: shutdownModeFromReason(reason),
    ...observation,
  };
  if (currentAutomaticRetry === undefined || observation.lastDeclined === undefined) return projection;
  return { ...projection, lastDeclined: observation.lastDeclined, automaticRetry: currentAutomaticRetry };
}

type LifecycleStartupContext = {
  deps: LifecycleDeps;
  runStartupRecovery: RunStartupRecoveryOrchestratorFn;
  state: LifecycleControlState;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  ownershipChecker: ReturnType<typeof createReplacementBackendOwnershipChecker>;
  shutdown: (reason: ShutdownReason) => Promise<LifecycleShutdownDisposition>;
};

/** What a startup no coordinator answers owes a committed successor or dead attempt; a hold ends it. */
type UnservedSuccession = Readonly<{
  hold: SuccessionStartupHold | null;
  committedRecovery: Extract<CommittedSuccessorRecovery, { kind: 'recover' }> | null;
  pendingDeadAttempt: DeadAttemptRecovery | null;
  preferredStoreEpochKey: string | null;
  retiredDeadAttemptId: string | null;
}>;

const NO_UNSERVED_SUCCESSION: UnservedSuccession = {
  hold: null,
  committedRecovery: null,
  pendingDeadAttempt: null,
  preferredStoreEpochKey: null,
  retiredDeadAttemptId: null,
};

/**
 * `setImmediate` runs after the current poll phase completes, so a health check already accepted on the
 * kernel-ready listener gets to send its response before Era II's synchronous work runs; a microtask
 * (`Promise.resolve()`, `queueMicrotask`) does not span that phase boundary and would not yield here.
 */
export async function yieldPastKernelReadyResponse(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The newer build the active selection names, once it validates. Reading the selection takes no lock. */
function selectedNewerBuild(runtime: Runtime, currentSelection: ActiveStoreSelection): ValidatedHandoffTarget | null {
  const read = readActiveStoreSelection(runtime);
  if (read.kind !== 'valid' || classifyActiveStoreSelection(read.selection, currentSelection) !== 'selected-newer') {
    return null;
  }
  const validation = validateForeignHandoffTarget(read.selection.bundleDir, read.selection.manifest);
  return validation.kind === 'validated' ? validation.target : null;
}

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
    reconcileCustodyAtStartup,
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
  const interposition = deps.successionInterposition ?? NO_SUCCESSION_INTERPOSITION;

  const startupAbort = new AbortController();
  state.startupAbort = startupAbort;
  const signal = startupAbort.signal;
  let port = 0;
  let host = '';
  let localBindHost: string | undefined;
  let startedAt = 0;
  let legacyServingCompleted = false;
  let legacyDiscoveryPublished = false;
  let legacyDiscoveryRetryScheduled = false;
  let publishLegacyDiscovery: (() => void) | null = null;
  const serverInfo = (): CoordinatorServerInfo => ({
    port,
    host,
    socketPath: runtime.paths.coral.coordinator.socketPath,
    token: identity.token,
    bootToken: identity.bootToken,
    shutdownToken: identity.shutdownToken,
    version,
    bundleHash,
    flavor,
    namespace,
    instanceId,
    startedAt,
  });

  try {
    // ===== Era I (kernel) =====
    // The address this coordinator publishes is its own canonical one; the claim additionally holds the
    // legacy and published addresses, which are exclusion inputs rather than what this build serves.
    const socketPath = runtime.paths.coral.coordinator.socketPath;
    const successionAttemptChild = currentSuccessionAttemptChild();
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
    const legacySupervisedChild =
      successionAttemptChild === null &&
      (await recordSupervisorLegacyChild(runtime, currentBuild, backendPid, deps.readSelfIncarnationFn()));
    if (legacySupervisedChild) runtimeState.setLaunchFenceActive(true);
    const successionStoreContext = {
      runtime,
      storeFormat: deps.storeFormat,
      currentBuild,
      busyTimeoutMs: STARTUP_STORE_BUSY_TIMEOUT_MS,
    };
    const currentBundleDir = resolveRunningBundleDir(identity.pluginRoot);
    const currentSelection =
      currentBundleDir === null
        ? null
        : {
            version: ACTIVE_STORE_SELECTION_VERSION,
            manifest: currentBuild,
            bundleDir: currentBundleDir,
            activeStoreFingerprint: currentBuild.storeFormatFingerprint,
          };
    if (successionAttemptChild !== null && (ipcServer === undefined || listenIpcFn === undefined)) {
      throw new Error('Succession attempt requires an IPC listener');
    }
    let preparedCommittedStore: Awaited<ReturnType<typeof prepareSuccessionAttemptStore>> | null = null;
    if (successionAttemptChild !== null) {
      preparedCommittedStore = await prepareSuccessionAttemptStore(
        runtime,
        identity,
        deps.storeFormat,
        currentBuild,
        successionAttemptChild,
      );
    }
    const preinjectedStoreServices = storeServicesRef.tryGet();
    // A dead attempt or committed successor is acted on only while no coordinator may answer: with one answering, the
    // bind decides this process, and acting first would hold every contender or fence the coordinator that serves.
    const coordinatorAtStartup =
      successionAttemptChild === null && preinjectedStoreServices === null ? probeCoordinator(runtime) : null;
    const noCoordinatorServes =
      coordinatorAtStartup !== null &&
      (coordinatorAtStartup.kind === 'absent' ||
        (coordinatorAtStartup.kind === 'unobservable' && coordinatorAtStartup.reason === 'recorded-process-absent'));
    /**
     * Resolves a committed successor or dead attempt for a startup no coordinator answers. A handoff is thrown at once;
     * a hold is returned, because only a startup that goes on to bind may act on it.
     */
    const resolveUnservedSuccession = async (): Promise<UnservedSuccession> => {
      const committed = await prepareCommittedSuccessorRecovery(
        runtime,
        identity,
        deps.storeFormat,
        currentBuild,
        (epochKey) =>
          new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot)
            .locationsFor(epochKey)
            .some((location) => location.disposition !== 'terminal'),
      );
      if (committed.kind === 'handoff') throw new StartupStoreHandoffError(committed.target);
      if (committed.kind === 'hold') return { ...NO_UNSERVED_SUCCESSION, hold: committed.hold };
      if (committed.kind === 'recover') return { ...NO_UNSERVED_SUCCESSION, committedRecovery: committed };
      const incomplete = await resolveIncompleteSuccessionAtStartup({
        runtime,
        currentBuild,
        startupId: instanceId,
        ...(deps.prepareRecoveryGrantHandoff === undefined
          ? {}
          : { prepareRecoveryGrantHandoff: deps.prepareRecoveryGrantHandoff }),
      });
      if (incomplete.kind === 'handoff') throw new StartupStoreHandoffError(incomplete.target);
      if (incomplete.kind === 'hold') return { ...NO_UNSERVED_SUCCESSION, hold: incomplete.hold };
      if (incomplete.kind === 'recover') {
        return {
          ...NO_UNSERVED_SUCCESSION,
          pendingDeadAttempt: incomplete.attempt,
          preferredStoreEpochKey: incomplete.preferredEpochKey,
        };
      }
      const retiredDeadAttemptId = incomplete.kind === 'retire' ? incomplete.attemptId : null;
      let preferredStoreEpochKey: string | null = null;
      const target = deps.prepareNoIncumbentHandoff?.();
      if (target !== undefined && target !== null) {
        const targetBuild = inspectValidatedHandoffTarget(target.target).build;
        const sameBuild =
          targetBuild.buildSetId === currentBuild.buildSetId && targetBuild.bundleHash === currentBuild.bundleHash;
        if (!sameBuild) {
          throw new StartupStoreHandoffError(target.target);
        }
        preferredStoreEpochKey = target.epochKey;
      }
      if (preferredStoreEpochKey === null && currentSelection !== null) {
        const selected = selectedNewerBuild(runtime, currentSelection);
        if (selected !== null) throw new StartupStoreHandoffError(selected);
      }
      return { ...NO_UNSERVED_SUCCESSION, preferredStoreEpochKey, retiredDeadAttemptId };
    };
    const unservedBeforeBind = noCoordinatorServes ? await resolveUnservedSuccession() : NO_UNSERVED_SUCCESSION;
    let bound: BoundCoordinator | null = null;
    if (ipcServer && listenIpcFn) {
      if (closeIpcServerFn === undefined) {
        throw new Error('IPC startup requires a close operation before binding');
      }
      if (successionAttemptChild !== null) {
        await successionAttemptChild.adoptListeners(ipcServer);
      } else {
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
          requestSuccession: async (incumbentSocketPath, incumbent, health) => {
            const target = resolveStrictBundleIdentity();
            if (!target.ok) return;
            const waiting = await requestUpgradeFromContender({
              runDir: runtime.paths.coral.coordinator.runDir,
              socketPath: incumbentSocketPath,
              incumbent,
              health,
              target: { build: target.manifest, pluginRootLabel: identity.pluginRoot },
              requestId: runtime.ids.uuid(),
              time: runtime.time,
              startLegacy: requestLegacyUpgrade,
            });
            await settleContenderUpgrade(runtime.paths.coral.coordinator.runDir, waiting, recordContenderDeferral);
          },
          signal,
          totalBudgetMs: HANDOFF_DRAIN_TIMEOUT_MS,
        });
      }
    }
    signal.throwIfAborted();
    // The probe reads only whether a recorded process lives, which a reused pid satisfies; a bind that met no holder
    // is what proves no coordinator answers, and only a startup that binds may act on what either decided.
    const boundUnanswered =
      !noCoordinatorServes && coordinatorAtStartup !== null && bound !== null && !bound.acquiredViaHandoff;
    const unserved = boundUnanswered ? await resolveUnservedSuccession() : unservedBeforeBind;
    if (unserved.hold !== null) throw startupHoldError(unserved.hold);
    const noCoordinatorAnswers = noCoordinatorServes || boundUnanswered;
    let committedRecovery = unserved.committedRecovery;
    const abandonedCommittedRecovery = Symbol('abandoned committed recovery');
    const committedRecoveryStep = async <T>(
      step: () => T | Promise<T>,
    ): Promise<T | typeof abandonedCommittedRecovery> => {
      try {
        return await step();
      } catch (error: unknown) {
        if (committedRecovery === null || signal.aborted) throw error;
        await holdFailedCommittedRecovery(runtime, instanceId, committedRecovery, error);
        return abandonedCommittedRecovery;
      }
    };
    let preferredStoreEpochKey = unserved.preferredStoreEpochKey;
    let pendingDeadAttempt = unserved.pendingDeadAttempt;
    const retiredDeadAttemptId = unserved.retiredDeadAttemptId;

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
    if (noCoordinatorAnswers) {
      const discard = await retryRecordedMintDiscard(runtime);
      const held = discard?.kind === 'held' ? heldUnservedMint(runtime) : null;
      if (held !== null && committedRecovery === null && preferredStoreEpochKey === null) throw startupHoldError(held);
    }
    if (pendingDeadAttempt !== null) {
      if (pendingDeadAttempt.discardAttemptId !== undefined) {
        const discarded = discardUnservedRetirementMint(
          runtime,
          pendingDeadAttempt.epochKey,
          pendingDeadAttempt.discardAttemptId,
        );
        if (discarded.kind === 'held') {
          throw startupHoldError({
            kind: 'unserved-mint-held',
            attemptId: pendingDeadAttempt.attemptId,
            reason: discarded.reason,
          });
        }
      }
      if ((await handBackDeadAttemptGeneration(runtime, instanceId, pendingDeadAttempt)) === 'abandoned') {
        pendingDeadAttempt = null;
        preferredStoreEpochKey = null;
      }
    }
    const preferredStore =
      preferredStoreEpochKey === null
        ? null
        : await openPreferredStoreEpoch(
            successionStoreContext,
            instanceId,
            preferredStoreEpochKey,
            pendingDeadAttempt?.attemptId ?? null,
          );

    if (successionAttemptChild !== null && preinjectedStoreServices !== null) {
      throw new SuccessionAttemptStartupHoldError('committed open requires a filesystem store');
    }
    const shouldScheduleStoreEpochSweep = preinjectedStoreServices === null;
    let storeDb: Database;
    let openedStore: ResolvedStoreEpoch | null = null;
    let successionGeneration: SuccessionWriterGeneration | null = null;
    let acceptedSuccessionPreparation: SuccessionPreparation | null = null;
    let acceptedSuccessionJobs: readonly string[] = [];
    let recoveryGeneration: SuccessionWriterGeneration | null = null;
    let recoveryIncarnation: ProcessIncarnation | null = null;
    const openOrdinaryStore = async (): Promise<Readonly<{ db: Database; store: ResolvedStoreEpoch }>> => {
      if (currentSelection === null) {
        throw documentedCoralSetupError({
          code: 'startup_bundle_unresolvable',
          pluginRoot: identity.pluginRoot,
        });
      }
      const authorizeStartupMint = deps.authorizeStartupMint;
      let mintWithheld = false;
      const routeStore = () =>
        routeOrOpenBackendStoreAtStartup({
          runtime,
          validateForeignTarget: validateForeignHandoffTarget,
          options: {
            storeFormat: deps.storeFormat,
            startupBusyTimeoutMs: STARTUP_STORE_BUSY_TIMEOUT_MS,
            selectProtectedPredecessor: (addresses) =>
              selectProtectedPredecessorFromControllers(
                runtime,
                runtime.storage.realpathSync(runtime.paths.coral.store.dbDir),
                addresses,
              ),
            ...(authorizeStartupMint === undefined
              ? {}
              : {
                  authorizeMint: (observation: Parameters<typeof authorizeStartupMint>[0]) => {
                    const disposition = authorizeStartupMint(observation);
                    mintWithheld = disposition === null;
                    return disposition;
                  },
                }),
            currentSelection,
          },
        });
      let routing: Awaited<ReturnType<typeof routeStore>>;
      try {
        routing = await routeStore();
      } catch (error: unknown) {
        // A withheld mint is decided by this boot: no later spawn is guaranteed on a machine nobody is watching.
        if (!mintWithheld) throw error;
        backendLog.warn(`Store epoch mint withheld under retirement patience; observing again: ${formatError(error)}`);
        await runtime.time.sleep(RETIREMENT_PATIENCE_INTERVAL_MS, { signal });
        mintWithheld = false;
        try {
          routing = await routeStore();
        } catch (repeated: unknown) {
          if (!mintWithheld) throw repeated;
          throw startupHoldError({
            kind: 'retirement-mint-withheld',
            attemptId: null,
            reason: errorMessage(repeated),
          });
        }
      }
      if (routing.kind === 'handoff') throw new StartupStoreHandoffError(routing.target);
      if (routing.kind === 'reset-newer-invalid') {
        backendLog.warn(
          `Recovered the newer-incompatible active store after selected bundle ${routing.evidence.bundleDir} failed validation (${routing.evidence.failure}).`,
        );
      }
      return { db: routing.db, store: routing.store };
    };
    if (preinjectedStoreServices !== null) {
      // Production starts with an empty service ref. Test composition may pre-inject an in-memory store, which
      // has no filesystem selection or reset state to coordinate and must not consume deterministic IDs.
      if (preinjectedStoreServices.storeDb.location() !== null) {
        throw new Error('Pre-injected lifecycle store must be non-filesystem-backed.');
      }
      storeDb = preinjectedStoreServices.storeDb;
    } else {
      if (committedRecovery !== null) {
        const recovery = committedRecovery;
        const opened = await committedRecoveryStep(() =>
          openCommittedRecoveryStore(successionStoreContext, recovery, {
            pid: backendPid,
            incarnation: deps.readSelfIncarnationFn,
          }),
        );
        if (opened === abandonedCommittedRecovery) {
          committedRecovery = null;
          const ordinary = await openOrdinaryStore();
          storeDb = ordinary.db;
          openedStore = ordinary.store;
        } else {
          storeDb = opened.db;
          openedStore = opened.store;
          recoveryGeneration = opened.generation;
          recoveryIncarnation = opened.incarnation;
          acceptedSuccessionPreparation = opened.preparation;
        }
      } else if (successionAttemptChild !== null) {
        if (preparedCommittedStore === null) {
          throw new SuccessionAttemptStartupHoldError('committed epoch was not prepared');
        }
        const historical = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
        const opened = await openSuccessionAttemptStore(
          successionStoreContext,
          successionAttemptChild,
          preparedCommittedStore,
          {
            interposition,
            retirementCertificate: {
              certificate: (epochKey) => historical.certificate(epochKey),
              resultsReleased: (epochKey) => historical.resultsReleased(epochKey),
            },
            ...(deps.onRetiredEpochOpened === undefined ? {} : { onRetiredEpochOpened: deps.onRetiredEpochOpened }),
          },
        );
        storeDb = opened.db;
        openedStore = opened.store;
        successionGeneration = opened.generation;
        acceptedSuccessionPreparation = opened.preparation;
      } else if (preferredStore !== null) {
        storeDb = preferredStore.db;
        openedStore = preferredStore.store;
      } else {
        const ordinary = await openOrdinaryStore();
        storeDb = ordinary.db;
        openedStore = ordinary.store;
      }
    }
    let storeServices: CoordinatorStoreServices;
    if (openedStore !== null) deps.onStoreOpened?.(openedStore);
    if (openedStore !== null) {
      state.rebindableStoreDb = createRebindableStoreDatabase(storeDb);
      storeDb = state.rebindableStoreDb.db;
    }
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
    if (acceptedSuccessionPreparation !== null && openedStore !== null) {
      if (acceptedSuccessionPreparation.receipts.length > 0 && deps.verifySuccessionReceipts === undefined) {
        throw new SuccessionAttemptStartupHoldError('accepted receipt verifier is unavailable');
      }
      const preparation = acceptedSuccessionPreparation;
      const epoch = openedStore;
      const verified = await committedRecoveryStep(
        () =>
          deps.verifySuccessionReceipts?.(
            preparation,
            epoch,
            committedRecovery?.intent.completionReceipt?.successor.instanceId ?? null,
          ) ?? [],
      );
      if (verified === abandonedCommittedRecovery) {
        committedRecovery = null;
        acceptedSuccessionPreparation = null;
        recoveryGeneration = null;
        recoveryIncarnation = null;
        if (state.rebindableStoreDb === null) throw new Error('Committed recovery store has no rebindable database.');
        state.rebindableStoreDb.closeCurrent();
        const ordinary = await openOrdinaryStore();
        state.rebindableStoreDb.replace(ordinary.db);
        openedStore = ordinary.store;
        deps.onStoreOpened?.(ordinary.store);
        storeServices = createStoreServicesFromDbFn(storeDb);
        storeServicesRef.clear();
        storeServicesRef.set(storeServices);
      } else {
        acceptedSuccessionJobs = verified;
      }
    }
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
        onRecoverySettlement: deps.onRecoverySettlement,
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

    // Ordinary startup binds HTTP and signals kernel-ready before recovery so the CLI can return promptly.
    // A supervised legacy successor binds HTTP before its serving receipt, with admission still fenced.
    if (!legacySupervisedChild) ({ port, host, bindHost: localBindHost } = await listenFn(server));
    signal.throwIfAborted();
    runtimeState.setStartedAt(now());
    startedAt = runtimeState.getStartedAt();
    const publishDiscovery = (): void => {
      const sentinelId = runtime.env.get('CORAL_SENTINEL_ID');
      const discoveryPublished = writeBackendInfoFn({
        pid: backendPid,
        port,
        host,
        ...(localBindHost === undefined ? {} : { bindHost: localBindHost }),
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
        ...(sentinelId === undefined ? {} : { sentinel: { version: 1 as const, id: sentinelId } }),
        ...(openedStore === null ? {} : { storeEpoch: openedStore.epoch }),
      });
      if (discoveryPublished === false) throw new Error('Coordinator discovery publication failed.');
    };
    publishLegacyDiscovery = () => {
      try {
        publishDiscovery();
        legacyDiscoveryPublished = true;
      } catch (error: unknown) {
        backendLog.warn(`Waiter-launched coordinator discovery publication failed: ${formatError(error)}`);
        if (state.started && !legacyDiscoveryRetryScheduled) {
          legacyDiscoveryRetryScheduled = true;
          void runtime.time.sleep(2_000).then(
            () => {
              legacyDiscoveryRetryScheduled = false;
              if (state.started && runtimeState.getLifecycle() === 'running') publishLegacyDiscovery?.();
            },
            (retryError: unknown) => {
              legacyDiscoveryRetryScheduled = false;
              backendLog.warn(`Waiter-launched discovery retry wait failed: ${formatError(retryError)}`);
            },
          );
        }
      }
    };
    if (successionAttemptChild === null && committedRecovery === null && !legacySupervisedChild) publishDiscovery();
    if (committedRecovery === null && !legacySupervisedChild) runtimeState.setLifecycle('kernel-ready');
    runtimeState.setLaunchFenceActive(true);
    // An attempt child that has not served may still be abandoned, and its sweep would certify the epoch it retires.
    if (
      successionAttemptChild === null &&
      committedRecovery === null &&
      !legacySupervisedChild &&
      shouldScheduleStoreEpochSweep &&
      openedStore !== null
    ) {
      deps.scheduleStoreEpochSweepFn?.(openedStore);
    }
    // ===== Era II (recovery) =====
    await yieldPastKernelReadyResponse();
    reconcileCustodyAtStartup?.();
    // This order is load-bearing: a pending publication contains remote facts that the generic job walk
    // cannot see, so allowing that walk to classify the job first could authorize a contradictory execution.
    const providerOperationStartupSnapshot = recoveryCoordinator.snapshotProviderOperationStartupOwnership();
    const providerOperationStartupOwnership = recoveryCoordinator.hydrateProviderOperationStartupOwnership(
      providerOperationStartupSnapshot,
    );
    signal.throwIfAborted();
    const providerOperationStartupReport = await reconcileProviderOperationsAtStartup?.(
      providerOperationStartupOwnership,
      signal,
    );
    for (const incident of providerOperationStartupReport?.incidents ?? []) {
      backendLog.warn(
        `Provider operation startup reconciliation left an obligation open: ${describeStartupReconciliationIncident(incident)}`,
      );
    }
    signal.throwIfAborted();
    // Per-job isolation: corrupt sessions should not abort recovery.
    // `bound.runStartupRecovery` registers journal cursors then awaits
    // `waitFreshUntil` against `currentMaxSeq`; that wait runs here in Era II
    // because its budget is bounded by the daemon-side
    // `bootFreshnessTimeoutMs` (default 90s), not by either CLI-facing
    // deadline — the CLI has already returned by now.
    const recoveryInputs: StartupRecoveryInputs = {
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
      interruptedAppServerReason: bound?.acquiredViaHandoff ? 'handoff' : 'restart',
      transferredJobIds: new Set(
        acceptedSuccessionPreparation === null
          ? []
          : (deps.transferredHostJobIds?.(acceptedSuccessionPreparation) ?? []),
      ),
    };
    // A startup that bound no socket owes recovery only for work it was handed: a succession child that
    // inherited its listeners owns exactly the obligations its accepted receipts transferred, and nothing else.
    let recoveredDiscussResumes =
      bound !== null
        ? await bound.runStartupRecovery(recoveryInputs)
        : (acceptedSuccessionPreparation?.receipts.length ?? 0) > 0
          ? await runStartupRecovery(
              { ...recoveryInputs, interruptedAppServerReason: 'restart' },
              recoveryCoordinator.runStartupRecovery,
            )
          : [];
    const adoptedGeneration = successionGeneration ?? recoveryGeneration;
    if (acceptedSuccessionPreparation !== null && adoptedGeneration !== null) {
      if (deps.adoptSuccessionReceipts === undefined) {
        throw new SuccessionAttemptStartupHoldError('accepted receipt adoption is unavailable');
      }
      const adoptSuccessionReceipts = deps.adoptSuccessionReceipts;
      const preparation = acceptedSuccessionPreparation;
      const adopted = await committedRecoveryStep(() =>
        adoptSuccessionReceipts(
          preparation,
          acceptedSuccessionJobs,
          adoptedGeneration,
          successionAttemptChild?.recovery === true || committedRecovery !== null,
        ),
      );
      if (adopted === abandonedCommittedRecovery) {
        committedRecovery = null;
        acceptedSuccessionPreparation = null;
        acceptedSuccessionJobs = [];
        runtimeState.setLifecycle('kernel-ready');
        if (!legacySupervisedChild) {
          publishDiscovery();
          if (shouldScheduleStoreEpochSweep && openedStore !== null) deps.scheduleStoreEpochSweepFn?.(openedStore);
        }
        const ordinaryResumes = await (bound !== null
          ? bound.runStartupRecovery({ ...recoveryInputs, transferredJobIds: new Set() })
          : runStartupRecovery(
              { ...recoveryInputs, transferredJobIds: new Set(), interruptedAppServerReason: 'restart' },
              recoveryCoordinator.runStartupRecovery,
            ));
        recoveredDiscussResumes = [
          ...new Map(
            [...recoveredDiscussResumes, ...ordinaryResumes].map((resume) => [resume.sessionId, resume]),
          ).values(),
        ];
      }
    }
    startupRecoveryBarrierPublisher?.publish();
    startProviderOperationReconciler?.();
    await Promise.resolve(cleanupStaleJobsFn(bundleHash, signal));
    signal.throwIfAborted();
    if (successionAttemptChild !== null) {
      if (successionGeneration === null || ipcServer === undefined || openedStore === null) {
        throw new SuccessionAttemptStartupHoldError('succession writer or listener is unavailable');
      }
      await publishAttemptServing(
        runtime,
        successionAttemptChild,
        { db: storeDb, store: openedStore, generation: successionGeneration },
        acceptedSuccessionPreparation,
        {
          instanceId,
          listener: ipcServer,
          productVersion: deps.storeFormat.productVersion,
          signal,
          interposition,
          publishDiscovery,
          ...(deps.recordSuccessionControllerReceipts === undefined
            ? {}
            : { recordControllerReceipts: deps.recordSuccessionControllerReceipts }),
          ...(deps.onStoreServing === undefined ? {} : { onStoreServing: deps.onStoreServing }),
          ...(deps.onSuccessionServing === undefined ? {} : { onServing: deps.onSuccessionServing }),
        },
      );
      if (shouldScheduleStoreEpochSweep) deps.scheduleStoreEpochSweepFn?.(openedStore);
    } else if (committedRecovery !== null) {
      if (recoveryGeneration === null || recoveryIncarnation === null) {
        throw new Error('Committed successor recovery has no writer identity.');
      }
      await publishCommittedRecoveryServing(
        runtime,
        committedRecovery,
        { generation: recoveryGeneration, incarnation: recoveryIncarnation },
        acceptedSuccessionPreparation,
        {
          instanceId,
          pid: backendPid,
          ...(deps.recordSuccessionControllerReceipts === undefined
            ? {}
            : { recordControllerReceipts: deps.recordSuccessionControllerReceipts }),
        },
      );
      runtimeState.setLifecycle('kernel-ready');
      publishDiscovery();
      if (shouldScheduleStoreEpochSweep && openedStore !== null) deps.scheduleStoreEpochSweepFn?.(openedStore);
    }
    if (legacySupervisedChild) {
      if (committedRecovery !== null || openedStore === null) {
        throw new SuccessionAttemptStartupHoldError('legacy serving record has no completion receipt');
      }
      ({ port, host, bindHost: localBindHost } = await listenFn(server));
      signal.throwIfAborted();
      const legacyCompletion = await completeSupervisorLegacyUpgrade(
        runtime,
        currentBuild,
        openedStore,
        instanceId,
        backendPid,
        deps.readSelfIncarnationFn(),
      );
      if (legacyCompletion.kind !== 'completed')
        throw new SuccessionAttemptStartupHoldError('legacy launch did not record completion');
      legacyServingCompleted = true;
      runtimeState.setLifecycle('kernel-ready');
      publishLegacyDiscovery();
      if (shouldScheduleStoreEpochSweep) deps.scheduleStoreEpochSweepFn?.(openedStore);
    }
    if (runtimeState.getLaunchFenceActive()) {
      runtimeState.setLaunchFenceActive(false);
    }
    const deadAttemptId = pendingDeadAttempt?.attemptId ?? retiredDeadAttemptId;
    if (deadAttemptId !== null) {
      await dischargeDeadSuccessionAttempt(runtime, deadAttemptId, deps.successionIncumbent());
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
    if (legacyServingCompleted && !legacyDiscoveryPublished) publishLegacyDiscovery();
    deps.wakeSuccessionReconciler?.();
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

    return serverInfo();
  } catch (error: unknown) {
    if (legacyServingCompleted && !signal.aborted) {
      backendLog.error(
        'Waiter-launched coordinator startup failed after serving was recorded; retaining listeners',
        error,
      );
      if (runtimeState.getLifecycle() === 'starting') runtimeState.setLifecycle('kernel-ready');
      if (runtimeState.getLifecycle() === 'kernel-ready') runtimeState.setLifecycle('running');
      state.started = true;
      runtimeState.setLaunchFenceActive(false);
      if (!legacyDiscoveryPublished) publishLegacyDiscovery?.();
      return serverInfo();
    }
    const successionAttemptChild = currentSuccessionAttemptChild();
    if (successionAttemptChild !== null && !successionAttemptChild.isServing()) {
      await successionAttemptChild
        .acknowledge({
          kind: 'hold',
          reason: error instanceof Error ? error.message : String(error),
        })
        .catch(() => {});
    }
    const mutationAdmissionDisposition = state.providerOperationMutationAdmission?.close();
    if (
      (error as { name?: string } | null)?.name === 'AbortError' &&
      (state.shutdownPromise !== null || state.shutdownRetry !== null)
    ) {
      // Startup failure must not release authority owned by a shutdown attempt or its retained continuation.
      throw error;
    }
    if (mutationAdmissionDisposition?.kind === 'holding') {
      // `retryAfter` settles only when every pending mutation returns and every closed-set fence lease is
      // released by its holder — neither is bounded by anything this cleanup owns, so awaiting it here would
      // sit ahead of the socket close and discovery withdrawal this cleanup still owes. What this cleanup did
      // not observe settle stays visible instead of being swallowed.
      backendLog.error(
        `Provider operation mutation admission did not confirm drained during startup-failure cleanup (pending: ${mutationAdmissionDisposition.pendingMutations.join(', ')})`,
      );
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
      // No retry: a `holding` result's `retryAfter` waits on the child's `close` event, which a grandchild
      // holding its stdio pipes open can keep from ever firing — that wait must not sit ahead of the socket
      // close and discovery withdrawal this cleanup still owes.
      const disposal = await kbDaemonSupervisor?.dispose('coordinator startup failed');
      if (disposal?.kind === 'holding') {
        backendLog.error(
          `KB daemon disposal did not confirm absence during startup-failure cleanup (${disposal.reason})`,
        );
      }
    } catch (error: unknown) {
      backendLog.error(`KB daemon disposal during startup-failure cleanup failed (${formatError(error)})`);
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
    const withdrawal = removeBackendInfoIfOwnerFn(instanceId);
    if (withdrawal !== undefined && withdrawal.kind === 'refused') {
      backendLog.error(
        `backend discovery withdrawal refused during startup-failure cleanup operation=${withdrawal.operation} code=${withdrawal.code} ${lifecycleDiagnosticFields(withdrawal.error)} correlation=${withdrawal.correlation}`,
      );
    }

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
    backendPid,
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
    readSelfIncarnationFn,
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
    shutdownHardConsequencesAbort: null,
    shutdownReason: null,
    shutdownIncidents: [],
    shutdownIncidentCount: 0,
    shutdownRetryAfter: null,
    shutdownRetry: null,
    shutdownObservationReader: null,
    lastShutdownDisposition: null,
    started: false,
    ownershipCheckerTeardown: null,
    recoveryCoordinator: null,
    providerOperationMutationAdmission: null,
    startupAbort: null,
    rebindableStoreDb: null,
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

  let successionRelease: Promise<never> | null = null;
  function releaseAuthority(release: SuccessionRelease): Promise<never> {
    successionRelease ??= (async () => {
      runtimeState.setLifecycle('draining');
      idleTimer.stopWatching();
      const disposition = await runSuccessionReleaseSequence({ release, runtime, providerHostManager, log });
      if (disposition.disposition !== 'settled') {
        bestEffortLifecycleLog(log, `succession release ended ${disposition.disposition}\n`);
      }
      if (release.kind === 'successor') {
        try {
          await release.handOver();
        } catch (error: unknown) {
          bestEffortLifecycleLog(log, `final succession connection handover failed: ${formatError(error)}\n`);
        }
      }
      runtimeState.setLifecycle('stopped');
      // A handed-over listener must stay open until exit: closing it would unlink the successor's address.
      return process.exit(release.kind === 'successor' ? 0 : SUCCESSION_RESTART_EXIT_CODE);
    })();
    return successionRelease;
  }

  async function shutdown(reason: ShutdownReason, incident?: ShutdownIncident): Promise<LifecycleShutdownDisposition> {
    const succession = deps.succession;
    if (succession?.committed() === true) {
      return releaseAuthority({ kind: 'successor', handOver: () => succession.handOverOpenConnections() });
    }
    state.shutdownReason ??= reason;
    if (reason === 'provider-proxy-lifecycle-fatal' || incident !== undefined) {
      state.shutdownReason = 'provider-proxy-lifecycle-fatal';
      state.shutdownHardConsequencesAbort?.abort();
    }
    if (incident !== undefined) {
      state.shutdownIncidentCount += 1;
      state.shutdownIncidents.push({ incident, occurrence: state.shutdownIncidentCount });
    }
    if (state.shutdownPromise) return state.shutdownPromise;
    const currentShutdownReason = (): ShutdownReason => state.shutdownReason ?? reason;
    const takeShutdownIncidents = (): readonly ShutdownIncidentOccurrence[] => state.shutdownIncidents.splice(0);
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
      const terminalReason = currentShutdownReason();
      const losses: ShutdownUndischarged[] = [
        ...(terminal.disposition === 'finalized' ? [] : terminal.undischarged),
        ...takeShutdownIncidents().map(shutdownIncidentUndischarged),
      ];
      const publish = (): void => {
        try {
          const publication = recordShutdownRemainder(
            {
              storage: runtime.storage,
              time: runtime.time,
              runDir: runtime.paths.coral.coordinator.runDir,
              writer: {
                pid: backendPid,
                incarnation: readSelfIncarnationFn(),
              },
            },
            {
              instanceId,
              reason: terminalReason,
              undischarged: losses,
            },
          );
          switch (publication.kind) {
            case 'published':
              return;
            case 'refused':
              bestEffortLifecycleLog(
                log,
                `shutdown remainder write refused operation=${publication.operation} code=${publication.code} ${lifecycleDiagnosticFields(publication.diagnostic)} correlation=${publication.correlation}\n`,
              );
              return;
            case 'verification-unavailable':
              bestEffortLifecycleLog(
                log,
                `shutdown remainder publication verification unavailable operation=${publication.operation} code=${publication.code} ${lifecycleDiagnosticFields(publication.diagnostic)} correlation=${publication.correlation}\n`,
              );
              return;
          }
        } catch (error: unknown) {
          const diagnostic = serializeThrown(error);
          const correlation = sha256Hex(`publish\0unexpected-exception\0${JSON.stringify(diagnostic)}`);
          bestEffortLifecycleLog(
            log,
            `shutdown remainder write refused operation=publish code=unexpected-exception ${lifecycleDiagnosticFields(diagnostic)} correlation=${correlation}\n`,
          );
        }
      };
      const withdraw = (): Readonly<{
        operation: 'read' | 'decode' | 'unlink' | 'callback';
        code: 'filesystem-operation-failed' | 'corrupt-json' | 'shape-rejected' | 'unexpected-exception';
        correlation: string;
        error: SerializedThrown;
      }> | null => {
        try {
          const withdrawal = removeBackendInfoIfOwnerFn(instanceId);
          return withdrawal !== undefined && withdrawal.kind === 'refused' ? withdrawal : null;
        } catch (error: unknown) {
          const serialized = serializeThrown(error);
          return {
            operation: 'callback',
            code: 'unexpected-exception',
            correlation: sha256Hex(`callback\0unexpected-exception\0${JSON.stringify(serialized)}`),
            error: serialized,
          };
        }
      };

      try {
        // Constraint: the store holds the latest remainder, not the latest loss. Publishing only when this
        // shutdown lost something leaves a record this build cannot read with no writer that will replace it,
        // and a clean shutdown is itself the answer that supersedes it.
        publish();
        const refusal = withdraw();
        if (refusal !== null) {
          bestEffortLifecycleLog(
            log,
            `backend discovery withdrawal refused operation=${refusal.operation} code=${refusal.code} ${lifecycleDiagnosticFields(refusal.error)} correlation=${refusal.correlation}\n`,
          );
          losses.push({
            label: 'backend discovery withdrawal',
            remainder: { owner: 'process-exit' },
            settlement: { cause: 'rejected', error: refusal.error },
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
        state.shutdownRetry = { retry: disposition.retry };
        const recovery: LifecycleShutdownRecovery = {
          kind: 'retry-shutdown',
          exit: disposition.exit,
          owner: {
            kind: 'lifecycle-finalization-continuation',
            instanceId,
          },
          automaticRetry: {
            status: 'scheduled',
            attemptsStarted: disposition.attemptsStarted,
            attemptLimit: disposition.attemptLimit,
          },
          retainedOwnership: {
            kind: 'coordinator-exclusive-authority',
            backendInfo: { kind: 'backend-info', instanceId },
            ipcSocket: disposition.retainedAuthority.ipcSocket,
            providerControlProxyInstanceIds: disposition.retainedAuthority.providerControlProxyInstanceIds,
            cleanupObligations: disposition.retainedAuthority.cleanupObligations,
          },
          retry: () => shutdown(currentShutdownReason()),
        };
        return { disposition: 'held', reason: disposition.reason, recovery };
      }
      state.shutdownRetryAfter = null;
      state.shutdownRetry = null;
      state.shutdownObservationReader = null;
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
    const settleShutdownDisposition = async (
      disposition: ShutdownSequenceDisposition,
    ): Promise<LifecycleShutdownDisposition> => {
      if (disposition.disposition === 'settled') {
        try {
          await closeServedIntentAtCleanExit(runtime, instanceId, deps.successionIncumbent());
        } catch (error: unknown) {
          log(`served upgrade intent could not be closed at exit (${formatError(error)})\n`);
        }
      }
      return acceptShutdownDisposition(disposition);
    };
    const attempt = (async (): Promise<LifecycleShutdownDisposition> => {
      if (runtimeState.getLifecycle() === 'stopped') {
        return { disposition: 'finalized' };
      }
      if (state.shutdownRetry !== null) return state.shutdownRetry.retry().then(settleShutdownDisposition);
      const hardConsequencesAbort = new AbortController();
      state.shutdownHardConsequencesAbort = hardConsequencesAbort;
      const stopProviderOperationMutations = (): ProviderOperationReconcilerStopDisposition => {
        const lifecycleDisposition = state.providerOperationMutationAdmission?.close() ?? {
          kind: 'drained' as const,
        };
        const reconcilerDisposition = stopProviderOperationReconciler?.() ?? { kind: 'drained' as const };
        return lifecycleDisposition.kind === 'holding' ? lifecycleDisposition : reconcilerDisposition;
      };
      try {
        return await settleShutdownDisposition(
          await runShutdownSequence({
            reason: currentShutdownReason(),
            currentReason: currentShutdownReason,
            registerShutdownObservationReader: (reader) => {
              state.shutdownObservationReader = reader;
            },
            takeIncidents: takeShutdownIncidents,
            hardConsequencesAbort: hardConsequencesAbort.signal,
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
            ...(deps.succession === undefined
              ? {}
              : { settleSuccessionAttempt: deps.succession.settleUncommittedAttempt }),
            log,
            ...(acceptProcessExitRemainder === undefined ? {} : { acceptProcessExitRemainder }),
          }),
        );
      } finally {
        if (state.shutdownHardConsequencesAbort === hardConsequencesAbort) {
          state.shutdownHardConsequencesAbort = null;
        }
      }
    })().catch((error) => {
      onFatalShutdownError(error);
      throw error;
    });
    const trackedAttempt = attempt.then(
      (disposition) => {
        state.lastShutdownDisposition = disposition;
        if (!isLifecycleShutdownTerminal(disposition)) {
          state.shutdownPromise = null;
          const automaticRetry = disposition.recovery.automaticRetry;
          if (
            automaticRetry.status === 'scheduled' &&
            state.shutdownContinuations.size === 0 &&
            automaticRetry.attemptsStarted < automaticRetry.attemptLimit
          ) {
            const continuationAbort = new AbortController();
            state.shutdownContinuationAbort = continuationAbort;
            const cancelled = new Promise<void>((resolve) => {
              continuationAbort.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            let pending: LifecycleShutdownDisposition = disposition;
            const continuation = (async () => {
              // The loop's own attempt count must come from the disposition the ledger just returned, not a
              // continuation-local counter — a count kept here can diverge from the ledger's forced-terminal
              // attempt and strand the loop on a hold with nothing left to schedule a retry.
              while (
                !isLifecycleShutdownTerminal(pending) &&
                pending.recovery.automaticRetry.status === 'scheduled' &&
                pending.recovery.automaticRetry.attemptsStarted < pending.recovery.automaticRetry.attemptLimit
              ) {
                await Promise.race([state.shutdownRetryAfter ?? Promise.resolve(), cancelled]);
                if (continuationAbort.signal.aborted) return;
                pending = await shutdown(currentShutdownReason());
                if (isLifecycleShutdownTerminal(pending)) return;
              }
            })()
              .catch((error: unknown) => {
                if (!isLifecycleShutdownTerminal(pending)) {
                  state.lastShutdownDisposition = {
                    ...pending,
                    recovery: {
                      ...pending.recovery,
                      automaticRetry: { status: 'failed' },
                    },
                  };
                }
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

  async function parkProviderOperationMutations(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const disposition = state.providerOperationMutationAdmission?.close();
    if (disposition?.kind === 'holding') {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void =>
          reject(signal?.reason instanceof Error ? signal.reason : new Error('Succession writer park aborted.'));
        signal?.addEventListener('abort', onAbort, { once: true });
        void disposition.retryAfter.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
      });
      signal?.throwIfAborted();
      if (state.providerOperationMutationAdmission?.close().kind === 'holding') {
        throw new Error('Provider operation mutations did not drain before succession.');
      }
    }
    state.providerOperationMutationAdmission = null;
  }

  function adoptProviderOperationAdmission(admission: ProviderOperationMutationAdmission): void {
    state.providerOperationMutationAdmission = admission;
  }

  function protectRetiringStore(epochKey: string, openerDrainMs: number): RetiringStoreProtection {
    const expected = decodeResolvedStoreEpoch(runtime, epochKey);
    const handle = state.rebindableStoreDb;
    if (expected === undefined || expected.lineageKey === undefined || handle === null) {
      throw new Error('Retiring store is unavailable.');
    }
    const current = inspectCurrentStore(runtime);
    if (current.kind !== 'current' || encodeResolvedStoreEpoch(runtime, current.epoch) !== epochKey) {
      throw new Error('Retiring store changed before protection.');
    }
    handle.closeCurrent();
    try {
      protectStoreEpoch(runtime, expected, openerDrainMs);
    } catch (error: unknown) {
      if (error instanceof StoreEpochOpenerHeldError) return { kind: 'opener-held', reason: error.message };
      throw error;
    }
    const protectedEpoch = resolveProtectedEpoch(runtime, expected.storeRoot, expected.lineageKey);
    if (protectedEpoch === null || protectedEpoch.path === expected.path) {
      throw new Error('Retiring store has no protected address.');
    }
    const readOnly = openReadOnlyStoreDatabase(runtime, {
      storeFormat: deps.storeFormat,
      resolved: { path: protectedEpoch.path, epoch: protectedEpoch, epochCandidate: true },
    });
    handle.replace(asDatabase(readOnly));
    return { kind: 'protected' };
  }

  function reopenRetiringStore(epochKey: string): void {
    const handle = state.rebindableStoreDb;
    if (handle === null) throw new Error('Retiring store cannot be reopened.');
    handle.closeCurrent();
    const expected = decodeResolvedStoreEpoch(runtime, epochKey);
    if (expected === undefined || expected.lineageKey === undefined) {
      throw new Error('Retiring store cannot be reopened.');
    }
    const storeRoot = runtime.storage.realpathSync(runtime.paths.coral.store.dbDir);
    if (resolveProtectedEpoch(runtime, storeRoot, expected.lineageKey) !== null) {
      restoreProtectedEpoch(runtime, storeRoot, expected.lineageKey);
    }
    const restored = decodeResolvedStoreEpoch(runtime, epochKey);
    if (restored === undefined || restored.path !== join(storeRoot, `epoch-${expected.epoch}`, 'store.db')) {
      throw new Error('Retiring store canonical address was not restored.');
    }
    const opened = openCommittedBackendStoreAtStartup(
      runtime,
      {
        storeFormat: deps.storeFormat,
        build: {
          version: identity.version,
          buildSetId: identity.buildSetId,
          flavor: identity.flavor,
          storeFormatFingerprint: deps.storeFormat.fingerprint,
          bundleHash: identity.bundleHash,
          cliBundleHash: identity.cliBundleHash,
          claudeAppserverBundleHash: identity.claudeAppserverBundleHash,
          durableWrapperBundleHash: identity.durableWrapperBundleHash,
        },
        startupBusyTimeoutMs: STARTUP_STORE_BUSY_TIMEOUT_MS,
      },
      restored,
    );
    if (opened.kind === 'holding') throw new Error(`Retiring store reopen held: ${opened.reason}`);
    handle.replace(opened.db);
  }

  function requestShutdownRetry(): void {
    const currentAttempt = state.shutdownPromise;
    if (currentAttempt === null) {
      const retryReason = state.shutdownReason;
      if (state.shutdownRetry === null || retryReason === null) return;
      void shutdown(retryReason).catch((error: unknown) => {
        log(`operator recovery shutdown retry failed (${formatError(error)})\n`);
      });
      return;
    }
    void currentAttempt
      .then((disposition) => {
        const retryReason = state.shutdownReason;
        if (!isLifecycleShutdownTerminal(disposition) && state.shutdownRetry !== null && retryReason !== null) {
          return shutdown(retryReason);
        }
      })
      .catch((error: unknown) => {
        log(`operator recovery shutdown retry failed (${formatError(error)})\n`);
      });
  }

  return {
    start,
    shutdown,
    observeShutdown: () => projectLifecycleShutdownObservation(state),
    requestShutdownRetry,
    waitForShutdown: () => {
      if (state.shutdownPromise !== null) return state.shutdownPromise;
      if (state.lastShutdownDisposition !== null) return Promise.resolve(state.lastShutdownDisposition);
      return Promise.reject(new Error('Shutdown has not been requested'));
    },
    getRecoveryRegistry: () => state.recoveryCoordinator?.getRecoveryRegistry() ?? null,
    parkProviderOperationMutations,
    adoptProviderOperationAdmission,
    protectRetiringStore,
    reopenRetiringStore,
    releaseAuthority,
  };
}
