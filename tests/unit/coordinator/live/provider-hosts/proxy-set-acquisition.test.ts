import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    probeProcessIncarnation: vi.fn(() => 'linux:00000000-0000-4000-8000-000000000000:1700000000' as ProcessIncarnation),
  };
});

vi.mock('#src/coordinator/live/provider-proxy/acquisition-steps.js', () => ({
  createProviderProxyAcquisitionSteps: vi.fn(() => ({ steps: 'stub' })),
}));

vi.mock('#src/coordinator/live/provider-proxy/index.js', () => ({
  acquireProviderProxySet: vi.fn(),
}));

import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { createProviderProxyAcquisitionSteps } from '#src/coordinator/live/provider-proxy/acquisition-steps.js';
import { acquireProviderProxySet } from '#src/coordinator/live/provider-proxy/index.js';
import { ensureProviderProxySet } from '#src/coordinator/live/provider-hosts/proxy-set-acquisition.js';
import { hostFingerprintFromSpec } from '#src/coordinator/live/provider-hosts/state.js';
import type { ProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/authority.js';
import type { HandoffCapsuleV3 } from '#src/provider-proxy/handoff-capsule.js';
import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';
import {
  closeProviderProxyAcquisitionSession,
  createOwnedProviderProxyAcquisitionControlSession,
  handOverProviderProxyAcquisitionControlSession,
  providerProxyAcquisitionSessionDescriptor,
  providerProxyControlSessionOwner,
} from '#src/coordinator/live/provider-proxy/control-session.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import { createEntry, createSharedSpec, runtime } from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

const mockedProbe = probeProcessIncarnation as unknown as ReturnType<typeof vi.fn>;
const mockedCreateSteps = createProviderProxyAcquisitionSteps as unknown as ReturnType<typeof vi.fn>;
const mockedAcquire = acquireProviderProxySet as unknown as ReturnType<typeof vi.fn>;
const PUBLICATION_RECEIPT = { kind: 'provider-proxy-set-published' } as PublicationReceipt;

const environment = {
  runtime,
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
};

function fakeSet(): ProviderProxySetAuthority {
  return {
    proxyInstanceId: 'proxy-1',
    stopAndReap: async () => ({ disappearanceReceipt: 'r' }),
    commitContainment: async () => ({ kind: 'containment-absent', disappearanceReceipt: 'r' }),
    stopHeartbeats: () => {},
    initiateControlClose: async () => {},
  };
}

function publicationUnknownAcquisitionHandoff(capsuleBinding: HandoffCapsuleV3) {
  const client: ControlClient = {
    exchange: async () => {
      throw new Error('not used');
    },
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => undefined,
  };
  const session = createOwnedProviderProxyAcquisitionControlSession(providerProxyControlSessionOwner.acquisition, {
    base: fakeSet() as never,
    setIdentity: {} as never,
    clients: { guardian: client, reaper: client, proxy: client },
    heartbeats: {
      guardian: { stop: () => undefined },
      reaper: { stop: () => undefined },
      proxy: { stop: () => undefined },
    },
    faults: createProviderProxyAuthorityFaultLatch(),
    guardianIdentity: {} as never,
    reaperIdentity: {} as never,
    proxyIdentity: {} as never,
    capsulePath: '/capsules/publication-unknown.handoff.v3.json',
    capsuleBinding,
    mutationRpcTimeoutMs: 1,
  });
  return handOverProviderProxyAcquisitionControlSession(
    session,
    providerProxyControlSessionOwner.providerHostAcquisition,
    { kind: 'publication-unknown', role: 'guardian', reason: 'publication response was lost' },
  );
}

describe('ensureProviderProxySet', () => {
  it('reports a failed outcome without attempting acquisition when the coordinator’s own incarnation cannot be read', () => {
    mockedProbe.mockReturnValueOnce(null);
    const outcomes: unknown[] = [];

    ensureProviderProxySet(createEntry({ spec: createSharedSpec() }), environment, (outcome) => {
      outcomes.push(outcome);
    });

    expect(outcomes).toEqual([{ kind: 'failed', reason: expect.stringContaining('incarnation') }]);
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
      strandedArtifacts: [],
    });
    let outcome: unknown;

    await new Promise<void>((resolve) => {
      ensureProviderProxySet(createEntry({ spec: createSharedSpec() }), environment, (result) => {
        outcome = result;
        resolve();
      });
    });

    expect(outcome).toEqual({ kind: 'failed', reason: 'boom' });
  });

  it('hands the publication-unknown live session to the provider host manager', async () => {
    const capsuleBinding = { version: 3 } as HandoffCapsuleV3;
    mockedAcquire.mockResolvedValueOnce(publicationUnknownAcquisitionHandoff(capsuleBinding));
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
      capsuleBinding,
    });
    closeProviderProxyAcquisitionSession(session, 'test complete');
  });

  it('reports a failed outcome when the acquisition promise itself rejects', async () => {
    mockedAcquire.mockRejectedValueOnce(new Error('spawn exploded'));
    let outcome: unknown;

    await new Promise<void>((resolve) => {
      ensureProviderProxySet(createEntry({ spec: createSharedSpec() }), environment, (result) => {
        outcome = result;
        resolve();
      });
    });

    expect(outcome).toEqual({ kind: 'failed', reason: 'spawn exploded' });
  });
});
