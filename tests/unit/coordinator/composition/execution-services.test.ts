import { describe, expect, it, vi } from 'vitest';

import { createExecutionServices } from '#src/coordinator/composition/execution-services.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import type { ProviderProxyAuthorityFault } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set-claim-mirror.js';
import {
  providerProxySetIdentityFromRecord,
  type ProviderProxySetIdentity,
} from '#src/coordinator/services/provider-proxy-set-identity.js';
import { ProviderProxySetLifecycleRef } from '#src/coordinator/services/provider-proxy-set-lifecycle-ref.js';
import type { Database } from '#src/store/db.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

describe('execution services provider-proxy proof composition', () => {
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
      setIdentity: providerProxySetIdentityFromRecord(record),
      faulted: Promise.resolve(fault),
      onFault: (listener: (observed: ProviderProxyAuthorityFault) => void) => {
        listener(fault);
        return () => undefined;
      },
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
    const world = {
      storeServicesRef: { tryGet: () => ({ progressStore: { getDb: () => db } }) },
      operationRegistry,
      providerProxyClaims: claims,
      providerProxyLifecycleRef: lifecycleRef,
      providerHostManager: {},
    } as never;
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
    const authority = {
      proxyInstanceId: record.operation.proxyInstanceId,
      setIdentity: providerProxySetIdentityFromRecord(record),
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      attachOperation,
      stopAndReap: async () => ({ unconfirmed: 'not requested' }),
      stopHeartbeats: () => undefined,
      initiateControlClose: async () => undefined,
      registerSuccessionOperation: async () => undefined,
    } as unknown as DurableProviderProxyOperationAuthority;
    const admission = lifecycle.beginFreshAcquisition('fresh-publication');
    if (admission.kind !== 'accepted') throw new Error(`fresh set was not admitted: ${admission.kind}`);

    lifecycle.acquisitionSucceeded(admission.slotId, authority);
    await vi.waitFor(() => expect(attachOperation).toHaveBeenCalledTimes(1));
    lifecycle.registerInheritedSet(authority);
    await flushMicrotasks();

    expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority);
    expect(attachOperation).toHaveBeenCalledTimes(1);
    services.stopProviderOperationReconciler();
  });

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
      setIdentity,
      faulted: new Promise<never>(() => undefined),
      onFault: (listener: (fault: ProviderProxyAuthorityFault) => void) => {
        faultSubscription.listener = listener;
        return () => {
          faultSubscription.listener = null;
        };
      },
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
