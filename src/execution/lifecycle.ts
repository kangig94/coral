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
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatError, isNoEntryError, isRecord } from '../shared/mcp-utils.js';
import { kbRoot } from '../infra/paths.js';
import { activeChildren as activeCliChildren, spawnCli } from './engine.js';
import { readBackendInfo, type writeBackendInfo, type removeBackendInfoIfOwner } from '../infra/backend-info.js';
import { RecoveryRegistry } from './recovery-registry.js';
import { eventBus, type EventBusEvents } from './event-bus.js';
import type { IdleTimer } from './idle-timer.js';
import type { ProgressStore } from './progress-store.js';
import type { CallerContext } from './request-context.js';
import type { SessionIndex } from './session-index.js';
import { SessionManager } from './session-manager.js';
import type { DiscussContext } from './discuss/context.js';
import type { DiscussSessionStore } from './discuss/session-store.js';
import { clearAllDiscuss, hasRunningSessions, type DiscussContextRegistry } from './discuss/context-registry.js';
import * as discussLoop from './discuss/loop.js';
import * as discussOperations from './discuss/operations.js';
import type { removeLockIfOwner } from './backend-lock.js';
import { getNewProvider } from '../providers/registry.js';
import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { type ExecutionService as DefaultExecutionService } from './service.js';
import {
  isAppServerRuntime,
  belongsToNamespace,
  isDurableCliRuntime,
  isLivePhase,
  isTerminalPhase,
  readBackendNamespace,
  type PersistedLaunchRecord,
  type PersistedRuntimeRecord,
  type PersistedStatusRecord,
  type TerminalResult,
} from '../shared/types.js';
import { createCurateScheduler } from '../kb/curate.js';
import { kbRuntimeDir } from '../kb/paths.js';
import { createKbRuntime } from '../kb/runtime.js';
import type { BackendIdentity, MutableBackendRuntimeState } from './backend-contracts.js';
import type { CreateKbSubsystemFn, ExecutionServiceLike, KbSubsystem } from './tool-router.js';
import type { BackendServerInfo } from './server.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
export const HANDOFF_DRAIN_TIMEOUT_MS = 30_000;
export const SHUTDOWN_POLL_MS = 50;
export const RECOVERY_POLL_MS = 500;
export const ORPHANED_JOB_NOTICE = 'Unclean shutdown - orphaned job';
export const OLD_FORMAT_NOTICE =
  'Incompatible job format — missing durable launch record. Job predates the handoff recovery system.';
export const GHOST_LAUNCH_NOTICE =
  'Launch record exists but runtime.json was never written. The durable wrapper did not start successfully.';

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

export type RecoveryClass =
  | 'incompatible'
  | 'queued'
  | 'running'
  | 'terminal'
  | 'incomplete'
  | 'stale_dead'
  | 'stale_running'
  | null;

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

export function waitForInflightDrain(idleTimer: IdleTimer, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      if (idleTimer.inflightRequests === 0 || Date.now() >= deadline) {
        clearInterval(interval);
        resolve();
      }
    };

    const interval = setInterval(check, SHUTDOWN_POLL_MS);
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

export function hasJobDir(progressStore: ProgressStore, jobId: string): boolean {
  try {
    statSync(progressStore.jobDir(jobId));
    return true;
  } catch (error: unknown) {
    if (isNoEntryError(error)) return false;
    throw error;
  }
}

export function readSessionRefs(shardDir: string): Array<{ sessionId: string; provider: string }> {
  try {
    return readdirSync(shardDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .flatMap((entry) => {
        try {
          const raw = readFileSync(join(shardDir, entry.name), 'utf-8');
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

/**
 * Classify a job for recovery purposes.
 * - 'incompatible': live phase but missing launch.json (predates durable snapshot system)
 * - 'terminal': already finished, no recovery needed
 * - 'incomplete': launch.json exists but no status record (partial admission)
 * - 'queued': launch.json exists, phase is queued, no runtime.json yet
 * - 'running': launch.json + runtime.json exist, phase is running/launching, process may be alive
 * - 'stale_dead': like running but exit.json already written (process exited uncleanly)
 * - 'stale_running': launch.json exists, phase is launching/running, but runtime.json was never written
 * - null: unrecognized state
 */
export function classifyRecoverableJob(progressStore: ProgressStore, jobId: string): RecoveryClass {
  const status = progressStore.readStatus(jobId);
  const hasLaunch = progressStore.hasLaunchRecord(jobId);

  // Incomplete admission: launch.json exists but no status.json (crash between writes)
  if (!status) return hasLaunch ? 'incomplete' : null;

  const hasRuntime = progressStore.hasRuntimeRecord(jobId);
  const hasExit = progressStore.hasExitRecord(jobId);

  // Terminal jobs need no recovery
  if (isTerminalPhase(status.phase)) return 'terminal';

  // Incompatible old-format: live phase but no launch.json
  if (isLivePhase(status.phase) && !hasLaunch) return 'incompatible';

  // Queued recoverable: launch.json exists, phase is queued, no runtime.json
  if (hasLaunch && status.phase === 'queued' && !hasRuntime) return 'queued';

  // Ghost launch: launch.json exists, job entered a live launch phase, but wrapper never committed runtime.json
  if (hasLaunch && !hasRuntime && (status.phase === 'launching' || status.phase === 'running')) {
    return 'stale_running';
  }

  // Running recoverable: launch.json and runtime.json exist, phase is running/launching
  if (hasLaunch && hasRuntime && (status.phase === 'running' || status.phase === 'launching')) {
    if (hasExit) return 'stale_dead';
    return 'running';
  }

  return null;
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

export function recoverOrphanedJobs(
  progressStore: ProgressStore,
  namespace: string,
  log: (message: string) => void,
): void {
  for (const shardDir of SessionManager.listShards()) {
    try {
      const sessionManager = SessionManager.openShard(shardDir);
      for (const sessionRef of readSessionRefs(shardDir)) {
        try {
          const session = sessionManager.get(sessionRef.provider, sessionRef.sessionId);
          if (!session?.activeJobId) continue;
          if (hasJobDir(progressStore, session.activeJobId)) continue;
          sessionManager.releaseJob(session.sessionId, session.activeJobId);
          log(`Recovered orphaned session claim: ${session.sessionId}\n`);
        } catch (err) {
          log(`Failed to recover orphaned session ${sessionRef.sessionId}: ${formatError(err)}\n`);
        }
      }
    } catch (err) {
      log(`Failed to scan session shard ${shardDir}: ${formatError(err)}\n`);
    }
  }

  for (const status of listLiveJobs(progressStore, namespace)) {
    try {
      const notice = progressStore.hasLaunchRecord(status.jobId) ? ORPHANED_JOB_NOTICE : OLD_FORMAT_NOTICE;
      markJobAsError(progressStore, status, notice, log);
      const sessionManager = new SessionManager(status.projectRoot);
      sessionManager.releaseJob(status.sessionId, status.jobId);
      log(`Recovered orphaned job: ${status.jobId}\n`);
    } catch (err) {
      log(`Failed to recover orphaned job ${status.jobId}: ${formatError(err)}\n`);
    }
  }
}

export function cleanupStaleJobs(
  progressStore: ProgressStore,
  currentBundleHash: string,
  log: (message: string) => void,
): void {
  for (const jobId of progressStore.listJobIds()) {
    const status = progressStore.readStatus(jobId);
    if (!status) continue;
    if (!isTerminalPhase(status.phase)) continue;
    if (!status.bundleHash || status.bundleHash === currentBundleHash) continue;

    try {
      rmSync(progressStore.jobDir(jobId), { recursive: true, force: true });
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
  spawnCli: typeof spawnCli;
}): Promise<KbSubsystem> {
  const kb = createKbRuntime({
    markdownRoot: kbRoot(),
    runtimeDir: kbRuntimeDir(),
  });
  await kb.initAdapter(pluginRoot);

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
export function resolveClientHost(bindHost: string): string {
  const override = process.env.CORAL_BACKEND_ADVERTISE_HOST;
  const host = override ?? (bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost === '::' ? '::1' : bindHost);
  return host.includes(':') ? `[${host}]` : host;
}

export async function listen(server: Server, bindHost: string): Promise<{ port: number; host: string }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, bindHost, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Backend server failed to bind to a TCP port'));
        return;
      }
      resolve({ port: address.port, host: resolveClientHost(bindHost) });
    });
  });
}

// ---------------------------------------------------------------------------
// LifecycleDeps — everything the lifecycle module needs
// ---------------------------------------------------------------------------

export type LifecycleDeps = {
  // Identity / config
  readonly identity: BackendIdentity;

  // Shared mutable runtime state
  readonly runtimeState: MutableBackendRuntimeState;

  // Runtime services (reference-identical with httpHandlerDeps)
  readonly idleTimer: IdleTimer;
  readonly progressStore: ProgressStore;
  readonly sessionIndex: SessionIndex;
  readonly streamResponses: Set<ServerResponse>;
  readonly discussStores: Map<string, DiscussSessionStore>;
  readonly discussRegistry: DiscussContextRegistry;

  // Server / transport
  readonly server: Server;

  // Service factories (shared with HTTP handler / tool router)
  readonly getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
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
  ) => Promise<void>;
  readonly writeBackendInfoFn: typeof writeBackendInfo;
  readonly removeBackendInfoIfOwnerFn: typeof removeBackendInfoIfOwner;
  readonly removeLockIfOwnerFn: typeof removeLockIfOwner;

  // Recovery hooks (injectable for tests)
  readonly recoverOrphanedJobsFn: (namespace: string) => void;
  readonly cleanupStaleJobsFn: (currentBundleHash: string) => void;
  readonly markJobsAsErrorFn: (namespace: string, message: string) => void;
  readonly killAllChildrenFn: () => void;

  // KB subsystem factory
  readonly createKbSubsystemFn: CreateKbSubsystemFn;

  // Transport hooks
  readonly closeServerFn: (server: Server) => Promise<void>;
  readonly listenFn: (server: Server, bindHost: string) => Promise<{ port: number; host: string }>;

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
    runtimeState,
    idleTimer,
    progressStore,
    sessionIndex,
    streamResponses,
    discussStores,
    discussRegistry,
    server,
    getExecutionService,
    listExecutionServices: _listExecutionServices,
    getDiscussStoreForSource,
    knownDiscussSources,
    getDiscussContext,
    acquireLockFn,
    writeBackendInfoFn,
    removeBackendInfoIfOwnerFn,
    removeLockIfOwnerFn,
    recoverOrphanedJobsFn: _recoverOrphanedJobsFn,
    cleanupStaleJobsFn,
    markJobsAsErrorFn,
    killAllChildrenFn,
    createKbSubsystemFn,
    closeServerFn,
    listenFn,
    onStopped,
    onFatalShutdownError,
  } = deps;

  const { pluginRoot, namespace, version, bundleHash, instanceId, now, log } = identity;

  let shutdownPromise: Promise<void> | null = null;
  let started = false;
  let sessionIndexSubscribed = false;
  let recoveryRegistry: RecoveryRegistry | null = null;
  let ownershipCheckerInterval: ReturnType<typeof setInterval> | null = null;
  const adoptedRunningPids = new Map<string, { pid: number; pool: string }>();
  const recoveryPollIntervals = new Set<NodeJS.Timeout>();

  // -- Session index subscription -------------------------------------------

  const onSessionIndexUpdated = (payload: EventBusEvents['session:updated']): void => {
    if (!sessionIndex.hasShard(payload.shardHash)) {
      sessionIndex.discoverShard(payload.shardHash);
    }
    sessionIndex.invalidate(payload.shardHash, payload.sessionId);
  };

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
        const service = getExecutionService(ctx) as DefaultExecutionService;
        const provider = getNewProvider(launchRecord.provider);
        const recovery = provider?.recovery;
        // TODO(AC2-AC10): route app-server runtime recovery through transport-aware continuity handling.
        if (!isDurableCliRuntime(runtimeRecord)) {
          throw new Error(`Unsupported runtime transport for recovered job ${jobId}: ${runtimeRecord.transport}`);
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
        const pollInterval: NodeJS.Timeout = setInterval(() => {
          drainRecoveredProgress();

          let alive = false;
          try {
            process.kill(runtimeRecord.pid, 0);
            alive = true;
          } catch {
            /* pid already exited */
          }

          if (!alive) {
            clearInterval(pollInterval);
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
        const service = getExecutionService(ctx) as DefaultExecutionService;
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
      await waitForInflightDrain(idleTimer, drainTimeout);
      server.closeAllConnections?.();
      for (const stream of streamResponses) {
        stream.end();
      }
      await Promise.race([serverClosed, new Promise<void>((resolve) => setTimeout(resolve, drainTimeout))]);

      if (mode === 'hard') {
        markJobsAsErrorFn(namespace, 'Backend shutting down');
        killAllChildrenFn();
      }
      // handoff mode: detached wrappers continue, jobs remain in their current
      // phase for recovery by the replacement backend.

      for (const interval of recoveryPollIntervals) clearInterval(interval);
      recoveryPollIntervals.clear();
      if (ownershipCheckerInterval) {
        clearInterval(ownershipCheckerInterval);
        ownershipCheckerInterval = null;
      }
      await Promise.race([
        runtimeState.getKbSubsystem()?.curateScheduler.stop?.(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
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
      eventBus.removeAllListeners();

      runtimeState.setLifecycle('stopped');
      onStopped?.();
    })()
      .catch((error) => {
        onFatalShutdownError?.(error);
        throw error;
      })
      .finally(() => {
        runtimeState.setLifecycle('stopped');
        removeBackendInfoIfOwnerFn(pluginRoot, instanceId);
        removeLockIfOwnerFn(pluginRoot, instanceId);
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
      await acquireLockFn(pluginRoot, instanceId, version, bundleHash);
      assertStartupStillActive();
      registerBuiltInProviders();
      const kbSub = await createKbSubsystemFn({
        pluginRoot,
        spawnCli,
      });
      assertStartupStillActive();
      runtimeState.setKbSubsystem(kbSub);
      subscribeSessionIndex();
      sessionIndex.hydrate(SessionManager.listShards());

      // Listen first so we're reachable during recovery
      const bindHost = process.env.CORAL_BACKEND_BIND ?? '127.0.0.1';
      const { port, host } = await listenFn(server, bindHost);
      assertStartupStillActive();
      runtimeState.setStartedAt(now());

      // Scan recoverable jobs and install recovery registry + launch fence
      runtimeState.setLaunchFenceActive(true);
      recoveryRegistry = new RecoveryRegistry();
      const incompatibleJobs: PersistedStatusRecord[] = [];
      const ghostLaunchJobs: PersistedStatusRecord[] = [];
      const queuedRecoverable: Array<{ jobId: string; launchRecord: PersistedLaunchRecord }> = [];
      const runningRecoverable: Array<{
        jobId: string;
        launchRecord: PersistedLaunchRecord;
        runtimeRecord: PersistedRuntimeRecord;
      }> = [];

      for (const jobId of progressStore.listJobIds()) {
        const preStatus = progressStore.readStatus(jobId);
        if (preStatus && !belongsToNamespace(preStatus, namespace)) continue;

        const classification = classifyRecoverableJob(progressStore, jobId);
        if (classification === 'incompatible') {
          const status = progressStore.readStatus(jobId);
          if (status) incompatibleJobs.push(status);
          continue;
        }
        if (classification === 'stale_running') {
          const status = progressStore.readStatus(jobId);
          if (status) ghostLaunchJobs.push(status);
          continue;
        }
        if (classification === 'incomplete') {
          // Crash between launch.json write and status.json — delete directory
          try {
            rmSync(progressStore.jobDir(jobId), { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
          log(`Deleted incomplete admission: ${jobId}\n`);
          continue;
        }
        if (classification === 'queued') {
          const launchRecord = progressStore.readLaunchRecord(jobId);
          if (launchRecord) {
            queuedRecoverable.push({ jobId, launchRecord });
            recoveryRegistry.register(jobId, launchRecord);
          }
          continue;
        }
        if (classification === 'running' || classification === 'stale_dead') {
          const launchRecord = progressStore.readLaunchRecord(jobId);
          const runtimeRecord = progressStore.readRuntimeRecord(jobId);
          if (launchRecord && runtimeRecord) {
            runningRecoverable.push({ jobId, launchRecord, runtimeRecord });
            if (isAppServerRuntime(runtimeRecord)) {
              recoveryRegistry.register(jobId, launchRecord, runtimeRecord, () => {
                const { threadId, turnId } = runtimeRecord.providerMeta;
                if (!threadId || !turnId) {
                  return;
                }

                const ctx: CallerContext = { projectRoot: launchRecord.projectRoot, pluginRoot, coralEnv: {} };
                const service = getExecutionService(ctx) as DefaultExecutionService;
                void service.interruptAppServerJob(runtimeRecord).catch((error: unknown) => {
                  log(`Failed to interrupt recovered app-server job ${jobId}: ${formatError(error)}\n`);
                });
              });
            } else {
              recoveryRegistry.register(jobId, launchRecord, runtimeRecord);
            }
          }
          continue;
        }
        // 'terminal' or null — no action needed
      }

      // Mark incompatible old-format jobs and release their session claims
      for (const status of incompatibleJobs) {
        try {
          markJobAsError(progressStore, status, OLD_FORMAT_NOTICE, log);
          const sessionManager = new SessionManager(status.projectRoot);
          sessionManager.releaseJob(status.sessionId, status.jobId);
          log(`Marked incompatible old-format job: ${status.jobId}\n`);
        } catch (err) {
          log(`Failed to handle incompatible job ${status.jobId}: ${formatError(err)}\n`);
        }
      }

      for (const status of ghostLaunchJobs) {
        try {
          markJobAsError(progressStore, status, GHOST_LAUNCH_NOTICE, log);
          const sessionManager = new SessionManager(status.projectRoot);
          sessionManager.releaseJob(status.sessionId, status.jobId);
          log(`Marked ghost launch job: ${status.jobId}\n`);
        } catch (err) {
          log(`Failed to handle ghost launch job ${status.jobId}: ${formatError(err)}\n`);
        }
      }

      // Release terminal-but-still-claimed sessions
      for (const shardDir of SessionManager.listShards()) {
        try {
          const sessionManager = SessionManager.openShard(shardDir);
          for (const sessionRef of readSessionRefs(shardDir)) {
            try {
              const session = sessionManager.get(sessionRef.provider, sessionRef.sessionId);
              if (!session?.activeJobId) continue;
              const jobStatus = progressStore.readStatus(session.activeJobId);
              if (jobStatus && isTerminalPhase(jobStatus.phase)) {
                sessionManager.releaseJob(session.sessionId, session.activeJobId);
                log(`Released terminal session claim: ${session.sessionId}\n`);
              } else if (!hasJobDir(progressStore, session.activeJobId)) {
                sessionManager.releaseJob(session.sessionId, session.activeJobId);
                log(`Released orphaned session claim: ${session.sessionId}\n`);
              }
            } catch (err) {
              log(`Failed to check session ${sessionRef.sessionId}: ${formatError(err)}\n`);
            }
          }
        } catch (err) {
          log(`Failed to scan session shard ${shardDir}: ${formatError(err)}\n`);
        }
      }

      // Cleanup stale terminal jobs (old terminal data from previous bundle hashes)
      cleanupStaleJobsFn(bundleHash);

      const recoveredDiscussResumes: discussOperations.RecoveredDiscussResume[] = [];

      // Discuss session recovery
      for (const source of knownDiscussSources()) {
        recoveredDiscussResumes.push(
          ...(await discussOperations.recoverPersistedSessionsFromStore(
            getDiscussStoreForSource(source),
            (snapshot) =>
              getDiscussContext({
                projectRoot: snapshot.projectRoot,
                pluginRoot,
                coralEnv: {},
              }),
            (snapshot) => ({
              projectRoot: snapshot.projectRoot,
              pluginRoot,
              coralEnv: {},
            }),
          )),
        );
        assertStartupStillActive();
      }

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
        pid: process.pid,
        port,
        host,
        token: identity.token,
        version,
        bundleHash,
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
          activeCliChildren.size === 0 &&
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
      ownershipCheckerInterval = setInterval(() => {
        if (runtimeState.getLifecycle() !== 'running' || idleTimer.isDraining) return;
        try {
          const current = readBackendInfo(pluginRoot);
          // null means backend.json was deleted (replacement) or corrupt — drain either way
          if (current?.instanceId !== instanceId) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- always set: callback runs inside the setInterval that assigned it
            clearInterval(ownershipCheckerInterval!);
            ownershipCheckerInterval = null;
            idleTimer.requestDrain('replaced');
          }
        } catch {
          // read failure — skip this check
        }
      }, 30_000);
      ownershipCheckerInterval.unref();

      for (const recovered of recoveredDiscussResumes) {
        discussLoop.resumeLoop(recovered.ctx, recovered.sessionId, recovered.callerCtx);
      }

      return {
        port,
        host,
        token: identity.token,
        version,
        bundleHash,
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
