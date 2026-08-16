import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#src/provider-proxy/handoff-capsule.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, readHandoffCapsuleFile: vi.fn() };
});

vi.mock('#src/provider-proxy/role-spawn.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, connectRoleControlWithRetry: vi.fn() };
});

vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    probeProcessIncarnation: vi.fn(() => 'linux:00000000-0000-4000-8000-000000000000:1700000000' as ProcessIncarnation),
  };
});

import {
  readHandoffCapsuleFile,
  CURRENT_HANDOFF_CAPSULE_VERSION,
  type HandoffCapsule,
  type HandoffCapsuleV2,
  type HandoffCapsuleV3,
} from '#src/provider-proxy/handoff-capsule.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { connectControlClient, ControlClientError } from '#src/provider-proxy/control-client.js';
import { createControlEndpoint, type ControlChallengeAuthority } from '#src/provider-proxy/control-endpoint.js';
import { ControlLeaseEvidence } from '#src/provider-proxy/control-lease.js';
import { PROXY_CONTROL_HEARTBEAT_MS, PROXY_CONTROL_LEASE_MS } from '#src/provider-proxy/orphan-deadline.js';
import { createProxy } from '#src/provider-proxy/proxy.js';
import { connectRoleControlWithRetry, runtimeControlTimer } from '#src/provider-proxy/role-spawn.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  attemptProviderProxySetInheritance,
  createProviderProxySetInheritance,
  type ProviderProxySetLocator,
} from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import {
  isProviderProxyOperationAuthority,
  notifyProviderProxyControlEstablished,
  subscribeProviderProxyControlEstablished,
  type ProviderProxyOperationAuthority,
} from '#src/coordinator/live/provider-proxy/operation-route.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';

/** The build this fixture lifecycle belongs to — the same one `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';

const mockedReadCapsule = vi.mocked(readHandoffCapsuleFile);
const mockedConnect = vi.mocked(connectRoleControlWithRetry);
const mockedProbe = vi.mocked(probeProcessIncarnation);

// Call history, not implementations, so `mockedProbe`'s default `1_700_000_000` (set in the `vi.mock` factory
// above) survives — only each test's own explicit `.mockReturnValueOnce`/`.mockResolvedValueOnce` setup and
// this shared `.not.toHaveBeenCalled()`-style assertions must not see a sibling test's earlier calls.
const runtime = createRealRuntime('prod');
const unusedDb = {} as Database;
// Every test in this file drives one redemption attempt to completion synchronously (fake clients settle
// immediately), so a signal that never aborts exercises exactly the same path the never-aborted case in
// production takes; the abort/deadline-checkpoint behavior itself is covered separately.
const neverAborts = new AbortController().signal;

const GUARDIAN_INSTANCE_ID = randomUUID();
const REAPER_INSTANCE_ID = randomUUID();
const PROXY_INSTANCE_ID = randomUUID();
const BUILD_SET_ID = randomUUID();
const HOST_FINGERPRINT = 'a'.repeat(64);

/** Every `establishes-control` reply is `{ ...fields, controlEpoch, heartbeatChallenge }` on the wire
 *  (`control-endpoint.ts`'s own `establishControl`); every fake "open" response below spreads this in. */
const OPENING = { controlEpoch: 1, heartbeatChallenge: 'first-challenge' };

function locator(operationOverrides: Partial<ProviderOperationRecord['operation']> = {}): ProviderProxySetLocator {
  const proxyInstanceId = operationOverrides.proxyInstanceId ?? PROXY_INSTANCE_ID;
  return {
    operation: {
      jobId: randomUUID(),
      operationId: randomUUID(),
      proxyInstanceId,
      buildSetId: BUILD_SET_ID,
      ...operationOverrides,
    },
    locator: {
      hostFingerprint: HOST_FINGERPRINT,
      guardian: {
        instanceId: GUARDIAN_INSTANCE_ID,
        pid: 100,
        incarnation: testIncarnation(1),
        controlEndpoint: '/tmp/guardian.sock',
      },
      proxy: {
        instanceId: proxyInstanceId,
        pid: 200,
        incarnation: testIncarnation(3),
        controlEndpoint: '/tmp/proxy.sock',
      },
      reaper: {
        instanceId: REAPER_INSTANCE_ID,
        pid: 300,
        incarnation: testIncarnation(2),
        controlEndpoint: '/tmp/reaper.sock',
      },
      containment: { pid: 200, incarnation: testIncarnation(3), processGroupId: 200, kind: 'posix-group' },
    },
  };
}

function alternateLocator(reference: ProviderProxySetLocator): ProviderProxySetLocator {
  return {
    operation: {
      ...reference.operation,
      jobId: randomUUID(),
      operationId: randomUUID(),
    },
    locator: {
      hostFingerprint: 'b'.repeat(64),
      guardian: {
        instanceId: randomUUID(),
        pid: 400,
        incarnation: testIncarnation(4),
        controlEndpoint: '/tmp/guardian-b.sock',
      },
      proxy: {
        instanceId: reference.operation.proxyInstanceId,
        pid: 500,
        incarnation: testIncarnation(5),
        controlEndpoint: '/tmp/proxy-b.sock',
      },
      reaper: {
        instanceId: randomUUID(),
        pid: 600,
        incarnation: testIncarnation(6),
        controlEndpoint: '/tmp/reaper-b.sock',
      },
      containment: { pid: 500, incarnation: testIncarnation(5), processGroupId: 500, kind: 'posix-group' },
    },
  };
}

function proofRecord(
  reference: ProviderProxySetLocator,
  providerRoot: Readonly<{ pid: number; incarnation: ProcessIncarnation }>,
): ProviderOperationRecord {
  return providerOperationRecordSchema.parse({
    ...providerOperationRecord('guardian-activation-pending', {
      operation: {
        ...reference.operation,
        jobId: randomUUID(),
        operationId: randomUUID(),
      },
      locator: reference.locator,
    }),
    providerRoot,
  });
}

function proofDatabase(records: readonly ProviderOperationRecord[]): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  for (const record of records) insertProviderOperation(db, record);
  return db;
}

function proofRuntime(liveProcesses: ReadonlyMap<number, ProcessIncarnation>) {
  const live = new Map(liveProcesses);
  const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  const base = createRealRuntime('prod');
  const proofRuntime = {
    ...base,
    process: {
      ...base.process,
      isAlive: (pid: number) => live.has(pid),
      kill: (pid: number, signal: NodeJS.Signals | 0) => {
        signals.push({ pid, signal });
        live.delete(pid);
        if (pid < 0) live.delete(-pid);
        return true;
      },
    },
  };
  mockedProbe.mockImplementation((pid) => live.get(pid) ?? null);
  return { runtime: proofRuntime, live, signals };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedProbe.mockImplementation(() => testIncarnation(1_700_000_000));
});

// The current generation, because that is the only one this build may inherit: a capsule whose identity it
// cannot read is represented and never dialed, whatever the number on it.
function capsuleFor(reference: ProviderProxySetLocator, overrides: Partial<HandoffCapsuleV3> = {}): HandoffCapsule {
  const { operation, locator: set } = reference;
  return {
    version: CURRENT_HANDOFF_CAPSULE_VERSION,
    guardianPid: set.guardian.pid,
    guardianIncarnation: set.guardian.incarnation,
    reaperPid: set.reaper.pid,
    reaperIncarnation: set.reaper.incarnation,
    proxyPid: set.proxy.pid,
    proxyIncarnation: set.proxy.incarnation,
    proxyProcessGroupId: set.containment.processGroupId,
    containmentKind: set.containment.kind,
    grantId: randomUUID(),
    secret: 'f'.repeat(64),
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: operation.buildSetId,
    hostFingerprint: set.hostFingerprint,
    guardianInstanceId: set.guardian.instanceId,
    reaperInstanceId: set.reaper.instanceId,
    proxyInstanceId: operation.proxyInstanceId,
    guardianControlEndpoint: set.guardian.controlEndpoint,
    reaperControlEndpoint: set.reaper.controlEndpoint,
    proxyEndpoint: set.proxy.controlEndpoint,
    orphanTimeoutMs: 30_000,
    teardownReserveMs: 14_000,
    ...overrides,
  };
}

const COORDINATOR_IDENTITY = {
  instanceId: randomUUID(),
  pid: 1,
  incarnation: testIncarnation(900),
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: BUILD_SET_ID,
};

type OperationKey = { jobId: string; operationId: string; proxyInstanceId: string; buildSetId: string };

function operationFor(reference: ProviderProxySetLocator, overrides: Partial<OperationKey> = {}): OperationKey {
  return {
    ...reference.operation,
    ...overrides,
  };
}

function byteSorted(operations: readonly OperationKey[]): OperationKey[] {
  return [...operations].sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
}

/** Method-dispatched fake `ControlClient`, shared across all three role connects — the wire methods this
 *  redemption calls (`guardian.handoff-redeem.v1`, `reaper.handoff-rotate.v1`, `handoff.redeem.v1`, and
 *  `*.heartbeat.v1`) never collide across roles, so one responder
 *  keyed by method name stands in for three distinct sockets. */
function fakeClient(
  responses: Record<string, unknown | ((params: unknown) => unknown)>,
  calls: { method: string; params: unknown }[],
  close: () => void = () => {},
): ControlClient {
  const faulted = new Promise<never>(() => undefined);
  return {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      const entry = responses[method];
      if (entry === undefined) throw new Error(`unexpected call to ${method}`);
      return typeof entry === 'function' ? (entry as (p: unknown) => unknown)(params) : entry;
    },
    faulted,
    onFault: () => () => undefined,
    close,
  };
}

function faultableClient(
  responses: Record<string, unknown | ((params: unknown) => unknown)>,
  calls: { method: string; params: unknown }[],
) {
  let latchedFault: ControlClientError | null = null;
  let resolveFault!: (error: ControlClientError) => void;
  const listeners = new Set<(error: ControlClientError) => void>();
  const faulted = new Promise<ControlClientError>((resolve) => {
    resolveFault = resolve;
  });
  const client: ControlClient = {
    call: async (method, params) => {
      calls.push({ method, params });
      const entry = responses[method];
      if (entry === undefined) throw new Error(`unexpected call to ${method}`);
      return typeof entry === 'function' ? (entry as (value: unknown) => unknown)(params) : entry;
    },
    faulted,
    onFault(listener) {
      if (latchedFault !== null) {
        listener(latchedFault);
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => undefined,
  };
  return {
    client,
    fault(error: ControlClientError) {
      if (latchedFault !== null) return;
      latchedFault = error;
      resolveFault(error);
      for (const listener of listeners) listener(error);
    },
  };
}

async function guardianLeaseClient(
  time: VirtualTime,
  openResponse: Record<string, unknown>,
): Promise<
  Readonly<{
    client: ControlClient;
    acceptedEchoes(): number;
    controlIsLive(): boolean;
    close(): Promise<void>;
  }>
> {
  const socketPath = `/tmp/coral-inheritance-heartbeat-${randomUUID()}.sock`;
  const scope = Symbol('inheritance-heartbeat');
  const clock = createMonotonicClock(scope, { readMilliseconds: () => BigInt(time.now()) });
  const lease = new ControlLeaseEvidence(clock, PROXY_CONTROL_LEASE_MS, clock.now(), () => null);
  let challengeNumber = 0;
  let acceptedEchoes = 0;
  const mintChallenge = () => `inheritance-challenge-${challengeNumber++}`;
  const challenges: ControlChallengeAuthority = {
    issueFirstChallenge: () => {
      const challenge = mintChallenge();
      return lease.issueFirstChallenge(challenge, clock.now(), 'recurring')
        ? { accepted: true, challenge }
        : { accepted: false, reason: 'already-issued' };
    },
    admitSuccessor: () => ({ accepted: false, reason: 'not-used' }),
    reattachControl: () => ({ accepted: true }),
    controlIsLive: () => lease.isControlLive(clock.now()),
    echoChallenge: (challenge) => {
      const nextChallenge = mintChallenge();
      const result = lease.echoChallenge(clock.now(), challenge, nextChallenge);
      if (!result.accepted) return result;
      acceptedEchoes += 1;
      return { accepted: true, nextChallenge };
    },
  };
  const endpoint = createControlEndpoint({
    socketPath,
    role: {
      heartbeatMethod: 'guardian.heartbeat.v1',
      methods: new Map([
        [
          'role.open.v1',
          { authority: 'establishes-control' as const, handle: async () => ({ holder: 'coordinator', fields: {} }) },
        ],
      ]),
    },
    challenges,
    observer: { onControlLost: () => undefined },
    timer: time,
    requestTimeoutMs: 5_000,
  });
  await endpoint.listen();
  const realClient = await connectControlClient(socketPath, time, 5_000);
  const opened = (await realClient.call('role.open.v1', {}, 5_000)) as {
    controlEpoch: number;
    heartbeatChallenge: string;
  };
  const client: ControlClient = {
    call: (method, params, timeoutMs) =>
      method === 'guardian.handoff-redeem.v1'
        ? Promise.resolve({
            ...openResponse,
            controlEpoch: opened.controlEpoch,
            heartbeatChallenge: opened.heartbeatChallenge,
          })
        : realClient.call(method, params, timeoutMs),
    faulted: realClient.faulted,
    onFault: (listener) => realClient.onFault(listener),
    close: () => realClient.close(),
  };
  const watchdog = time.setInterval(() => {
    if (!lease.isControlLive(clock.now())) void endpoint.close();
  }, 1_000);
  return {
    client,
    acceptedEchoes: () => acceptedEchoes,
    controlIsLive: () => lease.isControlLive(clock.now()),
    close: async () => {
      time.clearInterval(watchdog);
      realClient.close();
      await endpoint.close();
    },
  };
}

async function advanceInheritanceEndpointClock(
  time: VirtualTime,
  durationMs: number,
  heartbeatOriginMs: number,
  acceptedEchoes: () => number,
): Promise<void> {
  let remaining = durationMs;
  while (remaining > 0) {
    const step = Math.min(1_000, remaining);
    time.tick(step);
    remaining -= step;
    const expectedEchoes = 1 + Math.floor((time.now() - heartbeatOriginMs) / PROXY_CONTROL_HEARTBEAT_MS);
    if (acceptedEchoes() < expectedEchoes) {
      await vi.waitFor(() => expect(acceptedEchoes()).toBe(expectedEchoes));
    }
  }
}

function stubConnect(client: ControlClient): void {
  mockedConnect.mockImplementation(async () => client);
}

function proxyIdentityFieldsFor(reference: ProviderProxySetLocator) {
  const { operation, locator: set } = reference;
  return {
    proxyInstanceId: operation.proxyInstanceId,
    pid: set.proxy.pid,
    incarnation: set.proxy.incarnation,
    processGroupId: set.containment.processGroupId,
    guardianInstanceId: set.guardian.instanceId,
    reaperInstanceId: set.reaper.instanceId,
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId: operation.buildSetId,
    hostFingerprint: set.hostFingerprint,
    canonicalEndpoint: set.proxy.controlEndpoint,
  };
}

function guardianIdentityFor(reference: ProviderProxySetLocator) {
  const { operation, locator: set } = reference;
  return {
    guardianInstanceId: set.guardian.instanceId,
    pid: set.guardian.pid,
    incarnation: set.guardian.incarnation,
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId: operation.buildSetId,
    hostFingerprint: set.hostFingerprint,
    canonicalControlEndpoint: set.guardian.controlEndpoint,
  };
}

function reaperIdentityFor(reference: ProviderProxySetLocator) {
  const { operation, locator: set } = reference;
  return {
    reaperInstanceId: set.reaper.instanceId,
    pid: set.reaper.pid,
    incarnation: set.reaper.incarnation,
    guardianInstanceId: set.guardian.instanceId,
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId: operation.buildSetId,
    hostFingerprint: set.hostFingerprint,
    canonicalControlEndpoint: set.reaper.controlEndpoint,
    containmentKind: set.containment.kind,
  };
}

function containmentFor(reference: ProviderProxySetLocator) {
  return {
    pid: reference.locator.containment.pid,
    incarnation: reference.locator.containment.incarnation,
    processGroupId: reference.locator.containment.processGroupId,
    containmentKind: reference.locator.containment.kind,
  };
}

type RedemptionOperationSets = Readonly<{
  guardian: readonly OperationKey[];
  reaper: readonly OperationKey[];
  proxy: readonly OperationKey[];
}>;

function matchingOperationSets(operations: readonly OperationKey[]): RedemptionOperationSets {
  return {
    guardian: operations.map((operation) => ({ ...operation })),
    reaper: operations.map((operation) => ({ ...operation })),
    proxy: operations.map((operation) => ({ ...operation })),
  };
}

/** The three "open" replies a full, successful redemption needs, keyed exactly as `fakeClient` dispatches. */
function redemptionResponses(
  loc: ProviderProxySetLocator,
  operationSets: RedemptionOperationSets,
  overrides: Record<string, unknown | ((params: unknown) => unknown)> = {},
): Record<string, unknown | ((params: unknown) => unknown)> {
  return {
    'guardian.handoff-redeem.v1': {
      ...OPENING,
      state: 'redeemed-provisional',
      redemptionReceipt: 'guardian-receipt',
      operations: operationSets.guardian,
      guardian: guardianIdentityFor(loc),
      reaper: reaperIdentityFor(loc),
      containment: containmentFor(loc),
    },
    'guardian.heartbeat.v1': { state: 'active', nextHeartbeatChallenge: 'g2' },
    'reaper.handoff-rotate.v1': {
      ...OPENING,
      state: 'successor-rotated',
      reaperRotationReceipt: 'reaper-receipt',
      operations: operationSets.reaper,
      reaper: reaperIdentityFor(loc),
    },
    'reaper.heartbeat.v1': { state: 'active', nextHeartbeatChallenge: 'r2' },
    'handoff.redeem.v1': {
      ...OPENING,
      state: 'redeemed-provisional',
      redemptionReceipt: 'proxy-receipt',
      proxy: proxyIdentityFieldsFor(loc),
      operations: operationSets.proxy,
    },
    'control.heartbeat.v1': { state: 'active', nextHeartbeatChallenge: 'p2' },
    ...overrides,
  };
}

async function startRegisteredProxy(
  reference: ProviderProxySetLocator,
  capsule: HandoffCapsule,
  installedOperations: readonly OperationKey[],
  registeredOperations: readonly OperationKey[],
): Promise<Readonly<{ connect(): Promise<ControlClient>; close(): Promise<void> }>> {
  let clockMs = 0n;
  const timer = runtimeControlTimer(runtime);
  const bootstrapNonce = 'b'.repeat(64);
  const proxy = createProxy({
    capsule: {
      role: 'proxy',
      generation: capsule.generation,
      flavor: capsule.flavor,
      buildSetId: capsule.buildSetId,
      hostFingerprint: capsule.hostFingerprint,
      guardianInstanceId: capsule.guardianInstanceId,
      reaperInstanceId: capsule.reaperInstanceId,
      proxyInstanceId: capsule.proxyInstanceId,
      bootstrapNonce,
      canonicalEndpoint: capsule.proxyEndpoint,
      guardianControlEndpoint: capsule.guardianControlEndpoint,
      proxyGuardianAuthSecret: 'c'.repeat(64),
    },
    clock: createMonotonicClock(Symbol('inheritance-real-proxy'), { readMilliseconds: () => clockMs }),
    identity: proxyIdentityFieldsFor(reference),
    host: {
      start: () => {
        throw new Error('redemption test unexpectedly started an operation');
      },
      stop: () => {
        throw new Error('redemption test unexpectedly stopped an operation');
      },
    },
    timer,
    mintChallenge: () => randomUUID(),
    mintReceipt: () => randomUUID(),
    mintReservation: () => {
      throw new Error('redemption test unexpectedly reserved an operation');
    },
    wallClockNow: () => 0,
    containment: {
      stageProviderRoot: () => {
        throw new Error('redemption test unexpectedly staged a provider root');
      },
    },
  });
  await proxy.listen();

  const predecessor = await connectControlClient(capsule.proxyEndpoint, timer, 5_000);
  try {
    const opened = (await predecessor.call(
      'control.open.v1',
      { bootstrapNonce, coordinator: COORDINATOR_IDENTITY },
      5_000,
    )) as { controlEpoch: number; heartbeatChallenge: string };
    await predecessor.call(
      'control.heartbeat.v1',
      { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
      5_000,
    );
    await predecessor.call(
      'handoff.install.v1',
      {
        grantId: capsule.grantId,
        secretSha256: createHash('sha256').update(capsule.secret).digest('hex'),
        generation: capsule.generation,
        hostFingerprint: capsule.hostFingerprint,
        buildSetId: capsule.buildSetId,
        proxyInstanceId: capsule.proxyInstanceId,
        operations: installedOperations,
        orphanTimeoutMs: capsule.orphanTimeoutMs,
      },
      5_000,
    );
    for (const operation of registeredOperations) {
      await predecessor.call('succession.register-operation.v1', { operation }, 5_000);
    }
  } finally {
    predecessor.close();
  }

  // Expire the predecessor's live-control lease so the real proxy admits the successor redemption below.
  clockMs = 6_000n;
  return {
    connect: () => connectControlClient(capsule.proxyEndpoint, timer, 5_000),
    close: async () => {
      await proxy.close();
    },
  };
}

describe('attemptProviderProxySetInheritance', () => {
  it('reports not-bequeathed without touching a socket when no capsule exists at the address', async () => {
    mockedReadCapsule.mockReturnValueOnce(null);
    const loc = locator();

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      },
      neverAborts,
    );

    expect(outcome).toEqual({ kind: 'not-bequeathed', reason: 'no capsule at this address' });
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  // The upgrade path, and the one a discovery-side build gate cannot cover: this entry derives the capsule's
  // address from the record itself rather than from anything discovery classified. Dialing a set from another
  // build returns `identity_mismatch`, which the recovery policy retires fatally — the coordinator dies over a
  // set it never owned. `capsuleMatchesLocator` cannot catch it either, because it compares the capsule
  // against the *record's* build, and for a foreign set those two agree.
  it('reports not-bequeathed without reading a foreign build’s capsule at all', async () => {
    const loc = locator({ buildSetId: '77777777-7777-4777-8777-777777777777' });

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      },
      neverAborts,
    );

    expect(outcome).toEqual({ kind: 'not-bequeathed', reason: 'the recorded set belongs to another build' });
    expect(mockedReadCapsule, 'a foreign capsule is refused before it is even read').not.toHaveBeenCalled();
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  // Same build, shipped-V2 capsule. Its process fields are seconds this build cannot verify, so there is no
  // identity to redeem against — and inventing one from them reports a live process as absent.
  it('reports not-bequeathed for a capsule that predates the incarnation token', async () => {
    const loc = locator();
    const shippedV2: HandoffCapsuleV2 = {
      ...(capsuleFor(loc) as HandoffCapsuleV3),
      version: 2,
      guardianPid: loc.locator.guardian.pid,
      guardianProcessStartedAtSeconds: 1_700_000_001,
      proxyPid: loc.locator.proxy.pid,
      reaperPid: loc.locator.reaper.pid,
      reaperProcessStartedAtSeconds: 1_700_000_003,
      containmentKind: 'detached-process-group',
      proxyProcessStartedAtSeconds: 1_700_000_002,
      proxyProcessGroupId: loc.locator.proxy.pid,
    };
    mockedReadCapsule.mockReturnValueOnce(shippedV2);

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      },
      neverAborts,
    );

    expect(outcome).toEqual({
      kind: 'not-bequeathed',
      reason: 'the capsule predates the process incarnation token',
    });
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it('returns exact disappearance proof instead of treating a missing credential as authority to proceed', async () => {
    mockedReadCapsule.mockReturnValueOnce(null);
    const loc = locator();
    const proveContainmentAbsent = vi.fn(
      async () => 'group:200,leader:200@linux:00000000-0000-4000-8000-000000000000:3',
    );

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        proveContainmentAbsent,
      },
      neverAborts,
    );

    expect(outcome).toEqual({
      kind: 'containment-disappeared',
      disappearanceReceipt: 'group:200,leader:200@linux:00000000-0000-4000-8000-000000000000:3',
    });
    expect(proveContainmentAbsent).toHaveBeenCalledWith(providerProxySetIdentityFromRecord(loc), unusedDb, neverAborts);
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it('reports not-bequeathed when the capsule disagrees with the committed locator', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc, { proxyInstanceId: randomUUID() }));

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      },
      neverAborts,
    );

    expect(outcome).toEqual({
      kind: 'not-bequeathed',
      reason: 'capsule identity disagrees with the committed locator',
    });
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it('returns the shared operation authority whose stop sender rejects a malformed result', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const operations = [operationFor(loc)];
    const calls: { method: string; params: unknown }[] = [];
    const client = fakeClient(
      redemptionResponses(loc, matchingOperationSets(operations), {
        'operation.stop.v1': { state: 'stopping' },
      }),
      calls,
    );
    stubConnect(client);
    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      },
      neverAborts,
    );

    if (outcome.kind !== 'inherited') throw new Error('inheritance did not return its operation authority');
    const stop = outcome.set.buildOperationControl(operations[0]);
    await expect(stop.stop('signal_abort')).rejects.toThrow(/committedThroughProviderSeq/);
    expect(calls.filter((c) => c.method === 'operation.stop.v1')).toHaveLength(1);

    // A cause the shared schema has no place for is refused here, at the sender, and the frame is never
    // written — the proxy's own receipt-side `.strict()` parse never gets the chance to refuse it.
    await expect(stop.stop('not-a-real-cause' as never)).rejects.toThrow();
    expect(calls.filter((c) => c.method === 'operation.stop.v1')).toHaveLength(1);
  });

  it('redeems guardian, reaper, and proxy in proof order for the same complete operation set', async () => {
    const original = locator();
    const loc: ProviderProxySetLocator = {
      ...original,
      locator: {
        ...original.locator,
        proxy: {
          ...original.locator.proxy,
          controlEndpoint: `/tmp/coral-inheritance-${randomUUID()}.sock`,
        },
      },
    };
    const capsule = capsuleFor(loc);
    mockedReadCapsule.mockReturnValueOnce(capsule);
    const otherIdentity = { jobId: randomUUID(), operationId: randomUUID() };
    const guardianOperations = byteSorted([operationFor(loc), operationFor(loc, otherIdentity)]);
    const reaperOperations = byteSorted([operationFor(loc), operationFor(loc, otherIdentity)]);
    const proxy = await startRegisteredProxy(loc, capsule, [], [operationFor(loc), operationFor(loc, otherIdentity)]);
    const calls: { method: string; params: unknown }[] = [];
    const connectionOrder: string[] = [];
    let sawGuardianReceiptOnRotate = false;
    const roleClient = fakeClient(
      redemptionResponses(
        loc,
        { guardian: guardianOperations, reaper: reaperOperations, proxy: [] },
        {
          'reaper.handoff-rotate.v1': (params: unknown) => {
            sawGuardianReceiptOnRotate =
              (params as { guardianRedemptionReceipt: string }).guardianRedemptionReceipt === 'guardian-receipt';
            return {
              ...OPENING,
              state: 'successor-rotated',
              reaperRotationReceipt: 'reaper-receipt',
              operations: reaperOperations,
              reaper: reaperIdentityFor(loc),
            };
          },
        },
      ),
      calls,
    );
    mockedConnect.mockImplementation(async (socketPath: string) => {
      connectionOrder.push(socketPath);
      if (socketPath === loc.locator.guardian.controlEndpoint) return roleClient;
      if (socketPath === loc.locator.reaper.controlEndpoint) return roleClient;
      if (socketPath === loc.locator.proxy.controlEndpoint) return proxy.connect();
      throw new Error(`unexpected connection to ${socketPath}`);
    });

    try {
      const outcome = await attemptProviderProxySetInheritance(
        loc,
        unusedDb,
        {
          runtime,
          coordinatorIdentity: COORDINATOR_IDENTITY,
          operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        },
        neverAborts,
      );

      if (outcome.kind !== 'inherited') throw new Error('inheritance did not return its operation authority');
      try {
        expect(sawGuardianReceiptOnRotate).toBe(true);
        expect(outcome.set.proxyInstanceId).toBe(loc.operation.proxyInstanceId);
        expect(connectionOrder).toEqual([
          loc.locator.guardian.controlEndpoint,
          loc.locator.reaper.controlEndpoint,
          loc.locator.proxy.controlEndpoint,
        ]);
        expect(calls.some((call) => call.method.startsWith('operation.'))).toBe(false);
      } finally {
        outcome.set.stopHeartbeats();
        await outcome.set.initiateControlClose();
      }
    } finally {
      await proxy.close();
    }
  });

  it('rejects and closes every opened role when one redeemed operation set is a strict subset', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const otherIdentity = { jobId: randomUUID(), operationId: randomUUID() };
    const guardianOperations = byteSorted([operationFor(loc), operationFor(loc, otherIdentity)]);
    const reaperOperations = byteSorted([operationFor(loc), operationFor(loc, otherIdentity)]);
    const proxyOperations = [operationFor(loc)];
    const calls: { method: string; params: unknown }[] = [];
    const closed: string[] = [];
    const responses = redemptionResponses(loc, {
      guardian: guardianOperations,
      reaper: reaperOperations,
      proxy: proxyOperations,
    });
    const roleEndpoints = [
      loc.locator.guardian.controlEndpoint,
      loc.locator.reaper.controlEndpoint,
      loc.locator.proxy.controlEndpoint,
    ];

    mockedConnect.mockImplementation(async (socketPath: string) => {
      if (!roleEndpoints.includes(socketPath)) throw new Error(`unexpected connection to ${socketPath}`);
      return fakeClient(responses, calls, () => closed.push(socketPath));
    });

    await expect(
      attemptProviderProxySetInheritance(
        loc,
        unusedDb,
        {
          runtime,
          coordinatorIdentity: COORDINATOR_IDENTITY,
          operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        },
        neverAborts,
      ),
    ).rejects.toThrow('Guardian, reaper, and proxy redeemed different operation sets.');
    expect(closed).toHaveLength(3);
    expect(closed).toEqual(expect.arrayContaining(roleEndpoints));
  });

  it('accepts equivalent redeemed operation sets in different orders', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const mine = operationFor(loc);
    const other = operationFor(loc, { jobId: randomUUID(), operationId: randomUUID() });
    const calls: { method: string; params: unknown }[] = [];
    const client = fakeClient(
      redemptionResponses(loc, {
        guardian: [{ ...mine }, { ...other }],
        reaper: [{ ...other }, { ...mine }],
        proxy: [{ ...mine }, { ...other }],
      }),
      calls,
    );
    stubConnect(client);

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      },
      neverAborts,
    );

    if (outcome.kind !== 'inherited') throw new Error('inheritance did not return its operation authority');
    outcome.set.stopHeartbeats();
    await outcome.set.initiateControlClose();
  });

  it('closes every already-opened connection and rejects when a later role refusal leaves control ambiguous', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const closed: string[] = [];
    mockedConnect.mockImplementation(async (socketPath: string) => ({
      call: async (method: string) => {
        if (method === 'guardian.handoff-redeem.v1') {
          return {
            ...OPENING,
            state: 'redeemed-provisional',
            redemptionReceipt: 'g',
            operations: [],
            guardian: guardianIdentityFor(loc),
            reaper: reaperIdentityFor(loc),
            containment: containmentFor(loc),
          };
        }
        if (method === 'guardian.heartbeat.v1') return { state: 'active', nextHeartbeatChallenge: 'g2' };
        if (method === 'reaper.handoff-rotate.v1') throw new Error('grant_invalid: replayed');
        throw new Error(`unexpected ${method} for ${socketPath}`);
      },
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => closed.push(socketPath),
    }));

    await expect(
      attemptProviderProxySetInheritance(
        loc,
        unusedDb,
        {
          runtime,
          coordinatorIdentity: COORDINATOR_IDENTITY,
          operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        },
        neverAborts,
      ),
    ).rejects.toThrow(/grant_invalid/u);
    // The guardian connection opened before the reaper refusal must be closed rather than leaked.
    expect(closed).toContain(loc.locator.guardian.controlEndpoint);
  });

  it('refuses to open any connection when the caller signal is already aborted', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const controller = new AbortController();
    controller.abort();

    await expect(
      attemptProviderProxySetInheritance(
        loc,
        unusedDb,
        {
          runtime,
          coordinatorIdentity: COORDINATOR_IDENTITY,
          operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it('stops redeeming the next role once the caller signal aborts between roles', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const controller = new AbortController();
    const calls: { method: string; params: unknown }[] = [];
    const client = fakeClient(
      {
        ...redemptionResponses(loc, matchingOperationSets([])),
        'guardian.handoff-redeem.v1': () => {
          // Fires the caller's own cancellation (a coordinator shutdown, in production) the instant guardian
          // redemption completes — before reaper is ever dialed.
          controller.abort();
          return {
            ...OPENING,
            state: 'redeemed-provisional',
            redemptionReceipt: 'guardian-receipt',
            operations: [],
            guardian: guardianIdentityFor(loc),
            reaper: reaperIdentityFor(loc),
            containment: containmentFor(loc),
          };
        },
      },
      calls,
    );
    stubConnect(client);

    await expect(
      attemptProviderProxySetInheritance(
        loc,
        unusedDb,
        {
          runtime,
          coordinatorIdentity: COORDINATOR_IDENTITY,
          operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(calls.some((c) => c.method === 'reaper.handoff-rotate.v1')).toBe(false);
    expect(calls.some((c) => c.method === 'handoff.redeem.v1')).toBe(false);
  });
});

describe('createProviderProxySetInheritance', () => {
  const identity = { instanceId: randomUUID(), buildSetId: BUILD_SET_ID, flavor: 'prod' as const };

  it('stops reclamation after TERM when the bounded recovery signal aborts', async () => {
    const reference = locator();
    const record = proofRecord(reference, { pid: 104, incarnation: testIncarnation(1_003) });
    if (!('providerRoot' in record)) throw new Error('proof record did not retain its provider root');
    const db = proofDatabase([record]);
    const controller = new AbortController();
    const live = new Map<number, ProcessIncarnation>([
      [-reference.locator.containment.processGroupId, reference.locator.containment.incarnation],
      [reference.locator.containment.pid, reference.locator.containment.incarnation],
      [record.providerRoot.pid, record.providerRoot.incarnation],
    ]);
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const base = createRealRuntime('prod');
    const boundedRuntime = {
      ...base,
      process: {
        ...base.process,
        isAlive: (pid: number) => live.has(pid),
        kill: (pid: number, signal: NodeJS.Signals | 0) => {
          signals.push({ pid, signal });
          if (signal === 'SIGKILL') live.clear();
          return true;
        },
      },
    };
    mockedProbe.mockImplementation((pid) => live.get(pid) ?? null);
    const inheritance = createProviderProxySetInheritance({
      runtime: boundedRuntime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet: () => undefined,
    });

    const proof = inheritance.proveContainmentAbsent(
      providerProxySetIdentityFromRecord(reference),
      db,
      controller.signal,
    );
    expect(signals).toEqual([
      { pid: -reference.locator.containment.processGroupId, signal: 'SIGTERM' },
      { pid: record.providerRoot.pid, signal: 'SIGTERM' },
    ]);
    const observedProof = proof.catch((error: unknown) => error);
    controller.abort(new Error('recovery authority expired during TERM grace'));
    await expect(observedProof).resolves.toBeInstanceOf(Error);

    expect(signals).toEqual([
      { pid: -reference.locator.containment.processGroupId, signal: 'SIGTERM' },
      { pid: record.providerRoot.pid, signal: 'SIGTERM' },
    ]);
    expect(signals.some(({ signal }) => signal === 'SIGKILL')).toBe(false);
  });

  // Unreadable is the only ambiguity left. While the recorded value carried a per-process clock term a
  // disagreement meant nothing, so this path settled for existence — any readable pid counted as possibly
  // ours. The token removed that term, and a pid that reads back as *someone else* is now proof, not doubt;
  // treating it as doubt let an unrelated process inherit an enforcer's pid and block this proof forever,
  // which leaves the set's operations unsettled for good. What stays conservative is a pid that is alive but
  // cannot be read: nothing observed is still not absence.
  it('will not prove absence while an enforcer pid is alive but unreadable', async () => {
    const reference = locator();
    const record = proofRecord(reference, { pid: 104, incarnation: testIncarnation(1_003) });
    const db = proofDatabase([record]);
    const controller = new AbortController();
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const base = createRealRuntime('prod');
    const boundedRuntime = {
      ...base,
      process: {
        ...base.process,
        isAlive: () => true,
        kill: (pid: number, signal: NodeJS.Signals | 0) => {
          signals.push({ pid, signal });
          return true;
        },
      },
    };
    // No pid can be read at all, while every one of them is alive.
    mockedProbe.mockImplementation(() => null);

    const inheritance = createProviderProxySetInheritance({
      runtime: boundedRuntime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet: () => undefined,
    });

    await expect(
      inheritance.proveContainmentAbsent(providerProxySetIdentityFromRecord(reference), db, controller.signal),
      'an unreadable but living pid is not evidence that the enforcer is gone',
    ).resolves.toBeNull();
    expect(signals, 'nothing may be signalled while a target cannot be observed').toEqual([]);
  });

  // The other half of the same rule, and the reason the one above had to narrow. A pid that reads back as a
  // different process is not our enforcer, so it cannot keep this set alive — otherwise an unrelated process
  // inheriting that pid blocks the proof forever and the set's operations never settle.
  it('proves absence when an enforcer pid now belongs to a different process', async () => {
    const reference = locator();
    const record = proofRecord(reference, { pid: 104, incarnation: testIncarnation(1_003) });
    const db = proofDatabase([record]);
    const controller = new AbortController();
    const base = createRealRuntime('prod');
    const boundedRuntime = {
      ...base,
      process: { ...base.process, isAlive: () => true, kill: () => true },
    };
    // Every pid is readable, and every one of them reads back as someone else.
    mockedProbe.mockImplementation(() => testIncarnation(9_999_999));

    const inheritance = createProviderProxySetInheritance({
      runtime: boundedRuntime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet: () => undefined,
    });

    await expect(
      inheritance.proveContainmentAbsent(providerProxySetIdentityFromRecord(reference), db, controller.signal),
      'a pid that is provably someone else does not keep this set alive',
    ).resolves.not.toBeNull();
  });

  // The row may name a provider root that never enters the decoded inventory, so the proof cannot conclude
  // absence — but only for the set the row belongs to. Its key says which set that is without the row being
  // decodable, and fencing every set on any unreadable row anywhere blocks recovery for sets it has nothing to
  // do with. The key here therefore carries *this* set's proxy instance and build set.
  it('keeps containment proof unknown when an unreadable operation row may hide a root of this set', async () => {
    const reference = locator();
    const db = proofDatabase([proofRecord(reference, { pid: 104, incarnation: testIncarnation(1_003) })]);
    const unreadableKey =
      `provider_operation_saga.v1:record:${randomUUID()}:${randomUUID()}:` +
      `${reference.operation.proxyInstanceId}:${reference.operation.buildSetId}`;
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(unreadableKey, 'not json');
    const process = proofRuntime(new Map());
    mockedProbe.mockImplementation(() => testIncarnation('replacement'));
    const inheritance = createProviderProxySetInheritance({
      runtime: process.runtime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet: () => undefined,
    });

    await expect(
      inheritance.proveContainmentAbsent(providerProxySetIdentityFromRecord(reference), db, neverAborts),
    ).resolves.toBeNull();
    expect(process.signals).toEqual([]);
  });

  it('proves absence despite an unreadable row belonging to some other set', async () => {
    const reference = locator();
    const db = proofDatabase([proofRecord(reference, { pid: 104, incarnation: testIncarnation(1_003) })]);
    // Same shape, different set. Before this was scoped, one such row anywhere in the store blocked the proof
    // for every set in it, indefinitely and invisibly.
    const foreignKey = `provider_operation_saga.v1:record:${randomUUID()}:${randomUUID()}:${randomUUID()}:${randomUUID()}`;
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(foreignKey, 'not json');
    const process = proofRuntime(new Map());
    const inheritance = createProviderProxySetInheritance({
      runtime: process.runtime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet: () => undefined,
    });

    await expect(
      inheritance.proveContainmentAbsent(providerProxySetIdentityFromRecord(reference), db, neverAborts),
    ).resolves.not.toBeNull();
  });

  it('proves containment through the public factory without selecting an address-distinct root', async () => {
    const referenceA = locator();
    const referenceB = alternateLocator(referenceA);
    const db = proofDatabase([
      proofRecord(referenceA, { pid: 104, incarnation: testIncarnation(1_003) }),
      proofRecord(referenceB, { pid: 204, incarnation: testIncarnation(2_003) }),
    ]);
    const process = proofRuntime(
      new Map<number, ProcessIncarnation>([
        [-referenceA.locator.containment.processGroupId, referenceA.locator.containment.incarnation],
        [referenceA.locator.containment.pid, referenceA.locator.containment.incarnation],
        [104, testIncarnation(1_003)],
        [204, testIncarnation(2_003)],
      ]),
    );
    const inheritance = createProviderProxySetInheritance({
      runtime: process.runtime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet: () => undefined,
    });

    const receipt = await inheritance.proveContainmentAbsent(
      providerProxySetIdentityFromRecord(referenceA),
      db,
      neverAborts,
    );

    expect({
      receipt,
      signals: process.signals,
      addressDistinctRootAlive: process.live.has(204),
    }).toEqual({
      receipt:
        'group:200,leader:200@linux:00000000-0000-4000-8000-000000000000:3,root:104@linux:00000000-0000-4000-8000-000000000000:1003',
      signals: [
        { pid: -200, signal: 'SIGTERM' },
        { pid: 104, signal: 'SIGTERM' },
      ],
      addressDistinctRootAlive: true,
    });
  });

  it('keeps 64 address-distinct roots outside the 128-root guard for 65 exact roots', async () => {
    const referenceA = locator();
    const referenceB = alternateLocator(referenceA);
    const exactRecords = Array.from({ length: 65 }, (_, index) =>
      proofRecord(referenceA, { pid: 1_000 + index, incarnation: testIncarnation(`10000-${index}`) }),
    );
    const distinctRecords = Array.from({ length: 64 }, (_, index) =>
      proofRecord(referenceB, { pid: 2_000 + index, incarnation: testIncarnation(`20000-${index}`) }),
    );
    const db = proofDatabase([...exactRecords, ...distinctRecords]);
    const process = proofRuntime(new Map());
    const inheritance = createProviderProxySetInheritance({
      runtime: process.runtime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet: () => undefined,
    });

    const receipt = await inheritance.proveContainmentAbsent(
      providerProxySetIdentityFromRecord(referenceA),
      db,
      neverAborts,
    );

    expect(receipt?.match(/root:/gu)).toHaveLength(65);
    expect(receipt).not.toContain('root:2000@linux:00000000-0000-4000-8000-000000000000:20000');
    expect(process.signals).toEqual([]);
  });

  it('reports not-bequeathed without attempting redemption when this process’s own incarnation is unreadable', async () => {
    mockedProbe.mockReturnValueOnce(null);
    const registerInheritedSet = vi.fn();

    const inheritance = createProviderProxySetInheritance({
      runtime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet,
    });
    const outcome = await inheritance.inheritProviderProxySet(locator(), unusedDb, neverAborts);

    expect(outcome).toEqual({ kind: 'not-bequeathed', reason: expect.stringContaining('incarnation') });
    expect(mockedReadCapsule).not.toHaveBeenCalled();
    expect(registerInheritedSet).not.toHaveBeenCalled();
  });

  it('registers a successfully inherited set and leaves it unregistered when not bequeathed', async () => {
    mockedReadCapsule.mockReturnValueOnce(null);
    mockedProbe.mockImplementation((pid) => (pid === 100 ? testIncarnation(1) : testIncarnation(1_700_000_000)));
    const registerInheritedSet = vi.fn();

    const inheritance = createProviderProxySetInheritance({
      runtime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet,
    });
    const db = proofDatabase([]);
    const outcome = await inheritance.inheritProviderProxySet(locator(), db, neverAborts).finally(() => db.close());

    expect(outcome.kind).toBe('not-bequeathed');
    expect(registerInheritedSet).not.toHaveBeenCalled();
  });

  it('announces once when a claim-backed discovered capsule is later registered from its durable row', async () => {
    const loc = locator();
    const capsule = capsuleFor(loc);
    mockedReadCapsule.mockReturnValueOnce(capsule);
    const client = fakeClient(redemptionResponses(loc, matchingOperationSets([])), []);
    stubConnect(client);
    const established = vi.fn();
    const unsubscribe = subscribeProviderProxyControlEstablished(established);
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([providerOperationRecord('executing', { operation: loc.operation, locator: loc.locator })]);
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: FIXTURE_BUILD_SET_ID,
      claims,
      controlEstablished: notifyProviderProxyControlEstablished,
      time: runtime.time,
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
        'containment-proof': async () => null,
      }),
      reportLifecycle: () => undefined,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.installDiscoveredCapsules([{ path: '/capsules/claim-backed.handoff.json', capsule }]);
    expect(established).not.toHaveBeenCalled();
    const registerInheritedSet = vi.fn((set: ProviderProxyOperationAuthority) => {
      if (!isProviderProxyOperationAuthority(set)) throw new Error('expected durable authority');
      lifecycle.registerInheritedSet(set);
    });

    const inheritance = createProviderProxySetInheritance({
      runtime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet,
    });
    const outcome = await inheritance.inheritProviderProxySet(loc, unusedDb, neverAborts);
    unsubscribe();

    expect(outcome.kind).toBe('inherited');
    expect(registerInheritedSet).toHaveBeenCalledTimes(1);
    expect(established).toHaveBeenCalledTimes(1);
    expect(registerInheritedSet.mock.invocationCallOrder[0]).toBeLessThan(established.mock.invocationCallOrder[0]);
    expect(mockedConnect).toHaveBeenCalledTimes(3);
    if (outcome.kind === 'inherited') {
      expect(registerInheritedSet).toHaveBeenCalledWith(outcome.set);
    }
  });

  it('keeps guardian control live while reaper and proxy each consume 8500ms', async () => {
    const loc = locator();
    const capsule = capsuleFor(loc);
    mockedReadCapsule.mockReturnValueOnce(capsule);
    const responses = redemptionResponses(loc, matchingOperationSets([]));
    const guardianOpen = responses['guardian.handoff-redeem.v1'];
    if (typeof guardianOpen !== 'object' || guardianOpen === null) throw new Error('expected guardian response');
    const time = new VirtualTime();
    const guardian = await guardianLeaseClient(time, guardianOpen as Record<string, unknown>);
    const otherClient = fakeClient(responses, []);
    const heartbeatOriginMs = time.now();
    mockedConnect.mockImplementation(async (socketPath: string) => {
      if (socketPath === loc.locator.guardian.controlEndpoint) return guardian.client;
      if (socketPath === loc.locator.reaper.controlEndpoint) {
        await advanceInheritanceEndpointClock(time, 8_500, heartbeatOriginMs, guardian.acceptedEchoes);
        return otherClient;
      }
      if (socketPath === loc.locator.proxy.controlEndpoint) {
        await advanceInheritanceEndpointClock(time, 8_500, heartbeatOriginMs, guardian.acceptedEchoes);
        return otherClient;
      }
      throw new Error(`unexpected connection to ${socketPath}`);
    });
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const established = vi.fn();
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: FIXTURE_BUILD_SET_ID,
      claims,
      controlEstablished: established,
      time,
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
        'containment-proof': async () => null,
      }),
      reportLifecycle: () => undefined,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const inheritance = createProviderProxySetInheritance({
      runtime: { ...runtime, time },
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet: (set) => {
        if (!isProviderProxyOperationAuthority(set)) throw new Error('expected durable authority');
        lifecycle.registerInheritedSet(set);
      },
    });

    const outcome = await inheritance.inheritProviderProxySet(loc, unusedDb, neverAborts);
    if (outcome.kind !== 'inherited') throw new Error('expected inherited set');
    const observation = {
      recurringEchoes: guardian.acceptedEchoes() - 1,
      controlIsLive: guardian.controlIsLive(),
      announcements: established.mock.calls.length,
    };
    outcome.set.stopHeartbeats();
    await guardian.close();

    expect({
      acceptedRecurringEchoes: observation.recurringEchoes > 1,
      controlIsLive: observation.controlIsLive,
      announcements: observation.announcements,
    }).toEqual({ acceptedRecurringEchoes: true, controlIsLive: true, announcements: 1 });
  });

  it('observes a stored reaper fault inline before an inherited authority can be published', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const calls: { method: string; params: unknown }[] = [];
    const responses = redemptionResponses(loc, matchingOperationSets([]), {
      'guardian.stop-and-reap.v1': { disappearanceReceipt: 'guardian-absent' },
      'reaper.stop-and-reap.v1': { disappearanceReceipt: 'reaper-absent' },
    });
    const guardian = faultableClient(responses, calls);
    const reaper = faultableClient(responses, calls);
    const proxy = faultableClient(responses, calls);
    mockedConnect.mockImplementation(async (socketPath: string) => {
      if (socketPath === loc.locator.guardian.controlEndpoint) return guardian.client;
      if (socketPath === loc.locator.reaper.controlEndpoint) {
        reaper.fault(new ControlClientError('control_client_closed', 'The reaper control channel closed.', 'closed'));
        await reaper.client.faulted;
        return reaper.client;
      }
      if (socketPath === loc.locator.proxy.controlEndpoint) return proxy.client;
      throw new Error(`unexpected connection to ${socketPath}`);
    });
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const established = vi.fn();
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: FIXTURE_BUILD_SET_ID,
      claims,
      controlEstablished: established,
      time: {
        now: () => 0,
        setTimeout: () => ({ unref: () => undefined }),
        clearTimeout: () => undefined,
      },
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
    let authorityInsideRegistration: ProviderProxyOperationAuthority | null | undefined;

    const inheritance = createProviderProxySetInheritance({
      runtime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet: (set) => {
        if (!isProviderProxyOperationAuthority(set)) throw new Error('expected durable authority');
        lifecycle.registerInheritedSet(set);
        authorityInsideRegistration = lifecycle.authorityFor(set.setIdentity);
      },
    });
    const outcome = await inheritance.inheritProviderProxySet(loc, unusedDb, neverAborts);

    expect(outcome.kind).toBe('inherited');
    expect({
      authorityAcceptedDuringRegistration: authorityInsideRegistration !== null,
      announcements: established.mock.calls.length,
    }).toEqual({ authorityAcceptedDuringRegistration: false, announcements: 0 });
    if (outcome.kind === 'inherited') {
      expect(lifecycle.authorityFor(outcome.set.setIdentity)).toBeNull();
      outcome.set.stopHeartbeats();
      await outcome.set.initiateControlClose();
    }
  });

  it('removes inherited authority when the guardian heartbeat genuinely rejects', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    let guardianHeartbeats = 0;
    const client = fakeClient(
      redemptionResponses(loc, matchingOperationSets([]), {
        'guardian.heartbeat.v1': () => {
          guardianHeartbeats += 1;
          if (guardianHeartbeats === 1) {
            return { state: 'active', nextHeartbeatChallenge: 'g2' };
          }
          throw new Error('guardian heartbeat rejected');
        },
      }),
      [],
    );
    stubConnect(client);
    const time = new VirtualTime();
    const inheritedRuntime = { ...runtime, time };
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: FIXTURE_BUILD_SET_ID,
      claims,
      controlEstablished: () => undefined,
      time,
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

    const inheritance = createProviderProxySetInheritance({
      runtime: inheritedRuntime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet: (set) => {
        if (!isProviderProxyOperationAuthority(set)) throw new Error('expected durable authority');
        lifecycle.registerInheritedSet(set);
      },
    });
    const outcome = await inheritance.inheritProviderProxySet(loc, unusedDb, neverAborts);
    if (outcome.kind !== 'inherited') throw new Error('expected inherited set');
    expect(lifecycle.authorityFor(outcome.set.setIdentity)).toBe(outcome.set);

    time.tick(1_000);
    await flushMicrotasks();

    expect({
      guardianHeartbeats,
      authorityAvailable: lifecycle.authorityFor(outcome.set.setIdentity) !== null,
    }).toEqual({ guardianHeartbeats: 2, authorityAvailable: false });
    outcome.set.stopHeartbeats();
    await outcome.set.initiateControlClose();
  });
});
