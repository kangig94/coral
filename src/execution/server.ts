declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;
declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { formatError, readBundleHash } from '../shared/mcp-utils.js';
import { backendLog } from '../shared/backend-log.js';
import { pluginRootNamespace, resolveProjectSource } from '../infra/paths.js';
import type { ExecutionService, ExecutionServiceDeps, RecoveryCapableService } from './service.js';
import { LaunchCoordinator } from './engine.js';
import { writeBackendInfo, removeBackendInfoIfOwner } from '../infra/backend-info.js';
import { acquireLock, BackendAlreadyRunningError, removeLockIfOwner } from './backend-lock.js';
import type { AbortResult } from './abort-registry.js';

import { TypedEventBus } from './event-bus.js';
import { IdleTimer } from './idle-timer.js';
import { ProgressStore } from './progress-store.js';
import type { CallerContext } from './request-context.js';
import { SessionIndex } from './session-index.js';
import { type DiscussContext } from './discuss/context.js';
import {
  createDiscussContextRegistry,
  getOrCreate as getOrCreateDiscussContext,
  listAttachedSessions,
  type DiscussContextRegistry,
} from './discuss/context-registry.js';
import { DiscussSessionStore } from './discuss/session-store.js';
import {
  buildDiscussDetail,
  buildDiscussSummary,
  type DiscussAuthority,
  type DiscussDetailResponse,
  type DiscussSummaryDto,
  type DiscussView,
} from '../discuss/views.js';
import { readDiscussSources } from '../client/readers.js';
import { ExecutionService as DefaultExecutionService } from './service.js';
import { belongsToNamespace } from '../shared/types.js';
import {
  routeToolCall,
  getToolDescriptors,
  type CreateKbSubsystemFn,
  type KbSubsystem,
  type RouteToolCallFn,
} from './tool-router.js';
import { createHttpHandler, sendJson } from './http-handler.js';
import type {
  EventStreamHandlers,
  ExecutionServiceLike,
  HttpHandlerDeps,
  MutableBackendRuntimeState,
  ScopeCheckResult,
} from './backend-contracts.js';
import { createProviderHostManager, type ProviderHostManager } from './host-manager.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  closeServer as defaultCloseServer,
  createKbSubsystem as defaultCreateKbSubsystem,
  listen as defaultListen,
  recoverOrphanedJobs,
  cleanupStaleJobs,
  markJobsAsError,
  createLifecycle,
  StartupInterruptedError,
  type LifecycleDeps,
  type LifecycleController,
} from './lifecycle.js';
import type { BackendServerInfo, LifecycleState } from './server-types.js';

export { routeToolCall, getToolDescriptors };

type BackendServerOptions = {
  progressStore?: ProgressStore;
  pluginRoot?: string;
  version?: string;
  bundleHash?: string;
  instanceId?: string;
  token?: string;
  now?: () => number;
  log?: (message: string) => void;
  createIdleTimer?: () => IdleTimer;
  createExecutionService?: (
    ctx: CallerContext,
    deps: ExecutionServiceDeps,
  ) => ExecutionServiceLike;
  acquireLockFn?: (pluginRoot: string, instanceId: string, version: string, bundleHash: string) => Promise<void>;
  writeBackendInfoFn?: typeof writeBackendInfo;
  removeBackendInfoIfOwnerFn?: typeof removeBackendInfoIfOwner;
  removeLockIfOwnerFn?: typeof removeLockIfOwner;
  routeToolCallFn?: RouteToolCallFn;
  closeServerFn?: (server: Server) => Promise<void>;
  recoverOrphanedJobsFn?: (namespace: string) => void;
  cleanupStaleJobsFn?: (currentBundleHash: string) => void;
  markJobsAsErrorFn?: (namespace: string, message: string) => void;
  terminateAllFn?: () => void;
  createKbSubsystemFn?: CreateKbSubsystemFn;
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
const defaultPluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..', '..');

export function listInstantiatedExecutionServices(
  services: ReadonlyMap<string, ExecutionServiceLike>,
): ExecutionServiceLike[] {
  return [...services.values()];
}

export function createBackendServer(options: BackendServerOptions = {}): BackendServerController {
  const resolvedPluginRoot = options.pluginRoot ?? defaultPluginRoot;
  const namespace = pluginRootNamespace(resolvedPluginRoot);
  const version = options.version ?? (typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0');
  const bundleHash = options.bundleHash ?? readBundleHash(resolvedPluginRoot);
  const instanceId = options.instanceId ?? randomUUID();
  const token = options.token ?? randomBytes(32).toString('hex');
  const idleTimer = options.createIdleTimer?.() ?? new IdleTimer();
  const launchCoordinator = options.launchCoordinator ?? new LaunchCoordinator();
  const eventBus = options.eventBus ?? options.progressStore?.getEventBus() ?? new TypedEventBus();
  const providerRegistry = options.providerRegistry ?? new ProviderRegistry();
  const discussRegistry = options.discussRegistry ?? createDiscussContextRegistry();
  const progressStore = options.progressStore ?? new ProgressStore(eventBus);
  const providerHostManager =
    options.providerHostManager ??
    createProviderHostManager({
      spawnProviderServer: launchCoordinator.spawnProviderServer.bind(launchCoordinator),
    });
  const sessionIndex = new SessionIndex();
  const now = options.now ?? (() => Date.now());
  backendLog.init({ version, bundleHash });
  const log =
    options.log ??
    ((message: string) => {
      backendLog.raw(message);
    });
  const createExecutionService =
    options.createExecutionService ??
    ((ctx: CallerContext, deps) => new DefaultExecutionService(ctx, deps));
  const acquireLockFn = options.acquireLockFn ?? acquireLock;
  const writeBackendInfoFn = options.writeBackendInfoFn ?? writeBackendInfo;
  const removeBackendInfoIfOwnerFn = options.removeBackendInfoIfOwnerFn ?? removeBackendInfoIfOwner;
  const removeLockIfOwnerFn = options.removeLockIfOwnerFn ?? removeLockIfOwner;
  const routeToolCallFn =
    options.routeToolCallFn ??
    ((request, helpers, kbSubsystem) => routeToolCall(request, helpers, kbSubsystem));
  const closeServerFn = options.closeServerFn ?? defaultCloseServer;
  const recoverOrphanedJobsFn =
    options.recoverOrphanedJobsFn ??
    ((currentNamespace: string) => {
      recoverOrphanedJobs(progressStore, currentNamespace, log, eventBus);
    });
  const cleanupStaleJobsFn =
    options.cleanupStaleJobsFn ??
    ((currentBundleHash: string) => {
      cleanupStaleJobs(progressStore, currentBundleHash, log);
    });
  const markJobsAsErrorFn =
    options.markJobsAsErrorFn ??
    ((currentNamespace: string, message: string) => {
      markJobsAsError(progressStore, currentNamespace, message);
    });
  const terminateAllFn = options.terminateAllFn ?? (() => launchCoordinator.terminateAll());
  const createKbSubsystemFn = options.createKbSubsystemFn ?? defaultCreateKbSubsystem;

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

  // -- Service factories (shared between lifecycle, HTTP handler, tool router)
  function getExecutionService(ctx: CallerContext): ExecutionServiceLike {
    const key = ctx.projectRoot;
    const existing = services.get(key);
    if (existing) return existing;
    const created = createExecutionService(ctx, {
      progressStore,
      bundleHash,
      providerHostManager,
      launchCoordinator,
      eventBus,
      providerRegistry,
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
    return getDiscussStoreForSource(resolveProjectSource(projectRoot));
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

  // -- Discuss read helpers -------------------------------------------------
  function knownDiscussSources(): Set<string> {
    const sources = new Set<string>();
    for (const source of readDiscussSources()) {
      sources.add(source);
    }
    for (const liveSession of listAttachedSessions(discussRegistry)) {
      sources.add(resolveProjectSource(liveSession.projectRoot));
    }
    return sources;
  }

  function listDiscussSessions(): DiscussSummaryDto[] {
    const results = new Map<string, DiscussSummaryDto>();

    for (const source of knownDiscussSources()) {
      for (const summary of getDiscussStoreForSource(source).listSummariesFromIndex()) {
        const key = `${source}\u0000${summary.sessionId}`;
        results.set(key, summary);
      }
    }

    for (const liveSession of listAttachedSessions(discussRegistry)) {
      const snapshot = liveSession.session.snapshot;
      const summary = buildDiscussSummary(snapshot, 'live');
      const source = resolveProjectSource(liveSession.projectRoot);
      results.set(`${source}\u0000${summary.sessionId}`, summary);
    }

    return [...results.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  function isLiveDiscussSession(source: string, sessionId: string): boolean {
    for (const liveSession of listAttachedSessions(discussRegistry)) {
      if (liveSession.sessionId === sessionId && resolveProjectSource(liveSession.projectRoot) === source) {
        return true;
      }
    }
    return false;
  }

  function loadDiscussDetail(
    source: string,
    sessionId: string,
    view: DiscussView,
  ): DiscussDetailResponse | 'audit_requires_ended_session' | null {
    const snapshot = getDiscussStoreForSource(source).load(sessionId);
    if (!snapshot) {
      return null;
    }
    if (view === 'audit' && snapshot.state.status !== 'ended') {
      return 'audit_requires_ended_session';
    }

    const authority: DiscussAuthority = isLiveDiscussSession(source, sessionId) ? 'live' : 'persisted';
    if (view === 'audit') {
      return buildDiscussDetail(snapshot, 'audit', authority);
    }
    return buildDiscussDetail(snapshot, 'control', authority);
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
      instanceId,
      token,
      now,
      log,
    },
    runtimeState,
    idleTimer,
    progressStore,
    sessionIndex,
    activeLaunchCount: () => launchCoordinator.active,
    queueDepth: () => launchCoordinator.queueDepth(),
    streamResponses,
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
    routeToolCall: routeToolCallFn,
    getToolDescriptors: () => getToolDescriptors(providerRegistry),
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
    listDiscussSessions,
    loadDiscussDetail,
  };

  const handleRequest = createHttpHandler(httpHandlerDeps);

  const server = createServer((req, res) => {
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
    getExecutionService,
    getRecoveryService,
    listExecutionServices,
    getDiscussStoreForSource,
    knownDiscussSources,
    getDiscussContext,
    acquireLockFn,
    writeBackendInfoFn,
    removeBackendInfoIfOwnerFn,
    removeLockIfOwnerFn,
    recoverOrphanedJobsFn,
    cleanupStaleJobsFn,
    markJobsAsErrorFn,
    terminateAllFn,
    providerHostManager,
    createKbSubsystemFn,
    closeServerFn,
    listenFn: defaultListen,
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
