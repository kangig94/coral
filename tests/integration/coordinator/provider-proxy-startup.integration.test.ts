import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  ProviderOperationReconciler,
  StartupSetRecoveryProducer,
  type StartupSetRecoveryPort,
} from '#src/coordinator/services/provider-operation-reconciler.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set-claim-mirror.js';
import {
  ProviderProxySetLifecycle,
  ProviderProxySetLifecycleFatalError,
  type DisappearanceDeliveryAttemptOutcome,
} from '#src/coordinator/services/provider-proxy-set-lifecycle.js';
import {
  providerProxySetIdentityFromRecord,
  providerProxySetKey,
} from '#src/coordinator/services/provider-proxy-set-identity.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
import type { HandoffCapsuleV1, HandoffCapsuleV2 } from '#src/provider-proxy/handoff-capsule.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function drainMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function createDb(records: readonly ProviderOperationRecord[]): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  for (const record of records) insertProviderOperation(db, record);
  return db;
}

function secondSetRecord(): ProviderOperationRecord {
  const base = providerOperationRecord('executing');
  const proxyInstanceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3';
  return providerOperationRecord('executing', {
    operation: {
      jobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
      operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
      proxyInstanceId,
      buildSetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4',
    },
    locator: {
      ...base.locator,
      hostFingerprint: 'e'.repeat(64),
      guardian: {
        ...base.locator.guardian,
        instanceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
        controlEndpoint: '/tmp/startup-b-guardian.sock',
      },
      reaper: {
        ...base.locator.reaper,
        instanceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6',
        controlEndpoint: '/tmp/startup-b-reaper.sock',
      },
      proxy: {
        ...base.locator.proxy,
        instanceId: proxyInstanceId,
        controlEndpoint: '/tmp/startup-b-proxy.sock',
      },
    },
  });
}

function lifecycleFor(
  records: readonly ProviderOperationRecord[],
  options: Readonly<{
    time: VirtualTime;
    containmentDisappeared(notice: {
      operation: ProviderOperationRecord['operation'];
    }): Promise<DisappearanceDeliveryAttemptOutcome>;
    retireCapsule?: () =>
      | Readonly<{ kind: 'retired' }>
      | Readonly<{
          kind: 'operational-failure';
          code: 'capsule_retirement_unavailable';
          reason: string;
        }>;
    proveContainmentAbsent?: ProviderProxySetLifecycle['containmentAbsent'] extends never
      ? never
      : () => Promise<string | null>;
    redeemCapsule?: () => Promise<never>;
    onFatal?: (error: ProviderProxySetLifecycleFatalError) => void;
  }>,
): ProviderProxySetLifecycle {
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize(records);
  const lifecycle = new ProviderProxySetLifecycle({
    claims,
    controlEstablished: () => undefined,
    disappearanceConsumer: {
      containmentDisappeared: (notice) => options.containmentDisappeared(notice),
    },
    time: options.time,
    proveContainmentAbsent: options.proveContainmentAbsent ?? (async () => null),
    retireCapsule: () => options.retireCapsule?.() ?? { kind: 'retired' },
    rewriteCapsule: () => undefined,
    onFatal: options.onFatal ?? (() => undefined),
    ...(options.redeemCapsule === undefined ? {} : { redeemCapsule: options.redeemCapsule }),
  });
  lifecycle.initializeClaimSlots();
  return lifecycle;
}

function reconcilerFor(
  db: Database,
  time: VirtualTime,
  startupSetRecovery: StartupSetRecoveryPort,
): ProviderOperationReconciler {
  return new ProviderOperationReconciler({
    getProgressStore: () => ({
      getDb: () => db,
      commit: () => {
        throw new Error('startup fixture unexpectedly committed a job event');
      },
      readStatus: () => null,
      readLaunchProjection: () => null,
    }),
    authorityFor: () => null,
    startupSetRecovery,
    registry: { activate: vi.fn(), attach: vi.fn(), settled: vi.fn(), stop: vi.fn() },
    materializePrepare: () => {
      throw new Error('startup fixture unexpectedly materialized prepare input');
    },
    recoverLocalJob: async () => {
      throw new Error('startup fixture unexpectedly recovered a local job');
    },
    completeLocalRecovery: () => undefined,
    terminalization: {
      terminalize: () => {
        throw new Error('startup fixture unexpectedly terminalized through an authority');
      },
    },
    backendNamespace: 'provider-proxy-startup-integration',
    time,
  });
}

function v1CapsuleFor(record: ProviderOperationRecord): HandoffCapsuleV1 {
  const identity = providerProxySetIdentityFromRecord(record);
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
  };
}

function v2CapsuleFor(record: ProviderOperationRecord): HandoffCapsuleV2 {
  const identity = providerProxySetIdentityFromRecord(record);
  return {
    ...v1CapsuleFor(record),
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

describe('provider proxy startup set recovery', () => {
  it('shares one recovery promise while same-set delivery is gated', async () => {
    const record = providerOperationRecord('executing');
    const time = new VirtualTime();
    const delivery = deferred<DisappearanceDeliveryAttemptOutcome>();
    const lifecycle = lifecycleFor([record], {
      time,
      containmentDisappeared: () => delivery.promise,
    });
    lifecycle.completeStartupDiscovery();
    const identity = providerProxySetIdentityFromRecord(record);
    const recover = vi.fn(async () => ({
      kind: 'absence-accepted' as const,
      acceptance: lifecycle.containmentAbsent(identity, 'shared-proof'),
    }));
    const producer = new StartupSetRecoveryProducer(recover);
    const work = { key: providerProxySetKey(identity), identity, operations: [record.operation] };

    const first = producer.recoverSetAtStartup(work, new AbortController().signal);
    const second = producer.recoverSetAtStartup(work, new AbortController().signal);

    expect({ sharedPromise: second === first, proofCalls: recover.mock.calls.length }).toEqual({
      sharedPromise: true,
      proofCalls: 1,
    });
    delivery.resolve({
      kind: 'accepted',
      acceptance: { kind: 'accepted', operation: record.operation, disposition: 'record-absent' },
    });
    await expect(first).resolves.toMatchObject({ kind: 'absence-accepted' });
  });

  it('retires an unmatched exact v2 capsule after independent absence proof', async () => {
    const record = providerOperationRecord('executing');
    const time = new VirtualTime();
    const scheduled = vi.spyOn(time, 'setTimeout');
    const proof = vi.fn(async () => 'exact-v2-proof');
    const retirement = vi.fn(() => ({ kind: 'retired' as const }));
    const redemption = vi.fn(async () => {
      throw new Error('redemption unavailable');
    });
    const lifecycle = lifecycleFor([], {
      time,
      containmentDisappeared: async () => {
        throw new Error('zero-claim capsule must not deliver an operation');
      },
      proveContainmentAbsent: proof,
      redeemCapsule: redemption,
      retireCapsule: retirement,
    });

    const capsule = v2CapsuleFor(record);
    lifecycle.installDiscoveredCapsules([{ path: '/capsules/startup-v2.handoff.json', capsule }]);
    await drainMicrotasks();

    const snapshot = lifecycle.snapshot();
    expect({
      proofCalls: proof.mock.calls.length,
      redemptionCalls: redemption.mock.calls.length,
      retirementCalls: retirement.mock.calls.length,
      retrySchedules: scheduled.mock.calls.length,
      represented: snapshot.represented,
      states: snapshot.states,
      admission: lifecycle.beginFreshAcquisition('restored-admission', {
        buildSetId: capsule.buildSetId,
        hostFingerprint: capsule.hostFingerprint,
      }).kind,
    }).toEqual({
      proofCalls: 1,
      redemptionCalls: 1,
      retirementCalls: 1,
      retrySchedules: 0,
      represented: 0,
      states: [],
      admission: 'accepted',
    });
  });

  it('continues to set B after persistent disappearance-delivery failure', async () => {
    const setA = providerOperationRecord('executing');
    const setB = secondSetRecord();
    const db = createDb([setA, setB]);
    const time = new VirtualTime();
    const scheduled = vi.spyOn(time, 'setTimeout');
    const lifecycle = lifecycleFor([setA, setB], {
      time,
      containmentDisappeared: async () => ({
        kind: 'operational-failure',
        code: 'disappearance_consumer_unavailable',
        reason: 'journal temporarily unavailable',
      }),
    });
    lifecycle.completeStartupDiscovery();
    const identityA = providerProxySetIdentityFromRecord(setA);
    const setBVisits = vi.fn();
    const startupSetRecovery: StartupSetRecoveryPort = {
      recoverSetAtStartup: async (work) => {
        if (work.key === providerProxySetKey(identityA)) {
          return { kind: 'absence-accepted', acceptance: lifecycle.containmentAbsent(identityA, 'set-a-proof') };
        }
        setBVisits();
        return { kind: 'retry-scheduled', reason: 'set B retained for retry', nextAttemptAtMs: 25 };
      },
    };

    const abort = new AbortController();
    let settled = false;
    const startup = reconcilerFor(db, time, startupSetRecovery)
      .reconcileAtStartup(abort.signal)
      .then(
        (report) => ({ kind: 'fulfilled' as const, report }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        settled = true;
      });
    await drainMicrotasks();
    const beforeAbort = {
      setBVisits: setBVisits.mock.calls.length,
      retrySchedules: scheduled.mock.calls.length,
      settled,
    };
    abort.abort(new Error('startup delivery mutation observation complete'));
    const outcome = await startup;

    expect({ ...beforeAbort, outcome: outcome.kind }).toEqual({
      setBVisits: 1,
      retrySchedules: 1,
      settled: true,
      outcome: 'fulfilled',
    });
    expect(outcome.kind === 'fulfilled' ? outcome.report.incidents : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'absence-retry-owned' }),
        expect.objectContaining({ kind: 'set-retry-scheduled', setIdentity: providerProxySetIdentityFromRecord(setB) }),
      ]),
    );
    expect(lifecycle.snapshot()).toMatchObject({ states: expect.arrayContaining(['absence-delivery-pending']) });
    expect(scheduled).toHaveBeenCalledOnce();
  });

  it('continues to set B after persistent capsule-retirement failure', async () => {
    const setA = providerOperationRecord('executing');
    const setB = secondSetRecord();
    const db = createDb([setA, setB]);
    const time = new VirtualTime();
    const scheduled = vi.spyOn(time, 'setTimeout');
    const lifecycle = lifecycleFor([setA, setB], {
      time,
      containmentDisappeared: async (notice) => ({
        kind: 'accepted',
        acceptance: { kind: 'accepted', operation: notice.operation, disposition: 'record-absent' },
      }),
      retireCapsule: () => ({
        kind: 'operational-failure',
        code: 'capsule_retirement_unavailable',
        reason: 'capsule filesystem unavailable',
      }),
    });
    lifecycle.installDiscoveredCapsules([{ path: '/capsules/set-a.handoff.json', capsule: v1CapsuleFor(setA) }]);
    const identityA = providerProxySetIdentityFromRecord(setA);
    const setBVisits = vi.fn();
    const startupSetRecovery: StartupSetRecoveryPort = {
      recoverSetAtStartup: async (work) => {
        if (work.key === providerProxySetKey(identityA)) {
          return { kind: 'absence-accepted', acceptance: lifecycle.containmentAbsent(identityA, 'set-a-proof') };
        }
        setBVisits();
        return { kind: 'retry-scheduled', reason: 'set B retained for retry', nextAttemptAtMs: 25 };
      },
    };

    const abort = new AbortController();
    let settled = false;
    const startup = reconcilerFor(db, time, startupSetRecovery)
      .reconcileAtStartup(abort.signal)
      .then(
        (report) => ({ kind: 'fulfilled' as const, report }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        settled = true;
      });
    await drainMicrotasks();
    const beforeAbort = {
      setBVisits: setBVisits.mock.calls.length,
      retrySchedules: scheduled.mock.calls.length,
      settled,
    };
    abort.abort(new Error('startup retirement mutation observation complete'));
    const outcome = await startup;

    expect({ ...beforeAbort, outcome: outcome.kind }).toEqual({
      setBVisits: 1,
      retrySchedules: 1,
      settled: true,
      outcome: 'fulfilled',
    });
    expect(outcome.kind === 'fulfilled' ? outcome.report.incidents : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'absence-retry-owned',
          incident: expect.objectContaining({ stage: 'capsule-retirement' }),
        }),
      ]),
    );
    expect(lifecycle.snapshot()).toMatchObject({ states: expect.arrayContaining(['absence-delivery-pending']) });
    expect(scheduled).toHaveBeenCalledOnce();
  });

  it('aborts while disappearance initial disposition is pending', async () => {
    const setA = providerOperationRecord('executing');
    const db = createDb([setA]);
    const time = new VirtualTime();
    const deliveryStarted = deferred<void>();
    const delivery = deferred<DisappearanceDeliveryAttemptOutcome>();
    const lifecycle = lifecycleFor([setA], {
      time,
      containmentDisappeared: () => {
        deliveryStarted.resolve();
        return delivery.promise;
      },
    });
    lifecycle.completeStartupDiscovery();
    const identity = providerProxySetIdentityFromRecord(setA);
    const startupSetRecovery: StartupSetRecoveryPort = {
      recoverSetAtStartup: async () => ({
        kind: 'absence-accepted',
        acceptance: lifecycle.containmentAbsent(identity, 'abort-proof'),
      }),
    };
    const abort = new AbortController();
    const reason = new Error('supplied startup abort reason');
    const startup = reconcilerFor(db, time, startupSetRecovery).reconcileAtStartup(abort.signal);
    let settled = false;
    const outcomePromise = startup
      .then(
        () => ({ kind: 'fulfilled' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        settled = true;
      });
    await deliveryStarted.promise;

    abort.abort(reason);
    await drainMicrotasks();
    const settledAfterAbort = settled;
    delivery.resolve({
      kind: 'accepted',
      acceptance: { kind: 'accepted', operation: setA.operation, disposition: 'record-absent' },
    });
    const outcome = await outcomePromise;

    expect({
      settledAfterAbort,
      outcome: outcome.kind,
      exactReason: outcome.kind === 'rejected' && outcome.error === reason,
    }).toEqual({ settledAfterAbort: true, outcome: 'rejected', exactReason: true });
  });

  it('rejects startup on fatal disappearance identity corruption', async () => {
    const setA = providerOperationRecord('executing');
    const setB = secondSetRecord();
    const db = createDb([setA, setB]);
    const time = new VirtualTime();
    const fatals = vi.fn();
    const lifecycle = lifecycleFor([setA, setB], {
      time,
      containmentDisappeared: async (notice) => ({
        kind: 'accepted',
        acceptance: {
          kind: 'accepted',
          operation: { ...notice.operation, operationId: randomUUID() },
          disposition: 'record-absent',
        },
      }),
      onFatal: fatals,
    });
    lifecycle.completeStartupDiscovery();
    const identityA = providerProxySetIdentityFromRecord(setA);
    const setBVisits = vi.fn();
    const startupSetRecovery: StartupSetRecoveryPort = {
      recoverSetAtStartup: async (work) => {
        if (work.key === providerProxySetKey(identityA)) {
          return { kind: 'absence-accepted', acceptance: lifecycle.containmentAbsent(identityA, 'fatal-proof') };
        }
        setBVisits();
        return { kind: 'retry-scheduled', reason: 'must not reach set B', nextAttemptAtMs: 25 };
      },
    };

    const outcome = await reconcilerFor(db, time, startupSetRecovery)
      .reconcileAtStartup(new AbortController().signal)
      .then(
        () => ({ kind: 'fulfilled' as const, fatal: false }),
        (error: unknown) => ({
          kind: 'rejected' as const,
          fatal: error instanceof ProviderProxySetLifecycleFatalError,
        }),
      );

    expect({
      outcome: outcome.kind,
      fatal: outcome.fatal,
      fatalPortCalls: fatals.mock.calls.length,
      setBVisits: setBVisits.mock.calls.length,
    }).toEqual({ outcome: 'rejected', fatal: true, fatalPortCalls: 1, setBVisits: 0 });
  });
});
