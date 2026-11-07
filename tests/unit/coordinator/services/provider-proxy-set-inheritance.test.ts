import { ProcessContainmentInvariantError } from '#src/infra/process-containment.js';
import { ProviderOperationJournalError } from '#src/store/provider-operation-journal.js';
import { ControlClientError, controlExchangeForTest, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  providerProxySetIdentityFromRecord,
  ProviderProxySetInheritanceCorruptionError,
} from '#src/coordinator/services/provider-proxy-set/identity.js';

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

import { handoffCapsuleV3Schema, readHandoffCapsuleFile } from '#src/provider-proxy/handoff-capsule.js';
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
  ProviderProxySetContainmentProofInvariantError,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import type { ProviderProxySetRecordedContainmentReaper } from '#src/coordinator/services/provider-proxy-set/recorded-containment-reaper.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

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
// Every test in this file drives one redemption attempt to completion synchronously (fake clients settle
// immediately), so a signal that never aborts exercises exactly the same path the never-aborted case in
// production takes; the abort/deadline-checkpoint behavior itself is covered separately.
const neverAborts = new AbortController().signal;

const GUARDIAN_INSTANCE_ID = randomUUID();
const REAPER_INSTANCE_ID = randomUUID();
const PROXY_INSTANCE_ID = randomUUID();
const BUILD_SET_ID = randomUUID();
const HOST_FINGERPRINT = 'a'.repeat(64);

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

const COORDINATOR_IDENTITY = {
  instanceId: randomUUID(),
  pid: 1,
  incarnation: testIncarnation(900),
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: BUILD_SET_ID,
};

describe('attemptProviderProxySetInheritance', () => {
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
});

it.each(['open', 'first-heartbeat'] as const)(
  'retries EPIPE through real redemption and inheritance at %s without global fatal',
  async (stage) => {
    const loc = locator();
    const identity = providerProxySetIdentityFromRecord(loc);
    const { canonicalEndpoint, ...capsuleIdentity } = identity;
    const capsule = handoffCapsuleV3Schema.parse({
      ...capsuleIdentity,
      proxyEndpoint: canonicalEndpoint,
      version: 3,
      generation: 'gen2',
      flavor: 'prod',
      grantId: randomUUID(),
      secret: 'a'.repeat(64),
      orphanTimeoutMs: 60000,
      teardownReserveMs: 1000,
    });
    mockedReadCapsule.mockReturnValue(capsule);
    const pipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const failure = controlExchangeForTest({
      kind: 'delivery-unconfirmed',
      cause: 'socket-error-after-write',
      error: pipe,
    });
    const shared = { generation: 'gen2', flavor: 'prod', buildSetId: BUILD_SET_ID, hostFingerprint: HOST_FINGERPRINT };
    const guardian = {
      ...shared,
      guardianInstanceId: GUARDIAN_INSTANCE_ID,
      pid: 100,
      incarnation: testIncarnation(1),
      canonicalControlEndpoint: '/tmp/guardian.sock',
    };
    const reaper = {
      ...shared,
      reaperInstanceId: REAPER_INSTANCE_ID,
      pid: 300,
      incarnation: testIncarnation(2),
      guardianInstanceId: GUARDIAN_INSTANCE_ID,
      canonicalControlEndpoint: '/tmp/reaper.sock',
      containmentKind: 'posix-group',
    };
    const exchange = vi.fn<ControlClient['exchange']>(async (method) =>
      stage === 'first-heartbeat' && method === 'guardian.handoff-redeem.v1'
        ? controlExchangeForTest({
            kind: 'response',
            response: {
              kind: 'result',
              value: {
                state: 'redeemed-provisional',
                controlEpoch: 1,
                heartbeatChallenge: 'b'.repeat(64),
                redemptionReceipt: 'receipt',
                operations: [],
                guardian,
                reaper,
                containment: {
                  pid: identity.proxyPid,
                  incarnation: identity.proxyIncarnation,
                  processGroupId: identity.proxyProcessGroupId,
                  containmentKind: identity.containmentKind,
                },
              },
            },
          })
        : failure,
    );
    const close = vi.fn();
    mockedConnect.mockResolvedValue({ exchange, close, faulted: new Promise(() => {}), onFault: () => () => {} });
    const collectContainmentProof = vi.spyOn(defaultContainmentProver, 'collectContainmentProof');
    const reapRecordedContainment = vi.fn(unexpectedInheritanceRecordedContainmentReap);
    const fatal = vi.fn();
    const retry = vi.fn();
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const inherit = vi.fn(async () =>
      attemptProviderProxySetInheritance(
        loc,
        db,
        {
          runtime,
          coordinatorIdentity: COORDINATOR_IDENTITY,
          operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
          collectContainmentProof: defaultContainmentProver.collectContainmentProof,
          reapRecordedContainment,
        },
        neverAborts,
      ),
    );
    const dispatcher = createTestProviderProxyRecoveryDispatcher({ 'set-inheritance': inherit }, fatal);
    try {
      dispatcher.begin('ordinary-set-inheritance', {}, { evidence: vi.fn(), retry, fatal }).start({
        sourceId: 'inheritance',
        producerId: 'set-inheritance',
        input: { locator: loc, db, signal: neverAborts },
      });
      await vi.waitFor(() => {
        expect(fatal).not.toHaveBeenCalled();
        expect(retry).toHaveBeenCalledOnce();
      });
      const outcome = await inherit.mock.results[0].value;
      expect(outcome).toMatchObject({
        kind: 'temporarily-unavailable',
        incident:
          stage === 'open'
            ? { kind: 'role-open-indeterminate', exchange: failure }
            : { kind: 'role-heartbeat-indeterminate', observation: { kind: 'delivery-unconfirmed', error: pipe } },
      });
      expect(mockedConnect).toHaveBeenCalledOnce();
      expect(exchange.mock.calls.map(([method]) => method)).toEqual(
        stage === 'open' ? ['guardian.handoff-redeem.v1'] : ['guardian.handoff-redeem.v1', 'guardian.heartbeat.v1'],
      );
      expect(close).toHaveBeenCalledOnce();
      expect(collectContainmentProof).toHaveBeenCalledOnce();
      expect(reapRecordedContainment).not.toHaveBeenCalled();
      expect(fatal).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  },
);

it.each(['startup-set-inheritance', 'ordinary-set-inheritance', 'containment-attempt'] as const)(
  'holds unknown observation rejections locally at %s',
  async (seam) => {
    const fatal = vi.fn();
    const retry = vi.fn();
    const producerId = seam === 'containment-attempt' ? 'containment-proof' : 'set-inheritance';
    const dispatcher = createTestProviderProxyRecoveryDispatcher(
      {
        [producerId]: async () => {
          throw Object.assign(new Error('x'.repeat(1024)), { code: 'EOBSERVATION' });
        },
      },
      fatal,
    );
    const turn = dispatcher.begin(
      seam,
      { setIdentity: providerProxySetIdentityFromRecord(locator()) },
      {
        evidence: vi.fn(),
        retry,
        fatal,
      },
    );
    if (producerId === 'set-inheritance') {
      turn.start({
        sourceId: 'observation',
        producerId,
        input: { locator: locator(), db: unusedDb, signal: neverAborts },
      });
    } else {
      turn.start({
        sourceId: 'observation',
        producerId,
        input: { identity: providerProxySetIdentityFromRecord(locator()), signal: neverAborts },
      });
    }
    await vi.waitFor(() =>
      expect(retry).toHaveBeenCalledWith({
        producerId,
        incident: {
          kind: 'observation-unknown',
          producerId,
          diagnostic: { name: 'Error', code: 'EOBSERVATION', message: expect.any(String) },
        },
      }),
    );
    expect(retry.mock.calls[0]?.[0].incident.diagnostic.message).toHaveLength(512);
    expect(fatal).not.toHaveBeenCalled();
  },
);

it('keeps a malformed inheritance result coordinator-fatal', async () => {
  const fatal = vi.fn();
  const retry = vi.fn();
  const dispatcher = createTestProviderProxyRecoveryDispatcher(
    {
      'set-inheritance': async () => ({ kind: 'invalid' }) as never,
    },
    fatal,
  );
  dispatcher.begin('startup-set-inheritance', {}, { evidence: vi.fn(), retry, fatal }).start({
    sourceId: 'inheritance',
    producerId: 'set-inheritance',
    input: { locator: locator(), db: unusedDb, signal: neverAborts },
  });
  await vi.waitFor(() => expect(fatal).toHaveBeenCalled());
  expect(fatal.mock.calls[0]?.[0]).toMatchObject({
    name: 'ProviderProxySetLifecycleFatalError',
    cause: expect.any(Error),
  });
  expect(retry).not.toHaveBeenCalled();
});

it.each([
  new ProcessContainmentInvariantError('process_containment_reap_failed', 'Recorded target count exceeds the limit.'),
  new ProviderProxySetContainmentProofInvariantError('provider_proxy_set_containment_proof_identity_mismatch'),
  new ProviderOperationJournalError('corrupt operation journal'),
  new ProviderProxySetInheritanceCorruptionError('durable_identity_disagreement', 'durable identity mismatch'),
])('keeps a fallback containment invariant fatal: %s', async (invariant) => {
  const loc = locator();
  const identity = providerProxySetIdentityFromRecord(loc);
  const { canonicalEndpoint, ...capsuleIdentity } = identity;
  mockedReadCapsule.mockReturnValue(
    handoffCapsuleV3Schema.parse({
      ...capsuleIdentity,
      proxyEndpoint: canonicalEndpoint,
      version: 3,
      generation: 'gen2',
      flavor: 'prod',
      grantId: randomUUID(),
      secret: 'a'.repeat(64),
      orphanTimeoutMs: 60000,
      teardownReserveMs: 1000,
    }),
  );
  const close = vi.fn();
  mockedConnect.mockResolvedValue({
    exchange: async () =>
      controlExchangeForTest({
        kind: 'delivery-unconfirmed',
        cause: 'socket-error-after-write',
        error: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
      }),
    close,
    faulted: new Promise(() => {}),
    onFault: () => () => {},
  });
  const collectContainmentProof = vi.fn(async (): Promise<never> => {
    throw invariant;
  });
  const fatal = vi.fn();
  const retry = vi.fn();
  const inherit = () =>
    attemptProviderProxySetInheritance(
      loc,
      unusedDb,
      {
        runtime,
        coordinatorIdentity: COORDINATOR_IDENTITY,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        collectContainmentProof,
      },
      neverAborts,
    );
  const dispatcher = createTestProviderProxyRecoveryDispatcher({ 'set-inheritance': inherit }, fatal);
  dispatcher.begin('startup-set-inheritance', { setIdentity: identity }, { evidence: vi.fn(), retry, fatal }).start({
    sourceId: 'inheritance',
    producerId: 'set-inheritance',
    input: { locator: loc, db: unusedDb, signal: neverAborts },
  });
  await vi.waitFor(() => expect(fatal).toHaveBeenCalled());
  expect(collectContainmentProof).toHaveBeenCalledOnce();
  expect(fatal.mock.calls[0]?.[0]).toMatchObject({ name: 'ProviderProxySetLifecycleFatalError', cause: invariant });
  expect(retry).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it.each(['grant_replayed', 'grant_invalid', 'identity_mismatch'] as const)(
  'classifies an inheritance authority denial by protocol code: %s',
  async (protocolCode) => {
    const loc = locator();
    const identity = providerProxySetIdentityFromRecord(loc);
    const { canonicalEndpoint, ...capsuleIdentity } = identity;
    mockedReadCapsule.mockReturnValue(
      handoffCapsuleV3Schema.parse({
        ...capsuleIdentity,
        proxyEndpoint: canonicalEndpoint,
        version: 3,
        generation: 'gen2',
        flavor: 'prod',
        grantId: randomUUID(),
        secret: 'a'.repeat(64),
        orphanTimeoutMs: 60000,
        teardownReserveMs: 1000,
      }),
    );
    const failure = {
      kind: 'json-rpc-error' as const,
      jsonRpcCode: -32600,
      protocolCode,
      admissionReason: null,
      heartbeatRefusal: null,
    };
    const close = vi.fn();
    mockedConnect.mockResolvedValue({
      exchange: async () =>
        controlExchangeForTest({
          kind: 'response',
          response: {
            kind: 'refusal',
            failure,
            error: new ControlClientError('control_call_failed', 'grant denied', 'remote-response', failure),
          },
        }),
      close,
      faulted: new Promise(() => {}),
      onFault: () => () => {},
    });
    const fatal = vi.fn();
    const retry = vi.fn();
    const inherit = () =>
      attemptProviderProxySetInheritance(
        loc,
        unusedDb,
        {
          runtime,
          coordinatorIdentity: COORDINATOR_IDENTITY,
          operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        },
        neverAborts,
      );
    const dispatcher = createTestProviderProxyRecoveryDispatcher({ 'set-inheritance': inherit }, fatal);
    dispatcher.begin('startup-set-inheritance', { setIdentity: identity }, { evidence: vi.fn(), retry, fatal }).start({
      sourceId: 'inheritance',
      producerId: 'set-inheritance',
      input: { locator: loc, db: unusedDb, signal: neverAborts },
    });
    if (protocolCode === 'identity_mismatch') {
      await vi.waitFor(() => expect(fatal).toHaveBeenCalled());
      expect(fatal.mock.calls[0]?.[0]).toMatchObject({
        name: 'ProviderProxySetLifecycleFatalError',
        cause: expect.objectContaining({
          name: 'ProviderProxyRoleControlRemoteError',
          remoteFailure: expect.objectContaining({ protocolCode }),
        }),
      });
      expect(retry).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() =>
        expect(retry).toHaveBeenCalledWith({
          producerId: 'set-inheritance',
          incident: { kind: 'observation-refused', producerId: 'set-inheritance' },
        }),
      );
      expect(fatal).not.toHaveBeenCalled();
    }
    expect(close).toHaveBeenCalledOnce();
  },
);

it('keeps the production refused capsule route fatal at the recovery dispatcher', async () => {
  const loc = locator();
  const identity = providerProxySetIdentityFromRecord(loc);
  const { canonicalEndpoint, ...fields } = identity;
  const capsule = handoffCapsuleV3Schema.parse({
    ...fields,
    proxyEndpoint: canonicalEndpoint,
    version: 3,
    generation: 'gen2',
    flavor: 'prod',
    grantId: randomUUID(),
    secret: 'a'.repeat(64),
    orphanTimeoutMs: 60_000,
    teardownReserveMs: 14_000,
  });
  const unexpected = (): never => {
    throw new Error('Unexpected inheritance admission');
  };
  const inheritance = createProviderProxySetInheritance({
    runtime,
    identity: { ...COORDINATOR_IDENTITY, buildSetId: randomUUID() },
    operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
    containmentProver: defaultContainmentProver,
    reapRecordedContainment: unexpectedInheritanceRecordedContainmentReap,
    acquisitionFor: unexpected,
    releaseInheritanceAdmission: unexpected,
    registerInheritedSet: unexpected,
  });
  const fatal = vi.fn();
  const retry = vi.fn();
  const dispatcher = createTestProviderProxyRecoveryDispatcher(
    {
      'capsule-redemption': ({ capsule, capsulePath, signal }) =>
        inheritance.redeemDiscoveredCapsule(capsule, capsulePath, signal),
    },
    fatal,
  );
  dispatcher
    .begin('exact-capsule-recovery', { setIdentity: identity, capsule }, { evidence: vi.fn(), retry, fatal })
    .start({
      sourceId: 'redemption',
      producerId: 'capsule-redemption',
      input: { capsule, capsulePath: '/unused.handoff.v3.json', signal: neverAborts },
    });
  await vi.waitFor(() => expect(fatal).toHaveBeenCalled());
  expect(fatal.mock.calls[0]?.[0]).toMatchObject({
    name: 'ProviderProxySetLifecycleFatalError',
    cause: expect.any(ProviderProxySetInheritanceCorruptionError),
  });
  expect(fatal.mock.calls[0]?.[0].cause.code).toBe('capsule_identity_disagreement');
  expect(retry).not.toHaveBeenCalled();
  expect(mockedConnect).not.toHaveBeenCalled();
});
