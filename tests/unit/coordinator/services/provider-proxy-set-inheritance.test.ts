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

import { readHandoffCapsuleFile } from '#src/provider-proxy/handoff-capsule.js';
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
