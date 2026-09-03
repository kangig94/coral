import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it } from 'vitest';

import {
  acquireProviderProxySet,
  type AcquisitionUndo,
  type ProviderProxyAcquisitionSteps,
} from '#src/coordinator/live/provider-proxy/index.js';
import {
  closeProviderProxyAcquisitionSession,
  createOwnedProviderProxyAcquisitionControlSession,
  handOverProviderProxyAcquisitionControlSession,
  providerProxyAcquisitionSessionDescriptor,
  providerProxyControlSessionOwner,
} from '#src/coordinator/live/provider-proxy/control-session.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import type { ProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';
import type { HandoffCapsuleV3 } from '#src/provider-proxy/handoff-capsule.js';

const SET: ProviderProxyOperationAuthority = {
  proxyInstanceId: 'p1',
  autonomousDeadline: {
    orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
    adoptionWindowMs: Number.MAX_SAFE_INTEGER,
    heartbeatHoldBound: {
      spanMs: Number.MAX_SAFE_INTEGER,
      materialSchedulerLatenessMs: Number.MAX_SAFE_INTEGER,
    },
  },
  registerSuccessionOperation: async () => ({ kind: 'registered' as const }),
  stopAndReap: async () => ({ disappearanceReceipt: 'gone' }),
  commitContainment: async () => ({ kind: 'containment-absent', disappearanceReceipt: 'gone' }),
  stopHeartbeats: () => {},
  initiateControlClose: async () => {},
  setIdentity: {
    buildSetId: 'build-1',
    hostFingerprint: 'f'.repeat(64),
    guardianInstanceId: 'g1',
    guardianPid: 1,
    guardianIncarnation: testIncarnation(1),
    guardianControlEndpoint: '/tmp/guardian.sock',
    proxyInstanceId: 'p1',
    proxyPid: 2,
    reaperInstanceId: 'r1',
    reaperPid: 3,
    reaperIncarnation: testIncarnation(1),
    reaperControlEndpoint: '/tmp/reaper.sock',
    containmentKind: 'detached',
    proxyIncarnation: testIncarnation(1),
    proxyProcessGroupId: 2,
    canonicalEndpoint: '/tmp/proxy.sock',
  },
};
const PUBLICATION_RECEIPT = { kind: 'provider-proxy-set-published' } as PublicationReceipt;

type Recorded = { readonly log: string[]; readonly steps: ProviderProxyAcquisitionSteps };

/** Every step healthy unless a cut is named; the undo of each step appends to the same log. */
function steps(options: { failAt?: 'capsules' | 'spawn' | 'control'; failUndo?: string } = {}): Recorded {
  const log: string[] = [];
  const undo = (label: string): AcquisitionUndo => ({
    label,
    run: () => {
      if (options.failUndo === label) throw new Error(`${label} could not be removed`);
      log.push(`undo:${label}`);
    },
  });
  return {
    log,
    steps: {
      createCapsules: async () => {
        log.push('capsules');
        if (options.failAt === 'capsules') throw new Error('capsule path already exists');
        return undo('capsules');
      },
      spawnGuardian: async () => {
        log.push('spawn');
        if (options.failAt === 'spawn') throw new Error('guardian exited immediately');
        return undo('guardian');
      },
      establishControl: async () => {
        log.push('control');
        if (options.failAt === 'control') throw new Error('containment ACK never arrived');
        return {
          kind: 'established',
          set: SET as never,
          publicationReceipt: PUBLICATION_RECEIPT,
          undo: undo('control'),
        };
      },
    },
  };
}

const live = (): AbortSignal => new AbortController().signal;
const PUBLICATION_UNKNOWN_CAPSULE = { version: 3 } as HandoffCapsuleV3;

function publicationUnknownHandoff() {
  const client: ControlClient = {
    exchange: async () => {
      throw new Error('not used');
    },
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => undefined,
  };
  const session = createOwnedProviderProxyAcquisitionControlSession(
    providerProxyControlSessionOwner.controlEstablishment,
    {
      base: SET as never,
      setIdentity: SET.setIdentity,
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
      capsuleBinding: PUBLICATION_UNKNOWN_CAPSULE,
      mutationRpcTimeoutMs: 1,
    },
  );
  return handOverProviderProxyAcquisitionControlSession(session, providerProxyControlSessionOwner.acquisition, {
    kind: 'publication-unknown',
    role: 'guardian',
    reason: 'publication response was lost',
  });
}

describe('provider proxy set acquisition', () => {
  it('publishes the set only after every step has passed', async () => {
    const recorded = steps();

    const result = await acquireProviderProxySet({ steps: recorded.steps, deadlineSignal: live() });

    expect(result).toEqual({ kind: 'acquired', set: SET, publicationReceipt: PUBLICATION_RECEIPT });
    expect(recorded.log).toEqual(['capsules', 'spawn', 'control']);
  });

  it.each([
    ['capsules' as const, 'capsule creation', []],
    ['spawn' as const, 'guardian spawn', ['undo:capsules']],
    ['control' as const, 'control establishment', ['undo:guardian', 'undo:capsules']],
  ])('unwinds exactly what the %s cut had created', async (failAt, cut, expectedUndo) => {
    const recorded = steps({ failAt });

    const result = await acquireProviderProxySet({ steps: recorded.steps, deadlineSignal: live() });

    expect(result).toMatchObject({ kind: 'provider_proxy_acquisition_failed', cut, strandedArtifacts: [] });
    // Newest first: closing a control before removing the capsule that authorised it keeps the window in
    // which a stale capsule is redeemable as short as it can be.
    expect(recorded.log.filter((entry) => entry.startsWith('undo:'))).toEqual(expectedUndo);
  });

  it('keeps unwinding after a cleanup action fails, and names what it left behind', async () => {
    const recorded = steps({ failAt: 'control', failUndo: 'guardian' });
    const cleanupFailures: string[] = [];

    const result = await acquireProviderProxySet({
      steps: recorded.steps,
      deadlineSignal: live(),
      onCleanupFailure: (label) => cleanupFailures.push(label),
    });

    // Abandoning the rest on the first cleanup error is how an abandoned set keeps its endpoint.
    expect(result).toMatchObject({ strandedArtifacts: ['guardian'] });
    expect(recorded.log).toContain('undo:capsules');
    expect(cleanupFailures).toEqual(['guardian']);
  });

  it('hands over the live control-session owner without unwinding a publication-unknown set', async () => {
    const recorded = steps();
    recorded.steps.establishControl = async () => publicationUnknownHandoff();

    const result = await acquireProviderProxySet({ steps: recorded.steps, deadlineSignal: live() });

    if (result.kind !== 'handed-over') throw new Error(`expected handoff, received ${result.kind}`);
    expect(result.incident).toEqual({
      kind: 'publication-unknown',
      role: 'guardian',
      reason: 'publication response was lost',
    });
    expect(providerProxyAcquisitionSessionDescriptor(result.session)).toEqual({
      setIdentity: SET.setIdentity,
      capsulePath: '/capsules/publication-unknown.handoff.v3.json',
      capsuleBinding: PUBLICATION_UNKNOWN_CAPSULE,
    });
    expect(recorded.log).toEqual(['capsules', 'spawn']);
    closeProviderProxyAcquisitionSession(result.session, 'test complete');
  });

  it('does not begin a step once the acquisition deadline has elapsed', async () => {
    const recorded = steps();

    const result = await acquireProviderProxySet({ steps: recorded.steps, deadlineSignal: AbortSignal.abort() });

    expect(result).toMatchObject({ cut: 'capsule creation', reason: 'the acquisition deadline elapsed' });
    // Nothing was created, so there is nothing to unwind — and nothing was spawned that could outlive this.
    expect(recorded.log).toEqual([]);
  });

  it('does not let a hung cleanup action hold the acquisition open past its deadline', async () => {
    const recorded = steps({ failAt: 'control' });
    const originalSpawn = recorded.steps.spawnGuardian;
    recorded.steps.spawnGuardian = async () => {
      const undo = await originalSpawn();
      // Simulates a control-close RPC that never returns — exactly what would otherwise hold the caller's
      // single-flight slot open forever.
      return { label: undo.label, run: () => new Promise<void>(() => {}) };
    };
    const cleanupFailures: string[] = [];

    const result = await acquireProviderProxySet({
      steps: recorded.steps,
      deadlineSignal: AbortSignal.timeout(50),
      onCleanupFailure: (label) => cleanupFailures.push(label),
    });

    // The hung undo is reported as stranded instead of awaited forever; the attempt still resolves reporting
    // the original failure, and the capsules undo — which does not hang — still runs to completion.
    expect(result).toMatchObject({ kind: 'provider_proxy_acquisition_failed', cut: 'control establishment' });
    expect(cleanupFailures).toEqual(['guardian']);
    expect(recorded.log).toContain('undo:capsules');
  });

  it('refuses to publish a set whose deadline elapsed while the last handshake was in flight', async () => {
    const recorded = steps();
    const deadline = new AbortController();
    const original = recorded.steps.establishControl;
    const racing: ProviderProxyAcquisitionSteps = {
      ...recorded.steps,
      establishControl: async (registerUndo) => {
        const result = await original(registerUndo);
        deadline.abort();
        return result;
      },
    };

    const result = await acquireProviderProxySet({ steps: racing, deadlineSignal: deadline.signal });

    // The caller has already given up, so publishing here would hand out a set nobody is holding — and it
    // would reap itself on a deadline nobody is watching.
    expect(result).toMatchObject({ kind: 'provider_proxy_acquisition_failed', cut: 'readiness publication' });
    expect(recorded.log.filter((entry) => entry.startsWith('undo:'))).toEqual([
      'undo:control',
      'undo:guardian',
      'undo:capsules',
    ]);
  });
});
