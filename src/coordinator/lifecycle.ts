import type { Server, ServerResponse } from 'node:http';
import { backendLog } from '../infra/backend-log.js';
import { readBackendInfo, type BackendInfo } from '../infra/backend-discovery.js';
import { type LaunchCoordinator } from './live/admission.js';
import type { RecoveryRegistry } from '../jobs/reconcile/registry.js';
import type { IdleTimer } from './live/idle.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { DiscussContext } from '../discuss/shell/types.js';
import type { RecoveredDiscussResume } from '../discuss/shell/recovery.js';
import type { DiscussSessionStore } from '../discuss/shell/session-store.js';
import { type ProviderRegistry } from '../providers/registry.js';
import { isTerminalPhase } from '../jobs/phase.js';
import { createRecoveryCoordinator, type RecoveryCoordinator } from './services/recovery/index.js';
import { createReplacementBackendOwnershipChecker } from './ownership-checker.js';
import { listLiveJobs, markJobAsError } from '../jobs/reconcile/recovery-effects.js';
import { writeResultArtifact } from '../jobs/terminal/export.js';
import type { JobStore } from '../jobs/store.js';
import type { CreateKbSubsystemOptions, KnowledgeBaseRuntime } from '../kb/subsystem.js';
import { kbRuntimeDir } from '../kb/paths.js';
import type { ProviderHostManager } from './live/provider-hosts/index.js';
import type { Runtime } from '../runtime/ports.js';
import { KB_ID, type Subsystem } from './subsystems/contract.js';
import type { SubsystemRegistry } from './subsystems/registry.js';
import {
  SHUTDOWN_POLL_MS,
  runShutdownSequence,
  type LifecycleWiringState,
  type ShutdownMode,
  HANDOFF_DRAIN_TIMEOUT_MS,
} from './shutdown.js';
import type { HandoffQuiescePort } from './execution-service.js';
import type { InterruptedAppServerReason } from '../jobs/reconcile/interrupted-reason.js';
import { bindWithHandoff, BackendAlreadyRunningError, HandoffEscalationError } from './handoff.js';
import { IncumbentMatchesError } from '../transport/ipc/handoff.js';
import { probeCoordinator } from '../infra/backend-discovery.js';
import type { RecoveryCapableService } from '../jobs/reconcile/contracts.js';
import type { ProjectRequestPort } from './contracts.js';
import type { TypedEventBus } from './event-bus.js';
import type { IpcListener } from '../transport/ipc/server.js';
import { createBackendStoreResetAuthority, openOrResetBackendStoreDb, type Database } from '../store/db.js';
import type { CoordinatorStoreServices, StoreServicesRef } from './composition/store-services-ref.js';

export type LifecycleState = 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped';

export type CoordinatorServerInfo = {
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

export interface CoordinatorIdentity {
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
  getLaunchFenceActive(): boolean;
  readonly subsystems: SubsystemRegistry;
}

export interface MutableRuntimeState extends ReadonlyRuntimeState {
  setLifecycle(state: LifecycleState): void;
  setStartedAt(ts: number): void;
  setLaunchFenceActive(active: boolean): void;
}

export function createRuntimeState(startedAt: number, subsystems: SubsystemRegistry): MutableRuntimeState {
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
    subsystems,
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
 * Factory for the KB subsystem. Returns a `Subsystem<KnowledgeBaseRuntime>`
 * to register with the runtime-state registry. The registered subsystem
 * owns its own retry loop and curate-scheduler bridge; lifecycle.ts merely
 * registers it and triggers `initAll` after Era II completes.
 */
export type CreateKbSubsystemFn = (options: CreateKbSubsystemOptions) => Subsystem<KnowledgeBaseRuntime>;

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
  progressStore: JobStore,
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
  progressStore: JobStore,
  namespace: string,
  message: string,
  storage: Pick<Runtime['storage'], 'mkdirSync' | 'writeAtomicSync'>,
  jobsRoot: string,
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
          writeResultArtifact(storage, jobsRoot, status.jobId, '');
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
  readonly signal: AbortSignal;
};

export type RecoverPersistedDiscussFn = (deps: RecoverPersistedDiscussDeps) => Promise<RecoveredDiscussResume[]>;

export type StartupRecoveryDeps = {
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
  readonly cleanupStaleJobs: (currentBundleHash: string) => void;
  readonly recoverPersistedDiscussFn: RecoverPersistedDiscussFn;
  /**
   * Default `'restart'`. Phase C will set this to `'handoff'` when
   * `bindWithHandoff` observed an incumbent and acquired the socket; in this
   * landing the parameter exists but always defaults to `'restart'`.
   */
  readonly interruptedAppServerReason?: InterruptedAppServerReason;
};

export type RunStartupRecoveryFn = (deps: StartupRecoveryDeps) => Promise<RecoveredDiscussResume[]>;

export type LifecycleDeps = {
  readonly identity: CoordinatorIdentity;
  readonly runtime: Runtime;
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
  readonly server: Server;
  readonly getExecutionService: (ctx: InvocationContext) => ProjectRequestPort;
  readonly getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  readonly listExecutionServices: () => ProjectRequestPort[];
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  readonly writeBackendInfoFn: (info: BackendInfo) => void;
  readonly removeBackendInfoIfOwnerFn: (instanceId: string) => void;
  readonly cleanupStaleJobsFn: (currentBundleHash: string) => void;
  readonly markJobsAsErrorFn: (namespace: string, message: string) => void;
  readonly terminateAllFn: () => void;
  readonly providerHostManager: ProviderHostManager;
  readonly handoffQuiescePorts: () => readonly HandoffQuiescePort[];
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
  start(): Promise<CoordinatorServerInfo>;
  shutdown(reason: string): Promise<void>;
  waitForShutdown(): Promise<void>;
  getRecoveryRegistry(): RecoveryRegistry | null;
};

type LifecycleControlState = LifecycleWiringState & {
  shutdownPromise: Promise<void> | null;
  started: boolean;
  recoveryCoordinator: RecoveryCoordinator | null;
  startupAbort: AbortController | null;
};

type LifecycleStartupContext = {
  deps: LifecycleDeps;
  state: LifecycleControlState;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  ownershipChecker: ReturnType<typeof createReplacementBackendOwnershipChecker>;
  shutdown: (reason: string) => Promise<void>;
};

async function runLifecycleStartup({
  deps,
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
    providerRegistry,
    server,
    getRecoveryService,
    getDiscussStoreForSource,
    knownDiscussSources,
    getDiscussContext,
    writeBackendInfoFn,
    removeBackendInfoIfOwnerFn,
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
  const { namespace, version, bundleHash, flavor, instanceId, now } = identity;

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
    const socketPath = runtime.paths.coral.coordinator.socketPath;
    let interruptedAppServerReason: InterruptedAppServerReason = 'restart';
    let socketAuthorityAcquired = false;
    if (ipcServer && listenIpcFn) {
      const handoff = await bindWithHandoff({
        socketPath,
        desired: { bundleHash, flavor, namespace },
        bindAttempt: async () => {
          try {
            await listenIpcFn(ipcServer);
            return { kind: 'bound' as const };
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
              return { kind: 'incumbent' as const, reason: 'live-listener' };
            }
            throw error;
          }
        },
        runtime,
        readVerifiedIncumbentFromDiscovery: ({ socketPath: probeSocket, desired, lastHealth }) => {
          const info = probeCoordinator({
            storage: runtime.storage,
            env: runtime.env,
            paths: runtime.paths,
          });
          if (!info || info.processStartedAt === undefined) {
            return null;
          }
          if (
            info.socketPath !== probeSocket ||
            info.flavor !== desired.flavor ||
            info.namespace !== desired.namespace
          ) {
            return null;
          }
          if (
            lastHealth &&
            (lastHealth.flavor !== info.flavor ||
              lastHealth.namespace !== info.namespace ||
              lastHealth.bundleHash !== info.bundleHash ||
              (lastHealth.pid !== undefined && lastHealth.pid !== info.pid) ||
              (lastHealth.processStartedAt !== undefined && lastHealth.processStartedAt !== info.processStartedAt))
          ) {
            return null;
          }
          return {
            pid: info.pid,
            processStartedAt: info.processStartedAt,
            source: 'discovery',
          };
        },
        totalBudgetMs: HANDOFF_DRAIN_TIMEOUT_MS,
      });
      socketAuthorityAcquired = true;
      if (handoff.acquiredViaHandoff) {
        interruptedAppServerReason = 'handoff';
      }
    }
    signal.throwIfAborted();

    const resetAuthority = createBackendStoreResetAuthority(
      runtime,
      { acquiredViaHandoff: socketAuthorityAcquired },
      { bundleHash, namespace },
    );
    const storeDb = openOrResetBackendStoreDb(runtime, resetAuthority, { bundleHash, namespace });
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
    const progressStore = storeServices.progressStore;
    const recoveryCoordinator = createRecoveryCoordinator({
      progressStore,
      runtime,
      runtimeState,
      eventBus: deps.eventBus,
      providerRegistry,
      getRecoveryService,
      createInvocationContext,
      log: identity.log,
    });
    state.recoveryCoordinator = recoveryCoordinator;
    signal.throwIfAborted();

    registerBuiltInProvidersFn(providerRegistry);

    // Bind the HTTP listener and signal kernel-ready BEFORE Era II's
    // recovery work. KB is a subsystem (Era III); its boot work cannot gate
    // daemon liveness. The CLI's `waitForBackendReady` resolves on
    // `kernel.phase ∈ { 'kernel-ready', 'running' }` so once we reach this
    // point the CLI returns within `KERNEL_READY_DEADLINE_MS`.
    const { port, host } = await listenFn(server);
    signal.throwIfAborted();
    runtimeState.setStartedAt(now());
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
    runtimeState.setLifecycle('kernel-ready');

    // ===== Era II (recovery) =====
    // Per-job isolation: corrupt sessions should not abort recovery.
    // `runStartupRecoveryFn` registers journal cursors then awaits
    // `waitFreshUntil` against `currentMaxSeq`; that wait runs here in Era II
    // because its budget is bounded by the daemon-side
    // `bootFreshnessTimeoutMs` (default 90s), not by either CLI-facing
    // deadline — the CLI has already returned by now.
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
      signal,
      cleanupStaleJobs: cleanupStaleJobsFn,
      recoverPersistedDiscussFn,
      interruptedAppServerReason,
    });
    signal.throwIfAborted();

    let registeredSubsystems = false;
    try {
      const kbSubsystem = createKbSubsystemFn({
        db: progressStore.getDb(),
        paths: {
          markdownRoot: runtime.paths.coral.corpus.kbRoot,
          runtimeDir: kbRuntimeDir(flavor),
        },
        spawnCli: launchCoordinator.spawnCli.bind(launchCoordinator),
        processPort: runtime.process,
        storagePort: runtime.storage,
        envPort: runtime.env,
        timePort: runtime.time,
        idsPort: runtime.ids,
      });
      runtimeState.subsystems.register(kbSubsystem);
      registeredSubsystems = true;
    } catch (error: unknown) {
      backendLog.error('Subsystem registration failed — KB will be offline until restart', error);
    }

    runtimeState.setLifecycle('running');
    state.started = true;

    idleTimer.startWatching(
      () => {
        // Probe the curate scheduler through the registry. While KB is still
        // initializing/offline, the registry returns an error envelope; treat
        // that as "not running" so idle-shutdown can fire under those phases
        // (when no actual curate work can be in flight).
        const curateProbe = runtimeState.subsystems.run<KnowledgeBaseRuntime, boolean>(KB_ID, (kb) =>
          kb.curateScheduler.isRunning(),
        );
        const curateRunning = typeof curateProbe === 'boolean' ? curateProbe : false;
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

    // ===== Era III (subsystems — fire-and-forget) =====
    // Subsystems were registered before `running` became externally visible
    // and are now kicked off in the background. The KB subsystem owns its own
    // retry loop and curate-scheduler bridge; the registry surfaces its phase
    // via `runtimeState.subsystems.status('kb')`.
    // KB-routed handlers consult the registry through `subsystems.run`/
    // `runAsync` and receive a structured `kb_initializing` / `kb_offline`
    // envelope while the subsystem is not online.
    try {
      if (registeredSubsystems) {
        runtimeState.subsystems.initAll(signal);
      }
    } catch (error: unknown) {
      backendLog.error('Subsystem initialization dispatch failed — KB will be offline until restart', error);
    }

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
    if (error instanceof IncumbentMatchesError) {
      // Translate to the existing bootstrap-recognized "redundant contender"
      // signal (info log + exit 0). The socket has not been bound by us, so
      // there is nothing to clean up.
      runtimeState.setLifecycle('stopped');
      throw new BackendAlreadyRunningError();
    }
    if ((error as { name?: string } | null)?.name === 'AbortError' && state.shutdownPromise !== null) {
      // Shutdown owns cleanup. Do not close IPC/backend-info here, because
      // handoff finalizers may still hold socket authority until they
      // complete or budget-skip.
      throw error;
    }
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

    if (error instanceof HandoffEscalationError) {
      backendLog.error('Handoff escalation failed', error);
    }
    throw error;
  } finally {
    state.startupAbort = null;
  }
}

export function createLifecycle(deps: LifecycleDeps): LifecycleController {
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
    recoveryCoordinator: null,
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
  function createInvocationContext(projectRoot: string): InvocationContext {
    return { projectRoot, pluginRoot, coralEnv: {} };
  }

  async function shutdown(reason: string): Promise<void> {
    if (state.shutdownPromise) return state.shutdownPromise;

    // Calling `abort()` with no reason sets `signal.reason` to the platform
    // default (a DOMException whose `.name === 'AbortError'`). Downstream
    // `signal.throwIfAborted()` checks throw that reason value, which
    // downstream catches detect via `error?.name === 'AbortError'`. A string
    // reason would propagate as a bare string and lose the `name`
    // discriminator.
    state.startupAbort?.abort();

    state.shutdownPromise = (async () => {
      if (runtimeState.getLifecycle() === 'stopped') return;

      await runShutdownSequence({
        reason,
        state,
        teardownRecoveryCoordinator: () => state.recoveryCoordinator?.teardown(),
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
        storeServicesRef,
        terminateAllFn,
        handoffQuiescePorts: deps.handoffQuiescePorts,
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
        onStopped?.();
      });

    return state.shutdownPromise;
  }

  async function start(): Promise<CoordinatorServerInfo> {
    try {
      return await runLifecycleStartup({
        deps,
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

  return {
    start,
    shutdown,
    waitForShutdown: () => state.shutdownPromise ?? Promise.resolve(),
    getRecoveryRegistry: () => state.recoveryCoordinator?.getRecoveryRegistry() ?? null,
  };
}
