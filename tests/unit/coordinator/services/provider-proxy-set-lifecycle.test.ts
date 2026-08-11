import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { TimerHandle } from '#src/infra/port-types.js';
import type { HandoffCapsule, HandoffCapsuleV1, HandoffCapsuleV2 } from '#src/provider-proxy/handoff-capsule.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { ProviderProxyAuthorityFault } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set-claim-mirror.js';
import {
  ProviderProxySetLifecycle,
  type CapsuleRetirementAttemptOutcome,
  type ProviderProxySetLifecycleDeps,
  type ProviderProxySetLifecycleProgressViolation,
} from '#src/coordinator/services/provider-proxy-set-lifecycle.js';
import type {
  DisappearanceDeliveryAttemptOutcome,
  ProviderContainmentDisappearanceConsumer,
} from '#src/coordinator/services/provider-containment-disappearance.js';
import type {
  ProviderProxyRecoveryDispatcher,
  ProviderProxySetLifecycleFatalError,
} from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import { isProviderProxyRecoveryFatalError } from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set-identity.js';
import type { ProviderProxySetRedemptionOutcome } from '#src/coordinator/services/provider-proxy-set-inheritance.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { ProviderOperationTerminalMetadataError } from '#src/jobs/provider-operation-terminalization.js';
import type { ProviderOperationTerminalDirective } from '#src/store/provider-operation-record.js';

const noContainmentProof = async (): Promise<null> => null;
const ignoreControlEstablished = (): void => undefined;

type ProviderProxySetLifecycleFixtureDeps = Omit<ProviderProxySetLifecycleDeps, 'recoveryDispatcher'> &
  Readonly<{
    recoveryDispatcher?: ProviderProxyRecoveryDispatcher;
    disappearanceConsumer: ProviderContainmentDisappearanceConsumer;
    proveContainmentAbsent(
      identity: ReturnType<typeof providerProxySetIdentityFromRecord>,
      signal: AbortSignal,
    ): Promise<string | null>;
    retireCapsule?(path: string): Promise<CapsuleRetirementAttemptOutcome> | CapsuleRetirementAttemptOutcome;
    rewriteCapsule?(path: string, capsule: HandoffCapsuleV2): Promise<void> | void;
    onFatal?(error: ProviderProxySetLifecycleFatalError): void;
    redeemCapsule?(
      capsule: HandoffCapsule,
      capsulePath: string,
      signal: AbortSignal,
    ): Promise<ProviderProxySetRedemptionOutcome>;
  }>;

function lifecycleFor(deps: ProviderProxySetLifecycleFixtureDeps): ProviderProxySetLifecycle {
  const retireCapsule = deps.retireCapsule ?? (() => ({ kind: 'retired' as const }));
  const rewriteCapsule = deps.rewriteCapsule ?? (() => undefined);
  const onFatal = deps.onFatal ?? (() => undefined);
  const recoveryDispatcher = createTestProviderProxyRecoveryDispatcher(
    {
      ...(deps.redeemCapsule === undefined
        ? {}
        : {
            'capsule-redemption': ({ capsule, capsulePath, signal }) =>
              deps.redeemCapsule?.(capsule, capsulePath, signal) ?? Promise.reject(new Error('unconfigured')),
          }),
      'containment-proof': ({ identity, signal }) => deps.proveContainmentAbsent(identity, signal),
      'capsule-rewrite': ({ path, capsule }) => rewriteCapsule(path, capsule),
      'capsule-retirement': ({ path }) => retireCapsule(path),
      'disappearance-consumer': ({ notice }) => deps.disappearanceConsumer.containmentDisappeared(notice),
    },
    onFatal,
  );
  const {
    proveContainmentAbsent: _proveContainmentAbsent,
    retireCapsule: _retireCapsule,
    rewriteCapsule: _rewriteCapsule,
    onFatal: _onFatal,
    redeemCapsule: _redeemCapsule,
    disappearanceConsumer: _disappearanceConsumer,
    recoveryDispatcher: suppliedDispatcher,
    ...lifecycleDeps
  } = deps;
  return new ProviderProxySetLifecycle({
    ...lifecycleDeps,
    recoveryDispatcher: suppliedDispatcher ?? recoveryDispatcher,
  });
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
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
  overrides: Partial<HandoffCapsuleV1> = {},
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

function capsuleV2For(authority: DurableProviderProxyOperationAuthority): HandoffCapsuleV2 {
  const identity = authority.setIdentity;
  return {
    ...capsuleFor(authority),
    version: 2,
    guardianPid: identity.guardianPid,
    guardianProcessStartedAtSeconds: identity.guardianProcessStartedAtSeconds,
    proxyPid: identity.proxyPid,
    reaperPid: identity.reaperPid,
    reaperProcessStartedAtSeconds: identity.reaperProcessStartedAtSeconds,
    containmentKind: identity.containmentKind,
    proxyProcessStartedAtSeconds: identity.proxyProcessStartedAtSeconds,
    proxyProcessGroupId: identity.proxyProcessGroupId,
  };
}

describe('ProviderProxySetLifecycle', () => {
  it('reconstructs a zero-claim capsule before admitting an overlapping fresh set', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const capsule = capsuleFor(authority);
    const proveContainmentAbsent = vi.fn(noContainmentProof);
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent,
      redeemCapsule: async () => {
        throw new Error('unconfirmed redemption');
      },
    });

    lifecycle.initializeClaimSlots();
    lifecycle.installDiscoveredCapsules([{ path: '/capsules/zero-claim.handoff.json', capsule }]);
    await Promise.resolve();

    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({ startupDiscoveryCompleted: true, represented: 1, states: ['capsule-opaque'] }),
    );
    expect(
      lifecycle.beginFreshAcquisition('same-host-route', {
        buildSetId: capsule.buildSetId,
        hostFingerprint: capsule.hostFingerprint,
      }),
    ).toEqual({ kind: 'already-represented' });
    expect(proveContainmentAbsent).not.toHaveBeenCalled();
  });

  it('contains an unmatched zero-claim redemption before evaluating publication', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const established = vi.fn();
    const rewriteCapsule = vi.fn(async (_path: string, capsule: HandoffCapsuleV2) => {
      expect(capsule).toMatchObject({
        version: 2,
        guardianPid: authority.setIdentity.guardianPid,
        proxyProcessGroupId: authority.setIdentity.proxyProcessGroupId,
      });
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: established,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      redeemCapsule: async () => ({ kind: 'redeemed', set: authority }),
      rewriteCapsule,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules([{ path: '/capsules/unmatched.handoff.json', capsule: capsuleFor(authority) }]);
    await vi.waitFor(() => expect(lifecycle.snapshot().states).toEqual(['containing']));

    expect(established).not.toHaveBeenCalled();
    expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
    expect(rewriteCapsule).toHaveBeenCalledOnce();
  });

  it('retires an unmatched exact v2 capsule after independent absence proof', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const proveContainmentAbsent = vi.fn(async () => 'exact-v2-absence');
    const retireCapsule = vi.fn(async () => ({ kind: 'retired' as const }));
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent,
      redeemCapsule: async () => {
        return {
          kind: 'temporarily-unavailable',
          incident: { kind: 'recovery-deadline', timeoutMs: 45_000 },
        };
      },
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules([
      { path: '/capsules/unmatched-v2.handoff.json', capsule: capsuleV2For(authority) },
    ]);
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));

    expect(proveContainmentAbsent).toHaveBeenCalledOnce();
    expect(retireCapsule).toHaveBeenCalledWith('/capsules/unmatched-v2.handoff.json');
  });

  it('fails exact capsule recovery on redeemed identity corruption', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const clock = new ManualClock();
    const authority = fakeAuthority();
    const corrupted = {
      ...authority,
      setIdentity: { ...authority.setIdentity, guardianPid: authority.setIdentity.guardianPid + 1 },
    };
    const fatals = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      redeemCapsule: async () => ({ kind: 'redeemed', set: corrupted }),
      onFatal: fatals,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules([
      { path: '/capsules/corrupt-v2.handoff.json', capsule: capsuleV2For(authority) },
    ]);
    await drainMicrotasks();

    expect({
      fatalCalls: fatals.mock.calls.length,
      fatal: fatals.mock.calls[0]?.[0],
      snapshot: lifecycle.snapshot(),
      activeTimers: clock.timers.filter((timer) => timer.active).length,
    }).toMatchObject({
      fatalCalls: 1,
      fatal: {
        name: 'ProviderProxySetLifecycleFatalError',
        stage: 'capsule-recovery',
        setIdentity: authority.setIdentity,
      },
      snapshot: { represented: 1, states: ['capsule-recovering'] },
      activeTimers: 0,
    });
  });

  it('dispatches exact capsule fatal evidence on arrival', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const clock = new ManualClock();
    const authority = fakeAuthority();
    const redemption = deferred<ProviderProxySetRedemptionOutcome>();
    const neverProvesAbsence = new Promise<null>(() => undefined);
    const fatals = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: () => neverProvesAbsence,
      redeemCapsule: () => redemption.promise,
      onFatal: fatals,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.installDiscoveredCapsules([
      { path: '/capsules/arrival-fatal-v2.handoff.json', capsule: capsuleV2For(authority) },
    ]);
    const corrupted = {
      ...authority,
      setIdentity: { ...authority.setIdentity, guardianPid: authority.setIdentity.guardianPid + 1 },
    };

    redemption.resolve({ kind: 'redeemed', set: corrupted });
    await drainMicrotasks();

    expect({
      fatalCalls: fatals.mock.calls.length,
      snapshot: lifecycle.snapshot(),
      activeTimers: clock.timers.filter((timer) => timer.active).length,
    }).toEqual({
      fatalCalls: 1,
      snapshot: {
        startupDiscoveryCompleted: true,
        represented: 1,
        available: 0,
        states: ['capsule-recovering'],
        pendingOperationCounts: [],
      },
      activeTimers: 0,
    });
  });

  it('fails opaque capsule recovery on redeemed identity corruption', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const clock = new ManualClock();
    const authority = fakeAuthority();
    const redemption = deferred<ProviderProxySetRedemptionOutcome>();
    const rewriteCapsule = vi.fn();
    const fatals = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      redeemCapsule: () => redemption.promise,
      rewriteCapsule,
      onFatal: fatals,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.installDiscoveredCapsules([
      { path: '/capsules/opaque-corrupt-v1.handoff.json', capsule: capsuleFor(authority) },
    ]);
    const corrupted = {
      ...authority,
      setIdentity: { ...authority.setIdentity, guardianInstanceId: randomUUID() },
    };

    redemption.resolve({ kind: 'redeemed', set: corrupted });
    await drainMicrotasks();

    expect({
      fatalCalls: fatals.mock.calls.length,
      states: lifecycle.snapshot().states,
      rewriteCalls: rewriteCapsule.mock.calls.length,
      activeTimers: clock.timers.filter((timer) => timer.active).length,
    }).toEqual({ fatalCalls: 1, states: ['capsule-opaque'], rewriteCalls: 0, activeTimers: 0 });
  });

  it('fail-stops duplicate capsule addresses, grants, and claim-binding aliases during discovery', () => {
    const record = providerOperationRecord('executing');
    const authority = fakeAuthority({ record });
    const original = capsuleFor(authority);
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);

    const noClaims = new ProviderProxySetClaimMirror();
    noClaims.initialize([]);
    const duplicateAddress = lifecycleFor({
      claims: noClaims,
      controlEstablished: ignoreControlEstablished,
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

    const duplicateGrant = lifecycleFor({
      claims: noClaims,
      controlEstablished: ignoreControlEstablished,
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

    const claimAlias = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
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
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
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
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
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

  it('dispatches post-start disappearance corruption through the global fatal route', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const fatals: ProviderProxySetLifecycleFatalError[] = [];
    const delivery = vi.fn(
      async (notice: Parameters<ProviderContainmentDisappearanceConsumer['containmentDisappeared']>[0]) => ({
        kind: 'accepted' as const,
        acceptance: {
          kind: 'accepted' as const,
          operation: { ...notice.operation, operationId: randomUUID() },
          disposition: 'record-absent' as const,
        },
      }),
    );
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: delivery },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      onFatal: (error) => fatals.push(error),
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const authority = fakeAuthority({ record });
    lifecycle.registerInheritedSet(authority);
    lifecycle.faultAuthority(authority.setIdentity);

    const acceptance = lifecycle.containmentAbsent(authority.setIdentity, 'corrupt-disappearance-identity');
    const outcome = await acceptance.initialDisposition.then(
      () => ({ kind: 'fulfilled' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    expect({
      initialDisposition: outcome.kind,
      branded: outcome.kind === 'rejected' && isProviderProxyRecoveryFatalError(outcome.error),
      fatal: outcome.kind === 'rejected' ? outcome.error : null,
      dispatcherGlobalFatalCalls: fatals.length,
      sameFatal: outcome.kind === 'rejected' && fatals[0] === outcome.error,
      representedPendingRows: lifecycle.snapshot().pendingOperationCounts[0],
      activeRetryTimers: clock.timers.filter((timer) => timer.active).length,
      laterDeliveryCalls: delivery.mock.calls.length - 1,
    }).toMatchObject({
      initialDisposition: 'rejected',
      branded: true,
      fatal: { stage: 'disappearance-delivery', producerId: 'disappearance-consumer' },
      dispatcherGlobalFatalCalls: 1,
      sameFatal: true,
      representedPendingRows: 1,
      activeRetryTimers: 0,
      laterDeliveryCalls: 0,
    });
  });

  it('forwards nested disappearance fatal evidence without republishing it', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const globalFatals: ProviderProxySetLifecycleFatalError[] = [];
    const directive: ProviderOperationTerminalDirective = {
      kind: 'terminal-failed',
      code: 'provider_lost',
      reason: 'nested disappearance fatal',
    };
    const dispatcher: ProviderProxyRecoveryDispatcher = createTestProviderProxyRecoveryDispatcher(
      {
        'containment-proof': async () => null,
        'disappearance-terminalization': () => {
          throw new ProviderOperationTerminalMetadataError(record.operation);
        },
        'disappearance-consumer': ({ notice }) =>
          new Promise<DisappearanceDeliveryAttemptOutcome>((_resolve, reject) => {
            const inner = dispatcher.begin(
              'disappearance-delivery',
              { operation: notice.operation, setIdentity: notice.setIdentity },
              {
                evidence: () => reject(new Error('nested terminalization unexpectedly produced evidence')),
                retry: () => reject(new Error('nested terminalization unexpectedly requested retry')),
                fatal: reject,
              },
            );
            inner.start({
              sourceId: 'terminalization',
              producerId: 'disappearance-terminalization',
              input: { record, directive },
            });
          }),
      },
      (error) => globalFatals.push(error),
    );
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      recoveryDispatcher: dispatcher,
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const authority = fakeAuthority({ record });
    lifecycle.registerInheritedSet(authority);
    lifecycle.faultAuthority(authority.setIdentity);

    const acceptance = lifecycle.containmentAbsent(authority.setIdentity, 'nested-disappearance-fatal');
    const outcome = await acceptance.initialDisposition.then(
      () => ({ kind: 'fulfilled' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    expect({
      initialDisposition: outcome.kind,
      globalFatalCalls: globalFatals.length,
      branded: outcome.kind === 'rejected' && isProviderProxyRecoveryFatalError(outcome.error),
      sameObject: outcome.kind === 'rejected' && outcome.error === globalFatals[0],
      fatalIdentities: globalFatals.map((fatal) => ({
        branded: isProviderProxyRecoveryFatalError(fatal),
        sameOutcome: outcome.kind === 'rejected' && outcome.error === fatal,
        producerId: fatal.producerId,
        causeName: fatal.cause instanceof Error ? fatal.cause.name : typeof fatal.cause,
      })),
      representedPendingRows: lifecycle.snapshot().pendingOperationCounts[0],
      activeRetryTimers: clock.timers.filter((timer) => timer.active).length,
    }).toEqual({
      initialDisposition: 'rejected',
      globalFatalCalls: 1,
      branded: true,
      sameObject: true,
      fatalIdentities: [
        {
          branded: true,
          sameOutcome: true,
          producerId: 'disappearance-terminalization',
          causeName: 'ProviderOperationTerminalMetadataError',
        },
      ],
      representedPendingRows: 1,
      activeRetryTimers: 0,
    });
  });

  it('retains absence and its capsule until every captured operation acknowledges durable disposition', async () => {
    const first = providerOperationRecord('executing');
    const second = providerOperationRecord('executing', {
      operation: { ...first.operation, jobId: randomUUID(), operationId: randomUUID() },
      locator: first.locator,
    });
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([first, second]);
    const secondAcceptance = deferred<DisappearanceDeliveryAttemptOutcome>();
    const retireCapsule = vi.fn(async () => ({ kind: 'retired' as const }));
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: {
        containmentDisappeared: (notice) =>
          notice.operation.jobId === first.operation.jobId
            ? Promise.resolve({
                kind: 'accepted',
                acceptance: {
                  kind: 'accepted',
                  operation: notice.operation,
                  disposition: 'terminalization-committed',
                },
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
      acceptance: {
        kind: 'accepted',
        operation: second.operation,
        disposition: 'terminalization-committed',
      },
    });
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));

    expect(retireCapsule).toHaveBeenCalledWith('/capsules/set.handoff.json');
  });

  it('retains the slot until capsule retirement succeeds', async () => {
    const clock = new ManualClock();
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const retireCapsule = vi
      .fn(async (): Promise<CapsuleRetirementAttemptOutcome> => ({ kind: 'retired' }))
      .mockResolvedValueOnce({
        kind: 'temporarily-unavailable',
        incident: { kind: 'capsule-directory-durability-unavailable' },
      });
    const authority = fakeAuthority({
      stopAndReap: async () => ({ disappearanceReceipt: 'exact-absence' }),
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority, '/capsules/set.handoff.json');

    lifecycle.faultAuthority(authority.setIdentity);
    const acceptance = lifecycle.containmentAbsent(authority.setIdentity, 'exact-absence');
    await vi.waitFor(() => expect(retireCapsule).toHaveBeenCalledOnce());
    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({ represented: 1, states: ['absence-delivery-pending'] }),
    );
    await expect(acceptance.initialDisposition).resolves.toEqual({
      kind: 'operational-retry-owned',
      incidents: [
        expect.objectContaining({
          stage: 'capsule-retirement',
          code: 'capsule_retirement_unavailable',
          reason: 'capsule-directory-durability-unavailable',
        }),
      ],
    });

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
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
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
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
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
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
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
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
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
