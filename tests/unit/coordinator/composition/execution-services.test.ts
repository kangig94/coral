import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createExecutionServices } from '#src/coordinator/composition/execution-services.js';
import {
  createProviderProxyOperationAuthority,
  type DurableProviderProxyOperationAuthority,
} from '#src/coordinator/live/provider-proxy/operation-route.js';
import { createProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/set-authority.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import {
  createProviderProxyAuthorityFaultLatch,
  type ProviderProxyAuthorityFault,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import {
  providerProxySetIdentityFromRecord,
  type ProviderProxySetIdentity,
} from '#src/coordinator/services/provider-proxy-set/identity.js';
import { ProviderProxySetLifecycleRef } from '#src/coordinator/services/provider-proxy-set/lifecycle-ref.js';
import { backendLog } from '#src/infra/backend-log.js';
import { JobStore } from '#src/jobs/store.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import { CURRENT_HANDOFF_CAPSULE_VERSION, type HandoffCapsuleV3 } from '#src/provider-proxy/handoff-capsule.js';
import {
  CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV,
  MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  PROXY_TEARDOWN_RESERVE_MS,
  providerProxyHeartbeatHoldBound,
} from '#src/provider-proxy/orphan-deadline.js';
import type { Database } from '#src/store/db.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

/** The build these fixture worlds belong to; capsules built from the same fixtures are inheritable, not foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';
const TEST_AUTONOMOUS_DEADLINE = {
  owner: 'guardian-and-reaper' as const,
  orphanTimeoutMs: 37_000,
  heartbeatHoldBound: providerProxyHeartbeatHoldBound({ orphanTimeoutMs: 37_000, teardownReserveMs: 14_000 }),
};

type SharedSetControl = 'settlement-timeout' | 'control-channel-fault' | 'heartbeat-failed';

function setReference(identity: ProviderProxySetIdentity): string {
  return `proxyInstanceId=${identity.proxyInstanceId},buildSetId=${identity.buildSetId}`;
}

async function createSharedSetHarness(control: SharedSetControl) {
  const namespace = `execution-services-shared-set-${control}`;
  const time = new VirtualTime();
  const runtime = { ...createRealRuntime('prod'), time };
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const progressStore = new JobStore(namespace, runtime, createEventBodyCodec(), {
    db,
    providers: permissiveProviderLookupPort,
  });
  const claims = new ProviderProxySetClaimMirror();
  const lifecycleRef = new ProviderProxySetLifecycleRef();
  const operationRegistry = new LocalOperationRegistry();
  const world = {
    identity: { buildSetId: FIXTURE_BUILD_SET_ID },
    storeServicesRef: { tryGet: () => ({ progressStore }) },
    operationRegistry,
    providerProxyClaims: claims,
    providerProxyLifecycleRef: lifecycleRef,
    providerHostManager: {},
  } as never;
  const services = createExecutionServices({
    world,
    runtime,
    bundleHash: namespace,
    backendNamespace: namespace,
    onProviderProxyLifecycleFatal: (error) => {
      throw error;
    },
    createExecutionService: (() => {
      throw new Error('execution service creation was not expected');
    }) as never,
  });
  await services.reconcileProviderOperationsAtStartup(new AbortController().signal);

  const settlement = providerOperationRecord('settlement-pending');
  const siblings = [
    providerOperationRecord('executing', {
      operation: {
        jobId: randomUUID(),
        operationId: randomUUID(),
        proxyInstanceId: settlement.operation.proxyInstanceId,
        buildSetId: settlement.operation.buildSetId,
      },
      locator: settlement.locator,
    }),
    providerOperationRecord('executing', {
      operation: {
        jobId: randomUUID(),
        operationId: randomUUID(),
        proxyInstanceId: settlement.operation.proxyInstanceId,
        buildSetId: settlement.operation.buildSetId,
      },
      locator: settlement.locator,
    }),
  ];
  const records = [...siblings, settlement];
  const setIdentity = providerProxySetIdentityFromRecord(settlement);
  const formattedTimeout = 'settlement timed out';
  const timeout = Object.assign(new Error(formattedTimeout), { code: 'control_call_failed' });
  const proxyClient = {
    call: vi.fn(async (method: string, params: unknown) => {
      if (method === 'operation.attach.v1') {
        const committedThroughProviderSeq = (params as { committedThroughProviderSeq: number })
          .committedThroughProviderSeq;
        return { state: 'attached', replayFromProviderSeq: committedThroughProviderSeq + 1 };
      }
      if (method === 'operation.settle.v1' && control === 'settlement-timeout') throw timeout;
      throw new Error(`unexpected proxy control call: ${method}`);
    }),
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => undefined,
  } satisfies ControlClient;
  const idleClient = {
    call: async (method: string) => {
      throw new Error(`unexpected role control call: ${method}`);
    },
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => undefined,
  } satisfies ControlClient;
  const stopAndReap = vi.fn(async () =>
    control === 'settlement-timeout'
      ? ({ unconfirmed: 'unexpected settlement containment' } as const)
      : ({ disappearanceReceipt: `${control}-containment-absent` } as const),
  );
  const faults = createProviderProxyAuthorityFaultLatch();
  const authority = createProviderProxyOperationAuthority({
    base: {
      proxyInstanceId: setIdentity.proxyInstanceId,
      autonomousDeadline: TEST_AUTONOMOUS_DEADLINE,
      stopAndReap,
      stopHeartbeats: () => undefined,
      initiateControlClose: async () => undefined,
      registerSuccessionOperation: async () => undefined,
    },
    setIdentity,
    clients: { proxy: proxyClient, guardian: idleClient, reaper: idleClient },
    faults,
    mutationRpcTimeoutMs: 5_000,
  });
  const lifecycle = lifecycleRef.get();
  if (lifecycle === null) throw new Error('provider proxy lifecycle was not composed');
  const admission = lifecycle.beginFreshAcquisition(`shared-set-${control}`);
  if (admission.kind !== 'accepted') throw new Error(`fresh set was not admitted: ${admission.kind}`);
  lifecycle.acquisitionSucceeded(admission.slotId, authority);

  for (const record of records) {
    const sessionId = randomUUID();
    seedTestSessionProjection(db, {
      sessionId,
      provider: 'codex',
      projectRoot: process.cwd(),
      backendNamespace: namespace,
      activeJobId: record.operation.jobId,
    });
    progressStore.appendLaunchRequested(record.operation.jobId, {
      jobId: record.operation.jobId,
      owner: { kind: 'provider-session', id: sessionId },
      sessionId,
      provider: 'codex',
      projectRoot: process.cwd(),
      backendNamespace: namespace,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 1,
      providerAction: 'exec',
      request: { prompt: 'test', cwd: process.cwd(), bypassPermissions: false, coralEnv: {} },
      createdAt: '2026-08-09T12:34:55.000Z',
    });
    insertProviderOperation(db, record);
  }

  return {
    claims,
    db,
    faults,
    formattedTimeout,
    lifecycle,
    records,
    services,
    settlement,
    setIdentity,
    siblings,
    stopAndReap,
    timeout,
  };
}

describe('execution services provider-proxy proof composition', () => {
  // Skipping a row this build cannot read is only half the contract; the other half is that an operator can
  // find out. The skip was pinned and the reporting was not — deleting the whole warn block left every gate
  // green, which turns "tolerated and reported" into "silently dropped" without a single test noticing.
  //
  // This is the first scan on the boot path, so it is the one place the news can be delivered at all.
  it('reports the rows it skipped, by key, on the first boot-path scan', async () => {
    const runtime = createRealRuntime('prod');
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const namespace = 'execution-services-unreadable-report';
    const progressStore = new JobStore(namespace, runtime, createEventBodyCodec(), {
      db,
      providers: permissiveProviderLookupPort,
    });
    const claims = new ProviderProxySetClaimMirror();

    const readable = providerOperationRecord('executing');
    insertProviderOperation(db, readable);

    // A genuine predecessor row, at the address v0.10.8 actually wrote to. Its bytes are never parsed — the
    // generation is in the key — so this needs no forged payload to be exactly what the field will hold.
    const stranded = providerOperationRecord('prepare-pending', { job: 2 });
    const supersededKey =
      `provider_operation_saga.v1:record:${stranded.operation.jobId}:${stranded.operation.operationId}:` +
      `${stranded.operation.proxyInstanceId}:${stranded.operation.buildSetId}`;
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(supersededKey, 'unparsed');

    const world = {
      identity: { buildSetId: FIXTURE_BUILD_SET_ID },
      storeServicesRef: { tryGet: () => ({ progressStore }) },
      operationRegistry: new LocalOperationRegistry(),
      providerProxyClaims: claims,
      providerProxyLifecycleRef: new ProviderProxySetLifecycleRef(),
      providerHostManager: {},
    } as never;

    const services = createExecutionServices({
      world,
      runtime,
      bundleHash: namespace,
      backendNamespace: namespace,
      onProviderProxyLifecycleFatal: (error) => {
        throw error;
      },
      createExecutionService: (() => {
        throw new Error('execution service creation was not expected');
      }) as never,
    });

    // Captured inside the try, never read off the spy afterwards: `mockRestore()` clears `mock.calls`, so an
    // assertion placed after the teardown reads an empty array and fails whatever the code did.
    const reported: string[] = [];
    const warning = vi.spyOn(backendLog, 'warn').mockImplementation((message) => {
      reported.push(String(message));
    });
    try {
      await services.reconcileProviderOperationsAtStartup(new AbortController().signal);
    } finally {
      warning.mockRestore();
      services.stopProviderOperationReconciler();
      db.close();
    }

    const skipped = reported.filter((line) => line.includes('Skipped'));
    expect(skipped).toHaveLength(1);
    // By key, because the key is the only thing about the row this build is entitled to claim it understands.
    expect(skipped[0]).toContain(supersededKey);
    // And the boot still happened, on the rows it could read. A report that cost the daemon its startup would
    // be the fatality this whole path exists to avoid, and a scan that reported the skip and then initialized
    // nothing would satisfy the assertion above while losing every live claim.
    expect(claims.claimFor(readable.operation), 'the readable row still became a live claim').not.toBeNull();
    expect(claims.size, 'and the unreadable one contributed none').toBe(1);
  });

  it('does not invoke the disappearance consumer producer during assembly', async () => {
    const runtime = createRealRuntime('prod');
    const claims = new ProviderProxySetClaimMirror();
    const lifecycleRef = new ProviderProxySetLifecycleRef();
    const operationRegistry = new LocalOperationRegistry();
    const inheritProviderProxySet = vi.fn(async () => ({ kind: 'not-bequeathed' as const, reason: 'unused' }));
    const redeemDiscoveredCapsule = vi.fn(async () => {
      throw new Error('capsule redemption was not expected');
    });
    const proveContainmentAbsent = vi.fn(async () => null);
    const world = {
      identity: { buildSetId: FIXTURE_BUILD_SET_ID },
      storeServicesRef: { tryGet: () => null },
      operationRegistry,
      providerProxyClaims: claims,
      providerProxyLifecycleRef: lifecycleRef,
      providerProxyInheritance: { inheritProviderProxySet, redeemDiscoveredCapsule, proveContainmentAbsent },
      providerHostManager: {},
    } as never;

    const services = createExecutionServices({
      world,
      runtime,
      bundleHash: 'execution-services-assembly-test',
      backendNamespace: 'execution-services-assembly-test',
      onProviderProxyLifecycleFatal: (error) => {
        throw error;
      },
      createExecutionService: (() => {
        throw new Error('execution service creation was not expected');
      }) as never,
    });

    expect({
      inheritanceCalls: inheritProviderProxySet.mock.calls.length,
      redemptionCalls: redeemDiscoveredCapsule.mock.calls.length,
      proofCalls: proveContainmentAbsent.mock.calls.length,
      lifecycleComposed: lifecycleRef.get() !== null,
    }).toEqual({ inheritanceCalls: 0, redemptionCalls: 0, proofCalls: 0, lifecycleComposed: true });
    services.stopProviderOperationReconciler();
  });

  it('does not publish a stored-fault authority through the production subscriber', async () => {
    const time = new VirtualTime();
    const runtime = { ...createRealRuntime('prod'), time };
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const record = providerOperationRecord('executing');
    if (record.phase !== 'executing') throw new Error('expected executing fixture');
    insertProviderOperation(db, record);
    const claims = new ProviderProxySetClaimMirror();
    const lifecycleRef = new ProviderProxySetLifecycleRef();
    const operationRegistry = new LocalOperationRegistry();
    const world = {
      identity: { buildSetId: FIXTURE_BUILD_SET_ID },
      storeServicesRef: { tryGet: () => ({ progressStore: { getDb: () => db } }) },
      operationRegistry,
      providerProxyClaims: claims,
      providerProxyLifecycleRef: lifecycleRef,
      providerHostManager: {},
    } as never;
    const services = createExecutionServices({
      world,
      runtime,
      bundleHash: 'execution-services-stored-fault-test',
      backendNamespace: 'execution-services-stored-fault-test',
      onProviderProxyLifecycleFatal: (error) => {
        throw error;
      },
      createExecutionService: (() => {
        throw new Error('execution service creation was not expected');
      }) as never,
    });
    claims.initialize([record]);
    const lifecycle = lifecycleRef.get();
    if (lifecycle === null) throw new Error('provider proxy lifecycle was not composed');
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const fault = {
      kind: 'control-channel-fault' as const,
      role: 'proxy' as const,
      error: new Error('control already closed') as never,
    };
    const attachOperation = vi.fn(async () => ({
      state: 'attached' as const,
      replayFromProviderSeq: record.committedThroughProviderSeq + 1,
    }));
    const authority = {
      proxyInstanceId: record.operation.proxyInstanceId,
      autonomousDeadline: TEST_AUTONOMOUS_DEADLINE,
      setIdentity: providerProxySetIdentityFromRecord(record),
      faulted: Promise.resolve(fault),
      onFault: (listener: (observed: ProviderProxyAuthorityFault) => void) => {
        listener(fault);
        return () => undefined;
      },
      onIncident: () => () => undefined,
      attachOperation,
      stopAndReap: async () => ({ unconfirmed: 'stored fault' }),
      stopHeartbeats: () => undefined,
      initiateControlClose: async () => undefined,
      registerSuccessionOperation: async () => undefined,
    } as unknown as DurableProviderProxyOperationAuthority;

    lifecycle.registerInheritedSet(authority);
    await flushMicrotasks();

    expect({
      authority: lifecycle.authorityFor(authority.setIdentity),
      attachOperationCalls: attachOperation.mock.calls.length,
      states: lifecycle.snapshot().states,
    }).toEqual({ authority: null, attachOperationCalls: 0, states: ['containing'] });
    services.stopProviderOperationReconciler();
  });

  it('publishes an accepted fresh authority once through the production subscriber', async () => {
    const time = new VirtualTime();
    const runtime = { ...createRealRuntime('prod'), time };
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const record = providerOperationRecord('executing');
    if (record.phase !== 'executing') throw new Error('expected executing fixture');
    insertProviderOperation(db, record);
    const claims = new ProviderProxySetClaimMirror();
    const lifecycleRef = new ProviderProxySetLifecycleRef();
    const operationRegistry = new LocalOperationRegistry();
    const readLaunchProjection = vi.fn(() => ({
      jobId: record.operation.jobId,
      owner: { kind: 'provider-session' as const, id: record.operation.jobId },
      sessionId: record.operation.jobId,
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'tests',
      pool: 'default',
      enqueueSequence: 1,
      createdAt: '2026-08-09T12:34:55.000Z',
      jobKind: 'provider' as const,
      providerAction: 'exec' as const,
      request: { prompt: 'test', cwd: '/workspace', bypassPermissions: false, coralEnv: {} },
    }));
    const world = {
      identity: { buildSetId: FIXTURE_BUILD_SET_ID },
      storeServicesRef: { tryGet: () => ({ progressStore: { getDb: () => db, readLaunchProjection } }) },
      operationRegistry,
      providerProxyClaims: claims,
      providerProxyLifecycleRef: lifecycleRef,
      providerHostManager: {},
    } as never;
    const warning = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    const services = createExecutionServices({
      world,
      runtime,
      bundleHash: 'execution-services-fresh-publication-test',
      backendNamespace: 'execution-services-fresh-publication-test',
      onProviderProxyLifecycleFatal: (error) => {
        throw error;
      },
      createExecutionService: (() => {
        throw new Error('execution service creation was not expected');
      }) as never,
    });
    claims.initialize([record]);
    const lifecycle = lifecycleRef.get();
    if (lifecycle === null) throw new Error('provider proxy lifecycle was not composed');
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const attachOperation = vi.fn(async () => ({
      state: 'attached' as const,
      replayFromProviderSeq: record.committedThroughProviderSeq + 1,
    }));
    const buildOperationControl = vi.fn(() => ({ stop: async () => undefined }));
    const authority = {
      proxyInstanceId: record.operation.proxyInstanceId,
      autonomousDeadline: TEST_AUTONOMOUS_DEADLINE,
      setIdentity: providerProxySetIdentityFromRecord(record),
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      onIncident: () => () => undefined,
      attachOperation,
      stopAndReap: async () => ({ unconfirmed: 'not requested' }),
      stopHeartbeats: () => undefined,
      initiateControlClose: async () => undefined,
      registerSuccessionOperation: async () => undefined,
      buildOperationControl,
    } as unknown as DurableProviderProxyOperationAuthority;
    const admission = lifecycle.beginFreshAcquisition('fresh-publication');
    if (admission.kind !== 'accepted') throw new Error(`fresh set was not admitted: ${admission.kind}`);

    lifecycle.acquisitionSucceeded(admission.slotId, authority);
    await vi.waitFor(() => expect(attachOperation).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(buildOperationControl.mock.calls.length + warning.mock.calls.length).toBeGreaterThan(0),
    );
    lifecycle.registerInheritedSet(authority);
    await flushMicrotasks();

    expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority);
    expect(attachOperation).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
    expect(buildOperationControl).toHaveBeenCalledTimes(1);
    expect(readLaunchProjection).toHaveBeenCalledWith(record.operation.jobId);
    warning.mockRestore();
    services.stopProviderOperationReconciler();
  });

  it('preserves sibling operations when settlement times out on their shared proxy set', async () => {
    const harness = await createSharedSetHarness('settlement-timeout');
    const { claims, db, formattedTimeout, records, services, settlement, setIdentity, siblings, stopAndReap, timeout } =
      harness;
    const info = vi.spyOn(backendLog, 'info').mockImplementation(() => undefined);

    try {
      const report = await services.reconcileProviderOperationsAtStartup(new AbortController().signal);
      const storedSettlement = readProviderOperation(db, settlement.operation);
      const storedSiblings = siblings.map((record) => readProviderOperation(db, record.operation));

      expect(report.incidents).toEqual([
        {
          kind: 'operation-retry-scheduled',
          setIdentity,
          operation: settlement.operation,
          reason: timeout.message,
          nextAttemptAtMs: storedSettlement?.retryNotBeforeMs,
        },
      ]);
      expect(storedSettlement).toEqual(
        expect.objectContaining({
          phase: 'settlement-pending',
          retryCount: 1,
          lastError: expect.objectContaining({ code: timeout.code, message: timeout.message }),
        }),
      );
      expect(claims.size).toBe(3);
      expect(records.every((record) => claims.claimFor(record.operation) !== null)).toBe(true);
      expect(stopAndReap).not.toHaveBeenCalled();
      expect(storedSiblings.map((record) => record?.phase)).toEqual(['executing', 'executing']);
      const decisionRecords = info.mock.calls.filter(([message]) => message.startsWith('Provider proxy set action='));
      expect
        .soft(decisionRecords)
        .toEqual([
          [
            `Provider proxy set action=preserve reason=retry_safe_operation_control_failure fault=operation-control-failed subject=operation.settle.v1 liveClaims=3 set=${setReference(setIdentity)} error=${formattedTimeout}`,
          ],
        ]);
      expect(decisionRecords[0]?.[0].split(/\r?\n/u)).toHaveLength(1);
    } finally {
      services.stopProviderOperationReconciler();
      info.mockRestore();
    }
  });

  it.each(['control-channel-fault', 'heartbeat-failed'] as const)(
    'contains and reconciles shared-set claims after a %s authority loss',
    async (control) => {
      const harness = await createSharedSetHarness(control);
      const disappearance = vi.spyOn(ProviderOperationReconciler.prototype, 'containmentDisappeared');
      const warning = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
      try {
        const fault: ProviderProxyAuthorityFault =
          control === 'control-channel-fault'
            ? { kind: control, role: 'proxy', error: new Error('control channel lost') as never }
            : {
                kind: control,
                role: 'proxy',
                method: 'control.heartbeat.v1',
                terminalReason: 'teardown-latched',
                error: new Error('heartbeat failed'),
              };

        expect(harness.claims.size).toBe(3);
        expect(harness.records.every((record) => harness.claims.claimFor(record.operation) !== null)).toBe(true);
        harness.faults.latch(fault);
        await vi.waitFor(() => expect(disappearance).toHaveBeenCalledTimes(3));
        const outcomes = await Promise.all(
          disappearance.mock.results.map((result) => {
            if (result.type !== 'return') throw new Error('disappearance reconciliation did not return');
            return result.value;
          }),
        );
        const acceptances = outcomes.map((outcome) => {
          if (outcome.kind !== 'accepted') throw new Error(`disappearance was not accepted: ${outcome.kind}`);
          return outcome.acceptance;
        });

        expect(harness.stopAndReap).toHaveBeenCalledOnce();
        expect(warning.mock.calls.filter(([message]) => message.startsWith('Provider proxy set action='))).toEqual([
          [expect.stringContaining('action=stop-and-reap reason=provider_authority_lost')],
        ]);
        expect(acceptances).toEqual(
          expect.arrayContaining([
            {
              kind: 'accepted',
              operation: harness.siblings[0].operation,
              disposition: 'terminalization-committed',
            },
            {
              kind: 'accepted',
              operation: harness.siblings[1].operation,
              disposition: 'terminalization-committed',
            },
            {
              kind: 'accepted',
              operation: harness.settlement.operation,
              disposition: 'settlement-deleted',
            },
          ]),
        );
        expect(acceptances).toHaveLength(3);
      } finally {
        warning.mockRestore();
        disappearance.mockRestore();
        harness.services.stopProviderOperationReconciler();
      }
    },
  );

  it('reaches the public independent proof after a closed control path', async () => {
    const time = new VirtualTime();
    const runtime = { ...createRealRuntime('prod'), time };
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const claims = new ProviderProxySetClaimMirror();
    const lifecycleRef = new ProviderProxySetLifecycleRef();
    const operationRegistry = new LocalOperationRegistry();
    const proveContainmentAbsent = vi.fn<
      (identity: ProviderProxySetIdentity, db: Database, signal: AbortSignal) => Promise<string | null>
    >(async () => 'process-proof-receipt');
    const world = {
      identity: { buildSetId: FIXTURE_BUILD_SET_ID },
      storeServicesRef: {
        tryGet: () => ({ progressStore: { getDb: () => db } }),
      },
      operationRegistry,
      providerProxyClaims: claims,
      providerProxyLifecycleRef: lifecycleRef,
      providerProxyInheritance: {
        inheritProviderProxySet: async () => ({ kind: 'not-bequeathed', reason: 'unused' }),
        redeemDiscoveredCapsule: async () => {
          throw new Error('capsule redemption was not expected');
        },
        proveContainmentAbsent,
      },
      providerHostManager: {},
    } as never;
    createExecutionServices({
      world,
      runtime,
      bundleHash: 'execution-services-test',
      backendNamespace: 'execution-services-test',
      onProviderProxyLifecycleFatal: (error) => {
        throw error;
      },
      createExecutionService: (() => {
        throw new Error('execution service creation was not expected');
      }) as never,
    });
    claims.initialize([]);
    const lifecycle = lifecycleRef.get();
    if (lifecycle === null) throw new Error('provider proxy lifecycle was not composed');
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();

    const record = providerOperationRecord('executing');
    const setIdentity = providerProxySetIdentityFromRecord(record);
    const faultSubscription: { listener: ((fault: ProviderProxyAuthorityFault) => void) | null } = {
      listener: null,
    };
    let stopAttempts = 0;
    const authority = {
      proxyInstanceId: setIdentity.proxyInstanceId,
      autonomousDeadline: TEST_AUTONOMOUS_DEADLINE,
      setIdentity,
      faulted: new Promise<never>(() => undefined),
      onFault: (listener: (fault: ProviderProxyAuthorityFault) => void) => {
        faultSubscription.listener = listener;
        return () => {
          faultSubscription.listener = null;
        };
      },
      onIncident: () => () => undefined,
      stopAndReap: async () => {
        stopAttempts += 1;
        return { unconfirmed: 'control_client_closed' } as const;
      },
      stopHeartbeats: () => undefined,
      initiateControlClose: async () => undefined,
      registerSuccessionOperation: async () => undefined,
    } as unknown as DurableProviderProxyOperationAuthority;
    lifecycle.registerInheritedSet(authority);
    const faultListener = faultSubscription.listener;
    if (faultListener === null) throw new Error('lifecycle did not subscribe to authority faults');

    faultListener({
      kind: 'control-channel-fault',
      role: 'proxy',
      error: new Error('control_client_closed') as never,
    });
    await flushMicrotasks();
    time.tick(30_000);
    await flushMicrotasks();

    expect({
      publicProofCalls: proveContainmentAbsent.mock.calls.length,
      proofDb: proveContainmentAbsent.mock.calls[0]?.[1],
      stopAttempts,
      represented: lifecycle.snapshot().represented,
      states: lifecycle.snapshot().states,
    }).toEqual({
      publicProofCalls: 1,
      proofDb: db,
      stopAttempts: 1,
      represented: 0,
      states: [],
    });
  });

  it('routes inherited disappearance through the recovering lifecycle slot before freeing all four admissions', async () => {
    const time = new VirtualTime();
    const realRuntime = createRealRuntime('prod');
    const runtime = {
      ...realRuntime,
      time,
      storage: { readdirSync: () => [] },
    } as never;
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const record = providerOperationRecord('settlement-pending');
    insertProviderOperation(db, record);
    const claims = new ProviderProxySetClaimMirror();
    const lifecycleRef = new ProviderProxySetLifecycleRef();
    const operationRegistry = new LocalOperationRegistry();
    const inheritProviderProxySet = vi.fn(async () => ({
      kind: 'containment-disappeared' as const,
      disappearanceReceipt: 'inheritance-process-proof',
    }));
    const world = {
      identity: { buildSetId: FIXTURE_BUILD_SET_ID },
      storeServicesRef: {
        tryGet: () => ({ progressStore: { getDb: () => db } }),
      },
      operationRegistry,
      providerProxyClaims: claims,
      providerProxyLifecycleRef: lifecycleRef,
      providerProxyInheritance: {
        inheritProviderProxySet,
        redeemDiscoveredCapsule: async () => {
          throw new Error('capsule redemption was not expected');
        },
        proveContainmentAbsent: async () => null,
      },
      providerHostManager: {},
    } as never;
    const services = createExecutionServices({
      world,
      runtime,
      bundleHash: 'execution-services-inheritance-test',
      backendNamespace: 'execution-services-inheritance-test',
      onProviderProxyLifecycleFatal: (error) => {
        throw error;
      },
      createExecutionService: (() => {
        throw new Error('execution service creation was not expected');
      }) as never,
    });

    await services.reconcileProviderOperationsAtStartup(new AbortController().signal);
    const lifecycle = lifecycleRef.get();
    if (lifecycle === null) throw new Error('provider proxy lifecycle was not composed');
    await flushMicrotasks();
    const statesBeforeAdmissions = lifecycle.snapshot().states;
    claims.applyMutation({ kind: 'deleted', record });

    const admissions = Array.from({ length: 4 }, (_, index) => lifecycle.beginFreshAcquisition(`fresh-${index}`));

    expect({
      inheritanceCalls: inheritProviderProxySet.mock.calls.length,
      zeroClaims: claims.claimsFor(providerProxySetIdentityFromRecord(record)).length,
      statesBeforeAdmissions,
      states: lifecycle.snapshot().states,
      acceptedAdmissions: admissions.filter((admission) => admission.kind === 'accepted').length,
    }).toEqual({
      inheritanceCalls: 1,
      zeroClaims: 0,
      statesBeforeAdmissions: [],
      states: ['acquiring', 'acquiring', 'acquiring', 'acquiring'],
      acceptedAdmissions: 4,
    });
    services.stopProviderOperationReconciler();
  });
});

describe('execution services provider-proxy heartbeat-hold composition', () => {
  async function createHeartbeatHoldHarness() {
    const namespace = 'execution-services-heartbeat-hold';
    const time = new VirtualTime();
    const baseRuntime = createRealRuntime('prod');
    const runtime = {
      ...baseRuntime,
      time,
      env: {
        ...baseRuntime.env,
        // The successor deliberately disagrees with the redeemed set. The established authority below carries
        // the capsule-derived value the roles accepted, which must remain authoritative for its hold.
        get: (key: string) =>
          key === CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV
            ? String(MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS)
            : baseRuntime.env.get(key),
      },
    };
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const progressStore = new JobStore(namespace, runtime, createEventBodyCodec(), {
      db,
      providers: permissiveProviderLookupPort,
    });
    const lifecycleRef = new ProviderProxySetLifecycleRef();
    const world = {
      identity: { buildSetId: FIXTURE_BUILD_SET_ID },
      storeServicesRef: { tryGet: () => ({ progressStore }) },
      operationRegistry: new LocalOperationRegistry(),
      providerProxyClaims: new ProviderProxySetClaimMirror(),
      providerProxyLifecycleRef: lifecycleRef,
      providerHostManager: {},
    } as never;
    const services = createExecutionServices({
      world,
      runtime,
      bundleHash: namespace,
      backendNamespace: namespace,
      onProviderProxyLifecycleFatal: (error) => {
        throw error;
      },
      createExecutionService: (() => {
        throw new Error('execution service creation was not expected');
      }) as never,
    });
    await services.reconcileProviderOperationsAtStartup(new AbortController().signal);
    const lifecycle = lifecycleRef.get();
    if (lifecycle === null) throw new Error('provider proxy lifecycle was not composed');

    const setIdentity = providerProxySetIdentityFromRecord(providerOperationRecord('executing'));
    const faults = createProviderProxyAuthorityFaultLatch();
    const recoveryCapsule: HandoffCapsuleV3 = {
      version: CURRENT_HANDOFF_CAPSULE_VERSION,
      grantId: randomUUID(),
      secret: 'f'.repeat(64),
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: setIdentity.buildSetId,
      hostFingerprint: setIdentity.hostFingerprint,
      guardianInstanceId: setIdentity.guardianInstanceId,
      reaperInstanceId: setIdentity.reaperInstanceId,
      proxyInstanceId: setIdentity.proxyInstanceId,
      guardianControlEndpoint: setIdentity.guardianControlEndpoint,
      reaperControlEndpoint: setIdentity.reaperControlEndpoint,
      proxyEndpoint: setIdentity.canonicalEndpoint,
      orphanTimeoutMs: MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
      teardownReserveMs: PROXY_TEARDOWN_RESERVE_MS,
      guardianPid: setIdentity.guardianPid,
      guardianIncarnation: setIdentity.guardianIncarnation,
      reaperPid: setIdentity.reaperPid,
      reaperIncarnation: setIdentity.reaperIncarnation,
      proxyPid: setIdentity.proxyPid,
      proxyIncarnation: setIdentity.proxyIncarnation,
      proxyProcessGroupId: setIdentity.proxyProcessGroupId,
      containmentKind: setIdentity.containmentKind,
    };
    const roleClient = (role: 'guardian' | 'reaper' | 'proxy'): ControlClient => ({
      call: async (method: string) => {
        if (method.endsWith('handoff-install.v1') || method === 'handoff.install.v1') {
          return { state: 'installed-dormant', grantId: recoveryCapsule.grantId };
        }
        if (method === 'guardian.stop-and-reap.v1' || method === 'reaper.stop-and-reap.v1') {
          return { state: 'containment-absent', disappearanceReceipt: `${role}-gone` };
        }
        throw new Error(`unexpected role control call: ${method}`);
      },
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => undefined,
    });
    const guardianClient = roleClient('guardian');
    const reaperClient = roleClient('reaper');
    const proxyClient = roleClient('proxy');
    const base = createProviderProxySetAuthority({
      proxyInstanceId: setIdentity.proxyInstanceId,
      guardianClient,
      reaperClient,
      proxyClient,
      guardianIdentity: {
        guardianInstanceId: setIdentity.guardianInstanceId,
        pid: setIdentity.guardianPid,
        incarnation: setIdentity.guardianIncarnation,
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: setIdentity.buildSetId,
        hostFingerprint: setIdentity.hostFingerprint,
        canonicalControlEndpoint: setIdentity.guardianControlEndpoint,
      },
      reaperIdentity: {
        reaperInstanceId: setIdentity.reaperInstanceId,
        pid: setIdentity.reaperPid,
        incarnation: setIdentity.reaperIncarnation,
        guardianInstanceId: setIdentity.guardianInstanceId,
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: setIdentity.buildSetId,
        hostFingerprint: setIdentity.hostFingerprint,
        canonicalControlEndpoint: setIdentity.reaperControlEndpoint,
        containmentKind: setIdentity.containmentKind,
      },
      proxyIdentityFields: {
        proxyInstanceId: setIdentity.proxyInstanceId,
        pid: setIdentity.proxyPid,
        incarnation: setIdentity.proxyIncarnation,
        processGroupId: setIdentity.proxyProcessGroupId,
        guardianInstanceId: setIdentity.guardianInstanceId,
        reaperInstanceId: setIdentity.reaperInstanceId,
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: setIdentity.buildSetId,
        hostFingerprint: setIdentity.hostFingerprint,
        canonicalEndpoint: setIdentity.canonicalEndpoint,
      },
      heartbeats: {
        guardian: { stop: () => undefined },
        reaper: { stop: () => undefined },
        proxy: { stop: () => undefined },
      },
      coordinatorIdentity: {
        instanceId: randomUUID(),
        pid: 1,
        incarnation: testIncarnation(1),
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: setIdentity.buildSetId,
      },
      handoffCapsulePath: '/unused/redeemed-capsule.json',
      runtime,
      recoveryCapsule,
      recoveryOperations: [],
      operationRegistry: new LocalOperationRegistry(),
    });
    await base.installRecoveryCredential(new AbortController().signal);
    const stopAndReap = vi.fn(base.stopAndReap);
    const authority = createProviderProxyOperationAuthority({
      base: {
        ...base,
        stopAndReap,
      },
      setIdentity,
      clients: { proxy: proxyClient, guardian: guardianClient, reaper: reaperClient },
      faults,
      mutationRpcTimeoutMs: 5_000,
    });
    const admission = lifecycle.beginFreshAcquisition('heartbeat-hold-route');
    if (admission.kind !== 'accepted') throw new Error(`fresh set was not admitted: ${admission.kind}`);
    lifecycle.acquisitionSucceeded(admission.slotId, authority);

    return { time, faults, stopAndReap, redeemedDeadline: base.autonomousDeadline, services };
  }

  it("uses a redeemed set's capsule deadline instead of the successor coordinator's environment", async () => {
    const { time, faults, stopAndReap, redeemedDeadline, services } = await createHeartbeatHoldHarness();
    expect(redeemedDeadline.heartbeatHoldBound).toEqual({ spanMs: 5_001, materialSchedulerLatenessMs: 1_250 });

    const incident = (error: string): void =>
      faults.reportIncident({
        kind: 'heartbeat-indeterminate',
        role: 'guardian',
        method: 'guardian.heartbeat.v1',
        incidentReason: 'unanswered',
        schedulerLatenessMs: 0,
        error,
      });

    incident('first');
    time.tick(redeemedDeadline.heartbeatHoldBound.spanMs);
    incident('second');

    expect(stopAndReap).toHaveBeenCalledOnce();
    services.stopProviderOperationReconciler();
  });
});
