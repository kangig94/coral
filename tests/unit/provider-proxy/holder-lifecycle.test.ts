// Holder identity and identity-bound absence authority must have one canonical owner.

import { describe, expect, it, vi } from 'vitest';

import { createMonotonicClock, type MonotonicClock } from '#src/infra/monotonic-clock.js';
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

function assertDisposition(
  observation: HolderObservation<typeof observationClockScope>,
  expected: HolderDisposition,
): void {
  expect(observation.disposition).toBe(expected);
}

function assertPhase(authority: ControlHolderAuthority, expected: AcquisitionPhase): void {
  expect(authority.phase()).toBe(expected);
}

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

describe('ControlHolderAuthority: the *.holder-status.v1 disposition surface', () => {
  it('reports no status before any holder has ever been admitted', () => {
    const authority = createControlHolderAuthority();

    expect(authority.status()).toBeNull();
  });

  it('install() seeds unobservable at transitionSequence 1 — a fresh admission has no evidence yet', () => {
    const authority = createControlHolderAuthority({ wallClockNow: () => 1_000 });
    const admission = identity(1, holder('coordinator'));

    authority.install(admission);

    expect(authority.status()).toEqual({
      identity: admission,
      disposition: 'unobservable',
      transitionSequence: 1,
      changedAtMs: 1_000,
    });
  });

  it('recordObservation advances the sequence and changedAtMs only when the disposition actually changes', () => {
    let now = 1_000;
    const authority = createControlHolderAuthority({ wallClockNow: () => now });
    const admission = identity(1, holder('coordinator'));
    authority.install(admission);

    now = 2_000;
    authority.recordObservation(admission, 'alive');
    expect(authority.status()).toEqual({
      identity: admission,
      disposition: 'alive',
      transitionSequence: 2,
      changedAtMs: 2_000,
    });

    now = 3_000;
    authority.recordObservation(admission, 'alive');
    expect(authority.status()).toEqual({
      identity: admission,
      disposition: 'alive',
      transitionSequence: 2,
      changedAtMs: 2_000,
    });

    now = 4_000;
    authority.recordObservation(admission, 'unobservable');
    expect(authority.status()).toEqual({
      identity: admission,
      disposition: 'unobservable',
      transitionSequence: 3,
      changedAtMs: 4_000,
    });
  });

  it(
    'departed is the only disposition install() never seeds — reachable only from an ' + 'actual absence observation',
    () => {
      const authority = createControlHolderAuthority();
      const admission = identity(1, holder('coordinator'));
      authority.install(admission);

      authority.recordObservation(admission, 'departed');

      expect(authority.status()?.disposition).toBe('departed');
    },
  );

  it(
    'a successor admission is itself a transition, even though it resets to the same unobservable ' +
      'disposition a fresh admission always starts at',
    () => {
      const authority = createControlHolderAuthority();
      const incumbent = identity(1, holder('incumbent'));
      authority.install(incumbent);
      authority.recordObservation(incumbent, 'alive');
      const beforeSequence = authority.status()?.transitionSequence;

      authority.install(identity(2, holder('successor', 2)));

      expect(authority.status()?.disposition).toBe('unobservable');
      expect(authority.status()?.transitionSequence).toBe((beforeSequence ?? 0) + 1);
    },
  );

  it('onTransition fires exactly once per recorded transition, and never on a deduplicated repeat', () => {
    const transitions: string[] = [];
    const authority = createControlHolderAuthority({
      onTransition: (transition) => transitions.push(transition.disposition),
    });
    const admission = identity(1, holder('coordinator'));

    authority.install(admission);
    authority.recordObservation(admission, 'alive');
    authority.recordObservation(admission, 'alive');
    authority.recordObservation(admission, 'alive');
    authority.recordObservation(admission, 'unobservable');

    expect(transitions).toEqual(['unobservable', 'alive', 'unobservable']);
  });

  it(
    'observeControlHolder itself drives status through the authority it was handed — alive, unobservable, ' +
      'and departed each land on their own status word',
    async () => {
      const aliveAuthority = createControlHolderAuthority();
      aliveAuthority.install(identity(1, holder('coordinator')));
      await observeControlHolder(aliveAuthority, observerAnswering('alive'), testClock());
      expect(aliveAuthority.status()?.disposition).toBe('alive');

      const unknownAuthority = createControlHolderAuthority();
      unknownAuthority.install(identity(1, holder('coordinator')));
      await observeControlHolder(unknownAuthority, observerAnswering('unknown'), testClock());
      expect(unknownAuthority.status()?.disposition).toBe('unobservable');

      const absentAuthority = createControlHolderAuthority();
      absentAuthority.install(identity(1, holder('coordinator')));
      await observeControlHolder(absentAuthority, observerAnswering('absent'), testClock());
      expect(absentAuthority.status()?.disposition).toBe('departed');
    },
  );
});

describe('observeControlHolder', () => {
  it('answers unobservable when nothing has ever been admitted, and asks nothing', async () => {
    const authority = createControlHolderAuthority();
    const observe = observerAnswering('alive');

    const result = await observeControlHolder(authority, observe, testClock());

    assertDisposition(result, 'unobservable');
    expect(result.subject).toBeNull();
    expect(observe).not.toHaveBeenCalled();
  });

  it('answers alive with no authorization when the observer confirms the admitted holder', async () => {
    const authority = createControlHolderAuthority();
    const incumbent = holder('coordinator');
    authority.install({ controlEpoch: 1, holder: incumbent });
    const observe = observerAnswering('alive');

    const result = await observeControlHolder(authority, observe, testClock());

    assertDisposition(result, 'alive');
    expect(result.subject).toEqual({ controlEpoch: 1, holder: incumbent });
    expect(observe).toHaveBeenCalledWith({ pid: incumbent.pid, incarnation: incumbent.incarnation });
  });

  it('answers unobservable, and mints nothing, when the observer cannot decide', async () => {
    const authority = createControlHolderAuthority();
    const incumbent = holder('coordinator');
    authority.install({ controlEpoch: 1, holder: incumbent });

    const result = await observeControlHolder(authority, observerAnswering('unknown'), testClock());

    assertDisposition(result, 'unobservable');
    expect(result.subject).toEqual({ controlEpoch: 1, holder: incumbent });
  });

  it('mints ObservedHolderAbsenceAuthorization only on canonical absent, bound to the observed identity', async () => {
    const authority = createControlHolderAuthority();
    const incumbent = holder('coordinator');
    authority.install({ controlEpoch: 1, holder: incumbent });

    const result = await observeControlHolder(authority, observerAnswering('absent'), testClock());

    if (result.disposition !== 'absent') throw new Error('expected an absent disposition');
    expect(result.subject).toEqual({ controlEpoch: 1, holder: incumbent });
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

    const pending = observeControlHolder(authority, observe, testClock());
    const successor = holder('successor', 2);
    authority.install({ controlEpoch: 2, holder: successor });
    resolveObservation('absent');

    const result = await pending;
    if (result.disposition !== 'absent') throw new Error('expected an absent disposition');
    expect(result.authorization.holder).toEqual(incumbent);
    expect(result.authorization.controlEpoch).toBe(1);
  });

  it.each(['alive', 'unknown', 'absent'] as const)(
    'does not attribute a stale %s observation to a successor or advance the successor sequence',
    async (liveness) => {
      let now = 1_000;
      const authority = createControlHolderAuthority({ wallClockNow: () => now });
      const incumbent = identity(1, holder('incumbent'));
      authority.install(incumbent);

      let resolveObservation!: (answer: ProcessLiveness) => void;
      const pending = observeControlHolder(
        authority,
        () =>
          new Promise((resolve) => {
            resolveObservation = resolve;
          }),
        testClock(),
      );

      now = 2_000;
      const successor = identity(2, holder('successor', 2));
      authority.install(successor);
      const seededSuccessorStatus = authority.status();

      now = 3_000;
      resolveObservation(liveness);
      await pending;

      expect(authority.status()).toEqual(seededSuccessorStatus);
      expect(authority.status()).toEqual({
        identity: successor,
        disposition: 'unobservable',
        transitionSequence: 2,
        changedAtMs: 2_000,
      });
    },
  );

  it('carries observedAt as the instant the evidence resolved, not a later consumption time', async () => {
    const authority = createControlHolderAuthority();
    authority.install({ controlEpoch: 1, holder: holder('coordinator') });
    const clock = testClock(500);
    const evidenceResolvedAt = clock.now();

    const result = await observeControlHolder(authority, observerAnswering('alive'), clock);

    // Evidence time must remain its resolution instant when consumed later.
    expect(clock.compare(result.observedAt, evidenceResolvedAt)).toBeGreaterThanOrEqual(0);
    expect(clock.compare(result.observedAt, clock.now())).toBeLessThan(0);
  });
});

describe('controlHolderAuthorizationIsCurrent', () => {
  it('is true while the authority still holds the epoch and holder the capability names', async () => {
    const authority = createControlHolderAuthority();
    authority.install({ controlEpoch: 1, holder: holder('coordinator') });
    const observation = await observeControlHolder(authority, observerAnswering('absent'), testClock());
    if (observation.disposition !== 'absent') throw new Error('expected an absent disposition');

    expect(controlHolderAuthorizationIsCurrent(authority, observation.authorization)).toBe(true);
  });

  it('is revoked the instant a successor is installed, before any consumption', async () => {
    const authority = createControlHolderAuthority();
    authority.install({ controlEpoch: 1, holder: holder('incumbent') });
    const observation = await observeControlHolder(authority, observerAnswering('absent'), testClock());
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
