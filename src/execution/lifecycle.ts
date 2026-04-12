/**
 * Lifecycle management for the backend server.
 *
 * Extracted from `createBackendServer()` in server.ts. Owns startup,
 * shutdown, recovery adoption, session-index subscription, idle-watch setup,
 * and the replacement-backend ownership checker.
 *
 * All dependencies are received through the explicit `LifecycleDeps` contract.
 */

import type { Server, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { errorMessage, formatError, isNoEntryError, isRecord } from '../shared/utils.js';
import { backendLog } from '../shared/backend-log.js';
import { kbRoot } from '../infra/paths.js';
import { type LaunchCoordinator, type SpawnCliFn } from './engine.js';
import { readBackendInfo, type writeBackendInfo, type removeBackendInfoIfOwner } from '../infra/backend-info.js';
import { RecoveryRegistry } from './recovery-registry.js';
import { type EventBusEvents, type TypedEventBus } from './event-bus.js';
import type { IdleTimer } from './idle-timer.js';
import type { ProgressStore } from './progress-store.js';
import type { CallerContext } from '../shared/request-context.js';
import type { SessionIndex } from './session-index.js';
import { listSessionShards, SessionManager } from './session-manager.js';
import type { DiscussContext } from './discuss/context.js';
import type { DiscussSessionStore } from './discuss/session-store.js';
import { clearAllDiscuss, hasRunningSessions, type DiscussContextRegistry } from './discuss/context-registry.js';
import * as discussLoop from './discuss/loop.js';
import * as discussOperations from './discuss/operations.js';
import { type ProviderRegistry } from '../providers/registry.js';
import { type RecoveryCapableService } from './service.js';
import {
  isAppServerRuntime,
  isLivePhase,
  isTerminalPhase,
  readBackendNamespace,
  type PersistedExitRecord,
  type PersistedLaunchRecord,
  type PersistedRuntimeRecord,
  type PersistedStatusRecord,
  type SessionEntry,
  type TerminalResult,
} from '../shared/types.js';
import { createCurateScheduler } from '../kb/curate/scheduler.js';
import { kbRuntimeDir } from '../kb/paths.js';
import { createKbRuntime } from '../kb/runtime.js';
import type { KbSubsystem } from './kb-tools.js';
import type { BackendIdentity, ExecutionServiceLike, MutableBackendRuntimeState } from './backend-contracts.js';
import type { ProviderHostManager } from './host-manager.js';
import type { BackendServerInfo } from './server-types.js';
import { planRecovery, type JobStoreSnapshot, type RecoveryAction, type RecoveryInvariants } from './recovery-core.js';
import type { Runtime } from './runtime.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
export const HANDOFF_DRAIN_TIMEOUT_MS = 30_000;
export const SHUTDOWN_POLL_MS = 50;
export const RECOVERY_POLL_MS = 500;
export const OLD_FORMAT_NOTICE =
  'Incompatible job format — missing durable launch record. Job predates the handoff recovery system.';
export const GHOST_LAUNCH_NOTICE =
  'Launch record exists but runtime.json was never written. The durable wrapper did not start successfully.';

export type CreateKbSubsystemFn = (options: {
  pluginRoot: string;
  spawnCli: SpawnCliFn;
}) => Promise<KbSubsystem>;

// ---------------------------------------------------------------------------
// ShutdownMode / RecoveryClass
// ---------------------------------------------------------------------------

/**
 * Shutdown mode derived from reason. Determines child process and job handling:
 * - handoff: preserve wrappers/children for recovery; do NOT mark jobs as error or kill children
 * - hard: kill children and mark jobs as error (current behavior)
 */
export type ShutdownMode = 'handoff' | 'hard';

export function shutdownModeFromReason(reason: string): ShutdownMode {
  if (reason === 'replaced' || reason === 'sigterm') return 'handoff';
  return 'hard';
}

export class StartupInterruptedError extends Error {
  constructor() {
    super('Startup interrupted by shutdown');
    this.name = 'StartupInterruptedError';
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (pure functions, no closure state)
// ---------------------------------------------------------------------------

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

export function withBackendNamespace(status: PersistedStatusRecord, namespace: string): PersistedStatusRecord {
  return {
    ...status,
    backendNamespace: namespace,
  } as PersistedStatusRecord;
}

export function listLiveJobs(progressStore: ProgressStore, namespace: string): PersistedStatusRecord[] {
  const results: PersistedStatusRecord[] = [];

  for (const jobId of progressStore.listJobIds()) {
    const status = progressStore.readStatus(jobId);
    if (!status || !isLivePhase(status.phase)) continue;

    const backendNamespace = readBackendNamespace(status);
    if (backendNamespace === null) {
      const rewritten = withBackendNamespace(status, namespace);
      progressStore.writeStatus(jobId, rewritten);
      results.push(rewritten);
      continue;
    }

    if (backendNamespace === namespace) {
      results.push(status);
    }
  }

  return results;
}

export function readSessionRefs(
  shardDir: string,
  storage: Pick<Runtime['storage'], 'readdirSync' | 'readFileSync'>,
): Array<{ sessionId: string; provider: string }> {
  try {
    return storage
      .readdirSync(shardDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .flatMap((entry) => {
        try {
          const raw = storage.readFileSync(join(shardDir, entry.name), 'utf-8');
          const parsed: unknown = JSON.parse(raw);
          if (!isRecord(parsed)) return [];
          if (typeof parsed.sessionId !== 'string' || typeof parsed.provider !== 'string') return [];
          return [{ sessionId: parsed.sessionId, provider: parsed.provider }];
        } catch (error: unknown) {
          if (isNoEntryError(error) || error instanceof SyntaxError) return [];
          throw error;
        }
      });
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw error;
  }
}

export function markJobAsError(
  progressStore: ProgressStore,
  status: PersistedStatusRecord,
  notice: string,
  log: (message: string) => void,
): void {
  const terminalResult: TerminalResult =
    status.jobKind === 'workflow' ? { content: '', notice, workflow: { steps: [] } } : { content: '', notice };
  progressStore.updateLaunchState(status.jobId, 'error', notice);
  if (status.jobKind === 'workflow') {
    try {
      progressStore.writeWorkflowResultMdOrThrow(status.jobId, '');
    } catch (err) {
      log(`Failed to write workflow result for ${status.jobId}: ${formatError(err)}\n`);
    }
  }
  try {
    progressStore.appendTerminal(status.jobId, status.sessionId, terminalResult, 'error');
  } catch {
    progressStore.markTerminalStatus(status.jobId, terminalResult, 'error');
  }
}

export function cleanupStaleJobs(
  progressStore: ProgressStore,
  currentBundleHash: string,
  log: (message: string) => void,
  storage: Pick<Runtime['storage'], 'rmSync'>,
): void {
  for (const jobId of progressStore.listJobIds()) {
    const status = progressStore.readStatus(jobId);
    if (!status) continue;
    if (!isTerminalPhase(status.phase)) continue;
    if (!status.bundleHash || status.bundleHash === currentBundleHash) continue;

    try {
      storage.rmSync(progressStore.jobDir(jobId), { recursive: true, force: true });
      progressStore.purgeFromCache(jobId);
      log(`Cleaned up stale job: ${jobId}\n`);
    } catch {
      // best-effort
    }
  }
}

export function markJobsAsError(progressStore: ProgressStore, namespace: string, message: string): void {
  for (const status of listLiveJobs(progressStore, namespace)) {
    try {
      markJobAsError(progressStore, status, message, () => {});
    } catch {
      // fail-isolated: skip this job, continue with others
    }
  }
}

export async function createKbSubsystem({
  pluginRoot,
  spawnCli: spawnKbCli,
}: {
  pluginRoot: string;
  spawnCli: SpawnCliFn;
}): Promise<KbSubsystem> {
  const kb = createKbRuntime({
    markdownRoot: kbRoot(),
    runtimeDir: kbRuntimeDir(),
  });
  await kb.initVectorStore(pluginRoot);

  const curateScheduler = createCurateScheduler({
    kb,
    spawnCli: spawnKbCli,
  });

  await curateScheduler.start();

  return {
    kb,
    curateScheduler,
  };
}

/** Returns a URL-ready host: IPv6 addresses are wrapped in brackets. */
export function resolveClientHost(bindHost: string, advertiseHost?: string): string {
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
  readonly getDiscussContext: (ctx: CallerContext) => DiscussContext;
  readonly createCallerContext: (projectRoot: string) => CallerContext;
  readonly assertStartupStillActive: () => void;
};

export type RecoverPersistedDiscussFn = (
  deps: RecoverPersistedDiscussDeps,
) => Promise<discussOperations.RecoveredDiscussResume[]>;

export async function recoverPersistedDiscuss(
  deps: RecoverPersistedDiscussDeps,
): Promise<discussOperations.RecoveredDiscussResume[]> {
  const recoveredDiscussResumes: discussOperations.RecoveredDiscussResume[] = [];

  for (const source of deps.knownDiscussSources()) {
    try {
      recoveredDiscussResumes.push(
        ...(await discussOperations.recoverPersistedSessionsFromStore(
          deps.getDiscussStoreForSource(source),
          (snapshot) => deps.getDiscussContext(deps.createCallerContext(snapshot.projectRoot)),
          (snapshot) => deps.createCallerContext(snapshot.projectRoot),
        )),
      );
    } catch (err) {
      backendLog.warn(`Discuss recovery failed for source ${source}: ${errorMessage(err)}`);
    }
    deps.assertStartupStillActive();
  }

  return recoveredDiscussResumes;
}

// ---------------------------------------------------------------------------
// LifecycleDeps — everything the lifecycle module needs
// ---------------------------------------------------------------------------

export type LifecycleDeps = {
  // Identity / config
  readonly identity: BackendIdentity;
  readonly runtime: Runtime;
  readonly backendPid: number;

  // Shared mutable runtime state
  readonly runtimeState: MutableBackendRuntimeState;

  // Runtime services (reference-identical with httpHandlerDeps)
  readonly idleTimer: IdleTimer;
  readonly progressStore: ProgressStore;
  readonly sessionIndex: SessionIndex;
  readonly streamResponses: Set<ServerResponse>;
  readonly discussStores: Map<string, DiscussSessionStore>;
  readonly discussRegistry: DiscussContextRegistry;
  readonly eventBus: TypedEventBus;
  readonly launchCoordinator: LaunchCoordinator;
  readonly providerRegistry: ProviderRegistry;

  // Server / transport
  readonly server: Server;

  // Service factories
  readonly getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
  readonly getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
  readonly listExecutionServices: () => ExecutionServiceLike[];
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussContext: (ctx: CallerContext) => DiscussContext;

  // Backend info / lock lifecycle hooks
  readonly acquireLockFn: (
    pluginRoot: string,
    instanceId: string,
    version: string,
    bundleHash: string,
    flavor: 'prod' | 'dev',
  ) => Promise<void>;
  readonly writeBackendInfoFn: typeof writeBackendInfo;
  readonly removeBackendInfoIfOwnerFn: typeof removeBackendInfoIfOwner;
  readonly removeLockIfOwnerFn: (pluginRoot: string, instanceId: string) => void;

  // Recovery hooks (injectable for tests)
  readonly cleanupStaleJobsFn: (currentBundleHash: string) => void;
  readonly markJobsAsErrorFn: (namespace: string, message: string) => void;
  readonly terminateAllFn: () => void;
  readonly providerHostManager: ProviderHostManager;

  // KB subsystem factory
  readonly createKbSubsystemFn: CreateKbSubsystemFn;
  readonly registerBuiltInProvidersFn: RegisterBuiltInProvidersFn;
  readonly recoverPersistedDiscussFn: RecoverPersistedDiscussFn;

  // Transport hooks
  readonly closeServerFn: (server: Server) => Promise<void>;
  readonly listenFn: (server: Server) => Promise<{ port: number; host: string }>;

  // Lifecycle callbacks
  readonly onStopped?: () => void;
  readonly onFatalShutdownError?: (error: unknown) => void;
};

// ---------------------------------------------------------------------------
// createLifecycle — lifecycle state machine
// ---------------------------------------------------------------------------

export type LifecycleController = {
  start(): Promise<BackendServerInfo>;
  shutdown(reason: string): Promise<void>;
  waitForShutdown(): Promise<void>;
  /** Exposes the transient recovery registry so the composition root can wire abort/scope-check fallbacks. */
  getRecoveryRegistry(): RecoveryRegistry | null;
};

export function createLifecycle(deps: LifecycleDeps): LifecycleController {
  const {
    identity,
    runtime,
    backendPid,
    runtimeState,
    idleTimer,
    progressStore,
    sessionIndex,
    streamResponses,
    discussStores,
    discussRegistry,
    eventBus,
    launchCoordinator,
    providerRegistry,
    server,
    getRecoveryService,
    getDiscussStoreForSource,
    knownDiscussSources,
    getDiscussContext,
    acquireLockFn,
    writeBackendInfoFn,
    removeBackendInfoIfOwnerFn,
    removeLockIfOwnerFn,
    cleanupStaleJobsFn,
    markJobsAsErrorFn,
    terminateAllFn,
    providerHostManager,
    createKbSubsystemFn,
    registerBuiltInProvidersFn,
    recoverPersistedDiscussFn,
    closeServerFn,
    listenFn,
    onStopped,
    onFatalShutdownError,
  } = deps;

  const { pluginRoot, namespace, version, bundleHash, flavor, instanceId, now, log } = identity;

  let shutdownPromise: Promise<void> | null = null;
  let started = false;
  let sessionIndexSubscribed = false;
  let recoveryRegistry: RecoveryRegistry | null = null;
  let ownershipCheckerInterval: ReturnType<Runtime['time']['setInterval']> | null = null;
  const adoptedRunningPids = new Map<string, { pid: number; pool: string }>();
  const recoveryPollIntervals = new Set<ReturnType<Runtime['time']['setInterval']>>();

  // -- Session index subscription -------------------------------------------

  const onSessionIndexUpdated = (payload: EventBusEvents['session:updated']): void => {
    if (!sessionIndex.hasShard(payload.shardHash)) {
      sessionIndex.discoverShard(payload.shardHash);
    }
    sessionIndex.invalidate(payload.shardHash, payload.sessionId);
  };

  function createCallerContext(projectRoot: string): CallerContext {
    return { projectRoot, pluginRoot, coralEnv: {} };
  }

  function subscribeSessionIndex(): void {
    if (sessionIndexSubscribed) return;
    eventBus.on('session:updated', onSessionIndexUpdated);
    sessionIndexSubscribed = true;
  }

  function unsubscribeSessionIndex(): void {
    if (!sessionIndexSubscribed) return;
    eventBus.off('session:updated', onSessionIndexUpdated);
    sessionIndexSubscribed = false;
  }

  async function finalizeLiveAppServerJobsForHandoff(): Promise<void> {
    for (const status of listLiveJobs(progressStore, namespace)) {
      const launchRecord = progressStore.readLaunchRecord(status.jobId);
      const runtimeRecord = progressStore.readRuntimeRecord(status.jobId);
      if (!launchRecord || !isAppServerRuntime(runtimeRecord)) {
        continue;
      }

      try {
        const ctx: CallerContext = { projectRoot: launchRecord.projectRoot, pluginRoot, coralEnv: {} };
        const service = getRecoveryService(ctx);
        await service.finalizeInterruptedAppServerJob(launchRecord, runtimeRecord, { reason: 'handoff' });
        log(`Finalized interrupted app-server job during handoff: ${status.jobId}\n`);
      } catch (error: unknown) {
        log(`Failed to finalize interrupted app-server job ${status.jobId} during handoff: ${formatError(error)}\n`);
      }
    }

    try {
      await providerHostManager.drainForHandoff();
    } catch (error: unknown) {
      log(`Failed to drain provider servers during handoff: ${formatError(error)}\n`);
    }
  }

  function buildRecoverySnapshot(
    progressStore: ProgressStore,
    namespace: string,
    eventBus: TypedEventBus,
  ): JobStoreSnapshot {
    const jobIds = Object.freeze([...progressStore.listJobIds()]);
    const hasLaunchByJob = new Map<string, boolean>();
    const hasRuntimeByJob = new Map<string, boolean>();
    const hasExitByJob = new Map<string, boolean>();
    const statusesByJob = new Map<string, PersistedStatusRecord | null>();
    const launchesByJob = new Map<string, PersistedLaunchRecord | null>();
    const runtimesByJob = new Map<string, PersistedRuntimeRecord | null>();
    const exitsByJob = new Map<string, PersistedExitRecord | null>();
    const terminalPayloadsByJob = new Map<string, TerminalResult | null>();

    for (const jobId of jobIds) {
      let status = progressStore.readStatus(jobId);
      if (status && isLivePhase(status.phase) && readBackendNamespace(status) === null) {
        status = withBackendNamespace(status, namespace);
        progressStore.writeStatus(jobId, status);
      }

      hasLaunchByJob.set(jobId, progressStore.hasLaunchRecord(jobId));
      hasRuntimeByJob.set(jobId, progressStore.hasRuntimeRecord(jobId));
      hasExitByJob.set(jobId, progressStore.hasExitRecord(jobId));
      statusesByJob.set(jobId, status);
      launchesByJob.set(jobId, progressStore.readLaunchRecord(jobId));
      runtimesByJob.set(jobId, progressStore.readRuntimeRecord(jobId));
      exitsByJob.set(jobId, progressStore.readExitRecord(jobId));
      terminalPayloadsByJob.set(jobId, progressStore.readTerminalPayload(jobId));
    }

    const sessionRefs: Array<{ shardDir: string; sessionId: string; provider: string }> = [];
    const sessionsByRef = new Map<string, SessionEntry | null>();
    const sessionKey = (shardDir: string, provider: string, sessionId: string): string =>
      `${shardDir}\u0000${provider}\u0000${sessionId}`;

    for (const shardDir of listSessionShards(runtime)) {
      try {
        const sessionManager = SessionManager.openShard(shardDir, runtime, eventBus);
        for (const sessionRef of readSessionRefs(shardDir, runtime.storage)) {
          try {
            sessionRefs.push({ shardDir, ...sessionRef });
            sessionsByRef.set(
              sessionKey(shardDir, sessionRef.provider, sessionRef.sessionId),
              sessionManager.get(sessionRef.provider, sessionRef.sessionId),
            );
          } catch (error: unknown) {
            log(`Failed to check session ${sessionRef.sessionId}: ${formatError(error)}\n`);
          }
        }
      } catch (error: unknown) {
        log(`Failed to scan session shard ${shardDir}: ${formatError(error)}\n`);
      }
    }

    const snapshot: JobStoreSnapshot = {
      jobIds,
      currentNamespace: namespace,
      hasLaunch: (jobId: string): boolean => hasLaunchByJob.get(jobId) === true,
      hasRuntime: (jobId: string): boolean => hasRuntimeByJob.get(jobId) === true,
      hasExit: (jobId: string): boolean => hasExitByJob.get(jobId) === true,
      readStatus: (jobId: string): PersistedStatusRecord | null => statusesByJob.get(jobId) ?? null,
      readLaunch: (jobId: string): PersistedLaunchRecord | null => launchesByJob.get(jobId) ?? null,
      readRuntime: (jobId: string): PersistedRuntimeRecord | null => runtimesByJob.get(jobId) ?? null,
      readExit: (jobId: string): PersistedExitRecord | null => exitsByJob.get(jobId) ?? null,
      readTerminalPayload: (jobId: string): TerminalResult | null => terminalPayloadsByJob.get(jobId) ?? null,
      listSessionRefs: (): Array<{ shardDir: string; sessionId: string; provider: string }> => [...sessionRefs],
      readSession: (shardDir: string, provider: string, sessionId: string): SessionEntry | null =>
        sessionsByRef.get(sessionKey(shardDir, provider, sessionId)) ?? null,
    };

    return Object.freeze(snapshot);
  }

  function applyRecoveryAction(
    action: RecoveryAction,
    progressStore: ProgressStore,
    recoveryRegistry: RecoveryRegistry,
    queuedRecoverable: Array<{ jobId: string; launchRecord: PersistedLaunchRecord }>,
    runningRecoverable: Array<{
      jobId: string;
      launchRecord: PersistedLaunchRecord;
      runtimeRecord: PersistedRuntimeRecord;
    }>,
    log: (message: string) => void,
    eventBus: TypedEventBus,
  ): void {
    switch (action.type) {
      case 'deleteIncompleteDir':
        runtime.storage.rmSync(progressStore.jobDir(action.jobId), { recursive: true, force: true });
        log(`Deleted incomplete admission: ${action.jobId}\n`);
        return;
      case 'markError': {
        markJobAsError(progressStore, action.status, action.notice, log);
        new SessionManager(action.status.projectRoot, runtime, eventBus).releaseJob(action.status.sessionId, action.status.jobId);
        if (action.notice === OLD_FORMAT_NOTICE) {
          log(`Marked incompatible old-format job: ${action.jobId}\n`);
        } else if (action.notice === GHOST_LAUNCH_NOTICE) {
          log(`Marked ghost launch job: ${action.jobId}\n`);
        } else {
          log(`Marked recovery job as error: ${action.jobId}\n`);
        }
        return;
      }
      case 'registerQueued':
        recoveryRegistry.register(action.jobId, action.launchRecord);
        queuedRecoverable.push({ jobId: action.jobId, launchRecord: action.launchRecord });
        return;
      case 'registerRunning':
        if (isAppServerRuntime(action.runtimeRecord)) {
          const runtimeRecord = action.runtimeRecord;
          recoveryRegistry.register(action.jobId, action.launchRecord, action.runtimeRecord, () => {
            const ctx: CallerContext = { projectRoot: action.launchRecord.projectRoot, pluginRoot, coralEnv: {} };
            const service = getRecoveryService(ctx);
            void service.interruptAppServerJob(action.launchRecord, runtimeRecord).catch((error: unknown) => {
              log(`Failed to interrupt recovered app-server job ${action.jobId}: ${formatError(error)}\n`);
            });
          });
        } else {
          recoveryRegistry.register(action.jobId, action.launchRecord, action.runtimeRecord);
        }
        runningRecoverable.push({
          jobId: action.jobId,
          launchRecord: action.launchRecord,
          runtimeRecord: action.runtimeRecord,
        });
        return;
      case 'releaseSessionClaim': {
        SessionManager.openShard(action.shardDir, runtime, eventBus).releaseJob(action.sessionId, action.jobId);
        const status = progressStore.readStatus(action.jobId);
        if (status && isTerminalPhase(status.phase)) {
          log(`Released terminal session claim: ${action.sessionId}\n`);
        } else {
          log(`Released orphaned session claim: ${action.sessionId}\n`);
        }
        return;
      }
    }
  }

  function logRecoveryActionFailure(action: RecoveryAction, error: unknown, log: (message: string) => void): void {
    switch (action.type) {
      case 'deleteIncompleteDir':
        log(`Failed to delete incomplete admission ${action.jobId}: ${formatError(error)}\n`);
        return;
      case 'markError':
        if (action.notice === OLD_FORMAT_NOTICE) {
          log(`Failed to handle incompatible job ${action.jobId}: ${formatError(error)}\n`);
        } else if (action.notice === GHOST_LAUNCH_NOTICE) {
          log(`Failed to handle ghost launch job ${action.jobId}: ${formatError(error)}\n`);
        } else {
          log(`Failed to handle recovery error-mark job ${action.jobId}: ${formatError(error)}\n`);
        }
        return;
      case 'registerQueued':
        log(`Failed to register queued recovery job ${action.jobId}: ${formatError(error)}\n`);
        return;
      case 'registerRunning':
        log(`Failed to register running recovery job ${action.jobId}: ${formatError(error)}\n`);
        return;
      case 'releaseSessionClaim':
        log(`Failed to release session claim ${action.sessionId}: ${formatError(error)}\n`);
        return;
    }
  }

  // -- Recovery adoption ----------------------------------------------------

  async function runRecoveryAdoption(
    queuedJobs: Array<{ jobId: string; launchRecord: PersistedLaunchRecord }>,
    runningJobs: Array<{ jobId: string; launchRecord: PersistedLaunchRecord; runtimeRecord: PersistedRuntimeRecord }>,
    assertStartupStillActive: () => void,
  ): Promise<void> {
    // Sort queued jobs by enqueue sequence for FIFO ordering
    queuedJobs.sort((a, b) => a.launchRecord.enqueueSequence - b.launchRecord.enqueueSequence);

    // Seed counter from max recovered value to prevent ordering collision with new jobs
    const allRecoverableSeqs = [...queuedJobs, ...runningJobs].map((j) => j.launchRecord.enqueueSequence);
    if (allRecoverableSeqs.length > 0) {
      progressStore.seedEnqueueSequence(Math.max(...allRecoverableSeqs));
    }

    // Adopt running jobs first — restore their active permits before fence lifts
    for (const { jobId, launchRecord, runtimeRecord } of runningJobs) {
      let cleanup: (() => void) | null = null;
      try {
        const ctx: CallerContext = { projectRoot: launchRecord.projectRoot, pluginRoot, coralEnv: {} };
        const service = getRecoveryService(ctx);
        const provider = providerRegistry.get(launchRecord.provider);
        const recovery = provider?.recovery;
        if (isAppServerRuntime(runtimeRecord)) {
          assertStartupStillActive();
          await service.finalizeInterruptedAppServerJob(launchRecord, runtimeRecord, { reason: 'restart' });
          assertStartupStillActive();
          recoveryRegistry?.remove(jobId);
          log(`Recovered interrupted app-server job: ${jobId}\n`);
          continue;
        }

        let adoptedRuntimeRecord = runtimeRecord;
        assertStartupStillActive();
        ({ cleanup } = service.adoptRunningJob(launchRecord, runtimeRecord));
        assertStartupStillActive();

        // Track adopted PID
        adoptedRunningPids.set(jobId, { pid: runtimeRecord.pid, pool: launchRecord.pool });

        const drainRecoveredProgress = (): void => {
          if (!recovery?.extractProgress) {
            return;
          }

          try {
            const { messages, newOffset } = recovery.extractProgress({
              stdoutPath: adoptedRuntimeRecord.stdoutPath,
              fromOffset: adoptedRuntimeRecord.tailWatermark ?? 0,
              providerMeta: adoptedRuntimeRecord.providerMeta,
            });

            if (newOffset !== (adoptedRuntimeRecord.tailWatermark ?? 0)) {
              adoptedRuntimeRecord = { ...adoptedRuntimeRecord, tailWatermark: newOffset };
              progressStore.writeRuntimeRecord(jobId, adoptedRuntimeRecord);
            }

            if (messages.length === 0) {
              return;
            }

            const status = progressStore.readStatus(jobId);
            if (status && !isTerminalPhase(status.phase) && status.launch.state !== 'ready') {
              progressStore.updateLaunchState(jobId, 'ready');
              progressStore.updatePhase(jobId, 'running');
            }

            for (const message of messages) {
              progressStore.appendProgress(jobId, launchRecord.sessionId, message);
            }
          } catch (err) {
            log(`Failed to tail recovered progress for job ${jobId}: ${formatError(err)}\n`);
          }
        };

        // Install PID poller to detect termination
        const pollInterval = runtime.time.setInterval(() => {
          drainRecoveredProgress();

          const alive = runtime.process.isAlive(runtimeRecord.pid);

          if (!alive) {
            runtime.time.clearInterval(pollInterval);
            recoveryPollIntervals.delete(pollInterval);
            adoptedRunningPids.delete(jobId);

            const exitRecord = progressStore.readExitRecord(jobId);
            if (exitRecord) {
              drainRecoveredProgress();

              // Finalize from durable artifacts via provider recovery
              if (provider?.recovery) {
                void provider.recovery
                  .finalizeFromArtifacts({
                    stdoutPath: runtimeRecord.stdoutPath,
                    stderrPath: runtimeRecord.stderrPath,
                    exitCode: exitRecord.exitCode,
                    signal: exitRecord.signal,
                    fallbackConversationRef: launchRecord.request.conversationRef,
                  })
                  .then((result) => {
                    const phase = result.aborted ? ('aborted' as const) : ('completed' as const);
                    service.completeRecoveredJob(
                      jobId,
                      launchRecord.sessionId,
                      {
                        content: result.content,
                        durationMs: result.durationMs,
                        aborted: result.aborted,
                        nonResumable: result.nonResumable,
                        exitCode: result.exitCode,
                        notice: result.notice,
                        errors: result.errors,
                        warnings: result.warnings,
                        usage: result.usage,
                      },
                      phase,
                      {
                        conversationRef: result.conversationRef,
                        nonResumable: result.nonResumable,
                      },
                    );
                  })
                  .catch((recoverErr: unknown) => {
                    log(`Provider recovery failed for job ${jobId}: ${formatError(recoverErr)}\n`);
                    service.completeRecoveredJob(
                      jobId,
                      launchRecord.sessionId,
                      {
                        content: '',
                        notice: `Provider recovery failed: ${formatError(recoverErr)}`,
                      },
                      'error',
                    );
                  });
              } else {
                const persistedPayload = progressStore.readTerminalPayload(jobId);
                if (persistedPayload !== null) {
                  const phase: 'aborted' | 'completed' | 'error' =
                    persistedPayload.aborted === true ? 'aborted' : exitRecord.exitCode === 0 ? 'completed' : 'error';
                  const payload: TerminalResult =
                    persistedPayload.exitCode === undefined
                      ? { ...persistedPayload, exitCode: exitRecord.exitCode }
                      : persistedPayload;
                  // NOTE: `conversationRef` is deliberately omitted. `TerminalResult`
                  // has no `conversationRef` channel, and `completeRecoveredJob`
                  // treats `{ conversationRef? | nonResumable? }` as mutually exclusive.
                  service.completeRecoveredJob(jobId, launchRecord.sessionId, payload, phase, {
                    nonResumable: persistedPayload.nonResumable === true,
                  });
                } else {
                  service.completeRecoveredJob(
                    jobId,
                    launchRecord.sessionId,
                    {
                      content: '',
                      exitCode: exitRecord.exitCode,
                    },
                    exitRecord.exitCode === 0 ? 'completed' : 'error',
                  );
                }
              }
            } else {
              // PID dead + no exit.json = wrapper lost
              service.completeRecoveredJob(
                jobId,
                launchRecord.sessionId,
                {
                  content: '',
                  notice: 'Wrapper process lost — no exit.json found',
                },
                'error',
              );
            }

            cleanup?.();
          }
        }, RECOVERY_POLL_MS);
        pollInterval.unref?.();
        recoveryPollIntervals.add(pollInterval);

        recoveryRegistry?.remove(jobId);
        log(`Adopted running job: ${jobId} (pid=${runtimeRecord.pid})\n`);
      } catch (err) {
        if (err instanceof StartupInterruptedError) {
          cleanup?.();
          throw err;
        }
        log(`Failed to adopt running job ${jobId}: ${formatError(err)}\n`);
        recoveryRegistry?.remove(jobId);
      }
    }

    // Recover queued jobs in FIFO order
    for (const { jobId, launchRecord } of queuedJobs) {
      try {
        const ctx: CallerContext = { projectRoot: launchRecord.projectRoot, pluginRoot, coralEnv: {} };
        const service = getRecoveryService(ctx);
        assertStartupStillActive();
        service.recoverQueuedJob(launchRecord);
        recoveryRegistry?.remove(jobId);
        log(`Recovered queued job: ${jobId}\n`);
      } catch (err) {
        if (err instanceof StartupInterruptedError) throw err;
        log(`Failed to recover queued job ${jobId}: ${formatError(err)}\n`);
        recoveryRegistry?.remove(jobId);
      }
    }

    // All entries migrated — dissolve registry and lift launch fence
    assertStartupStillActive();
    recoveryRegistry = null;
    runtimeState.setLaunchFenceActive(false);
    log(`Recovery adoption complete. Launch fence lifted.\n`);
  }

  // -- shutdown -------------------------------------------------------------

  async function shutdown(reason: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      if (runtimeState.getLifecycle() === 'stopped') return;

      const mode = shutdownModeFromReason(reason);
      const discussSourcesAtShutdown = mode === 'hard' ? [...knownDiscussSources()] : [];
      const drainTimeout = mode === 'handoff' ? HANDOFF_DRAIN_TIMEOUT_MS : SHUTDOWN_DRAIN_TIMEOUT_MS;

      log(`Coral backend shutting down (${reason}, mode=${mode})...\n`);
      runtimeState.setLifecycle('draining');
      idleTimer.stopWatching();

      const serverClosed = closeServerFn(server);
      await waitForInflightDrain(idleTimer, drainTimeout, runtime.time);
      server.closeAllConnections?.();
      for (const stream of streamResponses) {
        stream.end();
      }
      await Promise.race([serverClosed, runtime.time.sleep(drainTimeout)]);

      if (mode === 'hard') {
        markJobsAsErrorFn(namespace, 'Backend shutting down');
        await providerHostManager.shutdown();
        terminateAllFn();
      } else {
        await finalizeLiveAppServerJobsForHandoff();
      }
      // handoff mode: detached durable wrappers continue for replacement recovery,
      // while app-server jobs are terminalized locally before provider-server drain.

      for (const interval of recoveryPollIntervals) runtime.time.clearInterval(interval);
      recoveryPollIntervals.clear();
      if (ownershipCheckerInterval) {
        runtime.time.clearInterval(ownershipCheckerInterval);
        ownershipCheckerInterval = null;
      }
      await Promise.race([
        runtimeState.getKbSubsystem()?.curateScheduler.stop?.(),
        runtime.time.sleep(5_000),
      ]);
      await runtimeState.getKbSubsystem()?.kb.closeVectorStores().catch((e: unknown) => { backendLog.warn(`closeVectorStores failed during shutdown: ${errorMessage(e)}`); });
      await clearAllDiscuss(discussRegistry, mode, discussOperations.persistAbortEndForShutdown);
      if (mode === 'hard') {
        await discussOperations.persistAbortEndForPersistedShutdownCandidates(
          discussSourcesAtShutdown,
          getDiscussStoreForSource,
          (snapshot) =>
            getDiscussContext({
              projectRoot: snapshot.projectRoot,
              pluginRoot,
              coralEnv: {},
            }),
        );
        discussRegistry.contexts.clear();
      }
      unsubscribeSessionIndex();
      for (const store of discussStores.values()) {
        store.dispose();
      }
    })()
      .catch((error) => {
        onFatalShutdownError?.(error);
        throw error;
      })
      .finally(() => {
        runtimeState.setLifecycle('stopped');
        removeBackendInfoIfOwnerFn(pluginRoot, instanceId);
        removeLockIfOwnerFn(pluginRoot, instanceId);
        onStopped?.();
      });

    return shutdownPromise;
  }

  // -- start ----------------------------------------------------------------

  async function start(): Promise<BackendServerInfo> {
    if (started || runtimeState.getLifecycle() !== 'starting') {
      throw new Error('Backend server already started');
    }

    const assertStartupStillActive = (): void => {
      if (shutdownPromise !== null || runtimeState.getLifecycle() !== 'starting') {
        throw new StartupInterruptedError();
      }
    };

    try {
      await acquireLockFn(pluginRoot, instanceId, version, bundleHash, flavor);
      assertStartupStillActive();
      registerBuiltInProvidersFn(providerRegistry);
      try {
        const kbSub = await createKbSubsystemFn({
          pluginRoot,
          spawnCli: launchCoordinator.spawnCli.bind(launchCoordinator),
        });
        runtimeState.setKbSubsystem(kbSub);
      } catch (error: unknown) {
        const msg = errorMessage(error);
        backendLog.error('KB subsystem failed to initialize — running in degraded mode', error);
        runtimeState.setKbInitError(msg);
      }
      assertStartupStillActive();
      subscribeSessionIndex();
      sessionIndex.hydrate(listSessionShards(runtime));

      // Listen first so we're reachable during recovery
      const { port, host } = await listenFn(server);
      assertStartupStillActive();
      runtimeState.setStartedAt(now());

      // Scan recoverable jobs and install recovery registry + launch fence
      runtimeState.setLaunchFenceActive(true);
      recoveryRegistry = new RecoveryRegistry(runtime.process);
      const queuedRecoverable: Array<{ jobId: string; launchRecord: PersistedLaunchRecord }> = [];
      const runningRecoverable: Array<{
        jobId: string;
        launchRecord: PersistedLaunchRecord;
        runtimeRecord: PersistedRuntimeRecord;
      }> = [];
      const snapshot = buildRecoverySnapshot(progressStore, namespace, eventBus);
      const invariants: RecoveryInvariants = {
        peerDaemonAlive: false,
        kbInitialized: true,
      };
      const plan = planRecovery(snapshot, invariants);

      for (const action of plan.register) {
        try {
          applyRecoveryAction(
            action,
            progressStore,
            recoveryRegistry,
            queuedRecoverable,
            runningRecoverable,
            log,
            eventBus,
          );
        } catch (error: unknown) {
          logRecoveryActionFailure(action, error, log);
        }
      }

      for (const action of plan.cleanup) {
        try {
          applyRecoveryAction(
            action,
            progressStore,
            recoveryRegistry,
            queuedRecoverable,
            runningRecoverable,
            log,
            eventBus,
          );
        } catch (error: unknown) {
          logRecoveryActionFailure(action, error, log);
        }
      }

      // Cleanup stale terminal jobs (old terminal data from previous bundle hashes)
      cleanupStaleJobsFn(bundleHash);

      const recoveredDiscussResumes = await recoverPersistedDiscussFn({
        knownDiscussSources,
        getDiscussStoreForSource,
        getDiscussContext,
        createCallerContext,
        assertStartupStillActive,
      });

      if (queuedRecoverable.length > 0 || runningRecoverable.length > 0) {
        try {
          await runRecoveryAdoption(queuedRecoverable, runningRecoverable, assertStartupStillActive);
        } catch (err) {
          if (err instanceof StartupInterruptedError) {
            throw err;
          }
          log(`Recovery adoption failed: ${formatError(err)}\n`);
          const allRecoverable = [...queuedRecoverable, ...runningRecoverable];
          for (const { jobId } of allRecoverable) {
            try {
              const status = progressStore.readStatus(jobId);
              if (status) markJobAsError(progressStore, status, `Recovery adoption failed: ${formatError(err)}`, log);
            } catch {
              /* best-effort */
            }
          }
          recoveryRegistry = null;
          runtimeState.setLaunchFenceActive(false);
        }
      } else {
        recoveryRegistry = null;
        runtimeState.setLaunchFenceActive(false);
      }

      assertStartupStillActive();
      const startedAt = runtimeState.getStartedAt();
      writeBackendInfoFn(pluginRoot, {
        pid: backendPid,
        port,
        host,
        token: identity.token,
        version,
        bundleHash,
        flavor,
        namespace,
        instanceId,
        startedAt,
      });

      runtimeState.setLifecycle('running');
      started = true;

      // Idle timer with namespace-based counting
      idleTimer.startWatching(
        () =>
          runtimeState.getLifecycle() === 'running' &&
          launchCoordinator.active === 0 &&
          adoptedRunningPids.size === 0 &&
          progressStore.liveJobCountByNamespace(namespace) === 0 &&
          idleTimer.inflightRequests === 0 &&
          (recoveryRegistry === null || recoveryRegistry.size === 0) &&
          !hasRunningSessions(discussRegistry) &&
          !(runtimeState.getKbSubsystem()?.curateScheduler.isRunning() ?? false),
        (reason) => {
          void shutdown(reason).catch(() => {});
        },
      );

      // Self-terminate if another backend replaces this one (backend-info.json
      // will point to the replacement's instanceId). Covers the case where
      // ensureBackend's shutdown request is lost during rapid rebuild cycles.
      ownershipCheckerInterval = runtime.time.setInterval(() => {
        if (runtimeState.getLifecycle() !== 'running' || idleTimer.isDraining) return;
        try {
          const current = readBackendInfo(pluginRoot, runtime);
          // null means backend.json was deleted (replacement) or corrupt — drain either way
          if (current?.instanceId !== instanceId) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- always set: callback runs inside the setInterval that assigned it
            runtime.time.clearInterval(ownershipCheckerInterval!);
            ownershipCheckerInterval = null;
            idleTimer.requestDrain('replaced');
          }
        } catch {
          // read failure — skip this check
        }
      }, 30_000);
      ownershipCheckerInterval.unref?.();

      for (const recovered of recoveredDiscussResumes) {
        try {
          discussLoop.resumeLoop(recovered.ctx, recovered.sessionId, recovered.callerCtx);
        } catch (err) {
          backendLog.warn(`Discuss resume failed for session ${recovered.sessionId}: ${errorMessage(err)}`);
        }
      }

      return {
        port,
        host,
        token: identity.token,
        version,
        bundleHash,
        flavor,
        namespace,
        instanceId,
        startedAt,
      };
    } catch (error: unknown) {
      if (error instanceof StartupInterruptedError && shutdownPromise !== null) {
        await shutdownPromise;
        throw error;
      }

      runtimeState.setLifecycle('stopped');
      idleTimer.stopWatching();
      unsubscribeSessionIndex();

      try {
        await closeServerFn(server);
      } catch {
        /* best effort */
      }
      removeBackendInfoIfOwnerFn(pluginRoot, instanceId);
      removeLockIfOwnerFn(pluginRoot, instanceId);

      throw error;
    }
  }

  return {
    start,
    shutdown,
    waitForShutdown: () => shutdownPromise ?? Promise.resolve(),
    getRecoveryRegistry: () => recoveryRegistry,
  };
}
