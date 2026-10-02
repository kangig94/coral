import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import { compareAndSwapProviderOperation } from '#src/store/provider-operation-journal.js';
import { ProviderOperationAtomicTerminalizationError } from '#src/jobs/provider-operation-terminalization.js';
import { ControlClientError } from '#src/provider-proxy/control-client.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { type DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import type { ProviderProxyAuthorityFault } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { type ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import { type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import {
  createTestProviderProxyContainmentProofProducer,
  createTestProviderProxyRecoveryDispatcher,
} from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { ProviderProxySetOperatorDispositionStore } from '#src/coordinator/services/provider-proxy-set/operator-disposition-store.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';
import { createProviderOperationReconcilerHarness as createHarness } from '#tests/helpers/provider-operation-reconciler-harness.js';

function proxyHeartbeatFault(error: unknown): ProviderProxyAuthorityFault {
  return {
    kind: 'heartbeat-failed',
    role: 'proxy',
    method: 'control.heartbeat.v1',
    terminalReason: 'teardown-latched',
    error,
  };
}

import { providerOperationRecord } from '../../store/provider-operation-fixtures.js';

const TEST_PUBLICATION_RECEIPT = { kind: 'provider-proxy-set-published' } as PublicationReceipt;

/** The build this fixture lifecycle belongs to — the same one `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';
const containmentProofRuntime = createRealRuntime('prod');
const containmentProofDb = newRawDatabase(':memory:');
applyBundledStoreSchema(containmentProofDb, currentCoralStoreFormat());
afterAll(() => containmentProofDb.close());

function connectLifecycleAuthority(
  authority: DurableProviderProxyOperationAuthority,
  proof: ReturnType<typeof deferredValue<Awaited<ReturnType<DurableProviderProxyOperationAuthority['stopAndReap']>>>>,
): (fault: ProviderProxyAuthorityFault) => void {
  const listeners = new Set<(fault: ProviderProxyAuthorityFault) => void>();
  Object.assign(authority, {
    onFault: (listener: (fault: ProviderProxyAuthorityFault) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stopAndReap: () => proof.promise,
    commitContainment: async () => {
      const result = await proof.promise;
      return 'disappearanceReceipt' in result
        ? ({ kind: 'containment-absent', disappearanceReceipt: result.disappearanceReceipt } as const)
        : ({ kind: 'outcome-unknown', error: result.unconfirmed } as const);
    },
  });
  return (fault) => {
    for (const listener of listeners) listener(fault);
  };
}

function lifecycleForSchedule(
  record: ProviderOperationRecord,
  reconciler: ProviderOperationReconciler,
  authority: DurableProviderProxyOperationAuthority,
): ProviderProxySetLifecycle {
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([record]);
  const time = {
    now: () => 100,
    monotonicNow: () => 100n,
    setTimeout: () => ({ unref: () => undefined }),
    clearTimeout: () => undefined,
  };
  const lifecycle = new ProviderProxySetLifecycle({
    buildSetId: FIXTURE_BUILD_SET_ID,
    claims,
    controlEstablished: () => undefined,
    time,
    operatorDispositionStore: new ProviderProxySetOperatorDispositionStore(new InMemoryStorage(time), '/coral/run'),
    writerIncarnation: 'reconciler-test',
    collectOperatorDispositionContainmentProof: async () => {
      throw new Error('unexpected durable proof collection');
    },
    reobserveAcquisitionContainment: async () => ({
      kind: 'held',
      observation: 'unknown',
      reason: 'unobserved acquisition',
    }),
    recoveryDispatcher: createTestProviderProxyRecoveryDispatcher(
      {
        'containment-proof': createTestProviderProxyContainmentProofProducer(
          containmentProofRuntime,
          containmentProofDb,
        ),
        'disappearance-consumer': ({ notice }) => reconciler.containmentDisappeared(notice),
      },
      (error) => {
        throw error;
      },
    ),
    reapRecordedContainment: () => {
      throw new Error('provider operation reconciler fixture unexpectedly requested recorded containment reaping');
    },
    reportLifecycle: () => undefined,
  });
  lifecycle.activateDurableOperatorDispositions();
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  lifecycle.registerInheritedSet(authority, TEST_PUBLICATION_RECEIPT);
  return lifecycle;
}

describe('provider proxy exactly-once containment schedules', () => {
  it('settles an aborted stop after control closes and the reaper confirms containment absence', async () => {
    const harness = createHarness({
      stopOperation: async () => {
        throw new ControlClientError('control_client_closed', 'The control channel closed.', 'closed');
      },
    });
    const record = providerOperationRecord('executing');
    insertProviderOperation(harness.db, record);
    const proof = deferredValue<Awaited<ReturnType<DurableProviderProxyOperationAuthority['stopAndReap']>>>();
    const emitFault = connectLifecycleAuthority(harness.authority, proof);
    const lifecycle = lifecycleForSchedule(record, harness.reconciler, harness.authority);

    harness.reconciler.requestStops([record.operation.jobId], 'signal_abort');
    const stopped = readProviderOperation(harness.db, record.operation);
    if (stopped === null) throw new Error('expected durable stop');
    await harness.reconciler.reconcile(stopped);
    expect(readProviderOperation(harness.db, record.operation)).toMatchObject({
      lastError: { code: 'control_client_closed' },
    });

    emitFault(proxyHeartbeatFault(new Error('proxy teardown latched')));
    expect(lifecycle.authorityFor(providerProxySetIdentityFromRecord(record))).toBeNull();
    expect(harness.appended).toEqual([]);
    proof.resolve({ disappearanceReceipt: 'aborted-stop-containment-absent' });
    await vi.waitFor(() => expect(readProviderOperation(harness.db, record.operation)).toBeNull());

    expect(harness.appended).toContainEqual(
      expect.objectContaining({
        type: 'job.terminal.recorded',
        body: expect.objectContaining({
          terminal: expect.objectContaining({ outcome: { kind: 'aborted', reason: 'signal_abort' } }),
        }),
      }),
    );
  });
});

function deferredValue<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

it('keeps a locked disappearance terminalization retryable without consuming the fatal dispatcher', async () => {
  const record = providerOperationRecord('executing');
  const harness = createHarness({
    terminalize: () => {
      throw new ProviderOperationAtomicTerminalizationError(
        record.operation,
        Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
      );
    },
  });
  try {
    insertProviderOperation(harness.db, record);
    const notice = {
      operation: record.operation,
      setIdentity: providerProxySetIdentityFromRecord(record),
      disappearanceReceipt: 'locked-bookkeeping-receipt',
    };
    await expect(harness.reconciler.containmentDisappeared(notice)).resolves.toMatchObject({
      kind: 'operational-failure',
      code: 'disappearance_consumer_unavailable',
    });
    expect(harness.fatalErrors).toEqual([]);
    expect(readProviderOperation(harness.db, record.operation)).toEqual(record);
  } finally {
    harness.db.close();
  }
});

it('retains a settlement tombstone after a lost release reply and deletes it only after the replayed ACK', async () => {
  let settleCalls = 0;
  let remoteLedgerPresent = true;
  let guardianMembershipPresent = true;
  let replayedAlreadyReleased = false;
  const harness = createHarness({
    settleOperation: async (_operation, finalProviderSeq) => {
      settleCalls += 1;
      if (settleCalls === 1) {
        remoteLedgerPresent = false;
        guardianMembershipPresent = false;
        throw Object.assign(new Error('settlement reply lost'), { code: 'control_call_failed' });
      }
      replayedAlreadyReleased = !remoteLedgerPresent && !guardianMembershipPresent;
      return { state: 'released-after-terminal', settledThroughProviderSeq: finalProviderSeq };
    },
  });
  await harness.begin();
  const executing = readProviderOperation(harness.db, harness.record.operation);
  if (executing?.phase !== 'executing') throw new Error('expected executing journal row');
  const settlement = providerOperationRecordSchema.parse({
    ...executing,
    phase: 'settlement-pending',
    committedThroughProviderSeq: 1,
    terminalProviderSeq: 1,
    settlementIntent: 'release-after-terminal',
    revision: executing.revision + 1,
    retryNotBeforeMs: 100,
  });
  expect(compareAndSwapProviderOperation(harness.db, executing, settlement).kind).toBe('updated');

  harness.reconciler.settlementPending(settlement.operation);
  await vi.waitFor(() => expect(settleCalls).toBe(1));
  await vi.waitFor(() =>
    expect(readProviderOperation(harness.db, settlement.operation)).toMatchObject({
      phase: 'settlement-pending',
      retryCount: 1,
    }),
  );

  expect(remoteLedgerPresent).toBe(false);
  expect(guardianMembershipPresent).toBe(false);
  harness.reconciler.onControlEstablished(harness.authority);
  await vi.waitFor(() => expect(readProviderOperation(harness.db, settlement.operation)).toBeNull());

  expect(settleCalls).toBe(2);
  expect(replayedAlreadyReleased).toBe(true);
});
