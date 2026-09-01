import { observeProcessLiveness } from '../../infra/node-process.js';
import { processIncarnationSchema, type ProcessIncarnation } from '../../infra/node-process.js';
declare const __PLUGIN_ROOT__: string;
declare const __BUNDLE_DIR__: string | undefined;
declare const __VERSION__: string;

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { pluginRootNamespace } from '../../infra/plugin-identity.js';
import { createRealRuntime } from '../../runtime/real.js';
import type { Runtime } from '../../runtime/ports.js';
import type { CoordinatorPaths } from '../../infra/path/index.js';
import { v0109CoordinatorSocketGuardSetForRunDir } from '../../infra/path/index.js';
import { HEALTH_TIMEOUT_MS } from '../http/sse.js';
import { BackendUnreachableError } from '../../infra/http-errors.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { isRecord } from '../../infra/json.js';
import { readBuildFlavor, readBundleHash, resolveStrictBundleIdentity } from '../../infra/bundle-manifest.js';
import { createIpcClient, type IpcClient } from './client.js';
import { bindSocket } from './server.js';
import type { TransportRuntimeComponentStatus } from '../server-ports.js';
import type { TimePort } from '../../infra/port-types.js';
import { CoralSetupError, type SerializedCoralSetupError } from '../../runtime/errors.js';
import { isCoralChildEnvironment } from '../../security/child-principal-env.js';
import { resolveStartupAttemptLineage } from '../../infra/startup-attempt-lineage.js';
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
  incarnation?: ProcessIncarnation;
  components?: TransportRuntimeComponentStatus[];
  env?: Readonly<Record<string, string>>;
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
  bootToken: string;
  shutdownToken?: string;
  host: string;
  version: string;
  instanceId: string;
  incarnation?: ProcessIncarnation;
};

export type EnsuredIpcClient = IpcClient & {
  readonly instanceId: string;
  readonly bundleHash: string;
  readonly flavor: 'prod' | 'dev';
  readonly namespace: string;
  readonly host: string;
  readonly port: number;
  readonly version: string;
};

type EnsuredClientAuthMode = 'boot' | 'none';

type ExistingIncumbentIdentity = Readonly<{
  instanceId: string;
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  pid?: number;
  incarnation?: ProcessIncarnation;
}>;

type SpawnedCoordinator = {
  readonly pid: number | undefined;
  readonly attemptId: string;
  readonly spawnedAt: number;
  readonly terminal: Promise<SpawnedCoordinatorTerminal>;
};

type SpawnedCoordinatorTerminal =
  | Readonly<{ kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }>
  | Readonly<{ kind: 'error'; error: Error }>;

type BackendReadyWaitContext =
  | {
      readonly kind: 'current-attempt';
      readonly attemptId: string;
      readonly spawnedAt: number;
      readonly terminal: Promise<SpawnedCoordinatorTerminal>;
    }
  | { readonly kind: 'existing-starting' };

type ReadyCoordinatorEvidence = Readonly<{
  info: VerifiedBackendInfo;
  health: RawCoordinatorHealth;
}>;

type CoordinatorObservation = Readonly<{
  socketPath: string;
  health: RawCoordinatorHealth | null;
}>;

type StartupErrorSentinel = {
  readonly version: 1;
  readonly attemptId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly recordedAt?: number;
  readonly phase?: string;
  readonly state?: string;
  readonly exitCode?: number;
  readonly diagnosticFile?: string;
  readonly socketPath: string;
  readonly bundleHash: string;
  readonly flavor: 'prod' | 'dev';
  readonly namespace: string;
  readonly error: SerializedCoralSetupError;
};

function summarizeBackend(
  info: VerifiedBackendInfo,
  timePort: TimePort,
  authMode: EnsuredClientAuthMode,
): EnsuredIpcClient {
  const auth = authMode === 'boot' ? { kind: 'boot' as const, token: info.bootToken } : undefined;
  return Object.assign(createIpcClient(info.socketPath, timePort, auth), {
    instanceId: info.instanceId,
    bundleHash: info.bundleHash,
    flavor: info.flavor,
    namespace: info.namespace,
    host: info.host,
    port: info.port,
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

const runtimeComponentStatusSchema = z.discriminatedUnion('phase', [
  z.object({ id: z.string().min(1), phase: z.literal('initializing'), attempt: z.number().int().positive() }).strict(),
  z.object({ id: z.string().min(1), phase: z.literal('online') }).strict(),
  z
    .object({
      id: z.string().min(1),
      phase: z.literal('degraded'),
      reason: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('curate-publish'),
            consecutiveFailures: z.number().int().nonnegative(),
            lastError: z.string(),
          })
          .strict(),
        z
          .object({
            kind: z.literal('recovery-quarantine'),
            count: z.number().int().nonnegative(),
            lastError: z.string(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      phase: z.literal('offline'),
      reason: z.string(),
      lastLogLine: z.string().optional(),
      diagnostic: z
        .object({
          attempts: z.number().int().nonnegative().optional(),
          failedStep: z.string().optional(),
          retry: z.enum(['restart-daemon', 'none']).optional(),
          lastErrorStack: z.string().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

const rawCoordinatorHealthSchema = z
  .object({
    status: z.enum(['starting', 'kernel-ready', 'ok', 'running', 'draining']),
    version: z.string().min(1),
    bundleHash: z.string().min(1),
    flavor: z.enum(['prod', 'dev']),
    instanceId: z.string().min(1),
    namespace: z.string().min(1),
    pid: z.number().int().positive().optional(),
    incarnation: processIncarnationSchema.optional(),
    components: z.array(runtimeComponentStatusSchema).optional(),
    env: z.record(z.string()).optional(),
  })
  .passthrough();

const nonEmptyStringSchema = z.string().min(1);
const verifiedBackendInfoSchema = z
  .object({
    pid: z.number().int().positive(),
    port: z.number().int().positive(),
    socketPath: nonEmptyStringSchema,
    bundleHash: nonEmptyStringSchema,
    flavor: z.enum(['prod', 'dev']),
    namespace: nonEmptyStringSchema,
    startedAt: z.number().positive(),
    token: nonEmptyStringSchema,
    bootToken: nonEmptyStringSchema,
    shutdownToken: nonEmptyStringSchema.optional(),
    host: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
    instanceId: nonEmptyStringSchema,
    incarnation: processIncarnationSchema.optional(),
  })
  // Same record `readDiscoveryRecord` parses in infra/backend-discovery.ts, re-validated here with a
  // narrower (all-required) shape — tolerant for the same reason: a future writer's extra field must not
  // make this build's own read of the record it just wrote fail.
  .passthrough();

function parseRawCoordinatorHealth(value: unknown): RawCoordinatorHealth | null {
  const parsed = rawCoordinatorHealthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Treat both coarse `'ok'` and lifecycle phases (`'kernel-ready'`,
 * `'running'`) as "the daemon is ready to serve requests".
 */
function isReadyStatus(status: RawCoordinatorHealth['status']): boolean {
  return status === 'ok' || status === 'kernel-ready' || status === 'running';
}

function isVerifiedBackendInfo(value: unknown): value is VerifiedBackendInfo {
  return verifiedBackendInfoSchema.safeParse(value).success;
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

async function readRawCoordinatorHealth(
  client: IpcClient,
  request: 'ping' | 'health' = 'ping',
): Promise<RawCoordinatorHealth | null> {
  try {
    const health =
      request === 'ping'
        ? await client.ping<unknown>({ timeoutMs: HEALTH_TIMEOUT_MS })
        : await client.health<unknown>({ timeoutMs: HEALTH_TIMEOUT_MS });
    return parseRawCoordinatorHealth(health);
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

export function mayInvocationBeServedByIncumbent(health: RawCoordinatorHealth | null): health is RawCoordinatorHealth {
  return health !== null && health.status !== 'draining';
}

export function mayProcessReplaceIncumbent(health: RawCoordinatorHealth | null): boolean {
  return health === null || health.status === 'draining';
}

function existingIncumbentIdentity(health: RawCoordinatorHealth): ExistingIncumbentIdentity {
  return {
    instanceId: health.instanceId,
    version: health.version,
    bundleHash: health.bundleHash,
    flavor: health.flavor,
    namespace: health.namespace,
    ...(health.pid === undefined ? {} : { pid: health.pid }),
    ...(health.incarnation === undefined ? {} : { incarnation: health.incarnation }),
  };
}

function optionalIdentityMatches<T>(expected: T | undefined, actual: T | undefined): boolean {
  return expected === undefined || actual === undefined || expected === actual;
}

function identityMatchesExistingIncumbent(
  candidate: ExistingIncumbentIdentity,
  incumbent: ExistingIncumbentIdentity,
): boolean {
  return (
    candidate.instanceId === incumbent.instanceId &&
    candidate.version === incumbent.version &&
    candidate.bundleHash === incumbent.bundleHash &&
    candidate.flavor === incumbent.flavor &&
    candidate.namespace === incumbent.namespace &&
    optionalIdentityMatches(incumbent.pid, candidate.pid) &&
    optionalIdentityMatches(incumbent.incarnation, candidate.incarnation)
  );
}

function discoveryMatchesExistingIncumbent(
  info: VerifiedBackendInfo,
  expectedSocketPath: string,
  incumbent: ExistingIncumbentIdentity,
): boolean {
  return info.socketPath === expectedSocketPath && identityMatchesExistingIncumbent(info, incumbent);
}

async function readIdentityCheckedAuthenticatedHealth(
  info: VerifiedBackendInfo,
  expectedSocketPath: string,
  observedHealth: RawCoordinatorHealth,
  timePort: TimePort,
): Promise<RawCoordinatorHealth | null> {
  const observedIdentity = existingIncumbentIdentity(observedHealth);
  if (!discoveryMatchesExistingIncumbent(info, expectedSocketPath, observedIdentity)) {
    return null;
  }

  const client = createIpcClient(info.socketPath, timePort, { kind: 'boot', token: info.bootToken });
  const authenticatedHealth = await readRawCoordinatorHealth(client, 'health');
  if (
    authenticatedHealth === null ||
    !identityMatchesExistingIncumbent(authenticatedHealth, observedIdentity) ||
    !discoveryMatchesExistingIncumbent(info, expectedSocketPath, existingIncumbentIdentity(authenticatedHealth))
  ) {
    return null;
  }
  return authenticatedHealth;
}

function childCoordinatorUnavailable(reason: string): BackendUnreachableError {
  return new BackendUnreachableError(
    `Nested Coral command stopped because ${reason}; it did not start or replace a coordinator. Run 'coral-cli backend status' from the top-level Coral session, restore or wait for that coordinator, then retry the original command.`,
  );
}

function startupSentinelBoundaryMatches(
  sentinel: StartupErrorSentinel,
  paths: CoordinatorPaths,
  desired: DesiredCoordinator,
): boolean {
  return (
    sentinel.socketPath === paths.socketPath &&
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

function matchingStartupError(
  paths: CoordinatorPaths,
  desired: DesiredCoordinator,
  waitContext: BackendReadyWaitContext,
  observedPid?: number,
): CoralSetupError | null {
  const record = readStartupErrorSentinel(paths);
  if (!record) return null;

  const { sentinel, mtimeMs } = record;
  if (!startupSentinelBoundaryMatches(sentinel, paths, desired)) {
    return null;
  }

  if (waitContext.kind === 'current-attempt') {
    const lineage = resolveStartupAttemptLineage({
      observedAttemptId: sentinel.attemptId,
      expectedAttemptId: waitContext.attemptId,
      desiredIdentity: desired,
    });
    if (lineage.kind !== 'proven-current-attempt' || lineage.proof !== 'startup-attempt-id') {
      return null;
    }
    const earliestMtime = waitContext.spawnedAt - STARTUP_POLL_MS;
    if (mtimeMs < earliestMtime) {
      return null;
    }
    return new CoralSetupError(sentinel.error);
  }

  if (sentinel.bundleHash !== desired.bundleHash) {
    return null;
  }
  if (observedPid !== undefined && sentinel.pid !== observedPid) {
    return null;
  }
  // Only a process observed gone may retire its sentinel: clearing on an unanswerable probe would discard a
  // live coordinator's recorded startup failure.
  if (observeProcessLiveness(sentinel.pid) === 'absent') {
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

function observeSpawnedCoordinatorTerminal(child: ChildProcess): Promise<SpawnedCoordinatorTerminal> {
  return new Promise((resolve) => {
    let settled = false;
    function settle(outcome: SpawnedCoordinatorTerminal): void {
      if (settled) {
        return;
      }
      settled = true;
      child.off('exit', onExit);
      child.off('error', onError);
      resolve(outcome);
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      settle({ kind: 'exit', code, signal });
    }
    function onError(error: Error): void {
      settle({ kind: 'error', error });
    }

    child.once('exit', onExit);
    child.once('error', onError);
  });
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
    const terminal = observeSpawnedCoordinatorTerminal(child);
    child.unref();
    return { pid: child.pid, attemptId, spawnedAt, terminal };
  } finally {
    if (typeof stderr === 'number') {
      closeSync(stderr);
    }
  }
}

/**
 * Uses the same primitive as daemon-side bind (path-cleanup is the next
 * binder's job per `bindSocket` contract).
 *
 * `false` means an incumbent still holds the address. A refusal is not that,
 * and draining cannot clear it.
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
  } catch (error: unknown) {
    if (error instanceof CoralSetupError) throw error;
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
 * After a fresh spawn (or while the incumbent is still in `starting`), poll
 * until the daemon has both bound the socket AND written `coordinator.json`
 * with an authenticated, identity-checked health response that can serve the
 * invocation.
 */
async function waitForBackendReady(
  paths: CoordinatorPaths,
  desired: DesiredCoordinator,
  timeoutMs: number,
  timePort: TimePort,
  waitContext: BackendReadyWaitContext,
  expectedSocketPath: string = paths.socketPath,
): Promise<ReadyCoordinatorEvidence> {
  const currentAttempt = waitContext.kind === 'current-attempt';
  const bindDeadline = timePort.now() + KERNEL_BIND_DEADLINE_MS;
  let sawFirstHealth = !currentAttempt;
  let readyDeadline = timePort.now() + timeoutMs;
  let terminalOutcome: SpawnedCoordinatorTerminal | null = null;

  const noteHealth = (health: RawCoordinatorHealth | null): void => {
    if (health === null || sawFirstHealth) {
      return;
    }
    sawFirstHealth = true;
    readyDeadline = timePort.now() + timeoutMs;
  };

  while (currentAttempt || timePort.now() < (sawFirstHealth ? readyDeadline : bindDeadline)) {
    const info = readDiscoverySnapshot(paths);
    let observedPid: number | undefined = info?.pid;
    if (info) {
      const health = await readRawCoordinatorHealth(createIpcClient(info.socketPath, timePort));
      noteHealth(health);
      observedPid = health?.pid ?? observedPid;
      if (mayInvocationBeServedByIncumbent(health) && isReadyStatus(health.status)) {
        const authenticatedHealth = await readIdentityCheckedAuthenticatedHealth(
          info,
          expectedSocketPath,
          health,
          timePort,
        );
        if (mayInvocationBeServedByIncumbent(authenticatedHealth) && isReadyStatus(authenticatedHealth.status)) {
          if (waitContext.kind !== 'current-attempt') {
            return { info: mergeDiscoveryWithHealth(info, authenticatedHealth), health: authenticatedHealth };
          }
          const lineage = resolveStartupAttemptLineage({
            observedAttemptId: authenticatedHealth.env?.CORAL_STARTUP_ATTEMPT_ID,
            expectedAttemptId: waitContext.attemptId,
            observedIdentity: authenticatedHealth,
            desiredIdentity: desired,
          });
          if (lineage.kind === 'proven-current-attempt') {
            return { info: mergeDiscoveryWithHealth(info, authenticatedHealth), health: authenticatedHealth };
          }
        }
      }
    } else if (waitContext.kind === 'existing-starting' || waitContext.kind === 'current-attempt') {
      const health = await readRawCoordinatorHealth(createIpcClient(expectedSocketPath, timePort));
      noteHealth(health);
      observedPid = health?.pid;
    }

    const startupError = matchingStartupError(paths, desired, waitContext, observedPid);
    if (startupError) {
      throw startupError;
    }
    if (terminalOutcome !== null) {
      throw new BackendUnreachableError(
        sawFirstHealth
          ? 'Timed out waiting for Coral coordinator startup. Run `coral-cli backend status` to check coordinator health.'
          : 'Timed out waiting for Coral coordinator bind. Run `coral-cli backend status` to check coordinator health.',
      );
    }

    if (waitContext.kind === 'current-attempt') {
      terminalOutcome = await Promise.race([waitContext.terminal, timePort.sleep(STARTUP_POLL_MS).then(() => null)]);
    } else {
      await timePort.sleep(STARTUP_POLL_MS);
    }
  }
  throw new BackendUnreachableError(
    sawFirstHealth
      ? 'Timed out waiting for Coral coordinator startup. Run `coral-cli backend status` to check coordinator health.'
      : 'Timed out waiting for Coral coordinator bind. Run `coral-cli backend status` to check coordinator health.',
  );
}

/**
 * Wait for the exact incumbent observed by a Coral child. Unlike the top-level
 * readiness path, this helper is strictly read-only: it never clears startup
 * sentinels, requests shutdown, waits for release, or follows a replacement
 * instance.
 */
async function waitForExistingIncumbentReady(
  paths: CoordinatorPaths,
  socketPath: string,
  initialHealth: RawCoordinatorHealth,
  timeoutMs: number,
  timePort: TimePort,
): Promise<VerifiedBackendInfo> {
  const incumbent = existingIncumbentIdentity(initialHealth);
  const deadline = timePort.now() + timeoutMs;
  let health: RawCoordinatorHealth | null = initialHealth;

  while (timePort.now() < deadline) {
    if (health === null) {
      throw childCoordinatorUnavailable('the observed parent coordinator became unreachable');
    }
    if (health.status === 'draining') {
      throw childCoordinatorUnavailable('the observed parent coordinator is draining');
    }
    if (!identityMatchesExistingIncumbent(health, incumbent)) {
      throw childCoordinatorUnavailable('the coordinator identity changed while the child was connecting');
    }

    const info = readDiscoverySnapshot(paths);
    if (info !== null && !discoveryMatchesExistingIncumbent(info, socketPath, incumbent)) {
      throw childCoordinatorUnavailable('coordinator discovery does not match the observed parent');
    }
    if (info !== null && isReadyStatus(health.status)) {
      return mergeDiscoveryWithHealth(info, health);
    }

    await timePort.sleep(STARTUP_POLL_MS);
    health = await readRawCoordinatorHealth(createIpcClient(socketPath, timePort));
  }

  throw childCoordinatorUnavailable('timed out waiting for the observed parent coordinator to become ready');
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

function resolveBackendBin(root: string): string {
  if (typeof __BUNDLE_DIR__ === 'string' && __BUNDLE_DIR__.length > 0) {
    return join(__BUNDLE_DIR__, 'coral-backend.cjs');
  }
  return join(root, 'bridge', 'coral-backend.cjs');
}

async function ensureChildIncumbent(
  paths: CoordinatorPaths,
  socketPath: string,
  health: RawCoordinatorHealth | null,
  timePort: TimePort,
): Promise<EnsuredIpcClient> {
  if (health === null) {
    throw childCoordinatorUnavailable('its parent coordinator is unreachable');
  }
  const info = await waitForExistingIncumbentReady(paths, socketPath, health, KERNEL_READY_DEADLINE_MS, timePort);
  return summarizeBackend(info, timePort, 'none');
}

async function reuseServingIncumbent(
  paths: CoordinatorPaths,
  socketPath: string,
  desired: DesiredCoordinator,
  health: RawCoordinatorHealth,
  timePort: TimePort,
): Promise<EnsuredIpcClient | null> {
  const info = readDiscoverySnapshot(paths);
  if (info !== null) {
    const authenticatedHealth = await readIdentityCheckedAuthenticatedHealth(info, socketPath, health, timePort);
    if (authenticatedHealth === null) {
      return null;
    }
    if (isReadyStatus(authenticatedHealth.status)) {
      return summarizeBackend(mergeDiscoveryWithHealth(info, authenticatedHealth), timePort, 'boot');
    }
  }

  const ready = await waitForBackendReady(
    paths,
    desired,
    KERNEL_READY_DEADLINE_MS,
    timePort,
    { kind: 'existing-starting' },
    socketPath,
  );
  return summarizeBackend(ready.info, timePort, 'boot');
}

async function prepareTopLevelSpawn(
  socketPath: string,
  health: RawCoordinatorHealth | null,
  timePort: TimePort,
): Promise<void> {
  if (health?.status === 'draining') {
    await waitForSocketRelease(socketPath, HANDOFF_DRAIN_TIMEOUT_MS, timePort);
  }
}

async function spawnTopLevelCoordinator(
  backendBin: string,
  paths: CoordinatorPaths,
  desired: DesiredCoordinator,
  timePort: TimePort,
): Promise<EnsuredIpcClient> {
  const spawned = spawnCoordinator(backendBin, paths);
  const ready = await waitForBackendReady(paths, desired, KERNEL_READY_DEADLINE_MS, timePort, {
    kind: 'current-attempt',
    attemptId: spawned.attemptId,
    spawnedAt: spawned.spawnedAt,
    terminal: spawned.terminal,
  });
  return summarizeBackend(ready.info, timePort, 'boot');
}

async function ensureTopLevelCoordinator(
  root: string,
  flavor: 'prod' | 'dev',
  paths: CoordinatorPaths,
  socketPath: string,
  health: RawCoordinatorHealth | null,
  timePort: TimePort,
): Promise<EnsuredIpcClient> {
  const strictIdentity = resolveStrictBundleIdentity();
  const manifest = strictIdentity.ok ? strictIdentity.manifest : null;
  const bundleHash = manifest?.bundleHash ?? readBundleHash(root);
  const namespace = pluginRootNamespace(root);
  const desired: DesiredCoordinator = {
    version: manifest?.version ?? currentVersion(root),
    bundleHash,
    flavor,
    namespace,
  };
  let replacementEvidence = health;
  if (mayInvocationBeServedByIncumbent(health)) {
    const incumbent = await reuseServingIncumbent(paths, socketPath, desired, health, timePort);
    if (incumbent !== null) {
      return incumbent;
    }
    // `reuseServingIncumbent` failing is not proof the incumbent is gone — an
    // unauthenticated `ping` already showed it live moments ago, and a single
    // dropped authenticated round-trip looks identical to a dead incumbent.
    // Re-probe and retry once before conceding: spawning a fresh coordinator
    // against a still-serving incumbent is exactly how two builds end up
    // racing `bindWithHandoff` for the same socket. `mayProcessReplaceIncumbent`
    // is the same predicate `mayInvocationBeServedByIncumbent` complements —
    // it is the explicit gate for "is spawning even on the table here".
    replacementEvidence = await readRawCoordinatorHealth(createIpcClient(socketPath, timePort));
    if (mayInvocationBeServedByIncumbent(replacementEvidence)) {
      const retried = await reuseServingIncumbent(paths, socketPath, desired, replacementEvidence, timePort);
      if (retried !== null) {
        return retried;
      }
    }
    if (!mayProcessReplaceIncumbent(replacementEvidence)) {
      throw new BackendUnreachableError(
        'Coral coordinator is running but this invocation could not verify it after a retry (transient IPC ' +
          'failure). Run `coral-cli backend status` and retry.',
      );
    }
  }
  await prepareTopLevelSpawn(socketPath, replacementEvidence, timePort);

  return spawnTopLevelCoordinator(resolveBackendBin(root), paths, desired, timePort);
}

async function observeCoordinator(
  runtime: Runtime,
  paths: CoordinatorPaths,
  timePort: TimePort,
): Promise<CoordinatorObservation> {
  const health = await readRawCoordinatorHealth(createIpcClient(paths.socketPath, timePort));
  if (health !== null) return { socketPath: paths.socketPath, health };

  const info = readDiscoverySnapshot(paths);
  if (info === null) return { socketPath: paths.socketPath, health: null };
  const compatibilityAddresses = v0109CoordinatorSocketGuardSetForRunDir(paths.runDir, runtime.flavor, {
    platform: runtime.env.platform(),
    configuredTempDirectory: runtime.env.get('TMPDIR'),
    systemTempDirectory: runtime.env.tmpdir(),
  });
  if (
    compatibilityAddresses.kind !== 'guarded-addresses' ||
    !compatibilityAddresses.paths.includes(info.socketPath) ||
    info.socketPath === paths.socketPath
  ) {
    return { socketPath: paths.socketPath, health: null };
  }

  return {
    socketPath: info.socketPath,
    health: await readRawCoordinatorHealth(createIpcClient(info.socketPath, timePort)),
  };
}

/**
 * Ensure a Coral coordinator daemon is running. The kernel's exclusive-bind
 * semantics on the IPC socket remain the single arbiter of the canonical
 * incumbent.
 */
export async function ensure(pluginRoot?: string, timePort?: TimePort): Promise<EnsuredIpcClient> {
  const root = resolvePluginRoot(pluginRoot);
  const flavor = readBuildFlavor(root);
  const runtime = createRealRuntime(flavor);
  const ipcTime = timePort ?? runtime.time;
  const paths = runtime.paths.coral.coordinator;
  const observation = await observeCoordinator(runtime, paths, ipcTime);

  if (isCoralChildEnvironment(runtime.env.fullSnapshot())) {
    return ensureChildIncumbent(paths, observation.socketPath, observation.health, ipcTime);
  }
  return ensureTopLevelCoordinator(root, flavor, paths, observation.socketPath, observation.health, ipcTime);
}
