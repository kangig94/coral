import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';

vi.mock('#src/provider-proxy/handoff-capsule.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, readHandoffCapsuleFile: vi.fn(() => null) };
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
  type HandoffCapsuleV3,
  type HandoffCapsuleV4,
} from '#src/provider-proxy/handoff-capsule.js';
import {
  ControlClientError,
  controlExchangeForTest,
  type ControlClient,
  type ControlExchange,
} from '#src/provider-proxy/control-client.js';
import { providerProxyDisappearanceReceipt } from '#src/provider-proxy/protocol.js';
import { connectRoleControlWithRetry } from '#src/provider-proxy/role-spawn.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  attemptProviderProxySetInheritance as attemptProviderProxySetInheritanceWithRequiredContainment,
  createProviderProxySetInheritance,
  type CreateProviderProxySetInheritanceOptions,
  type ProviderProxySetInheritanceDeps,
  type ProviderProxySetLocator,
} from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import {
  createProviderProxySetContainmentProver,
  providerProxySetContainmentEvidenceFor,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import type { ProviderProxySetRecordedContainmentReaper } from '#src/coordinator/services/provider-proxy-set/recorded-containment-reaper.js';
import { isProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import {
  createTestProviderProxyContainmentProofProducer,
  createTestProviderProxyRecoveryDispatcher,
} from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { testProviderProxySetLifecycleDurability } from '#tests/helpers/provider-proxy-set-lifecycle-durability.js';

/** The build this fixture lifecycle belongs to — the same one `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';

const mockedReadCapsule = vi.mocked(readHandoffCapsuleFile);
const mockedConnect = vi.mocked(connectRoleControlWithRetry);
const mockedProbe = vi.mocked(probeProcessIncarnation);

const realRuntime = createRealRuntime('prod');
const runtime = {
  ...realRuntime,
  process: {
    ...realRuntime.process,
    readProcessIncarnation: (pid: number, platform: NodeJS.Platform) => mockedProbe(pid, platform),
  },
};
const unusedDb = newRawDatabase(':memory:');
applyBundledStoreSchema(unusedDb, currentCoralStoreFormat());
const defaultContainmentProver = createProviderProxySetContainmentProver({
  ...runtime,
  process: {
    ...runtime.process,
    readProcessIncarnation: () => null,
    observeLiveness: () => 'unknown',
  },
});
const unexpectedInheritanceRecordedContainmentReap: ProviderProxySetRecordedContainmentReaper = (): never => {
  throw new Error('provider proxy inheritance fixture unexpectedly requested recorded containment reaping');
};
const defaultInheritanceContainmentDeps = {
  collectContainmentProof: defaultContainmentProver.collectContainmentProof,
  reapRecordedContainment: unexpectedInheritanceRecordedContainmentReap,
};
const inheritanceReaperIsRequired: Record<PropertyKey, never> extends Pick<
  ProviderProxySetInheritanceDeps,
  'reapRecordedContainment'
>
  ? false
  : true = true;
const composedInheritanceReaperIsRequired: Record<PropertyKey, never> extends Pick<
  CreateProviderProxySetInheritanceOptions,
  'reapRecordedContainment'
>
  ? false
  : true = true;
void inheritanceReaperIsRequired;
void composedInheritanceReaperIsRequired;
type TestInheritanceDeps = Omit<
  ProviderProxySetInheritanceDeps,
  'collectContainmentProof' | 'reapRecordedContainment'
> &
  Partial<Pick<ProviderProxySetInheritanceDeps, 'collectContainmentProof' | 'reapRecordedContainment'>>;
function attemptProviderProxySetInheritance(
  locator: ProviderProxySetLocator,
  db: Database,
  deps: TestInheritanceDeps,
  signal: AbortSignal,
) {
  return attemptProviderProxySetInheritanceWithRequiredContainment(
    locator,
    db,
    { ...defaultInheritanceContainmentDeps, ...deps },
    signal,
  );
}
const reapRecordedEvidence: ProviderProxySetRecordedContainmentReaper = async (identity, proof) => {
  const evidence = providerProxySetContainmentEvidenceFor(proof, identity);
  if (evidence.kind !== 'reap-required') throw new Error(`expected reap-required, received ${evidence.kind}`);
  return {
    kind: 'containment-absent',
    disappearanceReceipt: providerProxyDisappearanceReceipt(evidence.containment, evidence.recordedRoots),
  };
};
const unexpectedLifecycleRecordedContainmentReap = (): never => {
  throw new Error('provider proxy inheritance fixture unexpectedly requested lifecycle recorded containment reaping');
};
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

beforeEach(() => {
  vi.clearAllMocks();
  mockedReadCapsule.mockImplementation(() => null);
  mockedProbe.mockImplementation(() => testIncarnation(1_700_000_000));
});

// The current generation, because that is the only one this build may inherit: a capsule whose identity it
// cannot read is represented and never dialed, whatever the number on it.
function capsuleFor(reference: ProviderProxySetLocator, overrides: Partial<HandoffCapsuleV4> = {}): HandoffCapsule {
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
    controllerBuildSetId: operation.buildSetId,
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

async function scriptedHeartbeatExchange(
  responses: Record<string, unknown | ((params: unknown) => unknown)>,
  calls: { method: string; params: unknown }[],
  method: string,
  params: unknown,
): Promise<ControlExchange> {
  calls.push({ method, params });
  const entry = responses[method];
  if (entry === undefined) throw new Error(`unexpected exchange to ${method}`);
  try {
    const value = typeof entry === 'function' ? (entry as (value: unknown) => unknown)(params) : entry;
    return controlExchangeForTest({ kind: 'response', response: { kind: 'result', value } });
  } catch (error: unknown) {
    if (!(error instanceof ControlClientError)) throw error;
    if (error.remoteFailure !== null) {
      return controlExchangeForTest({
        kind: 'response',
        response: { kind: 'refusal', failure: error.remoteFailure, error },
      });
    }
    if (error.origin === 'timeout') return controlExchangeForTest({ kind: 'no-response', cause: 'timeout', error });
    return controlExchangeForTest({ kind: 'not-sent', cause: 'connection-already-closed', error });
  }
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
    exchange: (method, params) => scriptedHeartbeatExchange(responses, calls, method, params),
    faulted,
    onFault: () => () => undefined,
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
  const installAck = (params: unknown) => ({
    state: 'installed-dormant',
    grantId: (params as { grantId: string }).grantId,
  });
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
    'guardian.acquisition-publish.v1': {
      state: 'acquisition-published',
      certificate: 'publication-certificate',
      guardian: guardianIdentityFor(loc),
      reaper: reaperIdentityFor(loc),
    },
    'proxy.acquisition-publish.v1': { state: 'acquisition-published' },
    'guardian.handoff-install.v1': installAck,
    'reaper.handoff-install.v1': installAck,
    'handoff.install.v1': installAck,
    ...overrides,
  };
}

describe('attemptProviderProxySetInheritance', () => {
  // A set spawned by an older build keeps the capsule that build wrote, at that generation's own address.
  it('reads a set capsule written at an older supported generation address', async () => {
    const loc = locator({ buildSetId: '77777777-7777-4777-8777-777777777777' });
    const { controllerBuildSetId: _controller, ...currentFields } = capsuleFor(loc) as HandoffCapsuleV4;
    const olderGeneration: HandoffCapsuleV3 = { ...currentFields, version: 3 };
    mockedReadCapsule.mockImplementation((path) => (path.endsWith('.handoff.v3.json') ? olderGeneration : null));

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

    expect(outcome).toEqual({ kind: 'not-bequeathed', reason: 'the set is controlled by another build' });
    expect(mockedReadCapsule.mock.calls.map(([path]) => path.slice(path.indexOf('.handoff')))).toEqual([
      '.handoff.v4.json',
      '.handoff.v3.json',
    ]);
  });

  it('reaps exact containment evidence instead of treating a missing credential as authority to proceed', async () => {
    mockedReadCapsule.mockReturnValueOnce(null);
    const loc = locator();
    const containmentProver = createProviderProxySetContainmentProver({
      ...runtime,
      process: {
        ...runtime.process,
        readProcessIncarnation: () => null,
        observeLiveness: () => 'absent',
      },
    });
    const collectContainmentProof = vi.spyOn(containmentProver, 'collectContainmentProof');
    const reapRecordedContainment = vi.fn(async () => ({
      kind: 'containment-absent' as const,
      disappearanceReceipt: 'group:200,leader:200@linux:00000000-0000-4000-8000-000000000000:3',
    }));

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        collectContainmentProof: containmentProver.collectContainmentProof,
        reapRecordedContainment,
      },
      neverAborts,
    );

    expect(outcome).toEqual({
      kind: 'containment-disappeared',
      disappearanceReceipt: 'group:200,leader:200@linux:00000000-0000-4000-8000-000000000000:3',
    });
    expect(collectContainmentProof).toHaveBeenCalledWith(expect.any(Object), unusedDb, neverAborts);
    expect(reapRecordedContainment).toHaveBeenCalledWith(
      providerProxySetIdentityFromRecord(loc),
      expect.any(Object),
      neverAborts,
      expect.any(Function),
    );
    expect(reapRecordedContainment).toHaveBeenCalledOnce();
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it('should keep installing a served transfer recovery grant until the host acknowledges it', async () => {
    const time = new VirtualTime();
    const inheritedRuntime = { ...runtime, time };
    const loc = locator({ buildSetId: '77777777-7777-4777-8777-777777777777' });
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const calls: { method: string; params: unknown }[] = [];
    let guardianInstalls = 0;
    const client = fakeClient(
      redemptionResponses(loc, matchingOperationSets([]), {
        'guardian.handoff-install.v1': (params: unknown) => {
          guardianInstalls += 1;
          if (guardianInstalls === 1) {
            throw new ControlClientError('control_call_failed', 'the guardian did not answer', 'timeout');
          }
          return { state: 'installed-dormant', grantId: (params as { grantId: string }).grantId };
        },
      }),
      calls,
    );
    stubConnect(client);

    const outcome = await attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime: inheritedRuntime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        acceptsControllerTransfer: () => 'served',
      },
      neverAborts,
    );

    if (outcome.kind !== 'inherited') throw new Error('inheritance did not return its operation authority');
    try {
      expect(calls.some(({ method }) => method === 'handoff.install.v1')).toBe(false);
      time.tick(1_000);
      await flushMicrotasks();
      expect(calls.some(({ method }) => method === 'handoff.install.v1')).toBe(true);
      expect(guardianInstalls).toBe(2);
    } finally {
      outcome.set.stopHeartbeats();
      await outcome.set.initiateControlClose();
    }
  });

  it('closes every already-opened connection and rejects when a later role refusal leaves control ambiguous', async () => {
    const loc = locator();
    mockedReadCapsule.mockReturnValueOnce(capsuleFor(loc));
    const closed: string[] = [];
    mockedConnect.mockImplementation(async (socketPath: string) => ({
      exchange: async (method: string) => {
        if (method === 'guardian.handoff-redeem.v1') {
          return controlExchangeForTest({
            kind: 'response' as const,
            response: {
              kind: 'result' as const,
              value: {
                ...OPENING,
                state: 'redeemed-provisional',
                redemptionReceipt: 'g',
                operations: [],
                guardian: guardianIdentityFor(loc),
                reaper: reaperIdentityFor(loc),
                containment: containmentFor(loc),
              },
            },
          });
        }
        if (method === 'guardian.heartbeat.v1') {
          return controlExchangeForTest({
            kind: 'response' as const,
            response: {
              kind: 'result' as const,
              value: { state: 'active', nextHeartbeatChallenge: 'g2' },
            },
          });
        }
        if (method === 'reaper.handoff-rotate.v1') throw new Error('grant_invalid: replayed');
        throw new Error(`unexpected exchange ${method} for ${socketPath}`);
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
          throw new ControlClientError(
            'control_call_failed',
            'Heartbeat echo was not accepted (teardown-latched).',
            'remote-response',
            {
              kind: 'json-rpc-error',
              jsonRpcCode: -32600,
              protocolCode: 'invalid_request',
              admissionReason: null,
              heartbeatRefusal: { reason: 'teardown-latched', nextHeartbeatChallenge: null },
            },
          );
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
      ...testProviderProxySetLifecycleDurability(runtime.storage, time),
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
        'containment-proof': createTestProviderProxyContainmentProofProducer(inheritedRuntime, unusedDb),
        'disappearance-consumer': async ({ notice }) => ({
          kind: 'accepted',
          acceptance: { kind: 'accepted', operation: notice.operation, disposition: 'record-absent' },
        }),
      }),
      reapRecordedContainment: unexpectedLifecycleRecordedContainmentReap,
      reportLifecycle: () => undefined,
    });
    lifecycle.activateDurableOperatorDispositions();
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();

    const inheritance = createProviderProxySetInheritance({
      runtime: inheritedRuntime,
      containmentProver: createProviderProxySetContainmentProver(inheritedRuntime),
      reapRecordedContainment: reapRecordedEvidence,
      identity,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      registerInheritedSet: (set, publicationReceipt) => {
        if (!isProviderProxyOperationAuthority(set)) throw new Error('expected durable authority');
        lifecycle.registerInheritedSet(set, publicationReceipt);
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
