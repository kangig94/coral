import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as AppServerTransportModule from '#src/providers/app-server-transport.js';
import type * as ProviderBootstrapModule from '#src/providers/bootstrap.js';
import type * as NodeProcessModule from '#src/infra/node-process.js';
import type * as ProxySetAcquisitionModule from '#src/coordinator/live/provider-hosts/proxy-set-acquisition.js';

const rotationDoubles = vi.hoisted(() => ({
  ensureProxySet: vi.fn(),
  probeProcessStartedAtSeconds: vi.fn(),
  rehydrateBinding: vi.fn(),
  spawnProviderRoot: vi.fn(),
}));

vi.mock('#src/coordinator/live/provider-hosts/proxy-set-acquisition.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProxySetAcquisitionModule>();
  return {
    ...actual,
    ensureProviderProxySet: (...args: Parameters<typeof actual.ensureProviderProxySet>) =>
      rotationDoubles.ensureProxySet(...args),
  };
});

vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeProcessModule>();
  return {
    ...actual,
    probeProcessStartedAtSeconds: (...args: Parameters<typeof actual.probeProcessStartedAtSeconds>) =>
      rotationDoubles.probeProcessStartedAtSeconds(...args) ?? actual.probeProcessStartedAtSeconds(...args),
  };
});

vi.mock('#src/providers/app-server-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AppServerTransportModule>();
  return {
    ...actual,
    spawnProviderServerTransport: (...args: Parameters<typeof actual.spawnProviderServerTransport>) =>
      rotationDoubles.spawnProviderRoot(...args),
  };
});

vi.mock('#src/providers/bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderBootstrapModule>();
  return {
    ...actual,
    createBuiltInProviderRegistry: () => {
      const registry = actual.createBuiltInProviderRegistry();
      let authority: unknown = null;
      return {
        connectAppServerHost: (next: unknown) => {
          authority = next;
        },
        rehydrateBinding: (binding: unknown) => rotationDoubles.rehydrateBinding(binding, authority),
        sealPersistedCodecComponents: registry.sealPersistedCodecComponents.bind(registry),
      };
    },
  };
});

import {
  activateProviderOperation,
  attachProviderOperation,
  authorizeProviderOperation,
  prepareProviderOperation,
  providerOperationErrorCode,
  providerOperationPrepareAttempt,
} from '#src/coordinator/services/provider-proxy-operation-activation.js';
import type { ProviderProxySetIdentity } from '#src/coordinator/services/provider-proxy-set-identity.js';
import { createAppServerProxyRoute } from '#src/coordinator/services/provider-proxy-launch-route.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set-claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set-lifecycle.js';
import { ProviderProxySetLifecycleRef } from '#src/coordinator/services/provider-proxy-set-lifecycle-ref.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { DefaultProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import {
  createProviderProxyOperationAuthority,
  isProviderProxyOperationAuthority,
  type DurableProviderProxyOperationAuthority,
} from '#src/coordinator/live/provider-proxy/operation-route.js';
import { createProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/set-authority.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { createRealTimePort } from '#src/infra/time.js';
import type { JobProgressStore } from '#src/jobs/contracts/job-store.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import type { HostRef, ProviderServerSpec } from '#src/providers/contract.js';
import type { AppServerHostAuthority } from '#src/providers/internal/app-server-host.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { readProviderOperation } from '#src/store/provider-operation-journal.js';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import type { EnforcementScheduler } from '#src/provider-proxy/enforcement.js';
import { createGuardian } from '#src/provider-proxy/guardian.js';
import { createOperationLedger, operationPrepareAttemptKey } from '#src/provider-proxy/ledger.js';
import {
  guardianProxyOperationReleaseParamsSchema,
  guardianProxyOperationReleaseResultSchema,
  proxyOperationActivationOutcomeSchema,
  proxyOperationActivateParamsSchema,
  proxyOperationCancelParamsSchema,
  proxyOperationCancelResultSchema,
  proxyOperationPrepareParamsSchema,
  type ProxyIdentity,
  type ProxyPreparedAppServerOperation,
} from '#src/provider-proxy/protocol.js';
import type { SemanticOperationHost } from '#src/provider-proxy/operation-supervisor.js';
import { createProxy } from '#src/provider-proxy/proxy.js';
import { createReaper } from '#src/provider-proxy/reaper.js';
import { createProxyGuardianContainment } from '#src/provider-proxy/role-main.js';
import {
  createProxyAppServerHostAuthority,
  type ProxyAppServerHostAuthority,
} from '#src/provider-proxy/provider-root-authority.js';
import { createSemanticOperationRuntime } from '#src/provider-proxy/semantic-operation-runner.js';
import {
  asJointActivationReceipt,
  asJointContainmentReceipt,
  asReservation,
} from '#tests/helpers/provider-proxy-correlation.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createFakeProviderServerHandle } from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

/**
 * Drives `createProxyGuardianContainment` — the containment closures `startProviderProxyRole` installs on a
 * real `Proxy` — against a *real* `createGuardian`/`createReaper` pair over real control sockets, following
 * the same setup `enforcer-roles.integration.test.ts` uses. Only `ensureProviderRoot` is faked (a canned root,
 * no child process); the reservation, the wire calls, and the guardian/reaper themselves are all real.
 *
 * This path needs its own seam test because the operation-lifecycle harness injects containment and an
 * end-to-end CLI invocation cannot observe the two guardian hops directly. Forwarding the ledger's own
 * reservation is what lets guardian activation agree with the prepared operation.
 */

const NONCE = 'a'.repeat(64);
const PAIR_SECRET = 'c'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const CONTAINMENT = {
  pid: 5_100,
  processStartedAtSeconds: 900,
  processGroupId: 5_100,
  containmentKind: 'posix-group',
};
const ROOT = { pid: 7_001, processStartedAtSeconds: 800 };
const WALL_CLOCK_MS = Date.parse('2026-08-09T12:34:56.000Z');

const PREPARED: ProxyPreparedAppServerOperation = {
  version: 1,
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'do the thing',
    cwd: '/project',
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
};

function hostRefFor(jobId: string): HostRef {
  return {
    provider: PREPARED.provider,
    fingerprint: FINGERPRINT,
    instanceId: `host:${jobId}`,
    leaseMode: 'job-exclusive',
    ownerJobId: jobId,
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rotationDoubles.ensureProxySet.mockReset();
  rotationDoubles.probeProcessStartedAtSeconds.mockReset();
  rotationDoubles.rehydrateBinding.mockReset();
  rotationDoubles.spawnProviderRoot.mockReset();
});

const timer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

/** Never fires on its own; this test drives every transition through the RPCs themselves. */
const idleScheduler: EnforcementScheduler = { schedule: () => ({}), cancel: () => {} };

/**
 * A real guardian paired with a real reaper over real control sockets, plus a coordinator control connection
 * (`guardian.open.v1`) and the proxy's own paired peer channel (`guardian.pair.v1`) — exactly the
 * `guardianChannel` `startProviderProxyRole` hands to `createProxyGuardianContainment` in production.
 */
async function startGuardianAndReaper() {
  const directory = mkdtempSync(join(tmpdir(), 'coral-proxy-containment-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const guardianEndpoint = join(directory, 'g.sock');
  const reaperEndpoint = join(directory, 'r.sock');
  const proxyEndpoint = join(directory, 'p.sock');

  const shared = {
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId: randomUUID(),
    hostFingerprint: FINGERPRINT,
    guardianInstanceId: randomUUID(),
    reaperInstanceId: randomUUID(),
    proxyInstanceId: randomUUID(),
    bootstrapNonce: NONCE,
  };

  const proxyIdentity: ProxyIdentity = {
    proxyInstanceId: shared.proxyInstanceId,
    pid: 6_000,
    processStartedAtSeconds: 850,
    processGroupId: CONTAINMENT.processGroupId,
    guardianInstanceId: shared.guardianInstanceId,
    reaperInstanceId: shared.reaperInstanceId,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalEndpoint: proxyEndpoint,
  };
  const coordinatorIdentity = {
    instanceId: randomUUID(),
    pid: 4_000,
    processStartedAtSeconds: 700,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
  };

  const alive = new Set([CONTAINMENT.pid]);
  let elapsedMilliseconds = 0n;
  const clock = createMonotonicClock(Symbol('proxy-guardian-containment'), {
    readMilliseconds: () => elapsedMilliseconds,
    sleep: async (milliseconds) => {
      elapsedMilliseconds += BigInt(milliseconds);
    },
  });
  const containmentEnvironment = {
    clock,
    process: {
      kill: (pid: number) => {
        for (const target of pid < 0 ? [...alive] : [pid]) alive.delete(target);
        return true;
      },
      isAlive: (pid: number) => (pid < 0 ? alive.has(-pid) : alive.has(pid)),
    },
    platform: 'linux' as const,
    maxRecordedRoots: 128,
    readProcessStartedAtSeconds: (pid: number) => (alive.has(pid) ? CONTAINMENT.processStartedAtSeconds : null),
  };

  const boundsOf = () => {
    const now = clock.now();
    return {
      lastRoundTripEvidenceAt: now,
      eofAt: null,
      controlLossAt: now,
      adoptionDeadline: clock.shiftMilliseconds(now, 60_000),
      exitDeadline: clock.shiftMilliseconds(now, 74_000),
      firstChallengeExpiresAt: null,
    };
  };
  let challengeCount = 0;
  const mintChallenge = (): string => {
    challengeCount += 1;
    return `challenge-${challengeCount}`;
  };
  const deadlines = {
    controlIsLive: () => true,
    issueFirstChallenge: () => ({ accepted: true, challenge: mintChallenge() }) as const,
    admitSuccessor: () => ({ accepted: true, challenge: mintChallenge() }) as const,
    reattachControl: () => ({ accepted: true }) as const,
    echoChallenge: () => ({ accepted: true, nextChallenge: mintChallenge() }) as const,
    observeEof: () => {},
    observePairingLoss: () => {},
    latchTeardown: () => {},
    markContainmentAbsent: () => {},
    markExited: () => {},
    bounds: boundsOf,
    state: () => 'accepting-control' as const,
  };

  let receipts = 0;
  const mintReceipt = (): string => {
    receipts += 1;
    return `receipt-${receipts}`;
  };

  const reaper = createReaper({
    capsule: {
      role: 'reaper',
      ...shared,
      canonicalControlEndpoint: reaperEndpoint,
      guardianControlEndpoint: guardianEndpoint,
      proxyEndpoint,
      guardianReaperAuthSecret: PAIR_SECRET,
    },
    clock,
    deadlines,
    containmentEnvironment,
    scheduler: idleScheduler,
    timer,
    mintReceipt,
    self: { pid: 5_101, processStartedAtSeconds: 901 },
    onOutcome: () => {},
    onProgressViolation: () => {},
  });
  await reaper.listen();
  cleanups.push(() => reaper.close());

  // The guardian reaches the reaper over the capsule-authenticated pairing channel, exactly as
  // `startProviderGuardianRole` does in production.
  const reaperChannel = await connectControlClient(reaperEndpoint, timer, 5_000);
  cleanups.push(() => reaperChannel.close());
  await reaperChannel.call('reaper.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);
  await reaperChannel.call('reaper.record-containment.v1', CONTAINMENT, 5_000);

  const guardian = createGuardian({
    capsule: {
      role: 'guardian',
      ...shared,
      canonicalControlEndpoint: guardianEndpoint,
      reaperControlEndpoint: reaperEndpoint,
      proxyEndpoint,
      guardianReaperAuthSecret: PAIR_SECRET,
      proxyGuardianAuthSecret: PAIR_SECRET,
    },
    clock,
    deadlines,
    containmentEnvironment,
    scheduler: idleScheduler,
    timer,
    mintReceipt,
    reaperChannel,
    self: { pid: 5_102, processStartedAtSeconds: 902 },
    reaperSelf: { pid: 5_101, processStartedAtSeconds: 901 },
    onOutcome: () => {},
    onProgressViolation: () => {},
  });
  await guardian.listen();
  cleanups.push(() => guardian.close());
  await guardian.recordContainment(CONTAINMENT);

  // The coordinator's own control tenancy — the connection `guardian.operation-activate.v1` below is issued
  // over, exactly as `provider-proxy-operation-activation.ts` issues it in production.
  const control = await connectControlClient(guardianEndpoint, timer, 5_000);
  cleanups.push(() => control.close());
  const opened = (await control.call(
    'guardian.open.v1',
    { bootstrapNonce: NONCE, coordinator: coordinatorIdentity, proxy: proxyIdentity },
    5_000,
  )) as { controlEpoch: number; heartbeatChallenge: string };
  const guardianHeartbeat = (await control.call(
    'guardian.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  )) as { nextHeartbeatChallenge: string };

  const reaperControl = await connectControlClient(reaperEndpoint, timer, 5_000);
  cleanups.push(() => reaperControl.close());
  const reaperOpened = (await reaperControl.call(
    'reaper.open.v1',
    {
      bootstrapNonce: NONCE,
      coordinator: coordinatorIdentity,
      guardian: {
        guardianInstanceId: shared.guardianInstanceId,
        pid: 5_102,
        processStartedAtSeconds: 902,
        generation: shared.generation,
        flavor: shared.flavor,
        buildSetId: shared.buildSetId,
        hostFingerprint: shared.hostFingerprint,
        canonicalControlEndpoint: guardianEndpoint,
      },
      proxy: proxyIdentity,
      containment: CONTAINMENT,
    },
    5_000,
  )) as { controlEpoch: number; heartbeatChallenge: string };
  await reaperControl.call(
    'reaper.heartbeat.v1',
    { controlEpoch: reaperOpened.controlEpoch, heartbeatChallenge: reaperOpened.heartbeatChallenge },
    5_000,
  );

  // The proxy's own connection to its guardian: paired, not the coordinator's control tenancy — exactly the
  // `guardianChannel` `startProviderProxyRole` hands to `createProxyGuardianContainment`.
  const guardianChannel = await connectControlClient(guardianEndpoint, timer, 5_000);
  cleanups.push(() => guardianChannel.close());
  await guardianChannel.call('guardian.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);

  return {
    control,
    guardianControlEpoch: opened.controlEpoch,
    guardianHeartbeatChallenge: guardianHeartbeat.nextHeartbeatChallenge,
    reaperControl,
    guardianChannel,
    guardian,
    reaper,
    proxyIdentity,
    shared,
    coordinatorIdentity,
    clock,
    guardianEndpoint,
    reaperEndpoint,
    proxyEndpoint,
  };
}

async function startCoordinatorActivationSet() {
  const set = await startGuardianAndReaper();
  const started: Array<{ jobId: string; operationId: string; prepared: ProxyPreparedAppServerOperation }> = [];
  const host: SemanticOperationHost = {
    start: ({ key, prepared }) => {
      started.push({ ...key, prepared });
      return {
        result: Promise.resolve({ kind: 'started', hostRef: hostRefFor(key.jobId) }),
        abortAndRelease: async () => {},
      };
    },
    stop: () => {},
  };
  let receiptCount = 0;
  const proxy = createProxy({
    capsule: {
      role: 'proxy',
      ...set.shared,
      canonicalEndpoint: set.proxyEndpoint,
      guardianControlEndpoint: set.guardianEndpoint,
      proxyGuardianAuthSecret: PAIR_SECRET,
    },
    clock: set.clock,
    identity: set.proxyIdentity,
    host,
    timer,
    mintChallenge: () => randomUUID(),
    mintReceipt: () => {
      receiptCount += 1;
      return `proxy-receipt-${receiptCount}`;
    },
    mintReservation: () => asReservation(randomUUID()),
    wallClockNow: () => WALL_CLOCK_MS,
    containment: createProxyGuardianContainment({
      identity: set.proxyIdentity,
      guardianChannel: set.guardianChannel,
      stageProviderRoot: () => ({
        result: Promise.resolve({ state: 'staged', providerRoot: ROOT }),
        abortAndRelease: async () => {},
      }),
    }),
  });
  await proxy.listen();
  cleanups.push(() => proxy.close());

  const proxyControl = await connectControlClient(set.proxyEndpoint, timer, 5_000);
  cleanups.push(() => proxyControl.close());
  const opened = (await proxyControl.call(
    'control.open.v1',
    { bootstrapNonce: NONCE, coordinator: set.coordinatorIdentity },
    5_000,
  )) as { controlEpoch: number; heartbeatChallenge: string };
  await proxyControl.call(
    'control.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  );

  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  cleanups.push(() => db.close());
  const setIdentity: ProviderProxySetIdentity = {
    buildSetId: set.shared.buildSetId,
    hostFingerprint: set.shared.hostFingerprint,
    guardianInstanceId: set.shared.guardianInstanceId,
    guardianPid: 5_102,
    guardianProcessStartedAtSeconds: 902,
    guardianControlEndpoint: set.guardianEndpoint,
    proxyInstanceId: set.proxyIdentity.proxyInstanceId,
    proxyPid: set.proxyIdentity.pid,
    reaperInstanceId: set.shared.reaperInstanceId,
    reaperPid: 5_101,
    reaperProcessStartedAtSeconds: 901,
    reaperControlEndpoint: set.reaperEndpoint,
    containmentKind: CONTAINMENT.containmentKind,
    proxyProcessStartedAtSeconds: set.proxyIdentity.processStartedAtSeconds,
    proxyProcessGroupId: set.proxyIdentity.processGroupId,
    canonicalEndpoint: set.proxyEndpoint,
  };

  return { ...set, db, proxy, proxyControl, setIdentity, started };
}

function establishActivationRoute(setIdentity: ProviderProxySetIdentity) {
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const lifecycle = new ProviderProxySetLifecycle({
    claims,
    controlEstablished: () => undefined,
    disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
    time: { ...timer, now: () => 0 },
    proveContainmentAbsent: () => new Promise<never>(() => undefined),
    retireCapsule: () => ({ kind: 'retired' }),
    rewriteCapsule: () => undefined,
    onFatal: (error) => {
      throw error;
    },
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  const authority = {
    proxyInstanceId: setIdentity.proxyInstanceId,
    setIdentity,
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    stopHeartbeats: () => undefined,
    stopAndReap: () => new Promise<never>(() => undefined),
    initiateControlClose: async () => undefined,
  } as unknown as DurableProviderProxyOperationAuthority;
  const admission = lifecycle.beginFreshAcquisition('activation-route');
  if (admission.kind !== 'accepted') throw new Error('expected activation route admission');
  lifecycle.acquisitionSucceeded(admission.slotId, authority);
  return { lifecycle, authority };
}

const ROTATION_HOST_SPEC: ProviderServerSpec = {
  provider: 'codex',
  command: 'codex',
  args: ['app-server'],
  cwd: '/workspace',
  leaseMode: 'job-exclusive',
};

function rotationBoundProvider(authority: AppServerHostAuthority): BoundProvider {
  let stagedHostRef: HostRef | null = null;
  const unreachable = (name: string): never => {
    throw new Error(`rotation provider unexpectedly called ${name}`);
  };
  return {
    name: PREPARED.provider,
    envelope: PREPARED.binding,
    present: () => unreachable('present'),
    readiness: (() => unreachable('readiness')) as BoundProvider['readiness'],
    compareIdentity: () => unreachable('compareIdentity'),
    decodeContinuity: () => unreachable('decodeContinuity'),
    preflight: (() => unreachable('preflight')) as BoundProvider['preflight'],
    prepareExecution: () => ({
      kind: 'app-server',
      hostSpec: ROTATION_HOST_SPEC,
      execute: (executionRuntime) => {
        if (stagedHostRef === null) throw new Error('rotation provider started without a staged host');
        executionRuntime.onHostRef(stagedHostRef);
        return (async function* () {
          yield {
            kind: 'terminal' as const,
            terminal: { content: 'done', durationMs: 0, outcome: { kind: 'completed' as const } },
            diagnostics: {},
          };
        })();
      },
    }),
    appServer: {
      supportsInterrupt: false,
      supportsProbe: false,
      openReplacement: async (_input, runtime) => {
        const managed = await authority.openSession(ROTATION_HOST_SPEC, {
          jobId: runtime.jobId,
          ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
        });
        stagedHostRef = managed.hostRef;
        return { hostRef: managed.hostRef, close: () => managed.close() };
      },
      interrupt: async () => unreachable('interrupt'),
      probe: async () => unreachable('probe'),
    },
    artifacts: { kind: 'none', reason: 'rotation integration provider' },
  };
}

type RotationSet = Awaited<ReturnType<typeof startRotationSet>>;

async function startRotationSet(operationRegistry: LocalOperationRegistry) {
  const set = await startGuardianAndReaper();
  const runtime = createRealRuntime('prod');
  const hostAuthority = createProxyAppServerHostAuthority(runtime);
  const proxyRef: { current: ReturnType<typeof createProxy> | null } = { current: null };
  const semantic = createSemanticOperationRuntime({
    runtime,
    hostAuthority,
    getProxy: () => {
      if (proxyRef.current === null) throw new Error('rotation proxy is not ready');
      return proxyRef.current;
    },
  });
  let receipts = 0;
  const proxy = createProxy({
    capsule: {
      role: 'proxy',
      ...set.shared,
      canonicalEndpoint: set.proxyEndpoint,
      guardianControlEndpoint: set.guardianEndpoint,
      proxyGuardianAuthSecret: PAIR_SECRET,
    },
    clock: set.clock,
    identity: set.proxyIdentity,
    host: semantic.host,
    timer,
    mintChallenge: () => randomUUID(),
    mintReceipt: () => `rotation-proxy-receipt-${++receipts}`,
    mintReservation: () => asReservation(randomUUID()),
    wallClockNow: () => WALL_CLOCK_MS,
    containment: createProxyGuardianContainment({
      identity: set.proxyIdentity,
      guardianChannel: set.guardianChannel,
      stageProviderRoot: semantic.stage,
    }),
  });
  proxyRef.current = proxy;
  await proxy.listen();
  cleanups.push(() => proxy.close());

  const proxyControl = await connectControlClient(set.proxyEndpoint, timer, 5_000);
  cleanups.push(() => proxyControl.close());
  const opened = (await proxyControl.call(
    'control.open.v1',
    { bootstrapNonce: NONCE, coordinator: set.coordinatorIdentity },
    5_000,
  )) as { controlEpoch: number; heartbeatChallenge: string };
  await proxyControl.call(
    'control.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  );

  const setIdentity: ProviderProxySetIdentity = {
    buildSetId: set.shared.buildSetId,
    hostFingerprint: set.shared.hostFingerprint,
    guardianInstanceId: set.shared.guardianInstanceId,
    guardianPid: 5_102,
    guardianProcessStartedAtSeconds: 902,
    guardianControlEndpoint: set.guardianEndpoint,
    proxyInstanceId: set.proxyIdentity.proxyInstanceId,
    proxyPid: set.proxyIdentity.pid,
    reaperInstanceId: set.shared.reaperInstanceId,
    reaperPid: 5_101,
    reaperProcessStartedAtSeconds: 901,
    reaperControlEndpoint: set.reaperEndpoint,
    containmentKind: CONTAINMENT.containmentKind,
    proxyProcessStartedAtSeconds: set.proxyIdentity.processStartedAtSeconds,
    proxyProcessGroupId: set.proxyIdentity.processGroupId,
    canonicalEndpoint: set.proxyEndpoint,
  };
  const base = createProviderProxySetAuthority({
    proxyInstanceId: set.proxyIdentity.proxyInstanceId,
    guardianClient: set.control,
    proxyClient: proxyControl,
    reaperClient: set.reaperControl,
    guardianIdentity: {
      guardianInstanceId: set.shared.guardianInstanceId,
      pid: 5_102,
      processStartedAtSeconds: 902,
      generation: set.shared.generation,
      flavor: set.shared.flavor,
      buildSetId: set.shared.buildSetId,
      hostFingerprint: set.shared.hostFingerprint,
      canonicalControlEndpoint: set.guardianEndpoint,
    },
    reaperIdentity: {
      reaperInstanceId: set.shared.reaperInstanceId,
      pid: 5_101,
      processStartedAtSeconds: 901,
      guardianInstanceId: set.shared.guardianInstanceId,
      generation: set.shared.generation,
      flavor: set.shared.flavor,
      buildSetId: set.shared.buildSetId,
      hostFingerprint: set.shared.hostFingerprint,
      canonicalControlEndpoint: set.reaperEndpoint,
      containmentKind: CONTAINMENT.containmentKind,
    },
    proxyIdentityFields: set.proxyIdentity,
    heartbeats: {
      proxy: { stop: () => undefined },
      guardian: { stop: () => undefined },
      reaper: { stop: () => undefined },
    },
    coordinatorIdentity: set.coordinatorIdentity,
    handoffCapsulePath: `${set.proxyEndpoint}.handoff.json`,
    runtime,
    operationRegistry,
  });
  const clients = { proxy: proxyControl, guardian: set.control, reaper: set.control };
  const faults = createProviderProxyAuthorityFaultLatch();
  faults.observeControlClient('proxy', clients.proxy);
  faults.observeControlClient('guardian', clients.guardian);
  faults.observeControlClient('reaper', clients.reaper);
  const authority = createProviderProxyOperationAuthority({
    base,
    setIdentity,
    clients,
    faults,
    mutationRpcTimeoutMs: 5_000,
  });

  return { ...set, authority, proxy, proxyControl, semantic };
}

async function completeCapacityLocalHandoff(
  source: RotationSet['authority'],
  capacity: Extract<Awaited<ReturnType<RotationSet['authority']['prepareOperation']>>, { state: 'capacity' }>,
  operation: Readonly<{ jobId: string; operationId: string }>,
): Promise<void> {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  cleanups.push(() => db.close());
  const time = createRealTimePort();
  const registry = new LocalOperationRegistry();
  let localRecoveryCompletions = 0;
  const capacityAuthority = {
    ...source,
    // The driving proxy call above already proved this exact no-ledger capacity answer. Replaying it through
    // the durable local-handoff constructor must not try to install succession after rotation has already
    // closed the old controls: a capacity answer owns no remote operation to succeed.
    registerSuccessionOperation: async () => undefined,
    prepareOperation: async () => capacity,
  };
  const commit: JobProgressStore['commit'] = (callback) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      callback({ append: () => ({}) as never });
      db.exec('COMMIT');
      return [];
    } catch (error: unknown) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const sessionId = randomUUID();
  const reconciler = new ProviderOperationReconciler({
    getProgressStore: () => ({
      getDb: () => db,
      commit,
      readStatus: () => ({
        jobId: operation.jobId,
        owner: { kind: 'provider-session', id: sessionId },
        sessionId,
        provider: PREPARED.provider,
        projectRoot: '/project',
        backendNamespace: 'tests',
        jobKind: 'provider',
        phase: 'running',
        updatedAt: new Date(WALL_CLOCK_MS).toISOString(),
      }),
      readLaunchProjection: () => ({
        jobId: operation.jobId,
        owner: { kind: 'provider-session', id: sessionId },
        sessionId,
        provider: PREPARED.provider,
        projectRoot: '/project',
        backendNamespace: 'tests',
        pool: 'default',
        enqueueSequence: 1,
        createdAt: new Date(WALL_CLOCK_MS).toISOString(),
        jobKind: 'provider',
        providerAction: 'exec',
        request: PREPARED.request,
      }),
    }),
    authorityFor: () => capacityAuthority,
    startupSetRecovery: { recoverSetAtStartup: async () => ({ kind: 'authority', authority: capacityAuthority }) },
    registry,
    materializePrepare: () => ({ state: 'prepared', prepared: PREPARED }),
    recoverLocalJob: async () => undefined,
    completeLocalRecovery: () => {
      localRecoveryCompletions += 1;
    },
    terminalization: {
      terminalize: () => {
        throw new Error('capacity handoff unexpectedly terminalized the job');
      },
    },
    backendNamespace: 'tests',
    time,
  });
  reconciler.start();
  cleanups.push(() => reconciler.stop());
  const route = createAppServerProxyRoute({
    hostManager: { routeAppServerOperation: () => capacityAuthority },
    reconciler,
    now: () => time.now(),
  });

  const placement = await route.activate(
    {
      jobId: operation.jobId,
      operationId: operation.operationId,
      jobLaunchEventSeq: 1,
      sessionId,
      sessionVersion: 1,
      hostSpec: ROTATION_HOST_SPEC,
      provider: PREPARED.provider,
      binding: PREPARED.binding,
      request: PREPARED.request,
      persistedContinuity: null,
      baseEnv: PREPARED.baseEnv,
      protectedEnv: PREPARED.protectedEnv,
      platform: PREPARED.platform,
      childAuthorization: {
        principalWire: {
          subject: 'agent',
          binding: { kind: 'project', root: '/project' },
          attenuatedCaps: ['liveness', 'jobs:read'],
        },
        namespace: 'tests',
        expiresAtMs: WALL_CLOCK_MS + 60_000,
      },
    },
    new AbortController().signal,
  );
  expect(placement).toMatchObject({ kind: 'local-authorized' });
  expect(localRecoveryCompletions).toBe(0);
  await vi.waitFor(() =>
    expect(
      readProviderOperation(db, {
        jobId: operation.jobId,
        operationId: operation.operationId,
        proxyInstanceId: source.proxyInstanceId,
        buildSetId: source.setIdentity.buildSetId,
      }),
    ).toBeNull(),
  );
}

describe('provider proxy activation against a real guardian', () => {
  it('uses the shared schemas at both hops while proxy cancellation releases guardian membership', async () => {
    const set = await startCoordinatorActivationSet();
    const guardianReleaseParses = vi.spyOn(guardianProxyOperationReleaseParamsSchema, 'parse');
    const guardianReleaseResultParses = vi.spyOn(guardianProxyOperationReleaseResultSchema, 'parse');
    const cancelParses = vi.spyOn(proxyOperationCancelParamsSchema, 'parse');
    const cancelResultParses = vi.spyOn(proxyOperationCancelResultSchema, 'parse');
    const operation = {
      jobId: randomUUID(),
      operationId: randomUUID(),
      proxyInstanceId: set.proxyIdentity.proxyInstanceId,
      buildSetId: set.proxyIdentity.buildSetId,
    };
    const prepareRequest = proxyOperationPrepareParamsSchema.parse({
      operation,
      hostFingerprint: FINGERPRINT,
      prepareAttemptNumber: 1,
      prepared: PREPARED,
    });
    const prepared = (await set.proxyControl.call('operation.prepare.v1', prepareRequest, 5_000)) as {
      reservation: string;
      jointContainmentReceipt: string;
      providerRoot: typeof ROOT;
    };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    const cancelRequest = proxyOperationCancelParamsSchema.parse({
      operation,
      prepareAttemptNumber: 1,
      prepareAttemptKey,
    });

    const cancelResult = proxyOperationCancelResultSchema.parse(
      await set.proxyControl.call('operation.cancel.v2', cancelRequest, 5_000),
    );
    expect(cancelResult).toEqual({
      state: 'released-never-started',
      operation,
      prepareAttemptNumber: 1,
      prepareAttemptKey,
    });

    expect(cancelParses).toHaveBeenCalledTimes(2);
    expect(cancelResultParses).toHaveBeenCalledTimes(2);
    expect(guardianReleaseParses).toHaveBeenCalledTimes(2);
    expect(guardianReleaseResultParses).toHaveBeenCalledTimes(2);
    await expect(
      set.control.call(
        'guardian.operation-activate.v1',
        {
          operation,
          reservation: prepared.reservation,
          providerRoot: prepared.providerRoot,
          jointContainmentReceipt: prepared.jointContainmentReceipt,
        },
        5_000,
      ),
    ).rejects.toThrow(/Activation must present/u);
  });

  it('executes coordinator activation through the real clients and both real handlers', async () => {
    const set = await startCoordinatorActivationSet();
    const activationSchemaParses = vi.spyOn(proxyOperationActivateParamsSchema, 'parse');
    const activationResultSchemaParses = vi.spyOn(proxyOperationActivationOutcomeSchema, 'parse');
    const operation = {
      jobId: randomUUID(),
      operationId: randomUUID(),
      proxyInstanceId: set.proxyIdentity.proxyInstanceId,
      buildSetId: set.proxyIdentity.buildSetId,
    };

    const deps = {
      proxyClient: set.proxyControl,
      guardianClient: set.control,
      setIdentity: set.setIdentity,
      mutationRpcTimeoutMs: 5_000,
      faultAuthority: () => undefined,
    };
    const prepared = await prepareProviderOperation(deps, providerOperationPrepareAttempt(deps, operation, PREPARED));
    if (prepared.state !== 'pending-activation') throw new Error('expected a prepared operation');
    const authorized = await authorizeProviderOperation(deps, operation, {
      reservation: prepared.reservation,
      providerRoot: prepared.providerRoot,
      jointContainmentReceipt: prepared.jointContainmentReceipt,
    });
    const result = await activateProviderOperation(deps, operation, {
      reservation: prepared.reservation,
      jointContainmentReceipt: prepared.jointContainmentReceipt,
      jointActivationReceipt: authorized.jointActivationReceipt,
    });

    // The reply says `executing` because the kernel is running — that is what the caller asked and what it
    // gets. The LEDGER is the part that waits: it stays `started-awaiting-publication` until the coordinator
    // has durably committed `executing`, because a provider event delivered before that commit would name a
    // job this coordinator does not yet own, which is the stranded-terminal defect this phase closes.
    // `operation.attach.v1` reports the commit and is what opens delivery.
    expect(result.state).toBe('executing');
    expect(set.started).toEqual([{ jobId: operation.jobId, operationId: operation.operationId, prepared: PREPARED }]);
    expect(set.proxy.ledger().get(operation)).toMatchObject({ state: 'started-awaiting-publication' });

    const attached = await attachProviderOperation(deps, operation, 0);
    expect(attached).toMatchObject({ state: 'attached' });
    expect(set.proxy.ledger().get(operation)).toMatchObject({ state: 'executing' });
    // The same shared schema gates the hand-built payload once before it is written and once in the real
    // proxy handler. Keeping both observations makes bypassing the sender parse fail this test even though a
    // currently valid payload produces identical bytes with or without that parse.
    expect(activationSchemaParses).toHaveBeenCalledTimes(2);
    expect(activationResultSchemaParses).toHaveBeenCalledTimes(2);
  });

  it.each([
    { code: 'identity_mismatch', prepare: false },
    { code: 'operation_not_found', prepare: false },
    { code: 'unauthorized_control', prepare: true },
  ] as const)('keeps real endpoint $code refusal before semantic start', async ({ code, prepare }) => {
    const set = await startCoordinatorActivationSet();
    const { lifecycle, authority } = establishActivationRoute(set.setIdentity);
    const faults: unknown[] = [];
    const deps = {
      proxyClient: set.proxyControl,
      guardianClient: set.control,
      setIdentity: set.setIdentity,
      mutationRpcTimeoutMs: 5_000,
      faultAuthority: (fault: unknown) => {
        faults.push(fault);
        lifecycle.faultAuthority(set.setIdentity);
      },
    };
    const operation = {
      jobId: randomUUID(),
      operationId: randomUUID(),
      proxyInstanceId: code === 'identity_mismatch' ? randomUUID() : set.proxyIdentity.proxyInstanceId,
      buildSetId: code === 'identity_mismatch' ? randomUUID() : set.proxyIdentity.buildSetId,
    };
    let reservation = asReservation(randomUUID());
    let jointContainmentReceipt = asJointContainmentReceipt('unprepared-containment');
    if (prepare) {
      const prepared = await prepareProviderOperation(deps, providerOperationPrepareAttempt(deps, operation, PREPARED));
      if (prepared.state !== 'pending-activation') throw new Error('expected a prepared operation');
      reservation = prepared.reservation;
      jointContainmentReceipt = asJointContainmentReceipt('wrong-containment-receipt');
    }
    let returnedCode: string | null = null;

    try {
      await activateProviderOperation(deps, operation, {
        reservation,
        jointContainmentReceipt,
        jointActivationReceipt: asJointActivationReceipt('unused-activation-receipt'),
      });
    } catch (error: unknown) {
      returnedCode = providerOperationErrorCode(error);
    }

    expect({
      returnedCode,
      semanticStartCalls: set.started.length,
      authorityFaults: faults.length,
      routeAvailable: lifecycle.routeFor('activation-route') === authority,
    }).toEqual({ returnedCode: code, semanticStartCalls: 0, authorityFaults: 0, routeAvailable: true });
  });

  it('faults and removes routing when a raw recordStart failure follows a real semantic start', async () => {
    const set = await startCoordinatorActivationSet();
    const { lifecycle, authority } = establishActivationRoute(set.setIdentity);
    const faults: unknown[] = [];
    const deps = {
      proxyClient: set.proxyControl,
      guardianClient: set.control,
      setIdentity: set.setIdentity,
      mutationRpcTimeoutMs: 5_000,
      faultAuthority: (fault: unknown) => {
        faults.push(fault);
        lifecycle.faultAuthority(set.setIdentity);
      },
    };
    const operation = {
      jobId: randomUUID(),
      operationId: randomUUID(),
      proxyInstanceId: set.proxyIdentity.proxyInstanceId,
      buildSetId: set.proxyIdentity.buildSetId,
    };
    const prepared = await prepareProviderOperation(deps, providerOperationPrepareAttempt(deps, operation, PREPARED));
    if (prepared.state !== 'pending-activation') throw new Error('expected a prepared operation');
    const authorized = await authorizeProviderOperation(deps, operation, {
      reservation: prepared.reservation,
      providerRoot: prepared.providerRoot,
      jointContainmentReceipt: prepared.jointContainmentReceipt,
    });
    const recordStart = vi.spyOn(set.proxy.ledger(), 'recordStart').mockImplementationOnce(() => {
      throw new Error('injected post-start ledger failure');
    });
    const routeBeforeActivation = lifecycle.routeFor('activation-route');
    let returnedCode: string | null = null;

    try {
      await activateProviderOperation(deps, operation, {
        reservation: prepared.reservation,
        jointContainmentReceipt: prepared.jointContainmentReceipt,
        jointActivationReceipt: authorized.jointActivationReceipt,
      });
    } catch (error: unknown) {
      returnedCode = providerOperationErrorCode(error);
    } finally {
      recordStart.mockRestore();
    }

    expect({
      semanticStartCalls: set.started.length,
      returnedCode,
      authorityFaults: faults.length,
      routeBeforeActivation,
      routeAfterFailure: lifecycle.routeFor('activation-route'),
    }).toEqual({
      semanticStartCalls: 1,
      returnedCode: 'protocol_violation',
      authorityFaults: 1,
      routeBeforeActivation: authority,
      routeAfterFailure: null,
    });
  });

  it('forwards the ledger’s own reservation, so a later operation-activate.v1 presenting it is accepted', async () => {
    const { control, guardianChannel, proxyIdentity } = await startGuardianAndReaper();

    // What `operation.prepare.v1` would have already done to the proxy's own ledger before ever calling
    // `stageProviderRoot`: minted a reservation and stored it. This is that same real ledger, not a hand-built
    // stand-in, and `reserved.entry` is exactly what `proxy.ts`'s own handler passes into `stageProviderRoot`.
    const ledger = createOperationLedger<ProxyPreparedAppServerOperation>();
    const key = { jobId: randomUUID(), operationId: randomUUID() };
    const reservation = asReservation(randomUUID());
    const reserved = ledger.prepare({ key, reservation, prepared: PREPARED, nowMs: 0 });
    if (reserved.kind !== 'reserved') throw new Error('unexpected capacity refusal in a fresh ledger');

    const containment = createProxyGuardianContainment({
      identity: proxyIdentity,
      guardianChannel,
      // The one dependency replaced: a canned root instead of spawning a real provider process.
      stageProviderRoot: () => ({
        result: Promise.resolve({ state: 'staged', providerRoot: ROOT }),
        abortAndRelease: async () => {},
      }),
    });

    const stage = containment.stageProviderRoot(key, {
      reservation: reserved.entry.reservation,
      prepared: reserved.entry.prepared,
    });
    const staged = await stage.result;
    if (staged.state !== 'staged') throw new Error('expected staged containment');
    expect(staged.providerRoot).toEqual(ROOT);

    // The coordinator's own reservation: exactly the value `operation.prepare.v1` would have echoed back from
    // this same ledger entry — not one this test invents separately. Before the fix, `stageProviderRoot`
    // forwarded a freshly minted value to the guardian instead of this one, so the guardian's stored
    // membership could never agree with what is presented here.
    const activated = (await control.call(
      'guardian.operation-activate.v1',
      {
        operation: {
          jobId: key.jobId,
          operationId: key.operationId,
          proxyInstanceId: proxyIdentity.proxyInstanceId,
          buildSetId: proxyIdentity.buildSetId,
        },
        reservation,
        providerRoot: ROOT,
        jointContainmentReceipt: asJointContainmentReceipt(staged.receipt),
      },
      5_000,
    )) as { state: string; jointActivationReceipt: string };

    expect(activated.state).toBe('activation-authorized');

    // The full local half of activation also succeeds against what this containment wiring itself recognised
    // as staged — the last step `operation.activate.v1` performs before starting the kernel.
    await expect(
      stage.confirmActivation({
        jointContainmentReceipt: asJointContainmentReceipt(staged.receipt),
        jointActivationReceipt: asJointActivationReceipt(activated.jointActivationReceipt),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('provider proxy cancellation relinquishment against a real guardian pairing', () => {
  it('closes only the proxy pairing on unconfirmed cancellation while coordinator heartbeats remain live', async () => {
    const set = await startGuardianAndReaper();
    const hostRef: HostRef = {
      provider: PREPARED.provider,
      fingerprint: FINGERPRINT,
      instanceId: 'shared-unconfirmed-host',
      leaseMode: 'shared',
    };
    const bound = {
      name: PREPARED.provider,
      envelope: PREPARED.binding,
      present: () => {
        throw new Error('unconfirmed interaction unexpectedly presented the provider');
      },
      readiness: () => {
        throw new Error('unconfirmed interaction unexpectedly checked readiness');
      },
      compareIdentity: () => {
        throw new Error('unconfirmed interaction unexpectedly compared identity');
      },
      decodeContinuity: () => {
        throw new Error('unconfirmed interaction unexpectedly decoded continuity');
      },
      preflight: () => {
        throw new Error('unconfirmed interaction unexpectedly ran preflight');
      },
      prepareExecution: () => ({
        kind: 'app-server' as const,
        hostSpec: { ...ROTATION_HOST_SPEC, leaseMode: 'shared' as const, idleRetirement: 'none' as const },
        execute: async function* (executionRuntime: { signal: AbortSignal; onHostRef(ref: HostRef): void }) {
          executionRuntime.onHostRef(hostRef);
          await new Promise<void>((resolve) => {
            if (executionRuntime.signal.aborted) resolve();
            else executionRuntime.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { kind: 'suspended' as const, reason: 'interrupt_unconfirmed' };
        },
      }),
      appServer: {
        supportsInterrupt: true,
        supportsProbe: false,
        openReplacement: async () => ({ hostRef, close: () => {} }),
        interrupt: async () => ({ kind: 'not-accepted' as const, reason: 'test refusal' }),
        probe: async () => {
          throw new Error('unconfirmed interaction unexpectedly probed the provider');
        },
      },
      artifacts: { kind: 'none' as const, reason: 'unconfirmed cancellation integration provider' },
    } as unknown as BoundProvider;
    rotationDoubles.rehydrateBinding.mockReturnValue({ ok: true, value: bound });
    const hostAuthority: ProxyAppServerHostAuthority = {
      beginOperation: () => ({
        selectCancellationMode: () => {},
        openSession: async () => {
          throw new Error('unconfirmed interaction unexpectedly opened another host');
        },
        attachSession: async () => null,
      }),
      rootIdentity: () => ({ pid: 7_777, processStartedAtSeconds: 777 }),
      closed: () => new Promise<Error | void>(() => {}),
      forceClose: async () => {
        throw new Error('shared unconfirmed cancellation force-closed one operation');
      },
    };
    const ledger = createOperationLedger<ProxyPreparedAppServerOperation>();
    const proxy = {
      listen: async () => {},
      close: async () => {},
      ledger: () => ledger,
      emitProviderEvent: () => ({ kind: 'recorded' as const, providerSeq: 1 }),
    } as ReturnType<typeof createProxy>;
    let resolvePairingClosed!: () => void;
    const pairingClosed = new Promise<void>((resolve) => {
      resolvePairingClosed = resolve;
    });
    const semantic = createSemanticOperationRuntime({
      runtime: createRealRuntime('prod'),
      hostAuthority,
      getProxy: () => proxy,
      onRelinquish: () => {
        set.guardianChannel.close();
        resolvePairingClosed();
      },
    });
    const key = { jobId: randomUUID(), operationId: randomUUID() };
    const staged = await semantic.ensureProviderRoot(key, PREPARED);
    if (staged.state !== 'staged') throw new Error(`unconfirmed interaction stage returned ${staged.state}`);
    const started = semantic.host.start({ key, prepared: PREPARED });
    await started.result;

    const liveHeartbeat = (await set.control.call(
      'guardian.heartbeat.v1',
      {
        controlEpoch: set.guardianControlEpoch,
        heartbeatChallenge: set.guardianHeartbeatChallenge,
      },
      5_000,
    )) as { state: string; nextHeartbeatChallenge: string };
    expect(liveHeartbeat.state).toBe('active');
    await expect(semantic.host.stop({ key, cause: 'restart' })).rejects.toMatchObject({
      code: 'semantic_operation_cancellation_unconfirmed',
    });

    await pairingClosed;
    await expect(
      set.control.call(
        'guardian.heartbeat.v1',
        {
          controlEpoch: set.guardianControlEpoch,
          heartbeatChallenge: liveHeartbeat.nextHeartbeatChallenge,
        },
        5_000,
      ),
    ).resolves.toMatchObject({ state: 'active' });
    await expect(set.guardianChannel.call('guardian.operation-release.v2', {}, 5_000)).rejects.toThrow(
      /closed|write|socket/u,
    );
  });
});

describe('provider proxy cumulative root rotation', () => {
  it('rotates after 127 distinct sequential roots and gives every one of 129 jobs exactly one owner (C3-M6)', async () => {
    const operationRegistry = new LocalOperationRegistry();
    const runtime = createRealRuntime('prod');
    const rootHandles: Array<ReturnType<typeof createFakeProviderServerHandle>> = [];
    const builtSets: RotationSet[] = [];
    const rotationOrder: string[] = [];
    const owners: Array<Readonly<{ jobId: string; owner: 'proxy' | 'local'; setId: string }>> = [];
    const proxyRootIdentities = new Set<string>();
    let nextRootPid = 20_000;
    let activeProxyOperations = 0;
    let maximumActiveProxyOperations = 0;

    rotationDoubles.probeProcessStartedAtSeconds.mockImplementation((pid: number) =>
      pid >= 20_000 ? pid + 100_000 : undefined,
    );
    rotationDoubles.spawnProviderRoot.mockImplementation(async () => {
      const handle = createFakeProviderServerHandle({ generation: nextRootPid++ });
      rootHandles.push(handle);
      return handle.handle;
    });
    rotationDoubles.rehydrateBinding.mockImplementation((_binding: unknown, authority: unknown) => {
      if (authority === null) throw new Error('rotation provider was rehydrated before host authority connection');
      return { ok: true, value: rotationBoundProvider(authority as AppServerHostAuthority) };
    });

    let resolveFreshSet!: (set: RotationSet) => void;
    const freshSetBuilt = new Promise<RotationSet>((resolve) => {
      resolveFreshSet = resolve;
    });
    const factories = [
      async () => startRotationSet(operationRegistry),
      async () => startRotationSet(operationRegistry),
    ];
    rotationDoubles.ensureProxySet.mockImplementation(
      (
        _entry: unknown,
        _environment: unknown,
        onSettled: (outcome: Readonly<{ kind: 'acquired'; set: RotationSet['authority'] }>) => void,
      ) => {
        const factory = factories.shift();
        if (factory === undefined) throw new Error('coordinator attempted to acquire a third rotation set');
        void factory().then(
          (set) => {
            const isFirst = builtSets.length === 0;
            builtSets.push(set);
            const authority = isFirst
              ? {
                  ...set.authority,
                  stopAndReap: async (signal: AbortSignal) => {
                    const outcome = await set.authority.stopAndReap(signal);
                    if ('disappearanceReceipt' in outcome) rotationOrder.push('joint-absence');
                    return outcome;
                  },
                }
              : set.authority;
            if (!isFirst) {
              rotationOrder.push('fresh-set-spawn');
              resolveFreshSet(set);
            }
            onSettled({ kind: 'acquired', set: authority });
          },
          (error: unknown) => {
            throw error;
          },
        );
      },
    );

    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const lifecycle = new ProviderProxySetLifecycle({
      claims,
      controlEstablished: () => undefined,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: runtime.time,
      proveContainmentAbsent: async () => null,
      retireCapsule: () => ({ kind: 'retired' }),
      rewriteCapsule: () => undefined,
      onFatal: (error) => {
        throw error;
      },
      onSlotReleased: (routeKey) => manager.providerProxySlotReleased(routeKey),
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const providerProxyLifecycleRef = new ProviderProxySetLifecycleRef();
    providerProxyLifecycleRef.connect(lifecycle);

    const localHandle = createFakeProviderServerHandle({ generation: 9_000 });
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: async () => localHandle.handle,
      proxySetAcquisition: {
        pluginRoot: '/plugin',
        identity: { instanceId: randomUUID(), buildSetId: randomUUID(), flavor: 'prod' },
        operationRegistry,
      },
      providerProxyLifecycleRef,
    });

    const prepare = async (authority: RotationSet['authority'], jobId: string, operationId: string) => {
      const operation = {
        jobId,
        operationId,
        proxyInstanceId: authority.proxyInstanceId,
        buildSetId: authority.setIdentity.buildSetId,
      };
      const attempt = providerOperationPrepareAttempt({ setIdentity: authority.setIdentity }, operation, PREPARED);
      activeProxyOperations += 1;
      maximumActiveProxyOperations = Math.max(maximumActiveProxyOperations, activeProxyOperations);
      const result = await authority.prepareOperation(attempt);
      return { operation, attempt, result };
    };
    const releasePrepared = async (
      authority: RotationSet['authority'],
      prepared: Awaited<ReturnType<typeof prepare>>,
    ): Promise<void> => {
      if (prepared.result.state !== 'pending-activation') {
        activeProxyOperations -= 1;
        return;
      }
      proxyRootIdentities.add(
        `${prepared.result.providerRoot.pid}@${prepared.result.providerRoot.processStartedAtSeconds}`,
      );
      await authority.cancelOperation(
        prepared.operation,
        prepared.attempt.request.prepareAttemptNumber,
        prepared.attempt.prepareAttemptKey,
      );
      activeProxyOperations -= 1;
      const latestHandle = rootHandles.at(-1);
      if (latestHandle === undefined) throw new Error('proxy admitted an operation without spawning its root');
      await vi.waitFor(() => expect(latestHandle.closeMock).toHaveBeenCalledOnce());
    };

    try {
      const bootstrap = await manager.openSession(ROTATION_HOST_SPEC, { jobId: 'rotation-bootstrap' });
      bootstrap.close();
      await vi.waitFor(() => expect(builtSets).toHaveLength(1));
      let authority = manager.routeAppServerOperation(ROTATION_HOST_SPEC);
      if (authority === null || !isProviderProxyOperationAuthority(authority)) {
        throw new Error('first proxy set did not enter durable coordinator routing');
      }
      const firstSet = builtSets[0];
      if (firstSet === undefined) throw new Error('first proxy set was not captured');

      for (let index = 1; index <= 127; index += 1) {
        const jobId = randomUUID();
        const operationId = randomUUID();
        const prepared = await prepare(authority, jobId, operationId);
        expect(prepared.result.state).toBe('pending-activation');
        await releasePrepared(authority, prepared);
        owners.push({ jobId, owner: 'proxy', setId: authority.proxyInstanceId });
        expect(firstSet.guardian.enforcer()?.recordedRoots()).toHaveLength(index);
        expect(firstSet.reaper.enforcer()?.recordedRoots()).toHaveLength(index);
        expect(activeProxyOperations).toBe(0);
      }

      const capacityJob = { jobId: randomUUID(), operationId: randomUUID() };
      const capacityPrepared = await prepare(authority, capacityJob.jobId, capacityJob.operationId);
      await releasePrepared(authority, capacityPrepared);

      if (capacityPrepared.result.state === 'pending-activation') {
        owners.push({ jobId: capacityJob.jobId, owner: 'proxy', setId: authority.proxyInstanceId });
        expect(firstSet.guardian.enforcer()?.recordedRoots()).toHaveLength(128);
        expect(firstSet.reaper.enforcer()?.recordedRoots()).toHaveLength(128);

        const refusedJob = { jobId: randomUUID(), operationId: randomUUID() };
        let refused = false;
        try {
          const refusedPrepared = await prepare(authority, refusedJob.jobId, refusedJob.operationId);
          refused = refusedPrepared.result.state !== 'pending-activation';
          await releasePrepared(authority, refusedPrepared);
        } catch {
          activeProxyOperations -= 1;
          refused = true;
        }
        if (refused) {
          await vi.waitFor(() =>
            expect(rootHandles.every((handle) => handle.closeMock.mock.calls.length > 0)).toBe(true),
          );
          throw new Error(
            'C3-M6 live-only mutation: operation 129 returned root-cap refusal on the original set while live operations equal 0',
          );
        }
        throw new Error('generation gate mutation admitted a 129th root beyond both enforcers’ hard cap');
      }

      if (capacityPrepared.result.state !== 'capacity') {
        throw new Error(`operation 128 returned unexpected ${capacityPrepared.result.state} admission state`);
      }
      expect(capacityPrepared.result).toMatchObject({
        state: 'capacity',
        code: 'provider_root_generation_draining',
      });
      await completeCapacityLocalHandoff(authority, capacityPrepared.result, capacityJob);
      owners.push({ jobId: capacityJob.jobId, owner: 'local', setId: authority.proxyInstanceId });

      let freshSet: RotationSet | null = null;
      let freshTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        freshSet = await Promise.race([
          freshSetBuilt,
          new Promise<null>((resolve) => {
            freshTimeout = setTimeout(() => resolve(null), 2_000);
          }),
        ]);
      } finally {
        if (freshTimeout !== undefined) clearTimeout(freshTimeout);
      }
      if (freshSet === null) {
        const sameSet = manager.routeAppServerOperation(ROTATION_HOST_SPEC);
        if (sameSet === null || !isProviderProxyOperationAuthority(sameSet)) {
          throw new Error('rotation was suppressed but the original set disappeared from durable routing');
        }
        const laterJob = { jobId: randomUUID(), operationId: randomUUID() };
        const later = await prepare(sameSet, laterJob.jobId, laterJob.operationId);
        await releasePrepared(sameSet, later);
        if (later.result.state === 'capacity' && later.result.code === 'provider_root_generation_draining') {
          throw new Error(
            `C3-M6 no-rotation mutation: operations 128..129 returned provider_root_generation_draining and proxy set ID remained ${sameSet.proxyInstanceId}`,
          );
        }
        throw new Error('rotation was suppressed without preserving the generation-draining capacity result');
      }

      await vi.waitFor(() => {
        const routed = manager.routeAppServerOperation(ROTATION_HOST_SPEC);
        expect(routed?.proxyInstanceId).toBe(freshSet?.authority.proxyInstanceId);
      });
      authority = manager.routeAppServerOperation(ROTATION_HOST_SPEC);
      if (authority === null || !isProviderProxyOperationAuthority(authority)) {
        throw new Error('fresh proxy set did not enter durable coordinator routing');
      }
      const finalJob = { jobId: randomUUID(), operationId: randomUUID() };
      const finalPrepared = await prepare(authority, finalJob.jobId, finalJob.operationId);
      expect(finalPrepared.result.state).toBe('pending-activation');
      await releasePrepared(authority, finalPrepared);
      owners.push({ jobId: finalJob.jobId, owner: 'proxy', setId: authority.proxyInstanceId });

      expect(owners).toHaveLength(129);
      expect(new Set(owners.map(({ jobId }) => jobId)).size).toBe(129);
      expect(owners.filter(({ owner }) => owner === 'local')).toHaveLength(1);
      expect(new Set(owners.filter(({ owner }) => owner === 'proxy').map(({ setId }) => setId)).size).toBe(2);
      expect(proxyRootIdentities.size).toBe(128);
      expect(rootHandles).toHaveLength(128);
      expect(rootHandles.every((handle) => handle.closeMock.mock.calls.length === 1)).toBe(true);
      expect(firstSet.guardian.enforcer()?.recordedRoots()).toHaveLength(127);
      expect(firstSet.reaper.enforcer()?.recordedRoots()).toHaveLength(127);
      expect(freshSet.guardian.enforcer()?.recordedRoots()).toHaveLength(1);
      expect(freshSet.reaper.enforcer()?.recordedRoots()).toHaveLength(1);
      expect(
        builtSets.every(
          (set) =>
            (set.guardian.enforcer()?.recordedRoots().length ?? 0) <= 128 &&
            (set.reaper.enforcer()?.recordedRoots().length ?? 0) <= 128,
        ),
      ).toBe(true);
      expect(rotationOrder).toEqual(['joint-absence', 'fresh-set-spawn']);
      expect(maximumActiveProxyOperations).toBe(1);
      expect(activeProxyOperations).toBe(0);
    } finally {
      await manager.shutdown();
    }
  }, 30_000);
});
