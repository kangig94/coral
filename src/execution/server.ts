declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;
declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatError,
  isNoEntryError,
  isRecord,
  readBundleHash,
} from '../shared/mcp-utils.js';
import { kbRoot, pluginRootNamespace, resolveProjectSource } from '../infra/paths.js';
import type { ExecutionService } from './service.js';
import { activeChildren, killAllChildren, queueDepth, spawnCli } from './engine.js';
import { readBackendInfo, writeBackendInfo, removeBackendInfoIfOwner } from '../infra/backend-info.js';
import { acquireLock, BackendAlreadyRunningError, removeLockIfOwner } from './backend-lock.js';
import type { AbortResult } from './abort-registry.js';
import { RecoveryRegistry } from './recovery-registry.js';

import { eventBus, type EventBusEvents } from './event-bus.js';
import { IdleTimer } from './idle-timer.js';
import { ProgressStore } from './progress-store.js';
import type { CallerContext } from './request-context.js';
import { SessionIndex } from './session-index.js';
import { SessionManager } from './session-manager.js';
import {
  type DiscussContext,
} from './discuss/context.js';
import {
  createDiscussContextRegistry,
  getOrCreate as getOrCreateDiscussContext,
  hasRunningSessions,
  listAttachedSessions,
  type DiscussContextRegistry,
} from './discuss/context-registry.js';
import {
  DiscussSessionStore,
} from './discuss/session-store.js';
import * as discussOperations from './discuss/operations.js';
import {
  buildDiscussDetail,
  buildDiscussSummary,
  type DiscussAuthority,
  type DiscussDetailResponse,
  type DiscussSummaryDto,
  type DiscussView,
} from '../client/discuss.js';
import {
  readDiscussSources,
} from '../client/readers.js';
import { getNewProvider } from '../providers/registry.js';
import { registerBuiltInProviders } from '../providers/bootstrap.js';
import {
  ExecutionService as DefaultExecutionService,
} from './service.js';
import {
  belongsToNamespace,
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
import {
  routeToolCall,
  getToolDescriptors,
  type CreateKbSubsystemFn,
  type ExecutionServiceLike,
  type KbSubsystem,
  type RouteToolCallFn,
  type ScopeCheckResult,
} from './tool-router.js';
import { createHttpHandler, sendJson } from './http-handler.js';
import type { EventStreamHandlers, HttpHandlerDeps } from './backend-contracts.js';

export { routeToolCall, getToolDescriptors };

export type LifecycleState = 'starting' | 'running' | 'draining' | 'stopped';

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
  createExecutionService?: (ctx: CallerContext) => ExecutionServiceLike;
  acquireLockFn?: (pluginRoot: string, instanceId: string, version: string, bundleHash: string) => Promise<void>;
  writeBackendInfoFn?: typeof writeBackendInfo;
  removeBackendInfoIfOwnerFn?: typeof removeBackendInfoIfOwner;
  removeLockIfOwnerFn?: typeof removeLockIfOwner;
  routeToolCallFn?: RouteToolCallFn;
  closeServerFn?: (server: Server) => Promise<void>;
  recoverOrphanedJobsFn?: (namespace: string) => void;
  cleanupStaleJobsFn?: (currentBundleHash: string) => void;
  markJobsAsErrorFn?: (namespace: string, message: string) => void;
  killAllChildrenFn?: () => void;
  createKbSubsystemFn?: CreateKbSubsystemFn;
  onStopped?: () => void;
  onFatalShutdownError?: (error: unknown) => void;
  discussRegistry?: DiscussContextRegistry;
};

export type BackendServerInfo = {
  port: number;
  host: string;
  token: string;
  version: string;
  bundleHash: string;
  namespace: string;
  instanceId: string;
  startedAt: number;
};

export type BackendServerController = {
  server: Server;
  start: () => Promise<BackendServerInfo>;
  shutdown: (reason: string) => Promise<void>;
  waitForShutdown: () => Promise<void>;
  getLifecycle: () => LifecycleState;
  getIdleTimer: () => IdleTimer;
};

const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const HANDOFF_DRAIN_TIMEOUT_MS = 30_000;
const SHUTDOWN_POLL_MS = 50;
const ORPHANED_JOB_NOTICE = 'Unclean shutdown - orphaned job';
const OLD_FORMAT_NOTICE = 'Incompatible job format — missing durable launch record. Job predates the handoff recovery system.';

/**
 * Shutdown mode derived from reason. Determines child process and job handling:
 * - handoff: preserve wrappers/children for recovery; do NOT mark jobs as error or kill children
 * - hard: kill children and mark jobs as error (current behavior)
 */
type ShutdownMode = 'handoff' | 'hard';

function shutdownModeFromReason(reason: string): ShutdownMode {
  if (reason === 'replaced' || reason === 'sigterm') return 'handoff';
  return 'hard';
}
const defaultPluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..', '..');
const globalDiscussRegistry = createDiscussContextRegistry();

// sendJson, readJsonBody, parseToolRequest, runOnResponseDone, and request
// parsers (isStringArray, isWaitCursor, parseWaitRequest, parseLastEventIdCursor,
// serializeWaitCursor) have moved to http-handler.ts.

function closeServer(server: Server): Promise<void> {
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

function waitForInflightDrain(idleTimer: IdleTimer, timeoutMs: number): Promise<void> {
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

function withBackendNamespace(
  status: PersistedStatusRecord,
  namespace: string,
): PersistedStatusRecord {
  return {
    ...status,
    backendNamespace: namespace,
  } as PersistedStatusRecord;
}

function listLiveJobs(progressStore: ProgressStore, namespace: string): PersistedStatusRecord[] {
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

function hasJobDir(progressStore: ProgressStore, jobId: string): boolean {
  try {
    statSync(progressStore.jobDir(jobId));
    return true;
  } catch (error: unknown) {
    if (isNoEntryError(error)) return false;
    throw error;
  }
}

function readSessionRefs(shardDir: string): Array<{ sessionId: string; provider: string }> {
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

type RecoveryClass = 'incompatible' | 'queued' | 'running' | 'terminal' | 'incomplete' | 'stale_dead' | null;

/**
 * Classify a job for recovery purposes.
 * - 'incompatible': live phase but missing launch.json (predates durable snapshot system)
 * - 'terminal': already finished, no recovery needed
 * - 'incomplete': launch.json exists but no status record (partial admission)
 * - 'queued': launch.json exists, phase is queued, no runtime.json yet
 * - 'running': launch.json + runtime.json exist, phase is running/launching, process may be alive
 * - 'stale_dead': like running but exit.json already written (process exited uncleanly)
 * - null: unrecognized state
 */
function classifyRecoverableJob(
  progressStore: ProgressStore,
  jobId: string,
): RecoveryClass {
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

  // Running recoverable: launch.json and runtime.json exist, phase is running/launching
  if (hasLaunch && hasRuntime && (status.phase === 'running' || status.phase === 'launching')) {
    if (hasExit) return 'stale_dead';
    return 'running';
  }

  return null;
}

function markJobAsError(
  progressStore: ProgressStore,
  status: PersistedStatusRecord,
  notice: string,
  log: (message: string) => void,
): void {
  const terminalResult: TerminalResult = status.jobKind === 'workflow'
    ? { content: '', notice, workflow: { steps: [] } }
    : { content: '', notice };
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

function recoverOrphanedJobs(progressStore: ProgressStore, namespace: string, log: (message: string) => void): void {
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
      const notice = progressStore.hasLaunchRecord(status.jobId)
        ? ORPHANED_JOB_NOTICE
        : OLD_FORMAT_NOTICE;
      markJobAsError(progressStore, status, notice, log);
      const sessionManager = new SessionManager(status.projectRoot);
      sessionManager.releaseJob(status.sessionId, status.jobId);
      log(`Recovered orphaned job: ${status.jobId}\n`);
    } catch (err) {
      log(`Failed to recover orphaned job ${status.jobId}: ${formatError(err)}\n`);
    }
  }
}

function cleanupStaleJobs(progressStore: ProgressStore, currentBundleHash: string, log: (message: string) => void): void {
  for (const jobId of progressStore.listJobIds()) {
    const status = progressStore.readStatus(jobId);
    if (!status) continue;
    if (!isTerminalPhase(status.phase)) continue;
    if (!status.bundleHash || status.bundleHash === currentBundleHash) continue;

    try {
      rmSync(progressStore.jobDir(jobId), { recursive: true, force: true });
      log(`Cleaned up stale job: ${jobId}\n`);
    } catch {
      // best-effort
    }
  }
}

function markJobsAsError(progressStore: ProgressStore, namespace: string, message: string): void {
  for (const status of listLiveJobs(progressStore, namespace)) {
    try {
      markJobAsError(progressStore, status, message, () => {});
    } catch {
      // fail-isolated: skip this job, continue with others
    }
  }
}

async function createKbSubsystem({
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

// writeSseEvent has moved to http-handler.ts.

/** Returns a URL-ready host: IPv6 addresses are wrapped in brackets. */
function resolveClientHost(bindHost: string): string {
  const override = process.env.CORAL_BACKEND_ADVERTISE_HOST;
  const host = override
    ?? (bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost === '::' ? '::1' : bindHost);
  return host.includes(':') ? `[${host}]` : host;
}

async function listen(server: Server, bindHost: string): Promise<{ port: number; host: string }> {
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

export function createBackendServer(options: BackendServerOptions = {}): BackendServerController {
  const resolvedPluginRoot = options.pluginRoot ?? defaultPluginRoot;
  const namespace = pluginRootNamespace(resolvedPluginRoot);
  const version = options.version ?? (typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0');
  const bundleHash = options.bundleHash ?? readBundleHash(resolvedPluginRoot);
  const instanceId = options.instanceId ?? randomUUID();
  const token = options.token ?? randomBytes(32).toString('hex');
  const idleTimer = options.createIdleTimer?.() ?? new IdleTimer();
  const discussRegistry = options.discussRegistry ?? globalDiscussRegistry;
  const progressStore = options.progressStore ?? new ProgressStore();
  const sessionIndex = new SessionIndex();
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message: string) => {
    process.stderr.write(message);
  });
  const createExecutionService = options.createExecutionService
    ?? ((ctx: CallerContext) => new DefaultExecutionService(ctx, progressStore, bundleHash));
  const acquireLockFn = options.acquireLockFn ?? acquireLock;
  const writeBackendInfoFn = options.writeBackendInfoFn ?? writeBackendInfo;
  const removeBackendInfoIfOwnerFn = options.removeBackendInfoIfOwnerFn ?? removeBackendInfoIfOwner;
  const removeLockIfOwnerFn = options.removeLockIfOwnerFn ?? removeLockIfOwner;
  const routeToolCallFn = options.routeToolCallFn ?? routeToolCall;
  const closeServerFn = options.closeServerFn ?? closeServer;
  const recoverOrphanedJobsFn = options.recoverOrphanedJobsFn ?? ((currentNamespace: string) => {
    recoverOrphanedJobs(progressStore, currentNamespace, log);
  });
  const cleanupStaleJobsFn = options.cleanupStaleJobsFn ?? ((currentBundleHash: string) => {
    cleanupStaleJobs(progressStore, currentBundleHash, log);
  });
  const markJobsAsErrorFn = options.markJobsAsErrorFn ?? ((currentNamespace: string, message: string) => {
    markJobsAsError(progressStore, currentNamespace, message);
  });
  const killAllChildrenFn = options.killAllChildrenFn ?? killAllChildren;
  const createKbSubsystemFn = options.createKbSubsystemFn ?? createKbSubsystem;

  const services = new Map<string, ExecutionServiceLike>();
  const discussStores = new Map<string, DiscussSessionStore>();
  const streamResponses = new Set<ServerResponse>();
  let startedAt = now();
  let lifecycle: LifecycleState = 'starting';
  let shutdownPromise: Promise<void> | null = null;
  let started = false;
  let sessionIndexSubscribed = false;
  let kbSubsystem: KbSubsystem | null = null;
  let recoveryRegistry: RecoveryRegistry | null = null;
  let launchFenceActive = false;
  const adoptedRunningPids = new Map<string, { pid: number; pool: string }>();

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

  function getExecutionService(ctx: CallerContext): ExecutionServiceLike {
    const key = ctx.projectRoot;
    const existing = services.get(key);
    if (existing) return existing;
    const created = createExecutionService(ctx);
    services.set(key, created);
    return created;
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

  function abortJobs(jobIds: string[]): AbortResult {
    const pending = new Set(jobIds);
    const aborted: string[] = [];

    // Check recovery registry first
    if (recoveryRegistry && recoveryRegistry.size > 0) {
      const registryJobIds = [...pending].filter(id => recoveryRegistry!.has(id));
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

    const authority: DiscussAuthority = isLiveDiscussSession(source, sessionId)
      ? 'live'
      : 'persisted';
    return view === 'audit'
      ? buildDiscussDetail(snapshot, 'audit', authority)
      : buildDiscussDetail(snapshot, 'control', authority);
  }

  // -- Drain admission fence -------------------------------------------------
  // Flipped immediately by /admin/shutdown BEFORE lifecycle transitions to
  // 'draining'. This closes the pre-existing race window (AC4 behavior fix).
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
    runtimeState: {
      getLifecycle: () => lifecycle,
      getStartedAt: () => startedAt,
      getKbSubsystem: () => kbSubsystem,
      getLaunchFenceActive: () => launchFenceActive,
    },
    idleTimer,
    progressStore,
    sessionIndex,
    activeChildren,
    queueDepth,
    streamResponses,
    isDrainRequested: () => drainRequested,
    requestDrain: (reason: string) => {
      drainRequested = true;
      idleTimer.requestDrain(reason);
    },
    getExecutionService,
    getDiscussContext,
    abortJobs,
    scopeCheckJobs: (jobIds, projectRoot) => scopeCheckJobs(jobIds, projectRoot, namespace),
    routeToolCall: routeToolCallFn,
    getToolDescriptors,
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

  async function shutdown(reason: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      if (lifecycle === 'stopped') return;

      const mode = shutdownModeFromReason(reason);
      const drainTimeout = mode === 'handoff' ? HANDOFF_DRAIN_TIMEOUT_MS : SHUTDOWN_DRAIN_TIMEOUT_MS;

      log(`Coral backend shutting down (${reason}, mode=${mode})...\n`);
      lifecycle = 'draining';
      idleTimer.stopWatching();

      const serverClosed = closeServerFn(server);
      await waitForInflightDrain(idleTimer, drainTimeout);
      server.closeAllConnections?.();
      for (const stream of streamResponses) {
        stream.end();
      }
      await Promise.race([
        serverClosed,
        new Promise<void>((resolve) => setTimeout(resolve, drainTimeout)),
      ]);

      if (mode === 'hard') {
        markJobsAsErrorFn(namespace, 'Backend shutting down');
        killAllChildrenFn();
      }
      // handoff mode: detached wrappers continue, jobs remain in their current
      // phase for recovery by the replacement backend.

      unsubscribeSessionIndex();
      for (const store of discussStores.values()) {
        store.dispose();
      }

      removeBackendInfoIfOwnerFn(resolvedPluginRoot, instanceId);
      removeLockIfOwnerFn(resolvedPluginRoot, instanceId);

      lifecycle = 'stopped';
      options.onStopped?.();
    })().catch((error) => {
      lifecycle = 'stopped';
      options.onFatalShutdownError?.(error);
      throw error;
    });

    return shutdownPromise;
  }

  // handleWaitStream, handleEventStream, parseEventStreamFilter, and
  // handleRequest have moved to http-handler.ts (via createHttpHandler).

  async function runRecoveryAdoption(
    queuedJobs: Array<{ jobId: string; launchRecord: PersistedLaunchRecord }>,
    runningJobs: Array<{ jobId: string; launchRecord: PersistedLaunchRecord; runtimeRecord: PersistedRuntimeRecord }>,
  ): Promise<void> {
    // Sort queued jobs by enqueue sequence for FIFO ordering
    queuedJobs.sort((a, b) => a.launchRecord.enqueueSequence - b.launchRecord.enqueueSequence);

    // Adopt running jobs first — restore their active permits before fence lifts
    for (const { jobId, launchRecord, runtimeRecord } of runningJobs) {
      try {
        const ctx: CallerContext = { projectRoot: launchRecord.projectRoot, pluginRoot: resolvedPluginRoot, coralEnv: {} };
        const service = getExecutionService(ctx) as DefaultExecutionService;
        const { cleanup } = service.adoptRunningJob(launchRecord, runtimeRecord);

        // Track adopted PID
        adoptedRunningPids.set(jobId, { pid: runtimeRecord.pid, pool: launchRecord.pool });

        // Install PID poller to detect termination
        const pollInterval = setInterval(() => {
          let alive = false;
          try {
            process.kill(runtimeRecord.pid, 0);
            alive = true;
          } catch { /* pid already exited */ }

          if (!alive) {
            clearInterval(pollInterval);
            adoptedRunningPids.delete(jobId);

            const exitRecord = progressStore.readExitRecord(jobId);
            if (exitRecord) {
              // Finalize from durable artifacts via provider recovery
              const provider = getNewProvider(launchRecord.provider);
              if (provider?.recovery) {
                void provider.recovery.finalizeFromArtifacts({
                  stdoutPath: runtimeRecord.stdoutPath,
                  stderrPath: runtimeRecord.stderrPath,
                  exitCode: exitRecord.exitCode,
                  signal: exitRecord.signal,
                }).then((result) => {
                  const phase = result.aborted ? 'aborted' as const : 'completed' as const;
                  service.completeRecoveredJob(jobId, launchRecord.sessionId, {
                    content: result.content,
                    durationMs: result.durationMs,
                    aborted: result.aborted,
                    nonResumable: result.nonResumable,
                    exitCode: result.exitCode,
                    notice: result.notice,
                    errors: result.errors,
                    warnings: result.warnings,
                    usage: result.usage,
                  }, phase, {
                    conversationRef: result.conversationRef,
                    nonResumable: result.nonResumable,
                  });
                }).catch(() => {
                  service.completeRecoveredJob(jobId, launchRecord.sessionId, {
                    content: '',
                    notice: 'Provider recovery failed',
                  }, 'error');
                });
              } else {
                service.completeRecoveredJob(jobId, launchRecord.sessionId, {
                  content: '',
                  exitCode: exitRecord.exitCode,
                }, exitRecord.exitCode === 0 ? 'completed' : 'error');
              }
            } else {
              // PID dead + no exit.json = wrapper lost
              service.completeRecoveredJob(jobId, launchRecord.sessionId, {
                content: '',
                notice: 'Wrapper process lost — no exit.json found',
              }, 'error');
            }

            cleanup();
          }
        }, 5_000);
        pollInterval.unref?.();

        recoveryRegistry?.remove(jobId);
        log(`Adopted running job: ${jobId} (pid=${runtimeRecord.pid})\n`);
      } catch (err) {
        log(`Failed to adopt running job ${jobId}: ${formatError(err)}\n`);
        recoveryRegistry?.remove(jobId);
      }
    }

    // Recover queued jobs in FIFO order
    for (const { jobId, launchRecord } of queuedJobs) {
      try {
        const ctx: CallerContext = { projectRoot: launchRecord.projectRoot, pluginRoot: resolvedPluginRoot, coralEnv: {} };
        const service = getExecutionService(ctx) as DefaultExecutionService;
        service.recoverQueuedJob(launchRecord);
        recoveryRegistry?.remove(jobId);
        log(`Recovered queued job: ${jobId}\n`);
      } catch (err) {
        log(`Failed to recover queued job ${jobId}: ${formatError(err)}\n`);
        recoveryRegistry?.remove(jobId);
      }
    }

    // All entries migrated — dissolve registry and lift launch fence
    recoveryRegistry = null;
    launchFenceActive = false;
    log(`Recovery adoption complete. Launch fence lifted.\n`);
  }

  async function start(): Promise<BackendServerInfo> {
    if (started) {
      throw new Error('Backend server already started');
    }

    try {
      await acquireLockFn(resolvedPluginRoot, instanceId, version, bundleHash);
      registerBuiltInProviders();
      kbSubsystem = await createKbSubsystemFn({
        pluginRoot: resolvedPluginRoot,
        spawnCli,
      });
      subscribeSessionIndex();
      sessionIndex.hydrate(SessionManager.listShards());

      // Listen first so we're reachable during recovery
      const bindHost = process.env.CORAL_BACKEND_BIND ?? '127.0.0.1';
      const { port, host } = await listen(server, bindHost);
      startedAt = now();

      // Scan recoverable jobs and install recovery registry + launch fence
      launchFenceActive = true;
      recoveryRegistry = new RecoveryRegistry();
      const incompatibleJobs: PersistedStatusRecord[] = [];
      const queuedRecoverable: Array<{ jobId: string; launchRecord: PersistedLaunchRecord }> = [];
      const runningRecoverable: Array<{ jobId: string; launchRecord: PersistedLaunchRecord; runtimeRecord: PersistedRuntimeRecord }> = [];

      for (const jobId of progressStore.listJobIds()) {
        const classification = classifyRecoverableJob(progressStore, jobId);
        if (classification === 'incompatible') {
          const status = progressStore.readStatus(jobId);
          if (status) incompatibleJobs.push(status);
          continue;
        }
        if (classification === 'incomplete') {
          // Crash between launch.json write and status.json — delete directory
          try { rmSync(progressStore.jobDir(jobId), { recursive: true, force: true }); } catch { /* best-effort */ }
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
            recoveryRegistry.register(jobId, launchRecord, runtimeRecord);
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

      // Publish backend info (now reachable for wait/list/detail/abort via recovery registry)
      writeBackendInfoFn(resolvedPluginRoot, {
        pid: process.pid,
        port,
        host,
        token,
        version,
        bundleHash,
        namespace,
        instanceId,
        startedAt,
      });

      // Discuss session recovery
      for (const source of knownDiscussSources()) {
        await discussOperations.recoverPersistedSessionsFromStore(
          getDiscussStoreForSource(source),
          (snapshot) => getDiscussContext({
            projectRoot: snapshot.projectRoot,
            pluginRoot: resolvedPluginRoot,
            coralEnv: {},
          }),
        );
      }

      lifecycle = 'running';
      started = true;

      // Idle timer with namespace-based counting (AC10)
      idleTimer.startWatching(
        () => lifecycle === 'running'
          && activeChildren.size === 0
          && adoptedRunningPids.size === 0
          && progressStore.liveJobCountByNamespace(namespace) === 0
          && idleTimer.inflightRequests === 0
          && (recoveryRegistry === null || recoveryRegistry.size === 0)
          && !hasRunningSessions(discussRegistry)
          && !(kbSubsystem?.curateScheduler.isRunning() ?? false),
        (reason) => {
          void shutdown(reason).catch(() => {});
        },
      );

      // Self-terminate if another backend replaces this one (backend-info.json
      // will point to the replacement's instanceId). Covers the case where
      // ensureBackend's shutdown request is lost during rapid rebuild cycles.
      const ownershipChecker = setInterval(() => {
        if (lifecycle !== 'running' || idleTimer.isDraining) return;
        try {
          const current = readBackendInfo(resolvedPluginRoot);
          if (current !== null && current.instanceId !== instanceId) {
            clearInterval(ownershipChecker);
            idleTimer.requestDrain('replaced');
          }
        } catch {
          // read failure — skip this check
        }
      }, 30_000);
      ownershipChecker.unref();

      // Async recovery adoption — runs after we're already serving requests
      if (queuedRecoverable.length > 0 || runningRecoverable.length > 0) {
        void runRecoveryAdoption(queuedRecoverable, runningRecoverable).catch((err) => {
          log(`Recovery adoption failed: ${formatError(err)}\n`);
          // On failure, dissolve registry and lift fence so fresh launches can proceed
          recoveryRegistry = null;
          launchFenceActive = false;
        });
      } else {
        // No recoverable jobs — dissolve immediately
        recoveryRegistry = null;
        launchFenceActive = false;
      }

      return {
        port,
        host,
        token,
        version,
        bundleHash,
        namespace,
        instanceId,
        startedAt,
      };
    } catch (error: unknown) {
      lifecycle = 'stopped';
      idleTimer.stopWatching();
      unsubscribeSessionIndex();

      try {
        await closeServerFn(server);
      } catch {
        /* best effort */
      }
      removeBackendInfoIfOwnerFn(resolvedPluginRoot, instanceId);
      removeLockIfOwnerFn(resolvedPluginRoot, instanceId);

      throw error;
    }
  }

  return {
    server,
    start,
    shutdown,
    waitForShutdown: () => shutdownPromise ?? Promise.resolve(),
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
      process.stderr.write(`Fatal shutdown error: ${formatError(error)}\n`);
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
    process.stderr.write(`Coral backend running on ${info.host}:${info.port}\n`);
  } catch (error: unknown) {
    if (error instanceof BackendAlreadyRunningError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(0);
      return;
    }

    process.stderr.write(`Fatal startup error: ${formatError(error)}\n`);
    process.exit(1);
  }
}

if (typeof __IS_CORAL_BACKEND_MAIN__ !== 'undefined' && __IS_CORAL_BACKEND_MAIN__) {
  void main();
}
