import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { createEnforcerDeadlineStateMachine } from '#src/provider-proxy/orphan-deadline.js';
import { runtimeControlTimer, type connectRoleControlWithRetry } from '#src/provider-proxy/role-spawn.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';

type CreateEnforcerDeadlineStateMachine = typeof createEnforcerDeadlineStateMachine;
type ConnectRoleControlWithRetry = typeof connectRoleControlWithRetry;

const bootstrapTimingHarness = vi.hoisted(() => ({
  enabled: false,
  nowMs: 0,
  openingChallengeIssuedAtMs: 11_000,
  initialHeartbeatAcceptanceMs: 19_200,
  heartbeatCalls: 0,
  events: [] as string[],
  guardianEvidenceOffsetMs: null as null | (() => number),
  guardianState: null as null | (() => string),
  reaperReadyObserved: false,
}));

vi.mock('#src/provider-proxy/orphan-deadline.js', async (importOriginal) => {
  const actual = (await importOriginal<object>()) as object & {
    createEnforcerDeadlineStateMachine: CreateEnforcerDeadlineStateMachine;
  };
  const createEnforcerDeadlineStateMachine = ((...args: Parameters<CreateEnforcerDeadlineStateMachine>) => {
    const machine = actual.createEnforcerDeadlineStateMachine(...args);
    if (bootstrapTimingHarness.enabled && bootstrapTimingHarness.guardianEvidenceOffsetMs === null) {
      const [clock] = args;
      const constructedAt = machine.bounds().lastRoundTripEvidenceAt;
      bootstrapTimingHarness.events.push('deadline-construction');
      bootstrapTimingHarness.guardianEvidenceOffsetMs = () =>
        clock.millisecondsBetween(constructedAt, machine.bounds().lastRoundTripEvidenceAt);
      bootstrapTimingHarness.guardianState = () => machine.state();
    }
    return machine;
  }) as CreateEnforcerDeadlineStateMachine;
  return { ...actual, createEnforcerDeadlineStateMachine };
});

vi.mock('#src/provider-proxy/role-spawn.js', async (importOriginal) => {
  const actual = (await importOriginal<object>()) as object & {
    connectRoleControlWithRetry: ConnectRoleControlWithRetry;
  };
  const connectRoleControlWithRetry = (async (...args: Parameters<ConnectRoleControlWithRetry>) => {
    const client = await actual.connectRoleControlWithRetry(...args);
    if (!bootstrapTimingHarness.enabled) return client;
    if (!bootstrapTimingHarness.reaperReadyObserved) {
      bootstrapTimingHarness.reaperReadyObserved = true;
      bootstrapTimingHarness.nowMs = 4_500;
      bootstrapTimingHarness.events.push('reaper-ready');
    }
    return {
      ...client,
      async call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
        if (method === 'guardian.open.v1') {
          bootstrapTimingHarness.nowMs = bootstrapTimingHarness.openingChallengeIssuedAtMs;
        }
        if (method === 'guardian.heartbeat.v1') {
          bootstrapTimingHarness.heartbeatCalls += 1;
          if (bootstrapTimingHarness.heartbeatCalls === 1) {
            bootstrapTimingHarness.nowMs = bootstrapTimingHarness.initialHeartbeatAcceptanceMs;
          }
        }
        try {
          const result = await client.call(method, params, timeoutMs);
          if (method === 'reaper.pair.v1') {
            bootstrapTimingHarness.nowMs = 9_400;
            bootstrapTimingHarness.events.push('reaper-paired');
          } else if (method === 'guardian.open.v1') {
            bootstrapTimingHarness.nowMs = 14_300;
            bootstrapTimingHarness.events.push('open-response');
          } else if (method === 'guardian.heartbeat.v1' && bootstrapTimingHarness.heartbeatCalls === 1) {
            bootstrapTimingHarness.events.push('initial-heartbeat-accepted');
          } else if (method === 'guardian.heartbeat.v1') {
            bootstrapTimingHarness.events.push(`recurring-heartbeat-settled:${bootstrapTimingHarness.heartbeatCalls}`);
          }
          return result;
        } catch (error: unknown) {
          if (method === 'guardian.heartbeat.v1' && bootstrapTimingHarness.heartbeatCalls === 1) {
            bootstrapTimingHarness.events.push(`initial-heartbeat-rejected:${String(error)}`);
          } else if (method === 'guardian.heartbeat.v1') {
            bootstrapTimingHarness.events.push(`recurring-heartbeat-rejected:${String(error)}`);
          }
          throw error;
        }
      },
    };
  }) as ConnectRoleControlWithRetry;
  return { ...actual, connectRoleControlWithRetry };
});

// `runProviderRoleMain` (unlike `startProviderGuardianRole`/`startProviderReaperRole`/`startProviderProxyRole`
// below, which take injectable ports) has no seam to supply a strict-identity resolver through — it always
// resolves the real, embedded-vs-adjacent-manifest identity, unavailable in this dev/test environment. Mocked
// only for the one describe block at the end of this file that drives `runProviderRoleMain` itself (BLOCKING
// B6's SIGTERM wiring); every other describe block here calls the role-start functions directly and injects
// `resolveStrictIdentity` through the normal port, unaffected by this mock.
vi.mock('#src/infra/bundle-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    resolveStrictBundleIdentity: () => ({
      ok: true,
      manifest: {
        version: '1.0.0',
        buildSetId: '99999999-9999-4999-8999-999999999999',
        flavor: 'prod',
        storeFormatFingerprint: `sha256:${'e'.repeat(64)}`,
        bundleHash: '1'.repeat(16),
        cliBundleHash: '2'.repeat(16),
        claudeAppserverBundleHash: '3'.repeat(16),
      },
    }),
  };
});

import type { StrictBundleIdentityResult } from '#src/infra/bundle-manifest.js';
import {
  providerGuardianBootstrapCapsulePath,
  providerGuardianEndpoint,
  providerHandoffCapsulePath,
  providerProxyBootstrapCapsulePath,
  providerProxyEndpoint,
  providerReaperBootstrapCapsulePath,
  providerReaperEndpoint,
} from '#src/infra/path/index.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import { createProviderProxyAcquisitionSteps } from '#src/coordinator/live/provider-proxy/acquisition-steps.js';
import { acquireProviderProxySet } from '#src/coordinator/live/provider-proxy/index.js';
import { isProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { createProviderProxyAuthorityHeartbeatAssembly } from '#src/coordinator/live/provider-proxy/heartbeat.js';
import { establishRoleControl } from '#src/coordinator/live/provider-proxy/role-control.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import {
  attemptProviderProxySetInheritance,
  type ProviderProxySetLocator,
} from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
import {
  createProviderBootstrapCapsule,
  type GuardianBootstrapCapsule,
  type ProxyBootstrapCapsule,
  type ReaperBootstrapCapsule,
} from '#src/provider-proxy/bootstrap-capsule.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import {
  createFrameReader,
  controlEpochSchema,
  decodeProxyControlFrame,
  encodeProxyControlFrame,
  guardianIdentitySchema,
  guardianOpenParamsSchema,
  heartbeatChallengeSchema,
  proxyIdentitySchema,
} from '#src/provider-proxy/protocol.js';
import type { CoordinatorIdentity } from '#src/provider-proxy/protocol.js';
import { PROVIDER_ROLE_FLAGS, type ProviderRole } from '#src/provider-proxy/role-argv.js';
import {
  runProviderRoleMain,
  startProviderGuardianRole,
  startProviderProxyRole,
  startProviderReaperRole,
  type GuardianRoleHandle,
  type ProviderRoleHandle,
  type ProviderRoleMainPorts,
  type ProxyRoleHandle,
  type ReaperRoleHandle,
} from '#src/provider-proxy/role-main.js';
import type { Runtime, RuntimeSpawnOptions } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { CURRENT_HANDOFF_CAPSULE_VERSION } from '#src/provider-proxy/handoff-capsule.js';

/** The build this fixture lifecycle belongs to — the same one `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';

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
const timingGuardianOpenResultSchema = z
  .object({
    controlEpoch: controlEpochSchema,
    heartbeatChallenge: heartbeatChallengeSchema,
    guardian: guardianIdentitySchema,
    proxy: proxyIdentitySchema,
  })
  .strict();

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
  /** Overrides the incarnation a spawned pid reads back as. `null` simulates a spawn whose incarnation cannot
   *  be read at all. Defaults to a value derived from the pid, distinct per spawn. */
  incarnationFor?(role: ProviderRole, pid: number): ProcessIncarnation | null;
  /** Overrides the pid a role reports about itself (`ports.runtime.env.pid()`, read by `readSelfIdentity`).
   *  Defaults to the pid the fake spawn assigned it. Exists to engineer a deliberate self-report disagreement. */
  selfPidFor?(role: ProviderRole, spawnedPid: number): number;
  /** Called synchronously the instant the fake spawn call for the *proxy* is made — after the reaper is
   *  fully up, before `recordContainment`'s forward to it. Exists so a test can sever the guardian's own
   *  pairing channel to the reaper right at that point, engineering a forward failure at the one cut nothing
   *  else here can reach: everything up to it has already succeeded. */
  onProxySpawning?(): void;
  onGuardianListening?(): void;
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
  readProcessIncarnation(pid: number, platform: NodeJS.Platform): ProcessIncarnation | null;
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
  const pidHandles = new Map<number, ProviderRoleHandle>();
  const incarnationByPid = new Map<number, ProcessIncarnation | null>();

  const readProcessIncarnation = (pid: number, platform: NodeJS.Platform): ProcessIncarnation | null => {
    if (incarnationByPid.has(pid)) return incarnationByPid.get(pid) ?? null;
    return probeProcessIncarnation(pid, platform);
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
      readProcessIncarnation,
      onGuardianListening: () => {
        sequenceLog.push('guardian-listening');
        options.onGuardianListening?.();
      },
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
    const incarnation = (options.incarnationFor ?? ((_role, p) => testIncarnation(`base-${p}`)))(role, pid);
    incarnationByPid.set(pid, incarnation);
    if (selfPid !== pid) incarnationByPid.set(selfPid, incarnation);
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

  /** The pid whose process group `pid` belongs to. A detached spawn is its own leader; the only non-detached
   *  spawn in this topology is the reaper, which shares the guardian's group exactly as the real topology
   *  does — mirroring `role-spawn.ts`'s own `detached` convention rather than tracking group ids separately. */
  function groupLeaderPidOf(pid: number): number {
    const entry = spawnLog.find((candidate) => candidate.pid === pid);
    if (entry === undefined || entry.detached) return pid;
    return spawnLog.find((candidate) => candidate.role === 'guardian')?.pid ?? pid;
  }

  function fakeKill(pid: number, signal: NodeJS.Signals | 0): boolean {
    killLog.push({ pid, signal: String(signal) });
    // A negative pid is the group-signal convention: every registered handle whose group leader is `-pid`
    // receives it, exactly as a real OS `kill(-pid, …)` reaches every process in that group.
    const targets =
      pid < 0 ? [...pidHandles.keys()].filter((candidate) => groupLeaderPidOf(candidate) === -pid) : [pid];
    for (const target of targets) {
      const handle = pidHandles.get(target);
      if (handle === undefined) continue;
      pidHandles.delete(target);
      if (signal !== 'SIGTERM') continue; // SIGKILL is not catchable; nothing left to run.
      // Mirrors `runProviderRoleMain`'s own shutdown dispatch: a guardian or reaper must reap what it holds
      // before it exits (`giveUp`); the proxy holds no containment of its own and just closes.
      void (handle.role === 'proxy' ? handle.close() : handle.giveUp());
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
    readProcessIncarnation,
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
): Readonly<{
  guardianCapsulePath: string;
  guardianEndpoint: string;
  guardianCapsule: GuardianBootstrapCapsule;
  proxyCapsule: ProxyBootstrapCapsule;
}> {
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

  return { guardianCapsulePath, guardianEndpoint, guardianCapsule, proxyCapsule };
}

async function closeHandles(environment: FakeRoleEnvironment): Promise<void> {
  await environment.handles.proxy?.close();
  await environment.handles.reaper?.close();
  await environment.handles.guardian?.close();
}

function releaseTimingBarrier(barrier: (() => void) | null, label: string): void {
  if (barrier === null) throw new Error(`${label} was not reached`);
  barrier();
}

function releaseTimingBarrierIfPresent(barrier: (() => void) | null): void {
  if (barrier !== null) barrier();
}

async function runGuardianBootstrapSchedule(initialHeartbeatAcceptanceMs: number, openingChallengeIssuedAtMs = 11_000) {
  bootstrapTimingHarness.enabled = true;
  bootstrapTimingHarness.nowMs = 0;
  bootstrapTimingHarness.openingChallengeIssuedAtMs = openingChallengeIssuedAtMs;
  bootstrapTimingHarness.initialHeartbeatAcceptanceMs = initialHeartbeatAcceptanceMs;
  bootstrapTimingHarness.heartbeatCalls = 0;
  bootstrapTimingHarness.events.splice(0);
  bootstrapTimingHarness.guardianEvidenceOffsetMs = null;
  bootstrapTimingHarness.guardianState = null;
  bootstrapTimingHarness.reaperReadyObserved = false;

  const monotonicRead = vi
    .spyOn(process.hrtime, 'bigint')
    .mockImplementation(() => BigInt(bootstrapTimingHarness.nowMs) * 1_000_000n);
  cleanups.push(() => {
    bootstrapTimingHarness.enabled = false;
    monotonicRead.mockRestore();
  });

  const baseDir = scopedTempDir('coral-bootstrap-timing-');
  const shared = mintSharedSetIdentity();
  let startCoordinatorControl = (): void => {
    throw new Error('guardian timing control started before its plan was ready');
  };
  const environment = createFakeRoleEnvironment({
    base: createRealRuntime(FLAVOR),
    pluginRoot: baseDir,
    baseDir,
    resolveStrictIdentity: () => strictIdentity(shared.buildSetId),
    onGuardianListening: () => {
      bootstrapTimingHarness.nowMs = 9_500;
      bootstrapTimingHarness.events.push('guardian-listening');
      startCoordinatorControl();
    },
  });
  cleanups.push(() => closeHandles(environment));
  const { guardianCapsulePath, guardianEndpoint, guardianCapsule, proxyCapsule } = writeCapsuleSet(
    environment.outerRuntime(),
    baseDir,
    shared,
  );

  const coordinatorIdentity: CoordinatorIdentity = {
    instanceId: randomUUID(),
    pid: 4_000,
    incarnation: testIncarnation(700),
    generation: GENERATION,
    flavor: FLAVOR,
    buildSetId: shared.buildSetId,
  };
  const guardianIncarnation = environment.readProcessIncarnation(
    process.pid,
    environment.outerRuntime().env.platform() as NodeJS.Platform,
  );
  if (guardianIncarnation === null) throw new Error('test could not read the guardian process incarnation');

  const openedClients: ControlClient[] = [];
  cleanups.push(() => {
    for (const client of openedClients) client.close();
  });
  const clientTime = new VirtualTime();
  const faults = createProviderProxyAuthorityFaultLatch();
  const timer = runtimeControlTimer({ time: clientTime } as unknown as Runtime);
  const outerTime = environment.outerRuntime().time;
  const coordinatorControl: { promise: ReturnType<typeof establishRoleControl> | null } = { promise: null };
  startCoordinatorControl = () => {
    const reaperSpawn = environment.spawnLog.find((record) => record.role === 'reaper');
    if (reaperSpawn === undefined) throw new Error('guardian listened before the real reaper readiness path settled');
    const proxyPid = reaperSpawn.pid + 1;
    const proxyIdentity = {
      proxyInstanceId: proxyCapsule.proxyInstanceId,
      pid: proxyPid,
      incarnation: testIncarnation(`base-${proxyPid}`),
      processGroupId: proxyPid,
      guardianInstanceId: proxyCapsule.guardianInstanceId,
      reaperInstanceId: proxyCapsule.reaperInstanceId,
      generation: proxyCapsule.generation,
      flavor: proxyCapsule.flavor,
      buildSetId: proxyCapsule.buildSetId,
      hostFingerprint: proxyCapsule.hostFingerprint,
      canonicalEndpoint: proxyCapsule.canonicalEndpoint,
    };
    coordinatorControl.promise = establishRoleControl(
      openedClients,
      timer,
      {
        connectTimeoutMs: 2_000,
        retryIntervalMs: 20,
        overallDeadlineMs: 10_000,
        now: () => outerTime.now(),
        sleep: (ms) => outerTime.sleep(ms),
      },
      {
        role: 'guardian',
        endpoint: guardianEndpoint,
        openMethod: 'guardian.open.v1',
        openParams: {
          bootstrapNonce: guardianCapsule.bootstrapNonce,
          coordinator: coordinatorIdentity,
          proxy: proxyIdentity,
        },
        openParamsSchema: guardianOpenParamsSchema,
        openResultSchema: timingGuardianOpenResultSchema,
        identity: (opened) => opened.guardian,
        heartbeatMethod: 'guardian.heartbeat.v1',
        expectedIdentity: {
          guardianInstanceId: guardianCapsule.guardianInstanceId,
          pid: process.pid,
          incarnation: guardianIncarnation,
          generation: guardianCapsule.generation,
          flavor: guardianCapsule.flavor,
          buildSetId: guardianCapsule.buildSetId,
          hostFingerprint: guardianCapsule.hostFingerprint,
          canonicalControlEndpoint: guardianCapsule.canonicalControlEndpoint,
        },
      },
    );
    void coordinatorControl.promise.catch(() => undefined);
  };

  const handle = await startProviderGuardianRole(guardianCapsulePath, environment.topLevelPorts());
  environment.handles.guardian = handle;
  const controlPromise = coordinatorControl.promise;
  if (controlPromise === null) throw new Error('guardian listened without starting coordinator control');
  const control = await controlPromise.then(
    (session) => ({ accepted: true as const, session }),
    (error: unknown) => ({ accepted: false as const, error }),
  );
  return { clientTime, control, environment, faults, guardianInstanceId: guardianCapsule.guardianInstanceId };
}

describe('provider-proxy process topology: guardian role main', () => {
  it('carries construction-anchored bootstrap control through real readiness, pairing, open, and initial heartbeat', async () => {
    const scheduled = await runGuardianBootstrapSchedule(19_200);
    expect({
      control: scheduled.control.accepted ? 'accepted' : `rejected:${String(scheduled.control.error)}`,
      evidenceAt: bootstrapTimingHarness.guardianEvidenceOffsetMs?.(),
      state: bootstrapTimingHarness.guardianState?.(),
    }).toEqual({ control: 'accepted', evidenceAt: 19_200, state: 'accepting-control' });
    if (!scheduled.control.accepted) throw scheduled.control.error;
    bootstrapTimingHarness.events.push('control-established');
    const observedFaults: string[] = [];
    scheduled.faults.onFault((fault) => observedFaults.push(fault.kind));
    const heartbeatTime = new VirtualTime();
    const heartbeatAssembly = createProviderProxyAuthorityHeartbeatAssembly(
      { time: heartbeatTime } as unknown as Runtime,
      scheduled.faults,
    );
    heartbeatAssembly.startRole('guardian', {
      client: scheduled.control.session.client,
      controlEpoch: scheduled.control.session.opened.controlEpoch,
      nextHeartbeatChallenge: scheduled.control.session.nextHeartbeatChallenge,
      instanceId: scheduled.guardianInstanceId,
    });
    bootstrapTimingHarness.events.push('loop-enrolled');

    expect(bootstrapTimingHarness.events).toEqual([
      'deadline-construction',
      'reaper-ready',
      'reaper-paired',
      'guardian-listening',
      'open-response',
      'initial-heartbeat-accepted',
      'control-established',
      'loop-enrolled',
    ]);
    expect(observedFaults).toEqual([]);
    heartbeatAssembly.stop();
  });

  it('rejects the real production initial heartbeat at construction-anchored adoption equality', async () => {
    const scheduled = await runGuardianBootstrapSchedule(23_000);

    expect({
      control: scheduled.control.accepted ? 'accepted' : `rejected:${String(scheduled.control.error)}`,
      evidenceAt: bootstrapTimingHarness.guardianEvidenceOffsetMs?.(),
      state: bootstrapTimingHarness.guardianState?.(),
    }).toEqual({
      control: expect.stringContaining('json-rpc-error:-32600:invalid_request:none'),
      evidenceAt: 0,
      state: 'teardown-latched',
    });
  });

  it('stamps the real initial echo at acceptance before the recurring heartbeat tests ordinary control loss', async () => {
    const scheduled = await runGuardianBootstrapSchedule(19_300, 9_500);
    if (!scheduled.control.accepted) throw scheduled.control.error;
    const observedFaults: string[] = [];
    scheduled.faults.onFault((fault) => {
      observedFaults.push(
        fault.kind === 'heartbeat-failed' ? `${fault.kind}(${fault.role}):${String(fault.error)}` : fault.kind,
      );
    });
    const heartbeatTime = new VirtualTime();
    const heartbeatAssembly = createProviderProxyAuthorityHeartbeatAssembly(
      { time: heartbeatTime } as unknown as Runtime,
      scheduled.faults,
    );
    heartbeatAssembly.startRole('guardian', {
      client: scheduled.control.session.client,
      controlEpoch: scheduled.control.session.opened.controlEpoch,
      nextHeartbeatChallenge: scheduled.control.session.nextHeartbeatChallenge,
      instanceId: scheduled.guardianInstanceId,
    });

    bootstrapTimingHarness.nowMs = 22_000;
    heartbeatTime.tick(1_000);
    await vi.waitFor(() =>
      expect(bootstrapTimingHarness.events.some((event) => event.startsWith('recurring-heartbeat'))).toBe(true),
    );

    expect({
      recurringEvents: bootstrapTimingHarness.events.filter((event) => event.startsWith('recurring-heartbeat')),
      evidenceAt: bootstrapTimingHarness.guardianEvidenceOffsetMs?.(),
      state: bootstrapTimingHarness.guardianState?.(),
      observedFaults,
    }).toEqual({
      recurringEvents: ['recurring-heartbeat-settled:2'],
      evidenceAt: 22_000,
      state: 'accepting-control',
      observedFaults: [],
    });
    heartbeatAssembly.stop();
  });

  it('counts the previous response tail, next eligible cadence, and next request tail between accepted stamps', async () => {
    const scheduled = await runGuardianBootstrapSchedule(19_200);
    if (!scheduled.control.accepted) throw scheduled.control.error;
    const observedFaults: string[] = [];
    scheduled.faults.onFault((fault) => {
      observedFaults.push(
        fault.kind === 'heartbeat-failed' ? `${fault.kind}(${fault.role}):${String(fault.error)}` : fault.kind,
      );
    });
    const heartbeatTime = new VirtualTime();
    const heartbeatAssembly = createProviderProxyAuthorityHeartbeatAssembly(
      { time: heartbeatTime } as unknown as Runtime,
      scheduled.faults,
    );
    heartbeatAssembly.startRole('guardian', {
      client: scheduled.control.session.client,
      controlEpoch: scheduled.control.session.opened.controlEpoch,
      nextHeartbeatChallenge: scheduled.control.session.nextHeartbeatChallenge,
      instanceId: scheduled.guardianInstanceId,
    });

    const originalWrite = Socket.prototype.write;
    let holdResponse = true;
    let holdRequest = false;
    let releaseResponse: (() => void) | null = null;
    let releaseRequest: (() => void) | null = null;
    const writeSpy = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (
      this: Socket,
      ...args: Parameters<Socket['write']>
    ): boolean {
      const [chunk] = args;
      const frame = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      const forward = (): boolean => Reflect.apply(originalWrite, this, args);
      if (holdResponse && frame.includes('"nextHeartbeatChallenge"')) {
        holdResponse = false;
        releaseResponse = () => {
          forward();
        };
        return true;
      }
      if (holdRequest && frame.includes('"method":"guardian.heartbeat.v1"')) {
        holdRequest = false;
        releaseRequest = () => {
          forward();
        };
        return true;
      }
      return forward();
    });
    cleanups.push(() => {
      releaseTimingBarrierIfPresent(releaseResponse);
      releaseTimingBarrierIfPresent(releaseRequest);
      writeSpy.mockRestore();
    });

    bootstrapTimingHarness.nowMs = 20_000;
    heartbeatTime.tick(1_000);
    await vi.waitFor(() => expect(releaseResponse).not.toBeNull());
    expect(bootstrapTimingHarness.guardianEvidenceOffsetMs?.()).toBe(20_000);

    bootstrapTimingHarness.nowMs = 24_999;
    scheduled.clientTime.tick(4_999);
    heartbeatTime.tick(5_000);
    expect(bootstrapTimingHarness.heartbeatCalls).toBe(2);
    releaseTimingBarrier(releaseResponse, 'recurring heartbeat response barrier');
    await vi.waitFor(() => expect(bootstrapTimingHarness.events).toContain('recurring-heartbeat-settled:2'));

    bootstrapTimingHarness.nowMs = 26_001;
    holdRequest = true;
    heartbeatTime.tick(1_002);
    await vi.waitFor(() => expect(releaseRequest).not.toBeNull());

    bootstrapTimingHarness.nowMs = 31_000;
    scheduled.clientTime.tick(4_999);
    releaseTimingBarrier(releaseRequest, 'recurring heartbeat request barrier');
    await vi.waitFor(() =>
      expect(
        bootstrapTimingHarness.events.some(
          (event) => event === 'recurring-heartbeat-settled:3' || event.startsWith('recurring-heartbeat-rejected:'),
        ),
      ).toBe(true),
    );

    expect({
      evidenceAt: bootstrapTimingHarness.guardianEvidenceOffsetMs?.(),
      heartbeatCalls: bootstrapTimingHarness.heartbeatCalls,
      recurringEvents: bootstrapTimingHarness.events.filter((event) => event.startsWith('recurring-heartbeat')),
      observedFaults,
    }).toEqual({
      evidenceAt: 31_000,
      heartbeatCalls: 3,
      recurringEvents: ['recurring-heartbeat-settled:2', 'recurring-heartbeat-settled:3'],
      observedFaults: [],
    });
    heartbeatAssembly.stop();
  });

  it('spawns the reaper before pairing, listens before the proxy spawns, spawns the proxy detached, and records containment only once its pid and incarnation are known', async () => {
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
    // Unlike the reaper, the proxy role now pairs with the guardian (`guardian.pair.v1`) before it ever calls
    // `proxy.listen()` — a real round trip over its own socket connection, not settled by the time the
    // guardian's own `recordContainment` awaits only the reaper's ACK. `vi.waitFor` is this file's own existing
    // idiom for exactly this shape of gap (see the `exitLog` wait below).
    await vi.waitFor(() => expect(environment.handles.proxy).toBeDefined(), { timeout: 5_000 });

    // The guardian's own control endpoint was already listening before the proxy spawn call was made: a
    // sequence number recorded at each event (`onGuardianListening`, and at the fake spawn call itself) is
    // what actually discriminates this from the reverse order — unlike `proxySpawn.pid` matching the second
    // spawn log entry, which would hold either way.
    expect(handle.proxySpawn.pid).toBe(environment.spawnLog[1]?.pid);
    expect(environment.sequenceLog).toEqual(['reaper-spawn', 'guardian-listening', 'proxy-spawn']);

    // Containment was recorded: both enforcers are armed, and neither could be without
    // `guardian.recordContainment` having run with the proxy's own spawn-derived pid and incarnation —
    // nothing else could have supplied them, since they exist only as `spawnRoleProcess`'s return value.
    expect(handle.guardian.enforcer()).not.toBeNull();
    expect(environment.handles.reaper?.reaper.enforcer()).not.toBeNull();
  });

  it('fails the spawn — and never records containment — when the proxy incarnation cannot be read', async () => {
    const baseDir = scopedTempDir('coral-topology-badstart-');
    const shared = mintSharedSetIdentity();
    const environment = createFakeRoleEnvironment({
      base: createRealRuntime(FLAVOR),
      pluginRoot: baseDir,
      baseDir,
      resolveStrictIdentity: () => strictIdentity(shared.buildSetId),
      // A pid alone is not an identity — it is recycled — so a spawn whose incarnation cannot be read must
      // fail rather than record a bare pid. Only the proxy's incarnation is made unreadable.
      incarnationFor: (role, pid) => (role === 'proxy' ? null : testIncarnation(`base-${pid}`)),
    });
    cleanups.push(() => closeHandles(environment));
    const { guardianCapsulePath } = writeCapsuleSet(environment.outerRuntime(), baseDir, shared);

    await expect(startProviderGuardianRole(guardianCapsulePath, environment.topLevelPorts())).rejects.toThrow(
      /incarnation/u,
    );

    // The reaper came up fine — it is spawned and paired before the proxy — but must have been told
    // nothing: `recordContainment` is reached only after the proxy's pid and incarnation are known, and here
    // they never were, so its enforcer stays unarmed.
    expect(environment.handles.reaper).toBeDefined();
    expect(environment.handles.reaper?.reaper.enforcer()).toBeNull();
    // No proxy handle: the same unreadable incarnation that failed the guardian's own spawn call also fails
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

    await expect(startProviderGuardianRole(guardianCapsulePath, environment.topLevelPorts())).rejects.toThrow(
      /shared secret/u,
    );

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

    await expect(startProviderGuardianRole(guardianCapsulePath, environment.topLevelPorts())).rejects.toThrow(
      /bind failed/u,
    );

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

    await expect(startProviderGuardianRole(guardianCapsulePath, environment.topLevelPorts())).rejects.toThrow(
      /control channel closed/u,
    );

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
      incarnation: probeProcessIncarnation(process.pid, process.platform) ?? testIncarnation('self'),
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
      readProcessIncarnation: environment.readProcessIncarnation,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
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
    expect(
      existsSync(
        providerHandoffCapsulePath(
          {
            generation: GENERATION,
            flavor: FLAVOR,
            buildSetId: shared.buildSetId,
            hostFingerprint: shared.hostFingerprint,
            proxyInstanceId: result.set.proxyInstanceId,
          },
          CURRENT_HANDOFF_CAPSULE_VERSION,
          { baseDir },
        ),
      ),
    ).toBe(true);
    result.set.stopHeartbeats();
    const reaped = await result.set.stopAndReap(new AbortController().signal);
    expect(reaped).toHaveProperty('disappearanceReceipt');
    await result.set.initiateControlClose();
  });

  it('removes a fresh lifecycle route when the real reaper control channel closes', async () => {
    const baseDir = scopedTempDir('coral-topology-reaper-channel-');
    const shared = mintSharedSetIdentity();
    const environment = createFakeRoleEnvironment({
      base: createRealRuntime(FLAVOR),
      pluginRoot: baseDir,
      baseDir,
      resolveStrictIdentity: () => strictIdentity(shared.buildSetId),
    });
    cleanups.push(() => closeHandles(environment));
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: FIXTURE_BUILD_SET_ID,
      claims,
      controlEstablished: () => undefined,
      time: environment.outerRuntime().time,
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
        'containment-proof': async () => null,
        'disappearance-consumer': async ({ notice }) => ({
          kind: 'accepted',
          acceptance: { kind: 'accepted', operation: notice.operation, disposition: 'record-absent' },
        }),
      }),
      reportLifecycle: () => undefined,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const routeKey = 'fresh-reaper-channel';
    const admission = lifecycle.beginFreshAcquisition(routeKey);
    if (admission.kind !== 'accepted') throw new Error(`fresh set was not admitted: ${admission.kind}`);

    const acquired = await acquireProviderProxySet({
      steps: createProviderProxyAcquisitionSteps(acquisitionOptions(environment, baseDir, shared)),
      deadlineSignal: AbortSignal.timeout(15_000),
    });
    if (acquired.kind !== 'acquired') throw new Error(`acquisition failed: ${JSON.stringify(acquired)}`);
    if (!isProviderProxyOperationAuthority(acquired.set)) throw new Error('expected durable authority');
    const set = acquired.set;
    lifecycle.acquisitionSucceeded(admission.slotId, set);
    expect(lifecycle.routeFor(routeKey)).toBe(set);

    await environment.handles.reaper?.close();
    const observedFault = await Promise.race([
      set.faulted,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    const observation = {
      fault:
        observedFault?.kind === 'control-channel-fault'
          ? { kind: observedFault.kind, role: observedFault.role }
          : observedFault,
      routeAvailable: lifecycle.routeFor(routeKey) !== null,
    };
    set.stopHeartbeats();
    await set.initiateControlClose();

    expect(observation).toEqual({
      fault: { kind: 'control-channel-fault', role: 'reaper' },
      routeAvailable: false,
    });
  });

  it('redeems a standing set after an abrupt coordinator transport cut without a shutdown handoff', async () => {
    const baseDir = scopedTempDir('coral-topology-abrupt-recovery-');
    const shared = mintSharedSetIdentity();
    const environment = createFakeRoleEnvironment({
      base: createRealRuntime(FLAVOR),
      pluginRoot: baseDir,
      baseDir,
      resolveStrictIdentity: () => strictIdentity(shared.buildSetId),
    });
    cleanups.push(() => closeHandles(environment));

    const acquired = await acquireProviderProxySet({
      steps: createProviderProxyAcquisitionSteps(acquisitionOptions(environment, baseDir, shared)),
      deadlineSignal: AbortSignal.timeout(15_000),
    });
    if (acquired.kind !== 'acquired') throw new Error(`acquisition failed: ${JSON.stringify(acquired)}`);
    const identity = acquired.set.setIdentity;
    const operation = {
      jobId: randomUUID(),
      operationId: randomUUID(),
      proxyInstanceId: acquired.set.proxyInstanceId,
      buildSetId: identity.buildSetId,
    };
    const reference: ProviderProxySetLocator = {
      operation,
      locator: {
        hostFingerprint: identity.hostFingerprint,
        guardian: {
          instanceId: identity.guardianInstanceId,
          pid: identity.guardianPid,
          incarnation: identity.guardianIncarnation,
          controlEndpoint: identity.guardianControlEndpoint,
        },
        proxy: {
          instanceId: identity.proxyInstanceId,
          pid: identity.proxyPid,
          incarnation: identity.proxyIncarnation,
          controlEndpoint: identity.canonicalEndpoint,
        },
        reaper: {
          instanceId: identity.reaperInstanceId,
          pid: identity.reaperPid,
          incarnation: identity.reaperIncarnation,
          controlEndpoint: identity.reaperControlEndpoint,
        },
        containment: {
          pid: identity.proxyPid,
          incarnation: identity.proxyIncarnation,
          processGroupId: identity.proxyProcessGroupId,
          kind: identity.containmentKind,
        },
      },
    };
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    insertProviderOperation(db, providerOperationRecord('prepare-pending', { operation, locator: reference.locator }));

    await acquired.set.registerSuccessionOperation(operation);
    acquired.set.stopHeartbeats();
    await acquired.set.initiateControlClose();

    const successorIdentity: CoordinatorIdentity = {
      instanceId: randomUUID(),
      pid: process.pid,
      incarnation: probeProcessIncarnation(process.pid, process.platform) ?? testIncarnation('self'),
      generation: GENERATION,
      flavor: FLAVOR,
      buildSetId: shared.buildSetId,
    };
    const recovered = await attemptProviderProxySetInheritance(
      reference,
      db,
      {
        runtime: environment.outerRuntime(),
        baseDir,
        coordinatorIdentity: successorIdentity,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      },
      AbortSignal.timeout(15_000),
    );

    expect(recovered.kind).toBe('inherited');
    if (recovered.kind !== 'inherited') throw new Error(`recovery failed: ${JSON.stringify(recovered)}`);
    await expect(recovered.set.attachOperation(operation, 0)).resolves.toEqual({
      state: 'operation-absent',
      operation,
    });
    recovered.set.stopHeartbeats();
    const reaped = await recovered.set.stopAndReap(new AbortController().signal);
    expect(reaped).toHaveProperty('disappearanceReceipt');
    await recovered.set.initiateControlClose();
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

    // BLOCKING: the guardian's own construction had already spawned and recorded the proxy containment by
    // this point (it only rejects the coordinator's identity check *after* its own listen and
    // recordContainment already succeeded), so the group SIGTERM above must make it (and the reaper right
    // alongside it, sharing its process group) actually reap that containment, not merely disarm and
    // disappear leaving the detached, out-of-group proxy held by no one. `exitProcess` is only ever called
    // with `0` for a settled `containment-absent` outcome (`ROLE_ENFORCEMENT_FAILURE_EXIT_CODE` otherwise) —
    // a plain `close()` never reaches it at all — so this is proof enforcement actually ran, not merely that
    // a signal was sent. The old `handle.close()` shutdown left this unset, stranding the proxy forever.
    await vi.waitFor(() => expect(environment.exitLog).toContain(0), { timeout: 5_000 });

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

describe('provider-proxy process topology: proxy role SIGTERM (BLOCKING B6)', () => {
  /** Just enough of a guardian to answer `guardian.pair.v1` — the one RPC `startProviderProxyRole` sends
   *  before it can stand up its own control endpoint. No real guardian/reaper is needed for this: the defect
   *  and its fix live entirely in the proxy role's own shutdown path (`role-main.ts`). */
  function startFakeGuardian(endpoint: string): Promise<{ close: () => void }> {
    return new Promise((resolve) => {
      const server = createServer((socket: Socket) => {
        socket.on(
          'data',
          createFrameReader(
            (frame) => {
              const message = decodeProxyControlFrame(frame);
              if ('method' in message) {
                socket.write(encodeProxyControlFrame({ jsonrpc: '2.0', id: message.id, result: { state: 'paired' } }));
              }
            },
            () => {},
          ),
        );
      });
      server.listen(endpoint, () => resolve({ close: () => server.close() }));
    });
  }

  it('drains kernels and exits the process on SIGTERM — the same close-and-exit guarantee guardian/reaper already have', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coral-role-proxy-sigterm-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const capsulePath = join(dir, 'proxy.bootstrap.json');
    const runtime = createRealRuntime('prod');
    const capsuleEnv = { storage: runtime.storage, uid: process.getuid?.() ?? 0 };
    const guardianEndpoint = join(dir, 'g.sock');
    const proxyEndpoint = join(dir, 'p.sock');
    const capsule: ProxyBootstrapCapsule = {
      role: 'proxy',
      generation: 'gen2',
      flavor: 'prod',
      // Must match the mocked `resolveStrictBundleIdentity` at the top of this file — this is the one test
      // in it that actually reaches `assertConsumingBuild` through `runProviderRoleMain`'s own dispatch.
      buildSetId: '99999999-9999-4999-8999-999999999999',
      hostFingerprint: randomBytes(32).toString('hex'),
      guardianInstanceId: randomUUID(),
      reaperInstanceId: randomUUID(),
      proxyInstanceId: randomUUID(),
      bootstrapNonce: randomBytes(32).toString('hex'),
      canonicalEndpoint: proxyEndpoint,
      guardianControlEndpoint: guardianEndpoint,
      proxyGuardianAuthSecret: randomBytes(32).toString('hex'),
    };
    createProviderBootstrapCapsule(capsulePath, capsule, capsuleEnv);

    const fakeGuardian = await startFakeGuardian(guardianEndpoint);
    cleanups.push(() => fakeGuardian.close());

    // Real `process.exit` would tear down the test worker itself — intercepted the same way this file's own
    // `exitLog` fake stands in for it elsewhere.
    const exitCodes: Array<number | undefined> = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit);
    cleanups.push(() => exitSpy.mockRestore());

    const listenersBefore = new Set(process.listeners('SIGTERM'));

    await runProviderRoleMain({ role: 'proxy', capsulePath }, { pluginRoot: dir });

    // `runProviderRoleMain` installs its own `process.on('SIGTERM', shutdown)`; invoked directly (not via
    // `process.emit`) so this test cannot also trigger whatever else vitest's own process may have listening
    // for the same signal.
    const installed = process.listeners('SIGTERM').filter((listener) => !listenersBefore.has(listener));
    expect(installed).toHaveLength(1);
    const shutdown = installed[0] as () => void;
    cleanups.push(() => {
      process.removeListener('SIGTERM', shutdown as NodeJS.SignalsListener);
    });

    shutdown();
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
  });
});
