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
import {
  createIpcClient,
  IpcDrainRequestUnanswered,
  IpcLifecycleRefusal,
  IpcRequestTimeout,
  type IpcClient,
  type IpcRequestOptions,
} from './client.js';
import { bindSocket } from './server.js';
import {
  discoveryMatchesExistingIncumbent,
  identityMatchesExistingIncumbent,
  readIdentityCheckedAuthenticatedHealth,
  type CoordinatorHealthIdentity,
} from './health.js';
import {
  ipcRouteLifecycleAdmission,
  ipcRouteRefusalDisposition,
  type RouteLifecycleAdmission,
} from '../rpc/operational-catalog.js';
import type { TransportRuntimeComponentStatus } from '../server-ports.js';
import type { TimePort } from '../../infra/port-types.js';
import {
  CoralSetupError,
  readOperatorFacingCoralSetupError,
  resolveSetupErrorAuthorship,
  type OperatorFacingCoralSetupError,
  type SetupErrorAuthorship,
  type SetupErrorAuthorshipKind,
} from '../../runtime/errors.js';
import { assertNever } from '../../infra/error-format.js';
import { isCoralChildEnvironment } from '../../security/child-principal-env.js';
import { resolveStartupAttemptLineage } from '../../infra/startup-attempt-lineage.js';
export const STARTUP_POLL_MS = 200;
/**
 * Time budget for an already-starting incumbent to reach a usable lifecycle phase (kernel-ready or running).
 * A coordinator spawned by this invocation is bounded by its own child process instead, so no elapsed-time
 * budget may cut that wait short.
 */
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

type SpawnedCoordinator = {
  readonly attemptId: string;
  readonly spawnedAt: number;
  readonly terminal: Promise<SpawnedCoordinatorTerminal>;
};

/**
 * No code and no signal: an exit code is not evidence about whether a coordinator is serving, and the only
 * consumer must not be handed one to reason from. `reason` is safe to surface because it is authored here —
 * `spawnCoordinator` gives the child `stdio: ['ignore', 'ignore', <coordinator.log fd>]`, so no child-authored
 * text can reach this process.
 */
type SpawnedCoordinatorTerminal = Readonly<{ kind: 'exited' }> | Readonly<{ kind: 'never-started'; reason: string }>;

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
  readonly diagnosticFile?: string;
  readonly socketPath: string;
  readonly bundleHash: string;
  readonly flavor: 'prod' | 'dev';
  readonly namespace: string;
  readonly error: unknown;
};

/**
 * A draining incumbent may not be given a unary request budget longer than the time it has left to hold the
 * address: once `HANDOFF_DRAIN_TIMEOUT_MS` has passed with no answer, a caller's remaining exits are the
 * refusal and the successor, and neither becomes reachable by waiting out `TOOL_TIMEOUT_MS`. The bound caps
 * and never extends a caller's own budget, and it answers for its own expiry: a request this bound cut short
 * was not refused and was not completed, so it may not leave as an unattributed failure. Subscriptions are
 * not bounded here: no subscribed route is admitted while draining.
 */
function drainBoundedClient(client: IpcClient): IpcClient {
  return {
    ...client,
    request: async <TResult>(method: string, params?: unknown, options?: IpcRequestOptions) => {
      // A caller budget of zero or less means unbounded to `requestIpcMethod`, so it may not be carried into
      // the minimum: the smaller number would be the one that removes the bound.
      const callerMs = options?.timeoutMs;
      const callerBudgetBinds = typeof callerMs === 'number' && callerMs > 0 && callerMs < HANDOFF_DRAIN_TIMEOUT_MS;
      const budgetMs = callerBudgetBinds ? callerMs : HANDOFF_DRAIN_TIMEOUT_MS;
      try {
        return await client.request<TResult>(method, params, { ...options, timeoutMs: budgetMs });
      } catch (error: unknown) {
        // Only this bound's own expiry is renamed: a smaller caller budget that ran out was never bounded here.
        if (error instanceof IpcRequestTimeout && !callerBudgetBinds) {
          throw new IpcDrainRequestUnanswered(client.socketPath, method, budgetMs);
        }
        throw error;
      }
    },
  };
}

function summarizeBackend(
  info: VerifiedBackendInfo,
  health: RawCoordinatorHealth,
  timePort: TimePort,
  authMode: EnsuredClientAuthMode,
): EnsuredIpcClient {
  const auth = authMode === 'boot' ? { kind: 'boot' as const, token: info.bootToken } : undefined;
  const client = createIpcClient(info.socketPath, timePort, auth);
  return Object.assign(health.status === 'draining' ? drainBoundedClient(client) : client, {
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

/**
 * A draining coordinator serves only a route the operational catalog admits while draining, and `'starting'`
 * serves nothing: an invocation handed a coordinator that has not finished booting has no route at all.
 */
function isServingStatus(status: RawCoordinatorHealth['status'], admission: RouteLifecycleAdmission): boolean {
  if (status === 'draining') {
    return admission === 'running-or-draining';
  }
  return status === 'ok' || status === 'kernel-ready' || status === 'running';
}

function isVerifiedBackendInfo(value: unknown): value is VerifiedBackendInfo {
  return verifiedBackendInfoSchema.safeParse(value).success;
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
    'error' in value
  );
}

/**
 * A probe that did not complete is not a probe that found nothing. `unanswered` is the third answer and may
 * not stand in for either other one; in particular it is not evidence that the address is dead.
 */
type CoordinatorHealthReading =
  | Readonly<{ kind: 'answered'; health: RawCoordinatorHealth }>
  | Readonly<{ kind: 'unusable'; cause: 'health-shape-rejected' }>
  | Readonly<{ kind: 'unanswered'; cause: 'health-request-failed' }>;

async function readRawCoordinatorHealth(
  client: IpcClient,
  request: 'ping' | 'health' = 'ping',
): Promise<CoordinatorHealthReading> {
  let reply: unknown;
  try {
    reply =
      request === 'ping'
        ? await client.ping<unknown>({ timeoutMs: HEALTH_TIMEOUT_MS })
        : await client.health<unknown>({ timeoutMs: HEALTH_TIMEOUT_MS });
  } catch {
    return { kind: 'unanswered', cause: 'health-request-failed' };
  }

  const health = parseRawCoordinatorHealth(reply);
  return health === null ? { kind: 'unusable', cause: 'health-shape-rejected' } : { kind: 'answered', health };
}

function parseRawCoordinatorHealth(value: unknown): RawCoordinatorHealth | null {
  const parsed = rawCoordinatorHealthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** `null` is this invocation's lack of a usable reading, never proof that no coordinator is serving. */
function answeredHealth(reading: CoordinatorHealthReading): RawCoordinatorHealth | null {
  return reading.kind === 'answered' ? reading.health : null;
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

export function mayInvocationBeServedByIncumbent(
  health: RawCoordinatorHealth | null,
  admission: RouteLifecycleAdmission,
): health is RawCoordinatorHealth {
  return health !== null && (admission === 'running-or-draining' || health.status !== 'draining');
}

/**
 * Replacement is not the route's question and may not be parameterised by its admission: a route admitted
 * while draining still needs the draining incumbent replaced once reaching it has failed, and an admission
 * that called a draining incumbent irreplaceable would leave that invocation nothing to fall back to.
 */
export function mayProcessReplaceIncumbent(health: RawCoordinatorHealth | null): boolean {
  return health === null || health.status === 'draining';
}

function existingIncumbentIdentity(health: RawCoordinatorHealth): CoordinatorHealthIdentity {
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

function childCoordinatorUnavailable(reason: string): BackendUnreachableError {
  return new BackendUnreachableError(
    `Nested Coral command stopped because ${reason}; it did not start or replace a coordinator. Run 'coral-cli backend status' from the top-level Coral session, restore or wait for that coordinator, then retry the original command.`,
  );
}

/**
 * The address and flavor a sentinel names are the invocation's own, whichever build wrote it: startup
 * delegation ends at this socket under this flavor. A delegated build's own identity — its bundle hash and
 * the namespace of its plugin root — is by construction not this build's, so neither may be part of the
 * boundary that decides whether a sentinel is about this socket at all.
 */
function startupSentinelBoundaryMatches(
  sentinel: StartupErrorSentinel,
  paths: CoordinatorPaths,
  desired: DesiredCoordinator,
): boolean {
  return sentinel.socketPath === paths.socketPath && sentinel.flavor === desired.flavor;
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

/**
 * Shared by every startup refusal that names a code whose text could not be rebuilt. "Upgrade Coral" may be
 * said only about a record some other build wrote: telling an operator to upgrade past a refusal the running
 * build itself recorded sends them after a release that does not exist.
 */
function startupErrorFollowUp(authorship: SetupErrorAuthorshipKind): string {
  const inspect = 'Run `coral-cli backend status` to inspect the recorded failure';
  switch (authorship) {
    case 'this-build':
    case 'unprovable':
      return `${inspect}, read the coordinator log for that code, then retry the original command.`;
    case 'other-build':
      return `${inspect}, then upgrade Coral and retry the original command.`;
    default:
      return assertNever(authorship);
  }
}

/**
 * "whose codes this build cannot name" may be said only about a code some other build wrote. A record the
 * running build itself wrote and then could not re-read says nothing about its own catalog, so that arm may
 * claim only what was observed: the text did not survive the round trip.
 */
function unrecognizedStartupCodeMessage(
  startupError: Extract<OperatorFacingCoralSetupError, { kind: 'unrecognized_code' }>,
): string {
  const recorded = `Coordinator startup stopped with setup-error code '${startupError.code}'`;
  const followUp = startupErrorFollowUp(startupError.authorship);
  switch (startupError.authorship) {
    case 'this-build':
      return `${recorded}, and the text this Coral build recorded with it could not be re-read. ${followUp}`;
    case 'other-build':
      return `${recorded}, recorded by a Coral build other than the one running here, whose codes this build cannot name. ${followUp}`;
    case 'unprovable':
      return `${recorded}, and this Coral build could not prove which build recorded it. ${followUp}`;
    default:
      return assertNever(startupError.authorship);
  }
}

/**
 * A documented code whose recorded context this build cannot render still has a name, and the name is what an
 * operator searches the coordinator log with. Withholding it would leave a code this build documents harder to
 * act on than one it has never heard of.
 */
function unrenderableStartupContextMessage(
  startupError: Extract<OperatorFacingCoralSetupError, { kind: 'unrenderable_context' }>,
): string {
  return `Coordinator startup stopped with setup-error code '${startupError.code}', and the details recorded with it are not in the shape this Coral build renders that code from, so its text could not be regenerated. ${startupErrorFollowUp(startupError.authorship)}`;
}

/**
 * Only a strictly proven bundle identity may claim authorship of a sentinel. A hash this build read back
 * without that proof is not evidence: the same unproven value can be read by a build that wrote nothing.
 */
function sentinelAuthorship(sentinel: StartupErrorSentinel, desired: DesiredCoordinator): SetupErrorAuthorship {
  const strict = resolveStrictBundleIdentity();
  return resolveSetupErrorAuthorship({
    recorded: { bundleHash: sentinel.bundleHash, namespace: sentinel.namespace },
    self: strict.ok ? { bundleHash: strict.manifest.bundleHash, namespace: desired.namespace } : null,
  });
}

function matchingStartupError(
  paths: CoordinatorPaths,
  desired: DesiredCoordinator,
  waitContext: BackendReadyWaitContext,
  observedPid?: number,
): OperatorFacingCoralSetupError | null {
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
    return readOperatorFacingCoralSetupError(sentinel.error, sentinelAuthorship(sentinel, desired));
  }

  // No attempt id ties this sentinel to the spawn being waited on, so build identity is the only remaining
  // attribution: a record left by another build is not this invocation's to adopt or to retire.
  if (sentinel.bundleHash !== desired.bundleHash || sentinel.namespace !== desired.namespace) {
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
  return readOperatorFacingCoralSetupError(sentinel.error, sentinelAuthorship(sentinel, desired));
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
    function onExit(): void {
      settle({ kind: 'exited' });
    }
    function onError(error: Error): void {
      settle({ kind: 'never-started', reason: error.message });
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
    return { attemptId, spawnedAt, terminal };
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

/**
 * The release wait's own way of ending, and the only one an invocation already holding a lifecycle refusal may
 * answer with that refusal instead: every other `BackendUnreachableError` on the replacement path describes
 * something other than the refusing incumbent keeping the address.
 */
class CoordinatorSocketReleaseTimeout extends BackendUnreachableError {
  /** The budget actually waited, so a caller restating the observation cannot name a budget it did not spend. */
  readonly budgetMs: number;

  constructor(message: string, budgetMs: number) {
    super(message);
    this.name = 'CoordinatorSocketReleaseTimeout';
    this.budgetMs = budgetMs;
  }
}

async function waitForSocketRelease(socketPath: string, timeoutMs: number, timePort: TimePort): Promise<void> {
  const deadline = timePort.now() + timeoutMs;
  while (timePort.now() < deadline) {
    if (await probeSocketReleased(socketPath)) return;
    await timePort.sleep(STARTUP_POLL_MS);
  }
  throw new CoordinatorSocketReleaseTimeout(
    'Timed out waiting for Coral coordinator socket release. Run `coral-cli backend status` to check coordinator health.',
    timeoutMs,
  );
}

/**
 * Each way the wait can end gets its own sentence, and only a decisive reading may say the coordinator stopped
 * before binding: a probe that never completed did not observe that, and a coordinator that is serving would
 * answer the same way to a dropped request.
 */
function endedStartupMessage(terminal: SpawnedCoordinatorTerminal, reading: CoordinatorHealthReading): string {
  const inspect = 'Run `coral-cli backend status` to inspect the recorded startup outcome.';
  if (terminal.kind === 'never-started') {
    return `The Coral coordinator process could not be started (${terminal.reason}). ${inspect}`;
  }
  switch (reading.kind) {
    case 'answered':
      return `The spawned Coral coordinator stopped, and the coordinator holding this address is draining. ${inspect}`;
    case 'unusable':
      return (
        'The spawned Coral coordinator stopped, and this address answered something this Coral build cannot read ' +
        `as coordinator health. ${inspect}`
      );
    case 'unanswered':
      return (
        'The spawned Coral coordinator stopped, and this invocation could not reach a coordinator at this address ' +
        `to see whether one is serving it (${reading.cause}), so whether one is remains unobserved. ${inspect}`
      );
    default:
      return assertNever(reading);
  }
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
  const readyDeadline = timePort.now() + timeoutMs;
  let terminalOutcome: SpawnedCoordinatorTerminal | null = null;
  // What this wait produces is the successor to a draining incumbent, so no route's admission may end it on a
  // draining coordinator: that would hand back the incumbent as its own replacement.
  const admission: RouteLifecycleAdmission = 'running';

  while (currentAttempt || timePort.now() < readyDeadline) {
    const info = readDiscoverySnapshot(paths);
    const observedReading = await readRawCoordinatorHealth(
      createIpcClient(info?.socketPath ?? expectedSocketPath, timePort),
    );
    const observedHealth = answeredHealth(observedReading);
    const observedPid: number | undefined = observedHealth?.pid ?? info?.pid;
    let servingIncumbent: ReadyCoordinatorEvidence | null = null;
    if (
      info &&
      mayInvocationBeServedByIncumbent(observedHealth, admission) &&
      isServingStatus(observedHealth.status, admission)
    ) {
      const authenticatedHealth = await readIdentityCheckedAuthenticatedHealth(
        info,
        expectedSocketPath,
        existingIncumbentIdentity(observedHealth),
        timePort,
        (value) => {
          const health = parseRawCoordinatorHealth(value);
          return health === null ? null : { health, identity: existingIncumbentIdentity(health) };
        },
      );
      if (
        authenticatedHealth.kind === 'health' &&
        mayInvocationBeServedByIncumbent(authenticatedHealth.health, admission) &&
        isServingStatus(authenticatedHealth.health.status, admission)
      ) {
        const health = authenticatedHealth.health;
        servingIncumbent = { info: mergeDiscoveryWithHealth(info, health), health };
        if (waitContext.kind !== 'current-attempt') {
          return servingIncumbent;
        }
        const lineage = resolveStartupAttemptLineage({
          observedAttemptId: health.env?.CORAL_STARTUP_ATTEMPT_ID,
          expectedAttemptId: waitContext.attemptId,
          observedIdentity: health,
          desiredIdentity: desired,
        });
        if (lineage.kind === 'proven-current-attempt') {
          return servingIncumbent;
        }
      }
    }

    const startupError = matchingStartupError(paths, desired, waitContext, observedPid);
    if (startupError) {
      switch (startupError.kind) {
        case 'documented':
        case 'self_authored':
          throw new CoralSetupError(startupError);
        case 'unrecognized_code':
          throw new BackendUnreachableError(unrecognizedStartupCodeMessage(startupError));
        case 'unrenderable_context':
          throw new BackendUnreachableError(unrenderableStartupContextMessage(startupError));
        case 'invalid_diagnostic':
          throw new BackendUnreachableError(
            'Coordinator startup stopped with a setup-error diagnostic that carries no readable code. Run `coral-cli backend status` to inspect the recorded failure, then reinstall or upgrade the selected Coral build and retry the original command.',
          );
        default:
          return assertNever(startupError);
      }
    }
    if (terminalOutcome !== null) {
      // Attempt lineage governs only a live child: while the exact child runs, a coordinator that cannot be
      // tied to it may be someone else's and must not end the wait. Once that child is terminal and left no
      // refusal of its own, the question is the one `reuseServingIncumbent` answers before any spawn — is an
      // identity-checked, ready coordinator serving this address — and its answer does not depend on which
      // build bound it. Conceding to an incumbent that outranks it is a normal way for the child to exit.
      if (servingIncumbent !== null) {
        return servingIncumbent;
      }
      // A terminal child that left no refusal is not evidence the address is dead: the incumbent it conceded
      // to may still be in `starting`, which is not a serving status and so cannot produce a serving incumbent
      // here.
      if (mayInvocationBeServedByIncumbent(observedHealth, admission)) {
        return waitForBackendReady(
          paths,
          desired,
          timeoutMs,
          timePort,
          { kind: 'existing-starting' },
          expectedSocketPath,
        );
      }
      throw new BackendUnreachableError(endedStartupMessage(terminalOutcome, observedReading));
    }

    if (waitContext.kind === 'current-attempt') {
      terminalOutcome = await Promise.race([waitContext.terminal, timePort.sleep(STARTUP_POLL_MS).then(() => null)]);
    } else {
      await timePort.sleep(STARTUP_POLL_MS);
    }
  }
  throw new BackendUnreachableError(
    'Timed out waiting for Coral coordinator startup. Run `coral-cli backend status` to check coordinator health.',
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
): Promise<ReadyCoordinatorEvidence> {
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
    // A child may neither start nor replace a coordinator, so no route's admission may let a draining parent
    // serve it: the refusal it would then carry names an exit the child cannot take.
    if (info !== null && isServingStatus(health.status, 'running')) {
      return { info: mergeDiscoveryWithHealth(info, health), health };
    }

    await timePort.sleep(STARTUP_POLL_MS);
    health = answeredHealth(await readRawCoordinatorHealth(createIpcClient(socketPath, timePort)));
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
  const ready = await waitForExistingIncumbentReady(paths, socketPath, health, KERNEL_READY_DEADLINE_MS, timePort);
  return summarizeBackend(ready.info, ready.health, timePort, 'none');
}

/**
 * `null` releases the invocation to the replacement path, and only an incumbent observed `starting` may be
 * held in the startup wait instead: a coordinator that is not starting does not become servable by waiting,
 * and spending the startup budget on one ends in a timeout no operator can act on.
 */
async function reuseServingIncumbent(
  paths: CoordinatorPaths,
  socketPath: string,
  desired: DesiredCoordinator,
  health: RawCoordinatorHealth,
  admission: RouteLifecycleAdmission,
  timePort: TimePort,
): Promise<EnsuredIpcClient | null> {
  const info = readDiscoverySnapshot(paths);
  if (info !== null) {
    const authenticatedHealth = await readIdentityCheckedAuthenticatedHealth(
      info,
      socketPath,
      existingIncumbentIdentity(health),
      timePort,
      (value) => {
        const decoded = parseRawCoordinatorHealth(value);
        return decoded === null ? null : { health: decoded, identity: existingIncumbentIdentity(decoded) };
      },
    );
    if (authenticatedHealth.kind === 'unavailable') {
      return null;
    }
    const answeredHealth = authenticatedHealth.health;
    if (isServingStatus(answeredHealth.status, admission)) {
      return summarizeBackend(mergeDiscoveryWithHealth(info, answeredHealth), answeredHealth, timePort, 'boot');
    }
    if (answeredHealth.status !== 'starting') {
      return null;
    }
  } else if (health.status !== 'starting') {
    return null;
  }

  const ready = await waitForBackendReady(
    paths,
    desired,
    KERNEL_READY_DEADLINE_MS,
    timePort,
    { kind: 'existing-starting' },
    socketPath,
  );
  return summarizeBackend(ready.info, ready.health, timePort, 'boot');
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
  return summarizeBackend(ready.info, ready.health, timePort, 'boot');
}

async function ensureTopLevelCoordinator(
  reach: CoordinatorReach,
  admission: RouteLifecycleAdmission,
): Promise<EnsuredIpcClient> {
  const { root, flavor, paths, timePort } = reach;
  const { socketPath, health } = reach.observation;
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
  if (mayInvocationBeServedByIncumbent(health, admission)) {
    const incumbent = await reuseServingIncumbent(paths, socketPath, desired, health, admission, timePort);
    if (incumbent !== null) {
      return incumbent;
    }
    // `reuseServingIncumbent` failing is not proof the incumbent is gone — an
    // unauthenticated `ping` already showed it live moments ago, and a single
    // dropped authenticated round-trip looks identical to a dead incumbent.
    // Re-probe and retry once before conceding: spawning a fresh coordinator
    // against a still-serving incumbent is exactly how two builds end up
    // racing `bindWithHandoff` for the same socket. `mayProcessReplaceIncumbent`
    // is the explicit gate for "is spawning even on the table here".
    replacementEvidence = answeredHealth(await readRawCoordinatorHealth(createIpcClient(socketPath, timePort)));
    if (mayInvocationBeServedByIncumbent(replacementEvidence, admission)) {
      const retried = await reuseServingIncumbent(paths, socketPath, desired, replacementEvidence, admission, timePort);
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
  const health = answeredHealth(await readRawCoordinatorHealth(createIpcClient(paths.socketPath, timePort)));
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
    health: answeredHealth(await readRawCoordinatorHealth(createIpcClient(info.socketPath, timePort))),
  };
}

/**
 * What one observation of this namespace's coordinator produced, held together so the admission a route needs
 * is the only thing left to choose. A second entry point that re-derived these would be a second reach, and
 * the identity check it performs is the whole reason a refused invocation may not simply dial the record.
 */
type CoordinatorReach = Readonly<{
  root: string;
  flavor: 'prod' | 'dev';
  runtime: Runtime;
  paths: CoordinatorPaths;
  timePort: TimePort;
  observation: CoordinatorObservation;
}>;

async function reachCoordinator(
  pluginRoot: string | undefined,
  timePort: TimePort | undefined,
): Promise<CoordinatorReach> {
  const root = resolvePluginRoot(pluginRoot);
  const flavor = readBuildFlavor(root);
  const runtime = createRealRuntime(flavor);
  const ipcTime = timePort ?? runtime.time;
  const paths = runtime.paths.coral.coordinator;
  return {
    root,
    flavor,
    runtime,
    paths,
    timePort: ipcTime,
    observation: await observeCoordinator(runtime, paths, ipcTime),
  };
}

/**
 * Reach the coordinator this namespace has, starting one when none is serving. The kernel's exclusive-bind
 * semantics on the IPC socket remain the single arbiter of the canonical incumbent.
 *
 * The invocation's method, not an admission, is what a caller passes: whether a draining incumbent may serve
 * it is the operational catalog's answer, and a caller able to state that answer itself is a caller able to
 * disagree with the server that enforces it.
 */
export async function ensure(method: string, pluginRoot?: string, timePort?: TimePort): Promise<EnsuredIpcClient> {
  const reach = await reachCoordinator(pluginRoot, timePort);
  if (isCoralChildEnvironment(reach.runtime.env.fullSnapshot())) {
    return ensureChildIncumbent(reach.paths, reach.observation.socketPath, reach.observation.health, reach.timePort);
  }
  return ensureTopLevelCoordinator(reach, ipcRouteLifecycleAdmission(method));
}

/**
 * Obtain the successor a refused invocation may re-issue against. The reach is entered again rather than
 * spawned past: the coordinator that refused may have finished releasing, or a running one may have taken the
 * address meanwhile, and either is the successor. The admission is `'running'` whatever the route admits —
 * handing the refusing incumbent back as its own successor is the one answer that cannot discharge anything.
 *
 * Release that never comes is answered with the refusal itself: the operator needs to know which method was
 * refused, and `backend_unreachable` names neither the method nor an exit from the hold.
 */
async function ensureSuccessorAfterLifecycleRefusal(
  refusal: IpcLifecycleRefusal,
  pluginRoot?: string,
  timePort?: TimePort,
): Promise<EnsuredIpcClient> {
  const reach = await reachCoordinator(pluginRoot, timePort);
  // A child may neither start nor replace a coordinator, so it has no successor to obtain and the refusal is
  // the whole answer. Reaching a draining parent is already refused before any request, so a child holding
  // one of these arrived by a route this function must not widen.
  if (isCoralChildEnvironment(reach.runtime.env.fullSnapshot())) {
    throw refusal;
  }
  try {
    return await ensureTopLevelCoordinator(reach, 'running');
  } catch (error: unknown) {
    if (error instanceof CoordinatorSocketReleaseTimeout) {
      throw refusal.stillHoldingAddress(error.budgetMs);
    }
    // Whatever else failed here was reached only because of the refusal. This error keeps its own class and
    // exit, and the refusal rides as `cause` for the renderer to fold into the remediation — see
    // withLifecycleRefusalCause in src/cli/errors.ts. An already-set `cause` is another failure's evidence
    // and is not replaced, a non-Error throw has no `cause` to set, and a renderer whose walk does not reach
    // the refusal appends nothing: on any of these nothing else carries the refusal, so the operator
    // receives only this error.
    if (error instanceof Error && error.cause === undefined) {
      error.cause = refusal;
    }
    throw error;
  }
}

/**
 * Issue one invocation against the coordinator this namespace has, and — for a route whose successor can
 * discharge it — once more against a successor when the reached incumbent refused it on lifecycle grounds.
 *
 * Re-issuing may repeat no work, so a lifecycle-refused method must not have executed; see 'keeps unrelated
 * catalog methods closed while draining' in tests/unit/transport/ipc/draining-recovery.test.ts. And exactly one re-issue: a
 * successor that refuses in turn has answered, so trying again would be a retry loop against a hold no spawn
 * can clear.
 */
export async function issueWithSuccessorAfterLifecycleRefusal<TResult>(
  method: string,
  pluginRoot: string | undefined,
  issue: (client: Pick<IpcClient, 'request'>) => Promise<TResult>,
  timePort?: TimePort,
): Promise<TResult> {
  const incumbent = await ensure(method, pluginRoot, timePort);
  try {
    return await issue(incumbent);
  } catch (error: unknown) {
    // The disposition is the refused route's, not the reached route's: an `issue` that falls back to a second
    // method must be answered for the method the coordinator actually refused.
    if (!(error instanceof IpcLifecycleRefusal) || ipcRouteRefusalDisposition(error.method) === 'report-refusal') {
      throw error;
    }
    return issue(await ensureSuccessorAfterLifecycleRefusal(error, pluginRoot, timePort));
  }
}
