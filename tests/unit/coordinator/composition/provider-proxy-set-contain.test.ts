import { createServer } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CompositionWorldMod from '#src/coordinator/composition/world.js';
import type * as HttpHandlerMod from '#src/transport/http/handler.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

const captured = vi.hoisted(() => ({
  ports: null as HttpHandlerPorts | null,
  world: null as ReturnType<(typeof CompositionWorldMod)['createCoordinatorWorld']> | null,
}));

vi.mock('#src/transport/http/handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpHandlerMod>();
  return {
    ...actual,
    createHttpHandler: (ports: HttpHandlerPorts) => {
      captured.ports = ports;
      return actual.createHttpHandler(ports);
    },
  };
});

vi.mock('#src/coordinator/composition/world.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CompositionWorldMod>();
  return {
    ...actual,
    createCoordinatorWorld: (...args: Parameters<(typeof CompositionWorldMod)['createCoordinatorWorld']>) => {
      const world = actual.createCoordinatorWorld(...args);
      captured.world = world;
      return world;
    },
  };
});

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import type { ProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import type { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import type { CoordinatorStoreServices } from '#src/coordinator/composition/store-services-ref.js';
import type { ProviderProxySetContainmentEvidence } from '#src/provider-proxy/containment-proof-contract.js';
import type { ProviderProxySetAddress } from '#src/provider-proxy/set-address.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { JobStore } from '#src/jobs/store.js';
import type { ProviderProxySetOperatorExitResult } from '#src/coordinator/services/provider-proxy-set/index.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { setStoreServicesForTest } from '#tools/testing/store-services.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const address: ProviderProxySetAddress = {
  buildSetId: '11111111-1111-4111-8111-111111111111',
  hostFingerprint: 'a'.repeat(64),
  proxyInstanceId: '22222222-2222-4222-8222-222222222222',
};
const noEffect = {
  signalsSent: [] as const,
  containmentAbsent: false,
  representationAction: 'none' as const,
};
const capability = { setIdentity: address, issuedBy: 'composition-test' } as never;

function providerHostManager(): ProviderHostManager {
  return {
    openSession: async () => {
      throw new Error('provider host was not expected');
    },
    attachSession: async () => null,
    drainForHandoff: async () => undefined,
    shutdown: async () => undefined,
    routeAppServerOperation: () => null,
  };
}

function createHarness(): Readonly<{
  contain: NonNullable<HttpHandlerPorts['providerProxySets']>['contain'];
  db: Database;
  lifecycle: ProviderProxySetLifecycle;
  prover: NonNullable<typeof captured.world>['providerProxySetContainmentProver'];
}> {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const core = createCoordinatorCore(
    {
      runtime: createRealRuntime('prod'),
      storeFormat: currentCoralStoreFormat(),
      pluginRoot: process.cwd(),
      backendNamespace: 'provider-proxy-set-contain-composition-test',
      bootSnapshot: {
        version: 'test-version',
        bundleHash: 'test-bundle',
        flavor: 'prod',
        instanceId: 'provider-proxy-set-contain-instance',
        token: 'provider-proxy-set-contain-token',
        bootToken: 'provider-proxy-set-contain-boot-token',
        pid: process.pid,
        now: () => 10_000,
        log: () => undefined,
      },
      createServerFn: (handler) => createServer(handler),
      fetchFn: vi.fn(async () => ({ ok: true }) as never),
      providerHostManager: providerHostManager(),
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      getConsumerStuck: () => [],
    },
    async () => [],
  );
  setStoreServicesForTest(
    core.storeServicesRef,
    {
      storeDb: db,
      progressStore: { getDb: () => db } as JobStore,
      consumerDriver: null,
    } satisfies CoordinatorStoreServices,
    { storeDbPath: ':memory:' },
  );

  const world = captured.world;
  const ports = captured.ports;
  if (world === null) throw new Error('coordinator world was not captured');
  if (ports?.providerProxySets === undefined) throw new Error('provider proxy set port was not composed');
  const lifecycle = world.providerProxyLifecycleRef.get();
  if (lifecycle === null) throw new Error('provider proxy lifecycle was not composed');
  return { contain: ports.providerProxySets.contain, db, lifecycle, prover: world.providerProxySetContainmentProver };
}

let harness: ReturnType<typeof createHarness>;

beforeEach(() => {
  captured.ports = null;
  captured.world = null;
  harness = createHarness();
});

afterEach(() => {
  vi.restoreAllMocks();
  harness.db.close();
});

describe('provider proxy set operator RPC composition', () => {
  it('short-circuits an unauthorized request before containment proof', async () => {
    const authorize = vi.spyOn(harness.lifecycle, 'authorizeOperatorExit').mockReturnValue({ kind: 'set-not-found' });
    const proof = vi.spyOn(harness.prover, 'collectContainmentEvidence');
    const complete = vi.spyOn(harness.lifecycle, 'completeOperatorExit');

    await expect(harness.contain({ setIdentity: address, abandonWithoutAbsence: false })).resolves.toEqual({
      kind: 'set-not-found',
      setIdentity: address,
      effect: noEffect,
    });
    expect(authorize).toHaveBeenCalledExactlyOnceWith(address);
    expect(proof).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('completes with the issued capability after it goes stale while proof is in flight', async () => {
    vi.spyOn(harness.lifecycle, 'authorizeOperatorExit').mockReturnValue({ kind: 'authorized', capability });
    const evidence: ProviderProxySetContainmentEvidence = {
      kind: 'enforcers-observed',
      observations: [
        { role: 'guardian', observation: 'absent' },
        { role: 'reaper', observation: 'unknown' },
      ],
    };
    const proofGate = createDeferred<ProviderProxySetContainmentEvidence>();
    const proof = vi.spyOn(harness.prover, 'collectContainmentEvidence').mockReturnValue(proofGate.promise);
    let stale = false;
    const complete = vi.spyOn(harness.lifecycle, 'completeOperatorExit').mockImplementation(async () => {
      if (!stale) throw new Error('completion ran before the proof-time authorization became stale');
      return { kind: 'authorization-stale', setIdentity: address, effect: noEffect };
    });
    const signal = new AbortController().signal;

    const pending = harness.contain({ setIdentity: address, abandonWithoutAbsence: false }, signal);
    expect(proof).toHaveBeenCalledExactlyOnceWith(address, harness.db, signal);
    expect(complete).not.toHaveBeenCalled();
    stale = true;
    proofGate.resolve(evidence);

    await expect(pending).resolves.toEqual({ kind: 'authorization-stale', setIdentity: address, effect: noEffect });
    expect(complete).toHaveBeenCalledExactlyOnceWith(capability, evidence, false, signal);
  });

  it.each<Readonly<{ evidence: ProviderProxySetContainmentEvidence; result: ProviderProxySetOperatorExitResult }>>([
    {
      evidence: {
        kind: 'enforcers-observed',
        observations: [
          { role: 'guardian', observation: 'alive' },
          { role: 'reaper', observation: 'absent' },
        ],
      },
      result: {
        kind: 'enforcer-alive',
        setIdentity: address,
        enforcerObservations: [
          { role: 'guardian', observation: 'alive' },
          { role: 'reaper', observation: 'absent' },
        ],
        effect: noEffect,
      },
    },
    {
      evidence: {
        kind: 'enforcers-observed',
        observations: [
          { role: 'guardian', observation: 'absent' },
          { role: 'reaper', observation: 'unknown' },
        ],
      },
      result: {
        kind: 'enforcer-unobservable',
        setIdentity: address,
        enforcerObservations: [
          { role: 'guardian', observation: 'absent' },
          { role: 'reaper', observation: 'unknown' },
        ],
        effect: noEffect,
      },
    },
    {
      evidence: { kind: 'store-unreadable' },
      result: { kind: 'store-unreadable', setIdentity: address, effect: noEffect },
    },
  ])('passes proof refusal $result.kind through lifecycle completion', async ({ evidence, result }) => {
    vi.spyOn(harness.lifecycle, 'authorizeOperatorExit').mockReturnValue({ kind: 'authorized', capability });
    const proof = vi.spyOn(harness.prover, 'collectContainmentEvidence').mockResolvedValue(evidence);
    const complete = vi.spyOn(harness.lifecycle, 'completeOperatorExit').mockResolvedValue(result);
    const signal = new AbortController().signal;

    await expect(harness.contain({ setIdentity: address, abandonWithoutAbsence: false }, signal)).resolves.toEqual(
      result,
    );
    expect(proof).toHaveBeenCalledExactlyOnceWith(address, harness.db, signal);
    expect(complete).toHaveBeenCalledExactlyOnceWith(capability, evidence, false, signal);
  });

  it('forwards operator abandonment to lifecycle completion', async () => {
    vi.spyOn(harness.lifecycle, 'authorizeOperatorExit').mockReturnValue({ kind: 'authorized', capability });
    const evidence: ProviderProxySetContainmentEvidence = {
      kind: 'enforcers-observed',
      observations: [
        { role: 'guardian', observation: 'absent' },
        { role: 'reaper', observation: 'unknown' },
      ],
    };
    vi.spyOn(harness.prover, 'collectContainmentEvidence').mockResolvedValue(evidence);
    const result: ProviderProxySetOperatorExitResult = {
      kind: 'abandoned',
      setIdentity: address,
      enforcerObservations: evidence.observations,
      claimDischarge: { kind: 'completed' },
      effect: {
        signalsSent: [],
        containmentAbsent: false,
        representationAction: 'abandonment-release-started',
      },
    };
    const complete = vi.spyOn(harness.lifecycle, 'completeOperatorExit').mockResolvedValue(result);
    const signal = new AbortController().signal;

    await expect(harness.contain({ setIdentity: address, abandonWithoutAbsence: true }, signal)).resolves.toEqual(
      result,
    );
    expect(complete).toHaveBeenCalledExactlyOnceWith(capability, evidence, true, signal);
  });
});
