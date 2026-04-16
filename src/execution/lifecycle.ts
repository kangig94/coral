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
import { type LaunchCoordinator, type SpawnCliFn } from './engine.js';
import { readBackendInfo, type writeBackendInfo, type removeBackendInfoIfOwner } from '../infra/backend-info.js';
import { RecoveryRegistry } from './recovery-registry.js';
import { type EventBusEvents, type TypedEventBus } from './event-bus.js';
import type { IdleTimer } from './idle-timer.js';
import { isPersistedStatusRecordLike, type ProgressStore } from './progress-store.js';
import type { CallerContext } from '../shared/request-context.js';
import type { SessionIndex } from './session-index.js';
import { listSessionShards, SessionManager } from './session-manager.js';
import type { DiscussContext } from './discuss/context.js';
import type { DiscussSessionStore } from './discuss/session-store.js';
import type { RecoveredDiscussResume } from './discuss/operations.js';
import { type ProviderRegistry } from '../providers/registry.js';
import { type RecoveryCapableService } from './service.js';
import {
  isAppServerRuntime,
  isLivePhase,
  isTerminalPhase,
  readBackendNamespace,
  type DurableCliRuntimeRecord,
  type PersistedExitRecord,
  type PersistedLaunchRecord,
  type PersistedRuntimeRecord,
  type PersistedStatusRecord,
  type SessionEntry,
  type TerminalResult,
} from '../shared/types.js';
import type { KbSubsystem } from './kb-tools.js';
import type { BackendIdentity, ExecutionServiceLike, MutableBackendRuntimeState } from './backend-contracts.js';
import type { ProviderHostManager } from './host-manager.js';
import type { BackendServerInfo } from './server-types.js';
import { planRecovery, type JobStoreSnapshot, type RecoveryAction } from './recovery-core.js';
import type { Runtime, RuntimeTimerHandle } from './runtime.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
export const HANDOFF_DRAIN_TIMEOUT_MS = 30_000;
export const SHUTDOWN_POLL_MS = 50;
export const RECOVERY_POLL_MS = 500;
const FOREIGN_DAEMON_LOCK_STALE_MS = 30_000;
const ADOPTION_CLAIM_STALE_MS = 30_000;
import { OLD_FORMAT_NOTICE, GHOST_LAUNCH_NOTICE } from './recovery-notices.js';
export { OLD_FORMAT_NOTICE, GHOST_LAUNCH_NOTICE };

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

export interface LifecycleHooks {
  onShutdown(mode: ShutdownMode): Promise<void>;
  onIdleCheck(): boolean;
  onRecoveryComplete(resumes: RecoveredDiscussResume[]): Promise<void>;
}

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

type AdoptionStatusSnapshot = {
  raw: string;
  record: PersistedStatusRecord;
};

type AdoptionClaimRecord = {
  ownerId: string;
  claimedAt: number;
  stagedPath: string;
  verifiedStatusRaw: string;
};

type AdoptionClaimSnapshot = {
  raw: string;
  record: AdoptionClaimRecord | null;
  mtimeMs: number;
};

function isAdoptionClaimRecord(value: unknown): value is AdoptionClaimRecord {
  return (
    isRecord(value) &&
    typeof value.ownerId === 'string' &&
    value.ownerId.length > 0 &&
    typeof value.claimedAt === 'number' &&
    Number.isFinite(value.claimedAt) &&
    typeof value.stagedPath === 'string' &&
    value.stagedPath.length > 0 &&
    typeof value.verifiedStatusRaw === 'string'
  );
}

function claimPathForStatus(statusPath: string): string {
  return `${statusPath}.adopt.lock`;
}

function stagedStatusPath(statusPath: string, ownerId: string): string {
  return `${statusPath}.adopt.stage.${ownerId}`;
}

function createAdoptionOwnerId(nowMs: number, ids: Pick<Runtime['ids'], 'randomBytes'>): string {
  return `${nowMs}-${ids.randomBytes(6).toString('hex')}`;
}

function readAdoptionStatusSnapshot(
  statusPath: string,
  storage: Pick<Runtime['storage'], 'readFileSync'>,
): AdoptionStatusSnapshot | null {
  try {
    const raw = storage.readFileSync(statusPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedStatusRecordLike(parsed)) return null;
    return {
      raw,
      record: parsed,
    };
  } catch {
    return null;
  }
}

function readAdoptionClaimSnapshot(
  claimPath: string,
  storage: Pick<Runtime['storage'], 'readFileSync' | 'statSync'>,
): AdoptionClaimSnapshot | null {
  try {
    const raw = storage.readFileSync(claimPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return {
      raw,
      record: isAdoptionClaimRecord(parsed) ? parsed : null,
      mtimeMs: storage.statSync(claimPath).mtimeMs,
    };
  } catch (error: unknown) {
    if (isNoEntryError(error)) return null;
    throw error;
  }
}

function unlinkIfPresent(path: string, storage: Pick<Runtime['storage'], 'unlinkSync'>): void {
  try {
    storage.unlinkSync(path);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}

function restoreClaimFileIfMissing(
  fromPath: string,
  toPath: string,
  storage: Pick<Runtime['storage'], 'existsSync' | 'renameSync'>,
): void {
  if (storage.existsSync(toPath)) return;
  try {
    storage.renameSync(fromPath, toPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}

function rollbackUnexpectedStagedStatus(
  statusPath: string,
  stagedPath: string,
  storage: Pick<Runtime['storage'], 'existsSync' | 'renameSync' | 'unlinkSync'>,
): void {
  if (!storage.existsSync(stagedPath)) return;

  if (!storage.existsSync(statusPath)) {
    try {
      storage.renameSync(stagedPath, statusPath);
      return;
    } catch (error: unknown) {
      if (!isNoEntryError(error)) throw error;
    }
  }

  unlinkIfPresent(stagedPath, storage);
}

function restoreVerifiedStagedStatus(
  statusPath: string,
  stagedPath: string,
  verifiedStatusRaw: string,
  storage: Pick<Runtime['storage'], 'existsSync' | 'readFileSync' | 'renameSync' | 'tryExclusiveWriteSync' | 'unlinkSync'>,
): void {
  let stagedRaw: string;
  try {
    stagedRaw = storage.readFileSync(stagedPath, 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }

  if (stagedRaw !== verifiedStatusRaw) {
    rollbackUnexpectedStagedStatus(statusPath, stagedPath, storage);
    return;
  }

  if (!storage.existsSync(statusPath)) {
    storage.tryExclusiveWriteSync(statusPath, stagedRaw, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  unlinkIfPresent(stagedPath, storage);
}

function stageVerifiedStatusSnapshot(
  statusPath: string,
  stagedPath: string,
  verifiedStatusRaw: string,
  storage: Pick<Runtime['storage'], 'readFileSync' | 'renameSync' | 'existsSync' | 'unlinkSync'>,
): boolean {
  try {
    storage.renameSync(statusPath, stagedPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return false;
    throw error;
  }

  let stagedRaw: string;
  try {
    stagedRaw = storage.readFileSync(stagedPath, 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) return false;
    throw error;
  }

  if (stagedRaw === verifiedStatusRaw) return true;

  rollbackUnexpectedStagedStatus(statusPath, stagedPath, storage);
  return false;
}

function removeAdoptionClaimIfOwner(
  claimPath: string,
  ownerId: string,
  storage: Pick<Runtime['storage'], 'existsSync' | 'readFileSync' | 'renameSync' | 'unlinkSync'>,
): void {
  const stagePath = `${claimPath}.removing.${ownerId}`;

  try {
    storage.renameSync(claimPath, stagePath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }

  try {
    const raw = storage.readFileSync(stagePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isAdoptionClaimRecord(parsed) || parsed.ownerId !== ownerId) {
      restoreClaimFileIfMissing(stagePath, claimPath, storage);
      return;
    }
    storage.unlinkSync(stagePath);
  } catch (error: unknown) {
    unlinkIfPresent(stagePath, storage);
    if (isNoEntryError(error) || error instanceof SyntaxError) return;
    throw error;
  }
}

function reapStaleAdoptionClaim(
  statusPath: string,
  runtime: Pick<Runtime, 'storage' | 'time' | 'ids'>,
): boolean {
  const claimPath = claimPathForStatus(statusPath);
  const snapshot = readAdoptionClaimSnapshot(claimPath, runtime.storage);
  if (snapshot === null) return true;

  const claimedAt = snapshot.record?.claimedAt ?? snapshot.mtimeMs;
  if (runtime.time.now() - claimedAt < ADOPTION_CLAIM_STALE_MS) {
    return false;
  }

  const reapingPath = `${claimPath}.reaping.${createAdoptionOwnerId(runtime.time.now(), runtime.ids)}`;
  try {
    runtime.storage.renameSync(claimPath, reapingPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return true;
    throw error;
  }

  try {
    const reapedRaw = runtime.storage.readFileSync(reapingPath, 'utf-8');
    if (reapedRaw !== snapshot.raw) {
      restoreClaimFileIfMissing(reapingPath, claimPath, runtime.storage);
      return false;
    }

    if (snapshot.record !== null) {
      restoreVerifiedStagedStatus(
        statusPath,
        snapshot.record.stagedPath,
        snapshot.record.verifiedStatusRaw,
        runtime.storage,
      );
    }

    runtime.storage.unlinkSync(reapingPath);
    return true;
  } catch (error: unknown) {
    unlinkIfPresent(reapingPath, runtime.storage);
    if (isNoEntryError(error)) return true;
    throw error;
  }
}

function tryAcquireAdoptionClaim(
  statusPath: string,
  verifiedStatusRaw: string,
  runtime: Pick<Runtime, 'storage' | 'time' | 'ids'>,
): AdoptionClaimRecord | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ownerId = createAdoptionOwnerId(runtime.time.now(), runtime.ids);
    const claimRecord: AdoptionClaimRecord = {
      ownerId,
      claimedAt: runtime.time.now(),
      stagedPath: stagedStatusPath(statusPath, ownerId),
      verifiedStatusRaw,
    };

    const acquired = runtime.storage.tryExclusiveWriteSync(claimPathForStatus(statusPath), JSON.stringify(claimRecord), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    if (acquired) return claimRecord;
    if (!reapStaleAdoptionClaim(statusPath, runtime)) return null;
  }

  return null;
}

/**
 * Adopt orphaned jobs from other namespaces whose daemon has died.
 *
 * When a plugin updates (e.g. 0.5.0→0.5.1), the plugin root path changes,
 * causing a namespace hash change. Jobs from the old namespace are invisible
 * to the new ProgressStore. This function runs BEFORE hydration to rebind
 * orphaned live jobs to the current namespace on disk.
 *
 * Safety: only adopts if the foreign namespace's daemon is confirmed dead
 * (backend.json missing or PID not alive). Jobs from live daemons (e.g.
 * a dev-flavor daemon during a prod upgrade) are never touched.
 */
export function adoptOrphanedCrossNamespaceJobs(
  currentNamespace: string,
  runtime: Pick<Runtime, 'storage' | 'paths' | 'process' | 'time' | 'ids'>,
  log: (message: string) => void,
): number {
  let adopted = 0;
  const jobsDir = runtime.paths.jobsDir();

  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = runtime.storage.readdirSync(jobsDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const statusPath = join(jobsDir, entry.name, 'status.json');
    const snapshot = readAdoptionStatusSnapshot(statusPath, runtime.storage);
    if (snapshot === null) continue;

    const { raw: verifiedStatusRaw, record } = snapshot;
    const foreignNs = readBackendNamespace(record);
    if (foreignNs === null || foreignNs === currentNamespace) continue;
    if (!isLivePhase(record.phase)) continue;

    if (isForeignDaemonAlive(foreignNs, runtime)) continue; // daemon alive → don't steal

    const claim = tryAcquireAdoptionClaim(statusPath, verifiedStatusRaw, runtime);
    if (claim === null) continue;

    try {
      const confirmedSnapshot = readAdoptionStatusSnapshot(statusPath, runtime.storage);
      if (confirmedSnapshot === null || confirmedSnapshot.raw !== verifiedStatusRaw) continue;
      if (!isLivePhase(confirmedSnapshot.record.phase)) continue;

      const confirmedNamespace = readBackendNamespace(confirmedSnapshot.record);
      if (confirmedNamespace !== foreignNs) continue;

      if (!stageVerifiedStatusSnapshot(statusPath, claim.stagedPath, verifiedStatusRaw, runtime.storage)) continue;

      if (isForeignDaemonAlive(foreignNs, runtime)) {
        restoreVerifiedStagedStatus(statusPath, claim.stagedPath, verifiedStatusRaw, runtime.storage);
        continue;
      }

      const rebound: PersistedStatusRecord = {
        ...confirmedSnapshot.record,
        backendNamespace: currentNamespace,
      };
      const published = runtime.storage.tryExclusiveWriteSync(statusPath, JSON.stringify(rebound, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      if (!published) {
        restoreVerifiedStagedStatus(statusPath, claim.stagedPath, verifiedStatusRaw, runtime.storage);
        continue;
      }

      unlinkIfPresent(claim.stagedPath, runtime.storage);
      adopted++;
      log(`Adopted orphaned job ${entry.name} from namespace ${foreignNs}\n`);
    } catch (error: unknown) {
      restoreVerifiedStagedStatus(statusPath, claim.stagedPath, verifiedStatusRaw, runtime.storage);
      log(`Failed to adopt orphaned job ${entry.name}: ${formatError(error)}\n`);
    } finally {
      removeAdoptionClaimIfOwner(claimPathForStatus(statusPath), claim.ownerId, runtime.storage);
    }
  }

  return adopted;
}

function isForeignDaemonAlive(
  foreignNamespace: string,
  runtime: Pick<Runtime, 'storage' | 'paths' | 'process' | 'time'>,
): boolean {
  const installDir = runtime.paths.installationDirForNamespace(foreignNamespace);
  const infoPath = join(installDir, 'backend.json');
  const lockPath = join(installDir, 'backend.lock');

  let backendRecord: { pid: number; instanceId: string } | null = null;
  try {
    const raw = runtime.storage.readFileSync(infoPath, 'utf-8');
    const info: unknown = JSON.parse(raw);
    if (
      isRecord(info) &&
      typeof info.pid === 'number' &&
      Number.isFinite(info.pid) &&
      typeof info.instanceId === 'string' &&
      info.instanceId.length > 0
    ) {
      backendRecord = { pid: info.pid, instanceId: info.instanceId };
    }
  } catch {
    backendRecord = null;
  }

  let lockMissing = false;
  let lockFresh = false;
  let lockRecord: { pid: number; instanceId: string } | null = null;
  try {
    const raw = runtime.storage.readFileSync(lockPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const ageMs = runtime.time.now() - runtime.storage.statSync(lockPath).mtimeMs;
    lockFresh = ageMs <= FOREIGN_DAEMON_LOCK_STALE_MS;
    if (
      isRecord(parsed) &&
      typeof parsed.pid === 'number' &&
      Number.isFinite(parsed.pid) &&
      typeof parsed.instanceId === 'string' &&
      parsed.instanceId.length > 0
    ) {
      lockRecord = { pid: parsed.pid, instanceId: parsed.instanceId };
    }
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      lockMissing = true;
    } else {
      return true;
    }
  }

  if (backendRecord === null) {
    return !lockMissing && lockFresh;
  }

  if (lockMissing || !lockFresh || lockRecord === null) {
    return false;
  }

  if (backendRecord.instanceId !== lockRecord.instanceId || backendRecord.pid !== lockRecord.pid) {
    return false;
  }

  return runtime.process.isAlive(backendRecord.pid);
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
) => Promise<RecoveredDiscussResume[]>;

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
  readonly hooks: LifecycleHooks;

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

type LifecycleControlState = {
  shutdownPromise: Promise<void> | null;
  started: boolean;
  sessionIndexSubscribed: boolean;
  recoveryRegistry: RecoveryRegistry | null;
  ownershipCheckerInterval: RuntimeTimerHandle | null;
  adoptedRunningPids: Map<string, { pid: number; pool: string }>;
  recoveryPollIntervals: Set<RuntimeTimerHandle>;
};

type ProviderLike = NonNullable<ReturnType<ProviderRegistry['get']>>;

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
    hooks,
    closeServerFn,
    listenFn,
    onStopped,
    onFatalShutdownError,
  } = deps;

  const { pluginRoot, namespace, version, bundleHash, flavor, instanceId, now, log } = identity;

  const state: LifecycleControlState = {
    shutdownPromise: null,
    started: false,
    sessionIndexSubscribed: false,
    recoveryRegistry: null,
    ownershipCheckerInterval: null,
    adoptedRunningPids: new Map<string, { pid: number; pool: string }>(),
    recoveryPollIntervals: new Set<RuntimeTimerHandle>(),
  };

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
    if (state.sessionIndexSubscribed) return;
    eventBus.on('session:updated', onSessionIndexUpdated);
    state.sessionIndexSubscribed = true;
  }

  function unsubscribeSessionIndex(): void {
    if (!state.sessionIndexSubscribed) return;
    eventBus.off('session:updated', onSessionIndexUpdated);
    state.sessionIndexSubscribed = false;
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

  function finalizeDeadAdoptedJob(
    jobId: string,
    launchRecord: PersistedLaunchRecord,
    runtimeRecord: DurableCliRuntimeRecord,
    service: RecoveryCapableService,
    provider: ProviderLike | undefined,
  ): void {
    const exitRecord = progressStore.readExitRecord(jobId);
    if (exitRecord) {
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
  }

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
          state.recoveryRegistry?.remove(jobId);
          log(`Recovered interrupted app-server job: ${jobId}\n`);
          continue;
        }

        let adoptedRuntimeRecord = runtimeRecord;
        assertStartupStillActive();
        ({ cleanup } = service.adoptRunningJob(launchRecord, runtimeRecord));
        assertStartupStillActive();

        // Track adopted PID
        state.adoptedRunningPids.set(jobId, { pid: runtimeRecord.pid, pool: launchRecord.pool });

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
            state.recoveryPollIntervals.delete(pollInterval);
            state.adoptedRunningPids.delete(jobId);

            drainRecoveredProgress();
            finalizeDeadAdoptedJob(jobId, launchRecord, runtimeRecord, service, provider);
            cleanup?.();
          }
        }, RECOVERY_POLL_MS);
        pollInterval.unref?.();
        state.recoveryPollIntervals.add(pollInterval);

        state.recoveryRegistry?.remove(jobId);
        log(`Adopted running job: ${jobId} (pid=${runtimeRecord.pid})\n`);
      } catch (err) {
        if (err instanceof StartupInterruptedError) {
          cleanup?.();
          throw err;
        }
        log(`Failed to adopt running job ${jobId}: ${formatError(err)}\n`);
        state.recoveryRegistry?.remove(jobId);
      }
    }

    // Recover queued jobs in FIFO order
    for (const { jobId, launchRecord } of queuedJobs) {
      try {
        const ctx: CallerContext = { projectRoot: launchRecord.projectRoot, pluginRoot, coralEnv: {} };
        const service = getRecoveryService(ctx);
        assertStartupStillActive();
        service.recoverQueuedJob(launchRecord);
        state.recoveryRegistry?.remove(jobId);
        log(`Recovered queued job: ${jobId}\n`);
      } catch (err) {
        if (err instanceof StartupInterruptedError) throw err;
        log(`Failed to recover queued job ${jobId}: ${formatError(err)}\n`);
        state.recoveryRegistry?.remove(jobId);
      }
    }

    // All entries migrated — dissolve registry and lift launch fence
    assertStartupStillActive();
    state.recoveryRegistry = null;
    runtimeState.setLaunchFenceActive(false);
    log(`Recovery adoption complete. Launch fence lifted.\n`);
  }

  // -- shutdown -------------------------------------------------------------

  async function shutdown(reason: string): Promise<void> {
    if (state.shutdownPromise) return state.shutdownPromise;

    state.shutdownPromise = (async () => {
      if (runtimeState.getLifecycle() === 'stopped') return;

      const mode = shutdownModeFromReason(reason);
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

      for (const interval of state.recoveryPollIntervals) runtime.time.clearInterval(interval);
      state.recoveryPollIntervals.clear();
      if (state.ownershipCheckerInterval) {
        runtime.time.clearInterval(state.ownershipCheckerInterval);
        state.ownershipCheckerInterval = null;
      }
      await Promise.race([
        runtimeState.getKbSubsystem()?.curateScheduler.stop?.(),
        runtime.time.sleep(5_000),
      ]);
      await runtimeState.getKbSubsystem()?.kb.closeVectorStores().catch((e: unknown) => { backendLog.warn(`closeVectorStores failed during shutdown: ${errorMessage(e)}`); });
      await hooks.onShutdown(mode);
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

    return state.shutdownPromise;
  }

  // -- start ----------------------------------------------------------------

  async function start(): Promise<BackendServerInfo> {
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
      state.recoveryRegistry = new RecoveryRegistry(runtime.process);
      const queuedRecoverable: Array<{ jobId: string; launchRecord: PersistedLaunchRecord }> = [];
      const runningRecoverable: Array<{
        jobId: string;
        launchRecord: PersistedLaunchRecord;
        runtimeRecord: PersistedRuntimeRecord;
      }> = [];
      // Adopt orphaned jobs from previous daemon versions (e.g. 0.5.0→0.5.1 upgrade)
      // before ProgressStore hydration so they appear in the recovery snapshot.
      const adoptedCount = adoptOrphanedCrossNamespaceJobs(namespace, runtime, log);
      if (adoptedCount > 0) {
        log(`Adopted ${adoptedCount} orphaned cross-namespace job(s)\n`);
      }

      const snapshot = buildRecoverySnapshot(progressStore, namespace, eventBus);
      const plan = planRecovery(snapshot);

      for (const action of [...plan.register, ...plan.cleanup]) {
        try {
          applyRecoveryAction(
            action,
            progressStore,
            state.recoveryRegistry,
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
          state.recoveryRegistry = null;
          runtimeState.setLaunchFenceActive(false);
        }
      } else {
        state.recoveryRegistry = null;
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
      state.started = true;

      // Idle timer with namespace-based counting
      idleTimer.startWatching(
        () =>
          runtimeState.getLifecycle() === 'running' &&
          launchCoordinator.active === 0 &&
          state.adoptedRunningPids.size === 0 &&
          progressStore.liveJobCountByNamespace(namespace) === 0 &&
          idleTimer.inflightRequests === 0 &&
          (state.recoveryRegistry === null || state.recoveryRegistry.size === 0) &&
          !hooks.onIdleCheck() &&
          !(runtimeState.getKbSubsystem()?.curateScheduler.isRunning() ?? false),
        (reason) => {
          void shutdown(reason).catch(() => {});
        },
      );

      // Self-terminate if another backend replaces this one (backend-info.json
      // will point to the replacement's instanceId). Covers the case where
      // ensureBackend's shutdown request is lost during rapid rebuild cycles.
      state.ownershipCheckerInterval = runtime.time.setInterval(() => {
        if (runtimeState.getLifecycle() !== 'running' || idleTimer.isDraining) return;
        try {
          const current = readBackendInfo(pluginRoot, runtime);
          // null means backend.json was deleted (replacement) or corrupt — drain either way
          if (current?.instanceId !== instanceId) {
            if (state.ownershipCheckerInterval !== null) {
              runtime.time.clearInterval(state.ownershipCheckerInterval);
              state.ownershipCheckerInterval = null;
            }
            idleTimer.requestDrain('replaced');
          }
        } catch {
          // read failure — skip this check
        }
      }, 30_000);
      state.ownershipCheckerInterval?.unref?.();

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
      if (error instanceof StartupInterruptedError && state.shutdownPromise !== null) {
        await state.shutdownPromise;
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
    waitForShutdown: () => state.shutdownPromise ?? Promise.resolve(),
    getRecoveryRegistry: () => state.recoveryRegistry,
  };
}
