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
import type {
  ProviderProxySetContainmentProof,
  ProviderProxySetContainmentProofAuthorization,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import type { ProviderProxySetAddress } from '#src/provider-proxy/set-address.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Principal } from '#src/security/principal.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { JobStore } from '#src/jobs/store.js';
import type { ProviderProxySetOperatorExitResult } from '#src/coordinator/services/provider-proxy-set/index.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { providerProxySetContainBooleanRpcSpec, providerProxySetContainRpcSpec } from '#src/transport/rpc/catalog.js';
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
const proofAuthorization = {} as ProviderProxySetContainmentProofAuthorization;
const handback = vi.fn();
const capability = { setIdentity: address, containmentProofAuthorization: proofAuthorization, handback } as never;
const opaqueProof = {} as ProviderProxySetContainmentProof;
const operator: Principal = {
  subject: 'operator',
  transport: 'ipc',
  credential: { kind: 'boot-token', id: 'operator' },
  binding: { kind: 'unbound' },
};

function providerHostManager(): ProviderHostManager {
  return {
    openSession: async () => {
      throw new Error('provider host was not expected');
    },
    attachSession: async () => null,
    drainForHandoff: async () => ({
      kind: 'provider-hosts-quiesced',
      liveProxySets: [],
      acquisitionCleanupHolds: [],
      closingHosts: [],
    }),
    shutdown: async () => ({
      kind: 'provider-hosts-quiesced',
      liveProxySets: [],
      acquisitionCleanupHolds: [],
      closingHosts: [],
    }),
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
  setStoreServicesForTest(core.storeServicesRef, {
    storeDb: db,
    progressStore: { getDb: () => db } as JobStore,
    consumerDriver: null,
  } satisfies CoordinatorStoreServices);

  const world = captured.world;
  const ports = captured.ports;
  if (world === null) throw new Error('coordinator world was not captured');
  if (ports?.providerProxySets === undefined) throw new Error('provider proxy set port was not composed');
  const lifecycle = world.providerProxyLifecycleRef.get();
  if (lifecycle === null) throw new Error('provider proxy lifecycle was not composed');
  return {
    contain: ports.providerProxySets.contain,
    db,
    lifecycle,
    prover: world.providerProxySetContainmentProver,
  };
}

let harness: ReturnType<typeof createHarness>;

beforeEach(() => {
  captured.ports = null;
  captured.world = null;
  handback.mockClear();
  harness = createHarness();
});

afterEach(() => {
  vi.restoreAllMocks();
  harness.db.close();
});

describe('provider proxy set operator RPC composition', () => {
  it('short-circuits an unauthorized request before containment proof', async () => {
    const authorize = vi.spyOn(harness.lifecycle, 'authorizeOperatorExit').mockReturnValue({ kind: 'set-not-found' });
    const proof = vi.spyOn(harness.prover, 'collectContainmentProof');
    const complete = vi.spyOn(harness.lifecycle, 'completeOperatorExit');

    await expect(harness.contain({ setIdentity: address, mode: 'contain' })).resolves.toEqual({
      kind: 'set-not-found',
      setIdentity: address,
      effect: noEffect,
    });
    expect(authorize).toHaveBeenCalledExactlyOnceWith(address);
    expect(proof).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('answers a boolean abandonment request with its strict response generation', async () => {
    const authorize = vi
      .spyOn(harness.lifecycle, 'authorizeBooleanOperatorExit')
      .mockReturnValue({ kind: 'authorized', capability });
    vi.spyOn(harness.prover, 'collectContainmentProof').mockResolvedValue(opaqueProof);
    const complete = vi.spyOn(harness.lifecycle, 'completeBooleanOperatorExit').mockResolvedValue({
      kind: 'unattributable-group-abandoned',
      setIdentity: address,
      claimDischarge: { kind: 'initial-disposition-pending', exit: 'initial-disposition-settlement' },
      effect: {
        signalsSent: ['SIGTERM'],
        containmentAbsent: false,
        representationAction: 'abandonment-release-started',
      },
    });

    const request = providerProxySetContainBooleanRpcSpec.requestSchema.parse({
      setIdentity: address,
      abandonWithoutAbsence: true,
    });

    const ports = captured.ports;
    if (ports === null) throw new Error('coordinator ports were not captured');
    await expect(
      executeCatalogRequest(providerProxySetContainBooleanRpcSpec, request, ports, operator),
    ).resolves.toEqual({
      kind: 'unary',
      body: {
        kind: 'unattributable-group-abandoned',
        setIdentity: address,
        claimDischarge: { kind: 'initial-disposition-retry-owned' },
        effect: {
          signalsSent: ['SIGTERM'],
          containmentAbsent: false,
          representationAction: 'abandonment-release-started',
        },
      },
    });
    expect(authorize).toHaveBeenCalledExactlyOnceWith(address);
    expect(complete).toHaveBeenCalledExactlyOnceWith(capability, opaqueProof, true, undefined);
  });

  it('returns each RPC contract after current completion observes a fatal release successor', async () => {
    const effect = {
      signalsSent: ['SIGTERM'] as const,
      containmentAbsent: true,
      representationAction: 'absence-release-started' as const,
    };
    vi.spyOn(harness.prover, 'collectContainmentProof').mockResolvedValue(opaqueProof);
    vi.spyOn(harness.lifecycle, 'authorizeOperatorExit').mockReturnValue({ kind: 'authorized', capability });
    vi.spyOn(harness.lifecycle, 'completeOperatorExit').mockResolvedValue({
      kind: 'representation-release-abandonment-required',
      setIdentity: address,
      effect,
    });
    const ports = captured.ports;
    if (ports === null) throw new Error('coordinator ports were not captured');

    await expect(
      executeCatalogRequest(
        providerProxySetContainRpcSpec,
        providerProxySetContainRpcSpec.requestSchema.parse({ setIdentity: address, mode: 'contain' }),
        ports,
        operator,
      ),
    ).resolves.toEqual({
      kind: 'unary',
      body: { kind: 'representation-release-abandonment-required', setIdentity: address, effect },
    });

    vi.spyOn(harness.lifecycle, 'authorizeBooleanOperatorExit').mockReturnValue({ kind: 'authorized', capability });
    vi.spyOn(harness.lifecycle, 'completeBooleanOperatorExit').mockResolvedValue({
      kind: 'contained',
      setIdentity: address,
      disappearanceReceipt: 'operator-observed-absence',
      claimDischarge: { kind: 'initial-disposition-pending', exit: 'initial-disposition-settlement' },
      effect,
    });
    await expect(
      executeCatalogRequest(
        providerProxySetContainBooleanRpcSpec,
        providerProxySetContainBooleanRpcSpec.requestSchema.parse({
          setIdentity: address,
          abandonWithoutAbsence: false,
        }),
        ports,
        operator,
      ),
    ).resolves.toEqual({
      kind: 'unary',
      body: {
        kind: 'contained',
        setIdentity: address,
        disappearanceReceipt: 'operator-observed-absence',
        claimDischarge: { kind: 'initial-disposition-retry-owned' },
        effect,
      },
    });
  });

  it('refuses a legacy-only state before authorization or containment-proof collection', async () => {
    const authorizeBoolean = vi
      .spyOn(harness.lifecycle, 'authorizeBooleanOperatorExit')
      .mockReturnValue({ kind: 'unsupported-contract' });
    const authorizeCurrent = vi.spyOn(harness.lifecycle, 'authorizeOperatorExit');
    const proof = vi.spyOn(harness.prover, 'collectContainmentProof');
    const complete = vi.spyOn(harness.lifecycle, 'completeBooleanOperatorExit');
    const request = providerProxySetContainBooleanRpcSpec.requestSchema.parse({
      setIdentity: address,
      abandonWithoutAbsence: true,
    });
    const ports = captured.ports;
    if (ports === null) throw new Error('coordinator ports were not captured');

    await expect(
      executeCatalogRequest(providerProxySetContainBooleanRpcSpec, request, ports, operator),
    ).resolves.toEqual({
      kind: 'unsupported-method',
      statusCode: 404,
      body: {
        code: 'unsupported_method',
        message: 'The legacy containment contract cannot represent this provider-proxy set state.',
      },
    });
    expect(authorizeBoolean).toHaveBeenCalledExactlyOnceWith(address);
    expect(authorizeCurrent).not.toHaveBeenCalled();
    expect(proof).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('completes with the issued capability after it goes stale while proof is in flight', async () => {
    vi.spyOn(harness.lifecycle, 'authorizeOperatorExit').mockReturnValue({ kind: 'authorized', capability });
    const proofGate = createDeferred<ProviderProxySetContainmentProof>();
    const proof = vi.spyOn(harness.prover, 'collectContainmentProof').mockReturnValue(proofGate.promise);
    let stale = false;
    const complete = vi.spyOn(harness.lifecycle, 'completeOperatorExit').mockImplementation(async () => {
      if (!stale) throw new Error('completion ran before the proof-time authorization became stale');
      return { kind: 'authorization-stale', setIdentity: address, effect: noEffect };
    });
    const signal = new AbortController().signal;

    const pending = harness.contain({ setIdentity: address, mode: 'contain' }, signal);
    expect(proof).toHaveBeenCalledExactlyOnceWith(proofAuthorization, harness.db, signal);
    expect(complete).not.toHaveBeenCalled();
    stale = true;
    proofGate.resolve(opaqueProof);

    await expect(pending).resolves.toEqual({ kind: 'authorization-stale', setIdentity: address, effect: noEffect });
    expect(complete).toHaveBeenCalledExactlyOnceWith(capability, opaqueProof, false, signal);
    expect(handback).toHaveBeenCalledOnce();
  });

  it('hands authorization back when aborted proof collection rejects', async () => {
    vi.spyOn(harness.lifecycle, 'authorizeOperatorExit').mockReturnValue({ kind: 'authorized', capability });
    const controller = new AbortController();
    const proof = vi.spyOn(harness.prover, 'collectContainmentProof').mockImplementation(
      (_authorization, _db, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new Error('request aborted')),
            { once: true },
          );
        }),
    );
    const complete = vi.spyOn(harness.lifecycle, 'completeOperatorExit');

    const pending = harness.contain({ setIdentity: address, mode: 'contain' }, controller.signal);
    controller.abort(new Error('request aborted'));

    await expect(pending).rejects.toThrow('request aborted');
    expect(proof).toHaveBeenCalledExactlyOnceWith(proofAuthorization, harness.db, controller.signal);
    expect(complete).not.toHaveBeenCalled();
    expect(handback).toHaveBeenCalledOnce();
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
  ])('passes proof refusal $result.kind through lifecycle completion', async ({ evidence: _evidence, result }) => {
    vi.spyOn(harness.lifecycle, 'authorizeOperatorExit').mockReturnValue({ kind: 'authorized', capability });
    const proof = vi.spyOn(harness.prover, 'collectContainmentProof').mockResolvedValue(opaqueProof);
    const complete = vi.spyOn(harness.lifecycle, 'completeOperatorExit').mockResolvedValue(result);
    const signal = new AbortController().signal;

    await expect(harness.contain({ setIdentity: address, mode: 'contain' }, signal)).resolves.toEqual(result);
    expect(proof).toHaveBeenCalledExactlyOnceWith(proofAuthorization, harness.db, signal);
    expect(complete).toHaveBeenCalledExactlyOnceWith(capability, opaqueProof, false, signal);
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
    vi.spyOn(harness.prover, 'collectContainmentProof').mockResolvedValue(opaqueProof);
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

    await expect(harness.contain({ setIdentity: address, mode: 'abandon' }, signal)).resolves.toEqual(result);
    expect(complete).toHaveBeenCalledExactlyOnceWith(capability, opaqueProof, true, signal);
  });
});
