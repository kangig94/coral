import type { Server, ServerResponse } from 'node:http';
import { errorMessage } from '../infra/error-format.js';
import { backendLog } from '../infra/backend-log.js';
import { readBackendInfo, type BackendInfo } from '../infra/backend-discovery.js';
import { type LaunchCoordinator } from './live/admission.js';
import type { RecoveryRegistry } from '../jobs/reconcile/registry.js';
import type { IdleTimer } from './live/idle.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { DiscussContext } from '../discuss/shell/context.js';
import type { RecoveredDiscussResume } from '../discuss/shell/recovery.js';
import type { DiscussSessionStore } from '../discuss/shell/session-store.js';
import { type ProviderRegistry } from '../providers/registry.js';
import { isTerminalPhase } from '../jobs/phase.js';
import { createRecoveryCoordinator, type RecoveryCoordinator } from './services/recovery/coordinator.js';
import { createReplacementBackendOwnershipChecker } from './ownership-checker.js';
import { listLiveJobs, markJobAsError } from '../jobs/reconcile/recovery-effects.js';
import { writeResultArtifact } from '../jobs/terminal/export.js';
import { StartupInterruptedError } from './startup-error.js';
import type { ProgressStore } from '../jobs/job-store.js';
import type { CreateKbSubsystemOptions, KnowledgeBaseRuntime } from '../kb/subsystem.js';
import type { ProviderHostManager } from './live/provider-hosts/pool.js';
import type { Runtime } from '../runtime/ports.js';
import {
  SHUTDOWN_POLL_MS,
  runShutdownSequence,
  type LifecycleWiringState,
  type ShutdownMode,
} from './shutdown.js';
import type { RecoveryCapableService } from '../jobs/reconcile/contracts.js';
import type { ProjectRequestPort } from './contracts.js';
import type { TypedEventBus } from './event-bus.js';
import type { IpcListener } from '../transport/ipc/server.js';
import type { EquipmentLifecycleService } from './equipment/lifecycle.js';

export {
  HANDOFF_DRAIN_TIMEOUT_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  SHUTDOWN_POLL_MS,
  type ShutdownMode,
} from './shutdown.js';

export type LifecycleState = 'starting' | 'running' | 'draining' | 'stopped';

export type BackendServerInfo = {
  port: number;
  host: string;
  socketPath: string;
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

export function markJobsAsError(
  progressStore: ProgressStore,
  namespace: string,
  message: string,
  storage: Pick<Runtime['storage'], 'mkdirSync' | 'writeAtomicSync'>,
): void {
  for (const status of listLiveJobs(progressStore, namespace)) {
    try {
      markJobAsError(
        progressStore,
        status,
        {
          kind: 'wrapper_crashed',
          cause: { message },
        },
        () => {},
      );
      if (status.jobKind === 'workflow') {
        try {
          writeResultArtifact(storage, status.jobId, '');
        } catch {
          // best-effort export materialization; Journal terminal state is authoritative
        }
      }
    } catch {
      // fail-isolated: skip this job, continue with others
    }
  }
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
  readonly assertStartupStillActive: () => void;
};

export type RecoverPersistedDiscussFn = (deps: RecoverPersistedDiscussDeps) => Promise<RecoveredDiscussResume[]>;

export type StartupRecoveryDeps = {
  readonly identity: BackendIdentity;
  readonly runtime: Runtime;
  readonly progressStore: ProgressStore;
  readonly providerRegistry: ProviderRegistry;
  readonly getExecutionService: (ctx: InvocationContext) => ProjectRequestPort;
  readonly getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  readonly createInvocationContext: (projectRoot: string) => InvocationContext;
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
  readonly getExecutionService: (ctx: InvocationContext) => ProjectRequestPort;
  readonly getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  readonly listExecutionServices: () => ProjectRequestPort[];
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  readonly acquireLockFn: (
    pluginRoot: string,
    instanceId: string,
    version: string,
    bundleHash: string,
    flavor: 'prod' | 'dev',
  ) => Promise<void>;
  readonly writeBackendInfoFn: (info: BackendInfo) => void;
  readonly removeBackendInfoIfOwnerFn: (instanceId: string) => void;
  readonly removeLockIfOwnerFn: (pluginRoot: string, instanceId: string) => void;
  readonly cleanupStaleJobsFn: (currentBundleHash: string) => void;
  readonly markJobsAsErrorFn: (namespace: string, message: string) => void;
  readonly terminateAllFn: () => void;
  readonly providerHostManager: ProviderHostManager;
  readonly equipmentLifecycleService?: EquipmentLifecycleService | null;
  readonly createKbSubsystemFn: CreateKbSubsystemFn;
  readonly registerBuiltInProvidersFn: RegisterBuiltInProvidersFn;
  readonly recoverPersistedDiscussFn: RecoverPersistedDiscussFn;
  readonly runStartupRecoveryFn: RunStartupRecoveryFn;
  readonly hooks: LifecycleHooks;
  readonly closeServerFn: (server: Server) => Promise<void>;
  readonly listenFn: (server: Server) => Promise<{ port: number; host: string }>;
  readonly ipcServer?: IpcListener;
  readonly closeIpcServerFn?: (listener: IpcListener) => Promise<void>;
  readonly listenIpcFn?: (listener: IpcListener) => Promise<{ socketPath: string }>;
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
  createInvocationContext: (projectRoot: string) => InvocationContext;
  recoveryCoordinator: RecoveryCoordinator;
  ownershipChecker: ReturnType<typeof createReplacementBackendOwnershipChecker>;
  shutdown: (reason: string) => Promise<void>;
};

async function runLifecycleStartup({
  deps,
  state,
  createInvocationContext,
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
    ipcServer,
    closeIpcServerFn,
    listenIpcFn,
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
        db: progressStore.getDb(),
        pluginRoot,
        flavor,
        spawnCli: launchCoordinator.spawnCli.bind(launchCoordinator),
        processPort: runtime.process,
        storagePort: runtime.storage,
        envPort: runtime.env,
        timePort: runtime.time,
        idsPort: runtime.ids,
      });
      runtimeState.setKbSubsystem(kbSub);
    } catch (error: unknown) {
      const message = errorMessage(error);
      backendLog.error('KB subsystem failed to initialize — running in degraded mode', error);
      runtimeState.setKbInitError(message);
    }
    assertStartupStillActive();

    const { port, host } = await listenFn(server);
    const { socketPath } =
      ipcServer && listenIpcFn ? await listenIpcFn(ipcServer) : { socketPath: runtime.paths.coral.coordinator.socketPath };
    assertStartupStillActive();
    runtimeState.setStartedAt(now());

    const recoveredDiscussResumes = await runStartupRecoveryFn({
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
      assertStartupStillActive,
      cleanupStaleJobs: cleanupStaleJobsFn,
      recoverPersistedDiscussFn,
    });

    assertStartupStillActive();
    const startedAt = runtimeState.getStartedAt();
    writeBackendInfoFn({
      pid: backendPid,
      port,
      host,
      socketPath,
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
      socketPath,
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
    if (ipcServer && closeIpcServerFn) {
      try {
        await closeIpcServerFn(ipcServer);
      } catch {
        // best effort
      }
    }
    removeBackendInfoIfOwnerFn(instanceId);
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
    closeIpcServerFn,
    ipcServer,
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
    readBackendInfo,
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
    eventBus: deps.eventBus,
    providerRegistry,
    getRecoveryService,
    createInvocationContext,
    log,
  });

  function createInvocationContext(projectRoot: string): InvocationContext {
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
        closeIpcServerFn,
        ipcServer,
        streamResponses,
        runtime,
        namespace,
        markJobsAsErrorFn,
        providerHostManager,
        equipmentLifecycleService: deps.equipmentLifecycleService,
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
        removeBackendInfoIfOwnerFn(instanceId);
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
        createInvocationContext,
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
