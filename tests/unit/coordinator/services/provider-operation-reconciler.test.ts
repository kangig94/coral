import { ControlClientError } from '#src/provider-proxy/control-client.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { type DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import type { ProviderProxyAuthorityFault } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import type { ProviderOperationRecoveryAcceptance } from '#src/coordinator/services/recovery/provider-operation-job-recovery.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { type ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import {
  acquireProviderOperationMutationAdmission,
  compareAndSwapProviderOperation,
  insertProviderOperation,
  readProviderOperation,
  readProviderOperations,
  subscribeProviderOperationMutations,
} from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import {
  createTestProviderProxyContainmentProofProducer,
  createTestProviderProxyRecoveryDispatcher,
} from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { testProviderProxySetLifecycleDurability } from '#tests/helpers/provider-proxy-set-lifecycle-durability.js';
import { asJointContainmentReceipt, asReservation } from '#tests/helpers/provider-proxy-correlation.js';
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

const activationAck = {
  state: 'executing',
  activationFingerprint: 'c'.repeat(64),
  startedAt: '2026-08-09T12:34:56.000Z',
  hostRef: {
    provider: 'codex',
    fingerprint: 'a'.repeat(64),
    instanceId: 'host-instance-1',
    leaseMode: 'shared',
  },
  committedThroughProviderSeq: 0,
} as const;

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
    ...testProviderProxySetLifecycleDurability(containmentProofRuntime.storage, time),
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

  it('runs the prepare-pending zero-run schedule exactly once after absence handoff', async () => {
    let localStarts = 0;
    let emitFault = (_fault: ProviderProxyAuthorityFault): void => undefined;
    const harness = createHarness({
      prepareOperation: async () => {
        emitFault(proxyHeartbeatFault(new Error('ambiguous prepare acknowledgement')));
        throw new Error('ambiguous prepare acknowledgement');
      },
      inspectOperation: async () => {
        emitFault(proxyHeartbeatFault(new Error('inspection remained ambiguous after prepare')));
        throw new Error('inspection remained ambiguous');
      },
      recoverLocalJob: async (record) => {
        localStarts += 1;
        return providerRecoveryAccepted(record.operation.jobId);
      },
    });
    const record = harness.record;
    insertProviderOperation(harness.db, record);
    const proof = deferredValue<Awaited<ReturnType<DurableProviderProxyOperationAuthority['stopAndReap']>>>();
    emitFault = connectLifecycleAuthority(harness.authority, proof);
    const lifecycle = lifecycleForSchedule(record, harness.reconciler, harness.authority);

    await harness.reconciler.reconcile(record, harness.authority);
    expect(localStarts).toBe(0);
    expect(lifecycle.authorityFor(providerProxySetIdentityFromRecord(record))).toBeNull();

    proof.resolve({ disappearanceReceipt: 'prepare-containment-absent' });
    await vi.waitFor(() => expect(localStarts).toBe(1));

    expect(localStarts).toBe(1);
    expect(readProviderOperation(harness.db, record.operation)).toBeNull();
  });

  it('runs the post-start activation schedule once without authorizing local recovery', async () => {
    let remoteStarts = 0;
    let localStarts = 0;
    let emitFault = (_fault: ProviderProxyAuthorityFault): void => undefined;
    const harness = createHarness({
      activatePreparedOperation: async () => {
        remoteStarts += 1;
        emitFault(proxyHeartbeatFault(new Error('activation acknowledgement failed after start')));
        throw new Error('activation acknowledgement failed after start');
      },
      inspectOperation: async () => {
        throw new Error('inspection remained ambiguous');
      },
      recoverLocalJob: async (record) => {
        localStarts += 1;
        return providerRecoveryAccepted(record.operation.jobId);
      },
    });
    const record = providerOperationRecord('proxy-activation-pending');
    insertProviderOperation(harness.db, record);
    const proof = deferredValue<Awaited<ReturnType<DurableProviderProxyOperationAuthority['stopAndReap']>>>();
    emitFault = connectLifecycleAuthority(harness.authority, proof);
    const lifecycle = lifecycleForSchedule(record, harness.reconciler, harness.authority);

    await harness.reconciler.reconcile(record, harness.authority);
    if (lifecycle.snapshot().represented === 0) {
      // A forgotten slot makes an overlapping replacement admissible; model the replacement's semantic start.
      localStarts += 1;
    }
    expect({ remoteStarts, localStarts }).toEqual({ remoteStarts: 1, localStarts: 0 });
    expect(lifecycle.authorityFor(providerProxySetIdentityFromRecord(record))).toBeNull();

    proof.resolve({ disappearanceReceipt: 'activation-containment-absent' });
    await vi.waitFor(() => expect(readProviderOperation(harness.db, record.operation)).toBeNull());

    expect(remoteStarts + localStarts).toBe(1);
    expect(localStarts).toBe(0);
  });
});

const PREPARED = {
  version: 1,
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'do the thing',
    cwd: fixtureCanonicalWorkDir(process.cwd()),
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
} as const;
const MATERIALIZED_PREPARED = { state: 'prepared', prepared: PREPARED } as const;

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function deferredValue<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function providerRecoveryAccepted(jobId: string): ProviderOperationRecoveryAcceptance {
  return { state: 'accepted', jobId, owner: 'recovery-coordinator' };
}

describe('ProviderOperationReconciler publication', () => {
  it('replays a stop recorded before executing attachment', async () => {
    const stopOperation = vi.fn(async () => undefined);
    const harness = createHarness({ stopOperation });
    const record = providerOperationRecord('executing');
    insertProviderOperation(harness.db, record);

    expect(harness.reconciler.requestStops([record.operation.jobId], 'signal_abort')).toEqual({
      kind: 'answered',
      outcomes: new Map([[record.operation.jobId, { kind: 'recorded' }]]),
    });
    const stopped = readProviderOperation(harness.db, record.operation);
    expect(stopped).toMatchObject({
      phase: 'executing',
      controlIntent: { kind: 'stop', cause: 'signal_abort' },
    });
    if (stopped === null) throw new Error('expected recorded provider stop');

    await harness.reconciler.reconcile(stopped, harness.authority);

    expect(stopOperation).toHaveBeenCalledOnce();
    expect(stopOperation).toHaveBeenCalledWith('signal_abort');
  });

  it('retries an executing attachment timeout at control establishment', async () => {
    let attachCalls = 0;
    const timeout = Object.assign(new Error('attach timed out'), { code: 'control_call_failed' });
    const harness = createHarness({
      attachOperation: async (_operation, committedThroughProviderSeq) => {
        attachCalls += 1;
        if (attachCalls === 1) throw timeout;
        return { state: 'attached', replayFromProviderSeq: committedThroughProviderSeq + 1 };
      },
    });
    const recovered = providerOperationRecord('executing');
    insertProviderOperation(harness.db, recovered);

    await harness.reconciler.reconcileAtStartup(
      harness.startupOwnership.ownershipFor(readProviderOperations(harness.db).records),
      new AbortController().signal,
    );

    expect(readProviderOperation(harness.db, recovered.operation)).toMatchObject({
      phase: 'executing',
      retryCount: 1,
    });
    expect(harness.registry.attach).not.toHaveBeenCalled();

    harness.reconciler.onControlEstablished(harness.authority);

    await vi.waitFor(() => {
      expect(attachCalls).toBe(2);
      expect(harness.registry.attach).toHaveBeenCalledOnce();
    });
    expect(readProviderOperation(harness.db, recovered.operation)?.phase).toBe('executing');
  });

  it('fences a blocked executing attach and acknowledges disappearance only after terminalization', async () => {
    let resolveAttach!: (result: { state: 'attached'; replayFromProviderSeq: number }) => void;
    const attachBlocked = new Promise<{ state: 'attached'; replayFromProviderSeq: number }>((resolve) => {
      resolveAttach = resolve;
    });
    const harness = createHarness({ attachOperation: () => attachBlocked });
    const terminalize = harness.terminalization.terminalize;
    const terminalization = vi
      .spyOn(harness.terminalization, 'terminalize')
      .mockImplementation((record, directive) => terminalize(record, directive));
    const recovered = providerOperationRecord('executing');
    insertProviderOperation(harness.db, recovered);

    const drive = harness.reconciler.reconcile(recovered, harness.authority);
    await vi.waitFor(() => expect(readProviderOperation(harness.db, recovered.operation)?.phase).toBe('executing'));

    const acceptance = harness.reconciler.containmentDisappeared({
      operation: recovered.operation,
      setIdentity: providerProxySetIdentityFromRecord(recovered),
      disappearanceReceipt: 'exact-absence-receipt',
    });
    const accepted = await acceptance;

    if (accepted.kind !== 'accepted') throw new Error('disappearance terminalization unexpectedly requested retry');
    expect(accepted.acceptance.disposition).toBe('terminalization-committed');
    const setIdentity = providerProxySetIdentityFromRecord(recovered);
    const reference = `proxyInstanceId=${setIdentity.proxyInstanceId},buildSetId=${setIdentity.buildSetId}`;
    expect(terminalization).toHaveBeenCalledWith(
      recovered,
      expect.objectContaining({
        code: 'provider_lost',
        reason: `The provider became unavailable, so this job stopped before completion. Retry the job. Reference: ${reference}.`,
      }),
    );
    expect(readProviderOperation(harness.db, recovered.operation)).toBeNull();
    expect(harness.registry.attach).not.toHaveBeenCalled();

    if (recovered.phase !== 'executing') throw new Error('expected executing fixture');
    resolveAttach({ state: 'attached', replayFromProviderSeq: recovered.committedThroughProviderSeq + 1 });
    await drive;
    await Promise.resolve();
    expect(harness.registry.attach).not.toHaveBeenCalled();
    expect(readProviderOperation(harness.db, recovered.operation)).toBeNull();
  });

  it('replays a durable stop intent when attaching an executing operation after restart', async () => {
    const stopOperation = vi.fn(async () => undefined);
    const harness = createHarness({ stopOperation });
    const recovered = providerOperationRecordSchema.parse({
      ...providerOperationRecord('executing'),
      controlIntent: {
        kind: 'stop',
        cause: 'user_abort',
        requestedAt: '2026-08-09T12:34:56.000Z',
      },
    });
    if (recovered.phase !== 'executing') throw new Error('expected executing recovery fixture');
    insertProviderOperation(harness.db, recovered);

    await harness.reconciler.reconcileAtStartup(
      harness.startupOwnership.ownershipFor(readProviderOperations(harness.db).records),
      new AbortController().signal,
    );

    expect(stopOperation).toHaveBeenCalledOnce();
    expect(stopOperation).toHaveBeenCalledWith('user_abort');
    expect(harness.registry.attach).toHaveBeenCalledOnce();
    expect(readProviderOperation(harness.db, recovered.operation)).toMatchObject({
      phase: 'executing',
      controlIntent: recovered.controlIntent,
    });
  });

  it('holds shutdown admission until an accepted activation publishes its executing claim', async () => {
    const activation = deferredValue<typeof activationAck>();
    const harness = createHarness({ activatePreparedOperation: () => activation.promise });
    const lifecycleAcquisition = acquireProviderOperationMutationAdmission(harness.db, 'test-coordinator');
    expect(lifecycleAcquisition.kind).toBe('acquired');
    if (lifecycleAcquisition.kind !== 'acquired') throw new Error('lifecycle admission was not acquired');
    const observedPhases: string[] = [];
    const unsubscribe = subscribeProviderOperationMutations(harness.db, (mutation) => {
      if (mutation.kind === 'upserted') observedPhases.push(mutation.record.phase);
    });

    try {
      const publication = harness.begin();
      await vi.waitFor(() =>
        expect(readProviderOperation(harness.db, harness.record.operation)?.phase).toBe('proxy-activation-pending'),
      );

      const stopping = harness.reconciler.stop();
      expect(stopping).toMatchObject({
        kind: 'holding',
        exit: 'admitted-provider-operation-mutation-settlement',
      });
      if (stopping.kind !== 'holding') throw new Error('accepted activation was not retained by stop');

      expect(() => insertProviderOperation(harness.db, providerOperationRecord('prepare-pending', { job: 2 }))).toThrow(
        'Provider operation mutation admission is closed.',
      );

      activation.resolve(activationAck);
      await expect(publication).resolves.toEqual({ kind: 'remote-executing' });
      await stopping.retryAfter;

      expect(readProviderOperation(harness.db, harness.record.operation)?.phase).toBe('executing');
      expect(observedPhases).toContain('executing');
      expect(harness.reconciler.stop()).toEqual({ kind: 'drained' });
      expect(lifecycleAcquisition.admission.accepting).toBe(false);
      expect(acquireProviderOperationMutationAdmission(harness.db, 'successor-coordinator').kind).toBe('acquired');
      await expect(harness.reconciler.reconcile(harness.record)).rejects.toThrow(
        'Provider operation mutation admission is closed.',
      );
    } finally {
      unsubscribe();
    }
  });

  it('does not complete recovery against a stale local-recovery revision', async () => {
    const firstAcceptance = deferred();
    const currentAcceptance = deferred();
    const recoverLocalJob = vi
      .fn()
      .mockImplementationOnce(async (record) => {
        await firstAcceptance.promise;
        return providerRecoveryAccepted(record.operation.jobId);
      })
      .mockImplementationOnce(async (record) => {
        await currentAcceptance.promise;
        return providerRecoveryAccepted(record.operation.jobId);
      });
    const completeLocalRecovery = vi.fn();
    const harness = createHarness({ recoverLocalJob, completeLocalRecovery });
    const record = providerOperationRecord('local-recovery-pending');
    insertProviderOperation(harness.db, record);

    const reconciliation = harness.reconciler.reconcile(record);
    await vi.waitFor(() => expect(recoverLocalJob).toHaveBeenCalledTimes(1));
    const current = providerOperationRecordSchema.parse({
      ...record,
      reason: 'A newer recovery owner won the journal revision.',
      revision: record.revision + 1,
    });
    expect(compareAndSwapProviderOperation(harness.db, record, current)).toEqual({ kind: 'updated', record: current });

    firstAcceptance.resolve();
    await vi.waitFor(() => expect(recoverLocalJob).toHaveBeenCalledTimes(2));
    expect(readProviderOperation(harness.db, record.operation)).toEqual(current);
    expect(completeLocalRecovery).not.toHaveBeenCalled();

    currentAcceptance.resolve();
    await reconciliation;
    expect(readProviderOperation(harness.db, record.operation)).toBeNull();
    expect(completeLocalRecovery).toHaveBeenCalledOnce();
  });

  it('releases and terminalizes an expired recovered authorization instead of retrying it', async () => {
    const sentPrepareAttemptNumbers: number[] = [];
    const prepareOperation = vi.fn(async (attempt) => {
      sentPrepareAttemptNumbers.push(attempt.request.prepareAttemptNumber);
      return {
        state: 'pending-activation' as const,
        reservation: asReservation('00000000-0000-4000-8000-000000000007'),
        leaseExpiresInMs: 15_000,
        providerRoot: { pid: 104, incarnation: testIncarnation(1_003) },
        jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
      };
    });
    const cancelOperation = vi.fn(async (operation, prepareAttemptNumber, prepareAttemptKey) => ({
      state: 'released-never-started' as const,
      operation,
      prepareAttemptNumber,
      prepareAttemptKey,
    }));
    const materializePrepare = vi
      .fn()
      .mockResolvedValueOnce({
        state: 'permanent-refusal',
        code: 'authorization_expired',
        disposition: 'terminal-failure',
        reason: 'Provider operation child authorization has expired.',
      })
      .mockResolvedValue(MATERIALIZED_PREPARED);
    const harness = createHarness({
      prepareOperation,
      inspectOperation: async () => ({ state: 'absent' }),
      cancelOperation,
      materializePrepare,
    });
    insertProviderOperation(harness.db, harness.record);

    await harness.reconciler.reconcile(harness.record, harness.authority);
    const afterRefusal = readProviderOperation(harness.db, harness.record.operation);
    if (afterRefusal !== null) {
      await harness.reconciler.reconcile(afterRefusal, harness.authority);
    }

    expect(sentPrepareAttemptNumbers).toEqual([]);
    expect(materializePrepare).toHaveBeenCalledOnce();
    expect(cancelOperation).toHaveBeenCalledTimes(2);
    expect(prepareOperation).not.toHaveBeenCalled();
    expect(readProviderOperation(harness.db, harness.record.operation)).toBeNull();
    expect(harness.appended).toEqual([
      expect.objectContaining({
        type: 'job.progress.emitted',
        body: {
          kind: 'domain',
          stage: 'provider_operation_failed',
          message: 'Provider operation child authorization has expired.',
          detail: { code: 'authorization_expired' },
        },
      }),
      expect.objectContaining({ type: 'job.terminal.recorded' }),
    ]);
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
});
