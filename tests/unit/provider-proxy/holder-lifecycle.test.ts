// Holder identity and identity-bound absence authority must have one canonical owner.

import { describe, expect, it, vi } from 'vitest';

import { createMonotonicClock, type MonotonicClock } from '#src/infra/monotonic-clock.js';
import type { ActiveControlAuthorization, ControlTenancyHolder } from '#src/provider-proxy/control-endpoint.js';
import {
  controlHolderAuthorizationIsCurrent,
  createControlHolderAuthority,
  mintExplicitTeardownAuthorization,
  observeControlHolder,
  type ControlHolderIdentity,
} from '#src/provider-proxy/holder-lifecycle.js';
import type { AsyncRecordedProcessObserver, ProcessLiveness } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const observationClockScope: unique symbol = Symbol('holder-lifecycle-test-observation');

function testClock(startMs = 0): MonotonicClock<typeof observationClockScope> {
  let ms = BigInt(startMs);
  return createMonotonicClock(observationClockScope, {
    readMilliseconds: () => ms++,
  });
}

function holder(instanceId: string, pid = 1): ControlTenancyHolder {
  return { instanceId, pid, incarnation: testIncarnation(`${instanceId}:${pid}`) };
}

function identity(controlEpoch: number, tenancyHolder: ControlTenancyHolder): ControlHolderIdentity {
  return { controlEpoch, holder: tenancyHolder };
}

function observerAnswering(liveness: ProcessLiveness): AsyncRecordedProcessObserver {
  return vi.fn(() => Promise.resolve(liveness));
}

describe('observeControlHolder', () => {
  it('binds the minted capability to the holder that was actually probed, not a later successor', async () => {
    const authority = createControlHolderAuthority();
    const incumbent = holder('incumbent');
    authority.install({ controlEpoch: 1, holder: incumbent });

    let resolveObservation!: (liveness: ProcessLiveness) => void;
    const observe: AsyncRecordedProcessObserver = () =>
      new Promise((resolve) => {
        resolveObservation = resolve;
      });

    const pending = observeControlHolder(authority, observe, testClock());
    const successor = holder('successor', 2);
    authority.install({ controlEpoch: 2, holder: successor });
    resolveObservation('absent');

    const result = await pending;
    if (result.disposition !== 'absent') throw new Error('expected an absent disposition');
    expect(result.authorization.holder).toEqual(incumbent);
    expect(result.authorization.controlEpoch).toBe(1);
  });
});

describe('controlHolderAuthorizationIsCurrent', () => {
  it('is revoked the instant a successor is installed, before any consumption', async () => {
    const authority = createControlHolderAuthority();
    authority.install({ controlEpoch: 1, holder: holder('incumbent') });
    const observation = await observeControlHolder(authority, observerAnswering('absent'), testClock());
    if (observation.disposition !== 'absent') throw new Error('expected an absent disposition');

    authority.install({ controlEpoch: 2, holder: holder('successor', 2) });

    expect(controlHolderAuthorizationIsCurrent(authority, observation.authorization)).toBe(false);
  });
});

describe('mintExplicitTeardownAuthorization', () => {
  const activeControlAuthorization = {} as unknown as ActiveControlAuthorization;

  it('refuses an active-control authorization bound to a different holder admission', () => {
    const authority = createControlHolderAuthority();
    const admitted = identity(2, holder('target', 2));
    const authorized = identity(1, holder('authorized'));
    authority.install(admitted);
    const activeControlAuthorizationIsCurrent = vi.fn(
      (candidate: ActiveControlAuthorization, subject: ControlHolderIdentity) =>
        candidate === activeControlAuthorization &&
        subject.controlEpoch === authorized.controlEpoch &&
        subject.holder.instanceId === authorized.holder.instanceId &&
        subject.holder.pid === authorized.holder.pid &&
        subject.holder.incarnation === authorized.holder.incarnation,
    );

    expect(
      mintExplicitTeardownAuthorization(authority, activeControlAuthorization, activeControlAuthorizationIsCurrent),
    ).toBeNull();
    expect(activeControlAuthorizationIsCurrent).toHaveBeenCalledWith(activeControlAuthorization, admitted);
  });
});
