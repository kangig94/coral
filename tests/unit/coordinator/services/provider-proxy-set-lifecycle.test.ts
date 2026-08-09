import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { TimerHandle } from '#src/infra/port-types.js';
import type { HandoffCapsule } from '#src/provider-proxy/handoff-capsule.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { ProviderProxyAuthorityFault } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set-claim-mirror.js';
import {
  ProviderProxySetLifecycle,
  type ProviderProxySetLifecycleProgressViolation,
} from '#src/coordinator/services/provider-proxy-set-lifecycle.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set-identity.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

const noContainmentProof = async (): Promise<null> => null;

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class ManualClock {
  nowMs = 0;
  readonly timers: Array<{ at: number; active: boolean; callback: () => void }> = [];

  now = (): number => this.nowMs;

  setTimeout = (callback: () => void, ms: number): TimerHandle => {
    const timer = { at: this.nowMs + ms, active: true, callback };
    this.timers.push(timer);
    return { unref: () => undefined, __timer: timer } as TimerHandle;
  };

  clearTimeout = (handle: TimerHandle | null): void => {
    const timer = (handle as (TimerHandle & { __timer?: { active: boolean } }) | null)?.__timer;
    if (timer !== undefined) timer.active = false;
  };

  elapse(ms: number): void {
    this.nowMs += ms;
  }

  runDue(): void {
    for (const timer of this.timers) {
      if (!timer.active || timer.at > this.nowMs) continue;
      timer.active = false;
      timer.callback();
    }
  }
}

function fakeAuthority(
  options: {
    record?: ReturnType<typeof providerOperationRecord>;
    fault?: ReturnType<typeof deferred<ProviderProxyAuthorityFault>>;
    stopAndReap?: DurableProviderProxyOperationAuthority['stopAndReap'];
  } = {},
): DurableProviderProxyOperationAuthority {
  const record = options.record ?? providerOperationRecord('executing');
  const fault = options.fault ?? deferred<ProviderProxyAuthorityFault>();
  return {
    proxyInstanceId: record.operation.proxyInstanceId,
    setIdentity: providerProxySetIdentityFromRecord(record),
    faulted: fault.promise,
    onFault: (listener) => {
      void fault.promise.then(listener);
      return () => undefined;
    },
    registerSuccessionOperation: async () => undefined,
    stopAndReap: options.stopAndReap ?? (async () => ({ unconfirmed: 'not proved' })),
    stopHeartbeats: () => undefined,
    initiateControlClose: async () => undefined,
    prepareOperation: async () => {
      throw new Error('unused');
    },
    inspectOperation: async () => ({ state: 'absent' }),
    authorizeOperation: async () => {
      throw new Error('unused');
    },
    activatePreparedOperation: async () => {
      throw new Error('unused');
    },
    attachOperation: async () => ({ state: 'operation-absent', operation: record.operation }),
    cancelOperation: async () => ({
      state: 'released-never-started',
      operation: record.operation,
      prepareAttemptNumber: 1,
      prepareAttemptKey: 'b'.repeat(64),
    }),
    settleOperation: async (_operation, finalProviderSeq) => ({
      state: 'released-after-terminal',
      settledThroughProviderSeq: finalProviderSeq,
    }),
    buildOperationControl: () => ({ stop: async () => undefined }),
  };
}

function capsuleFor(
  authority: DurableProviderProxyOperationAuthority,
  overrides: Partial<HandoffCapsule> = {},
): HandoffCapsule {
  const identity = authority.setIdentity;
  return {
    version: 1,
    grantId: randomUUID(),
    secret: 'c'.repeat(64),
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: identity.buildSetId,
    hostFingerprint: identity.hostFingerprint,
    guardianInstanceId: identity.guardianInstanceId,
    reaperInstanceId: identity.reaperInstanceId,
    proxyInstanceId: identity.proxyInstanceId,
    guardianControlEndpoint: identity.guardianControlEndpoint,
    reaperControlEndpoint: identity.reaperControlEndpoint,
    proxyEndpoint: identity.canonicalEndpoint,
    orphanTimeoutMs: 30_000,
    teardownReserveMs: 14_000,
    ...overrides,
  };
}

describe('ProviderProxySetLifecycle', () => {
  it('reconstructs a zero-claim capsule before admitting an overlapping fresh set', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const capsule = capsuleFor(authority);
    const lifecycle = new ProviderProxySetLifecycle({
      claims,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      redeemCapsule: async () => {
        throw new Error('unconfirmed redemption');
      },
    });

    lifecycle.initializeClaimSlots();
    lifecycle.installDiscoveredCapsules([{ path: '/capsules/zero-claim.handoff.json', capsule }]);
    await Promise.resolve();

    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({ startupDiscoveryCompleted: true, represented: 1, states: ['capsule-recovering'] }),
    );
    expect(
      lifecycle.beginFreshAcquisition('same-host-route', {
        buildSetId: capsule.buildSetId,
        hostFingerprint: capsule.hostFingerprint,
      }),
    ).toEqual({ kind: 'already-represented' });
  });

  it('fail-stops duplicate capsule addresses, grants, and claim-binding aliases during discovery', () => {
    const record = providerOperationRecord('executing');
    const authority = fakeAuthority({ record });
    const original = capsuleFor(authority);
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);

    const noClaims = new ProviderProxySetClaimMirror();
    noClaims.initialize([]);
    const duplicateAddress = new ProviderProxySetLifecycle({
      claims: noClaims,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
    });
    duplicateAddress.initializeClaimSlots();
    expect(() =>
      duplicateAddress.installDiscoveredCapsules([
        { path: '/capsules/a.handoff.json', capsule: original },
        { path: '/capsules/b.handoff.json', capsule: { ...original, grantId: randomUUID() } },
      ]),
    ).toThrow('provider_proxy_capsule_address_alias');

    const duplicateGrant = new ProviderProxySetLifecycle({
      claims: noClaims,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
    });
    duplicateGrant.initializeClaimSlots();
    expect(() =>
      duplicateGrant.installDiscoveredCapsules([
        { path: '/capsules/a.handoff.json', capsule: original },
        {
          path: '/capsules/c.handoff.json',
          capsule: {
            ...original,
            hostFingerprint: 'd'.repeat(64),
            proxyInstanceId: randomUUID(),
          },
        },
      ]),
    ).toThrow('provider_proxy_capsule_grant_alias');

    const claimAlias = new ProviderProxySetLifecycle({
      claims,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
    });
    claimAlias.initializeClaimSlots();
    expect(() =>
      claimAlias.installDiscoveredCapsules([
        {
          path: '/capsules/claim.handoff.json',
          capsule: { ...original, guardianInstanceId: randomUUID() },
        },
      ]),
    ).toThrow('provider_proxy_capsule_claim_identity_mismatch');
  });
  it('removes routing immediately when the operation authority fault latch resolves', async () => {
    const clock = new ManualClock();
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const fault = deferred<ProviderProxyAuthorityFault>();
    const faultListeners = new Set<(next: ProviderProxyAuthorityFault) => void>();
    const authority: DurableProviderProxyOperationAuthority = {
      ...fakeAuthority({ fault }),
      onFault: (listener) => {
        faultListeners.add(listener);
        return () => faultListeners.delete(listener);
      },
    };
    const lifecycle = new ProviderProxySetLifecycle({
      claims,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const admission = lifecycle.beginFreshAcquisition('codex-route');
    if (admission.kind !== 'accepted') throw new Error('expected acquisition admission');
    lifecycle.acquisitionSucceeded(admission.slotId, authority);
    expect(lifecycle.routeFor('codex-route')).toBe(authority);

    const authorityFault: ProviderProxyAuthorityFault = {
      kind: 'heartbeat-failed',
      role: 'proxy',
      method: 'control.heartbeat.v1',
      error: new Error('control closed'),
    };
    for (const listener of faultListeners) listener(authorityFault);

    expect(lifecycle.routeFor('codex-route')).toBeNull();
    expect(lifecycle.snapshot().states).toEqual(['containing']);
    fault.resolve(authorityFault);
    await authority.faulted;
  });

  it('installs absence delivery before closing controls and begins durable delivery in the same turn', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const closeObservations: Array<readonly string[]> = [];
    const containmentDisappeared = vi.fn(() => new Promise<never>(() => undefined));
    const authority: DurableProviderProxyOperationAuthority = {
      ...fakeAuthority({ record, stopAndReap: () => new Promise<never>(() => undefined) }),
      initiateControlClose: () => {
        closeObservations.push(lifecycle.snapshot().states);
        return Promise.resolve();
      },
    };
    const lifecycle = new ProviderProxySetLifecycle({
      claims,
      disappearanceConsumer: { containmentDisappeared },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);
    lifecycle.faultAuthority(authority.setIdentity);

    lifecycle.containmentAbsent(authority.setIdentity, 'public-proof-receipt');

    expect(closeObservations).toEqual([['absence-delivery-pending']]);
    expect(containmentDisappeared).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({ represented: 1, states: ['absence-delivery-pending'], pendingOperationCounts: [1] }),
    );
    expect(() => lifecycle.containmentAbsent(authority.setIdentity, 'public-proof-receipt')).not.toThrow();
    expect(() => lifecycle.containmentAbsent(authority.setIdentity, 'conflicting-receipt')).toThrow(
      'provider_proxy_containment_absence_conflict',
    );
  });

  it('retains absence and its capsule until every captured operation acknowledges durable disposition', async () => {
    const first = providerOperationRecord('executing');
    const second = providerOperationRecord('executing', {
      operation: { ...first.operation, jobId: randomUUID(), operationId: randomUUID() },
      locator: first.locator,
    });
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([first, second]);
    const secondAcceptance = deferred<{
      kind: 'accepted';
      operation: typeof second.operation;
      disposition: 'terminalization-committed';
    }>();
    const retireCapsule = vi.fn(async () => undefined);
    const lifecycle = new ProviderProxySetLifecycle({
      claims,
      disappearanceConsumer: {
        containmentDisappeared: (notice) =>
          notice.operation.jobId === first.operation.jobId
            ? Promise.resolve({
                kind: 'accepted',
                operation: notice.operation,
                disposition: 'terminalization-committed',
              })
            : secondAcceptance.promise,
      },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const authority = fakeAuthority({
      record: first,
      stopAndReap: async () => ({ disappearanceReceipt: 'exact-absence' }),
    });
    lifecycle.registerInheritedSet(authority, '/capsules/set.handoff.json');

    lifecycle.faultAuthority(authority.setIdentity);
    await vi.waitFor(() => expect(lifecycle.snapshot().pendingOperationCounts).toEqual([1]));
    expect(lifecycle.snapshot().represented).toBe(1);
    expect(retireCapsule).not.toHaveBeenCalled();

    secondAcceptance.resolve({
      kind: 'accepted',
      operation: second.operation,
      disposition: 'terminalization-committed',
    });
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));

    expect(retireCapsule).toHaveBeenCalledWith('/capsules/set.handoff.json');
  });

  it('retains the slot until capsule retirement succeeds', async () => {
    const clock = new ManualClock();
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const retirementErrors: string[] = [];
    const retireCapsule = vi
      .fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('capsule still durable'))
      .mockResolvedValue(undefined);
    const authority = fakeAuthority({
      stopAndReap: async () => ({ disappearanceReceipt: 'exact-absence' }),
    });
    const lifecycle = new ProviderProxySetLifecycle({
      claims,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
      onError: (message) => retirementErrors.push(message),
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority, '/capsules/set.handoff.json');

    lifecycle.faultAuthority(authority.setIdentity);
    await vi.waitFor(() => expect(retireCapsule).toHaveBeenCalledOnce());
    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({ represented: 1, states: ['absence-delivery-pending'] }),
    );
    expect(retirementErrors).toEqual(['Provider handoff capsule retirement failed: capsule still durable']);

    clock.elapse(1_000);
    clock.runDue();
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));
    expect(retireCapsule).toHaveBeenCalledTimes(2);
  });

  it('keeps unconfirmed containment represented, retries, and reports late scheduler wakes', async () => {
    const clock = new ManualClock();
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const violations: ProviderProxySetLifecycleProgressViolation[] = [];
    let attempts = 0;
    const authority = fakeAuthority({
      stopAndReap: async () => {
        attempts += 1;
        return { unconfirmed: 'still ambiguous' };
      },
    });
    const lifecycle = new ProviderProxySetLifecycle({
      claims,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      onProgressPremiseViolation: (violation) => violations.push(violation),
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const admission = lifecycle.beginFreshAcquisition('route');
    if (admission.kind !== 'accepted') throw new Error('expected acquisition admission');
    lifecycle.acquisitionSucceeded(admission.slotId, authority);
    lifecycle.faultAuthority(authority.setIdentity);
    expect(attempts).toBe(1);

    clock.elapse(30_500);
    clock.runDue();
    await Promise.resolve();
    await Promise.resolve();
    expect(lifecycle.snapshot().states).toEqual(['containment-wait']);

    clock.elapse(1_500);
    clock.runDue();
    await Promise.resolve();
    expect(attempts).toBe(2);
    expect(lifecycle.snapshot().represented).toBe(1);
    expect(violations).toEqual([
      expect.objectContaining({ stage: 'containment-attempt-deadline', latenessMs: 500 }),
      expect.objectContaining({ stage: 'containment-retry', latenessMs: 500 }),
    ]);
  });

  it('ignores a proof result that arrives after its containment attempt token was retired', async () => {
    const clock = new ManualClock();
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const lateProof = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['stopAndReap']>>>();
    const consumer = vi.fn(async () => ({}) as never);
    const authority = fakeAuthority({ stopAndReap: () => lateProof.promise });
    const lifecycle = new ProviderProxySetLifecycle({
      claims,
      disappearanceConsumer: { containmentDisappeared: consumer },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const admission = lifecycle.beginFreshAcquisition('route');
    if (admission.kind !== 'accepted') throw new Error('expected acquisition admission');
    lifecycle.acquisitionSucceeded(admission.slotId, authority);
    lifecycle.faultAuthority(authority.setIdentity);

    clock.elapse(30_000);
    clock.runDue();
    expect(lifecycle.snapshot().states).toEqual(['containment-wait']);

    lateProof.resolve({ disappearanceReceipt: 'stale-attempt-receipt' });
    await Promise.resolve();
    await Promise.resolve();

    expect(lifecycle.snapshot()).toEqual(expect.objectContaining({ represented: 1, states: ['containment-wait'] }));
    expect(consumer).not.toHaveBeenCalled();
  });

  it('represents a fifth inherited set as excess without admitting fresh capacity', () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const lifecycle = new ProviderProxySetLifecycle({
      claims,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();

    for (let index = 1; index <= 5; index += 1) {
      const base = providerOperationRecord('executing');
      const proxyInstanceId = randomUUID();
      const record = providerOperationRecord('executing', {
        operation: {
          ...base.operation,
          jobId: randomUUID(),
          operationId: randomUUID(),
          proxyInstanceId,
          buildSetId: randomUUID(),
        },
        locator: {
          ...base.locator,
          hostFingerprint: String(index).repeat(64),
          guardian: {
            ...base.locator.guardian,
            instanceId: randomUUID(),
            controlEndpoint: `/tmp/guardian-${index}.sock`,
          },
          reaper: {
            ...base.locator.reaper,
            instanceId: randomUUID(),
            controlEndpoint: `/tmp/reaper-${index}.sock`,
          },
          proxy: {
            ...base.locator.proxy,
            instanceId: proxyInstanceId,
            controlEndpoint: `/tmp/proxy-${index}.sock`,
          },
        },
      });
      lifecycle.registerInheritedSet(fakeAuthority({ record }));
    }

    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({ represented: 5, available: 4, states: expect.arrayContaining(['containing']) }),
    );
    expect(lifecycle.beginFreshAcquisition('new-route')).toEqual({
      kind: 'capacity',
      code: 'provider_proxy_set_capacity',
    });
  });

  it('keeps a graceful drain live while a durable executing claim exists before attachment', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'still claimed' }) as const);
    const authority = fakeAuthority({ record, stopAndReap });
    const lifecycle = new ProviderProxySetLifecycle({
      claims,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    lifecycle.beginGracefulDrain(authority.setIdentity);
    expect(stopAndReap).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().states).toEqual(['draining']);

    claims.applyMutation({ kind: 'deleted', record });
    lifecycle.claimsChanged(authority.setIdentity);
    expect(stopAndReap).toHaveBeenCalledOnce();
  });
});
