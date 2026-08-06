import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { StrictBundleIdentityResult } from '#src/infra/bundle-manifest.js';
import {
  providerGuardianBootstrapCapsulePath,
  providerGuardianEndpoint,
  providerProxyBootstrapCapsulePath,
  providerProxyEndpoint,
  providerReaperBootstrapCapsulePath,
  providerReaperEndpoint,
} from '#src/infra/path/index.js';
import { probeProcessStartedAtSeconds } from '#src/infra/node-process.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import { createProviderProxyAcquisitionSteps } from '#src/coordinator/live/provider-proxy-acquisition-steps.js';
import { acquireProviderProxySet } from '#src/coordinator/live/provider-proxy-acquisition.js';
import {
  createProviderBootstrapCapsule,
  type GuardianBootstrapCapsule,
  type ProxyBootstrapCapsule,
  type ReaperBootstrapCapsule,
} from '#src/provider-proxy/bootstrap-capsule.js';
import type { CoordinatorIdentity } from '#src/provider-proxy/protocol.js';
import { PROVIDER_ROLE_FLAGS, type ProviderRole } from '#src/provider-proxy/role-argv.js';
import {
  startProviderGuardianRole,
  startProviderProxyRole,
  startProviderReaperRole,
  type GuardianRoleHandle,
  type ProviderRoleMainPorts,
  type ProxyRoleHandle,
  type ReaperRoleHandle,
} from '#src/provider-proxy/role-main.js';
import type { Runtime, RuntimeSpawnOptions } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';

/**
 * Drives the real spawn topology in-process rather than against the built backend artifact.
 *
 * `clients/bridge/*.cjs` bundles have build-time constants (`__PLUGIN_ROOT__`, `__BUILD_SET_ID__`, …)
 * injected by esbuild and only work from an installed plugin path — CLAUDE.md forbids executing them
 * directly, and this feature branch may not rebuild `clients/bridge/` at all. So instead of spawning
 * `node coral-backend.cjs --provider-guardian <capsule>` as a real OS process, the fake `runtime.process.spawn`
 * below recognises the same argv `role-spawn.ts` builds and, in its place, calls this same module's
 * `startProviderGuardianRole` / `startProviderReaperRole` / `startProviderProxyRole` in-process — real
 * control endpoints on real Unix sockets, real capsule files on disk, real challenge/heartbeat traffic, with
 * only the "became a new OS process" fact faked. That is the one seam production code cannot avoid testing
 * without an actual process; everything on either side of it is the genuine implementation under test.
 */

const GENERATION = 'gen2' as const;
const FLAVOR = 'prod' as const;
const BASE_STARTED_AT_SECONDS = 1_700_000_000;

function strictIdentity(buildSetId: string): StrictBundleIdentityResult {
  return {
    ok: true,
    manifest: {
      version: '1.0.0',
      buildSetId,
      flavor: FLAVOR,
      storeFormatFingerprint: `sha256:${'e'.repeat(64)}`,
      bundleHash: '1'.repeat(16),
      cliBundleHash: '2'.repeat(16),
      claudeAppserverBundleHash: '3'.repeat(16),
    },
  };
}

type SharedSetIdentity = Readonly<{ buildSetId: string; hostFingerprint: string }>;

function mintSharedSetIdentity(): SharedSetIdentity {
  return { buildSetId: randomUUID(), hostFingerprint: randomBytes(32).toString('hex') };
}

type SpawnRecord = Readonly<{ role: ProviderRole; capsulePath: string; detached: boolean; pid: number }>;

type FakeRoleEnvironmentOptions = Readonly<{
  base: Runtime;
  pluginRoot: string;
  baseDir: string;
  resolveStrictIdentity(): StrictBundleIdentityResult;
  /** Overrides the start time a spawned pid reads back as. `null` simulates a spawn whose start time cannot
   *  be read at all. Defaults to a value derived from the pid, distinct per spawn. */
  startedAtSecondsFor?(role: ProviderRole, pid: number): number | null;
  /** Overrides the pid a role reports about itself (`ports.runtime.env.pid()`, read by `readSelfIdentity`).
   *  Defaults to the pid the fake spawn assigned it. Exists to engineer a deliberate self-report disagreement. */
  selfPidFor?(role: ProviderRole, spawnedPid: number): number;
  /** Called synchronously the instant the fake spawn call for the *proxy* is made — after the reaper is
   *  fully up, before `recordContainment`'s forward to it. Exists so a test can sever the guardian's own
   *  pairing channel to the reaper right at that point, engineering a forward failure at the one cut nothing
   *  else here can reach: everything up to it has already succeeded. */
  onProxySpawning?(): void;
}>;

type FakeRoleEnvironment = Readonly<{
  spawnLog: SpawnRecord[];
  killLog: Array<{ pid: number; signal: string }>;
  nestedErrors: unknown[];
  handles: { guardian?: GuardianRoleHandle; reaper?: ReaperRoleHandle; proxy?: ProxyRoleHandle };
  /** One entry per `listen()`-vs-spawn event this environment can observe, appended in the order it actually
   *  happened — so an ordering claim can be checked against the recorded sequence rather than against an
   *  assertion that would hold regardless of which order ran. */
  sequenceLog: string[];
  /** Every code a role passed to `exitProcess` — real teardowns driven through this fake environment (e.g.
   *  `stopAndReap`) reach `containment-absent` for real, and letting the default `process.exit` fire would
   *  tear down the test worker itself; the fake below stands in for it and this records what would have run. */
  exitLog: number[];
  /** Shared with every nested role's own ports, and exposed so a non-role caller (the coordinator's own
   *  acquisition steps) can inject the identical fake pid identity resolution. */
  readProcessStartedAtSeconds(pid: number, platform: NodeJS.Platform): number | null;
  /** Ports for the role under direct test — its own spawn calls route through the shared fake below. */
  topLevelPorts(): ProviderRoleMainPorts;
  /** Runtime for a caller that is not itself a role (e.g. the coordinator's own acquisition steps). */
  outerRuntime(): Runtime;
}>;

/**
 * Builds one shared fake-spawn environment. Every nested role it starts — however deep — routes its own
 * spawn calls back through the same fake, so a guardian spawned this way can itself spawn a reaper and a
 * proxy exactly as it would from a real OS process.
 */
function createFakeRoleEnvironment(options: FakeRoleEnvironmentOptions): FakeRoleEnvironment {
  let nextPid = 900_001;
  const spawnLog: SpawnRecord[] = [];
  const killLog: Array<{ pid: number; signal: string }> = [];
  const nestedErrors: unknown[] = [];
  const handles: FakeRoleEnvironment['handles'] = {};
  const sequenceLog: string[] = [];
  const exitLog: number[] = [];
  const pidHandles = new Map<number, { close(): Promise<void> }>();
  const startedAtByPid = new Map<number, number | null>();

  const readProcessStartedAtSeconds = (pid: number, platform: NodeJS.Platform): number | null => {
    if (startedAtByPid.has(pid)) return startedAtByPid.get(pid) ?? null;
    return probeProcessStartedAtSeconds(pid, platform);
  };

  function runtimeWithFakeProcess(pidOverride: number | undefined): Runtime {
    return {
      ...options.base,
      ...(pidOverride === undefined ? {} : { env: { ...options.base.env, pid: () => pidOverride } }),
      process: { ...options.base.process, spawn: fakeSpawn, kill: fakeKill },
    };
  }

  function portsFor(pidOverride: number | undefined): ProviderRoleMainPorts {
    return {
      runtime: runtimeWithFakeProcess(pidOverride),
      pluginRoot: options.pluginRoot,
      baseDir: options.baseDir,
      resolveStrictIdentity: options.resolveStrictIdentity,
      readProcessStartedAtSeconds,
      onGuardianListening: () => sequenceLog.push('guardian-listening'),
      exitProcess: (code) => exitLog.push(code),
    };
  }

  function fakeSpawn(spawnOptions: RuntimeSpawnOptions): ChildProcessLike {
    const flag = spawnOptions.args[1];
    const capsulePath = spawnOptions.args[2];
    const role = flag === undefined ? undefined : PROVIDER_ROLE_FLAGS[flag];
    if (role === undefined || capsulePath === undefined) {
      throw new Error(`fake spawn saw unrecognised role argv: ${JSON.stringify(spawnOptions.args)}`);
    }
    sequenceLog.push(`${role}-spawn`);
    if (role === 'proxy') options.onProxySpawning?.();
    const pid = nextPid;
    nextPid += 1;
    const selfPid = options.selfPidFor?.(role, pid) ?? pid;
    const startedAtSeconds = (options.startedAtSecondsFor ?? ((_role, p) => BASE_STARTED_AT_SECONDS + p))(role, pid);
    startedAtByPid.set(pid, startedAtSeconds);
    if (selfPid !== pid) startedAtByPid.set(selfPid, startedAtSeconds);
    spawnLog.push({ role, capsulePath, detached: spawnOptions.detached === true, pid });

    const child: ChildProcessLike = {
      pid,
      stdin: null,
      stdout: null,
      stderr: null,
      on: () => child,
      kill: () => true,
    };

    // Fire-and-forget, exactly as a real `child_process.spawn` returns before the child has done anything —
    // the caller learns readiness only by reaching the endpoint, never from the spawn call itself.
    void (async (): Promise<void> => {
      try {
        const rolePorts = portsFor(selfPid);
        if (role === 'guardian') {
          const handle = await startProviderGuardianRole(capsulePath, rolePorts);
          handles.guardian = handle;
          pidHandles.set(pid, handle);
        } else if (role === 'reaper') {
          const handle = await startProviderReaperRole(capsulePath, rolePorts);
          handles.reaper = handle;
          pidHandles.set(pid, handle);
        } else {
          const handle = await startProviderProxyRole(capsulePath, rolePorts);
          handles.proxy = handle;
          pidHandles.set(pid, handle);
        }
      } catch (error: unknown) {
        nestedErrors.push(error);
      }
    })();

    return child;
  }

  function fakeKill(pid: number, signal: NodeJS.Signals | 0): boolean {
    killLog.push({ pid, signal: String(signal) });
    const handle = pidHandles.get(pid);
    if (handle !== undefined) {
      pidHandles.delete(pid);
      void handle.close();
    }
    return true;
  }

  return {
    spawnLog,
    killLog,
    nestedErrors,
    handles,
    sequenceLog,
    exitLog,
    readProcessStartedAtSeconds,
    topLevelPorts: () => portsFor(undefined),
    outerRuntime: () => runtimeWithFakeProcess(undefined),
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scopedTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Writes one guardian bootstrap capsule directly (bypassing the coordinator's own acquisition steps, which
 * hide their minted paths behind an opaque `AcquisitionUndo`) so a test driving `startProviderGuardianRole`
 * on its own has a real file to consume and knows every identity it minted.
 */
/**
 * Writes all three bootstrap capsules directly (bypassing the coordinator's own acquisition steps, which
 * hide their minted paths behind an opaque `AcquisitionUndo`) so a test driving `startProviderGuardianRole`
 * on its own has real files to consume — guardian's, plus the reaper's and proxy's it will independently
 * derive the paths of and expect already present, exactly as the real acquisition flow leaves them.
 */
function writeCapsuleSet(
  runtime: Runtime,
  baseDir: string,
  shared: SharedSetIdentity,
  overrides: Readonly<{
    /** The reaper's own copy of the pairing secret, defaulting to the guardian's. Set to a different value
     *  to engineer a pairing refusal — the reaper spawns and comes up listening, but the guardian's
     *  `reaper.pair.v1` call against it is refused, failing the cut right after the reaper spawn. */
    reaperGuardianReaperAuthSecret?: string;
  }> = {},
): Readonly<{ guardianCapsulePath: string; guardianEndpoint: string }> {
  const guardianInstanceId = randomUUID();
  const reaperInstanceId = randomUUID();
  const proxyInstanceId = randomUUID();
  const setIdentity = { generation: GENERATION, flavor: FLAVOR, ...shared };
  const uid = process.getuid?.() ?? 0;
  const capsuleEnv = { storage: runtime.storage, uid };

  const endpointEnv = {
    baseDir,
    platform: runtime.env.platform(),
    tempDirectory: runtime.env.tmpdir(),
    uid,
    storage: runtime.storage,
  };
  const guardianEndpoint = providerGuardianEndpoint({ ...setIdentity, guardianInstanceId }, endpointEnv);
  const reaperEndpoint = providerReaperEndpoint({ ...setIdentity, reaperInstanceId }, endpointEnv);
  const proxyEndpoint = providerProxyEndpoint({ ...setIdentity, proxyInstanceId }, endpointEnv);
  const guardianReaperAuthSecret = randomBytes(32).toString('hex');
  const proxyGuardianAuthSecret = randomBytes(32).toString('hex');

  const guardianCapsulePath = providerGuardianBootstrapCapsulePath({ ...setIdentity, guardianInstanceId }, { baseDir });
  const guardianCapsule: GuardianBootstrapCapsule = {
    role: 'guardian',
    generation: GENERATION,
    flavor: FLAVOR,
    buildSetId: shared.buildSetId,
    hostFingerprint: shared.hostFingerprint,
    guardianInstanceId,
    reaperInstanceId,
    proxyInstanceId,
    bootstrapNonce: randomBytes(32).toString('hex'),
    canonicalControlEndpoint: guardianEndpoint,
    reaperControlEndpoint: reaperEndpoint,
    proxyEndpoint,
    guardianReaperAuthSecret,
    proxyGuardianAuthSecret,
  };
  createProviderBootstrapCapsule(guardianCapsulePath, guardianCapsule, capsuleEnv);

  const reaperCapsulePath = providerReaperBootstrapCapsulePath({ ...setIdentity, reaperInstanceId }, { baseDir });
  const reaperCapsule: ReaperBootstrapCapsule = {
    role: 'reaper',
    generation: GENERATION,
    flavor: FLAVOR,
    buildSetId: shared.buildSetId,
    hostFingerprint: shared.hostFingerprint,
    guardianInstanceId,
    reaperInstanceId,
    proxyInstanceId,
    bootstrapNonce: randomBytes(32).toString('hex'),
    canonicalControlEndpoint: reaperEndpoint,
    guardianControlEndpoint: guardianEndpoint,
    proxyEndpoint,
    guardianReaperAuthSecret: overrides.reaperGuardianReaperAuthSecret ?? guardianReaperAuthSecret,
  };
  createProviderBootstrapCapsule(reaperCapsulePath, reaperCapsule, capsuleEnv);

  const proxyCapsulePath = providerProxyBootstrapCapsulePath({ ...setIdentity, proxyInstanceId }, { baseDir });
  const proxyCapsule: ProxyBootstrapCapsule = {
    role: 'proxy',
    generation: GENERATION,
    flavor: FLAVOR,
    buildSetId: shared.buildSetId,
    hostFingerprint: shared.hostFingerprint,
    guardianInstanceId,
    reaperInstanceId,
    proxyInstanceId,
    bootstrapNonce: randomBytes(32).toString('hex'),
    canonicalEndpoint: proxyEndpoint,
    guardianControlEndpoint: guardianEndpoint,
    proxyGuardianAuthSecret,
  };
  createProviderBootstrapCapsule(proxyCapsulePath, proxyCapsule, capsuleEnv);

  return { guardianCapsulePath, guardianEndpoint };
}

async function closeHandles(environment: FakeRoleEnvironment): Promise<void> {
  await environment.handles.proxy?.close();
  await environment.handles.reaper?.close();
  await environment.handles.guardian?.close();
}

describe('provider-proxy process topology: guardian role main', () => {
  it('spawns the reaper before pairing, listens before the proxy spawns, spawns the proxy detached, and records containment only once its pid and start time are known', async () => {
    const baseDir = scopedTempDir('coral-topology-order-');
    const shared = mintSharedSetIdentity();
    const environment = createFakeRoleEnvironment({
      base: createRealRuntime(FLAVOR),
      pluginRoot: baseDir,
      baseDir,
      resolveStrictIdentity: () => strictIdentity(shared.buildSetId),
    });
    cleanups.push(() => closeHandles(environment));
    const { guardianCapsulePath } = writeCapsuleSet(environment.outerRuntime(), baseDir, shared);

    const handle = await startProviderGuardianRole(guardianCapsulePath, environment.topLevelPorts());
    environment.handles.guardian = handle;

    // Exactly two nested spawns, reaper first, then proxy.
    expect(environment.spawnLog.map((entry) => entry.role)).toEqual(['reaper', 'proxy']);
    // The reaper is an ordinary child; the proxy is a new process-group leader.
    expect(environment.spawnLog[0]?.detached).toBe(false);
    expect(environment.spawnLog[1]?.detached).toBe(true);

    // Reaching this at all proves the pairing connect succeeded only once the reaper was actually listening
    // — nothing answers at its endpoint until `startProviderReaperRole` itself binds it, and an un-retried
    // connect attempt racing a freshly spawned process would otherwise have thrown.
    expect(environment.handles.reaper).toBeDefined();
    expect(environment.handles.proxy).toBeDefined();

    // The guardian's own control endpoint was already listening before the proxy spawn call was made: a
    // sequence number recorded at each event (`onGuardianListening`, and at the fake spawn call itself) is
    // what actually discriminates this from the reverse order — unlike `proxySpawn.pid` matching the second
    // spawn log entry, which would hold either way.
    expect(handle.proxySpawn.pid).toBe(environment.spawnLog[1]?.pid);
    expect(environment.sequenceLog).toEqual(['reaper-spawn', 'guardian-listening', 'proxy-spawn']);

    // Containment was recorded: both enforcers are armed, and neither could be without
    // `guardian.recordContainment` having run with the proxy's own spawn-derived pid and start time —
    // nothing else could have supplied them, since they exist only as `spawnRoleProcess`'s return value.
    expect(handle.guardian.enforcer()).not.toBeNull();
    expect(environment.handles.reaper?.reaper.enforcer()).not.toBeNull();
  });

  it('fails the spawn — and never records containment — when the proxy start time cannot be read', async () => {
    const baseDir = scopedTempDir('coral-topology-badstart-');
    const shared = mintSharedSetIdentity();
    const environment = createFakeRoleEnvironment({
      base: createRealRuntime(FLAVOR),
      pluginRoot: baseDir,
      baseDir,
      resolveStrictIdentity: () => strictIdentity(shared.buildSetId),
      // A pid alone is not an identity — it is recycled — so a spawn whose start time cannot be read must
      // fail rather than record a bare pid. Only the proxy's start time is made unreadable.
      startedAtSecondsFor: (role, pid) => (role === 'proxy' ? null : BASE_STARTED_AT_SECONDS + pid),
    });
    cleanups.push(() => closeHandles(environment));
    const { guardianCapsulePath } = writeCapsuleSet(environment.outerRuntime(), baseDir, shared);

    await expect(startProviderGuardianRole(guardianCapsulePath, environment.topLevelPorts())).rejects.toThrow(
      /start time/u,
    );

    // The reaper came up fine — it is spawned and paired before the proxy — but must have been told
    // nothing: `recordContainment` is reached only after the proxy's pid and start time are known, and here
    // they never were, so its enforcer stays unarmed.
    expect(environment.handles.reaper).toBeDefined();
    expect(environment.handles.reaper?.reaper.enforcer()).toBeNull();
    // No proxy handle: the same unreadable start time that failed the guardian's own spawn call also fails
    // the proxy's own self-identity read, so the phantom process this fake started never gets to `listen()`.
    expect(environment.handles.proxy).toBeUndefined();

    // BLOCKING 2: an unarmed reaper is not a held one — the guardian created it, and a guardian that failed
    // partway through must reap what it created rather than leave a live, unaccounted-for child behind. The
    // old code left exactly this reaper running forever with nothing pointed at it.
    const reaperPid = environment.spawnLog.find((entry) => entry.role === 'reaper')?.pid;
    expect(reaperPid).toBeDefined();
    expect(environment.killLog).toContainEqual({ pid: reaperPid, signal: 'SIGTERM' });
  });

  it('leaves no live child when pairing fails right after the reaper spawn', async () => {
    const baseDir = scopedTempDir('coral-topology-pairing-fails-');
    const shared = mintSharedSetIdentity();
    const environment = createFakeRoleEnvironment({
      base: createRealRuntime(FLAVOR),
      pluginRoot: baseDir,
      baseDir,
      resolveStrictIdentity: () => strictIdentity(shared.buildSetId),
    });
    cleanups.push(() => closeHandles(environment));
    // The reaper's own copy of the pairing secret disagrees with the guardian's, so the reaper spawns and
    // comes up listening fine, but `reaper.pair.v1` is refused — the cut right after the reaper spawn, with
    // nothing else yet created.
    const { guardianCapsulePath } = writeCapsuleSet(environment.outerRuntime(), baseDir, shared, {
      reaperGuardianReaperAuthSecret: randomBytes(32).toString('hex'),
    });

    await expect(startProviderGuardianRole(guardianCapsulePath, environment.topLevelPorts())).rejects.toThrow();

    expect(environment.spawnLog.map((entry) => entry.role)).toEqual(['reaper']);
    const reaperPid = environment.spawnLog[0]?.pid;
    expect(environment.killLog).toContainEqual({ pid: reaperPid, signal: 'SIGTERM' });
  });

  it('leaves no live child when the guardian endpoint itself fails to bind', async () => {
    const baseDir = scopedTempDir('coral-topology-listen-fails-');
    const shared = mintSharedSetIdentity();
    const environment = createFakeRoleEnvironment({
      base: createRealRuntime(FLAVOR),
      pluginRoot: baseDir,
      baseDir,
      resolveStrictIdentity: () => strictIdentity(shared.buildSetId),
    });
    cleanups.push(() => closeHandles(environment));
    const { guardianCapsulePath, guardianEndpoint } = writeCapsuleSet(environment.outerRuntime(), baseDir, shared);

    // Occupies the guardian's own instance-keyed socket path before it ever tries to bind it, so
    // `guardian.listen()` itself fails (`EADDRINUSE`) — the cut right after `listen`, with the reaper already
    // spawned and paired but nothing past it.
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(guardianEndpoint, resolve);
    });
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

    await expect(startProviderGuardianRole(guardianCapsulePath, environment.topLevelPorts())).rejects.toThrow();

    expect(environment.spawnLog.map((entry) => entry.role)).toEqual(['reaper']);
    const reaperPid = environment.spawnLog[0]?.pid;
    expect(environment.killLog).toContainEqual({ pid: reaperPid, signal: 'SIGTERM' });
  });

  it('leaves no live child when the forward to the reaper fails at recordContainment', async () => {
    const baseDir = scopedTempDir('coral-topology-forward-fails-');
    const shared = mintSharedSetIdentity();
    const environment = createFakeRoleEnvironment({
      base: createRealRuntime(FLAVOR),
      pluginRoot: baseDir,
      baseDir,
      resolveStrictIdentity: () => strictIdentity(shared.buildSetId),
      // Severs the guardian's own pairing channel to the reaper the instant the proxy spawn call is made —
      // after the reaper is fully up and paired, before `recordContainment`'s forward reaches it. This is the
      // one cut nothing else here can reach: everything up to it has already succeeded.
      onProxySpawning: () => {
        void environment.handles.reaper?.close();
      },
    });
    cleanups.push(() => closeHandles(environment));
    const { guardianCapsulePath } = writeCapsuleSet(environment.outerRuntime(), baseDir, shared);

    await expect(startProviderGuardianRole(guardianCapsulePath, environment.topLevelPorts())).rejects.toThrow();

    // Both the reaper (an ordinary child, signalled by its own pid) and the proxy (a detached leader,
    // signalled by its whole group — the negative pid) were reaped, not merely the one that failed.
    expect(environment.spawnLog.map((entry) => entry.role)).toEqual(['reaper', 'proxy']);
    const reaperPid = environment.spawnLog[0]?.pid;
    const proxyPid = environment.spawnLog[1]?.pid;
    expect(environment.killLog).toContainEqual({ pid: reaperPid, signal: 'SIGTERM' });
    expect(environment.killLog).toContainEqual({ pid: -proxyPid, signal: 'SIGTERM' });
  });
});

describe('provider-proxy process topology: acquisition', () => {
  function acquisitionOptions(
    environment: FakeRoleEnvironment,
    baseDir: string,
    shared: SharedSetIdentity,
  ): Parameters<typeof createProviderProxyAcquisitionSteps>[0] {
    const coordinatorIdentity: CoordinatorIdentity = {
      instanceId: randomUUID(),
      pid: process.pid,
      processStartedAtSeconds: probeProcessStartedAtSeconds(process.pid, process.platform) ?? 0,
      generation: GENERATION,
      flavor: FLAVOR,
      buildSetId: shared.buildSetId,
    };
    return {
      runtime: environment.outerRuntime(),
      pluginRoot: baseDir,
      coordinatorIdentity,
      hostFingerprint: shared.hostFingerprint,
      baseDir,
      readProcessStartedAtSeconds: environment.readProcessStartedAtSeconds,
    };
  }

  it('acquires a full set end to end: all three controls authenticate and agree on the issued identities', async () => {
    const baseDir = scopedTempDir('coral-topology-acquire-');
    const shared = mintSharedSetIdentity();
    const environment = createFakeRoleEnvironment({
      base: createRealRuntime(FLAVOR),
      pluginRoot: baseDir,
      baseDir,
      resolveStrictIdentity: () => strictIdentity(shared.buildSetId),
    });
    cleanups.push(() => closeHandles(environment));

    const steps = createProviderProxyAcquisitionSteps(acquisitionOptions(environment, baseDir, shared));
    const result = await acquireProviderProxySet({ steps, deadlineSignal: AbortSignal.timeout(15_000) });

    expect(result.kind).toBe('acquired');
    if (result.kind !== 'acquired') throw new Error(`unreachable: ${JSON.stringify(result)}`);
    expect(result.set.proxyInstanceId.length).toBeGreaterThan(0);
    await expect(result.set.snapshotOperations(new AbortController().signal)).resolves.toEqual([]);

    const reaped = await result.set.stopAndReap(new AbortController().signal);
    expect(reaped).toHaveProperty('disappearanceReceipt');
    result.set.stopHeartbeats();
    await result.set.initiateControlClose();
  });

  it('unwinds the capsules and reaps the guardian when a later cut fails control establishment', async () => {
    const baseDir = scopedTempDir('coral-topology-cut-');
    const shared = mintSharedSetIdentity();
    const environment = createFakeRoleEnvironment({
      base: createRealRuntime(FLAVOR),
      pluginRoot: baseDir,
      baseDir,
      resolveStrictIdentity: () => strictIdentity(shared.buildSetId),
      // The guardian comes up and reports a pid one off from the one this acquisition actually spawned and
      // observed — the exact disagreement `establishControl`'s "checks the returned identities against what
      // was issued" step exists to catch. Every other role self-reports honestly.
      selfPidFor: (role, spawnedPid) => (role === 'guardian' ? spawnedPid + 1 : spawnedPid),
    });
    cleanups.push(() => closeHandles(environment));

    const runtime = environment.outerRuntime();
    const rmSyncCalls: Array<{ path: string; force: boolean | undefined }> = [];
    const spiedRuntime: Runtime = {
      ...runtime,
      storage: {
        ...runtime.storage,
        rmSync: (path, opts) => {
          rmSyncCalls.push({ path, force: opts?.force });
          runtime.storage.rmSync(path, opts);
        },
      },
    };

    const steps = createProviderProxyAcquisitionSteps({
      ...acquisitionOptions(environment, baseDir, shared),
      runtime: spiedRuntime,
    });
    const result = await acquireProviderProxySet({ steps, deadlineSignal: AbortSignal.timeout(15_000) });

    expect(result).toMatchObject({
      kind: 'provider_proxy_acquisition_failed',
      cut: 'control establishment',
      strandedArtifacts: [],
    });

    // Reaps the guardian by its own group (it is spawned `detached: true`, a leader in its own right): the
    // undo targets the exact pid this acquisition itself spawned and observed, not the mismatched pid the
    // guardian self-reported.
    const guardianSpawn = environment.spawnLog.find((entry) => entry.role === 'guardian');
    expect(guardianSpawn).toBeDefined();
    expect(environment.killLog).toContainEqual({ pid: -(guardianSpawn?.pid as number), signal: 'SIGTERM' });

    // Unwinds the capsules: the three capsule paths this acquisition itself minted were all handed to
    // `rmSync` with `force: true`, regardless of whether the underlying process had already consumed them.
    expect(rmSyncCalls).toHaveLength(3);
    expect(rmSyncCalls.every((call) => call.force === true)).toBe(true);

    // And no capsule debris is left behind on disk either way.
    const runDir = join(baseDir, GENERATION, 'run');
    if (existsSync(runDir)) {
      const remaining = readdirSync(runDir).filter((name) => name.endsWith('.bootstrap.json'));
      expect(remaining).toEqual([]);
    }
  });
});
