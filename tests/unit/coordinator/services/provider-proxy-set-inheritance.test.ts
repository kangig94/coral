import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#src/provider-proxy/handoff-capsule.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, readHandoffCapsuleFile: vi.fn() };
});

vi.mock('#src/store/provider-operation-journal.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, readProviderOperation: vi.fn() };
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
import { connectRoleControlWithRetry } from '#src/provider-proxy/role-spawn.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import type { Database } from '#src/store/db.js';
import { readProviderOperation } from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
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
import { proxyOperationAdoptParamsSchema } from '#src/provider-proxy/protocol.js';

const mockedReadCapsule = vi.mocked(readHandoffCapsuleFile);
const mockedReadOperation = vi.mocked(readProviderOperation);
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
const cleanupIdentityFor = (jobId: string) => ({ jobId, pool: 'curate' as const });

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

function executingRecord(
  reference: ProviderProxySetLocator,
  committedThroughProviderSeq = 0,
): Extract<ProviderOperationRecord, { phase: 'executing' }> {
  const record = providerOperationRecordSchema.parse({
    version: 1,
    operation: reference.operation,
    locator: reference.locator,
    prepareAttemptNumber: 1,
    prepareAttemptKey: 'b'.repeat(64),
    phase: 'executing',
    reservation: randomUUID(),
    providerRoot: { pid: 7_001, processStartedAtSeconds: 800 },
    jointContainmentReceipt: 'joint-1',
    jointActivationReceipt: 'activation-receipt',
    activationAck: {
      state: 'executing',
      activationFingerprint: 'c'.repeat(64),
      startedAt: '2026-08-09T12:34:56.000Z',
      hostRef: {
        provider: 'codex',
        fingerprint: reference.locator.hostFingerprint,
        instanceId: 'host-instance-1',
        leaseMode: 'job-exclusive',
        ownerJobId: reference.operation.jobId,
      },
      committedThroughProviderSeq: 0,
    },
    committedThroughProviderSeq,
    revision: 0,
    retryNotBeforeMs: 0,
    retryCount: 0,
    lastError: null,
  });
  if (record.phase !== 'executing') throw new Error('executing fixture failed validation');
  return record;
}

function activationPendingRecord(reference: ProviderProxySetLocator): ProviderOperationRecord {
  const executing = executingRecord(reference);
  const { activationAck, committedThroughProviderSeq, ...pending } = executing;
  void activationAck;
  void committedThroughProviderSeq;
  return providerOperationRecordSchema.parse({
    ...pending,
    phase: 'proxy-activation-pending',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedReadOperation.mockReturnValue(null);
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

/** The three "open" replies a full, successful redemption needs, keyed exactly as `fakeClient` dispatches. */
function redemptionResponses(
  loc: ProviderProxySetLocator,
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

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { adopt: vi.fn(), operationsFor: () => [], providerRootsFor: () => [] },
        cleanupIdentityFor,
      },
      neverAborts,
    );

    expect(outcome).toEqual({ kind: 'not-bequeathed', reason: 'no capsule at this address' });
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
        operationRegistry: { adopt: vi.fn(), operationsFor: () => [], providerRootsFor: () => [] },
        cleanupIdentityFor,
      },
      neverAborts,
    );

    expect(outcome).toEqual({
      kind: 'not-bequeathed',
      reason: 'capsule identity disagrees with the committed locator',
    });
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it('parses an adopted stop request and rejects a malformed result at the sender', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const operations = [operationFor(loc)];
    const calls: { method: string; params: unknown }[] = [];
    const client = fakeClient(
      redemptionResponses(loc, operations, {
        'operation.adopt.v1': { state: 'executing', replayFromProviderSeq: 1 },
        'operation.stop.v1': { state: 'stopping' },
      }),
      calls,
    );
    stubConnect(client);
    mockedReadOperation.mockImplementation((_db: Database, operation) =>
      executingRecord({ operation, locator: loc.locator }, 5),
    );

    // The adopted stop control is handed to the registry and nowhere else, so capturing it here is the only
    // way to drive the send this file makes. Before this test the send had no coverage at all — which is why
    // its payload could have gone unvalidated indefinitely without any mutation being observable.
    let adoptedStop: { stop(cause: string): Promise<void> } | undefined;
    await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: {
          adopt: (_meta, control) => {
            adoptedStop = control as { stop(cause: string): Promise<void> };
          },
          operationsFor: () => [],
          providerRootsFor: () => [],
        },
        cleanupIdentityFor,
      },
      neverAborts,
    );

    if (adoptedStop === undefined) throw new Error('adoption did not register a stop control');
    // A JSON-RPC success is not a protocol success when its method result has drifted from the shared schema.
    await expect(adoptedStop.stop('signal_abort')).rejects.toThrow(/committedThroughProviderSeq/);
    expect(calls.filter((c) => c.method === 'operation.stop.v1')).toHaveLength(1);

    // A cause the shared schema has no place for is refused here, at the sender, and the frame is never
    // written — the proxy's own receipt-side `.strict()` parse never gets the chance to refuse it.
    await expect(adoptedStop.stop('not-a-real-cause')).rejects.toThrow();
    expect(calls.filter((c) => c.method === 'operation.stop.v1')).toHaveLength(1);

    // The sibling send in this same file gets the same treatment. Its watermark always comes from an
    // already-validated durable row, so the runtime path cannot produce a bad one today — which is exactly
    // why the schema is worth asserting directly rather than trusting the caller to keep being careful.
    const adopt = calls.find((c) => c.method === 'operation.adopt.v1');
    expect(adopt).toBeDefined();
    expect(() => proxyOperationAdoptParamsSchema.parse(adopt?.params)).not.toThrow();
    expect(() =>
      proxyOperationAdoptParamsSchema.parse({ ...(adopt?.params as object), committedThroughProviderSeq: -1 }),
    ).toThrow();
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
    mockedReadOperation.mockImplementation((_db: Database, operation) =>
      executingRecord({ operation, locator: loc.locator }, operation.jobId === loc.operation.jobId ? 5 : 9),
    );

    const registered: {
      jobId: string;
      committedThroughProviderSeq: number;
      cleanup: { jobId: string; pool: 'default' | 'discuss' | 'curate' };
    }[] = [];
    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: {
          adopt: (meta, _control, cleanup) =>
            registered.push({
              jobId: meta.operation.jobId,
              committedThroughProviderSeq: meta.committedThroughProviderSeq,
              cleanup,
            }),
          operationsFor: () => [],
          providerRootsFor: () => [],
        },
        cleanupIdentityFor,
      },
      neverAborts,
    );

    expect(sawGuardianReceiptOnRotate).toBe(true);
    expect(outcome.kind).toBe('inherited');
    if (outcome.kind !== 'inherited') throw new Error('unreachable');
    expect(outcome.set.proxyInstanceId).toBe(loc.operation.proxyInstanceId);
    expect([...outcome.adoptedJobIds].sort()).toEqual([mine.jobId, other.jobId].sort());
    expect(registered).toHaveLength(2);
    expect(registered.find((r) => r.jobId === loc.operation.jobId)?.committedThroughProviderSeq).toBe(5);
    expect(registered.find((r) => r.jobId === loc.operation.jobId)?.cleanup).toEqual({
      jobId: loc.operation.jobId,
      pool: 'curate',
    });

    const methodOrder = calls.map((c) => c.method);
    expect(methodOrder.indexOf('guardian.handoff-redeem.v1')).toBeLessThan(
      methodOrder.indexOf('reaper.handoff-rotate.v1'),
    );
    expect(methodOrder.indexOf('reaper.handoff-rotate.v1')).toBeLessThan(methodOrder.indexOf('handoff.redeem.v1'));
    expect(methodOrder.indexOf('handoff.redeem.v1')).toBeLessThan(methodOrder.indexOf('operation.adopt.v1'));
  });

  it('adopts a pending journal row at the proxy without registering it as executing', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const operation = operationFor(loc);
    const calls: { method: string; params: unknown }[] = [];
    const client = fakeClient(
      redemptionResponses(loc, [operation], {
        'operation.adopt.v1': { state: 'prepared', replayFromProviderSeq: 1 },
      }),
      calls,
    );
    stubConnect(client);
    mockedReadOperation.mockReturnValueOnce(activationPendingRecord(loc));
    const adopt = vi.fn();

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { adopt, operationsFor: () => [], providerRootsFor: () => [] },
        cleanupIdentityFor,
      },
      neverAborts,
    );

    expect(outcome.kind).toBe('inherited');
    expect(calls.find((call) => call.method === 'operation.adopt.v1')?.params).toEqual(
      expect.objectContaining({ committedThroughProviderSeq: 0 }),
    );
    expect(adopt).not.toHaveBeenCalled();
    if (outcome.kind === 'inherited') expect(outcome.adoptedJobIds).toEqual(new Set());
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
    mockedReadOperation.mockImplementation((_db: Database, operation) =>
      executingRecord({ operation, locator: loc.locator }),
    );

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { adopt: vi.fn(), operationsFor: () => [], providerRootsFor: () => [] },
        cleanupIdentityFor,
      },
      neverAborts,
    );

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
    mockedReadOperation.mockReturnValueOnce(null);
    const adopt = vi.fn();

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { adopt, operationsFor: () => [], providerRootsFor: () => [] },
        cleanupIdentityFor,
      },
      neverAborts,
    );

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

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { adopt: vi.fn(), operationsFor: () => [], providerRootsFor: () => [] },
        cleanupIdentityFor,
      },
      neverAborts,
    );

    expect(outcome).toEqual({ kind: 'not-bequeathed', reason: expect.stringContaining('grant_invalid') });
    // The guardian connection opened before the reaper refusal must be closed rather than leaked.
    expect(closed).toContain(loc.locator.guardian.controlEndpoint);
  });

  it('stops every heartbeat loop before closing clients when a later step fails after they start', async () => {
    // Reproduces the exact shape of the leak: all three roles redeem successfully (heartbeats start), then
    // adoption itself throws (a database failure, not a per-operation refusal `adoptRedeemedOperations`
    // already tolerates) — the only way to reach `redeem`'s `catch` with `heartbeats` non-empty.
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const op = operationFor(loc);
    const client = fakeClient(redemptionResponses(loc, [op]), []);
    stubConnect(client);
    mockedReadOperation.mockImplementation(() => {
      throw new Error('meta store unavailable');
    });
    const clearIntervalSpy = vi.spyOn(runtime.time, 'clearInterval');
    const closeSpy = vi.spyOn(client, 'close');

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { adopt: vi.fn(), operationsFor: () => [], providerRootsFor: () => [] },
        cleanupIdentityFor,
      },
      neverAborts,
    );

    expect(outcome).toEqual({ kind: 'not-bequeathed', reason: expect.stringContaining('meta store unavailable') });
    // One `clearInterval` per heartbeat loop (guardian, reaper, proxy) — a leaked loop would leave this at 0.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(3);
    // Every `clearInterval` call landed before every `close` call, mirroring `establishControl`'s own undo
    // ordering (`provider-proxy/acquisition-steps.ts`): a loop still running against an already-closed client
    // would call into an `onError` that only logs, forever.
    const clearIntervalCallOrders = clearIntervalSpy.mock.invocationCallOrder;
    const closeCallOrders = closeSpy.mock.invocationCallOrder;
    expect(closeCallOrders.length).toBeGreaterThan(0);
    expect(Math.max(...clearIntervalCallOrders)).toBeLessThan(Math.min(...closeCallOrders));
    clearIntervalSpy.mockRestore();
    closeSpy.mockRestore();
  });

  it('refuses to open any connection when the caller signal is already aborted', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const controller = new AbortController();
    controller.abort();

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { adopt: vi.fn(), operationsFor: () => [], providerRootsFor: () => [] },
        cleanupIdentityFor,
      },
      controller.signal,
    );

    expect(outcome.kind).toBe('not-bequeathed');
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it('stops redeeming the next role once the caller signal aborts between roles', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const controller = new AbortController();
    const calls: { method: string; params: unknown }[] = [];
    const client = fakeClient(
      {
        ...redemptionResponses(loc, []),
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

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { adopt: vi.fn(), operationsFor: () => [], providerRootsFor: () => [] },
        cleanupIdentityFor,
      },
      controller.signal,
    );

    expect(outcome.kind).toBe('not-bequeathed');
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
      operationRegistry: { adopt: vi.fn(), operationsFor: () => [], providerRootsFor: () => [] },
      cleanupIdentityFor,
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
      operationRegistry: { adopt: vi.fn(), operationsFor: () => [], providerRootsFor: () => [] },
      cleanupIdentityFor,
      registerInheritedSet,
    });
    const outcome = await inheritance.inheritProviderProxySet(locator(), unusedDb, neverAborts);

    expect(outcome.kind).toBe('not-bequeathed');
    expect(registerInheritedSet).not.toHaveBeenCalled();
  });

  it('registers and announces a redeemed set so pending journal phases resume', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const client = fakeClient(redemptionResponses(loc, []), []);
    stubConnect(client);
    const registerInheritedSet = vi.fn<(set: ProviderProxyOperationAuthority) => void>();
    const established = vi.fn();
    const unsubscribe = subscribeProviderProxyControlEstablished(established);

    const inheritance = createProviderProxySetInheritance({
      runtime,
      identity,
      operationRegistry: { adopt: vi.fn(), operationsFor: () => [], providerRootsFor: () => [] },
      cleanupIdentityFor,
      registerInheritedSet,
    });
    const outcome = await inheritance.inheritProviderProxySet(loc, unusedDb, neverAborts);
    const replayedOutcome = await inheritance.inheritProviderProxySet(loc, unusedDb, neverAborts);
    unsubscribe();

    expect(outcome.kind).toBe('inherited');
    expect(replayedOutcome).toBe(outcome);
    expect(registerInheritedSet).toHaveBeenCalledTimes(1);
    expect(established).toHaveBeenCalledTimes(1);
    expect(mockedConnect).toHaveBeenCalledTimes(3);
    if (outcome.kind === 'inherited') {
      expect(registerInheritedSet).toHaveBeenCalledWith(outcome.set);
    }
  });
});
