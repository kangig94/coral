import { describe, expect, it } from 'vitest';

import {
  acquireProviderProxySet,
  type AcquisitionUndo,
  type ProviderProxyAcquisitionSteps,
} from '#src/coordinator/live/provider-proxy-acquisition.js';
import type { ProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy-authority.js';

const SET: ProviderProxySetAuthority = {
  proxyInstanceId: 'p1',
  snapshotOperations: async () => [],
  installHandoffGrant: async () => {},
  stopAndReap: async () => ({ disappearanceReceipt: 'gone' }),
  stopHeartbeats: () => {},
  initiateControlClose: async () => {},
};

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
        return { set: SET, undo: undo('control') };
      },
    },
  };
}

const live = (): AbortSignal => new AbortController().signal;

describe('provider proxy set acquisition', () => {
  it('publishes the set only after every step has passed', async () => {
    const recorded = steps();

    const result = await acquireProviderProxySet({ steps: recorded.steps, deadlineSignal: live() });

    expect(result).toEqual({ kind: 'acquired', set: SET });
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
      establishControl: async () => {
        const result = await original();
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
