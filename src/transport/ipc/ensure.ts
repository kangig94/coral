declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pluginRootNamespace } from '../../infra/plugin-identity.js';
import { createRealRuntime } from '../../runtime/real.js';
import type { CoordinatorPaths } from '../../infra/path/index.js';
import { HEALTH_TIMEOUT_MS } from '../http/sse.js';
import { BackendUnreachableError } from '../../infra/http-errors.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { isRecord } from '../../infra/json.js';
import { readBuildFlavor, readBundleHash } from '../../infra/bundle-manifest.js';
import { createIpcClient, type IpcClient } from './client.js';
import { bindSocket } from './server.js';
import { IncumbentMatchesError, requestIncumbentShutdown, type DesiredIncumbentIdentity } from './handoff.js';
import { shutdownBackend } from '../http/backend/shutdown.js';
import type { TransportSubsystemStatus } from '../server-ports.js';
import type { TimePort } from '../../infra/port-types.js';
import { CoralSetupError, type SerializedCoralSetupError } from '../../runtime/errors.js';
export const STARTUP_POLL_MS = 200;
/** Time budget for the daemon to bind its socket / answer first health probe. */
export const KERNEL_BIND_DEADLINE_MS = 5_000;
/** Time budget for the daemon to reach a usable lifecycle phase (kernel-ready or running). */
export const KERNEL_READY_DEADLINE_MS = 15_000;
/**
 * Time budget for the previous daemon to release the socket after shutdown
 * request. Mirrors `HANDOFF_DRAIN_TIMEOUT_MS` in `coordinator/shutdown.ts` —
 * defined locally here to avoid a transport→coordinator import cycle. The
 * coordinator side is canonical; the two must stay in sync.
 */
export const HANDOFF_DRAIN_TIMEOUT_MS = 30_000;
export const LOG_ROTATE_THRESHOLD_BYTES = 2 * 1024 * 1024;

export type DesiredCoordinator = {
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
};

export type RawCoordinatorHealth = {
  status: 'starting' | 'kernel-ready' | 'ok' | 'running' | 'draining';
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  instanceId: string;
  namespace: string;
  pid?: number;
  processStartedAt?: number;
  subsystems?: TransportSubsystemStatus[];
};

export type VerifiedBackendInfo = {
  pid: number;
  port: number;
  socketPath: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  startedAt: number;
  token: string;
  shutdownToken?: string;
  host: string;
  version: string;
  instanceId: string;
  processStartedAt?: number;
};

export type EnsuredIpcClient = IpcClient & {
  readonly instanceId: string;
  readonly bundleHash: string;
  readonly flavor: 'prod' | 'dev';
  readonly namespace: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly version: string;
};

type SpawnedCoordinator = {
  readonly pid: number;
  readonly attemptId: string;
  readonly spawnedAt: number;
};

type BackendReadyWaitContext =
  | { readonly kind: 'current-attempt'; readonly attemptId: string; readonly spawnedAt: number }
  | { readonly kind: 'existing-starting' };

type StartupErrorSentinel = {
  readonly version: 1;
  readonly attemptId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly socketPath: string;
  readonly bundleHash: string;
  readonly flavor: 'prod' | 'dev';
  readonly namespace: string;
  readonly error: SerializedCoralSetupError;
};

function summarizeBackend(info: VerifiedBackendInfo, timePort: TimePort): EnsuredIpcClient {
  return Object.assign(createIpcClient(info.socketPath, timePort), {
    instanceId: info.instanceId,
    bundleHash: info.bundleHash,
    flavor: info.flavor,
    namespace: info.namespace,
    host: info.host,
    port: info.port,
    token: info.token,
    version: info.version,
  });
}

function currentVersion(root: string): string {
  const fallbackVersion = typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0';
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    return isRecord(pkg) && typeof pkg.version === 'string' ? pkg.version : fallbackVersion;
  } catch {
    return fallbackVersion;
  }
}

function isRawCoordinatorHealth(value: unknown): value is RawCoordinatorHealth {
  return (
    isRecord(value) &&
    (value.status === 'starting' ||
      value.status === 'kernel-ready' ||
      value.status === 'ok' ||
      value.status === 'running' ||
      value.status === 'draining') &&
    typeof value.version === 'string' &&
    typeof value.bundleHash === 'string' &&
    (value.flavor === 'prod' || value.flavor === 'dev') &&
    typeof value.instanceId === 'string' &&
    value.instanceId.length > 0 &&
    typeof value.namespace === 'string' &&
    value.namespace.length > 0 &&
    (value.subsystems === undefined || Array.isArray(value.subsystems))
  );
}

/**
 * Treat both legacy `'ok'` and the new lifecycle phases (`'kernel-ready'`,
 * `'running'`) as "the daemon is ready to serve requests". Older composition
 * layers may map kernel-ready/running to legacy `'ok'`; newer ones report the
 * lifecycle phase directly.
 */
function isReadyStatus(status: RawCoordinatorHealth['status']): boolean {
  return status === 'ok' || status === 'kernel-ready' || status === 'running';
}

function isVerifiedBackendInfo(value: unknown): value is VerifiedBackendInfo {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.pid) &&
    (record.pid as number) > 0 &&
    Number.isInteger(record.port) &&
    (record.port as number) > 0 &&
    typeof record.socketPath === 'string' &&
    record.socketPath.length > 0 &&
    (record.host === undefined || (typeof record.host === 'string' && record.host.length > 0)) &&
    typeof record.token === 'string' &&
    record.token.length > 0 &&
    (record.shutdownToken === undefined ||
      (typeof record.shutdownToken === 'string' && record.shutdownToken.length > 0)) &&
    typeof record.version === 'string' &&
    record.version.length > 0 &&
    typeof record.bundleHash === 'string' &&
    record.bundleHash.length > 0 &&
    (record.flavor === 'prod' || record.flavor === 'dev') &&
    typeof record.instanceId === 'string' &&
    record.instanceId.length > 0 &&
    typeof record.namespace === 'string' &&
    record.namespace.length > 0 &&
    Number.isFinite(record.startedAt) &&
    (record.startedAt as number) > 0 &&
    (record.processStartedAt === undefined ||
      (Number.isInteger(record.processStartedAt) && (record.processStartedAt as number) > 0))
  );
}

function isSerializedStartupError(value: unknown): value is SerializedCoralSetupError {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.userMessage === 'string' &&
    typeof value.remediation === 'string'
  );
}

function isStartupErrorSentinel(value: unknown): value is StartupErrorSentinel {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.attemptId === 'string' &&
    Number.isInteger(value.pid) &&
    (value.pid as number) > 0 &&
    Number.isFinite(value.startedAt) &&
    (value.startedAt as number) > 0 &&
    typeof value.socketPath === 'string' &&
    typeof value.bundleHash === 'string' &&
    (value.flavor === 'prod' || value.flavor === 'dev') &&
    typeof value.namespace === 'string' &&
    isSerializedStartupError(value.error)
  );
}

async function readRawCoordinatorHealth(client: IpcClient): Promise<RawCoordinatorHealth | null> {
  try {
    const health = await client.health<unknown>({ timeoutMs: HEALTH_TIMEOUT_MS });
    return isRawCoordinatorHealth(health) ? health : null;
  } catch {
    return null;
  }
}

function readDiscoverySnapshot(paths: CoordinatorPaths): VerifiedBackendInfo | null {
  try {
    const raw = readFileSync(paths.infoFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    record.host ??= '127.0.0.1';
    return isVerifiedBackendInfo(record) ? record : null;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function mergeDiscoveryWithHealth(info: VerifiedBackendInfo, health: RawCoordinatorHealth): VerifiedBackendInfo {
  return {
    ...info,
    version: health.version,
    bundleHash: health.bundleHash,
    flavor: health.flavor,
    instanceId: health.instanceId,
    namespace: health.namespace,
  };
}

function isCompatibleHealth(health: RawCoordinatorHealth, desired: DesiredCoordinator): boolean {
  return (
    health.bundleHash === desired.bundleHash &&
    health.flavor === desired.flavor &&
    health.namespace === desired.namespace
  );
}

function startupSentinelIdentityMatches(
  sentinel: StartupErrorSentinel,
  paths: CoordinatorPaths,
  desired: DesiredCoordinator,
): boolean {
  return (
    sentinel.socketPath === paths.socketPath &&
    sentinel.bundleHash === desired.bundleHash &&
    sentinel.flavor === desired.flavor &&
    sentinel.namespace === desired.namespace
  );
}

function readStartupErrorSentinel(paths: CoordinatorPaths): { sentinel: StartupErrorSentinel; mtimeMs: number } | null {
  try {
    const raw = readFileSync(paths.startupErrorFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isStartupErrorSentinel(parsed)) return null;
    return { sentinel: parsed, mtimeMs: statSync(paths.startupErrorFile).mtimeMs };
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function clearStartupErrorSentinel(paths: CoordinatorPaths): void {
  try {
    unlinkSync(paths.startupErrorFile);
  } catch {
    // absent or already removed
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function matchingStartupError(
  paths: CoordinatorPaths,
  desired: DesiredCoordinator,
  waitContext: BackendReadyWaitContext,
  observedPid?: number,
): CoralSetupError | null {
  const record = readStartupErrorSentinel(paths);
  if (!record) return null;

  const { sentinel, mtimeMs } = record;
  if (!startupSentinelIdentityMatches(sentinel, paths, desired)) {
    return null;
  }

  if (waitContext.kind === 'current-attempt') {
    if (sentinel.attemptId !== waitContext.attemptId) {
      return null;
    }
    const earliestMtime = waitContext.spawnedAt - STARTUP_POLL_MS;
    const latestMtime = waitContext.spawnedAt + KERNEL_READY_DEADLINE_MS;
    if (mtimeMs < earliestMtime || mtimeMs > latestMtime) {
      return null;
    }
    return new CoralSetupError(sentinel.error);
  }

  if (observedPid !== undefined && sentinel.pid !== observedPid) {
    return null;
  }
  if (!isPidAlive(sentinel.pid)) {
    clearStartupErrorSentinel(paths);
    return null;
  }
  return new CoralSetupError(sentinel.error);
}

function rotateLogIfLarge(runDir: string): void {
  const path = join(runDir, 'coordinator.log');
  const archive = `${path}.1`;
  try {
    if (statSync(path).size < LOG_ROTATE_THRESHOLD_BYTES) return;
    try {
      unlinkSync(archive);
    } catch {
      // no prior archive
    }
    renameSync(path, archive);
  } catch {
    // no current log, or fs error: fail-open and let openSync create a fresh one
  }
}

function spawnCoordinator(backendBin: string, paths: CoordinatorPaths): SpawnedCoordinator {
  const attemptId = randomUUID();
  const spawnedAt = Date.now();
  let stderr: 'ignore' | number = 'ignore';
  try {
    mkdirSync(paths.runDir, { recursive: true });
    clearStartupErrorSentinel(paths);
    rotateLogIfLarge(paths.runDir);
    stderr = openSync(join(paths.runDir, 'coordinator.log'), 'a');
  } catch {
    // fail-open: spawn without log if dir creation fails
  }

  try {
    const child = spawn(process.execPath, [backendBin], {
      detached: true,
      stdio: ['ignore', 'ignore', stderr],
      env: {
        ...process.env,
        CORAL_STARTUP_ATTEMPT_ID: attemptId,
        CORAL_STARTUP_STARTED_AT: String(spawnedAt),
      },
    });
    if (child.pid === undefined) {
      throw new Error('Spawned coordinator pid was unavailable.');
    }
    child.unref();
    return { pid: child.pid, attemptId, spawnedAt };
  } finally {
    if (typeof stderr === 'number') {
      closeSync(stderr);
    }
  }
}

/**
 * Probe whether `socketPath` is currently bound by a live listener. Uses the
 * same primitive as daemon-side bind: open a probe `net` server, attempt
 * `bindSocket`, and if it succeeds, immediately close it (path-cleanup is the
 * next binder's job per `bindSocket` contract). Returns true when the path is
 * unbound (either truly absent or a stale orphan that the probe cleared).
 */
async function probeSocketReleased(socketPath: string): Promise<boolean> {
  const probe = createServer();
  try {
    const result = await bindSocket(probe, socketPath);
    if (result.kind === 'bound') {
      await new Promise<void>((resolve) => {
        if (!probe.listening) {
          resolve();
          return;
        }
        probe.close(() => resolve());
      });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function waitForSocketRelease(socketPath: string, timeoutMs: number, timePort: TimePort): Promise<void> {
  const deadline = timePort.now() + timeoutMs;
  while (timePort.now() < deadline) {
    if (await probeSocketReleased(socketPath)) return;
    await timePort.sleep(STARTUP_POLL_MS);
  }
  throw new BackendUnreachableError(
    'Timed out waiting for Coral coordinator socket release. Run `coral-cli backend status` to check coordinator health.',
  );
}

/**
 * Shut down the running coordinator (admin drain) and wait until its socket is
 * released, so a follow-up `ensure()` spawns a fresh daemon instead of racing a
 * still-`running` incumbent. The CLI's lazy KB re-enable path uses this: the
 * daemon must restart to pick up a changed `CORAL_KB_ENABLE`, and admin
 * shutdown is identity-agnostic (the handoff path refuses to replace a
 * same-bundle daemon).
 */
export async function shutdownAndAwaitRelease(pluginRoot?: string, timePort?: TimePort): Promise<void> {
  const root = resolvePluginRoot(pluginRoot);
  const flavor = readBuildFlavor(root);
  const runtime = createRealRuntime(flavor);
  const ipcTime = timePort ?? runtime.time;
  const paths = runtime.paths.coral.coordinator;
  await shutdownBackend(root);
  await waitForSocketRelease(paths.socketPath, HANDOFF_DRAIN_TIMEOUT_MS, ipcTime);
}

/**
 * After a fresh spawn (or while the incumbent is still in `starting`), poll
 * until the daemon has both bound the socket AND written `coordinator.json`
 * with a compatible health response. Returns the merged `VerifiedBackendInfo` ready
 * for `summarizeBackend`.
 */
async function waitForBackendReady(
  paths: CoordinatorPaths,
  desired: DesiredCoordinator,
  timeoutMs: number,
  timePort: TimePort,
  waitContext: BackendReadyWaitContext,
): Promise<VerifiedBackendInfo> {
  const currentAttempt = waitContext.kind === 'current-attempt';
  const bindDeadline = timePort.now() + KERNEL_BIND_DEADLINE_MS;
  let sawFirstHealth = !currentAttempt;
  let readyDeadline = timePort.now() + timeoutMs;

  const noteHealth = (health: RawCoordinatorHealth | null): void => {
    if (health === null || sawFirstHealth) {
      return;
    }
    sawFirstHealth = true;
    readyDeadline = timePort.now() + timeoutMs;
  };

  while (timePort.now() < (sawFirstHealth ? readyDeadline : bindDeadline)) {
    const info = readDiscoverySnapshot(paths);
    let observedPid: number | undefined = info?.pid;
    if (info) {
      const health = await readRawCoordinatorHealth(createIpcClient(info.socketPath, timePort));
      noteHealth(health);
      observedPid = health?.pid ?? observedPid;
      if (health && isReadyStatus(health.status) && isCompatibleHealth(health, desired)) {
        return mergeDiscoveryWithHealth(info, health);
      }
    } else if (waitContext.kind === 'existing-starting' || waitContext.kind === 'current-attempt') {
      const health = await readRawCoordinatorHealth(createIpcClient(paths.socketPath, timePort));
      noteHealth(health);
      observedPid = health?.pid;
    }

    const startupError = matchingStartupError(paths, desired, waitContext, observedPid);
    if (startupError) {
      throw startupError;
    }
    await timePort.sleep(STARTUP_POLL_MS);
  }
  throw new BackendUnreachableError(
    sawFirstHealth
      ? 'Timed out waiting for Coral coordinator startup. Run `coral-cli backend status` to check coordinator health.'
      : 'Timed out waiting for Coral coordinator bind. Run `coral-cli backend status` to check coordinator health.',
  );
}

function resolvePluginRoot(pluginRoot?: string): string {
  if (pluginRoot) {
    return pluginRoot;
  }
  if (typeof __PLUGIN_ROOT__ === 'string') {
    return __PLUGIN_ROOT__;
  }
  if (typeof __dirname === 'string') {
    return join(__dirname, '..', '..', '..');
  }
  return process.cwd();
}

/**
 * Ensure a Coral coordinator daemon is running and compatible with the calling
 * plugin bundle. The CLI side mirrors daemon-side `bindWithHandoff` — it
 * relies on the kernel's exclusive-bind semantics on the IPC socket as the
 * single arbiter of "who is the canonical incumbent" and uses the shared
 * `requestIncumbentShutdown` helper for graceful cross-version handoff.
 *
 * Decision tree:
 *   1. Probe existing socket via `transport.health`.
 *      - Compatible + ready  → return summary (or wait for `coordinator.json`
 *                              if `starting` or discovery missing).
 *      - Compatible + draining → wait for socket release, fall through to spawn.
 *      - Incompatible → request shutdown over the same shared helper, wait
 *                       for socket release, spawn fresh.
 *      - Unreachable → spawn fresh.
 *   2. Spawn the coordinator and wait for it to bind + write discovery.
 */
export async function ensure(pluginRoot?: string, timePort?: TimePort): Promise<EnsuredIpcClient> {
  const root = resolvePluginRoot(pluginRoot);
  const flavor = readBuildFlavor(root);
  const bundleHash = readBundleHash(root);
  const namespace = pluginRootNamespace(root);
  const runtime = createRealRuntime(flavor);
  const ipcTime = timePort ?? runtime.time;
  const paths = runtime.paths.coral.coordinator;
  const desired: DesiredCoordinator = {
    version: currentVersion(root),
    bundleHash,
    flavor,
    namespace,
  };
  const desiredIdentity: DesiredIncumbentIdentity = { bundleHash, flavor, namespace };
  const backendBin = join(root, 'bridge', 'coral-backend.cjs');

  const health = await readRawCoordinatorHealth(createIpcClient(paths.socketPath, ipcTime));

  if (health && isCompatibleHealth(health, desired) && health.status !== 'draining') {
    const info = readDiscoverySnapshot(paths);
    if (info && isReadyStatus(health.status)) {
      return summarizeBackend(mergeDiscoveryWithHealth(info, health), ipcTime);
    }
    // Compatible incumbent is still `starting`, or `coordinator.json` lags
    // behind the bound socket; wait for the daemon to finish writing it.
    return summarizeBackend(
      await waitForBackendReady(paths, desired, KERNEL_READY_DEADLINE_MS, ipcTime, { kind: 'existing-starting' }),
      ipcTime,
    );
  }

  if (health && isCompatibleHealth(health, desired) && health.status === 'draining') {
    // Compatible-but-draining: the incumbent rejects normal RPCs but health
    // still answers. Wait for the socket to be released, then spawn fresh.
    await waitForSocketRelease(paths.socketPath, HANDOFF_DRAIN_TIMEOUT_MS, ipcTime);
  } else if (health && !isCompatibleHealth(health, desired)) {
    // Mismatched bundle/flavor/namespace — same shutdown path as daemon-side.
    try {
      const info = readDiscoverySnapshot(paths);
      const shutdownResult = await requestIncumbentShutdown({
        socketPath: paths.socketPath,
        desired: desiredIdentity,
        shutdownToken: info?.shutdownToken,
        timeoutMs: HEALTH_TIMEOUT_MS,
        timePort: ipcTime,
      });
      if (shutdownResult.shutdownUnauthorized) {
        throw new BackendUnreachableError('Manual shutdown required: incumbent rejected shutdown capability.');
      }
      if (!shutdownResult.shutdownAttempted && info?.shutdownToken === undefined) {
        throw new BackendUnreachableError(
          'Manual shutdown required: refusing handoff because verified shutdown capability was unavailable.',
        );
      }
    } catch (error) {
      if (error instanceof IncumbentMatchesError) {
        // Health classified the incumbent as incompatible but the helper
        // re-classified as compatible. Re-converge by re-reading discovery.
        const info = readDiscoverySnapshot(paths);
        if (info) {
          return summarizeBackend(
            await waitForBackendReady(paths, desired, KERNEL_READY_DEADLINE_MS, ipcTime, { kind: 'existing-starting' }),
            ipcTime,
          );
        }
      }
      if (error instanceof BackendUnreachableError && error.message.startsWith('Manual shutdown required:')) {
        throw error;
      }
      // ignore other errors: bounded escalation happens via socket-release wait
    }
    await waitForSocketRelease(paths.socketPath, HANDOFF_DRAIN_TIMEOUT_MS, ipcTime);
  }
  // else: health unreachable → fall through to spawn

  const spawned = spawnCoordinator(backendBin, paths);
  return summarizeBackend(
    await waitForBackendReady(paths, desired, KERNEL_READY_DEADLINE_MS, ipcTime, {
      kind: 'current-attempt',
      attemptId: spawned.attemptId,
      spawnedAt: spawned.spawnedAt,
    }),
    ipcTime,
  );
}
