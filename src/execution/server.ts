declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;
declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { formatError, readBuildFlavor, readBundleHash } from '../shared/utils.js';
import { backendLog } from '../shared/backend-log.js';
import { setBuildFlavor } from '../infra/paths.js';
import type { ExecutionService, ExecutionServiceDeps, RecoveryCapableService } from './service.js';
import { LaunchCoordinator } from './engine.js';
import { readBackendInfo, writeBackendInfo, removeBackendInfoIfOwner } from '../infra/backend-info.js';
import {
  acquireLock,
  BackendAlreadyRunningError,
  removeLockIfOwner,
  type BackendOwnershipState,
  type LockRecord,
  type VerifyBackendOwnershipFn,
} from './backend-lock.js';
import type { AbortResult } from '../shared/execution-contracts.js';

import { TypedEventBus } from './event-bus.js';
import { IdleTimer, resolveIdleTimeoutMs } from './idle-timer.js';
import { ProgressStore } from './progress-store.js';
import type { CallerContext } from '../shared/request-context.js';
import { SessionIndex } from './session-index.js';
import { createRealRuntime, type Runtime, type RuntimeObserver } from './runtime.js';
import { type DiscussContext } from './discuss/context.js';
import {
  clearAllDiscuss,
  createDiscussContextRegistry,
  getOrCreate as getOrCreateDiscussContext,
  hasRunningSessions,
  listAttachedSessions,
  type DiscussContextRegistry,
} from './discuss/context-registry.js';
import * as discussLoop from './discuss/loop.js';
import * as discussOperations from './discuss/operations.js';
import { DiscussSessionStore } from './discuss/session-store.js';
import {
  knownDiscussSources,
  listDiscussSessions,
  loadDiscussDetail,
  type DiscussReadHelpersDeps,
} from './discuss/read-helpers.js';
import { ExecutionService as DefaultExecutionService } from './service.js';
import { belongsToNamespace } from '../shared/types.js';
import { createKbSubsystem as defaultCreateKbSubsystem, type KbSubsystem } from './kb-tools.js';
import { createHttpHandler, sendJson } from './http-handler.js';
import { createPluginRegistry } from '../infra/plugin-registry.js';
import type {
  EventStreamHandlers,
  ExecutionServiceLike,
  HttpHandlerDeps,
  MutableBackendRuntimeState,
  ScopeCheckResult,
} from './backend-contracts.js';
import { createProviderHostManager, type ProviderHostManager } from './host-manager.js';
import { ProviderRegistry } from '../providers/registry.js';
import { registerBuiltInProviders } from '../providers/bootstrap.js';
import {
  closeServer as defaultCloseServer,
  listen as defaultListen,
  cleanupStaleJobs,
  markJobsAsError,
  createLifecycle,
  StartupInterruptedError,
  type CreateKbSubsystemFn,
  type LifecycleDeps,
  type LifecycleController,
  type LifecycleHooks,
  type RecoverPersistedDiscussFn,
  type RegisterBuiltInProvidersFn,
} from './lifecycle.js';
import { recoverPersistedDiscuss as defaultRecoverPersistedDiscuss } from './discuss/recovery.js';
import type { BackendServerInfo, LifecycleState } from './server-types.js';
import {
  EventEmitterObserver,
  asEmittingRuntimeObserver,
  attachRecordingObserver,
  observeRuntimeSpawns,
  resolveSpawnRecordingDir,
} from './recording-observer.js';

export type BackendBootSnapshot = {
  version?: string;
  bundleHash?: string;
  flavor?: 'prod' | 'dev';
  instanceId?: string;
  token?: string;
  now?: () => number;
  log?: (message: string) => void;
  bindHost?: string;
  advertiseHost?: string;
  pid?: number;
};

export type CreateServerFn = (handler: (req: IncomingMessage, res: ServerResponse) => void) => Server;
type RemoveLockIfOwnerFn = (pluginRoot: string, instanceId: string) => void;

const LOCK_HEALTHCHECK_TIMEOUT_MS = 1_000;

export type BackendServerOptions = {
  runtime?: Runtime;
  runtimeObserver?: RuntimeObserver;
  bootSnapshot?: BackendBootSnapshot;
  progressStore?: ProgressStore;
  pluginRoot?: string;
  backendNamespace?: string;
  resolveProjectSourceFn?: (projectRoot: string) => string;
  createServerFn?: CreateServerFn;
  listenFn?: LifecycleDeps['listenFn'];
  createIdleTimer?: () => IdleTimer;
  createExecutionService?: (
    ctx: CallerContext,
    deps: ExecutionServiceDeps,
  ) => ExecutionServiceLike;
  verifyBackendOwnershipFn?: VerifyBackendOwnershipFn;
  acquireLockFn?: (
    pluginRoot: string,
    instanceId: string,
    version: string,
    bundleHash: string,
    flavor: 'prod' | 'dev',
  ) => Promise<void>;
  writeBackendInfoFn?: typeof writeBackendInfo;
  removeBackendInfoIfOwnerFn?: typeof removeBackendInfoIfOwner;
  removeLockIfOwnerFn?: RemoveLockIfOwnerFn;
  closeServerFn?: (server: Server) => Promise<void>;
  cleanupStaleJobsFn?: (currentBundleHash: string) => void;
  markJobsAsErrorFn?: (namespace: string, message: string) => void;
  terminateAllFn?: () => void;
  createKbSubsystemFn?: CreateKbSubsystemFn;
  registerBuiltInProvidersFn?: RegisterBuiltInProvidersFn;
  recoverPersistedDiscussFn?: RecoverPersistedDiscussFn;
  providerHostManager?: ProviderHostManager;
  launchCoordinator?: LaunchCoordinator;
  eventBus?: TypedEventBus;
  providerRegistry?: ProviderRegistry;
  onStopped?: () => void;
  onFatalShutdownError?: (error: unknown) => void;
  discussRegistry?: DiscussContextRegistry;
};

export type BackendServerController = {
  server: Server;
  start: () => Promise<BackendServerInfo>;
  shutdown: (reason: string) => Promise<void>;
  waitForShutdown: () => Promise<void>;
  getLifecycle: () => LifecycleState;
  getIdleTimer: () => IdleTimer;
};
function resolveDefaultPluginRoot(): string {
  return typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..', '..');
}

async function verifyBackendOwnershipWithHealthcheck(
  pluginRoot: string,
  record: LockRecord,
  runtime: Pick<Runtime, 'process' | 'storage' | 'paths' | 'time'>,
): Promise<BackendOwnershipState> {
  const expectedNamespace = runtime.paths.pluginRootNamespace(pluginRoot);
  const info = readBackendInfo(pluginRoot, runtime);
  if (!info) {
    return 'stale';
  }
  if (
    info.instanceId !== record.instanceId ||
    info.pid !== record.pid ||
    info.bundleHash !== record.bundleHash ||
    info.flavor !== record.flavor ||
    info.namespace !== expectedNamespace
  ) {
    return 'stale';
  }
  if (!runtime.process.isAlive(record.pid)) {
    return 'stale';
  }

  const controller = new AbortController();
  const timeout = runtime.time.setTimeout(() => controller.abort(), LOCK_HEALTHCHECK_TIMEOUT_MS);

  try {
    const response = await fetch(`http://${info.host}:${info.port}/health`, {
      method: 'GET',
      headers: { 'X-Coral-Backend-Token': info.token },
      signal: controller.signal,
    });
    if (!response.ok) {
      return 'contended';
    }

    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') {
      return 'contended';
    }

    const payload = body as Record<string, unknown>;
    return payload.status === 'ok' &&
      payload.bundleHash === record.bundleHash &&
      payload.flavor === record.flavor &&
      payload.instanceId === record.instanceId &&
      payload.namespace === expectedNamespace
      ? 'healthy'
      : 'contended';
  } catch {
    return 'contended';
  } finally {
    runtime.time.clearTimeout(timeout);
  }
}

function createDefaultBackendOwnershipVerifier(runtime: Pick<Runtime, 'process' | 'storage' | 'paths' | 'time'>): VerifyBackendOwnershipFn {
  return ({ pluginRoot, record }) => verifyBackendOwnershipWithHealthcheck(pluginRoot, record, runtime);
}

export function listInstantiatedExecutionServices(
  services: ReadonlyMap<string, ExecutionServiceLike>,
): ExecutionServiceLike[] {
  return [...services.values()];
}

export function createBackendServer(options: BackendServerOptions = {}): BackendServerController {
  const runtime = options.runtime ?? createRealRuntime();
  const runtimeObserver = asEmittingRuntimeObserver(options.runtimeObserver ?? new EventEmitterObserver());
  observeRuntimeSpawns(runtime, runtimeObserver);
  const recordingDir = resolveSpawnRecordingDir(runtime.env.get('CORAL_SIMULATE_RECORD'), runtime.env.cwd());
  if (recordingDir) {
    attachRecordingObserver({
      observer: runtimeObserver,
      runtime,
      recordingDir,
    });
  }
  const bootSnapshot = options.bootSnapshot ?? {};
  const resolvedPluginRoot = options.pluginRoot ?? resolveDefaultPluginRoot();
  const namespace = options.backendNamespace ?? runtime.paths.pluginRootNamespace(resolvedPluginRoot);
  const resolveProjectSourceFn = options.resolveProjectSourceFn ?? ((projectRoot: string) => runtime.paths.projectSource(projectRoot));
  const version = bootSnapshot.version ?? (typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0');
  const bundleHash = bootSnapshot.bundleHash ?? readBundleHash(resolvedPluginRoot);
  const flavor = bootSnapshot.flavor ?? readBuildFlavor(resolvedPluginRoot);
  setBuildFlavor(flavor);
  const instanceId = bootSnapshot.instanceId ?? runtime.ids.uuid();
  const token = bootSnapshot.token ?? runtime.ids.randomBytes(32).toString('hex');
  const bindHost = bootSnapshot.bindHost ?? runtime.env.get('CORAL_BACKEND_BIND') ?? '127.0.0.1';
  const advertiseHost = bootSnapshot.advertiseHost ?? runtime.env.get('CORAL_BACKEND_ADVERTISE_HOST');
  const backendPid = bootSnapshot.pid ?? runtime.env.pid();
  const idleTimer =
    options.createIdleTimer?.() ??
    new IdleTimer({
      time: runtime.time,
      timeoutMs: resolveIdleTimeoutMs(runtime.env.get('CORAL_BACKEND_IDLE_MS')),
    });
  const launchCoordinator = options.launchCoordinator ?? new LaunchCoordinator({ runtime });
  const eventBus = options.eventBus ?? options.progressStore?.getEventBus() ?? new TypedEventBus();
  const providerRegistry = options.providerRegistry ?? new ProviderRegistry();
  const pluginRegistry = createPluginRegistry({
    storage: runtime.storage,
    env: runtime.env,
    homeDir: runtime.env.get('HOME') ?? runtime.env.get('USERPROFILE') ?? undefined,
  });
  const discussRegistry = options.discussRegistry ?? createDiscussContextRegistry();
  const progressStore = options.progressStore ?? new ProgressStore(namespace, eventBus, runtime);
  const coralEnvSnapshot = runtime.env.coralSnapshot();
  const providerHostManager =
    options.providerHostManager ??
    createProviderHostManager({
      runtime,
      spawnProviderServer: launchCoordinator.spawnProviderServer.bind(launchCoordinator),
    });
  const sessionIndex = new SessionIndex(runtime);
  const now = bootSnapshot.now ?? (() => runtime.time.now());
  backendLog.init({ version, bundleHash });
  const log =
    bootSnapshot.log ??
    ((message: string) => {
      backendLog.raw(message);
    });
  const createExecutionService =
    options.createExecutionService ??
    ((ctx: CallerContext, deps) => new DefaultExecutionService(ctx, deps));
  const verifyBackendOwnershipFn = options.verifyBackendOwnershipFn ?? createDefaultBackendOwnershipVerifier(runtime);
  const acquireLockFn =
    options.acquireLockFn ?? ((pluginRoot, instanceId, version, currentBundleHash, currentFlavor) =>
      acquireLock(pluginRoot, instanceId, version, currentBundleHash, currentFlavor, {
        env: runtime.env,
        storage: runtime.storage,
        paths: runtime.paths,
        time: runtime.time,
        verifyOwnership: verifyBackendOwnershipFn,
      }));
  const writeBackendInfoFn =
    options.writeBackendInfoFn ?? ((pluginRoot, info) => writeBackendInfo(pluginRoot, info, runtime));
  const removeBackendInfoIfOwnerFn =
    options.removeBackendInfoIfOwnerFn ??
    ((pluginRoot, instanceId) => removeBackendInfoIfOwner(pluginRoot, instanceId, runtime));
  const removeLockIfOwnerFn =
    options.removeLockIfOwnerFn ??
    ((pluginRoot, instanceId) => removeLockIfOwner(pluginRoot, instanceId, runtime.storage, runtime.paths));
  const closeServerFn = options.closeServerFn ?? defaultCloseServer;
  const cleanupStaleJobsFn =
    options.cleanupStaleJobsFn ??
    ((currentBundleHash: string) => {
      cleanupStaleJobs(progressStore, currentBundleHash, log, runtime.storage);
    });
  const markJobsAsErrorFn =
    options.markJobsAsErrorFn ??
    ((currentNamespace: string, message: string) => {
      markJobsAsError(progressStore, currentNamespace, message);
    });
  const terminateAllFn = options.terminateAllFn ?? (() => launchCoordinator.terminateAll());
  const createKbSubsystemFn = options.createKbSubsystemFn ?? defaultCreateKbSubsystem;
  const createServerFn = options.createServerFn ?? createServer;
  const listenFn = options.listenFn ?? ((server: Server) => defaultListen(server, bindHost, advertiseHost));
  const registerBuiltInProvidersFn = options.registerBuiltInProvidersFn ?? registerBuiltInProviders;
  const recoverPersistedDiscussFn = options.recoverPersistedDiscussFn ?? defaultRecoverPersistedDiscuss;

  // Late-bound lifecycle controller — assigned after httpHandlerDeps (which
  // references abortJobs/scopeCheckJobs) but before any request-time call.
  let lifecycleController: LifecycleController | null = null;

  // -- Shared runtime state (composition root owns the mutable cell) --------
  const services = new Map<string, ExecutionServiceLike>();
  const discussStores = new Map<string, DiscussSessionStore>();
  const streamResponses = new Set<ServerResponse>();
  let startedAt = now();
  let lifecycle: LifecycleState = 'starting';
  let kbSubsystem: KbSubsystem | null = null;
  let kbInitError: string | null = null;
  let launchFenceActive = false;

  const runtimeState: MutableBackendRuntimeState = {
    getLifecycle: () => lifecycle,
    getStartedAt: () => startedAt,
    getKbSubsystem: () => kbSubsystem,
    getKbInitError: () => kbInitError,
    getLaunchFenceActive: () => launchFenceActive,
    setLifecycle: (state) => {
      lifecycle = state;
    },
    setStartedAt: (ts) => {
      startedAt = ts;
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

  // -- Service factories (shared between lifecycle and the HTTP handler)
  function getExecutionService(ctx: CallerContext): ExecutionServiceLike {
    const key = ctx.projectRoot;
    const existing = services.get(key);
    if (existing) return existing;
    const created = createExecutionService(ctx, {
      runtime,
      progressStore,
      bundleHash,
      backendNamespace: namespace,
      providerHostManager,
      launchCoordinator,
      eventBus,
      providerRegistry,
      pluginRegistry,
    });
    services.set(key, created);
    return created;
  }

  function getRecoveryService(ctx: CallerContext): RecoveryCapableService {
    // getExecutionService creates ExecutionService which implements RecoveryCapableService.
    // The cast is safe because createExecutionService always returns ExecutionService.
    return getExecutionService(ctx) as unknown as RecoveryCapableService;
  }

  function listExecutionServices(): ExecutionServiceLike[] {
    return listInstantiatedExecutionServices(services);
  }

  function getDiscussStoreForSource(source: string): DiscussSessionStore {
    const existing = discussStores.get(source);
    if (existing) return existing;
    const created = new DiscussSessionStore(source, {
      onCommit: (snapshot) => {
        eventBus.emit('discuss:updated', {
          projectRoot: snapshot.projectRoot,
          sessionId: snapshot.sessionId,
          lastSeq: snapshot.lastAppliedSeq,
          status: snapshot.state.status,
        });
      },
    });
    discussStores.set(source, created);
    return created;
  }

  function getDiscussStore(projectRoot: string): DiscussSessionStore {
    return getDiscussStoreForSource(resolveProjectSourceFn(projectRoot));
  }

  function getDiscussContext(ctx: CallerContext): DiscussContext {
    const store = getDiscussStore(ctx.projectRoot);
    return getOrCreateDiscussContext(
      discussRegistry,
      ctx.projectRoot,
      getExecutionService(ctx) as ExecutionService,
      store,
    );
  }

  const discussReadHelpersDeps: DiscussReadHelpersDeps = {
    discussRegistry,
    getDiscussStoreForSource,
    resolveProjectSource: resolveProjectSourceFn,
  };

  const hooks: LifecycleHooks = {
    onShutdown: async (mode) => {
      const discussSourcesAtShutdown = mode === 'hard' ? [...knownDiscussSources(discussReadHelpersDeps)] : [];

      await clearAllDiscuss(discussRegistry, mode, discussOperations.persistAbortEndForShutdown);

      if (mode !== 'hard') {
        return;
      }

      await discussOperations.persistAbortEndForPersistedShutdownCandidates(
        discussSourcesAtShutdown,
        getDiscussStoreForSource,
        (snapshot) =>
          getDiscussContext({
            projectRoot: snapshot.projectRoot,
            pluginRoot: resolvedPluginRoot,
            coralEnv: {},
          }),
      );
      discussRegistry.contexts.clear();
    },
    onIdleCheck: () => hasRunningSessions(discussRegistry),
    onRecoveryComplete: async (resumes) => {
      for (const recovered of resumes) {
        try {
          discussLoop.resumeLoop(recovered.ctx, recovered.sessionId, recovered.callerCtx);
        } catch (error: unknown) {
          backendLog.warn(`Discuss resume failed for session ${recovered.sessionId}: ${formatError(error)}`);
        }
      }
    },
  };

  // -- Abort / scope helpers ------------------------------------------------
  function abortJobs(jobIds: string[]): AbortResult {
    const pending = new Set(jobIds);
    const aborted: string[] = [];

    // Check recovery registry first (transient, owned by lifecycle)
    const recoveryRegistry = lifecycleController?.getRecoveryRegistry();
    if (recoveryRegistry && recoveryRegistry.size > 0) {
      const registryJobIds = [...pending].filter((id) => recoveryRegistry.has(id));
      if (registryJobIds.length > 0) {
        const result = recoveryRegistry.abort(registryJobIds);
        for (const jobId of result.aborted) {
          pending.delete(jobId);
          aborted.push(jobId);
        }
      }
    }

    for (const service of services.values()) {
      if (pending.size === 0) break;
      const result = service.abort([...pending]);
      for (const jobId of result.aborted) {
        if (!pending.has(jobId)) continue;
        pending.delete(jobId);
        aborted.push(jobId);
      }
    }

    return { aborted, notFound: [...pending] };
  }

  function scopeCheckJobs(jobIds: string[], projectRoot: string, currentNamespace: string): ScopeCheckResult {
    const valid: string[] = [];
    const missing: string[] = [];
    const mismatch: string[] = [];
    const recoveryRegistry = lifecycleController?.getRecoveryRegistry();

    for (const jobId of jobIds) {
      const status = progressStore.readStatus(jobId);
      if (!status) {
        valid.push(jobId);
        missing.push(jobId);
        continue;
      }

      // projectRoot must match — never bypassed by recovery registry
      if (status.projectRoot !== projectRoot) {
        mismatch.push(jobId);
        continue;
      }

      // Namespace check with recovery registry fallback
      if (belongsToNamespace(status, currentNamespace)) {
        valid.push(jobId);
        continue;
      }

      // Recovery registry fallback: job's projectRoot matches but namespace doesn't yet
      if (recoveryRegistry?.has(jobId)) {
        valid.push(jobId);
        continue;
      }

      mismatch.push(jobId);
    }

    return { valid, missing, mismatch };
  }

  // -- Drain admission fence -------------------------------------------------
  // Flipped immediately by /admin/shutdown BEFORE lifecycle transitions to
  // 'draining'. This closes the pre-existing race window.
  let drainRequested = false;

  // -- HTTP handler wiring ---------------------------------------------------
  const httpHandlerDeps: HttpHandlerDeps = {
    identity: {
      pluginRoot: resolvedPluginRoot,
      namespace,
      version,
      bundleHash,
      flavor,
      instanceId,
      token,
      now,
      log,
    },
    runtime,
    runtimeState,
    idleTimer,
    progressStore,
    sessionIndex,
    activeLaunchCount: () => launchCoordinator.active,
    queueDepth: () => launchCoordinator.queueDepth(),
    streamResponses,
    coralEnvSnapshot,
    resolveProjectSource: resolveProjectSourceFn,
    isDrainRequested: () => drainRequested,
    requestDrain: (reason: string) => {
      drainRequested = true;
      idleTimer.requestDrain(reason);
    },
    getExecutionService,
    getDiscussContext,
    providerRegistry,
    abortJobs,
    scopeCheckJobs: (jobIds, projectRoot) => scopeCheckJobs(jobIds, projectRoot, namespace),
    subscribeBackendEvents: (handlers: EventStreamHandlers) => {
      eventBus.on('job:created', handlers.onJobCreated);
      eventBus.on('job:phase_changed', handlers.onPhaseChanged);
      eventBus.on('job:progress', handlers.onProgress);
      eventBus.on('job:completed', handlers.onCompleted);
      eventBus.on('session:updated', handlers.onSessionUpdated);
      eventBus.on('discuss:updated', handlers.onDiscussUpdated);
    },
    unsubscribeBackendEvents: (handlers: EventStreamHandlers) => {
      eventBus.off('job:created', handlers.onJobCreated);
      eventBus.off('job:phase_changed', handlers.onPhaseChanged);
      eventBus.off('job:progress', handlers.onProgress);
      eventBus.off('job:completed', handlers.onCompleted);
      eventBus.off('session:updated', handlers.onSessionUpdated);
      eventBus.off('discuss:updated', handlers.onDiscussUpdated);
    },
    liveDiscussCount: () => listAttachedSessions(discussRegistry).length,
    listDiscussSessions: () => listDiscussSessions(discussReadHelpersDeps),
    loadDiscussDetail: (source, sessionId, view) => loadDiscussDetail(discussReadHelpersDeps, source, sessionId, view),
  };

  const handleRequest = createHttpHandler(httpHandlerDeps);

  const server = createServerFn((req, res) => {
    void handleRequest(req, res).catch((error) => {
      log(`Backend request error: ${formatError(error)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error' });
        return;
      }
      res.destroy();
    });
  });

  // -- Lifecycle wiring -----------------------------------------------------
  const lifecycleDeps: LifecycleDeps = {
    identity: httpHandlerDeps.identity,
    runtime,
    backendPid,
    runtimeState,
    idleTimer,
    progressStore,
    sessionIndex,
    streamResponses,
    discussStores,
    eventBus,
    launchCoordinator,
    providerRegistry,
    server,
    getExecutionService,
    getRecoveryService,
    listExecutionServices,
    getDiscussStoreForSource,
    knownDiscussSources: () => knownDiscussSources(discussReadHelpersDeps),
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
    hooks,
    closeServerFn,
    listenFn,
    onStopped: options.onStopped,
    onFatalShutdownError: options.onFatalShutdownError,
  };

  lifecycleController = createLifecycle(lifecycleDeps);

  return {
    server,
    start: () => lifecycleController.start(),
    shutdown: (reason) => lifecycleController.shutdown(reason),
    waitForShutdown: () => lifecycleController.waitForShutdown(),
    getLifecycle: () => lifecycle,
    getIdleTimer: () => idleTimer,
  };
}

async function main(): Promise<void> {
  const backend = createBackendServer({
    onStopped: () => {
      process.exit(0);
    },
    onFatalShutdownError: (error) => {
      backendLog.error('Fatal shutdown error', error);
      process.exit(1);
    },
  });

  process.on('SIGTERM', () => {
    void backend.shutdown('sigterm').catch(() => {});
  });
  process.on('SIGINT', () => {
    void backend.shutdown('sigint').catch(() => {});
  });

  try {
    const info = await backend.start();
    backendLog.info(`Running on ${info.host}:${info.port}`);
  } catch (error: unknown) {
    if (error instanceof BackendAlreadyRunningError) {
      backendLog.info(error.message);
      process.exit(0);
      return;
    }
    if (error instanceof StartupInterruptedError) {
      return;
    }

    backendLog.error('Fatal startup error', error);
    process.exit(1);
  }
}

if (typeof __IS_CORAL_BACKEND_MAIN__ !== 'undefined' && __IS_CORAL_BACKEND_MAIN__) {
  void main();
}
