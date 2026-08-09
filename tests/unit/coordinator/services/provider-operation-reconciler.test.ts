import { describe, expect, it, vi } from 'vitest';

import type { JobProgressStore } from '#src/jobs/contracts/job-store.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { providerOperationPrepareAttempt } from '#src/coordinator/services/provider-proxy-operation-activation.js';
import {
  ProviderOperationReconciler,
  providerOperationTerminationVerdict,
  type ProviderOperationReconciliationEvidence,
} from '#src/coordinator/services/provider-operation-reconciler.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import {
  compareAndSwapProviderOperation,
  insertProviderOperation,
  readProviderOperation,
} from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { proxyOperationAttachResultSchema } from '#src/provider-proxy/protocol.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import {
  asJointActivationReceipt,
  asJointContainmentReceipt,
  asReservation,
} from '#tests/helpers/provider-proxy-correlation.js';

import { providerOperationRecord } from '../../store/provider-operation-fixtures.js';

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

describe('provider operation termination verdicts', () => {
  it('fires each termination only from its own semantic evidence', () => {
    const cases = [
      [
        providerOperationRecord('proxy-activation-pending'),
        { kind: 'activation-ack-replayed', activationAck, localRuntimeCommitCompleted: true },
        'executing',
      ],
      [
        providerOperationRecord('proxy-activation-pending'),
        { kind: 'activation-ack-replayed', activationAck, localRuntimeCommitCompleted: false },
        'pending',
      ],
      [
        providerOperationRecord('prestart-cleanup-pending'),
        {
          kind: 'released-never-started',
          operation: providerOperationRecord('prestart-cleanup-pending').operation,
          prepareAttemptNumber: 1,
          prepareAttemptKey: 'b'.repeat(64),
        },
        'released-never-started',
      ],
      [
        providerOperationRecord('settlement-pending'),
        { kind: 'released-after-terminal', settledThroughProviderSeq: 4 },
        'released-after-terminal',
      ],
      [
        providerOperationRecord('activation-resolution-pending'),
        { kind: 'containment-disappeared', disappearanceReceipt: 'gone' },
        'indeterminate-activation',
      ],
      [providerOperationRecord('prepare-pending'), { kind: 'unresolved' }, 'pending'],
    ] satisfies ReadonlyArray<readonly [ProviderOperationRecord, ProviderOperationReconciliationEvidence, string]>;

    for (const [record, evidence, expected] of cases) {
      expect(providerOperationTerminationVerdict(record, evidence).kind).toBe(expected);
    }
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
    cwd: '/workspace',
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
} as const;

function createHarness(
  overrides: {
    prepareOperation?: DurableProviderProxyOperationAuthority['prepareOperation'];
    inspectOperation?: DurableProviderProxyOperationAuthority['inspectOperation'];
    authorizeOperation?: DurableProviderProxyOperationAuthority['authorizeOperation'];
    activatePreparedOperation?: DurableProviderProxyOperationAuthority['activatePreparedOperation'];
    attachOperation?: DurableProviderProxyOperationAuthority['attachOperation'];
    settleOperation?: DurableProviderProxyOperationAuthority['settleOperation'];
    cancelOperation?: DurableProviderProxyOperationAuthority['cancelOperation'];
    materializePrepare?: () => typeof PREPARED | Promise<typeof PREPARED>;
    failCommitOnce?: boolean;
  } = {},
) {
  const record = providerOperationRecord('prepare-pending') as Extract<
    ProviderOperationRecord,
    { phase: 'prepare-pending' }
  >;
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const appended: unknown[] = [];
  let failCommit = overrides.failCommitOnce === true;
  const commit: JobProgressStore['commit'] = (callback) => {
    const pending: unknown[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      callback({
        append: (input) => {
          pending.push(input);
          return {} as never;
        },
      });
      if (failCommit) {
        failCommit = false;
        throw new Error('injected runtime commit failure');
      }
      db.exec('COMMIT');
      appended.push(...pending);
      return [];
    } catch (error: unknown) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const progressStore: Pick<JobProgressStore, 'getDb' | 'commit' | 'readStatus' | 'readLaunchProjection'> = {
    getDb: () => db,
    commit,
    readStatus: () => ({
      jobId: record.operation.jobId,
      owner: { kind: 'provider-session', id: record.prepareSource.sessionId },
      sessionId: record.prepareSource.sessionId,
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'tests',
      jobKind: 'provider',
      phase: 'running',
      updatedAt: '2026-08-09T12:34:55.000Z',
    }),
    readLaunchProjection: () => ({
      jobId: record.operation.jobId,
      owner: { kind: 'provider-session', id: record.prepareSource.sessionId },
      sessionId: record.prepareSource.sessionId,
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'tests',
      pool: 'curate',
      enqueueSequence: 1,
      createdAt: '2026-08-09T12:34:55.000Z',
      jobKind: 'provider',
      providerAction: 'exec',
      request: {
        prompt: 'do the thing',
        cwd: '/workspace',
        bypassPermissions: false,
        coralEnv: {},
      },
    }),
  };
  const phasesBeforeMutation: string[] = [];
  const readPhase = (): string => readProviderOperation(db, record.operation)?.phase ?? 'missing';
  const authority: DurableProviderProxyOperationAuthority = {
    proxyInstanceId: record.operation.proxyInstanceId,
    setIdentity: {
      buildSetId: record.operation.buildSetId,
      hostFingerprint: record.locator.hostFingerprint,
      guardianInstanceId: record.locator.guardian.instanceId,
      guardianPid: record.locator.guardian.pid,
      guardianProcessStartedAtSeconds: record.locator.guardian.processStartedAtSeconds,
      guardianControlEndpoint: record.locator.guardian.controlEndpoint,
      proxyInstanceId: record.locator.proxy.instanceId,
      proxyPid: record.locator.proxy.pid,
      reaperInstanceId: record.locator.reaper.instanceId,
      reaperPid: record.locator.reaper.pid,
      reaperProcessStartedAtSeconds: record.locator.reaper.processStartedAtSeconds,
      reaperControlEndpoint: record.locator.reaper.controlEndpoint,
      containmentKind: record.locator.containment.kind,
      proxyProcessStartedAtSeconds: record.locator.proxy.processStartedAtSeconds,
      proxyProcessGroupId: record.locator.containment.processGroupId,
      canonicalEndpoint: record.locator.proxy.controlEndpoint,
    },
    snapshotOperations: async () => [],
    installHandoffGrant: async () => undefined,
    stopAndReap: async () => ({ disappearanceReceipt: 'gone' }),
    stopHeartbeats: () => undefined,
    initiateControlClose: async () => undefined,
    prepareOperation:
      overrides.prepareOperation ??
      (async () => {
        phasesBeforeMutation.push(readPhase());
        return {
          state: 'pending-activation',
          reservation: asReservation('00000000-0000-4000-8000-000000000007'),
          leaseExpiresInMs: 15_000,
          providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
          jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
        };
      }),
    inspectOperation: overrides.inspectOperation ?? (async () => ({ state: 'absent' })),
    authorizeOperation:
      overrides.authorizeOperation ??
      (async () => {
        phasesBeforeMutation.push(readPhase());
        return {
          state: 'activation-authorized',
          jointActivationReceipt: asJointActivationReceipt('activation-receipt'),
        };
      }),
    activatePreparedOperation:
      overrides.activatePreparedOperation ??
      (async () => {
        phasesBeforeMutation.push(readPhase());
        return activationAck;
      }),
    attachOperation:
      overrides.attachOperation ??
      (async (_operation, committedThroughProviderSeq) => {
        phasesBeforeMutation.push(readPhase());
        return { state: 'attached', replayFromProviderSeq: committedThroughProviderSeq + 1 };
      }),
    cancelOperation:
      overrides.cancelOperation ??
      (async (operation, prepareAttemptNumber, prepareAttemptKey) => ({
        state: 'released-never-started',
        operation,
        prepareAttemptNumber,
        prepareAttemptKey,
      })),
    settleOperation:
      overrides.settleOperation ??
      (async (_operation, finalProviderSeq) => ({
        state: 'released-after-terminal',
        settledThroughProviderSeq: finalProviderSeq,
      })),
    buildOperationControl: () => ({ stop: async () => undefined }),
  };
  const registry = { activate: vi.fn(), adopt: vi.fn(), settled: vi.fn() };
  let now = 100;
  const reconciler = new ProviderOperationReconciler({
    getProgressStore: () => progressStore,
    authorityFor: () => authority,
    registry,
    materializePrepare: overrides.materializePrepare ?? (() => PREPARED),
    backendNamespace: 'tests',
    time: {
      now: () => now,
      setTimeout: () => ({ unref: () => undefined }),
      clearTimeout: () => undefined,
    },
  });
  const begin = () => {
    const attempt = providerOperationPrepareAttempt(authority, record.operation, PREPARED, record.prepareAttemptNumber);
    return reconciler.begin({
      record: { ...record, prepareAttemptKey: attempt.prepareAttemptKey },
      attempt,
      authority,
    });
  };

  return {
    record,
    db,
    appended,
    progressStore,
    authority,
    registry,
    reconciler,
    phasesBeforeMutation,
    begin,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ProviderOperationReconciler publication', () => {
  it('writes every mutation intent before its send and commits execution only from the activation ACK', async () => {
    const harness = createHarness();

    await expect(harness.begin()).resolves.toEqual({ kind: 'remote-executing' });

    expect(harness.phasesBeforeMutation).toEqual([
      'prepare-pending',
      'guardian-activation-pending',
      'proxy-activation-pending',
      'executing',
    ]);
    expect(readProviderOperation(harness.db, harness.record.operation)?.phase).toBe('executing');
    expect(harness.appended).toEqual([expect.objectContaining({ type: 'job.runtime.started' })]);
    expect(harness.registry.activate).toHaveBeenCalledOnce();
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

    await harness.reconciler.reconcileAtStartup(new AbortController().signal);

    expect(readProviderOperation(harness.db, recovered.operation)).toMatchObject({
      phase: 'executing',
      retryCount: 1,
    });
    expect(harness.registry.adopt).not.toHaveBeenCalled();

    harness.reconciler.onControlEstablished(harness.authority);

    await vi.waitFor(() => expect(attachCalls).toBe(2));
    expect(harness.registry.adopt).toHaveBeenCalledOnce();
    expect(readProviderOperation(harness.db, recovered.operation)?.phase).toBe('executing');
  });

  it('retries a malformed attachment reply without treating it as absence', async () => {
    let attachCalls = 0;
    const harness = createHarness({
      attachOperation: async (_operation, committedThroughProviderSeq) => {
        attachCalls += 1;
        if (attachCalls === 1) {
          return proxyOperationAttachResultSchema.parse({ state: 'attached', replayFromProviderSeq: 0 });
        }
        return { state: 'attached', replayFromProviderSeq: committedThroughProviderSeq + 1 };
      },
    });
    let placement: unknown;
    const publication = harness.begin().then((result) => {
      placement = result;
      return result;
    });
    await vi.waitFor(() =>
      expect(readProviderOperation(harness.db, harness.record.operation)).toMatchObject({
        phase: 'executing',
        retryCount: 1,
      }),
    );

    expect(placement).toBeUndefined();
    expect(harness.registry.activate).not.toHaveBeenCalled();
    const retry = readProviderOperation(harness.db, harness.record.operation);
    if (retry?.phase !== 'executing') throw new Error('expected retryable executing attachment');
    await harness.reconciler.reconcile(retry, harness.authority);

    await expect(publication).resolves.toEqual({ kind: 'remote-executing' });
    expect(attachCalls).toBe(2);
    expect(harness.registry.activate).toHaveBeenCalledOnce();
  });

  it('enters placement failure only for an exact typed operation-absent proof', async () => {
    let attachCalls = 0;
    const harness = createHarness({
      attachOperation: async (operation) => {
        attachCalls += 1;
        return {
          state: 'operation-absent',
          operation: attachCalls === 1 ? { ...operation, operationId: 'wrong-operation' } : operation,
        };
      },
    });
    let placement: unknown;
    const publication = harness.begin().then((result) => {
      placement = result;
      return result;
    });
    await vi.waitFor(() =>
      expect(readProviderOperation(harness.db, harness.record.operation)).toMatchObject({
        phase: 'executing',
        retryCount: 1,
      }),
    );

    expect(placement).toBeUndefined();
    const retry = readProviderOperation(harness.db, harness.record.operation);
    if (retry?.phase !== 'executing') throw new Error('expected retryable executing attachment');
    await harness.reconciler.reconcile(retry, harness.authority);

    await expect(publication).resolves.toEqual({
      kind: 'failed',
      reason: 'The provider proxy proved that the committed operation is absent.',
    });
    expect(readProviderOperation(harness.db, harness.record.operation)).toBeNull();
    expect(harness.registry.activate).not.toHaveBeenCalled();
  });

  it('does not publish execution after two lost guardian activation replies', async () => {
    let guardianCalls = 0;
    const ambiguous = Object.assign(new Error('guardian reply lost'), { code: 'control_call_failed' });
    const harness = createHarness({
      authorizeOperation: async () => {
        guardianCalls += 1;
        if (guardianCalls <= 2) throw ambiguous;
        return {
          state: 'activation-authorized',
          jointActivationReceipt: asJointActivationReceipt('activation-receipt'),
        };
      },
    });
    let placement: unknown;
    const publication = harness.begin().then((result) => {
      placement = result;
      return result;
    });
    await vi.waitFor(() => expect(guardianCalls).toBe(1));
    let current = readProviderOperation(harness.db, harness.record.operation);
    if (current === null) throw new Error('expected guardian-pending journal row');
    await harness.reconciler.reconcile(current, harness.authority);

    expect(harness.appended).toEqual([]);
    expect(harness.registry.activate).not.toHaveBeenCalled();
    expect(guardianCalls).toBe(2);
    expect(placement).toBeUndefined();

    current = readProviderOperation(harness.db, harness.record.operation);
    if (current === null) throw new Error('expected retryable guardian-pending journal row');
    await harness.reconciler.reconcile(current, harness.authority);
    await expect(publication).resolves.toEqual({ kind: 'remote-executing' });
  });

  it('continues from a recovered prepare proof through activation', async () => {
    const ambiguous = Object.assign(new Error('prepare reply lost'), { code: 'control_call_failed' });
    const activatePreparedOperation = vi.fn(async () => activationAck);
    const harness = createHarness({
      prepareOperation: async () => {
        throw ambiguous;
      },
      inspectOperation: async () => ({
        state: 'prepared',
        reservation: asReservation('00000000-0000-4000-8000-000000000007'),
        leaseExpiresInMs: 15_000,
        providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
        jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
      }),
      activatePreparedOperation,
    });

    await expect(harness.begin()).resolves.toEqual({ kind: 'remote-executing' });

    expect(activatePreparedOperation).toHaveBeenCalledOnce();
    expect(readProviderOperation(harness.db, harness.record.operation)?.phase).toBe('executing');
  });

  it('keeps a timeout pending and never turns it into local authorization', async () => {
    const ambiguous = Object.assign(new Error('prepare timed out'), { code: 'control_call_failed' });
    const harness = createHarness({
      prepareOperation: async () => {
        throw ambiguous;
      },
      inspectOperation: async () => {
        throw ambiguous;
      },
    });
    let placement: unknown;
    void harness.begin().then((result) => {
      placement = result;
    });
    await vi.waitFor(() => expect(readProviderOperation(harness.db, harness.record.operation)?.retryCount).toBe(1));

    expect(placement).toBeUndefined();
    expect(readProviderOperation(harness.db, harness.record.operation)?.phase).toBe('prepare-pending');
    expect(harness.appended).toEqual([]);
  });

  it('drives a recovered proxy-activation-pending row to proven prestart release', async () => {
    const activationRefused = Object.assign(new Error('activation refused'), { code: 'activation_refused' });
    const activatePreparedOperation = vi.fn(async () => {
      throw activationRefused;
    });
    const inspectOperation = vi.fn(async () => ({
      state: 'prepared' as const,
      reservation: asReservation('00000000-0000-4000-8000-000000000007'),
      leaseExpiresInMs: 15_000,
      providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
      jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
    }));
    const harness = createHarness({ activatePreparedOperation, inspectOperation });
    const recovered = providerOperationRecord('proxy-activation-pending');
    insertProviderOperation(harness.db, recovered);
    const acquireAuthority = vi.fn(async () => harness.authority);
    const reconciler = new ProviderOperationReconciler({
      getProgressStore: () => harness.progressStore,
      authorityFor: () => null,
      acquireAuthority,
      registry: harness.registry,
      materializePrepare: () => PREPARED,
      backendNamespace: 'tests',
      time: {
        now: () => 100,
        setTimeout: () => ({ unref: () => undefined }),
        clearTimeout: () => undefined,
      },
    });

    await reconciler.reconcileAtStartup(new AbortController().signal);

    expect(acquireAuthority).toHaveBeenCalledWith(recovered, expect.any(AbortSignal));
    expect(activatePreparedOperation).toHaveBeenCalledOnce();
    expect(inspectOperation).toHaveBeenCalledOnce();
    expect(readProviderOperation(harness.db, recovered.operation)).toBeNull();
    expect(harness.registry.activate).not.toHaveBeenCalled();
    expect(harness.appended).toEqual([]);
  });

  it('keeps a recovered activation pending when its durable proxy locator is unreachable', async () => {
    const harness = createHarness();
    const recovered = providerOperationRecord('proxy-activation-pending');
    insertProviderOperation(harness.db, recovered);
    const acquireAuthority = vi.fn(async () => null);
    const registry = { activate: vi.fn(), adopt: vi.fn(), settled: vi.fn() };
    const reconciler = new ProviderOperationReconciler({
      getProgressStore: () => harness.progressStore,
      authorityFor: () => null,
      acquireAuthority,
      registry,
      materializePrepare: () => PREPARED,
      backendNamespace: 'tests',
      time: {
        now: () => 100,
        setTimeout: () => ({ unref: () => undefined }),
        clearTimeout: () => undefined,
      },
    });

    await reconciler.reconcileAtStartup(new AbortController().signal);

    expect(acquireAuthority).toHaveBeenCalledWith(recovered, expect.any(AbortSignal));
    expect(readProviderOperation(harness.db, recovered.operation)).toMatchObject({
      phase: 'proxy-activation-pending',
      retryCount: 1,
    });
    expect(registry.activate).not.toHaveBeenCalled();
    expect(harness.appended).toEqual([]);
  });

  it('retries an active publication immediately when its proxy control is established', async () => {
    const ambiguous = Object.assign(new Error('prepare timed out'), { code: 'control_call_failed' });
    let prepareCalls = 0;
    const harness = createHarness({
      prepareOperation: async () => {
        prepareCalls += 1;
        if (prepareCalls === 1) throw ambiguous;
        return {
          state: 'pending-activation',
          reservation: asReservation('00000000-0000-4000-8000-000000000007'),
          leaseExpiresInMs: 15_000,
          providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
          jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
        };
      },
      inspectOperation: async () => {
        throw ambiguous;
      },
    });
    const publication = harness.begin();
    await vi.waitFor(() => expect(readProviderOperation(harness.db, harness.record.operation)?.retryCount).toBe(1));

    harness.reconciler.onControlEstablished(harness.authority);

    await vi.waitFor(() => expect(prepareCalls).toBe(2));
    await expect(publication).resolves.toEqual({ kind: 'remote-executing' });
  });

  it('fences an absent recovered attempt, journals its replacement, then finishes execution', async () => {
    const sendObservations: Array<{
      durableAttemptNumber: number;
      durableAttemptKey: string;
      sentAttemptNumber: number;
      sentAttemptKey: string;
    }> = [];
    let observeSend: (
      attempt: Parameters<DurableProviderProxyOperationAuthority['prepareOperation']>[0],
    ) => void = () => undefined;
    const prepareOperation = vi.fn(async (attempt) => {
      observeSend(attempt);
      return {
        state: 'pending-activation' as const,
        reservation: asReservation('00000000-0000-4000-8000-000000000007'),
        leaseExpiresInMs: 15_000,
        providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
        jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
      };
    });
    const inspectOperation = vi.fn(async () => ({ state: 'absent' as const }));
    const cancelOperation = vi.fn(async (operation, prepareAttemptNumber, prepareAttemptKey) => ({
      state: 'released-never-started' as const,
      operation,
      prepareAttemptNumber,
      prepareAttemptKey,
    }));
    const materializePrepare = vi.fn(() => PREPARED);
    const harness = createHarness({ prepareOperation, inspectOperation, cancelOperation, materializePrepare });
    observeSend = (attempt) => {
      const durable = readProviderOperation(harness.db, harness.record.operation);
      if (durable?.phase !== 'prepare-pending') throw new Error('prepare was sent without a pending journal attempt');
      sendObservations.push({
        durableAttemptNumber: durable.prepareAttemptNumber,
        durableAttemptKey: durable.prepareAttemptKey,
        sentAttemptNumber: attempt.request.prepareAttemptNumber,
        sentAttemptKey: attempt.prepareAttemptKey,
      });
    };
    insertProviderOperation(harness.db, harness.record);

    await harness.reconciler.reconcile(harness.record, harness.authority);

    expect(inspectOperation).toHaveBeenCalledWith(harness.record.operation, harness.record.prepareAttemptKey);
    expect(cancelOperation).toHaveBeenCalledWith(
      harness.record.operation,
      harness.record.prepareAttemptNumber,
      harness.record.prepareAttemptKey,
    );
    expect(materializePrepare).toHaveBeenCalledOnce();
    expect(sendObservations).toEqual([
      {
        durableAttemptNumber: 2,
        durableAttemptKey: expect.any(String),
        sentAttemptNumber: 2,
        sentAttemptKey: expect.any(String),
      },
    ]);
    expect(sendObservations[0]?.sentAttemptKey).toBe(sendObservations[0]?.durableAttemptKey);
    expect(readProviderOperation(harness.db, harness.record.operation)).toMatchObject({
      phase: 'executing',
      prepareAttemptNumber: 2,
      prepareAttemptKey: sendObservations[0]?.sentAttemptKey,
    });
  });

  it('does not rotate or send when cancellation proof names a different attempt', async () => {
    const prepareOperation = vi.fn();
    const materializePrepare = vi.fn(() => PREPARED);
    const harness = createHarness({
      prepareOperation,
      inspectOperation: async () => ({ state: 'absent' }),
      cancelOperation: async (operation, prepareAttemptNumber, prepareAttemptKey) => ({
        state: 'released-never-started',
        operation,
        prepareAttemptNumber: prepareAttemptNumber + 1,
        prepareAttemptKey,
      }),
      materializePrepare,
    });
    insertProviderOperation(harness.db, harness.record);

    await harness.reconciler.reconcile(harness.record, harness.authority);

    expect(materializePrepare).not.toHaveBeenCalled();
    expect(prepareOperation).not.toHaveBeenCalled();
    expect(readProviderOperation(harness.db, harness.record.operation)).toMatchObject({
      phase: 'prepare-pending',
      prepareAttemptNumber: 1,
      prepareAttemptKey: harness.record.prepareAttemptKey,
      retryCount: 1,
      lastError: expect.objectContaining({
        message: 'Cancellation acknowledgement did not fence the journaled prepare attempt.',
      }),
    });
  });

  it('publishes a replayed activation receipt and registers reconstructable cleanup', async () => {
    const harness = createHarness();
    const recovered = providerOperationRecord('proxy-activation-pending');
    insertProviderOperation(harness.db, recovered);

    await harness.reconciler.reconcile(recovered, harness.authority);

    expect(harness.appended).toEqual([
      expect.objectContaining({
        type: 'job.runtime.started',
        body: {
          transport: 'app-server',
          startedAt: activationAck.startedAt,
          providerMeta: {
            provider: activationAck.hostRef.provider,
            leaseState: 'acquired',
            hostRef: activationAck.hostRef,
          },
        },
      }),
    ]);
    expect(harness.registry.adopt).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), {
      jobId: recovered.operation.jobId,
      pool: 'curate',
    });
  });

  it('resumes a recovered pending cleanup when redeemed proxy control is established', async () => {
    const harness = createHarness();
    const recovered = providerOperationRecord('prestart-cleanup-pending');
    insertProviderOperation(harness.db, recovered);

    harness.reconciler.onControlEstablished(harness.authority);

    await vi.waitFor(() => expect(readProviderOperation(harness.db, recovered.operation)).toBeNull());
    expect(harness.registry.activate).not.toHaveBeenCalled();
    expect(harness.appended).toEqual([]);
  });

  it('leaves proxy activation pending when the atomic runtime commit fails after the ACK', async () => {
    const harness = createHarness({ failCommitOnce: true });
    let placement: unknown;
    void harness.begin().then((result) => {
      placement = result;
    });
    await vi.waitFor(() =>
      expect(readProviderOperation(harness.db, harness.record.operation)).toMatchObject({
        phase: 'proxy-activation-pending',
        retryCount: 1,
      }),
    );

    expect(placement).toBeUndefined();
    expect(harness.appended).toEqual([]);
    expect(harness.registry.activate).not.toHaveBeenCalled();
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

type FaultBoundary =
  | 'before-send'
  | 'after-send'
  | 'before-reply'
  | 'after-reply'
  | 'before-sqlite-commit'
  | 'after-sqlite-commit';

const FAULT_BOUNDARIES: readonly FaultBoundary[] = [
  'before-send',
  'after-send',
  'before-reply',
  'after-reply',
  'before-sqlite-commit',
  'after-sqlite-commit',
];

type RemoteOperationState = {
  prepared: boolean;
  guardianAuthorized: boolean;
  kernelStarts: number;
  ledgerPresent: boolean;
  guardianMembershipPresent: boolean;
  terminalAwaitingSettlement: boolean;
};

function injectedTransportError(boundary: FaultBoundary): Error {
  return Object.assign(new Error(`injected ${boundary} fault`), { code: 'control_call_failed' });
}

async function callAcrossFaultBoundary<T>(
  boundary: FaultBoundary,
  observe: (point: FaultBoundary) => void,
  applyRemoteEffect: () => void,
  reply: () => T,
): Promise<T> {
  observe('before-send');
  if (boundary === 'before-send') throw injectedTransportError(boundary);
  observe('after-send');
  if (boundary === 'after-send') throw injectedTransportError(boundary);
  applyRemoteEffect();
  observe('before-reply');
  if (boundary === 'before-reply') throw injectedTransportError(boundary);
  const result = reply();
  observe('after-reply');
  if (boundary === 'after-reply') throw injectedTransportError(boundary);
  return result;
}

function installSqliteCommitFault(
  harness: ReturnType<typeof createHarness>,
  boundary: Extract<FaultBoundary, 'before-sqlite-commit' | 'after-sqlite-commit'>,
  committedPhase: ProviderOperationRecord['phase'] | null,
): () => void {
  let armed = true;
  const originalExec = harness.db.exec.bind(harness.db);
  const spy = vi.spyOn(harness.db, 'exec').mockImplementation((sql: string) => {
    if (armed && sql.trim().toUpperCase() === 'COMMIT') {
      const current = readProviderOperation(harness.db, harness.record.operation);
      const matches = committedPhase === null ? current === null : current?.phase === committedPhase;
      if (matches && boundary === 'before-sqlite-commit') {
        armed = false;
        throw new Error(`injected ${boundary} fault`);
      }
      const result = originalExec(sql);
      if (matches && boundary === 'after-sqlite-commit') {
        armed = false;
        throw new Error(`injected ${boundary} fault`);
      }
      return result;
    }
    return originalExec(sql);
  });
  return () => spy.mockRestore();
}

function expectFaultInvariant(
  harness: ReturnType<typeof createHarness>,
  state: RemoteOperationState,
  stage: string,
  boundary: FaultBoundary,
): void {
  const record = readProviderOperation(harness.db, harness.record.operation);
  const remoteStateExists =
    state.prepared ||
    state.guardianAuthorized ||
    state.ledgerPresent ||
    state.guardianMembershipPresent ||
    state.terminalAwaitingSettlement;
  if (remoteStateExists) {
    expect(record, `${stage}/${boundary}: remote state lost its durable name`).not.toBeNull();
  }
  expect(state.kernelStarts, `${stage}/${boundary}: kernel started more than once`).toBeLessThanOrEqual(1);
  if (record?.phase === 'executing' || harness.registry.activate.mock.calls.length > 0) {
    expect(state.kernelStarts, `${stage}/${boundary}: execution was published without a kernel`).toBe(1);
  }
  if (record === null) {
    expect(remoteStateExists, `${stage}/${boundary}: unnamed remote state survived`).toBe(false);
  }
}

async function driveCurrentRecord(harness: ReturnType<typeof createHarness>): Promise<ProviderOperationRecord | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = readProviderOperation(harness.db, harness.record.operation);
    if (
      current === null ||
      (current.phase === 'executing' &&
        (harness.registry.activate.mock.calls.length > 0 || harness.registry.adopt.mock.calls.length > 0))
    ) {
      return current;
    }
    await harness.reconciler.reconcile(current, harness.authority);
  }
  return readProviderOperation(harness.db, harness.record.operation);
}

function startedRemoteState(): RemoteOperationState {
  return {
    prepared: false,
    guardianAuthorized: false,
    kernelStarts: 1,
    ledgerPresent: true,
    guardianMembershipPresent: true,
    terminalAwaitingSettlement: false,
  };
}

describe('ProviderOperationReconciler fault-injection matrix', () => {
  it('preserves publication invariants across every prepare boundary', async () => {
    for (const boundary of FAULT_BOUNDARIES) {
      const state: RemoteOperationState = {
        prepared: false,
        guardianAuthorized: false,
        kernelStarts: 0,
        ledgerPresent: false,
        guardianMembershipPresent: false,
        terminalAwaitingSettlement: false,
      };
      let faulted = false;
      const harness = createHarness({
        prepareOperation: async () => {
          if (!faulted && !boundary.includes('sqlite')) {
            faulted = true;
            return callAcrossFaultBoundary(
              boundary,
              observe,
              () => {
                state.prepared = true;
                state.guardianMembershipPresent = true;
              },
              () => ({
                state: 'pending-activation' as const,
                reservation: asReservation('00000000-0000-4000-8000-000000000007'),
                leaseExpiresInMs: 15_000,
                providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
                jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
              }),
            );
          }
          state.prepared = true;
          state.guardianMembershipPresent = true;
          return {
            state: 'pending-activation' as const,
            reservation: asReservation('00000000-0000-4000-8000-000000000007'),
            leaseExpiresInMs: 15_000,
            providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
            jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
          };
        },
        inspectOperation: async () =>
          state.prepared
            ? {
                state: 'prepared' as const,
                reservation: asReservation('00000000-0000-4000-8000-000000000007'),
                leaseExpiresInMs: 15_000,
                providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
                jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
              }
            : { state: 'absent' as const },
        cancelOperation: async (operation, prepareAttemptNumber, prepareAttemptKey) => {
          state.prepared = false;
          state.guardianAuthorized = false;
          state.guardianMembershipPresent = false;
          return { state: 'released-never-started', operation, prepareAttemptNumber, prepareAttemptKey };
        },
        authorizeOperation: async () => {
          state.guardianAuthorized = true;
          return {
            state: 'activation-authorized',
            jointActivationReceipt: asJointActivationReceipt('activation-receipt'),
          };
        },
        activatePreparedOperation: async () => {
          if (!state.ledgerPresent) state.kernelStarts += 1;
          state.ledgerPresent = true;
          return activationAck;
        },
      });
      const observe = (point: FaultBoundary): void => {
        const record = readProviderOperation(harness.db, harness.record.operation);
        expect(record?.phase, `prepare/${boundary} at ${point}`).toBe('prepare-pending');
      };
      const restoreCommitFault = boundary.includes('sqlite')
        ? installSqliteCommitFault(
            harness,
            boundary as 'before-sqlite-commit' | 'after-sqlite-commit',
            'guardian-activation-pending',
          )
        : () => undefined;
      const publication = harness.begin();
      await vi.waitFor(() =>
        expect(readProviderOperation(harness.db, harness.record.operation)?.revision ?? 0).toBeGreaterThan(0),
      );
      restoreCommitFault();
      expectFaultInvariant(harness, state, 'prepare', boundary);
      const final = await driveCurrentRecord(harness);
      const placement = await publication;
      expect(final?.phase, `prepare/${boundary}: publication did not settle`).toBe('executing');
      expect(placement).toEqual({ kind: 'remote-executing' });
      expectFaultInvariant(harness, state, 'prepare', boundary);
    }
  });

  it('preserves publication invariants across every guardian-activation boundary', async () => {
    for (const boundary of FAULT_BOUNDARIES) {
      const state: RemoteOperationState = {
        prepared: true,
        guardianAuthorized: false,
        kernelStarts: 0,
        ledgerPresent: false,
        guardianMembershipPresent: true,
        terminalAwaitingSettlement: false,
      };
      let faulted = false;
      const harness = createHarness({
        authorizeOperation: async () => {
          const observe = (point: FaultBoundary): void => {
            const current = readProviderOperation(harness.db, harness.record.operation);
            expect(current?.phase, `guardian activation/${boundary} at ${point}`).toBe('guardian-activation-pending');
          };
          if (!faulted && !boundary.includes('sqlite')) {
            faulted = true;
            return callAcrossFaultBoundary(
              boundary,
              observe,
              () => {
                state.guardianAuthorized = true;
              },
              () => ({
                state: 'activation-authorized' as const,
                jointActivationReceipt: asJointActivationReceipt('activation-receipt'),
              }),
            );
          }
          state.guardianAuthorized = true;
          return {
            state: 'activation-authorized',
            jointActivationReceipt: asJointActivationReceipt('activation-receipt'),
          };
        },
        activatePreparedOperation: async () => {
          if (!state.ledgerPresent) state.kernelStarts += 1;
          state.ledgerPresent = true;
          return activationAck;
        },
        cancelOperation: async (operation, prepareAttemptNumber, prepareAttemptKey) => {
          state.prepared = false;
          state.guardianAuthorized = false;
          state.guardianMembershipPresent = false;
          return { state: 'released-never-started', operation, prepareAttemptNumber, prepareAttemptKey };
        },
      });
      const initial = providerOperationRecord('guardian-activation-pending');
      insertProviderOperation(harness.db, initial);
      const restoreCommitFault = boundary.includes('sqlite')
        ? installSqliteCommitFault(
            harness,
            boundary as 'before-sqlite-commit' | 'after-sqlite-commit',
            'proxy-activation-pending',
          )
        : () => undefined;
      await harness.reconciler.reconcile(initial, harness.authority);
      restoreCommitFault();
      expectFaultInvariant(harness, state, 'guardian activation', boundary);
      const final = await driveCurrentRecord(harness);
      expect(['executing', undefined], `guardian activation/${boundary}: unsafe terminal phase`).toContain(
        final?.phase,
      );
      expectFaultInvariant(harness, state, 'guardian activation', boundary);
    }
  });

  it('preserves publication invariants across every proxy-activation boundary', async () => {
    for (const boundary of FAULT_BOUNDARIES) {
      const state: RemoteOperationState = {
        prepared: true,
        guardianAuthorized: true,
        kernelStarts: 0,
        ledgerPresent: false,
        guardianMembershipPresent: true,
        terminalAwaitingSettlement: false,
      };
      let faulted = false;
      const harness = createHarness({
        activatePreparedOperation: async () => {
          const observe = (point: FaultBoundary): void => {
            const current = readProviderOperation(harness.db, harness.record.operation);
            expect(current?.phase, `proxy activation/${boundary} at ${point}`).toBe('proxy-activation-pending');
          };
          if (!faulted && !boundary.includes('sqlite')) {
            faulted = true;
            return callAcrossFaultBoundary(
              boundary,
              observe,
              () => {
                if (!state.ledgerPresent) state.kernelStarts += 1;
                state.ledgerPresent = true;
              },
              () => activationAck,
            );
          }
          if (!state.ledgerPresent) state.kernelStarts += 1;
          state.ledgerPresent = true;
          return activationAck;
        },
      });
      const initial = providerOperationRecord('proxy-activation-pending');
      insertProviderOperation(harness.db, initial);
      const restoreCommitFault = boundary.includes('sqlite')
        ? installSqliteCommitFault(harness, boundary as 'before-sqlite-commit' | 'after-sqlite-commit', 'executing')
        : () => undefined;
      await harness.reconciler.reconcile(initial, harness.authority);
      restoreCommitFault();
      expectFaultInvariant(harness, state, 'proxy activation', boundary);
      const final = await driveCurrentRecord(harness);
      expect(final?.phase, `proxy activation/${boundary}: activation did not settle`).toBe('executing');
      expectFaultInvariant(harness, state, 'proxy activation', boundary);
    }
  });

  it('preserves settlement invariants across every boundary', async () => {
    for (const boundary of FAULT_BOUNDARIES) {
      const state = { ...startedRemoteState(), terminalAwaitingSettlement: true };
      let faulted = false;
      const harness = createHarness({
        settleOperation: async (_operation, finalProviderSeq) => {
          const observe = (point: FaultBoundary): void => {
            const current = readProviderOperation(harness.db, harness.record.operation);
            expect(current?.phase, `settlement/${boundary} at ${point}`).toBe('settlement-pending');
          };
          const release = (): void => {
            state.ledgerPresent = false;
            state.guardianMembershipPresent = false;
            state.terminalAwaitingSettlement = false;
          };
          if (!faulted && !boundary.includes('sqlite')) {
            faulted = true;
            return callAcrossFaultBoundary(boundary, observe, release, () => ({
              state: 'released-after-terminal' as const,
              settledThroughProviderSeq: finalProviderSeq,
            }));
          }
          release();
          return { state: 'released-after-terminal', settledThroughProviderSeq: finalProviderSeq };
        },
      });
      const initial = providerOperationRecord('settlement-pending');
      insertProviderOperation(harness.db, initial);
      const restoreCommitFault = boundary.includes('sqlite')
        ? installSqliteCommitFault(harness, boundary as 'before-sqlite-commit' | 'after-sqlite-commit', null)
        : () => undefined;
      await harness.reconciler.reconcile(initial, harness.authority);
      restoreCommitFault();
      expectFaultInvariant(harness, state, 'settlement', boundary);
      const final = await driveCurrentRecord(harness);
      expect(final, `settlement/${boundary}: tombstone survived confirmed release`).toBeNull();
      expectFaultInvariant(harness, state, 'settlement', boundary);
    }
  });

  it('preserves prestart-release invariants across every boundary', async () => {
    for (const boundary of FAULT_BOUNDARIES) {
      const state: RemoteOperationState = {
        prepared: true,
        guardianAuthorized: false,
        kernelStarts: 0,
        ledgerPresent: false,
        guardianMembershipPresent: true,
        terminalAwaitingSettlement: false,
      };
      let faulted = false;
      const harness = createHarness({
        cancelOperation: async (operation, prepareAttemptNumber, prepareAttemptKey) => {
          const observe = (point: FaultBoundary): void => {
            const current = readProviderOperation(harness.db, harness.record.operation);
            expect(current?.phase, `release/${boundary} at ${point}`).toBe('prestart-cleanup-pending');
          };
          const release = (): void => {
            state.prepared = false;
            state.guardianAuthorized = false;
            state.guardianMembershipPresent = false;
          };
          if (!faulted && !boundary.includes('sqlite')) {
            faulted = true;
            return callAcrossFaultBoundary(boundary, observe, release, () => ({
              state: 'released-never-started' as const,
              operation,
              prepareAttemptNumber,
              prepareAttemptKey,
            }));
          }
          release();
          return { state: 'released-never-started', operation, prepareAttemptNumber, prepareAttemptKey };
        },
      });
      const initial = providerOperationRecord('prestart-cleanup-pending');
      insertProviderOperation(harness.db, initial);
      const restoreCommitFault = boundary.includes('sqlite')
        ? installSqliteCommitFault(harness, boundary as 'before-sqlite-commit' | 'after-sqlite-commit', null)
        : () => undefined;
      await harness.reconciler.reconcile(initial, harness.authority);
      restoreCommitFault();
      expectFaultInvariant(harness, state, 'release', boundary);
      const final = await driveCurrentRecord(harness);
      expect(final, `release/${boundary}: cleanup row survived confirmed release`).toBeNull();
      expectFaultInvariant(harness, state, 'release', boundary);
    }
  });
});
