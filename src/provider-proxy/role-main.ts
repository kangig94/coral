import { BUILD_FLAVOR_ENV_KEY, resolveBuildFlavor } from '../infra/build-flavor.js';
import { backendLog } from '../infra/backend-log.js';
import type { StrictBundleIdentityResult } from '../infra/bundle-manifest.js';
import { createMonotonicClock, type MonotonicClock } from '../infra/monotonic-clock.js';
import { probeProcessStartedAtSeconds } from '../infra/node-process.js';
import { providerProxyBootstrapCapsulePath, providerReaperBootstrapCapsulePath } from '../infra/path/index.js';
import { SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import type { ProcessContainmentEnvironment } from '../infra/process-containment.js';
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
import {
  createEnforcerDeadlineStateMachine,
  resolveProviderProxyDeadlineConfiguration,
  type EnforcerDeadlineStateMachine,
} from './orphan-deadline.js';
import type { ControlClient } from './control-client.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS, type ProxyIdentity } from './protocol.js';
import { createProxy, type Proxy, type SemanticOperationHost } from './proxy.js';
import { createReaper, type Reaper } from './reaper.js';
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
    time: ports.runtime.time,
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
}>;

export type ReaperRoleHandle = Readonly<{
  role: 'reaper';
  reaper: Reaper<symbol>;
  close(): Promise<void>;
}>;

export type ProxyRoleHandle = Readonly<{
  role: 'proxy';
  proxy: Proxy;
  close(): Promise<void>;
}>;

export type ProviderRoleHandle = GuardianRoleHandle | ReaperRoleHandle | ProxyRoleHandle;

/** How long `reapUnheldRoleProcess` polls for a signalled process to disappear before it gives up waiting
 *  and escalates. Matches `infra/process-containment.ts`'s own `ABSENCE_POLL_MS`. */
const REAP_POLL_MS = 25;

/**
 * Best-effort cleanup for a role process this attempt itself spawned but can no longer hold, because a later
 * cut in the same construction failed. Verifies the recorded pid is still the exact process that was spawned
 * before signalling it — a bare pid is recycled, so signalling on trust alone risks hitting an unrelated
 * later process — then SIGTERMs, escalating to SIGKILL if it has not disappeared after the standard grace
 * period. `signalGroup` reaches a detached proxy by its whole process group (`-pid`), since the group leader
 * alone is not the containment; an ordinary child (the reaper) is signalled by its own pid.
 */
async function reapUnheldRoleProcess(
  identity: Readonly<{ pid: number; processStartedAtSeconds: number }>,
  signalGroup: boolean,
  ports: ProviderRoleMainPorts,
): Promise<void> {
  const platform = ports.runtime.env.platform() as NodeJS.Platform;
  const read = ports.readProcessStartedAtSeconds ?? probeProcessStartedAtSeconds;
  let observedStartedAt: number | null;
  try {
    observedStartedAt = read(identity.pid, platform);
  } catch {
    observedStartedAt = null;
  }
  if (observedStartedAt !== identity.processStartedAtSeconds) {
    // A readable-but-different start time means a different process now holds this pid; an unreadable one
    // means it is already gone, or was never reachable. Either way there is nothing this identity still
    // names — signalling the bare pid would risk hitting whatever now holds it.
    return;
  }

  const target = signalGroup ? -identity.pid : identity.pid;
  ports.runtime.process.kill(target, 'SIGTERM');
  const graceDeadline = ports.runtime.time.now() + SIGTERM_GRACE_MS;
  while (ports.runtime.process.isAlive(target) && ports.runtime.time.now() < graceDeadline) {
    await ports.runtime.time.sleep(REAP_POLL_MS);
  }
  if (ports.runtime.process.isAlive(target)) {
    ports.runtime.process.kill(target, 'SIGKILL');
  }
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

  // Phase 2: identity-check and reap every process this attempt started, newest first.
  if (partial.proxySpawn !== null) {
    const proxySpawn = partial.proxySpawn;
    await attempt('reap the proxy process group', () => reapUnheldRoleProcess(proxySpawn, true, ports));
  }
  if (partial.reaperSpawn !== null) {
    const reaperSpawn = partial.reaperSpawn;
    await attempt('reap the reaper process', () => reapUnheldRoleProcess(reaperSpawn, false, ports));
  }

  // Phase 3: capsules and endpoints are removed by the coordinator's own acquisition steps once it observes
  // this rejection; this attempt owns no capsule path of its own to remove.
  if (stranded.length > 0) {
    backendLog.error(`guardian construction failed and could not clean up: ${stranded.join(', ')}`);
  }
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
  const clock = createMonotonicClock(Symbol('coral.provider-proxy.guardian'));
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

    // Raced, not merely awaited, so an async spawn error the OS reports after the sync `spawn()` call
    // already returned surfaces here as this attempt's own rejection rather than waiting out the full
    // connect deadline — or worse, as an uncaught exception with no listener at all (BLOCKING 4). The
    // connect attempt's own promise is given a no-op catch: `Promise.race` never observes a losing
    // promise's eventual settlement, so if the spawn failure wins the race first, the connect attempt's own
    // later rejection must not become an unhandled one.
    const reaperConnected = connectRoleControlWithRetry(capsule.reaperControlEndpoint, timer, {
      connectTimeoutMs: ROLE_CONNECT_TIMEOUT_MS,
      retryIntervalMs: ROLE_SPAWN_READY_RETRY_INTERVAL_MS,
      overallDeadlineMs: ROLE_SPAWN_READY_DEADLINE_MS,
      now: () => ports.runtime.time.now(),
      sleep: (ms) => ports.runtime.time.sleep(ms),
    });
    reaperConnected.catch(() => {});
    reaperChannel = await Promise.race([reaperConnected, reaperSpawn.spawnFailed]);
    await reaperChannel.call(
      'reaper.pair.v1',
      { pairingSecret: capsule.guardianReaperAuthSecret },
      PROXY_CONTROL_RPC_TIMEOUT_MS,
    );

    const pairedReaperChannel = reaperChannel;
    // Forward-referenced by `close` below (assigned into `createGuardian`'s own `onOutcome` before the
    // guardian it closes exists), then assigned exactly once — `let` is load-bearing here, not a style choice.
    // eslint-disable-next-line prefer-const
    let guardianRef!: Guardian<symbol>;
    close = async (): Promise<void> => {
      pairedReaperChannel.close();
      await guardianRef.close();
    };
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

    // Same race-and-guard shape as the reaper connect above: an async proxy spawn failure must surface as
    // this attempt's own rejection, and `recordContainment`'s own eventual settlement must not become an
    // unhandled rejection if the spawn failure wins the race first.
    const containmentRecorded = guardian.recordContainment({
      pid: proxySpawn.pid,
      processStartedAtSeconds: proxySpawn.processStartedAtSeconds,
      processGroupId: proxySpawn.pid,
      containmentKind: DETACHED_CONTAINMENT_KIND,
    });
    containmentRecorded.catch(() => {});
    await Promise.race([containmentRecorded, proxySpawn.spawnFailed]);

    return { role: 'guardian', guardian, reaperSpawn, proxySpawn, close };
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
  const clock = createMonotonicClock(Symbol('coral.provider-proxy.reaper'));
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
    self: readSelfIdentity(ports),
    onOutcome,
    onProgressViolation,
  });
  await reaperRef.listen();

  return { role: 'reaper', reaper: reaperRef, close };
}

/**
 * Runs the proxy: consumes its capsule and starts listening. The semantic carrier — the Claude/Codex
 * app-server child, bound session, and operation ledger execution — is wired by the operation ledger work
 * (plan item W2.3); this role main provides the process topology, endpoint, and authentication surface only.
 */
export async function startProviderProxyRole(
  capsulePath: string,
  ports: ProviderRoleMainPorts,
): Promise<ProxyRoleHandle> {
  const capsule = consumeProviderBootstrapCapsule(capsulePath, 'proxy', buildCapsuleEnv(ports));
  const clock = createMonotonicClock(Symbol('coral.provider-proxy.proxy'));
  const self = readSelfIdentity(ports);

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

  const semanticCarrierNotWired = (what: string) => (): never => {
    throw new Error(`${what} is wired by the operation ledger work (plan item W2.3), not this role main.`);
  };
  const host: SemanticOperationHost = {
    start: semanticCarrierNotWired('Starting the semantic kernel'),
    stop: semanticCarrierNotWired('Stopping the semantic kernel'),
  };

  const proxy = createProxy({
    capsule,
    clock,
    identity,
    host,
    timer: runtimeControlTimer(ports.runtime),
    mintChallenge: () => ports.runtime.ids.uuid(),
    mintReceipt: () => ports.runtime.ids.uuid(),
    mintReservationId: () => ports.runtime.ids.uuid(),
    mintActivationNonce: () => ports.runtime.ids.uuid(),
    containment: {
      stageProviderRoot: semanticCarrierNotWired('Provider-root staging'),
      confirmActivation: semanticCarrierNotWired('Activation confirmation'),
    },
  });
  await proxy.listen();

  return { role: 'proxy', proxy, close: () => proxy.close() };
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

  const shutdown = (): void => {
    void handle.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return 0;
}
