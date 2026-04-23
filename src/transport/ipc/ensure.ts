declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pluginRootNamespace } from '../../infra/paths.js';
import { coordinatorPaths } from '../../infra/coordinator-paths.js';
import { type LockRecord } from '../../infra/lock-record.js';
import { isProcessAlive, probeProcessStartedAtSeconds } from '../../infra/node-process.js';
import { HEALTH_TIMEOUT_MS as SHARED_HEALTH_TIMEOUT_MS } from '../http/sse.js';
import { BackendUnreachableError } from '../../infra/http-errors.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { isRecord } from '../../infra/json.js';
import { readBuildFlavor, readBundleHash } from '../../infra/bridge-manifest.js';
import { createIpcClient, type IpcClient } from './client.js';

export const STARTUP_POLL_MS = 200;
export const STARTUP_TIMEOUT_MS = 60_000;
export const SICK_VERIFICATION_WINDOW_MS = 10_000;
export const CORRUPT_LOCK_RETRY_LIMIT = 3;
export const HEALTH_TIMEOUT_MS = SHARED_HEALTH_TIMEOUT_MS;

type ReplacementLock = string;

type DesiredCoordinator = {
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
};

type CoordinatorFilePaths = ReturnType<typeof coordinatorPaths>;

type RawCoordinatorHealth = {
  status: 'ok' | 'draining';
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  instanceId: string;
  namespace: string;
};

type BackendInfo = {
  pid: number;
  port: number;
  socketPath: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  startedAt: number;
  token: string;
  host: string;
  version: string;
  instanceId: string;
  processStartedAt?: number;
};

type DiscoverySnapshot = {
  raw: string;
  info: BackendInfo | null;
};

type LockSnapshot = {
  raw: string;
  record: LockRecord;
};

export type VerifiedOwnership = {
  kind: 'verified';
  instanceId: string;
  processStartedAt: number;
  source: 'processIdentity';
  cleanupSnapshot: {
    lockRaw: string;
    discoveryRaw: string | null;
  };
};

export type UnverifiedOwnership = {
  kind: 'unverified';
  reason: string;
};

export type DaemonObservation =
  | { observedAt: number; type: 'absent' }
  | { observedAt: number; type: 'starting' }
  | {
      observedAt: number;
      type: 'sick';
      pid: number;
      ownership: VerifiedOwnership | UnverifiedOwnership;
    }
  | { observedAt: number; type: 'healthyCompatible'; info: BackendInfo }
  | { observedAt: number; type: 'healthyIncompatible'; info: BackendInfo }
  | { observedAt: number; type: 'staleLock'; pid: number; snapshot: LockSnapshot }
  | { observedAt: number; type: 'corruptLock' };

export type DaemonAction =
  | { type: 'wait' }
  | { type: 'requestShutdown'; info: BackendInfo }
  | { type: 'ensureReplacement'; replacedInstanceId: string | null }
  | { type: 'clearStaleLock'; pid: number; snapshot: LockSnapshot }
  | {
      type: 'forceReplace';
      pid: number;
      ownership: VerifiedOwnership;
    }
  | { type: 'failUnsafeReplacement'; pid: number; reason: string }
  | { type: 'quarantineCorruptLock' }
  | { type: 'converged'; info: BackendInfo };

export type ControllerState = {
  sickSince: number | null;
  sickPid: number | null;
  unverifiedSince: number | null;
  shutdownRequestedFor: Set<string>;
  corruptLockRetries: number;
  corruptLockQuarantined: boolean;
  replacedInstanceId: string | null;
  replacementPending: boolean;
  verifiedSickOwnership: VerifiedOwnership | null;
};

export type ReconcileResult = {
  action: DaemonAction;
  nextState: ControllerState;
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

function summarizeBackend(info: BackendInfo): EnsuredIpcClient {
  return Object.assign(createIpcClient(info.socketPath), {
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

function discoveryInfoPath(paths: CoordinatorFilePaths): string {
  return paths.infoFile;
}

function coordinatorLockPath(paths: CoordinatorFilePaths): string {
  return paths.lockFile;
}

function coordinatorRunDir(paths: CoordinatorFilePaths): string {
  return paths.runDir;
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
    (value.status === 'ok' || value.status === 'draining') &&
    typeof value.version === 'string' &&
    typeof value.bundleHash === 'string' &&
    (value.flavor === 'prod' || value.flavor === 'dev') &&
    typeof value.instanceId === 'string' &&
    value.instanceId.length > 0 &&
    typeof value.namespace === 'string' &&
    value.namespace.length > 0
  );
}

function isLockRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.instanceId === 'string' &&
    record.instanceId.length > 0 &&
    Number.isInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.version === 'string' &&
    record.version.length > 0 &&
    typeof record.bundleHash === 'string' &&
    record.bundleHash.length > 0 &&
    (record.flavor === 'prod' || record.flavor === 'dev') &&
    Number.isFinite(record.startedAt) &&
    (record.startedAt as number) > 0 &&
    (record.processStartedAt === undefined ||
      (Number.isInteger(record.processStartedAt) && (record.processStartedAt as number) > 0))
  );
}

function isObservedBackendInfo(value: unknown): value is BackendInfo {
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

async function readRawCoordinatorHealth(info: BackendInfo): Promise<RawCoordinatorHealth | null> {
  try {
    const health = await createIpcClient(info.socketPath).health<unknown>({ timeoutMs: HEALTH_TIMEOUT_MS });
    return isRawCoordinatorHealth(health) ? health : null;
  } catch {
    return null;
  }
}

function readDiscoverySnapshot(paths: CoordinatorFilePaths): DiscoverySnapshot | null {
  try {
    const raw = readFileSync(discoveryInfoPath(paths), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { raw, info: null };
    const record = parsed as Record<string, unknown>;
    record.host ??= '127.0.0.1';
    if (!('flavor' in record)) record.flavor = 'prod';
    return { raw, info: isObservedBackendInfo(record) ? record : null };
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function readLockSnapshot(paths: CoordinatorFilePaths): LockSnapshot | 'corrupt' | null {
  try {
    const raw = readFileSync(coordinatorLockPath(paths), 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return 'corrupt';
    }
    return isLockRecord(parsed) ? { raw, record: parsed } : 'corrupt';
  } catch (error: unknown) {
    if (isNoEntryError(error)) return null;
    throw error;
  }
}

function mergeDiscoveryWithHealth(info: BackendInfo, health: RawCoordinatorHealth): BackendInfo {
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

function verifySickOwnership(
  infoSnapshot: DiscoverySnapshot,
  lockSnapshot: LockSnapshot | null,
): VerifiedOwnership | UnverifiedOwnership {
  const info = infoSnapshot.info;
  if (!info) {
    return { kind: 'unverified', reason: 'backend-info-invalid' };
  }

  if (!lockSnapshot) {
    return { kind: 'unverified', reason: 'lock-missing' };
  }

  const infoProcessStartedAt = info.processStartedAt;
  const lockProcessStartedAt = lockSnapshot.record.processStartedAt;
  if (infoProcessStartedAt === undefined || lockProcessStartedAt === undefined) {
    return { kind: 'unverified', reason: 'legacy-no-processStartedAt' };
  }

  if (
    info.pid !== lockSnapshot.record.pid ||
    info.instanceId !== lockSnapshot.record.instanceId ||
    info.bundleHash !== lockSnapshot.record.bundleHash ||
    info.flavor !== lockSnapshot.record.flavor
  ) {
    return { kind: 'unverified', reason: 'identity-mismatch' };
  }

  const liveProcessStartedAt = probeProcessStartedAtSeconds(info.pid);
  if (liveProcessStartedAt === null) {
    return { kind: 'unverified', reason: 'live-processStartedAt-unavailable' };
  }

  if (
    liveProcessStartedAt !== Math.floor(infoProcessStartedAt) ||
    liveProcessStartedAt !== Math.floor(lockProcessStartedAt)
  ) {
    return { kind: 'unverified', reason: 'processStartedAt-mismatch' };
  }

  return {
    kind: 'verified',
    instanceId: info.instanceId,
    processStartedAt: liveProcessStartedAt,
    source: 'processIdentity',
    cleanupSnapshot: {
      lockRaw: lockSnapshot.raw,
      discoveryRaw: infoSnapshot.raw,
    },
  };
}

async function observe(paths: CoordinatorFilePaths, desired: DesiredCoordinator): Promise<DaemonObservation> {
  const observedAt = Date.now();
  const infoSnapshot = readDiscoverySnapshot(paths);

  if (infoSnapshot?.info) {
    const health = await readRawCoordinatorHealth(infoSnapshot.info);
    if (health) {
      if (health.status === 'draining') {
        return { observedAt, type: 'starting' };
      }

      const info = mergeDiscoveryWithHealth(infoSnapshot.info, health);
      if (isCompatibleHealth(health, desired)) {
        return { observedAt, type: 'healthyCompatible', info };
      }

      return { observedAt, type: 'healthyIncompatible', info };
    }
  }

  const lockSnapshot = readLockSnapshot(paths);
  if (lockSnapshot === 'corrupt') {
    return { observedAt, type: 'corruptLock' };
  }

  if (infoSnapshot?.info && isProcessAlive(infoSnapshot.info.pid)) {
    return {
      observedAt,
      type: 'sick',
      pid: infoSnapshot.info.pid,
      ownership: verifySickOwnership(infoSnapshot, lockSnapshot),
    };
  }

  if (lockSnapshot) {
    if (isProcessAlive(lockSnapshot.record.pid)) {
      return { observedAt, type: 'starting' };
    }
    return { observedAt, type: 'staleLock', pid: lockSnapshot.record.pid, snapshot: lockSnapshot };
  }

  return { observedAt, type: 'absent' };
}

function cloneControllerState(state: ControllerState): ControllerState {
  return {
    sickSince: state.sickSince,
    sickPid: state.sickPid,
    unverifiedSince: state.unverifiedSince,
    shutdownRequestedFor: new Set(state.shutdownRequestedFor),
    corruptLockRetries: state.corruptLockRetries,
    corruptLockQuarantined: state.corruptLockQuarantined,
    replacedInstanceId: state.replacedInstanceId,
    replacementPending: state.replacementPending,
    verifiedSickOwnership: state.verifiedSickOwnership,
  };
}

function resetSickTracking(state: ControllerState): void {
  state.sickSince = null;
  state.sickPid = null;
  state.unverifiedSince = null;
  state.verifiedSickOwnership = null;
}

export function initialControllerState(): ControllerState {
  return {
    sickSince: null,
    sickPid: null,
    unverifiedSince: null,
    shutdownRequestedFor: new Set(),
    corruptLockRetries: 0,
    corruptLockQuarantined: false,
    replacedInstanceId: null,
    replacementPending: false,
    verifiedSickOwnership: null,
  };
}

export function reconcile(
  observation: DaemonObservation,
  _desired: DesiredCoordinator,
  controllerState: ControllerState,
): ReconcileResult {
  const nextState = cloneControllerState(controllerState);

  if (observation.type !== 'corruptLock') {
    nextState.corruptLockRetries = 0;
    nextState.corruptLockQuarantined = false;
  }

  switch (observation.type) {
    case 'absent': {
      resetSickTracking(nextState);
      nextState.replacementPending = true;
      return {
        action: { type: 'ensureReplacement', replacedInstanceId: nextState.replacedInstanceId },
        nextState,
      };
    }

    case 'starting': {
      resetSickTracking(nextState);
      if (nextState.replacementPending) {
        return {
          action: { type: 'ensureReplacement', replacedInstanceId: nextState.replacedInstanceId },
          nextState,
        };
      }
      return { action: { type: 'wait' }, nextState };
    }

    case 'healthyCompatible': {
      resetSickTracking(nextState);
      nextState.replacementPending = false;
      nextState.replacedInstanceId = null;
      return { action: { type: 'converged', info: observation.info }, nextState };
    }

    case 'healthyIncompatible': {
      resetSickTracking(nextState);
      nextState.replacementPending = true;
      nextState.replacedInstanceId = observation.info.instanceId;
      if (!nextState.shutdownRequestedFor.has(observation.info.instanceId)) {
        nextState.shutdownRequestedFor.add(observation.info.instanceId);
        return { action: { type: 'requestShutdown', info: observation.info }, nextState };
      }
      return {
        action: { type: 'ensureReplacement', replacedInstanceId: nextState.replacedInstanceId },
        nextState,
      };
    }

    case 'staleLock': {
      resetSickTracking(nextState);
      return {
        action: { type: 'clearStaleLock', pid: observation.pid, snapshot: observation.snapshot },
        nextState,
      };
    }

    case 'corruptLock': {
      resetSickTracking(nextState);
      nextState.corruptLockRetries += 1;
      if (nextState.corruptLockRetries >= CORRUPT_LOCK_RETRY_LIMIT) {
        nextState.corruptLockRetries = 0;
        nextState.corruptLockQuarantined = true;
        return { action: { type: 'quarantineCorruptLock' }, nextState };
      }
      return { action: { type: 'wait' }, nextState };
    }

    case 'sick': {
      nextState.replacementPending = true;

      if (nextState.sickPid !== observation.pid) {
        nextState.sickPid = observation.pid;
        nextState.sickSince = observation.observedAt;
        nextState.unverifiedSince = null;
        nextState.verifiedSickOwnership = null;
      }

      if (observation.ownership.kind === 'verified') {
        nextState.verifiedSickOwnership = observation.ownership;
        nextState.replacedInstanceId = observation.ownership.instanceId;
        nextState.unverifiedSince = null;
      } else if (nextState.unverifiedSince === null && nextState.verifiedSickOwnership === null) {
        nextState.unverifiedSince = observation.observedAt;
      }

      const sickSince = nextState.sickSince ?? observation.observedAt;
      const sickDurationMs = observation.observedAt - sickSince;
      if (sickDurationMs >= SICK_VERIFICATION_WINDOW_MS) {
        const verifiedOwnership =
          observation.ownership.kind === 'verified' ? observation.ownership : nextState.verifiedSickOwnership;
        if (verifiedOwnership) {
          nextState.verifiedSickOwnership = verifiedOwnership;
          nextState.replacedInstanceId = verifiedOwnership.instanceId;
          return {
            action: { type: 'forceReplace', pid: observation.pid, ownership: verifiedOwnership },
            nextState,
          };
        }

        const reason =
          observation.ownership.kind === 'unverified' ? observation.ownership.reason : 'ownership-unverified';
        return { action: { type: 'failUnsafeReplacement', pid: observation.pid, reason }, nextState };
      }

      return { action: { type: 'wait' }, nextState };
    }
  }
}

async function requestCoordinatorShutdown(info: BackendInfo): Promise<void> {
  try {
    await createIpcClient(info.socketPath).shutdown({ timeoutMs: HEALTH_TIMEOUT_MS });
  } catch {
    // best effort
  }
}

function tryAcquireReplacementLock(
  paths: CoordinatorFilePaths,
  version: string,
  bundleHash: string,
  flavor: 'prod' | 'dev',
): ReplacementLock | null {
  const replacementPid = process.pid;
  const payload = JSON.stringify({
    instanceId: `proxy-replacement-${replacementPid}-${Date.now()}`,
    pid: replacementPid,
    version,
    bundleHash,
    flavor,
    startedAt: Date.now(),
    processStartedAt: probeProcessStartedAtSeconds(replacementPid) ?? undefined,
  });
  const lockPath = coordinatorLockPath(paths);
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    writeFileSync(lockPath, payload, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
  if (process.platform !== 'win32') {
    try {
      chmodSync(lockPath, 0o600);
    } catch {
      // best-effort
    }
  }
  return payload;
}

function releaseReplacementLock(paths: CoordinatorFilePaths, lock: ReplacementLock): void {
  const lockPath = coordinatorLockPath(paths);

  try {
    if (readFileSync(lockPath, 'utf-8') !== lock) return;
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }

  try {
    unlinkSync(lockPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}

function spawnCoordinator(backendBin: string, runDir: string): void {
  let stderr: 'ignore' | number = 'ignore';
  try {
    mkdirSync(runDir, { recursive: true });
    stderr = openSync(join(runDir, 'backend.log'), 'a');
  } catch {
    // fail-open: spawn without log if dir creation fails
  }

  try {
    const child = spawn(process.execPath, [backendBin], {
      detached: true,
      stdio: ['ignore', 'ignore', stderr],
    });
    child.unref();
  } finally {
    if (typeof stderr === 'number') {
      closeSync(stderr);
    }
  }
}

function removeFileIfSnapshotMatches(filePath: string, expectedRaw: string): boolean {
  try {
    if (readFileSync(filePath, 'utf-8') !== expectedRaw) return false;
  } catch (error: unknown) {
    if (isNoEntryError(error)) return true;
    throw error;
  }

  try {
    unlinkSync(filePath);
    return true;
  } catch (error: unknown) {
    if (isNoEntryError(error)) return true;
    throw error;
  }
}

function clearStaleLock(paths: CoordinatorFilePaths, snapshot: LockSnapshot): void {
  if (isProcessAlive(snapshot.record.pid)) return;
  removeFileIfSnapshotMatches(coordinatorLockPath(paths), snapshot.raw);
}

function quarantineCorruptLock(paths: CoordinatorFilePaths): void {
  try {
    unlinkSync(coordinatorLockPath(paths));
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}

async function waitForReplacementCoordinator(
  paths: CoordinatorFilePaths,
  desired: DesiredCoordinator,
  oldInstanceId: string | null,
  deadline: number,
): Promise<BackendInfo> {
  while (Date.now() < deadline) {
    const observation = await observe(paths, desired);
    if (
      observation.type === 'healthyCompatible' &&
      (oldInstanceId === null || observation.info.instanceId !== oldInstanceId)
    ) {
      return observation.info;
    }
    await delay(STARTUP_POLL_MS);
  }

  throw new BackendUnreachableError(
    'Timed out waiting for Coral backend startup. Run `coral-cli backend status` to check backend health.',
  );
}

async function ensureReplacement(
  paths: CoordinatorFilePaths,
  desired: DesiredCoordinator,
  backendBin: string,
  replacedInstanceId: string | null,
  deadline: number,
): Promise<BackendInfo | null> {
  const replacementLock = tryAcquireReplacementLock(paths, desired.version, desired.bundleHash, desired.flavor);
  if (!replacementLock) {
    await delay(STARTUP_POLL_MS);
    return null;
  }

  try {
    spawnCoordinator(backendBin, coordinatorRunDir(paths));
    return await waitForReplacementCoordinator(paths, desired, replacedInstanceId, deadline);
  } finally {
    releaseReplacementLock(paths, replacementLock);
  }
}

async function forceReplaceCoordinator(
  paths: CoordinatorFilePaths,
  pid: number,
  ownership: VerifiedOwnership,
  deadline: number,
): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw error;
  }

  const killDeadline = Math.min(deadline, Date.now() + 5_000);
  while (Date.now() < killDeadline) {
    if (!isProcessAlive(pid)) break;
    await delay(STARTUP_POLL_MS);
  }

  if (isProcessAlive(pid)) {
    throw new BackendUnreachableError(`Failed to terminate sick Coral backend pid ${pid}.`);
  }

  removeFileIfSnapshotMatches(coordinatorLockPath(paths), ownership.cleanupSnapshot.lockRaw);
  if (ownership.cleanupSnapshot.discoveryRaw !== null) {
    removeFileIfSnapshotMatches(discoveryInfoPath(paths), ownership.cleanupSnapshot.discoveryRaw);
  }
}

async function applyAction(
  paths: CoordinatorFilePaths,
  desired: DesiredCoordinator,
  backendBin: string,
  deadline: number,
  action: DaemonAction,
): Promise<BackendInfo | null> {
  switch (action.type) {
    case 'wait':
      await delay(STARTUP_POLL_MS);
      return null;

    case 'requestShutdown':
      await requestCoordinatorShutdown(action.info);
      return null;

    case 'ensureReplacement':
      return await ensureReplacement(paths, desired, backendBin, action.replacedInstanceId, deadline);

    case 'clearStaleLock':
      clearStaleLock(paths, action.snapshot);
      return null;

    case 'forceReplace':
      await forceReplaceCoordinator(paths, action.pid, action.ownership, deadline);
      return null;

    case 'failUnsafeReplacement':
      throw new BackendUnreachableError(
        `Refusing unsafe replacement for sick Coral backend pid ${action.pid}: ${action.reason}. Run 'coral-cli backend status' and restart if the problem persists.`,
      );

    case 'quarantineCorruptLock':
      quarantineCorruptLock(paths);
      return null;

    case 'converged':
      return action.info;
  }
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

export async function ensure(pluginRoot?: string): Promise<EnsuredIpcClient> {
  const root = resolvePluginRoot(pluginRoot);
  const flavor = readBuildFlavor(root);
  const bundleHash = readBundleHash(root);
  const namespace = pluginRootNamespace(root);
  const paths = coordinatorPaths(flavor);
  const desired: DesiredCoordinator = {
    version: currentVersion(root),
    bundleHash,
    flavor,
    namespace,
  };
  const backendBin = join(root, 'bridge', 'coral-backend.cjs');

  const initialObservation = await observe(paths, desired);
  if (initialObservation.type === 'healthyCompatible') {
    return summarizeBackend(initialObservation.info);
  }

  let state = initialControllerState();
  const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < startupDeadline) {
    const observation = await observe(paths, desired);
    const { action, nextState } = reconcile(observation, desired, state);
    state = nextState;

    const info = await applyAction(paths, desired, backendBin, startupDeadline, action);
    if (info) return summarizeBackend(info);
  }

  throw new BackendUnreachableError(
    'Timed out waiting for Coral backend startup. Run `coral-cli backend status` to check backend health.',
  );
}
