import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#src/provider-proxy/handoff-capsule.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, readHandoffCapsuleFile: vi.fn() };
});

vi.mock('#src/jobs/runtime-meta-store.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, readProviderOperationRuntimeMeta: vi.fn() };
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
import { readProviderOperationRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import { connectRoleControlWithRetry } from '#src/provider-proxy/role-spawn.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import type { ProviderOperationRuntimeMeta } from '#src/jobs/runtime-meta.js';
import type { Database } from '#src/store/db.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  attemptProviderProxySetInheritance,
  createProviderProxySetInheritance,
} from '#src/coordinator/services/provider-proxy-set-inheritance.js';
import type { ProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy-operation-route.js';

const mockedReadCapsule = vi.mocked(readHandoffCapsuleFile);
const mockedReadMeta = vi.mocked(readProviderOperationRuntimeMeta);
const mockedConnect = vi.mocked(connectRoleControlWithRetry);
const mockedProbe = vi.mocked(probeProcessStartedAtSeconds);

// Call history, not implementations, so `mockedProbe`'s default `1_700_000_000` (set in the `vi.mock` factory
// above) survives — only each test's own explicit `.mockReturnValueOnce`/`.mockResolvedValueOnce` setup and
// this shared `.not.toHaveBeenCalled()`-style assertions must not see a sibling test's earlier calls.
beforeEach(() => {
  vi.clearAllMocks();
});

const runtime = createRealRuntime('prod');
const unusedDb = {} as Database;

const GUARDIAN_INSTANCE_ID = randomUUID();
const REAPER_INSTANCE_ID = randomUUID();
const PROXY_INSTANCE_ID = randomUUID();
const BUILD_SET_ID = randomUUID();
const HOST_FINGERPRINT = 'a'.repeat(64);

/** Every `establishes-control` reply is `{ ...fields, controlEpoch, heartbeatChallenge }` on the wire
 *  (`control-endpoint.ts`'s own `establishControl`); every fake "open" response below spreads this in. */
const OPENING = { controlEpoch: 1, heartbeatChallenge: 'first-challenge' };

function locator(overrides: Partial<ProviderOperationRuntimeMeta> = {}): ProviderOperationRuntimeMeta {
  return {
    version: 1,
    jobId: randomUUID(),
    operationId: randomUUID(),
    buildSetId: BUILD_SET_ID,
    hostFingerprint: HOST_FINGERPRINT,
    guardianInstanceId: GUARDIAN_INSTANCE_ID,
    guardianPid: 100,
    guardianProcessStartedAtSeconds: 1,
    guardianControlEndpoint: '/tmp/guardian.sock',
    proxyInstanceId: PROXY_INSTANCE_ID,
    proxyPid: 200,
    reaperInstanceId: REAPER_INSTANCE_ID,
    reaperPid: 300,
    reaperProcessStartedAtSeconds: 2,
    reaperControlEndpoint: '/tmp/reaper.sock',
    containmentKind: 'posix-group',
    proxyProcessStartedAtSeconds: 3,
    proxyProcessGroupId: 200,
    canonicalEndpoint: '/tmp/proxy.sock',
    reservationId: randomUUID(),
    activationNonce: randomUUID(),
    providerRootPid: 7_001,
    providerRootProcessStartedAtSeconds: 800,
    jointContainmentReceipt: 'joint-1',
    committedThroughProviderSeq: 0,
    ...overrides,
  };
}

function capsuleFor(loc: ProviderOperationRuntimeMeta, overrides: Partial<HandoffCapsule> = {}): HandoffCapsule {
  return {
    version: 1,
    grantId: randomUUID(),
    secret: 'f'.repeat(64),
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: loc.buildSetId,
    hostFingerprint: loc.hostFingerprint,
    guardianInstanceId: loc.guardianInstanceId,
    reaperInstanceId: loc.reaperInstanceId,
    proxyInstanceId: loc.proxyInstanceId,
    guardianControlEndpoint: loc.guardianControlEndpoint,
    reaperControlEndpoint: loc.reaperControlEndpoint,
    proxyEndpoint: loc.canonicalEndpoint,
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

function operationFor(loc: ProviderOperationRuntimeMeta, overrides: Partial<OperationKey> = {}): OperationKey {
  return {
    jobId: loc.jobId,
    operationId: loc.operationId,
    proxyInstanceId: loc.proxyInstanceId,
    buildSetId: loc.buildSetId,
    ...overrides,
  };
}

function byteSorted(operations: readonly OperationKey[]): OperationKey[] {
  return [...operations].sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
}

/** Method-dispatched fake `ControlClient`, shared across all three role connects — the wire methods this
 *  redemption calls (`guardian.handoff-redeem.v1`, `reaper.handoff-rotate.v1`, `handoff.redeem.v1`,
 *  `*.heartbeat.v1`, `operation.adopt.v1`, `operation.stop.v1`) never collide across roles, so one responder
 *  keyed by method name stands in for three distinct sockets. */
function fakeClient(
  responses: Record<string, unknown | ((params: unknown) => unknown)>,
  calls: { method: string; params: unknown }[],
): ControlClient {
  return {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      const entry = responses[method];
      if (entry === undefined) throw new Error(`unexpected call to ${method}`);
      return typeof entry === 'function' ? (entry as (p: unknown) => unknown)(params) : entry;
    },
    close: () => {},
  };
}

function stubConnect(client: ControlClient): void {
  mockedConnect.mockImplementation(async () => client);
}

function proxyIdentityFieldsFor(loc: ProviderOperationRuntimeMeta) {
  return {
    proxyInstanceId: loc.proxyInstanceId,
    pid: loc.proxyPid,
    processStartedAtSeconds: loc.proxyProcessStartedAtSeconds,
    processGroupId: loc.proxyProcessGroupId,
    guardianInstanceId: loc.guardianInstanceId,
    reaperInstanceId: loc.reaperInstanceId,
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId: loc.buildSetId,
    hostFingerprint: loc.hostFingerprint,
    canonicalEndpoint: loc.canonicalEndpoint,
  };
}

/** The three "open" replies a full, successful redemption needs, keyed exactly as `fakeClient` dispatches. */
function redemptionResponses(
  loc: ProviderOperationRuntimeMeta,
  operations: readonly OperationKey[],
  overrides: Record<string, unknown | ((params: unknown) => unknown)> = {},
): Record<string, unknown | ((params: unknown) => unknown)> {
  return {
    'guardian.handoff-redeem.v1': {
      ...OPENING,
      state: 'redeemed-provisional',
      redemptionReceipt: 'guardian-receipt',
      operations,
    },
    'guardian.heartbeat.v1': { state: 'active', nextHeartbeatChallenge: 'g2' },
    'reaper.handoff-rotate.v1': {
      ...OPENING,
      state: 'successor-rotated',
      reaperRotationReceipt: 'reaper-receipt',
      operations,
    },
    'reaper.heartbeat.v1': { state: 'active', nextHeartbeatChallenge: 'r2' },
    'handoff.redeem.v1': {
      ...OPENING,
      state: 'redeemed-provisional',
      redemptionReceipt: 'proxy-receipt',
      proxy: proxyIdentityFieldsFor(loc),
      operations,
    },
    'control.heartbeat.v1': { state: 'active', nextHeartbeatChallenge: 'p2' },
    ...overrides,
  };
}

describe('attemptProviderProxySetInheritance', () => {
  it('reports not-bequeathed without touching a socket when no capsule exists at the address', async () => {
    mockedReadCapsule.mockReturnValueOnce(null);
    const loc = locator();

    const outcome = await attemptProviderProxySetInheritance(loc, unusedDb, {
      runtime,
      coordinatorIdentity: COORDINATOR_IDENTITY,
      operationRegistry: { adopt: vi.fn(), operationsFor: () => [] },
    });

    expect(outcome).toEqual({ kind: 'not-bequeathed', reason: 'no capsule at this address' });
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it('reports not-bequeathed when the capsule disagrees with the committed locator', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc, { proxyInstanceId: randomUUID() }));

    const outcome = await attemptProviderProxySetInheritance(loc, unusedDb, {
      runtime,
      coordinatorIdentity: COORDINATOR_IDENTITY,
      operationRegistry: { adopt: vi.fn(), operationsFor: () => [] },
    });

    expect(outcome).toEqual({
      kind: 'not-bequeathed',
      reason: 'capsule identity disagrees with the committed locator',
    });
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it('redeems guardian, then reaper with the guardian’s own receipt, then proxy, adopting every named operation in order', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const mine = operationFor(loc);
    const other = operationFor(loc, { jobId: randomUUID(), operationId: randomUUID() });
    const operations = byteSorted([mine, other]);

    const calls: { method: string; params: unknown }[] = [];
    let sawGuardianReceiptOnRotate = false;
    const client = fakeClient(
      redemptionResponses(loc, operations, {
        'reaper.handoff-rotate.v1': (params: unknown) => {
          sawGuardianReceiptOnRotate =
            (params as { guardianRedemptionReceipt: string }).guardianRedemptionReceipt === 'guardian-receipt';
          return { ...OPENING, state: 'successor-rotated', reaperRotationReceipt: 'reaper-receipt', operations };
        },
        'operation.adopt.v1': { state: 'executing', replayFromProviderSeq: 1 },
      }),
      calls,
    );
    stubConnect(client);
    mockedReadMeta.mockImplementation((_db: Database, jobId: string, operationId: string) =>
      locator({ jobId, operationId, committedThroughProviderSeq: jobId === loc.jobId ? 5 : 9 }),
    );

    const registered: { jobId: string; committedThroughProviderSeq: number }[] = [];
    const outcome = await attemptProviderProxySetInheritance(loc, unusedDb, {
      runtime,
      coordinatorIdentity: COORDINATOR_IDENTITY,
      operationRegistry: {
        adopt: (meta) =>
          registered.push({ jobId: meta.jobId, committedThroughProviderSeq: meta.committedThroughProviderSeq }),
        operationsFor: () => [],
      },
    });

    expect(sawGuardianReceiptOnRotate).toBe(true);
    expect(outcome.kind).toBe('inherited');
    if (outcome.kind !== 'inherited') throw new Error('unreachable');
    expect(outcome.set.proxyInstanceId).toBe(loc.proxyInstanceId);
    expect([...outcome.adoptedJobIds].sort()).toEqual([mine.jobId, other.jobId].sort());
    expect(registered).toHaveLength(2);
    expect(registered.find((r) => r.jobId === loc.jobId)?.committedThroughProviderSeq).toBe(5);

    const methodOrder = calls.map((c) => c.method);
    expect(methodOrder.indexOf('guardian.handoff-redeem.v1')).toBeLessThan(
      methodOrder.indexOf('reaper.handoff-rotate.v1'),
    );
    expect(methodOrder.indexOf('reaper.handoff-rotate.v1')).toBeLessThan(methodOrder.indexOf('handoff.redeem.v1'));
    expect(methodOrder.indexOf('handoff.redeem.v1')).toBeLessThan(methodOrder.indexOf('operation.adopt.v1'));
  });

  it('skips a per-operation adopt refusal without failing the whole redeemed set', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const mine = operationFor(loc);
    const refused = operationFor(loc, { jobId: randomUUID(), operationId: randomUUID() });
    const operations = byteSorted([mine, refused]);

    const calls: { method: string; params: unknown }[] = [];
    const client = fakeClient(
      redemptionResponses(loc, operations, {
        'operation.adopt.v1': (params: unknown) => {
          const { operation } = params as { operation: { operationId: string } };
          if (operation.operationId === refused.operationId) throw new Error('operation_not_found');
          return { state: 'executing', replayFromProviderSeq: 1 };
        },
      }),
      calls,
    );
    stubConnect(client);
    mockedReadMeta.mockImplementation((_db: Database, jobId: string, operationId: string) =>
      locator({ jobId, operationId }),
    );

    const outcome = await attemptProviderProxySetInheritance(loc, unusedDb, {
      runtime,
      coordinatorIdentity: COORDINATOR_IDENTITY,
      operationRegistry: { adopt: vi.fn(), operationsFor: () => [] },
    });

    expect(outcome.kind).toBe('inherited');
    if (outcome.kind !== 'inherited') throw new Error('unreachable');
    expect([...outcome.adoptedJobIds]).toEqual([mine.jobId]);
  });

  it('skips an operation whose committed locator has already vanished', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const mine = operationFor(loc);
    const operations = [mine];

    const calls: { method: string; params: unknown }[] = [];
    const client = fakeClient(redemptionResponses(loc, operations), calls);
    stubConnect(client);
    mockedReadMeta.mockReturnValueOnce(null);
    const adopt = vi.fn();

    const outcome = await attemptProviderProxySetInheritance(loc, unusedDb, {
      runtime,
      coordinatorIdentity: COORDINATOR_IDENTITY,
      operationRegistry: { adopt, operationsFor: () => [] },
    });

    expect(outcome.kind).toBe('inherited');
    if (outcome.kind !== 'inherited') throw new Error('unreachable');
    expect(outcome.adoptedJobIds.size).toBe(0);
    expect(adopt).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'operation.adopt.v1')).toBe(false);
  });

  it('closes every already-opened connection and reports not-bequeathed when a later role refuses redemption', async () => {
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

    const outcome = await attemptProviderProxySetInheritance(loc, unusedDb, {
      runtime,
      coordinatorIdentity: COORDINATOR_IDENTITY,
      operationRegistry: { adopt: vi.fn(), operationsFor: () => [] },
    });

    expect(outcome).toEqual({ kind: 'not-bequeathed', reason: expect.stringContaining('grant_invalid') });
    // The guardian connection opened before the reaper refusal must be closed rather than leaked.
    expect(closed).toContain(loc.guardianControlEndpoint);
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
      operationRegistry: { adopt: vi.fn(), operationsFor: () => [] },
      registerInheritedSet,
    });
    const outcome = await inheritance.inheritProviderProxySet(locator(), unusedDb);

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
      operationRegistry: { adopt: vi.fn(), operationsFor: () => [] },
      registerInheritedSet,
    });
    const outcome = await inheritance.inheritProviderProxySet(locator(), unusedDb);

    expect(outcome.kind).toBe('not-bequeathed');
    expect(registerInheritedSet).not.toHaveBeenCalled();
  });

  it('folds a redeemed set into registerInheritedSet on success', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const client = fakeClient(redemptionResponses(loc, []), []);
    stubConnect(client);
    const registerInheritedSet = vi.fn<(set: ProviderProxyOperationAuthority) => void>();

    const inheritance = createProviderProxySetInheritance({
      runtime,
      identity,
      operationRegistry: { adopt: vi.fn(), operationsFor: () => [] },
      registerInheritedSet,
    });
    const outcome = await inheritance.inheritProviderProxySet(loc, unusedDb);

    expect(outcome.kind).toBe('inherited');
    expect(registerInheritedSet).toHaveBeenCalledTimes(1);
    if (outcome.kind === 'inherited') {
      expect(registerInheritedSet).toHaveBeenCalledWith(outcome.set);
    }
  });
});
