import { z } from 'zod';

import { BUILD_FLAVOR_ENV_KEY, resolveBuildFlavor } from '../infra/build-flavor.js';
import { backendLog } from '../infra/backend-log.js';
import type { StrictBundleIdentityResult } from '../infra/bundle-manifest.js';
import { createMonotonicClock, type MonotonicClock } from '../infra/monotonic-clock.js';
import { probeProcessStartedAtSeconds } from '../infra/node-process.js';
import { providerProxyBootstrapCapsulePath, providerReaperBootstrapCapsulePath } from '../infra/path/index.js';
import { PROXY_DISAPPEARANCE_CONFIRM_MS, SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import {
  ABSENCE_POLL_MS,
  type ProcessContainmentEnvironment,
  type RecordedContainmentIdentity,
  type RecordedProcessIdentity,
} from '../infra/process-containment.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime } from '../runtime/ports.js';
import {
  consumeProviderBootstrapCapsule,
  type GuardianBootstrapCapsule,
  type ProviderBootstrapCapsuleEnvironment,
} from './bootstrap-capsule.js';
import {
  MAX_PROXY_RECORDED_PROVIDER_ROOTS,
  type EnforcementOutcome,
  type EnforcementScheduler,
} from './enforcement.js';
import { DETACHED_CONTAINMENT_KIND, createGuardian, type Guardian } from './guardian.js';
import type { ProviderOperationKey } from './ledger.js';
import {
  createEnforcerDeadlineStateMachine,
  resolveProviderProxyDeadlineConfiguration,
  type EnforcerDeadlineStateMachine,
} from './orphan-deadline.js';
import type { OperationStageHandle } from './operation-supervisor.js';
import type { ControlClient } from './control-client.js';
import {
  guardianRegisterProviderRootParamsSchema,
  guardianProxyOperationReleaseParamsSchema,
  guardianProxyOperationReleaseResultSchema,
  jointContainmentReceiptSchema,
  providerRootSchema,
  reservationSchema,
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  controlPairParamsSchema,
  controlPairResultSchema,
  type JointContainmentReceipt,
  type ProxyIdentity,
  type ProxyPreparedAppServerOperation,
} from './protocol.js';
import { createProxy, type Proxy, type ProxyOptions } from './proxy.js';
import { createReaper, type Reaper } from './reaper.js';
import { createProxyAppServerHostAuthority } from './provider-root-authority.js';
import { createSemanticOperationRuntime, type SemanticOperationStageHandle } from './semantic-operation-runner.js';
import {
  connectRoleControlWithRetry,
  runtimeControlTimer,
  spawnRoleProcess,
  type RoleSpawnPorts,
  type SpawnedRoleProcess,
} from './role-spawn.js';
import type { ProviderRoleArgv } from './role-argv.js';

/**
 * Runs one provider-role process: guardian, reaper, or proxy.
 *
 * The spawn topology this file drives has a circular dependency the reaper already shows the shape of: the
 * guardian creates the proxy containment by spawning it, but must already be listening before the proxy can
 * connect — so its enforcer arms from `guardian.recordContainment`, not from construction, exactly mirroring
 * how the reaper's enforcer arms from `reaper.record-containment.v1` rather than from its own construction.
 */

/** How long a role main waits for a just-spawned peer to bind its control socket before giving up. A spawn
 *  call returns as soon as the OS has scheduled the process, not once it is listening. */
const ROLE_SPAWN_READY_DEADLINE_MS = 10_000;
const ROLE_SPAWN_READY_RETRY_INTERVAL_MS = 20;
const ROLE_CONNECT_TIMEOUT_MS = 2_000;

// One `unique symbol` per role clock, so a clock built for one role's containment can never type-check as
// interchangeable with another's — each is its own process-local authority.
const guardianConstructionUnwindClockScope: unique symbol = Symbol('coral.provider-proxy.guardian-unwind');
const guardianRoleClockScope: unique symbol = Symbol('coral.provider-proxy.guardian');
const reaperRoleClockScope: unique symbol = Symbol('coral.provider-proxy.reaper');
const proxyRoleClockScope: unique symbol = Symbol('coral.provider-proxy.proxy');

export type ProviderRoleMainPorts = Readonly<{
  runtime: Runtime;
  pluginRoot: string;
  /** Overrides the capsule/endpoint path base directory; defaults to the real `~/.coral` tree. Tests pass a
   *  scoped temp directory so they never touch real user state. */
  baseDir?: string;
  /** Injected for tests; defaults to the real embedded-vs-adjacent-manifest strict identity check. */
  resolveStrictIdentity?(): StrictBundleIdentityResult;
  /** Injected for tests; defaults to the real per-platform `/proc` or `ps` probe. */
  readProcessStartedAtSeconds?(pid: number, platform: NodeJS.Platform): number | null;
  /** Injected for tests; defaults to the real `process.exit`. Called once a guardian or reaper's enforcement
   *  outcome has settled and its own control has closed — its only reason to keep running was bounding one
   *  containment, and there is nothing left to bound once teardown is done. */
  exitProcess?(code: number): void;
  /** Test-only observation hook: called the instant the guardian's `listen()` resolves, strictly before the
   *  proxy is spawned. Exists so a test can record a sequence number here and at the spawn call and assert
   *  the ordering directly, rather than via an assertion that would hold whichever order actually ran. */
  onGuardianListening?(): void;
}>;

function buildCapsuleEnv(ports: ProviderRoleMainPorts): ProviderBootstrapCapsuleEnvironment {
  return {
    storage: ports.runtime.storage,
    uid: process.getuid?.() ?? 0,
    ...(ports.resolveStrictIdentity === undefined ? {} : { resolveStrictIdentity: ports.resolveStrictIdentity }),
  };
}

function buildScheduler(runtime: Runtime): EnforcementScheduler {
  return {
    schedule: (callback, ms) => runtime.time.setTimeout(callback, ms),
    cancel: (handle) => runtime.time.clearTimeout(handle),
  };
}

function buildContainmentEnvironment<Scope extends symbol>(
  clock: MonotonicClock<Scope>,
  ports: ProviderRoleMainPorts,
): ProcessContainmentEnvironment<Scope> {
  return {
    maxRecordedRoots: MAX_PROXY_RECORDED_PROVIDER_ROOTS,
    clock,
    process: { kill: ports.runtime.process.kill, isAlive: ports.runtime.process.isAlive },
    platform: ports.runtime.env.platform() as NodeJS.Platform,
    ...(ports.readProcessStartedAtSeconds === undefined
      ? {}
      : { readProcessStartedAtSeconds: ports.readProcessStartedAtSeconds }),
  };
}

function buildDeadlines<Scope extends symbol>(
  clock: MonotonicClock<Scope>,
  ports: ProviderRoleMainPorts,
): EnforcerDeadlineStateMachine<Scope> {
  return createEnforcerDeadlineStateMachine(clock, resolveProviderProxyDeadlineConfiguration(ports.runtime.env), {
    mintChallenge: () => ports.runtime.ids.uuid(),
  });
}

function buildSpawnPorts(ports: ProviderRoleMainPorts): RoleSpawnPorts {
  return {
    process: ports.runtime.process,
    runtime: ports.runtime,
    platform: ports.runtime.env.platform() as NodeJS.Platform,
    ...(ports.readProcessStartedAtSeconds === undefined
      ? {}
      : { readProcessStartedAtSeconds: ports.readProcessStartedAtSeconds }),
  };
}

/** How the deferred close-and-exit below schedules itself; real callers source it from the runtime's own
 *  timer port, tests supply a synchronous stand-in so the assertion does not have to race a real timer. */
type RoleOutcomeScheduler = (callback: () => void) => void;

function realRoleOutcomeScheduler(ports: ProviderRoleMainPorts): RoleOutcomeScheduler {
  return (callback) => {
    ports.runtime.time.setTimeout(callback, 0);
  };
}

/** This role's own pid and start time. A role that cannot read its own start time cannot construct an
 *  identity anyone else could later verify against, so it fails rather than reporting a bare pid. */
function readSelfIdentity(ports: ProviderRoleMainPorts): Readonly<{ pid: number; processStartedAtSeconds: number }> {
  const pid = ports.runtime.env.pid();
  const platform = ports.runtime.env.platform() as NodeJS.Platform;
  const read = ports.readProcessStartedAtSeconds ?? probeProcessStartedAtSeconds;
  const processStartedAtSeconds = read(pid, platform);
  if (processStartedAtSeconds === null) {
    throw new Error(`Could not read this process's own start time (pid ${pid}).`);
  }
  return { pid, processStartedAtSeconds };
}

function reaperCapsulePathFrom(capsule: GuardianBootstrapCapsule, baseDir: string | undefined): string {
  return providerReaperBootstrapCapsulePath(
    {
      generation: capsule.generation,
      flavor: capsule.flavor,
      buildSetId: capsule.buildSetId,
      hostFingerprint: capsule.hostFingerprint,
      reaperInstanceId: capsule.reaperInstanceId,
    },
    { baseDir },
  );
}

function proxyCapsulePathFrom(capsule: GuardianBootstrapCapsule, baseDir: string | undefined): string {
  return providerProxyBootstrapCapsulePath(
    {
      generation: capsule.generation,
      flavor: capsule.flavor,
      buildSetId: capsule.buildSetId,
      hostFingerprint: capsule.hostFingerprint,
      proxyInstanceId: capsule.proxyInstanceId,
    },
    { baseDir },
  );
}

export type GuardianRoleHandle = Readonly<{
  role: 'guardian';
  guardian: Guardian<symbol>;
  reaperSpawn: SpawnedRoleProcess;
  proxySpawn: SpawnedRoleProcess;
  close(): Promise<void>;
  /** What a SIGTERM asks for: give up and reap the proxy containment this guardian's enforcer was armed on,
   *  rather than merely disarm and disappear — the same close-and-exit path a cooperative
   *  `guardian.stop-and-reap.v1` RPC takes, reached here directly instead of over the wire. Falls back to a
   *  plain close on the (unreachable in production) window before any containment was ever recorded, since
   *  there is nothing yet to reap. */
  giveUp(): Promise<EnforcementOutcome>;
}>;

export type ReaperRoleHandle = Readonly<{
  role: 'reaper';
  reaper: Reaper<symbol>;
  close(): Promise<void>;
  /** The reaper's own half of `GuardianRoleHandle.giveUp`: reaps the same containment its enforcer was
   *  independently armed on, so a SIGTERM reaching this process (it shares the guardian's process group)
   *  enforces rather than merely disarms even if the guardian did not survive to do so itself. */
  giveUp(): Promise<EnforcementOutcome>;
}>;

export type ProxyRoleHandle = Readonly<{
  role: 'proxy';
  proxy: Proxy;
  close(): Promise<void>;
}>;

export type ProviderRoleHandle = GuardianRoleHandle | ReaperRoleHandle | ProxyRoleHandle;

/** Whether `identity` still names the exact process it was recorded from. A readable-but-different start
 *  time means a different process now holds this pid; an unreadable one means it is already gone, or was
 *  never reachable. Either way, a mismatch means there is nothing this identity still names — signalling the
 *  bare pid would risk hitting whatever now holds it. */
function isStillTheRecordedProcess<Scope extends symbol>(
  identity: RecordedProcessIdentity,
  environment: ProcessContainmentEnvironment<Scope>,
): boolean {
  const read = environment.readProcessStartedAtSeconds ?? probeProcessStartedAtSeconds;
  try {
    return read(identity.pid, environment.platform) === identity.processStartedAtSeconds;
  } catch {
    return false;
  }
}

/**
 * Signals `target`, then confirms it gone rather than assuming so: waits up to `graceMs` for it to
 * disappear, then holds a further confirmation window before declaring success — the same
 * disappear-then-confirm discipline `reapRecordedContainment` (`infra/process-containment.ts`) itself uses,
 * so a target that flickers dead-then-alive across one lucky poll is not mistaken for reaped.
 */
async function signalAndConfirmAbsence<Scope extends symbol>(
  target: number,
  signal: NodeJS.Signals,
  graceMs: number,
  clock: MonotonicClock<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<boolean> {
  environment.process.kill(target, signal);
  const waitDeadline = clock.shiftMilliseconds(clock.now(), graceMs);
  while (environment.process.isAlive(target) && clock.compare(clock.now(), waitDeadline) < 0) {
    await clock.sleep(ABSENCE_POLL_MS);
  }
  if (environment.process.isAlive(target)) return false;

  const confirmDeadline = clock.shiftMilliseconds(clock.now(), PROXY_DISAPPEARANCE_CONFIRM_MS);
  while (clock.compare(clock.now(), confirmDeadline) < 0) {
    if (environment.process.isAlive(target)) return false;
    const remainingMs = clock.millisecondsBetween(clock.now(), confirmDeadline);
    await clock.sleep(Math.max(0, Math.min(ABSENCE_POLL_MS, remainingMs)));
  }
  return !environment.process.isAlive(target);
}

/** Reaps one signal target — SIGTERM, escalating to SIGKILL after the standard grace period, absence
 *  confirmed after each — throwing only once both have failed to produce a confirmed exit. */
async function reapUnheldTarget<Scope extends symbol>(
  target: number,
  targetLabel: string,
  clock: MonotonicClock<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<void> {
  if (await signalAndConfirmAbsence(target, 'SIGTERM', SIGTERM_GRACE_MS, clock, environment)) return;
  if (await signalAndConfirmAbsence(target, 'SIGKILL', SIGKILL_GRACE_MS, clock, environment)) return;
  throw new Error(`Could not confirm ${targetLabel} exited after SIGTERM and SIGKILL.`);
}

/**
 * Best-effort cleanup for a detached role process (the proxy: spawned with `detached: true`) this attempt
 * itself spawned but can no longer hold, because a later cut in the same construction failed. A detached
 * spawn is its own process-group leader by that OS guarantee — the identical fact
 * `guardian.recordContainment`'s own `processGroupId: proxySpawn.pid` call already relies on — so this takes
 * a full `RecordedContainmentIdentity` and asserts that shape rather than trusting a bare pid plus an
 * easily-mistyped "signal the group" flag.
 *
 * Not a call to `reapRecordedContainment` itself: that function observes whether its target is already
 * absent *before* ever signalling it — correct for a containment that may be reaped long after it was
 * recorded, but wrong here, where the target is a process this very construction attempt spawned moments ago
 * and is expected to still be alive. Skipping straight to "already absent" on an unrelated liveness-probe gap
 * (this module's `environment.process.isAlive` has no reason to know about a role process before it is ever
 * recorded as a live containment) would silently abandon a real cleanup. This reuses that function's
 * monotonic-clock, confirm-after-signal discipline directly instead of its observe-first entry point.
 */
async function reapUnheldProcessGroup<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  clock: MonotonicClock<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<void> {
  if (containment.processGroupId !== containment.pid) {
    throw new Error(
      `Recorded containment pid=${containment.pid} is not its own process-group leader (processGroupId=${containment.processGroupId}).`,
    );
  }
  if (!isStillTheRecordedProcess(containment, environment)) return;
  await reapUnheldTarget(
    -containment.processGroupId,
    `process group ${containment.processGroupId}`,
    clock,
    environment,
  );
}

/**
 * Best-effort cleanup for an ordinary (non-detached) role process (the reaper) this attempt itself spawned
 * but can no longer hold. Signalled by its own pid, never a group: an undetached child shares its parent's
 * process group rather than establishing one of its own, so it never had a group to target.
 */
async function reapUnheldOrdinaryProcess<Scope extends symbol>(
  identity: RecordedProcessIdentity,
  clock: MonotonicClock<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<void> {
  if (!isStillTheRecordedProcess(identity, environment)) return;
  await reapUnheldTarget(identity.pid, `pid=${identity.pid}`, clock, environment);
}

/** A wake later than the model's enforcement bound, or a reap that failed outright — exit code for the
 *  latter, distinct from the `0` a confirmed `containment-absent` exits with. */
const ROLE_ENFORCEMENT_FAILURE_EXIT_CODE = 1;

export type RoleEnforcementOutcomeHandlers = Readonly<{
  onOutcome(outcome: EnforcementOutcome): void;
  onProgressViolation(observedWakeLatencyMs: number): void;
}>;

export type RoleEnforcementOutcomeOptions<Scope extends symbol> = Readonly<{
  role: 'guardian' | 'reaper';
  deadlines: Pick<EnforcerDeadlineStateMachine<Scope>, 'markExited'>;
  /** Closes this role's own control (and, for the guardian, its reaper pairing channel too). */
  close(): Promise<void>;
  exitProcess(code: number): void;
  schedule: RoleOutcomeScheduler;
}>;

/**
 * How a guardian or reaper role reacts once its own enforcer's teardown settles. A role process's only
 * reason to keep running is bounding one containment, so once that is truly done — `containment-absent` —
 * there is nothing left to hold and the process must exit; without this, the deadline model's `exited` state
 * is unreachable in production and the process leaks forever. A `reap-failed` outcome exits too, since this
 * role has no retry of its own to fall back on, but it never claims the `exited` state the model reserves
 * for a confirmed reap.
 *
 * The close-and-exit is deferred past the current synchronous continuation, not run inline: `onOutcome` is
 * invoked from *inside* `enforcement.ts`'s own `settle()`, which runs before a caller's own in-flight
 * `*.stop-and-reap.v1` RPC handler ever resumes from its `await` — closing sockets here synchronously would
 * destroy that caller's connection before its own response reaches the wire. Deferring lets every microtask
 * already queued, including that response's `write()`, run first.
 */
export function buildEnforcementOutcomeHandlers<Scope extends symbol>(
  options: RoleEnforcementOutcomeOptions<Scope>,
): RoleEnforcementOutcomeHandlers {
  return {
    onOutcome: (outcome) => {
      options.schedule(() => {
        if (outcome.kind === 'containment-absent') {
          options.deadlines.markExited();
        } else {
          backendLog.error(`${options.role}: containment reap failed`, outcome.reason);
        }
        void options
          .close()
          .catch((error: unknown) => backendLog.error(`${options.role}: close on exit failed`, error))
          .finally(() =>
            options.exitProcess(outcome.kind === 'containment-absent' ? 0 : ROLE_ENFORCEMENT_FAILURE_EXIT_CODE),
          );
      });
    },
    onProgressViolation: (observedWakeLatencyMs) => {
      // A late wake is a detected progress-premise failure the plan requires be reported, not an execution
      // that silently counts as satisfying the enforcement guarantee — teardown still proceeds regardless.
      backendLog.warn(`${options.role}: enforcement wake exceeded the modelled bound by ${observedWakeLatencyMs}ms`);
    },
  };
}

/**
 * Unwinds a guardian construction attempt that failed partway through, using only what was actually created
 * by the point of failure. Ordered in fixed phases, not merely by reverse creation order, because the two
 * differ once every phase exists: stop scheduled work first (closing the guardian also disarms its
 * enforcer), then close every opened control, then identity-check and reap every process this attempt
 * started, newest first. A control left open while its process is being signalled could observe a partial,
 * contradictory state; a live enforcement tick firing mid-unwind could reap concurrently with this function.
 * Every phase runs regardless of an earlier one failing — failures are reported, not left to abandon the
 * rest — because a cleanup that gave up on its first error is exactly how a set stays half-abandoned.
 */
async function unwindGuardianConstruction(
  ports: ProviderRoleMainPorts,
  partial: Readonly<{
    close: (() => Promise<void>) | null;
    reaperChannel: Pick<ControlClient, 'close'> | null;
    reaperSpawn: SpawnedRoleProcess | null;
    proxySpawn: SpawnedRoleProcess | null;
  }>,
): Promise<void> {
  const stranded: string[] = [];
  const attempt = async (label: string, run: () => Promise<void> | void): Promise<void> => {
    try {
      await run();
    } catch (error: unknown) {
      stranded.push(label);
      backendLog.error(`guardian construction cleanup could not ${label}`, error);
    }
  };

  // Phase 1: stop scheduled work and close every opened control. `close` (once the guardian exists) already
  // disarms its enforcer before closing the reaper channel and its own endpoint, in that order; before the
  // guardian exists there is only the reaper channel to close, and nothing yet scheduled to disarm.
  if (partial.close !== null) {
    await attempt('close the guardian control', partial.close);
  } else if (partial.reaperChannel !== null) {
    const reaperChannel = partial.reaperChannel;
    await attempt('close the reaper control channel', () => reaperChannel.close());
  }

  // Phase 2: identity-check and reap every process this attempt started, newest first. Its own scoped clock,
  // matching the pattern every role's own construction (`startProviderGuardianRole`, `startProviderReaperRole`,
  // `startProviderProxyRole`) already uses to mint one on demand rather than share another subsystem's.
  const clock = createMonotonicClock(guardianConstructionUnwindClockScope);
  const environment = buildContainmentEnvironment(clock, ports);
  if (partial.proxySpawn !== null) {
    const proxySpawn = partial.proxySpawn;
    await attempt('reap the proxy process group', () =>
      reapUnheldProcessGroup(
        {
          pid: proxySpawn.pid,
          processStartedAtSeconds: proxySpawn.processStartedAtSeconds,
          processGroupId: proxySpawn.pid,
        },
        clock,
        environment,
      ),
    );
  }
  if (partial.reaperSpawn !== null) {
    const reaperSpawn = partial.reaperSpawn;
    await attempt('reap the reaper process', () => reapUnheldOrdinaryProcess(reaperSpawn, clock, environment));
  }

  // Phase 3: capsules and endpoints are removed by the coordinator's own acquisition steps once it observes
  // this rejection; this attempt owns no capsule path of its own to remove.
  if (stranded.length > 0) {
    backendLog.error(`guardian construction failed and could not clean up: ${stranded.join(', ')}`);
  }
}

/**
 * Races a role's own readiness against its spawn's async failure, so a spawn error the OS reports after the
 * synchronous `spawn()` call already returned surfaces here as this attempt's own rejection rather than
 * waiting out the full readiness wait — or worse, escaping as an uncaught exception with no listener at all.
 * `readiness` is given a no-op catch: `Promise.race` never observes a losing promise's eventual settlement,
 * so if the spawn failure wins the race first, `readiness`'s own later rejection must not become an
 * unhandled one.
 */
function raceReadinessAgainstSpawnFailure<T>(readiness: Promise<T>, spawnFailed: Promise<never>): Promise<T> {
  readiness.catch(() => {});
  return Promise.race([readiness, spawnFailed]);
}

/**
 * Runs the guardian: consumes its capsule, spawns the reaper outside the future proxy group, pairs with it,
 * starts listening, spawns the proxy as a new process-group leader, and records the containment it watched
 * being created. Each step is awaited in this exact order because the next one depends on it: the reaper
 * must exist before it can be paired with, the guardian must be listening before the proxy can connect to
 * it, and the proxy's pid and start time must be known before there is anything to record.
 *
 * The guardian owns the two cuts this function can fail at — the reaper spawn/pairing and the proxy spawn —
 * and therefore owns unwinding them: a half-built set is worse than none, because the enforcers arm on their
 * own clocks and would eventually reap themselves while the coordinator still believes the set never
 * existed. `reaperSpawn`, `reaperChannel`, `close`, and `proxySpawn` are tracked outside the `try` so the
 * `catch` can unwind exactly what this attempt actually created, however far it got.
 */
export async function startProviderGuardianRole(
  capsulePath: string,
  ports: ProviderRoleMainPorts,
): Promise<GuardianRoleHandle> {
  const capsule = consumeProviderBootstrapCapsule(capsulePath, 'guardian', buildCapsuleEnv(ports));
  const clock = createMonotonicClock(guardianRoleClockScope);
  const deadlines = buildDeadlines(clock, ports);
  const containmentEnvironment = buildContainmentEnvironment(clock, ports);
  const timer = runtimeControlTimer(ports.runtime);
  const spawnPorts = buildSpawnPorts(ports);
  // The child inherits none of this process's CORAL_* env (composeChildEnv strips it), so the flavor that
  // selects which artifact identity a spawned peer expects must be re-asserted explicitly.
  const flavorEnv = { [BUILD_FLAVOR_ENV_KEY]: capsule.flavor };
  const exitProcess = ports.exitProcess ?? ((code: number): void => process.exit(code));
  const schedule = realRoleOutcomeScheduler(ports);

  let reaperSpawn: SpawnedRoleProcess | null = null;
  let reaperChannel: ControlClient | null = null;
  let close: (() => Promise<void>) | null = null;
  let proxySpawn: SpawnedRoleProcess | null = null;

  try {
    reaperSpawn = spawnRoleProcess('reaper', reaperCapsulePathFrom(capsule, ports.baseDir), spawnPorts, {
      pluginRoot: ports.pluginRoot,
      detached: false,
      envAdditions: flavorEnv,
    });

    const reaperConnected = connectRoleControlWithRetry(capsule.reaperControlEndpoint, timer, {
      connectTimeoutMs: ROLE_CONNECT_TIMEOUT_MS,
      retryIntervalMs: ROLE_SPAWN_READY_RETRY_INTERVAL_MS,
      overallDeadlineMs: ROLE_SPAWN_READY_DEADLINE_MS,
      now: () => ports.runtime.time.now(),
      sleep: (ms) => ports.runtime.time.sleep(ms),
    });
    reaperChannel = await raceReadinessAgainstSpawnFailure(reaperConnected, reaperSpawn.spawnFailed);
    const pairingResult = await reaperChannel.call(
      'reaper.pair.v1',
      controlPairParamsSchema.parse({ pairingSecret: capsule.guardianReaperAuthSecret }),
      PROXY_CONTROL_RPC_TIMEOUT_MS,
    );
    controlPairResultSchema.parse(pairingResult);

    const pairedReaperChannel = reaperChannel;
    // Forward-referenced by `close` below (assigned into `createGuardian`'s own `onOutcome` before the
    // guardian it closes exists), then assigned exactly once — `let` is load-bearing here, not a style choice.
    // eslint-disable-next-line prefer-const
    let guardianRef!: Guardian<symbol>;
    close = async (): Promise<void> => {
      pairedReaperChannel.close();
      await guardianRef.close();
    };
    // Captured once `close` holds its real value, so `giveUp` below closes over a function rather than the
    // `(() => Promise<void>) | null` type `close` itself carries for the rest of this attempt.
    const closeGuardian = close;
    const { onOutcome, onProgressViolation } = buildEnforcementOutcomeHandlers({
      role: 'guardian',
      deadlines,
      close,
      exitProcess,
      schedule,
    });
    guardianRef = createGuardian({
      capsule,
      clock,
      deadlines,
      containmentEnvironment,
      scheduler: buildScheduler(ports.runtime),
      timer,
      mintReceipt: () => ports.runtime.ids.uuid(),
      reaperChannel: pairedReaperChannel,
      self: readSelfIdentity(ports),
      reaperSelf: { pid: reaperSpawn.pid, processStartedAtSeconds: reaperSpawn.processStartedAtSeconds },
      onOutcome,
      onProgressViolation,
    });
    const guardian = guardianRef;

    await guardian.listen();
    ports.onGuardianListening?.();

    proxySpawn = spawnRoleProcess('proxy', proxyCapsulePathFrom(capsule, ports.baseDir), spawnPorts, {
      pluginRoot: ports.pluginRoot,
      detached: true,
      envAdditions: flavorEnv,
    });

    const containmentRecorded = guardian.recordContainment({
      pid: proxySpawn.pid,
      processStartedAtSeconds: proxySpawn.processStartedAtSeconds,
      processGroupId: proxySpawn.pid,
      containmentKind: DETACHED_CONTAINMENT_KIND,
    });
    await raceReadinessAgainstSpawnFailure(containmentRecorded, proxySpawn.spawnFailed);

    return {
      role: 'guardian',
      guardian,
      reaperSpawn,
      proxySpawn,
      close,
      giveUp: async (): Promise<EnforcementOutcome> => {
        const armed = guardian.enforcer();
        if (armed === null) {
          // Unreachable once this handle exists — `recordContainment` above always succeeds before this
          // function returns — but a null enforcer still has nothing to reap, so the plain close it would
          // otherwise have gotten on SIGTERM is the correct fallback rather than a thrown assertion.
          await closeGuardian();
          return { kind: 'reap-failed', reason: 'no containment was recorded to reap' };
        }
        return armed.stopAndReap(deadlines.bounds().exitDeadline);
      },
    };
  } catch (error: unknown) {
    await unwindGuardianConstruction(ports, { close, reaperChannel, reaperSpawn, proxySpawn });
    throw error;
  }
}

/** Runs the reaper: consumes its capsule and starts listening. It holds nothing to enforce until the
 *  guardian reports the containment it watched being created over `reaper.record-containment.v1`. */
export async function startProviderReaperRole(
  capsulePath: string,
  ports: ProviderRoleMainPorts,
): Promise<ReaperRoleHandle> {
  const capsule = consumeProviderBootstrapCapsule(capsulePath, 'reaper', buildCapsuleEnv(ports));
  const clock = createMonotonicClock(reaperRoleClockScope);
  const deadlines = buildDeadlines(clock, ports);
  const exitProcess = ports.exitProcess ?? ((code: number): void => process.exit(code));

  // Forward-referenced by `close` below (assigned into `createReaper`'s own `onOutcome` before the reaper it
  // closes exists), then assigned exactly once — `let` is load-bearing here, not a style choice.
  // eslint-disable-next-line prefer-const
  let reaperRef!: Reaper<symbol>;
  const close = (): Promise<void> => reaperRef.close();
  const { onOutcome, onProgressViolation } = buildEnforcementOutcomeHandlers({
    role: 'reaper',
    deadlines,
    close,
    exitProcess,
    schedule: realRoleOutcomeScheduler(ports),
  });

  reaperRef = createReaper({
    capsule,
    clock,
    deadlines,
    containmentEnvironment: buildContainmentEnvironment(clock, ports),
    scheduler: buildScheduler(ports.runtime),
    timer: runtimeControlTimer(ports.runtime),
    mintReceipt: () => ports.runtime.ids.uuid(),
    self: readSelfIdentity(ports),
    onOutcome,
    onProgressViolation,
  });
  await reaperRef.listen();

  return {
    role: 'reaper',
    reaper: reaperRef,
    close,
    giveUp: async (): Promise<EnforcementOutcome> => {
      const armed = reaperRef.enforcer();
      if (armed === null) {
        // The guardian has not yet forwarded a containment to reap — nothing armed, nothing to enforce, so
        // the plain close this process would otherwise have gotten on SIGTERM is the correct fallback.
        await close();
        return { kind: 'reap-failed', reason: 'no containment was recorded to reap' };
      }
      return armed.stopAndReap(deadlines.bounds().exitDeadline);
    },
  };
}

/** `guardian.register-provider-root.v1`'s reply, kept strict because the paired guardian is still a wire peer. */
const registerProviderRootResultSchema = z
  .object({
    state: z.literal('staged-contained'),
    providerRoot: providerRootSchema,
    jointContainmentReceipt: jointContainmentReceiptSchema,
  })
  .strict();

/** What `createProxyGuardianContainment` needs to talk to the guardian on the kernel's behalf, with every
 *  dependency that would otherwise force a real provider spawn or a real spawned guardian process taken as a
 *  parameter: `stageProviderRoot` in particular is captured from `semantic-operation.ts` in production, but a
 *  test can supply a canned root instead. */
export type ProxyGuardianContainmentDeps = Readonly<{
  identity: ProxyIdentity;
  guardianChannel: Pick<ControlClient, 'call'>;
  stageProviderRoot(key: ProviderOperationKey, prepared: ProxyPreparedAppServerOperation): SemanticOperationStageHandle;
}>;

/**
 * Builds the containment closures a proxy uses to talk to its guardian on the kernel's behalf:
 * `stageProviderRoot` (called from `operation.prepare.v1`). Extracted out of `startProviderProxyRole` so it can
 * be exercised against a real `createGuardian` in a test without spawning a real provider — only the semantic
 * stage needs replacing for
 * that, everything else here is the real wiring `startProviderProxyRole` itself installs.
 *
 * Takes no ledger access of any kind: `stageProviderRoot`'s `reservation` parameter is exactly what
 * `ledger.prepare()` already returned to `proxy.ts`'s own caller, passed straight through rather than fetched
 * here a second time. A seam that could independently ask the ledger for "the" reservation is a seam that can
 * be asked before one exists — and minting a fresh one to answer anyway is exactly how this bug shipped; a
 * seam with no such question to ask cannot make that mistake.
 *
 */
export function createProxyGuardianContainment(
  deps: ProxyGuardianContainmentDeps,
): ProxyOptions<symbol>['containment'] {
  return {
    stageProviderRoot: (key, reserved) => {
      const semanticStage = deps.stageProviderRoot(key, reserved.prepared);
      let guardianMayHoldMembership = false;
      let guardianReleased = false;
      let recognisedReceipt: JointContainmentReceipt | null = null;
      const result = semanticStage.result.then(async (staged) => {
        if (staged.state === 'permanent-refusal' || staged.state === 'capacity') return staged;
        const root = staged.providerRoot;
        const params = guardianRegisterProviderRootParamsSchema.parse({
          proxy: deps.identity,
          operation: {
            jobId: key.jobId,
            operationId: key.operationId,
            proxyInstanceId: deps.identity.proxyInstanceId,
            buildSetId: deps.identity.buildSetId,
          },
          reservation: reserved.reservation,
          providerPid: root.pid,
          providerProcessStartedAtSeconds: root.processStartedAtSeconds,
        });
        guardianMayHoldMembership = true;
        const response = await deps.guardianChannel.call(
          'guardian.register-provider-root.v1',
          params,
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        );
        const parsed = registerProviderRootResultSchema.parse(response);
        recognisedReceipt = parsed.jointContainmentReceipt;
        return {
          state: 'staged' as const,
          providerRoot: parsed.providerRoot,
          receipt: parsed.jointContainmentReceipt,
        };
      });

      const handle: OperationStageHandle = Object.freeze({
        result,
        async confirmActivation(input: Parameters<OperationStageHandle['confirmActivation']>[0]) {
          const { jointContainmentReceipt, jointActivationReceipt } = input;
          if (recognisedReceipt === null || recognisedReceipt !== jointContainmentReceipt) {
            throw new Error(
              `Activation named a containment receipt this proxy never staged for ${key.jobId}/${key.operationId}.`,
            );
          }
          if (jointActivationReceipt.length === 0) {
            throw new Error('Activation presented an empty activation receipt.');
          }
        },
        async abortAndRelease() {
          const semanticRelease = semanticStage.abortAndRelease();
          try {
            await result;
          } catch {
            // Registration ambiguity still requires the idempotent guardian release below.
          }
          await semanticRelease;
          if (!guardianMayHoldMembership || guardianReleased) return;
          const params = guardianProxyOperationReleaseParamsSchema.parse({
            proxy: deps.identity,
            operation: {
              jobId: key.jobId,
              operationId: key.operationId,
              proxyInstanceId: deps.identity.proxyInstanceId,
              buildSetId: deps.identity.buildSetId,
            },
            reservation: reserved.reservation,
          });
          const response = await deps.guardianChannel.call(
            'guardian.operation-release.v2',
            params,
            PROXY_CONTROL_RPC_TIMEOUT_MS,
          );
          guardianProxyOperationReleaseResultSchema.parse(response);
          guardianReleased = true;
        },
      });
      return handle;
    },
  };
}

/**
 * Runs the proxy: consumes its capsule, pairs with the guardian over the channel `guardian.register-provider-
 * root.v1` requires, and starts listening. The semantic carrier itself — reconstructing the bound provider,
 * running its kernel, and pumping `ProviderEventBody`s into `proxy.emitProviderEvent` — is
 * `semantic-operation.ts`'s `SemanticOperationHost`; this role main owns the process topology, endpoint and
 * guardian-authentication surface, and the containment closures that talk to the guardian on the kernel's
 * behalf (`Proxy`'s own `containment.stageProviderRoot`/`confirmActivation`).
 */
export async function startProviderProxyRole(
  capsulePath: string,
  ports: ProviderRoleMainPorts,
): Promise<ProxyRoleHandle> {
  const capsule = consumeProviderBootstrapCapsule(capsulePath, 'proxy', buildCapsuleEnv(ports));
  const clock = createMonotonicClock(proxyRoleClockScope);
  const self = readSelfIdentity(ports);
  const timer = runtimeControlTimer(ports.runtime);

  const identity: ProxyIdentity = {
    proxyInstanceId: capsule.proxyInstanceId,
    pid: self.pid,
    processStartedAtSeconds: self.processStartedAtSeconds,
    processGroupId: self.pid,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    canonicalEndpoint: capsule.canonicalEndpoint,
  };

  // The guardian must already be listening by the time this process exists — it spawns the proxy only after
  // its own `listen()` resolves — so this is an ordinary connect, retried only for the residual scheduling
  // window between the OS reporting this process spawned and its socket file becoming dialable.
  const guardianChannel = await connectRoleControlWithRetry(capsule.guardianControlEndpoint, timer, {
    connectTimeoutMs: ROLE_CONNECT_TIMEOUT_MS,
    retryIntervalMs: ROLE_SPAWN_READY_RETRY_INTERVAL_MS,
    overallDeadlineMs: ROLE_SPAWN_READY_DEADLINE_MS,
    now: () => ports.runtime.time.now(),
    sleep: (ms) => ports.runtime.time.sleep(ms),
  });
  const pairingResult = await guardianChannel.call(
    'guardian.pair.v1',
    controlPairParamsSchema.parse({ pairingSecret: capsule.proxyGuardianAuthSecret }),
    PROXY_CONTROL_RPC_TIMEOUT_MS,
  );
  controlPairResultSchema.parse(pairingResult);

  const hostAuthority = createProxyAppServerHostAuthority(ports.runtime);
  const exitProcess = ports.exitProcess ?? ((code: number): void => process.exit(code));
  let closePromise: Promise<void> | null = null;
  let relinquishmentStarted = false;
  // Forward-referenced: `createSemanticOperationRuntime`'s host needs the `Proxy` this call is itself building
  // (to pump events and read ledger state), and `createProxy` needs that host before the `Proxy` it returns
  // can exist — the same shape `guardianRef`/`reaperRef` already use above for their own peer/self references.
  // eslint-disable-next-line prefer-const
  let proxyRef!: Proxy;
  const semantic = createSemanticOperationRuntime({
    runtime: ports.runtime,
    hostAuthority,
    getProxy: () => proxyRef,
    onRelinquish: (failure) => {
      if (relinquishmentStarted) return;
      relinquishmentStarted = true;
      queueMicrotask(() => {
        void closeRole().then(
          () => {
            backendLog.error('proxy: cancellation was unconfirmed; relinquishing provider set', failure);
            exitProcess(ROLE_ENFORCEMENT_FAILURE_EXIT_CODE);
          },
          (error: unknown) => {
            backendLog.error('proxy: set relinquishment after unconfirmed cancellation failed', error);
            exitProcess(ROLE_ENFORCEMENT_FAILURE_EXIT_CODE);
          },
        );
      });
    },
  });

  const proxy = createProxy({
    capsule,
    clock,
    identity,
    host: semantic.host,
    timer,
    mintChallenge: () => ports.runtime.ids.uuid(),
    mintReceipt: () => ports.runtime.ids.uuid(),
    // The one place a reservation is created. `.parse()` is what mints the brand, so this expression — the
    // proxy's own authority to reserve — is the only expression in the tree that can produce one from raw
    // randomness. Everywhere else a reservation can only have been received.
    mintReservation: () => reservationSchema.parse(ports.runtime.ids.uuid()),
    wallClockNow: ports.runtime.time.now,
    containment: createProxyGuardianContainment({
      identity,
      guardianChannel,
      stageProviderRoot: semantic.stage,
    }),
  });
  proxyRef = proxy;
  await proxy.listen();

  const closeRole = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    closePromise = (async () => {
      let semanticFailure: unknown;
      let closeFailures: unknown[];
      try {
        await semantic.shutdown('signal_abort');
      } catch (error: unknown) {
        semanticFailure = error;
      } finally {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => guardianChannel.close()),
          proxy.close(),
        ]);
        closeFailures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      }
      if (semanticFailure !== undefined) {
        if (closeFailures.length > 0) {
          backendLog.error(
            'proxy: pairing/control closure also failed after semantic shutdown failure',
            new AggregateError(closeFailures),
          );
        }
        if (semanticFailure instanceof Error) throw semanticFailure;
        throw new Error('Proxy semantic shutdown failed.', { cause: semanticFailure });
      }
      if (closeFailures.length > 0) {
        throw new AggregateError(closeFailures, 'Proxy role pairing/control closure failed.');
      }
    })();
    return closePromise;
  };

  return {
    role: 'proxy',
    proxy,
    // Give every provider its own chance at a graceful stop, then always relinquish pairing and proxy
    // control. The joined promise makes a second signal observe the same drain and the same failure.
    close: closeRole,
  };
}

export type ProviderRoleMainOptions = Readonly<{ pluginRoot: string }>;

/**
 * The `bootstrap.ts` dispatch target: composes the real runtime and runs whichever role `argv` named,
 * staying up for the lifetime of the process via its own open control socket — the same pattern the ordinary
 * coordinator's own `main()` uses. A `'none'` mode is a defensive no-op; `bootstrap.ts` never reaches this
 * function without a role already confirmed.
 */
export async function runProviderRoleMain(mode: ProviderRoleArgv, options: ProviderRoleMainOptions): Promise<number> {
  if (mode.role === 'none') return 0;

  // Every role logs to stderr (`backendLog`), and `role-spawn.ts` spawns roles through the short-lived-child
  // path — piped, not redirected to a file. If this role's parent (the coordinator spawning the guardian, or
  // the guardian spawning the reaper/proxy) exits first, the read end of that pipe closes, and this
  // process's next stderr write raises EPIPE. A `Writable` stream's `'error'` with no listener is an
  // uncaught exception, which would kill the very enforcer that exists to bound coordinator loss — so the
  // guard is installed before anything else in this role can log. `stdout` is guarded for the same reason,
  // though no role writes to it today.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});

  const runtime = createRealRuntime(resolveBuildFlavor(process.env));
  const ports: ProviderRoleMainPorts = { runtime, pluginRoot: options.pluginRoot };

  const handle: ProviderRoleHandle =
    mode.role === 'guardian'
      ? await startProviderGuardianRole(mode.capsulePath, ports)
      : mode.role === 'reaper'
        ? await startProviderReaperRole(mode.capsulePath, ports)
        : await startProviderProxyRole(mode.capsulePath, ports);

  const exitProcess = ports.exitProcess ?? ((code: number): void => process.exit(code));
  let proxyShutdownStarted = false;

  const shutdown = (): void => {
    // SIGTERM/SIGINT here means give up entirely — `buildGuardianSpawnUndo`'s acquisition-cleanup path is
    // the production sender — never a negotiated handoff (that goes through `*.stop-and-reap.v1` over
    // control, or a clean `initiateControlClose`). A guardian or reaper holds a proxy containment its own
    // enforcer was armed on; `close()` alone only disarms it, and the proxy is a separate detached
    // process-group leader outside this signal's own reach, so leaving it merely disarmed strands it
    // forever. `giveUp()` reaps it first, through the same close-and-exit path a cooperative RPC teardown
    // takes, and its own outcome handler is what exits this process afterwards.
    //
    // The proxy holds no containment of its own, so it has no enforcement outcome to exit on — `close()` now
    // drains every kernel it runs, but nothing else ever calls `exitProcess` for this role. Installing this
    // handler overrides SIGTERM's own default terminate, so without an explicit exit here this process would
    // sit alive with no way to end itself once `close()` resolves.
    if (handle.role === 'proxy') {
      if (proxyShutdownStarted) return;
      proxyShutdownStarted = true;
      void handle.close().then(
        () => exitProcess(0),
        (error: unknown) => {
          backendLog.error('proxy: close on shutdown failed', error);
          exitProcess(ROLE_ENFORCEMENT_FAILURE_EXIT_CODE);
        },
      );
      return;
    }
    void handle.giveUp();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return 0;
}
