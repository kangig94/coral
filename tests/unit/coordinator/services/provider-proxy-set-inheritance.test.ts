import { controlExchangeForTest, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
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

import { handoffCapsuleV3Schema, readHandoffCapsuleFile } from '#src/provider-proxy/handoff-capsule.js';
import { connectRoleControlWithRetry } from '#src/provider-proxy/role-spawn.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  attemptProviderProxySetInheritance as attemptProviderProxySetInheritanceWithRequiredContainment,
  type CreateProviderProxySetInheritanceOptions,
  type ProviderProxySetInheritanceDeps,
  type ProviderProxySetLocator,
} from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import { createProviderProxySetContainmentProver } from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
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
