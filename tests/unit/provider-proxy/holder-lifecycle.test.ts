// `ControlHolderAuthority` is the one home for a role process's holder identity (§7), and the provider-proxy
// wrapper that turns an identity-bound observation into the one capability canonical `absent` may construct.

import { describe, expect, it, vi } from 'vitest';

import type { ControlTenancyHolder } from '#src/provider-proxy/control-endpoint.js';
import {
  controlHolderAuthorizationIsCurrent,
  createControlHolderAuthority,
  mintExplicitTeardownAuthorization,
  observeControlHolder,
  type AcquisitionPhase,
  type ControlHolderAuthority,
  type ControlHolderIdentity,
  type ExplicitTeardownAuthorization,
  type HolderDisposition,
  type HolderObservation,
  type ObservedHolderAbsenceAuthorization,
  type OperatorTeardownAuthorization,
} from '#src/provider-proxy/holder-lifecycle.js';
import type { AsyncRecordedProcessObserver, ProcessLiveness } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

function holder(instanceId: string, pid = 1): ControlTenancyHolder {
  return { instanceId, pid, incarnation: testIncarnation(`${instanceId}:${pid}`) };
}

function identity(controlEpoch: number, tenancyHolder: ControlTenancyHolder): ControlHolderIdentity {
  return { controlEpoch, holder: tenancyHolder };
}

function observerAnswering(liveness: ProcessLiveness): AsyncRecordedProcessObserver {
  return vi.fn(() => Promise.resolve(liveness));
}

function assertDisposition(observation: HolderObservation, expected: HolderDisposition): void {
  expect(observation.disposition).toBe(expected);
}

function assertPhase(authority: ControlHolderAuthority, expected: AcquisitionPhase): void {
  expect(authority.phase()).toBe(expected);
}

/**
 * `OperatorTeardownAuthorization` has no constructor in this batch — Batch D mints it at the direct
 * operator-force boundary. Its non-substitutability is proven statically in
 * holder-teardown-authorization-boundary.test-d.ts; this signature keeps the type reachable from a real
 * (`.test.ts`) knip entry too, since a `.test-d.ts` file is not one.
 */
function acceptsOperatorTeardown(_authorization: OperatorTeardownAuthorization): void {}
void acceptsOperatorTeardown;

describe('createControlHolderAuthority', () => {
  it('holds nothing before any admission', () => {
    const authority = createControlHolderAuthority();

    expect(authority.current()).toBeNull();
    assertPhase(authority, 'acquisition-provisional');
  });

  it('installs the first admission and reports it back unchanged', () => {
    const authority = createControlHolderAuthority();
    const incumbent = holder('coordinator');

    authority.install(identity(1, incumbent));

    expect(authority.current()).toEqual(identity(1, incumbent));
  });

  it('replaces the installed holder on a successor admission at a strictly greater epoch', () => {
    const authority = createControlHolderAuthority();
    authority.install(identity(1, holder('incumbent')));

    const successor = holder('successor', 2);
    authority.install(identity(2, successor));

    expect(authority.current()).toEqual(identity(2, successor));
  });

  it('refuses to install an epoch that does not strictly advance', () => {
    const authority = createControlHolderAuthority();
    authority.install({ controlEpoch: 3, holder: holder('incumbent') });

    expect(() => authority.install({ controlEpoch: 3, holder: holder('replay') })).toThrow();
    expect(() => authority.install({ controlEpoch: 2, holder: holder('stale') })).toThrow();
  });

  it('publishes one-way, and publishing an already-published authority changes nothing', () => {
    const authority = createControlHolderAuthority();

    authority.publish();
    assertPhase(authority, 'published');

    authority.publish();
    assertPhase(authority, 'published');
  });
});

describe('observeControlHolder', () => {
  it('answers unobservable when nothing has ever been admitted, and asks nothing', async () => {
    const authority = createControlHolderAuthority();
    const observe = observerAnswering('alive');

    assertDisposition(await observeControlHolder(authority, observe), 'unobservable');
    expect(observe).not.toHaveBeenCalled();
  });

  it('answers alive with no authorization when the observer confirms the admitted holder', async () => {
    const authority = createControlHolderAuthority();
    const incumbent = holder('coordinator');
    authority.install({ controlEpoch: 1, holder: incumbent });
    const observe = observerAnswering('alive');

    const result = await observeControlHolder(authority, observe);

    assertDisposition(result, 'alive');
    expect(observe).toHaveBeenCalledWith({ pid: incumbent.pid, incarnation: incumbent.incarnation });
  });

  it('answers unobservable, and mints nothing, when the observer cannot decide', async () => {
    const authority = createControlHolderAuthority();
    authority.install({ controlEpoch: 1, holder: holder('coordinator') });

    const result = await observeControlHolder(authority, observerAnswering('unknown'));

    assertDisposition(result, 'unobservable');
  });

  it('mints ObservedHolderAbsenceAuthorization only on canonical absent, bound to the observed identity', async () => {
    const authority = createControlHolderAuthority();
    const incumbent = holder('coordinator');
    authority.install({ controlEpoch: 1, holder: incumbent });

    const result = await observeControlHolder(authority, observerAnswering('absent'));

    if (result.disposition !== 'absent') throw new Error('expected an absent disposition');
    expect(result.authorization.controlEpoch).toBe(1);
    expect(result.authorization.holder).toEqual(incumbent);
  });

  it('binds the minted capability to the holder that was actually probed, not a later successor', async () => {
    const authority = createControlHolderAuthority();
    const incumbent = holder('incumbent');
    authority.install({ controlEpoch: 1, holder: incumbent });

    let resolveObservation!: (liveness: ProcessLiveness) => void;
    const observe: AsyncRecordedProcessObserver = () =>
      new Promise((resolve) => {
        resolveObservation = resolve;
      });

    const pending = observeControlHolder(authority, observe);
    // A successor is admitted while the probe of the incumbent is still in flight.
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
  it('is true while the authority still holds the epoch and holder the capability names', async () => {
    const authority = createControlHolderAuthority();
    authority.install({ controlEpoch: 1, holder: holder('coordinator') });
    const observation = await observeControlHolder(authority, observerAnswering('absent'));
    if (observation.disposition !== 'absent') throw new Error('expected an absent disposition');

    expect(controlHolderAuthorizationIsCurrent(authority, observation.authorization)).toBe(true);
  });

  it('is revoked the instant a successor is installed, before any consumption', async () => {
    const authority = createControlHolderAuthority();
    authority.install({ controlEpoch: 1, holder: holder('incumbent') });
    const observation = await observeControlHolder(authority, observerAnswering('absent'));
    if (observation.disposition !== 'absent') throw new Error('expected an absent disposition');

    authority.install({ controlEpoch: 2, holder: holder('successor', 2) });

    expect(controlHolderAuthorizationIsCurrent(authority, observation.authorization)).toBe(false);
  });

  it('is false for an authority that has never admitted anyone', () => {
    const authority = createControlHolderAuthority();
    const foreign = { controlEpoch: 1, holder: holder('nobody') } as unknown as ObservedHolderAbsenceAuthorization;

    expect(controlHolderAuthorizationIsCurrent(authority, foreign)).toBe(false);
  });
});

describe('mintExplicitTeardownAuthorization', () => {
  it('is null when nothing is currently admitted', () => {
    const authority = createControlHolderAuthority();

    expect(mintExplicitTeardownAuthorization(authority)).toBeNull();
  });

  it('mints from the authority’s own current holder, and the result verifies as current', () => {
    const authority = createControlHolderAuthority();
    const incumbent = holder('coordinator');
    authority.install({ controlEpoch: 1, holder: incumbent });

    const authorization = mintExplicitTeardownAuthorization(authority);

    expect(authorization).not.toBeNull();
    expect((authorization as ExplicitTeardownAuthorization).controlEpoch).toBe(1);
    expect((authorization as ExplicitTeardownAuthorization).holder).toEqual(incumbent);
    expect(controlHolderAuthorizationIsCurrent(authority, authorization as ExplicitTeardownAuthorization)).toBe(true);
  });

  it('is revoked once a successor is installed after minting', () => {
    const authority = createControlHolderAuthority();
    authority.install({ controlEpoch: 1, holder: holder('incumbent') });
    const authorization = mintExplicitTeardownAuthorization(authority) as ExplicitTeardownAuthorization;

    authority.install({ controlEpoch: 2, holder: holder('successor', 2) });

    expect(controlHolderAuthorizationIsCurrent(authority, authorization)).toBe(false);
  });
});
