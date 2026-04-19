import { EventEmitter } from 'node:events';
import type { Server, ServerResponse } from 'node:http';
import { errorMessage } from '../shared/utils.js';
import { backendLog } from '../shared/backend-log.js';
import { type LaunchCoordinator } from './live/admission.js';
import { type writeBackendInfo, type removeBackendInfoIfOwner } from './discovery.js';
import type { RecoveryRegistry } from '../execution/recovery-registry.js';
import type { IdleTimer } from './live/idle.js';
import type { ProgressStore } from '../execution/progress-store.js';
import type { CallerContext } from '../shared/request-context.js';
import type { DiscussContext } from '../discuss/shell/context.js';
import type { DiscussSessionStore } from '../discuss/shell/session-store.js';
import type { RecoveredDiscussResume } from '../discuss/shell/operations.js';
import { type ProviderRegistry } from '../providers/registry.js';
import { legacyWrapperCrashedFault } from '../shared/legacy-terminal-outcome-compat.js';
import { isTerminalPhase, type JobPhase, type JobTerminalRecord } from '../shared/types.js';
import type { CreateKbSubsystemOptions, KnowledgeBaseRuntime } from '../kb/subsystem.js';
import type { ProviderHostManager } from './live/provider-hosts/pool.js';
import type { Runtime } from '../runtime/ports.js';
import { listLiveJobs, markJobAsError } from '../jobs/reconcile/job-helpers.js';
import { resolveClientHost } from './shutdown/network.js';
import { createReplacementBackendOwnershipChecker } from '../jobs/reconcile/ownership-checker.js';
import { createRecoveryCoordinator, type RecoveryCoordinator } from '../jobs/reconcile/coordinator.js';
import { SHUTDOWN_POLL_MS, runShutdownSequence, type LifecycleWiringState } from './shutdown/sequence.js';
import { StartupInterruptedError } from '../jobs/reconcile/errors.js';
import type { ShutdownMode } from './shutdown/mode.js';
import type { ProjectRequestPort, RecoveryCapableService } from './api.js';

export { adoptOrphanedCrossNamespaceJobs } from '../jobs/reconcile/cross-namespace-adoption.js';
export { StartupInterruptedError } from '../jobs/reconcile/errors.js';
export {
  HANDOFF_DRAIN_TIMEOUT_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  SHUTDOWN_POLL_MS,
} from './shutdown/sequence.js';
export type { ShutdownMode } from './shutdown/mode.js';

export type LifecycleState = 'starting' | 'running' | 'draining' | 'stopped';

export type BackendServerInfo = {
  port: number;
  host: string;
  token: string;
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  instanceId: string;
  startedAt: number;
};

export interface BackendIdentity {
  readonly pluginRoot: string;
  readonly namespace: string;
  readonly version: string;
  readonly bundleHash: string;
  readonly flavor: 'prod' | 'dev';
  readonly instanceId: string;
  readonly token: string;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

export interface ReadonlyRuntimeState {
  getLifecycle(): LifecycleState;
  getStartedAt(): number;
  getKbSubsystem(): KnowledgeBaseRuntime | null;
  getKbInitError(): string | null;
  getLaunchFenceActive(): boolean;
}

export interface MutableRuntimeState extends ReadonlyRuntimeState {
  setLifecycle(state: LifecycleState): void;
  setStartedAt(ts: number): void;
  setKbSubsystem(kb: KnowledgeBaseRuntime | null): void;
  setKbInitError(error: string | null): void;
  setLaunchFenceActive(active: boolean): void;
}

export type EventBusEvents = {
  'job:created': { jobId: string; sessionId: string; provider: string; projectRoot: string };
  'job:phase_changed': { jobId: string; phase: JobPhase; previousPhase: JobPhase };
  'job:progress': { jobId: string; eventId: number; message: string };
  'job:completed': {
    jobId: string;
    result: JobTerminalRecord;
    costUsd?: number;
    tokenUsage?: {
      inputTokens?: number;
      outputTokens?: number;
    };
  };
  'discuss:updated': { projectRoot: string; sessionId: string; lastSeq: number; status: string };
};

const MAX_EVENT_BUS_LISTENERS = 100;

export class TypedEventBus {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  constructor() {
    this.emitter.setMaxListeners(MAX_EVENT_BUS_LISTENERS);
  }

  on<K extends keyof EventBusEvents>(event: K, listener: (payload: EventBusEvents[K]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  off<K extends keyof EventBusEvents>(event: K, listener: (payload: EventBusEvents[K]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  emit<K extends keyof EventBusEvents>(event: K, payload: EventBusEvents[K]): boolean {
    const listeners = this.emitter.listeners(event) as Array<(value: EventBusEvents[K]) => unknown>;
    if (listeners.length === 0) {
      return false;
    }

    for (const listener of listeners) {
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          void result.catch((error: unknown) => {
            backendLog.error(`EventBus listener for ${String(event)} failed`, error);
          });
        }
      } catch (error: unknown) {
        backendLog.error(`EventBus listener for ${String(event)} failed`, error);
      }
    }

    return true;
  }

  removeAllListeners(): this {
    this.emitter.removeAllListeners();
    return this;
  }

  reset(): this {
    return this.removeAllListeners();
  }
}

export function createRuntimeState(startedAt: number): MutableRuntimeState {
  let lifecycle: LifecycleState = 'starting';
  let currentStartedAt = startedAt;
  let kbSubsystem: KnowledgeBaseRuntime | null = null;
  let kbInitError: string | null = null;
  let launchFenceActive = false;

  return {
    getLifecycle: () => lifecycle,
    getStartedAt: () => currentStartedAt,
    getKbSubsystem: () => kbSubsystem,
    getKbInitError: () => kbInitError,
    getLaunchFenceActive: () => launchFenceActive,
    setLifecycle: (state) => {
      lifecycle = state;
    },
    setStartedAt: (ts) => {
      currentStartedAt = ts;
    },
    setKbSubsystem: (kb) => {
      kbSubsystem = kb;
    },
    setKbInitError: (error) => {
      kbInitError = error;
    },
    setLaunchFenceActive: (active) => {
      launchFenceActive = active;
    },
  };
}

export type CreateKbSubsystemFn = (options: CreateKbSubsystemOptions) => Promise<KnowledgeBaseRuntime>;

export interface LifecycleHooks {
  onShutdown(mode: ShutdownMode): Promise<void>;
  onIdleCheck(): boolean;
  onRecoveryComplete(resumes: RecoveredDiscussResume[]): Promise<void>;
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
      markJobAsError(progressStore, status, legacyWrapperCrashedFault(message), () => {});
    } catch {
      // fail-isolated: skip this job, continue with others
    }
  }
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
) => Promise<RecoveredDiscussResume[]>;

export type StartupRecoveryDeps = {
  readonly identity: BackendIdentity;
  readonly runtime: Runtime;
  readonly progressStore: ProgressStore;
  readonly providerRegistry: ProviderRegistry;
  readonly getExecutionService: (ctx: CallerContext) => ProjectRequestPort;
  readonly getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly getDiscussContext: (ctx: CallerContext) => DiscussContext;
  readonly createCallerContext: (projectRoot: string) => CallerContext;
  readonly recoveryCoordinator: RecoveryCoordinator;
  readonly assertStartupStillActive: () => void;
  readonly cleanupStaleJobs: (currentBundleHash: string) => void;
  readonly recoverPersistedDiscussFn: RecoverPersistedDiscussFn;
};

export type RunStartupRecoveryFn = (deps: StartupRecoveryDeps) => Promise<RecoveredDiscussResume[]>;

export type LifecycleDeps = {
  readonly identity: BackendIdentity;
  readonly runtime: Runtime;
  readonly backendPid: number;
  readonly runtimeState: MutableRuntimeState;
  readonly idleTimer: IdleTimer;
  readonly progressStore: ProgressStore;
  readonly streamResponses: Set<ServerResponse>;
  readonly discussStores: Map<string, DiscussSessionStore>;
  readonly eventBus: TypedEventBus;
  readonly launchCoordinator: LaunchCoordinator;
  readonly providerRegistry: ProviderRegistry;
  readonly server: Server;
  readonly getExecutionService: (ctx: CallerContext) => ProjectRequestPort;
  readonly getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
  readonly listExecutionServices: () => ProjectRequestPort[];
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussContext: (ctx: CallerContext) => DiscussContext;
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
  readonly cleanupStaleJobsFn: (currentBundleHash: string) => void;
  readonly markJobsAsErrorFn: (namespace: string, message: string) => void;
  readonly terminateAllFn: () => void;
  readonly providerHostManager: ProviderHostManager;
  readonly createKbSubsystemFn: CreateKbSubsystemFn;
  readonly registerBuiltInProvidersFn: RegisterBuiltInProvidersFn;
  readonly recoverPersistedDiscussFn: RecoverPersistedDiscussFn;
  readonly runStartupRecoveryFn?: RunStartupRecoveryFn;
  readonly hooks: LifecycleHooks;
  readonly closeServerFn: (server: Server) => Promise<void>;
  readonly listenFn: (server: Server) => Promise<{ port: number; host: string }>;
  readonly onStopped?: () => void;
  readonly onFatalShutdownError?: (error: unknown) => void;
};

export type LifecycleController = {
  start(): Promise<BackendServerInfo>;
  shutdown(reason: string): Promise<void>;
  waitForShutdown(): Promise<void>;
  getRecoveryRegistry(): RecoveryRegistry | null;
};

type LifecycleControlState = LifecycleWiringState & {
  shutdownPromise: Promise<void> | null;
  started: boolean;
};

type LifecycleStartupContext = {
  deps: LifecycleDeps;
  state: LifecycleControlState;
  createCallerContext: (projectRoot: string) => CallerContext;
  recoveryCoordinator: RecoveryCoordinator;
  ownershipChecker: ReturnType<typeof createReplacementBackendOwnershipChecker>;
  shutdown: (reason: string) => Promise<void>;
};

async function runLifecycleStartup({
  deps,
  state,
  createCallerContext,
  recoveryCoordinator,
  ownershipChecker,
  shutdown,
}: LifecycleStartupContext): Promise<BackendServerInfo> {
  const {
    identity,
    runtime,
    backendPid,
    runtimeState,
    idleTimer,
    progressStore,
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
    createKbSubsystemFn,
    registerBuiltInProvidersFn,
    recoverPersistedDiscussFn,
    runStartupRecoveryFn,
    hooks,
    closeServerFn,
    listenFn,
  } = deps;
  const { pluginRoot, namespace, version, bundleHash, flavor, instanceId, now } = identity;

  if (state.started || runtimeState.getLifecycle() !== 'starting') {
    throw new Error('Backend server already started');
  }

  const assertStartupStillActive = (): void => {
    if (state.shutdownPromise !== null || runtimeState.getLifecycle() !== 'starting') {
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
        processPort: runtime.process,
        storagePort: runtime.storage,
        envPort: runtime.env,
      });
      runtimeState.setKbSubsystem(kbSub);
    } catch (error: unknown) {
      const message = errorMessage(error);
      backendLog.error('KB subsystem failed to initialize — running in degraded mode', error);
      runtimeState.setKbInitError(message);
    }
    assertStartupStillActive();

    const { port, host } = await listenFn(server);
    assertStartupStillActive();
    runtimeState.setStartedAt(now());

    const recoveredDiscussResumes =
      (await runStartupRecoveryFn?.({
        identity,
        runtime,
        progressStore,
        providerRegistry,
        getExecutionService: deps.getExecutionService,
        getRecoveryService,
        knownDiscussSources,
        getDiscussStoreForSource,
        getDiscussContext,
        createCallerContext,
        recoveryCoordinator,
        assertStartupStillActive,
        cleanupStaleJobs: cleanupStaleJobsFn,
        recoverPersistedDiscussFn,
      })) ?? [];

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
    state.started = true;

    idleTimer.startWatching(
      () => {
        const curateRunning = runtimeState.getKbSubsystem()?.curateScheduler.isRunning() ?? false;
        return (
          runtimeState.getLifecycle() === 'running' &&
          launchCoordinator.active === 0 &&
          !recoveryCoordinator.isIdleBlocked() &&
          progressStore.liveJobCountByNamespace(namespace) === 0 &&
          idleTimer.inflightRequests === 0 &&
          !hooks.onIdleCheck() &&
          (idleTimer.isDraining || !curateRunning)
        );
      },
      (reason) => {
        void shutdown(reason).catch(() => {});
      },
    );

    state.ownershipCheckerTeardown = ownershipChecker.install();
    await hooks.onRecoveryComplete(recoveredDiscussResumes);

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
    runtimeState.setLifecycle('stopped');
    idleTimer.stopWatching();
    state.ownershipCheckerTeardown?.();
    state.ownershipCheckerTeardown = null;

    try {
      await closeServerFn(server);
    } catch {
      // best effort
    }
    removeBackendInfoIfOwnerFn(pluginRoot, instanceId);
    removeLockIfOwnerFn(pluginRoot, instanceId);

    throw error;
  }
}

export function createLifecycle(deps: LifecycleDeps): LifecycleController {
  const {
    identity,
    runtime,
    runtimeState,
    idleTimer,
    progressStore,
    streamResponses,
    discussStores,
    providerRegistry,
    server,
    getRecoveryService,
    removeBackendInfoIfOwnerFn,
    removeLockIfOwnerFn,
    markJobsAsErrorFn,
    terminateAllFn,
    providerHostManager,
    hooks,
    closeServerFn,
    onStopped,
    onFatalShutdownError,
  } = deps;

  const { pluginRoot, namespace, instanceId, log } = identity;

  const state: LifecycleControlState = {
    shutdownPromise: null,
    started: false,
    ownershipCheckerTeardown: null,
  };
  const ownershipChecker = createReplacementBackendOwnershipChecker({
    runtime,
    runtimeState,
    idleTimer,
    pluginRoot,
    instanceId,
  });
  const recoveryCoordinator = createRecoveryCoordinator({
    progressStore,
    runtime,
    runtimeState,
    providerRegistry,
    getRecoveryService,
    createCallerContext,
    log,
  });

  function createCallerContext(projectRoot: string): CallerContext {
    return { projectRoot, pluginRoot, coralEnv: {} };
  }

  async function shutdown(reason: string): Promise<void> {
    if (state.shutdownPromise) return state.shutdownPromise;

    state.shutdownPromise = (async () => {
      if (runtimeState.getLifecycle() === 'stopped') return;

      await runShutdownSequence({
        reason,
        state,
        teardownRecoveryCoordinator: recoveryCoordinator.teardown,
        runtimeState,
        idleTimer,
        closeServerFn,
        waitForInflightDrain,
        server,
        streamResponses,
        runtime,
        namespace,
        markJobsAsErrorFn,
        providerHostManager,
        terminateAllFn,
        progressStore,
        pluginRoot,
        getRecoveryService,
        hooks,
        discussStores,
        log,
      });
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

    return state.shutdownPromise;
  }

  async function start(): Promise<BackendServerInfo> {
    try {
      return await runLifecycleStartup({
        deps,
        state,
        createCallerContext,
        recoveryCoordinator,
        ownershipChecker,
        shutdown,
      });
    } catch (error: unknown) {
      if (error instanceof StartupInterruptedError && state.shutdownPromise !== null) {
        await state.shutdownPromise;
        throw error;
      }
      throw error;
    }
  }

  return {
    start,
    shutdown,
    waitForShutdown: () => state.shutdownPromise ?? Promise.resolve(),
    getRecoveryRegistry: () => recoveryCoordinator.getRecoveryRegistry(),
  };
}
