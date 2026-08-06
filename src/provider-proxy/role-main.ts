import { BUILD_FLAVOR_ENV_KEY, resolveBuildFlavor } from '../infra/build-flavor.js';
import type { StrictBundleIdentityResult } from '../infra/bundle-manifest.js';
import { createMonotonicClock, type MonotonicClock } from '../infra/monotonic-clock.js';
import { probeProcessStartedAtSeconds } from '../infra/node-process.js';
import { providerProxyBootstrapCapsulePath, providerReaperBootstrapCapsulePath } from '../infra/path/index.js';
import type { ProcessContainmentEnvironment } from '../infra/process-containment.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime } from '../runtime/ports.js';
import {
  consumeProviderBootstrapCapsule,
  type GuardianBootstrapCapsule,
  type ProviderBootstrapCapsuleEnvironment,
} from './bootstrap-capsule.js';
import { MAX_PROXY_RECORDED_PROVIDER_ROOTS, type EnforcementScheduler } from './enforcement.js';
import { DETACHED_CONTAINMENT_KIND, createGuardian, type Guardian } from './guardian.js';
import {
  createEnforcerDeadlineStateMachine,
  resolveProviderProxyDeadlineConfiguration,
  type EnforcerDeadlineStateMachine,
} from './orphan-deadline.js';
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
    // Neither enforcer has an independent oracle for coordinator liveness beyond the round-trip evidence this
    // machine already tracks — the only production call site of this policy (`proxy.ts`) answers the same way.
    coordinatorIsLive: () => true,
    mintChallenge: () => ports.runtime.ids.uuid(),
  });
}

function buildSpawnPorts(ports: ProviderRoleMainPorts): RoleSpawnPorts {
  return {
    process: ports.runtime.process,
    platform: ports.runtime.env.platform() as NodeJS.Platform,
    ...(ports.readProcessStartedAtSeconds === undefined
      ? {}
      : { readProcessStartedAtSeconds: ports.readProcessStartedAtSeconds }),
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

/**
 * Runs the guardian: consumes its capsule, spawns the reaper outside the future proxy group, pairs with it,
 * starts listening, spawns the proxy as a new process-group leader, and records the containment it watched
 * being created. Each step is awaited in this exact order because the next one depends on it: the reaper
 * must exist before it can be paired with, the guardian must be listening before the proxy can connect to
 * it, and the proxy's pid and start time must be known before there is anything to record.
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

  const reaperSpawn = spawnRoleProcess('reaper', reaperCapsulePathFrom(capsule, ports.baseDir), spawnPorts, {
    pluginRoot: ports.pluginRoot,
    detached: false,
    envAdditions: flavorEnv,
  });

  const reaperChannel = await connectRoleControlWithRetry(capsule.reaperControlEndpoint, timer, {
    connectTimeoutMs: ROLE_CONNECT_TIMEOUT_MS,
    retryIntervalMs: ROLE_SPAWN_READY_RETRY_INTERVAL_MS,
    overallDeadlineMs: ROLE_SPAWN_READY_DEADLINE_MS,
    now: () => ports.runtime.time.now(),
    sleep: (ms) => ports.runtime.time.sleep(ms),
  });
  await reaperChannel.call(
    'reaper.pair.v1',
    { pairingSecret: capsule.guardianReaperAuthSecret },
    PROXY_CONTROL_RPC_TIMEOUT_MS,
  );

  const guardian = createGuardian({
    capsule,
    clock,
    deadlines,
    containmentEnvironment,
    scheduler: buildScheduler(ports.runtime),
    timer,
    mintReceipt: () => ports.runtime.ids.uuid(),
    reaperChannel,
    self: readSelfIdentity(ports),
    onOutcome: () => {},
    onProgressViolation: () => {},
  });

  await guardian.listen();

  const proxySpawn = spawnRoleProcess('proxy', proxyCapsulePathFrom(capsule, ports.baseDir), spawnPorts, {
    pluginRoot: ports.pluginRoot,
    detached: true,
    envAdditions: flavorEnv,
  });

  await guardian.recordContainment({
    pid: proxySpawn.pid,
    processStartedAtSeconds: proxySpawn.processStartedAtSeconds,
    processGroupId: proxySpawn.pid,
    containmentKind: DETACHED_CONTAINMENT_KIND,
  });

  return {
    role: 'guardian',
    guardian,
    reaperSpawn,
    proxySpawn,
    close: async () => {
      reaperChannel.close();
      await guardian.close();
    },
  };
}

/** Runs the reaper: consumes its capsule and starts listening. It holds nothing to enforce until the
 *  guardian reports the containment it watched being created over `reaper.record-containment.v1`. */
export async function startProviderReaperRole(
  capsulePath: string,
  ports: ProviderRoleMainPorts,
): Promise<ReaperRoleHandle> {
  const capsule = consumeProviderBootstrapCapsule(capsulePath, 'reaper', buildCapsuleEnv(ports));
  const clock = createMonotonicClock(Symbol('coral.provider-proxy.reaper'));

  const reaper = createReaper({
    capsule,
    clock,
    deadlines: buildDeadlines(clock, ports),
    containmentEnvironment: buildContainmentEnvironment(clock, ports),
    scheduler: buildScheduler(ports.runtime),
    timer: runtimeControlTimer(ports.runtime),
    self: readSelfIdentity(ports),
    onOutcome: () => {},
    onProgressViolation: () => {},
  });
  await reaper.listen();

  return { role: 'reaper', reaper, close: () => reaper.close() };
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
