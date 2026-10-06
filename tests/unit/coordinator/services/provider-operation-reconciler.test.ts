import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import {
  compareAndSwapProviderOperation,
  ProviderOperationMutationSetClosedError,
} from '#src/store/provider-operation-journal.js';
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

it('rejects the publication when its reconciliation is refused', async () => {
  const harness = createHarness();
  const refusal = new ProviderOperationMutationSetClosedError();
  vi.spyOn(harness.reconciler, 'reconcile').mockRejectedValueOnce(refusal);
  try {
    await expect(harness.begin()).rejects.toBe(refusal);
  } finally {
    harness.reconciler.stop();
    harness.db.close();
  }
});

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

it.each(['prepare-pending', 'guardian-activation-pending', 'proxy-activation-pending'] as const)(
  '%s preserves healthy work across unavailable control authority',
  async (phase) => {
    let attempts = 0;
    const contain = vi.fn(async () => ({ kind: 'containment-absent' as const, disappearanceReceipt: 'gone' }));
    const harness = createHarness({
      authorityFor: () => null,
      acquireAuthority: async () => {
        attempts += 1;
        return attempts <= 8
          ? { kind: 'temporarily-unavailable', reason: 'Authenticated redemption pending' }
          : harness.authority;
      },
      commitContainment: contain,
    });
    const record = providerOperationRecord(phase);
    let elapsed = 0;
    try {
      insertProviderOperation(harness.db, record);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const current = readProviderOperation(harness.db, record.operation);
        if (current === null) break;
        const wait = Math.max(0, current.retryNotBeforeMs - 100 - elapsed);
        harness.advance(wait + 60_000);
        elapsed += wait + 60_000;
        await harness.reconciler.reconcile(current);
      }
      expect(contain).not.toHaveBeenCalled();
      expect(readProviderOperation(harness.db, record.operation)).toMatchObject({ phase: 'executing' });
    } finally {
      harness.reconciler.stop();
      harness.db.close();
    }
  },
);

function unpublishedStart() {
  const record = providerOperationRecord('executing');
  if (record.phase !== 'executing') throw new Error('Expected executing fixture');
  return { ...record.activationAck, state: 'started-awaiting-publication' as const };
}

it.each(['executing', 'settlement-pending'] as const)(
  'recovers %s after repeated transient replies without authorizing containment',
  async (phase) => {
    let attempts = 0;
    const transientReply = () => {
      attempts += 1;
      if (attempts <= 10) throw new ControlClientError('control_call_failed', 'Reply lost', 'timeout');
    };
    const contain = vi.fn();
    const harness = createHarness({
      commitContainment: contain,
      attachOperation: async () => {
        transientReply();
        return { state: 'attached', replayFromProviderSeq: 1, committedThroughProviderSeq: 0 };
      },
      settleOperation: async (_operation, settledThroughProviderSeq) => {
        transientReply();
        return { state: 'released-after-terminal', settledThroughProviderSeq };
      },
    });
    const initial = providerOperationRecord(phase);
    try {
      insertProviderOperation(harness.db, initial);
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const current = readProviderOperation(harness.db, initial.operation);
        if (current === null) break;
        harness.advance(2_000);
        await harness.reconciler.reconcile(current);
      }
      expect(attempts).toBe(11);
      expect(contain).not.toHaveBeenCalled();
      expect(harness.appended).not.toContainEqual(expect.objectContaining({ type: 'job.terminal.recorded' }));
      expect(readProviderOperation(harness.db, initial.operation)).toEqual(
        phase === 'executing' ? expect.objectContaining({ phase: 'executing', retryCount: 0, lastError: null }) : null,
      );
    } finally {
      harness.reconciler.stop();
      harness.db.close();
    }
  },
);

it.each(['started-awaiting-publication', 'released-activation-indeterminate'] as const)(
  'honors an abort while resolving %s without publishing execution',
  async (state) => {
    let released = state === 'released-activation-indeterminate';
    const stop = vi.fn(async () => {
      released = true;
    });
    const activate = vi.fn();
    const harness = createHarness({
      inspectOperation: async (operation, prepareAttemptKey) =>
        released
          ? {
              state: 'released-activation-indeterminate',
              operation,
              prepareAttemptNumber: 1,
              prepareAttemptKey,
            }
          : unpublishedStart(),
      stopOperation: stop,
      activatePreparedOperation: activate,
    });
    const initial = providerOperationRecord('activation-resolution-pending');
    if (initial.phase !== 'activation-resolution-pending') throw new Error('Expected activation resolution');
    const record = {
      ...initial,
      onNeverStarted: {
        kind: 'terminal-aborted' as const,
        cause: 'signal_abort' as const,
        requestedAt: '2026-08-09T12:34:56.000Z',
      },
    };
    try {
      insertProviderOperation(harness.db, record);
      await harness.reconciler.reconcile(record);
      expect(readProviderOperation(harness.db, record.operation)).toBeNull();
      expect(activate).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(state === 'started-awaiting-publication' ? 1 : 0);
      expect(harness.appended).toContainEqual(
        expect.objectContaining({
          type: 'job.terminal.recorded',
          body: expect.objectContaining({
            terminal: expect.objectContaining({ outcome: { kind: 'aborted', reason: 'signal_abort' } }),
          }),
        }),
      );
    } finally {
      harness.reconciler.stop();
      harness.db.close();
    }
  },
);

it('retries transient local recovery until its owner accepts, then deletes the obligation', async () => {
  let attempts = 0;
  const complete = vi.fn();
  const contain = vi.fn();
  const harness = createHarness({
    recoverLocalJob: async (record) => {
      attempts += 1;
      if (attempts <= 10) throw Object.assign(new Error('Recovery store busy'), { code: 'SQLITE_BUSY' });
      return { state: 'accepted', jobId: record.operation.jobId, owner: 'recovery-coordinator' };
    },
    completeLocalRecovery: complete,
    commitContainment: contain,
  });
  const record = providerOperationRecord('local-recovery-pending');
  try {
    insertProviderOperation(harness.db, record);
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const current = readProviderOperation(harness.db, record.operation);
      if (current === null) break;
      harness.advance(2_000);
      await harness.reconciler.reconcile(current);
    }
    expect(attempts).toBe(11);
    expect(complete).toHaveBeenCalledWith(record.operation.jobId);
    expect(readProviderOperation(harness.db, record.operation)).toBeNull();
    expect(contain).not.toHaveBeenCalled();
  } finally {
    harness.reconciler.stop();
    harness.db.close();
  }
});

it('recovers an executing operation when temporarily unavailable authority becomes available', async () => {
  let attempts = 0;
  const contain = vi.fn();
  const harness = createHarness({
    authorityFor: () => null,
    acquireAuthority: async () => {
      attempts += 1;
      return attempts <= 10
        ? { kind: 'temporarily-unavailable', reason: 'Authenticated redemption pending' }
        : harness.authority;
    },
    commitContainment: contain,
  });
  const record = providerOperationRecord('executing');
  try {
    insertProviderOperation(harness.db, record);
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const current = readProviderOperation(harness.db, record.operation);
      if (current === null) throw new Error('Lost the executing obligation');
      harness.advance(2_000);
      await harness.reconciler.reconcile(current);
    }
    expect(attempts).toBe(11);
    expect(contain).not.toHaveBeenCalled();
    expect(readProviderOperation(harness.db, record.operation)).toMatchObject({
      phase: 'executing',
      retryCount: 0,
      lastError: null,
    });
  } finally {
    harness.reconciler.stop();
    harness.db.close();
  }
});

it('releases only the unpublished operation after decisive failure time is exhausted', async () => {
  let stopped = false;
  const stop = vi.fn(async () => {
    stopped = true;
  });
  const contain = vi.fn();
  const harness = createHarness({
    requestContainment: contain,
    stopOperation: stop,
    inspectOperation: async (operation, prepareAttemptKey) => {
      if (!stopped)
        throw new ControlClientError('control_call_failed', 'Decisive remote refusal', 'remote-response', {
          kind: 'json-rpc-error',
          jsonRpcCode: -32000,
          protocolCode: null,
          admissionReason: null,
          heartbeatRefusal: null,
        });
      return { state: 'released-activation-indeterminate', operation, prepareAttemptNumber: 1, prepareAttemptKey };
    },
  });
  const record = providerOperationRecord('activation-resolution-pending');
  try {
    insertProviderOperation(harness.db, record);
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const current = readProviderOperation(harness.db, record.operation);
      if (current === null) break;
      harness.advance(30_000);
      await harness.reconciler.reconcile(current);
    }
    expect(stop).toHaveBeenCalledOnce();
    expect(contain).not.toHaveBeenCalled();
    expect(readProviderOperation(harness.db, record.operation)).toBeNull();
    expect(harness.appended).toContainEqual(
      expect.objectContaining({
        type: 'job.progress.emitted',
        body: expect.objectContaining({ detail: { code: 'provider_operation_retries_exhausted' } }),
      }),
    );
  } finally {
    harness.reconciler.stop();
    harness.db.close();
  }
});

it('releases an invalid activation ACK before terminalizing and lets a recorded abort win', async () => {
  const stop = vi.fn(async () => {});
  const contain = vi.fn();
  const warn = vi.fn();
  const harness = createHarness({
    stopOperation: stop,
    requestContainment: contain,
    onError: warn,
    activatePreparedOperation: async () => ({
      ...unpublishedStart(),
      state: 'executing',
      hostRef: { ...unpublishedStart().hostRef, fingerprint: 'b'.repeat(64) },
    }),
    inspectOperation: async (operation, prepareAttemptKey) => ({
      state: 'released-activation-indeterminate',
      operation,
      prepareAttemptNumber: 1,
      prepareAttemptKey,
    }),
  });
  const record = providerOperationRecord('proxy-activation-pending');
  try {
    insertProviderOperation(harness.db, record);
    await harness.reconciler.reconcile(record);
    expect(stop).toHaveBeenCalledOnce();
    expect(contain).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(readProviderOperation(harness.db, record.operation)).toBeNull();
    expect(harness.appended).toContainEqual(
      expect.objectContaining({
        type: 'job.progress.emitted',
        body: expect.objectContaining({ detail: { code: 'provider_activation_ack_invalid' } }),
      }),
    );
  } finally {
    harness.reconciler.stop();
    harness.db.close();
  }
});

it('lets a recorded user abort win over permanent failure on ordinary containment disappearance', async () => {
  const harness = createHarness();
  const initial = providerOperationRecord('activation-resolution-pending');
  if (initial.phase !== 'activation-resolution-pending') throw new Error('Expected resolution');
  const record = {
    ...initial,
    onNeverStarted: {
      kind: 'terminal-aborted' as const,
      cause: 'user_abort' as const,
      requestedAt: '2026-08-09T12:34:56.000Z',
    },
    lastError: { observedAtMs: 100, code: 'provider_activation_ack_invalid', message: 'Fingerprint mismatch' },
  };
  try {
    insertProviderOperation(harness.db, record);
    await harness.reconciler.containmentDisappeared({
      operation: record.operation,
      setIdentity: harness.authority.setIdentity,
      disappearanceReceipt: 'exact-absence',
    });
    expect(harness.appended).toContainEqual(
      expect.objectContaining({
        type: 'job.terminal.recorded',
        body: expect.objectContaining({
          terminal: expect.objectContaining({ outcome: { kind: 'aborted', reason: 'user_abort' } }),
        }),
      }),
    );
  } finally {
    harness.reconciler.stop();
    harness.db.close();
  }
});

it('excludes time spent acquiring authority between decisive proxy failures', async () => {
  const cancel = vi.fn();
  const harness = createHarness({
    authorityFor: () => null,
    acquireAuthority: async () => {
      harness.advance(140_000);
      return harness.authority;
    },
    cancelOperation: cancel,
    inspectOperation: async () => {
      throw new ControlClientError('control_call_failed', 'Decisive remote refusal', 'remote-response', {
        kind: 'json-rpc-error',
        jsonRpcCode: -32000,
        protocolCode: null,
        admissionReason: null,
        heartbeatRefusal: null,
      });
    },
  });
  const record = providerOperationRecord('prepare-pending');
  try {
    insertProviderOperation(harness.db, record);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = readProviderOperation(harness.db, record.operation);
      if (current === null) throw new Error('lost operation');
      harness.advance(2_000);
      await harness.reconciler.reconcile(current);
    }
    expect(cancel).not.toHaveBeenCalled();
    expect(readProviderOperation(harness.db, record.operation)).toMatchObject({ phase: 'prepare-pending' });
  } finally {
    harness.reconciler.stop();
    harness.db.close();
  }
});

it('resets decisive failure time after a confirmed prepare-attempt release', async () => {
  let releasing = false;
  const cancel = vi.fn(async (operation, prepareAttemptNumber, prepareAttemptKey) => ({
    state: 'released-never-started' as const,
    operation,
    prepareAttemptNumber,
    prepareAttemptKey,
  }));
  const harness = createHarness({
    cancelOperation: cancel,
    inspectOperation: async () => {
      if (releasing) {
        releasing = false;
        return { state: 'absent' as const };
      }
      throw new ControlClientError('control_call_failed', 'Decisive remote refusal', 'remote-response', {
        kind: 'json-rpc-error',
        jsonRpcCode: -32000,
        protocolCode: null,
        admissionReason: null,
        heartbeatRefusal: null,
      });
    },
    registerSuccessionOperation: async () => {
      throw new ControlClientError('control_client_closed', 'Registration closed.', 'closed');
    },
  });
  const record = providerOperationRecord('prepare-pending');
  try {
    insertProviderOperation(harness.db, record);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = readProviderOperation(harness.db, record.operation);
      if (current === null) throw new Error('lost operation');
      releasing = attempt === 4;
      harness.advance(30_000);
      await harness.reconciler.reconcile(current);
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(readProviderOperation(harness.db, record.operation)).toMatchObject({
      phase: 'prepare-pending',
      prepareAttemptNumber: 2,
    });
  } finally {
    harness.reconciler.stop();
    harness.db.close();
  }
});

it.each(['prepare-pending', 'guardian-activation-pending'] as const)(
  'falls back locally after cancelling an exhausted never-started %s operation',
  async (phase) => {
    let cancelling = false;
    const cancel = vi.fn(async (operation, prepareAttemptNumber, prepareAttemptKey) => {
      cancelling = true;
      return { state: 'released-never-started' as const, operation, prepareAttemptNumber, prepareAttemptKey };
    });
    const contain = vi.fn();
    const decisiveFailure = async () => {
      throw new ControlClientError('control_call_failed', 'Decisive remote refusal', 'remote-response', {
        kind: 'json-rpc-error',
        jsonRpcCode: -32000,
        protocolCode: null,
        admissionReason: null,
        heartbeatRefusal: null,
      });
    };
    const harness = createHarness({
      cancelOperation: cancel,
      requestContainment: contain,
      inspectOperation: decisiveFailure,
      authorizeOperation: decisiveFailure,
    });
    const record = providerOperationRecord(phase);
    try {
      insertProviderOperation(harness.db, record);
      for (let attempt = 0; attempt < 7 && !cancelling; attempt += 1) {
        const current = readProviderOperation(harness.db, record.operation);
        if (current === null) throw new Error('lost operation');
        harness.advance(30_000);
        await harness.reconciler.reconcile(current);
      }
      expect(cancel).toHaveBeenCalled();
      expect(contain).not.toHaveBeenCalled();
      expect(readProviderOperation(harness.db, record.operation)).toMatchObject({ phase: 'local-recovery-pending' });
    } finally {
      harness.reconciler.stop();
      harness.db.close();
    }
  },
);

it.each(['proxy-activation-pending', 'activation-resolution-pending'] as const)(
  'recognizes a released fingerprint refinement in %s after acquiring ownership without claiming upgrade cleanup',
  async (phase) => {
    const request = vi.fn();
    const harness = createHarness({ requestContainment: request, inspectOperation: async () => unpublishedStart() });
    const record = {
      ...providerOperationRecord(phase),
      lastError: {
        observedAtMs: 100,
        code: 'provider_operation_failed',
        message: JSON.stringify([
          {
            code: 'custom',
            path: ['activationAck', 'hostRef', 'fingerprint'],
            message: 'activation host fingerprint must equal the durable locator',
          },
        ]),
      },
    };
    try {
      insertProviderOperation(harness.db, record);
      await harness.reconciler.reconcile(record);
      expect(request).toHaveBeenCalledWith(harness.authority.setIdentity, 'provider_activation_ack_invalid');
      expect(readProviderOperation(harness.db, record.operation)).toMatchObject({
        lastError: { code: 'provider_activation_ack_invalid' },
      });
      expect(harness.appended).not.toContainEqual(expect.objectContaining({ type: 'job.terminal.recorded' }));
    } finally {
      harness.reconciler.stop();
      harness.db.close();
    }
  },
);

it('waits through the semantic cancellation budget without containing the set', async () => {
  let released = false;
  const request = vi.fn();
  const harness = createHarness({
    requestContainment: request,
    inspectOperation: async (operation, prepareAttemptKey) =>
      ({
        state: released ? 'released-activation-indeterminate' : 'releasing',
        ...(released ? {} : { releaseKind: 'activation-indeterminate' }),
        operation,
        prepareAttemptNumber: 1,
        prepareAttemptKey,
      }) as never,
  });
  const record = providerOperationRecord('activation-resolution-pending');
  try {
    insertProviderOperation(harness.db, record);
    for (let index = 0; index < 10; index += 1) {
      harness.advance(2_000);
      const current = readProviderOperation(harness.db, record.operation);
      if (current === null) throw new Error('lost ownership');
      await harness.reconciler.reconcile(current);
    }
    expect(request).not.toHaveBeenCalled();
    expect(readProviderOperation(harness.db, record.operation)).not.toBeNull();
    released = true;
    const current = readProviderOperation(harness.db, record.operation);
    if (current === null) throw new Error('lost ownership');
    await harness.reconciler.reconcile(current);
    expect(readProviderOperation(harness.db, record.operation)).toBeNull();
  } finally {
    harness.reconciler.stop();
    harness.db.close();
  }
});

it('retains released-operation terminalization retries without requesting set containment on a local store failure', async () => {
  const request = vi.fn();
  const harness = createHarness({
    requestContainment: request,
    terminalize: () => {
      throw Object.assign(new Error('terminal store busy'), { code: 'SQLITE_BUSY' });
    },
    inspectOperation: async (operation, prepareAttemptKey) => ({
      state: 'released-activation-indeterminate',
      operation,
      prepareAttemptNumber: 1,
      prepareAttemptKey,
    }),
  });
  const record = {
    ...providerOperationRecord('proxy-activation-pending'),
    lastError: { observedAtMs: 100, code: 'provider_activation_ack_invalid', message: 'Fingerprint mismatch' },
  };
  try {
    insertProviderOperation(harness.db, record);
    await harness.reconciler.reconcile(record);
    expect(request).not.toHaveBeenCalled();
    expect(readProviderOperation(harness.db, record.operation)).not.toBeNull();
  } finally {
    harness.reconciler.stop();
    harness.db.close();
  }
});

it('waits for real lifecycle disappearance after a failed single-operation release', async () => {
  let lifecycle!: ProviderProxySetLifecycle;
  const stop = vi.fn(async () => undefined);
  const harness = createHarness({
    stopOperation: stop,
    inspectOperation: async () => unpublishedStart(),
    requestContainment: (identity, cause) => lifecycle.requestOperationContainment(identity, cause),
  });
  const record = {
    ...providerOperationRecord('proxy-activation-pending'),
    lastError: { observedAtMs: 100, code: 'provider_activation_ack_invalid', message: 'Fingerprint mismatch' },
  };
  const proof = deferredValue<Awaited<ReturnType<DurableProviderProxyOperationAuthority['stopAndReap']>>>();
  const emitFault = connectLifecycleAuthority(harness.authority, proof);
  try {
    insertProviderOperation(harness.db, record);
    lifecycle = lifecycleForSchedule(record, harness.reconciler, harness.authority);
    await harness.reconciler.reconcile(record);
    expect(stop).toHaveBeenCalledOnce();
    expect(JSON.stringify(lifecycle.snapshot())).toContain('operation-control-outcome-unknown');
    expect(readProviderOperation(harness.db, record.operation)).not.toBeNull();
    expect(harness.appended).not.toContainEqual(expect.objectContaining({ type: 'job.terminal.recorded' }));
    emitFault(proxyHeartbeatFault(new Error('proxy teardown latched')));
    expect(lifecycle.authorityFor(harness.authority.setIdentity)).toBeNull();
    proof.resolve({ disappearanceReceipt: 'single-release-lifecycle-absence' });
    await vi.waitFor(() => expect(readProviderOperation(harness.db, record.operation)).toBeNull());
    expect(harness.appended).toContainEqual(
      expect.objectContaining({
        type: 'job.progress.emitted',
        body: expect.objectContaining({ detail: { code: 'provider_activation_ack_invalid' } }),
      }),
    );
  } finally {
    harness.reconciler.stop();
    harness.db.close();
  }
});
