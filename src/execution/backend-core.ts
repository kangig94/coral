declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { readBackendInfo, writeBackendInfo, removeBackendInfoIfOwner } from '../infra/backend-info.js';
import { createPluginRegistry } from '../infra/plugin-registry.js';
import { setBuildFlavor } from '../infra/paths.js';
import { readDiscussSourcesWithStorage, readStatusRecordWithStorage } from '../client/readers.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { AbortResult } from '../shared/execution-contracts.js';
import type { CallerContext } from '../shared/request-context.js';
import { belongsToNamespace } from '../shared/types.js';
import { formatError, readBuildFlavor, readBundleHash } from '../shared/utils.js';
import { backendLog } from '../shared/backend-log.js';
import {
  acquireLock,
  removeLockIfOwner,
  type BackendOwnershipState,
  type LockRecord,
  type VerifyBackendOwnershipFn,
} from './backend-lock.js';
import type {
  BackendIdentity,
  EventStreamHandlers,
  ExecutionServiceLike,
  HttpHandlerDeps,
  MutableBackendRuntimeState,
  ScopeCheckResult,
} from './backend-contracts.js';
import { LaunchCoordinator } from './engine.js';
import type { DiscussContext } from './discuss/context.js';
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
import { recoverPersistedDiscuss as defaultRecoverPersistedDiscuss } from './discuss/recovery.js';
import {
  knownDiscussSources,
  listDiscussSessions,
  loadDiscussDetail,
  type DiscussReadHelpersDeps,
} from './discuss/read-helpers.js';
import { DiscussSessionStore } from './discuss/session-store.js';
import { TypedEventBus } from './event-bus.js';
import { createProviderHostManager, type ProviderHostManager } from './host-manager.js';
import { createHttpHandler, sendJson } from './http-handler.js';
import { IdleTimer, resolveIdleTimeoutMs } from './idle-timer.js';
import { createKbSubsystem as defaultCreateKbSubsystem, type KbSubsystem } from './kb-tools.js';
import {
  cleanupStaleJobs,
  closeServer as defaultCloseServer,
  createLifecycle,
  listen as defaultListen,
  markJobsAsError,
  type CreateKbSubsystemFn,
  type LifecycleController,
  type LifecycleDeps,
  type LifecycleHooks,
  type RecoverPersistedDiscussFn,
  type RegisterBuiltInProvidersFn,
} from './lifecycle.js';
import { ProgressStore } from './progress-store.js';
import type { Runtime } from './runtime.js';
import type { LifecycleState } from './server-types.js';
import {
  type ExecutionService,
  type ExecutionServiceDeps,
  type RecoveryCapableService,
  ExecutionService as DefaultExecutionService,
} from './service.js';
import { SessionIndex } from './session-index.js';

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

export type BackendCoreOptions = {
  runtime: Runtime;
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

export type BackendCoreResult = {
  identity: BackendIdentity;
  server: Server;
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  lifecycleController: LifecycleController;
  sessionIndex: SessionIndex;
  idleTimer: IdleTimer;
  discussRegistry: DiscussContextRegistry;
  runtimeState: MutableBackendRuntimeState;
  progressStore: ProgressStore;
  eventBus: TypedEventBus;
  launchCoordinator: LaunchCoordinator;
  providerRegistry: ProviderRegistry;
  providerHostManager: ProviderHostManager;
  getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
  getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
  listExecutionServices: () => ExecutionServiceLike[];
  getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  getDiscussContext: (ctx: CallerContext) => DiscussContext;
  resolveProjectSource: (projectRoot: string) => string;
  isDrainRequested: () => boolean;
  requestDrain: (reason: string) => void;
  hooks: LifecycleHooks;
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

export function createBackendCore(options: BackendCoreOptions): BackendCoreResult {
  const runtime = options.runtime;
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
    options.acquireLockFn ?? ((pluginRoot, instanceId, currentVersion, currentBundleHash, currentFlavor) =>
      acquireLock(pluginRoot, instanceId, currentVersion, currentBundleHash, currentFlavor, {
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
  const registerBuiltInProvidersFn = options.registerBuiltInProvidersFn ?? (() => {});
  const recoverPersistedDiscussFn = options.recoverPersistedDiscussFn ?? defaultRecoverPersistedDiscuss;

  // Late-bound so abort/scope helpers can read the lifecycle recovery registry
  // after the HTTP deps and server have been assembled.
  let lifecycleController: LifecycleController | null = null;

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
    return getExecutionService(ctx) as unknown as RecoveryCapableService;
  }

  function listExecutionServices(): ExecutionServiceLike[] {
    return listInstantiatedExecutionServices(services);
  }

  function getDiscussStoreForSource(source: string): DiscussSessionStore {
    const existing = discussStores.get(source);
    if (existing) return existing;
    const created = new DiscussSessionStore(source, {
      storage: runtime.storage,
      time: runtime.time,
      paths: runtime.paths,
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
    const jobStatusReader = {
      read: (jobId: string) => readStatusRecordWithStorage(runtime.storage, runtime.paths, jobId),
    };
    return getOrCreateDiscussContext(
      discussRegistry,
      ctx.projectRoot,
      getExecutionService(ctx) as ExecutionService,
      store,
      jobStatusReader,
    );
  }

  const discussReadHelpersDeps: DiscussReadHelpersDeps = {
    discussRegistry,
    getDiscussStoreForSource,
    resolveProjectSource: resolveProjectSourceFn,
    readDiscussSources: () => readDiscussSourcesWithStorage(runtime.storage, runtime.paths),
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

  function abortJobs(jobIds: string[]): AbortResult {
    const pending = new Set(jobIds);
    const aborted: string[] = [];

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

      if (status.projectRoot !== projectRoot) {
        mismatch.push(jobId);
        continue;
      }

      if (belongsToNamespace(status, currentNamespace)) {
        valid.push(jobId);
        continue;
      }

      if (recoveryRegistry?.has(jobId)) {
        valid.push(jobId);
        continue;
      }

      mismatch.push(jobId);
    }

    return { valid, missing, mismatch };
  }

  // Flipped immediately by /admin/shutdown before lifecycle state changes to
  // draining. This preserves the existing admission fence semantics.
  let drainRequested = false;
  const isDrainRequested = () => drainRequested;
  const requestDrain = (reason: string) => {
    drainRequested = true;
    idleTimer.requestDrain(reason);
  };

  const identity: BackendIdentity = {
    pluginRoot: resolvedPluginRoot,
    namespace,
    version,
    bundleHash,
    flavor,
    instanceId,
    token,
    now,
    log,
  };

  const httpHandlerDeps: HttpHandlerDeps = {
    identity,
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
    isDrainRequested,
    requestDrain,
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

  const lifecycleDeps: LifecycleDeps = {
    identity,
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

  const resolvedLifecycleController = createLifecycle(lifecycleDeps);
  lifecycleController = resolvedLifecycleController;

  return {
    identity,
    server,
    handleRequest,
    lifecycleController: resolvedLifecycleController,
    sessionIndex,
    idleTimer,
    discussRegistry,
    runtimeState,
    progressStore,
    eventBus,
    launchCoordinator,
    providerRegistry,
    providerHostManager,
    getExecutionService,
    getRecoveryService,
    listExecutionServices,
    getDiscussStoreForSource,
    getDiscussContext,
    resolveProjectSource: resolveProjectSourceFn,
    isDrainRequested,
    requestDrain,
    hooks,
  };
}
