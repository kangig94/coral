import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it } from 'vitest';

import {
  acquireProviderProxySet,
  type AcquisitionUndo,
  type ProviderProxyAcquisitionSteps,
} from '#src/coordinator/live/provider-proxy/index.js';
import type { ProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';
import {
  unexercisedControllerSuccessionControls,
  unexercisedProviderHostControls,
} from '#tests/helpers/provider-host-controls.js';

const SET: ProviderProxyOperationAuthority = {
  proxyInstanceId: 'p1',
  providerHosts: unexercisedProviderHostControls,
  ...unexercisedControllerSuccessionControls,
  autonomousDeadline: {
    orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
    adoptionWindowMs: Number.MAX_SAFE_INTEGER,
    heartbeatHoldBound: {
      spanMs: Number.MAX_SAFE_INTEGER,
      materialSchedulerLatenessMs: Math.floor(Number.MAX_SAFE_INTEGER / 4),
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
const acceptHoldForTest = () => ({
  kind: 'accepted' as const,
  owner: 'durable-provider-proxy-acquisition-hold-store' as const,
});
const immediateRetryTime = { sleep: async () => undefined };
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

describe('provider proxy set acquisition', () => {
  it('publishes the set only after every step has passed', async () => {
    const recorded = steps();

    const result = await acquireProviderProxySet({
      steps: recorded.steps,
      time: immediateRetryTime,
      acceptHold: acceptHoldForTest,
      deadlineSignal: live(),
    });

    expect(result).toEqual({ kind: 'acquired', set: SET, publicationReceipt: PUBLICATION_RECEIPT });
    expect(recorded.log).toEqual(['capsules', 'spawn', 'control']);
  });

  it('keeps unwinding after a cleanup action fails, and names what it left behind', async () => {
    const recorded = steps({ failAt: 'control', failUndo: 'guardian' });
    const cleanupFailures: string[] = [];

    const result = await acquireProviderProxySet({
      steps: recorded.steps,
      time: immediateRetryTime,
      acceptHold: acceptHoldForTest,
      deadlineSignal: live(),
      onCleanupFailure: (label) => cleanupFailures.push(label),
    });

    // Abandoning the rest on the first cleanup error is how an abandoned set keeps its endpoint.
    expect(result).toMatchObject({ strandedArtifacts: ['guardian'] });
    expect(recorded.log).toContain('undo:capsules');
    expect(cleanupFailures).toEqual(['guardian']);
  });
});
