import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('#src/coordinator/live/provider-proxy/acquisition-steps.js', () => ({
  createProviderProxyAcquisitionSteps: vi.fn(() => ({ steps: 'stub' })),
}));

vi.mock('#src/coordinator/live/provider-proxy/index.js', () => ({
  acquireProviderProxySet: vi.fn(),
}));

import { createProviderProxyAcquisitionSteps } from '#src/coordinator/live/provider-proxy/acquisition-steps.js';
import { acquireProviderProxySet } from '#src/coordinator/live/provider-proxy/index.js';
import {
  disposeStoppedProviderProxySetAcquisition,
  ensureProviderProxySet,
} from '#src/coordinator/live/provider-hosts/proxy-set-acquisition.js';
import { hostFingerprintFromSpec } from '#src/coordinator/live/provider-hosts/state.js';
import type { ProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';
import {
  closeProviderProxyAcquisitionSession,
  handOverProviderProxyAcquisitionControlSession,
  providerProxyAcquisitionSessionDescriptor,
  providerProxyControlSessionOwner,
  retryProviderProxyAcquisitionPublication,
} from '#src/coordinator/live/provider-proxy/control-session.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS } from '#src/provider-proxy/protocol.js';
import { createPublicationUnknownAcquisitionSessionFixture } from '#tests/helpers/provider-proxy-acquisition-session.js';
import { createEntry, createSharedSpec, runtime } from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

const readProcessIncarnation = vi.fn<(pid: number, platform: NodeJS.Platform) => ProcessIncarnation | null>(() =>
  testIncarnation(1_700_000_000),
);
const mockedCreateSteps = createProviderProxyAcquisitionSteps as unknown as ReturnType<typeof vi.fn>;
const mockedAcquire = acquireProviderProxySet as unknown as ReturnType<typeof vi.fn>;
const PUBLICATION_RECEIPT = { kind: 'provider-proxy-set-published' } as PublicationReceipt;

const environment = {
  runtime: {
    ...runtime,
    process: { ...runtime.process, readProcessIncarnation },
  },
  pluginRoot: '/plugin/root',
  identity: {
    instanceId: 'coordinator-instance',
    buildSetId: '1'.repeat(8) + '-0000-4000-8000-000000000000',
    flavor: 'prod' as const,
  },
  // `createProviderProxyAcquisitionSteps` itself is mocked in this file, so nothing reads the registry.
  operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
  // The ordinary case: nothing is stopping the provider host manager, so this attempt's only deadline is its
  // own internal one.
  signal: new AbortController().signal,
  acceptHold: () => ({ kind: 'accepted' as const, owner: 'durable-provider-proxy-acquisition-hold-store' as const }),
};

function fakeSet(): ProviderProxyOperationAuthority {
  const proxyInstanceId = '00000000-0000-4000-8000-000000000002';
  return {
    proxyInstanceId,
    stopAndReap: async () => ({ disappearanceReceipt: 'r' }),
    commitContainment: async () => ({ kind: 'containment-absent', disappearanceReceipt: 'r' }),
    stopHeartbeats: () => {},
    initiateControlClose: async () => {},
    autonomousDeadline: {
      orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
      adoptionWindowMs: Number.MAX_SAFE_INTEGER,
      heartbeatHoldBound: {
        spanMs: Number.MAX_SAFE_INTEGER,
        materialSchedulerLatenessMs: Math.floor(Number.MAX_SAFE_INTEGER / 4),
      },
    },
    registerSuccessionOperation: async () => ({ kind: 'registered' }),
    setIdentity: {
      buildSetId: '00000000-0000-4000-8000-000000000001',
      hostFingerprint: 'a'.repeat(64),
      guardianInstanceId: '00000000-0000-4000-8000-000000000003',
      guardianPid: 100,
      guardianIncarnation: testIncarnation(1),
      guardianControlEndpoint: '/tmp/guardian.sock',
      proxyInstanceId,
      proxyPid: 200,
      reaperInstanceId: '00000000-0000-4000-8000-000000000004',
      reaperPid: 300,
      reaperIncarnation: testIncarnation(2),
      reaperControlEndpoint: '/tmp/reaper.sock',
      containmentKind: 'posix-group',
      proxyIncarnation: testIncarnation(3),
      proxyProcessGroupId: 200,
      canonicalEndpoint: '/tmp/proxy.sock',
    },
  };
}

function publicationUnknownAcquisitionHandoff() {
  const fixture = createPublicationUnknownAcquisitionSessionFixture(providerProxyControlSessionOwner.acquisition);
  return {
    handoff: handOverProviderProxyAcquisitionControlSession(
      fixture.session,
      providerProxyControlSessionOwner.providerHostAcquisition,
      { kind: 'publication-unknown', role: 'guardian', reason: 'publication response was lost' },
    ),
    ...fixture,
  };
}

describe('disposeStoppedProviderProxySetAcquisition', () => {
  it('requires lifecycle transfer for a live acquisition selected for handoff', async () => {
    const stopAndReap = vi.fn(async () => ({ disappearanceReceipt: 'r' }));
    const stopHeartbeats = vi.fn();
    const initiateControlClose = vi.fn(async () => {});
    const set = {
      ...fakeSet(),
      stopAndReap,
      stopHeartbeats,
      initiateControlClose,
    };
    const acquisition = { kind: 'acquired' as const, set, publicationReceipt: PUBLICATION_RECEIPT };

    await expect(disposeStoppedProviderProxySetAcquisition(acquisition, 'handoff')).resolves.toEqual({
      kind: 'transfer-required',
      successor: 'provider-proxy-set-lifecycle',
      acquisition,
    });
    expect(stopAndReap).not.toHaveBeenCalled();
    expect(stopHeartbeats).not.toHaveBeenCalled();
    expect(initiateControlClose).not.toHaveBeenCalled();
  });

  it('confirms absence only after stop-and-reap observes it', async () => {
    const stopAndReap = vi.fn(async () => ({ disappearanceReceipt: 'joint-absence' }));
    const set = { ...fakeSet(), stopAndReap };

    await expect(
      disposeStoppedProviderProxySetAcquisition(
        { kind: 'acquired', set, publicationReceipt: PUBLICATION_RECEIPT },
        'contain',
      ),
    ).resolves.toEqual({ kind: 'absence-confirmed', strandedArtifacts: [] });
    expect(stopAndReap).toHaveBeenCalledOnce();
  });

  it('returns a hold when containment cannot be observed', async () => {
    const set = {
      ...fakeSet(),
      stopAndReap: vi.fn(async () => ({ unconfirmed: 'guardian observation unavailable' })),
    };

    await expect(
      disposeStoppedProviderProxySetAcquisition(
        { kind: 'acquired', set, publicationReceipt: PUBLICATION_RECEIPT },
        'contain',
      ),
    ).resolves.toEqual({
      kind: 'held',
      reason: 'provider_proxy_set_acquisition_containment_unconfirmed: guardian observation unavailable',
    });
  });
});

describe('ensureProviderProxySet', () => {
  it('reports a failed outcome without attempting acquisition when the coordinator’s own incarnation cannot be read', () => {
    readProcessIncarnation.mockReturnValueOnce(null);
    const outcomes: unknown[] = [];

    ensureProviderProxySet(createEntry({ spec: createSharedSpec() }), environment, (outcome) => {
      outcomes.push(outcome);
    });

    expect(outcomes).toEqual([
      { kind: 'failed', reason: expect.stringContaining('incarnation'), strandedArtifacts: [] },
    ]);
    expect(mockedCreateSteps).not.toHaveBeenCalled();
    expect(mockedAcquire).not.toHaveBeenCalled();
  });

  it('derives the host fingerprint from the entry spec and reports the acquired set on success', async () => {
    const set = fakeSet();
    mockedAcquire.mockResolvedValueOnce({ kind: 'acquired', set, publicationReceipt: PUBLICATION_RECEIPT });
    let outcome: unknown;

    const entry = createEntry({ spec: createSharedSpec() });
    await new Promise<void>((resolve) => {
      ensureProviderProxySet(entry, environment, (result) => {
        outcome = result;
        resolve();
      });
    });

    expect(outcome).toEqual({ kind: 'acquired', set, publicationReceipt: PUBLICATION_RECEIPT });
    expect(mockedCreateSteps).toHaveBeenCalledTimes(1);
    const stepsCall = mockedCreateSteps.mock.calls[0][0];
    expect(stepsCall.pluginRoot).toBe('/plugin/root');
    expect(stepsCall.coordinatorIdentity).toMatchObject({
      instanceId: 'coordinator-instance',
      generation: 'gen2',
      flavor: 'prod',
      incarnation: testIncarnation(1_700_000_000),
    });
    // Derived, not merely non-empty: compared against the real production function's output for this entry.
    expect(stepsCall.hostFingerprint).toBe(hostFingerprintFromSpec(entry.spec));

    // The steps this call built, and a deadline, actually reached `acquireProviderProxySet` — not just that
    // it was called.
    expect(mockedAcquire).toHaveBeenCalledTimes(1);
    const acquireCall = mockedAcquire.mock.calls[0][0];
    expect(acquireCall.steps).toBe(mockedCreateSteps.mock.results[0]?.value);
    expect(acquireCall.deadlineSignal).toBeInstanceOf(AbortSignal);
  });

  it('does not settle until the ownership callback completes', async () => {
    const set = fakeSet();
    mockedAcquire.mockResolvedValueOnce({ kind: 'acquired', set, publicationReceipt: PUBLICATION_RECEIPT });
    let finishCallback: (() => void) | undefined;
    let settled = false;

    const acquisition = ensureProviderProxySet(
      createEntry({ spec: createSharedSpec() }),
      environment,
      () =>
        new Promise<void>((resolve) => {
          finishCallback = resolve;
        }),
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    if (finishCallback === undefined) throw new Error('ownership callback was not invoked');
    finishCallback();
    await acquisition;
    expect(settled).toBe(true);
  });

  it('folds the caller-supplied stop signal into the deadline so an external abort reaches it too', async () => {
    // This is the seam `DefaultProviderHostManager.stopAndClose` relies on: aborting `env.signal` must reach
    // `acquireProviderProxySet` the same way the attempt's own internal timeout would, even though nothing
    // about the internal deadline itself was touched.
    const stop = new AbortController();
    // Never settles — only the deadline signal itself is under test here.
    mockedAcquire.mockReturnValueOnce(new Promise(() => {}));

    ensureProviderProxySet(
      createEntry({ spec: createSharedSpec() }),
      { ...environment, signal: stop.signal },
      () => {},
    );

    // Not `.calls[0]`: an earlier test in this file already exercised a real (settling) acquisition, so this
    // attempt's call is not necessarily the first one recorded on the shared mock.
    const acquireCall = mockedAcquire.mock.calls.at(-1)![0];
    expect(acquireCall.deadlineSignal.aborted).toBe(false);
    stop.abort();
    expect(acquireCall.deadlineSignal.aborted).toBe(true);
  });

  it('reports a failed outcome — never a rejection — when acquisition itself fails', async () => {
    mockedAcquire.mockResolvedValueOnce({
      kind: 'provider_proxy_acquisition_failed',
      cut: 'guardian spawn',
      reason: 'boom',
      strandedArtifacts: ['guardian'],
    });
    let outcome: unknown;

    await new Promise<void>((resolve) => {
      ensureProviderProxySet(createEntry({ spec: createSharedSpec() }), environment, (result) => {
        outcome = result;
        resolve();
      });
    });

    expect(outcome).toEqual({ kind: 'failed', reason: 'boom', strandedArtifacts: ['guardian'] });
  });

  it('preserves an acquisition cleanup hold and its recovery capability', async () => {
    const retry = vi.fn(async () => ({ kind: 'held' as const, reason: 'still unobservable' }));
    const held = {
      kind: 'provider_proxy_acquisition_held' as const,
      owner: 'provider-host-acquisition' as const,
      cut: 'control establishment',
      reason: 'guardian teardown was unobservable',
      strandedArtifacts: ['guardian'],
      setAddress: {
        buildSetId: '11111111-1111-4111-8111-111111111111',
        hostFingerprint: 'a'.repeat(64),
        proxyInstanceId: '22222222-2222-4222-8222-222222222222',
      },
      guardianIdentity: { pid: 101, incarnation: testIncarnation(101), processGroupId: 101 },
      recoverySubject: {
        guardianIdentity: { pid: 101, incarnation: testIncarnation(101), processGroupId: 101 },
        reaper: { kind: 'possible-unidentified' as const },
        constructionContainmentSettled: false,
        proxy: { kind: 'possible-unidentified' as const },
      },
      recoveryCapability: { retry },
    };
    mockedAcquire.mockResolvedValueOnce(held);
    let outcome: unknown;

    await new Promise<void>((resolve) => {
      ensureProviderProxySet(createEntry({ spec: createSharedSpec() }), environment, (result) => {
        outcome = result;
        resolve();
      });
    });

    expect(outcome).toEqual({ ...held, owner: 'provider-host-manager' });
    expect(retry).not.toHaveBeenCalled();
  });

  it('hands the publication-unknown live session to the provider host manager', async () => {
    const publicationUnknown = publicationUnknownAcquisitionHandoff();
    mockedAcquire.mockResolvedValueOnce(publicationUnknown.handoff);
    let outcome: unknown;

    await new Promise<void>((resolve) => {
      ensureProviderProxySet(createEntry({ spec: createSharedSpec() }), environment, (result) => {
        outcome = result;
        resolve();
      });
    });

    expect(outcome).toMatchObject({
      kind: 'handed-over',
      incident: { kind: 'publication-unknown', role: 'guardian', reason: 'publication response was lost' },
      session: { owner: 'provider-host-manager' },
    });
    if (typeof outcome !== 'object' || outcome === null || !('session' in outcome)) throw new Error('missing session');
    const session = outcome.session as Parameters<typeof providerProxyAcquisitionSessionDescriptor>[0];
    expect(providerProxyAcquisitionSessionDescriptor(session)).toMatchObject({
      capsulePath: '/capsules/publication-unknown.handoff.v3.json',
      capsuleBinding: publicationUnknown.capsuleBinding,
    });
    await expect(retryProviderProxyAcquisitionPublication(session)).resolves.toMatchObject({
      kind: 'publication-unknown',
      role: 'guardian',
    });
    expect(publicationUnknown.guardianExchange.mock.calls).toContainEqual([
      'guardian.acquisition-publish.v1',
      {
        guardian: publicationUnknown.guardianIdentity,
        reaper: publicationUnknown.reaperIdentity,
        proxy: publicationUnknown.proxyIdentity,
      },
      PROXY_CONTROL_RPC_TIMEOUT_MS,
    ]);
    expect(publicationUnknown.proxyExchange).not.toHaveBeenCalled();
    closeProviderProxyAcquisitionSession(session, 'test complete');
  });

  it('reports an unknown outcome when the acquisition promise itself rejects', async () => {
    mockedAcquire.mockRejectedValueOnce(new Error('spawn exploded'));
    let outcome: unknown;

    await new Promise<void>((resolve) => {
      ensureProviderProxySet(createEntry({ spec: createSharedSpec() }), environment, (result) => {
        outcome = result;
        resolve();
      });
    });

    expect(outcome).toEqual({ kind: 'outcome-unknown', reason: 'spawn exploded' });
    await expect(
      disposeStoppedProviderProxySetAcquisition({ kind: 'outcome-unknown', reason: 'spawn exploded' }, 'contain'),
    ).resolves.toEqual({ kind: 'held', reason: 'spawn exploded' });
  });
});
