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
  return { ...original, probeProcessStartedAtSeconds: vi.fn(() => 1_700_000_000) };
});

import { readHandoffCapsuleFile, type HandoffCapsule } from '#src/provider-proxy/handoff-capsule.js';
import { probeProcessStartedAtSeconds } from '#src/infra/node-process.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import { createProxy } from '#src/provider-proxy/proxy.js';
import { connectRoleControlWithRetry, runtimeControlTimer } from '#src/provider-proxy/role-spawn.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import type { Database } from '#src/store/db.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  attemptProviderProxySetInheritance,
  createProviderProxySetInheritance,
  type ProviderProxySetLocator,
} from '#src/coordinator/services/provider-proxy-set-inheritance.js';
import {
  subscribeProviderProxyControlEstablished,
  type ProviderProxyOperationAuthority,
} from '#src/coordinator/live/provider-proxy/operation-route.js';

const mockedReadCapsule = vi.mocked(readHandoffCapsuleFile);
const mockedConnect = vi.mocked(connectRoleControlWithRetry);
const mockedProbe = vi.mocked(probeProcessStartedAtSeconds);

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
        processStartedAtSeconds: 1,
        controlEndpoint: '/tmp/guardian.sock',
      },
      proxy: {
        instanceId: proxyInstanceId,
        pid: 200,
        processStartedAtSeconds: 3,
        controlEndpoint: '/tmp/proxy.sock',
      },
      reaper: {
        instanceId: REAPER_INSTANCE_ID,
        pid: 300,
        processStartedAtSeconds: 2,
        controlEndpoint: '/tmp/reaper.sock',
      },
      containment: { pid: 200, processStartedAtSeconds: 3, processGroupId: 200, kind: 'posix-group' },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

function capsuleFor(reference: ProviderProxySetLocator, overrides: Partial<HandoffCapsule> = {}): HandoffCapsule {
  const { operation, locator: set } = reference;
  return {
    version: 1,
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
  processStartedAtSeconds: 900,
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
  return {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      const entry = responses[method];
      if (entry === undefined) throw new Error(`unexpected call to ${method}`);
      return typeof entry === 'function' ? (entry as (p: unknown) => unknown)(params) : entry;
    },
    close,
  };
}

function stubConnect(client: ControlClient): void {
  mockedConnect.mockImplementation(async () => client);
}

function proxyIdentityFieldsFor(reference: ProviderProxySetLocator) {
  const { operation, locator: set } = reference;
  return {
    proxyInstanceId: operation.proxyInstanceId,
    pid: set.proxy.pid,
    processStartedAtSeconds: set.proxy.processStartedAtSeconds,
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
    },
    'guardian.heartbeat.v1': { state: 'active', nextHeartbeatChallenge: 'g2' },
    'reaper.handoff-rotate.v1': {
      ...OPENING,
      state: 'successor-rotated',
      reaperRotationReceipt: 'reaper-receipt',
      operations: operationSets.reaper,
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

  it('returns exact disappearance proof instead of treating a missing credential as authority to proceed', async () => {
    mockedReadCapsule.mockReturnValueOnce(null);
    const loc = locator();
    const confirmContainmentDisappearance = vi.fn(async () => 'group:200,leader:200@3');

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        confirmContainmentDisappearance,
      },
      neverAborts,
    );

    expect(outcome).toEqual({
      kind: 'containment-disappeared',
      disappearanceReceipt: 'group:200,leader:200@3',
    });
    expect(confirmContainmentDisappearance).toHaveBeenCalledWith(loc, unusedDb, neverAborts);
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
          return { ...OPENING, state: 'redeemed-provisional', redemptionReceipt: 'g', operations: [] };
        }
        if (method === 'guardian.heartbeat.v1') return { state: 'active', nextHeartbeatChallenge: 'g2' };
        if (method === 'reaper.handoff-rotate.v1') throw new Error('grant_invalid: replayed');
        throw new Error(`unexpected ${method} for ${socketPath}`);
      },
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
          return { ...OPENING, state: 'redeemed-provisional', redemptionReceipt: 'guardian-receipt', operations: [] };
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

  it('reports not-bequeathed without attempting redemption when this process’s own start time is unreadable', async () => {
    mockedProbe.mockReturnValueOnce(null);
    const registerInheritedSet = vi.fn();

    const inheritance = createProviderProxySetInheritance({
      runtime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet,
    });
    const outcome = await inheritance.inheritProviderProxySet(locator(), unusedDb, neverAborts);

    expect(outcome).toEqual({ kind: 'not-bequeathed', reason: expect.stringContaining('start time') });
    expect(mockedReadCapsule).not.toHaveBeenCalled();
    expect(registerInheritedSet).not.toHaveBeenCalled();
  });

  it('registers a successfully inherited set and leaves it unregistered when not bequeathed', async () => {
    mockedReadCapsule.mockReturnValueOnce(null);
    const registerInheritedSet = vi.fn();

    const inheritance = createProviderProxySetInheritance({
      runtime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      confirmContainmentDisappearance: async () => null,
      registerInheritedSet,
    });
    const outcome = await inheritance.inheritProviderProxySet(locator(), unusedDb, neverAborts);

    expect(outcome.kind).toBe('not-bequeathed');
    expect(registerInheritedSet).not.toHaveBeenCalled();
  });

  it('registers and announces a redeemed set so pending journal phases resume', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const client = fakeClient(redemptionResponses(loc, matchingOperationSets([])), []);
    stubConnect(client);
    const registerInheritedSet = vi.fn<(set: ProviderProxyOperationAuthority) => void>();
    const established = vi.fn();
    const unsubscribe = subscribeProviderProxyControlEstablished(established);

    const inheritance = createProviderProxySetInheritance({
      runtime,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet,
    });
    const outcome = await inheritance.inheritProviderProxySet(loc, unusedDb, neverAborts);
    const replayedOutcome = await inheritance.inheritProviderProxySet(loc, unusedDb, neverAborts);
    unsubscribe();

    expect(outcome.kind).toBe('inherited');
    expect(replayedOutcome).toBe(outcome);
    expect(registerInheritedSet).toHaveBeenCalledTimes(1);
    expect(established).toHaveBeenCalledTimes(1);
    expect(registerInheritedSet.mock.invocationCallOrder[0]).toBeLessThan(established.mock.invocationCallOrder[0]);
    expect(mockedConnect).toHaveBeenCalledTimes(3);
    if (outcome.kind === 'inherited') {
      expect(registerInheritedSet).toHaveBeenCalledWith(outcome.set);
    }
  });
});
