import type * as ProcessContainmentModule from '#src/infra/process-containment.js';
import type * as ContainmentProofModule from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import { beforeEach, expect, it, vi } from 'vitest';
import type { FailureDomainObservation } from '#src/infra/failure-domain.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { reapProviderOperationCarrier } from '#src/coordinator/services/recovery/interrupted-performer.js';
import {
  createProviderProxySetRecordedContainmentReaper,
  reobserveDurableProviderProxySetContainment,
} from '#src/coordinator/services/provider-proxy-set/recorded-containment-reaper.js';
import type { ProviderProxySetFencedContainmentProof } from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import type { ProviderProxySetIdentity } from '#src/coordinator/services/provider-proxy-set/identity.js';

const state = vi.hoisted(() => ({
  observation: { kind: 'absent' } as FailureDomainObservation,
  after: { kind: 'unknown', reason: 'EACCES' } as FailureDomainObservation,
  observeExistingInsideReap: false,
}));
vi.mock('#src/infra/process-containment.js', async (original) => ({
  ...(await original<typeof ProcessContainmentModule>()),
  reapRecordedContainment: async (
    _subject: unknown,
    _roots: unknown,
    _deadline: unknown,
    environment: { failureDomain?: { observe(): FailureDomainObservation } },
  ) => {
    if (state.observeExistingInsideReap) {
      state.observation = { kind: 'absent' };
      environment.failureDomain?.observe();
    }
    queueMicrotask(() => {
      state.observation = state.after;
    });
    return { kind: 'containment-absent' as const };
  },
}));
vi.mock('#src/coordinator/services/provider-proxy-set/containment-proof.js', async (original) => ({
  ...(await original<typeof ContainmentProofModule>()),
  providerProxySetContainmentEvidenceFor: () => ({ kind: 'reap-required', containment: {}, recordedRoots: [] }),
  verifyProviderProxySetContainmentProofCurrent: () => ({ kind: 'current' }),
  releaseProviderProxySetContainmentProofFence: () => undefined,
}));
beforeEach(() => {
  state.observation = { kind: 'absent' };
  state.observeExistingInsideReap = false;
});

function transition(after: 'unknown' | 'missing' | 'populated' | 'missing-after-inner-observation') {
  if (after === 'missing-after-inner-observation') {
    state.observation = { kind: 'missing' };
    state.observeExistingInsideReap = true;
    state.after = { kind: 'missing' };
  } else {
    state.after = after === 'unknown' ? { kind: 'unknown', reason: 'EACCES' } : { kind: after };
  }
}

it.each(['unknown', 'missing', 'populated', 'missing-after-inner-observation'] as const)(
  'rejects interrupted carrier reaping after its existing leaf becomes %s across await',
  async (after) => {
    transition(after);
    const runtime = new SimulationRuntime();
    vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
      observe: () => state.observation,
      kill: () => ({ kind: 'entered' }),
    });
    const record = providerOperationRecord('executing');
    if (record.phase !== 'executing') throw new Error('fixture must execute');
    await expect(
      reapProviderOperationCarrier(record, {
        process: runtime.process,
        platform: 'linux',
        signal: new AbortController().signal,
        clock: createMonotonicClock(Symbol('post-reap-test')),
      }),
    ).rejects.toThrow(/leaf absence changed/);
  },
);

it.each(['unknown', 'missing', 'populated', 'missing-after-inner-observation'] as const)(
  'does not mint a set disappearance receipt after its existing leaf becomes %s across await',
  async (after) => {
    transition(after);
    const runtime = new SimulationRuntime();
    vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
      observe: () => state.observation,
      kill: () => ({ kind: 'entered' }),
    });
    const reap = createProviderProxySetRecordedContainmentReaper(runtime);
    const result = await reap(
      { proxyInstanceId: 'test' } as ProviderProxySetIdentity,
      {} as ProviderProxySetFencedContainmentProof,
      new AbortController().signal,
      () => {},
    );
    expect(result.kind).toBe('identity-unobservable');
  },
);

it.each(['unknown', 'missing', 'populated', 'missing-after-inner-observation'] as const)(
  'keeps a durable disposition after its existing leaf becomes %s across reobservation await',
  async (after) => {
    transition(after);
    const result = await reobserveDurableProviderProxySetContainment({
      identity: { proxyInstanceId: 'test' } as ProviderProxySetIdentity,
      proof: {} as ProviderProxySetFencedContainmentProof,
      signal: new AbortController().signal,
      failureDomain: { observe: () => state.observation },
      reapRecordedContainment: async (
        _identity,
        _proof,
        _signal,
        _onSignal,
        _assertSignalAuthorized,
        absenceObserver,
      ) => {
        if (state.observeExistingInsideReap) absenceObserver?.({ kind: 'absent' });
        queueMicrotask(() => {
          state.observation = state.after;
        });
        return { kind: 'containment-absent', disappearanceReceipt: 'proof' };
      },
    });
    expect(result.kind).toBe('publish-hold');
  },
);
