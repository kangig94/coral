import { describe, expect, it, vi } from 'vitest';

import type { JobProgressStore } from '#src/jobs/contracts/job-store.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { providerOperationPrepareAttempt } from '#src/coordinator/services/provider-proxy-operation-activation.js';
import type { ProviderOperationPrepareMaterializationResult } from '#src/coordinator/services/provider-operation-prepare.js';
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
import { OperationSupervisor } from '#src/provider-proxy/operation-supervisor.js';
import { proxyOperationAttachResultSchema } from '#src/provider-proxy/protocol.js';
import { createGrantRegistry, handoffSecretDigest, type HandoffCapsule } from '#src/provider-proxy/handoff-capsule.js';
import { terminalizeProviderOperation } from '#src/jobs/provider-operation-terminalization.js';
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
const MATERIALIZED_PREPARED = { kind: 'prepared', prepared: PREPARED } as const;

function preparedFor(provider: string) {
  return {
    ...PREPARED,
    provider,
    binding: { ...PREPARED.binding, provider },
  };
}

async function activationAckFromRealProxy(provider: string, operation: ProviderOperationRecord['operation']) {
  const reservation = asReservation('00000000-0000-4000-8000-000000000007');
  const jointContainmentReceipt = asJointContainmentReceipt('containment-receipt');
  const jointActivationReceipt = asJointActivationReceipt('activation-receipt');
  const prepareAttemptKey = 'c'.repeat(64);
  const supervisor = new OperationSupervisor({
    host: {
      start: () => ({
        result: Promise.resolve({
          kind: 'started',
          hostRef: {
            provider,
            fingerprint: 'a'.repeat(64),
            instanceId: 'host-instance-1',
            leaseMode: 'shared',
          },
        }),
        abortAndRelease: async () => undefined,
      }),
      stop: async () => undefined,
    },
    timer: {
      setTimeout: () => ({ unref: () => undefined }),
      clearTimeout: () => undefined,
    },
    mintReservation: () => reservation,
    wallClockNow: () => Date.parse('2026-08-09T12:34:56.000Z'),
    nowMs: () => 100,
    proxyInstanceId: operation.proxyInstanceId,
    buildSetId: operation.buildSetId,
    stageProviderRoot: () => ({
      result: Promise.resolve({
        providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
        receipt: jointContainmentReceipt,
      }),
      confirmActivation: async () => undefined,
      abortAndRelease: async () => undefined,
    }),
    pushProviderEvent: async () => ({ kind: 'ack', committedThroughProviderSeq: 0 }),
  });
  await supervisor.prepare(operation, {
    prepareAttemptNumber: 1,
    prepareAttemptKey,
    prepared: preparedFor(provider),
  });
  const outcome = await supervisor.activate(operation, {
    reservation,
    jointContainmentReceipt,
    jointActivationReceipt,
    activationFingerprint: prepareAttemptKey,
  });
  if (outcome.state !== 'executing') throw new Error('real proxy sender did not produce an activation ACK');
  return outcome;
}

function createHarness(
  overrides: {
    providerName?: string;
    prepareOperation?: DurableProviderProxyOperationAuthority['prepareOperation'];
    inspectOperation?: DurableProviderProxyOperationAuthority['inspectOperation'];
    authorizeOperation?: DurableProviderProxyOperationAuthority['authorizeOperation'];
    activatePreparedOperation?: DurableProviderProxyOperationAuthority['activatePreparedOperation'];
    attachOperation?: DurableProviderProxyOperationAuthority['attachOperation'];
    settleOperation?: DurableProviderProxyOperationAuthority['settleOperation'];
    cancelOperation?: DurableProviderProxyOperationAuthority['cancelOperation'];
    registerSuccessionOperation?: DurableProviderProxyOperationAuthority['registerSuccessionOperation'];
    materializePrepare?: () =>
      | ProviderOperationPrepareMaterializationResult
      | Promise<ProviderOperationPrepareMaterializationResult>;
    stopOperation?: (
      cause: Parameters<ReturnType<DurableProviderProxyOperationAuthority['buildOperationControl']>['stop']>[0],
    ) => Promise<void>;
    beforeCommitOnce?: () => void;
    failCommitOnce?: boolean;
  } = {},
) {
  const providerName = overrides.providerName ?? PREPARED.provider;
  const prepared = preparedFor(providerName);
  const record = providerOperationRecord('prepare-pending') as Extract<
    ProviderOperationRecord,
    { phase: 'prepare-pending' }
  >;
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const appended: unknown[] = [];
  let failCommit = overrides.failCommitOnce === true;
  let beforeCommit = overrides.beforeCommitOnce;
  const commit: JobProgressStore['commit'] = (callback) => {
    const pending: unknown[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const before = beforeCommit;
      beforeCommit = undefined;
      before?.();
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
      provider: providerName,
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
      provider: providerName,
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
    registerSuccessionOperation: overrides.registerSuccessionOperation ?? (async () => undefined),
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
    buildOperationControl: () => ({ stop: overrides.stopOperation ?? (async () => undefined) }),
  };
  const registry = { activate: vi.fn(), attach: vi.fn(), settled: vi.fn(), stop: vi.fn() };
  let now = 100;
  const terminalization = {
    terminalize: (
      terminalRecord: ProviderOperationRecord,
      directive: Parameters<typeof terminalizeProviderOperation>[2],
    ) => terminalizeProviderOperation(progressStore, terminalRecord, directive, now),
  };
  const reconciler = new ProviderOperationReconciler({
    getProgressStore: () => progressStore,
    authorityFor: () => authority,
    registry,
    materializePrepare: overrides.materializePrepare ?? (() => ({ kind: 'prepared', prepared })),
    terminalization,
    backendNamespace: 'tests',
    time: {
      now: () => now,
      setTimeout: () => ({ unref: () => undefined }),
      clearTimeout: () => undefined,
    },
  });
  const begin = (signal = new AbortController().signal) => {
    const attempt = providerOperationPrepareAttempt(authority, record.operation, prepared, record.prepareAttemptNumber);
    return reconciler.begin({
      record: { ...record, prepareAttemptKey: attempt.prepareAttemptKey },
      attempt,
      authority,
      signal,
    });
  };

  return {
    record,
    db,
    appended,
    progressStore,
    authority,
    registry,
    terminalization,
    reconciler,
    phasesBeforeMutation,
    begin,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ProviderOperationReconciler publication', () => {
  it.each([128, 129])(
    'persists the real proxy activation sender provider at registry-supported length %i',
    async (providerLength) => {
      const provider = 'p'.repeat(providerLength);
      const harness = createHarness({
        providerName: provider,
        activatePreparedOperation: (operation) => activationAckFromRealProxy(provider, operation),
      });

      const publication = harness.begin();
      await vi.waitFor(() => {
        const durable = readProviderOperation(harness.db, harness.record.operation);
        expect(
          durable?.phase,
          `${providerLength}-character activation ACK provider was rejected: ${durable?.lastError?.message ?? 'no durable error'}`,
        ).toBe('executing');
      });
      await expect(publication).resolves.toEqual({ kind: 'remote-executing' });

      expect(readProviderOperation(harness.db, harness.record.operation)).toMatchObject({
        phase: 'executing',
        activationAck: { hostRef: { provider } },
      });
    },
  );

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

  it('honors the recorded abort intent at every publication cut before registry registration', async () => {
    const cuts = [
      'before-prepare',
      'after-prepare',
      'before-activation',
      'after-ack',
      'before-commit',
      'after-attach',
    ] as const;

    for (const cut of cuts) {
      const controller = new AbortController();
      const stopOperation = vi.fn(async () => undefined);
      let activationCalls = 0;
      const assertAbortedDirective = (): void => {
        const current = readProviderOperation(harness.db, harness.record.operation);
        if (current?.phase === 'activation-resolution-pending') {
          expect(current.onNeverStarted, cut).toMatchObject({
            kind: 'terminal-aborted',
            cause: 'signal_abort',
          });
          return;
        }
        if (current?.phase === 'prestart-cleanup-pending') {
          expect(current.afterRelease, cut).toMatchObject({
            kind: 'terminal-aborted',
            cause: 'signal_abort',
          });
          return;
        }
        if (current?.phase === 'executing') {
          expect(current.controlIntent, cut).toMatchObject({ kind: 'stop', cause: 'signal_abort' });
          return;
        }
        throw new Error(`${cut} did not persist an abort directive`);
      };

      const harness = createHarness({
        prepareOperation: async () => {
          if (cut === 'after-prepare') {
            controller.abort();
            assertAbortedDirective();
          }
          return {
            state: 'pending-activation',
            reservation: asReservation('00000000-0000-4000-8000-000000000007'),
            leaseExpiresInMs: 15_000,
            providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
            jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
          };
        },
        inspectOperation: async () =>
          cut === 'after-ack' || cut === 'before-commit'
            ? { ...activationAck, state: 'started-awaiting-publication' }
            : { state: 'absent' },
        activatePreparedOperation: async () => {
          activationCalls += 1;
          if (cut === 'before-activation' || (cut === 'after-ack' && activationCalls === 1)) {
            controller.abort();
            assertAbortedDirective();
          }
          return cut === 'before-activation'
            ? {
                state: 'released-never-started',
                operation: harness.record.operation,
                prepareAttemptNumber: harness.record.prepareAttemptNumber,
                prepareAttemptKey: harness.record.prepareAttemptKey,
              }
            : activationAck;
        },
        attachOperation: async (_operation, committedThroughProviderSeq) => {
          if (cut === 'after-attach') {
            controller.abort();
            assertAbortedDirective();
          }
          return { state: 'attached', replayFromProviderSeq: committedThroughProviderSeq + 1 };
        },
        beforeCommitOnce:
          cut === 'before-commit'
            ? () => {
                controller.abort();
                assertAbortedDirective();
              }
            : undefined,
        stopOperation,
      });

      if (cut === 'before-prepare') controller.abort();
      const placement = await harness.begin(controller.signal);

      if (cut === 'before-prepare' || cut === 'after-prepare' || cut === 'before-activation') {
        expect(placement, cut).toEqual({ kind: 'terminalized' });
        expect(readProviderOperation(harness.db, harness.record.operation), cut).toBeNull();
        expect(harness.appended, cut).toEqual([
          expect.objectContaining({
            type: 'job.terminal.recorded',
            body: expect.objectContaining({
              terminal: expect.objectContaining({ outcome: { kind: 'aborted', reason: 'signal_abort' } }),
            }),
          }),
        ]);
        expect(stopOperation, cut).not.toHaveBeenCalled();
        continue;
      }

      expect(placement, cut).toEqual({ kind: 'remote-executing' });
      expect(readProviderOperation(harness.db, harness.record.operation), cut).toMatchObject({
        phase: 'executing',
        controlIntent: { kind: 'stop', cause: 'signal_abort' },
      });
      expect(stopOperation, cut).toHaveBeenCalledWith('signal_abort');
    }
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
    expect(harness.registry.attach).not.toHaveBeenCalled();

    harness.reconciler.onControlEstablished(harness.authority);

    await vi.waitFor(() => expect(attachCalls).toBe(2));
    expect(harness.registry.attach).toHaveBeenCalledOnce();
    expect(readProviderOperation(harness.db, recovered.operation)?.phase).toBe('executing');
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

    await harness.reconciler.reconcileAtStartup(new AbortController().signal);

    expect(stopOperation).toHaveBeenCalledOnce();
    expect(stopOperation).toHaveBeenCalledWith('user_abort');
    expect(harness.registry.attach).toHaveBeenCalledOnce();
    expect(readProviderOperation(harness.db, recovered.operation)).toMatchObject({
      phase: 'executing',
      controlIntent: recovered.controlIntent,
    });
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

    await expect(publication).resolves.toEqual({ kind: 'terminalized' });
    expect(readProviderOperation(harness.db, harness.record.operation)).toBeNull();
    expect(harness.registry.activate).not.toHaveBeenCalled();
    expect(harness.appended).toContainEqual(
      expect.objectContaining({
        type: 'job.progress.emitted',
        body: expect.objectContaining({ detail: expect.objectContaining({ code: 'provider_lost' }) }),
      }),
    );
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

  it('recreates a coordinator after the succession-register/prepare cut using only SQLite, capsule, and proxy state', async () => {
    const harness = createHarness();
    const recovered = harness.record;
    insertProviderOperation(harness.db, recovered);

    const capsule: HandoffCapsule = {
      version: 1,
      grantId: '99999999-9999-4999-8999-999999999999',
      secret: 'd'.repeat(64),
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: recovered.operation.buildSetId,
      hostFingerprint: recovered.locator.hostFingerprint,
      guardianInstanceId: recovered.locator.guardian.instanceId,
      reaperInstanceId: recovered.locator.reaper.instanceId,
      proxyInstanceId: recovered.operation.proxyInstanceId,
      guardianControlEndpoint: recovered.locator.guardian.controlEndpoint,
      reaperControlEndpoint: recovered.locator.reaper.controlEndpoint,
      proxyEndpoint: recovered.locator.proxy.controlEndpoint,
      orphanTimeoutMs: 30_000,
      teardownReserveMs: 14_000,
    };
    const modeledProxyState = createGrantRegistry(() => 'recovery-receipt');
    modeledProxyState.install({
      grantId: capsule.grantId,
      secretSha256: handoffSecretDigest(capsule.secret),
      generation: capsule.generation,
      flavor: capsule.flavor,
      buildSetId: capsule.buildSetId,
      hostFingerprint: capsule.hostFingerprint,
      guardianInstanceId: capsule.guardianInstanceId,
      reaperInstanceId: capsule.reaperInstanceId,
      proxyInstanceId: capsule.proxyInstanceId,
      operations: [],
      orphanTimeoutMs: capsule.orphanTimeoutMs,
    });

    // This is the only remote effect left by the dead coordinator: the full tuple landed, then its
    // transport vanished before prepare. No authority or promise from that coordinator crosses the cut.
    modeledProxyState.register(recovered.operation);

    const successorCalls: string[] = [];
    const successorAuthority: DurableProviderProxyOperationAuthority = {
      ...harness.authority,
      registerSuccessionOperation: async (operation) => {
        successorCalls.push('register');
        modeledProxyState.register(operation);
      },
      prepareOperation: async (attempt) => {
        successorCalls.push('prepare');
        expect(modeledProxyState.redemption()?.grant.operations).toContainEqual(recovered.operation);
        return harness.authority.prepareOperation(attempt);
      },
    };
    const acquireAuthority = vi.fn(async () => {
      modeledProxyState.redeem({
        grantId: capsule.grantId,
        secret: capsule.secret,
        successorInstanceId: '88888888-8888-4888-8888-888888888888',
        binding: {
          generation: capsule.generation,
          flavor: capsule.flavor,
          buildSetId: capsule.buildSetId,
          hostFingerprint: capsule.hostFingerprint,
          guardianInstanceId: capsule.guardianInstanceId,
          reaperInstanceId: capsule.reaperInstanceId,
          proxyInstanceId: capsule.proxyInstanceId,
        },
      });
      return successorAuthority;
    });
    const recreated = new ProviderOperationReconciler({
      getProgressStore: () => harness.progressStore,
      authorityFor: () => null,
      acquireAuthority,
      registry: harness.registry,
      materializePrepare: () => MATERIALIZED_PREPARED,
      terminalization: harness.terminalization,
      backendNamespace: 'tests',
      time: {
        now: () => 100,
        setTimeout: () => ({ unref: () => undefined }),
        clearTimeout: () => undefined,
      },
    });

    await recreated.reconcileAtStartup(new AbortController().signal);

    expect(acquireAuthority).toHaveBeenCalledOnce();
    expect(successorCalls).toEqual(['register', 'prepare']);
    expect(readProviderOperation(harness.db, recovered.operation)?.phase).toBe('executing');
    expect(harness.registry.attach).toHaveBeenCalledOnce();
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
      materializePrepare: () => MATERIALIZED_PREPARED,
      terminalization: harness.terminalization,
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
    const registry = { activate: vi.fn(), attach: vi.fn(), settled: vi.fn(), stop: vi.fn() };
    const reconciler = new ProviderOperationReconciler({
      getProgressStore: () => harness.progressStore,
      authorityFor: () => null,
      acquireAuthority,
      registry,
      materializePrepare: () => MATERIALIZED_PREPARED,
      terminalization: harness.terminalization,
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
    const materializePrepare = vi.fn(() => MATERIALIZED_PREPARED);
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
    const materializePrepare = vi.fn(() => MATERIALIZED_PREPARED);
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

  it('releases and terminalizes an expired recovered authorization instead of retrying it', async () => {
    const prepareOperation = vi.fn();
    const cancelOperation = vi.fn(async (operation, prepareAttemptNumber, prepareAttemptKey) => ({
      state: 'released-never-started' as const,
      operation,
      prepareAttemptNumber,
      prepareAttemptKey,
    }));
    const harness = createHarness({
      prepareOperation,
      inspectOperation: async () => ({ state: 'absent' }),
      cancelOperation,
      materializePrepare: async () => ({
        kind: 'permanent-refusal',
        code: 'authorization_expired',
        reason: 'Provider operation child authorization has expired.',
      }),
    });
    insertProviderOperation(harness.db, harness.record);

    await harness.reconciler.reconcile(harness.record, harness.authority);

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
    expect(harness.registry.attach).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), {
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
    const { controlIntent: _controlIntent, ...settlementRecord } = executing;
    const settlement = providerOperationRecordSchema.parse({
      ...settlementRecord,
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

  it('takes the phase-specific exit after exact containment disappearance', async () => {
    const terminalCleanup = providerOperationRecordSchema.parse({
      ...providerOperationRecord('prestart-cleanup-pending'),
      afterRelease: {
        kind: 'terminal-failed',
        code: 'authorization_expired',
        reason: 'The durable authorization expired before recovery.',
      },
    });
    const cases = [
      { record: providerOperationRecord('prepare-pending'), failureCode: null },
      { record: providerOperationRecord('guardian-activation-pending'), failureCode: null },
      { record: providerOperationRecord('prestart-cleanup-pending'), failureCode: null },
      { record: terminalCleanup, failureCode: 'authorization_expired' },
      { record: providerOperationRecord('proxy-activation-pending'), failureCode: 'activation_indeterminate' },
      { record: providerOperationRecord('activation-resolution-pending'), failureCode: 'activation_indeterminate' },
      { record: providerOperationRecord('executing'), failureCode: 'provider_lost' },
      { record: providerOperationRecord('settlement-pending'), failureCode: null },
    ] as const;

    for (const { record, failureCode } of cases) {
      const harness = createHarness();
      insertProviderOperation(harness.db, record);
      const acquireAuthority = vi.fn(async () => ({
        kind: 'containment-disappeared' as const,
        disappearanceReceipt: 'group:101,leader:101@1000,root:104@1003',
      }));
      const reconciler = new ProviderOperationReconciler({
        getProgressStore: () => harness.progressStore,
        authorityFor: () => null,
        acquireAuthority,
        registry: harness.registry,
        materializePrepare: () => MATERIALIZED_PREPARED,
        terminalization: harness.terminalization,
        backendNamespace: 'tests',
        time: {
          now: () => 100,
          setTimeout: () => ({ unref: () => undefined }),
          clearTimeout: () => undefined,
        },
      });

      await reconciler.reconcileAtStartup(new AbortController().signal);

      expect(acquireAuthority, record.phase).toHaveBeenCalledWith(record, expect.any(AbortSignal));
      expect(readProviderOperation(harness.db, record.operation), record.phase).toBeNull();
      const failureCodes = harness.appended
        .filter((event) => (event as { type?: string }).type === 'job.progress.emitted')
        .map((event) => (event as { body: { detail?: { code?: string } } }).body.detail?.code);
      expect(failureCodes, record.phase).toEqual(failureCode === null ? [] : [failureCode]);
      expect(harness.registry.activate, record.phase).not.toHaveBeenCalled();
      expect(harness.registry.attach, record.phase).not.toHaveBeenCalled();
    }
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

type FaultScenario = Readonly<{
  label: string;
  boundary: FaultBoundary;
  afterSendEffect: 'applied' | 'not-applied';
}>;

const FAULT_SCENARIOS: readonly FaultScenario[] = FAULT_BOUNDARIES.flatMap<FaultScenario>((boundary) =>
  boundary === 'after-send'
    ? [
        { label: `${boundary}/remote-effect-not-applied`, boundary, afterSendEffect: 'not-applied' },
        { label: `${boundary}/remote-effect-applied`, boundary, afterSendEffect: 'applied' },
      ]
    : [{ label: boundary, boundary, afterSendEffect: 'not-applied' }],
);

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
  scenario: FaultScenario,
  observe: (point: FaultBoundary) => void,
  applyRemoteEffect: () => void,
  reply: () => T,
): Promise<T> {
  const { boundary } = scenario;
  observe('before-send');
  if (boundary === 'before-send') throw injectedTransportError(boundary);
  observe('after-send');
  if (boundary === 'after-send') {
    if (scenario.afterSendEffect === 'applied') applyRemoteEffect();
    throw injectedTransportError(boundary);
  }
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
  fault: string,
): void {
  const record = readProviderOperation(harness.db, harness.record.operation);
  const remoteStateExists =
    state.prepared ||
    state.guardianAuthorized ||
    state.ledgerPresent ||
    state.guardianMembershipPresent ||
    state.terminalAwaitingSettlement;
  if (remoteStateExists) {
    expect(record, `${stage}/${fault}: remote state lost its durable name`).not.toBeNull();
  }
  expect(state.kernelStarts, `${stage}/${fault}: kernel started more than once`).toBeLessThanOrEqual(1);
  if (record?.phase === 'executing' || harness.registry.activate.mock.calls.length > 0) {
    expect(state.kernelStarts, `${stage}/${fault}: execution was published without a kernel`).toBe(1);
  }
  if (record === null) {
    expect(remoteStateExists, `${stage}/${fault}: unnamed remote state survived`).toBe(false);
  }
}

async function driveCurrentRecord(harness: ReturnType<typeof createHarness>): Promise<ProviderOperationRecord | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = readProviderOperation(harness.db, harness.record.operation);
    if (
      current === null ||
      (current.phase === 'executing' &&
        (harness.registry.activate.mock.calls.length > 0 || harness.registry.attach.mock.calls.length > 0))
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
  it.each(FAULT_SCENARIOS)('preserves publication invariants at prepare/$label', async (scenario) => {
    const { boundary } = scenario;
    const fault = scenario.label;
    const state: RemoteOperationState = {
      prepared: false,
      guardianAuthorized: false,
      kernelStarts: 0,
      ledgerPresent: false,
      guardianMembershipPresent: false,
      terminalAwaitingSettlement: false,
    };
    let faulted = false;
    let prepareCalls = 0;
    let prepareEffects = 0;
    const applyPrepare = (): void => {
      prepareEffects += 1;
      state.prepared = true;
      state.guardianMembershipPresent = true;
    };
    const harness = createHarness({
      prepareOperation: async () => {
        prepareCalls += 1;
        if (!faulted && !boundary.includes('sqlite')) {
          faulted = true;
          return callAcrossFaultBoundary(scenario, observe, applyPrepare, () => ({
            state: 'pending-activation' as const,
            reservation: asReservation('00000000-0000-4000-8000-000000000007'),
            leaseExpiresInMs: 15_000,
            providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
            jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
          }));
        }
        if (!state.prepared) applyPrepare();
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
      expect(record?.phase, `prepare/${fault} at ${point}`).toBe('prepare-pending');
    };
    const restoreCommitFault = boundary.includes('sqlite')
      ? installSqliteCommitFault(
          harness,
          boundary as 'before-sqlite-commit' | 'after-sqlite-commit',
          'guardian-activation-pending',
        )
      : () => undefined;
    const publication = harness.begin();
    await vi.waitFor(() => {
      if (boundary.includes('sqlite')) {
        expect(readProviderOperation(harness.db, harness.record.operation)?.revision ?? 0).toBeGreaterThan(0);
      } else {
        expect(faulted).toBe(true);
      }
    });
    restoreCommitFault();
    if (boundary === 'after-send') {
      const effectWasApplied = scenario.afterSendEffect === 'applied';
      expect(state.prepared, `prepare/${fault}: remote state did not distinguish the lost send`).toBe(effectWasApplied);
      expect(prepareEffects, `prepare/${fault}: unexpected prepare effect before recovery`).toBe(
        effectWasApplied ? 1 : 0,
      );
    }
    expectFaultInvariant(harness, state, 'prepare', fault);
    const final = await driveCurrentRecord(harness);
    const placement = await publication;
    expect(final?.phase, `prepare/${fault}: publication did not settle`).toBe('executing');
    expect(placement).toEqual({ kind: 'remote-executing' });
    if (boundary === 'after-send') {
      expect(prepareCalls, `prepare/${fault}: prepared inspection retried the remote prepare`).toBe(
        scenario.afterSendEffect === 'applied' ? 1 : 2,
      );
      expect(prepareEffects, `prepare/${fault}: remote prepare effect was not applied exactly once`).toBe(1);
    }
    expectFaultInvariant(harness, state, 'prepare', fault);
  });

  it.each(FAULT_SCENARIOS)('preserves publication invariants at guardian-activation/$label', async (scenario) => {
    const { boundary } = scenario;
    const fault = scenario.label;
    const state: RemoteOperationState = {
      prepared: true,
      guardianAuthorized: false,
      kernelStarts: 0,
      ledgerPresent: false,
      guardianMembershipPresent: true,
      terminalAwaitingSettlement: false,
    };
    let faulted = false;
    let authorizationCalls = 0;
    let authorizationEffects = 0;
    const applyAuthorization = (): void => {
      authorizationEffects += 1;
      state.guardianAuthorized = true;
    };
    const harness = createHarness({
      authorizeOperation: async () => {
        authorizationCalls += 1;
        const observe = (point: FaultBoundary): void => {
          const current = readProviderOperation(harness.db, harness.record.operation);
          expect(current?.phase, `guardian activation/${fault} at ${point}`).toBe('guardian-activation-pending');
        };
        if (!faulted && !boundary.includes('sqlite')) {
          faulted = true;
          return callAcrossFaultBoundary(scenario, observe, applyAuthorization, () => ({
            state: 'activation-authorized' as const,
            jointActivationReceipt: asJointActivationReceipt('activation-receipt'),
          }));
        }
        if (!state.guardianAuthorized) applyAuthorization();
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
    if (boundary === 'after-send') {
      const effectWasApplied = scenario.afterSendEffect === 'applied';
      expect(
        state.guardianAuthorized,
        `guardian activation/${fault}: remote state did not distinguish the lost send`,
      ).toBe(effectWasApplied);
      expect(
        authorizationEffects,
        `guardian activation/${fault}: unexpected authorization effect before recovery`,
      ).toBe(effectWasApplied ? 1 : 0);
    }
    expectFaultInvariant(harness, state, 'guardian activation', fault);
    const final = await driveCurrentRecord(harness);
    expect(['executing', undefined], `guardian activation/${fault}: unsafe terminal phase`).toContain(final?.phase);
    if (boundary === 'after-send') {
      expect(authorizationCalls, `guardian activation/${fault}: authorization recovery call count`).toBe(2);
      expect(
        authorizationEffects,
        `guardian activation/${fault}: remote authorization effect was applied more than once`,
      ).toBe(1);
    }
    expectFaultInvariant(harness, state, 'guardian activation', fault);
  });

  it.each(FAULT_SCENARIOS)('preserves publication invariants at proxy-activation/$label', async (scenario) => {
    const { boundary } = scenario;
    const fault = scenario.label;
    const state: RemoteOperationState = {
      prepared: true,
      guardianAuthorized: true,
      kernelStarts: 0,
      ledgerPresent: false,
      guardianMembershipPresent: true,
      terminalAwaitingSettlement: false,
    };
    let faulted = false;
    let activationCalls = 0;
    const startKernel = (): void => {
      state.kernelStarts += 1;
      state.ledgerPresent = true;
    };
    const harness = createHarness({
      activatePreparedOperation: async () => {
        activationCalls += 1;
        const observe = (point: FaultBoundary): void => {
          const current = readProviderOperation(harness.db, harness.record.operation);
          expect(current?.phase, `proxy activation/${fault} at ${point}`).toBe('proxy-activation-pending');
        };
        if (!faulted && !boundary.includes('sqlite')) {
          faulted = true;
          return callAcrossFaultBoundary(scenario, observe, startKernel, () => activationAck);
        }
        if (!state.ledgerPresent) startKernel();
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
    if (boundary === 'after-send') {
      const effectWasApplied = scenario.afterSendEffect === 'applied';
      expect(state.ledgerPresent, `proxy activation/${fault}: remote state did not distinguish the lost send`).toBe(
        effectWasApplied,
      );
      expect(state.kernelStarts, `proxy activation/${fault}: unexpected kernel start before recovery`).toBe(
        effectWasApplied ? 1 : 0,
      );
    }
    expectFaultInvariant(harness, state, 'proxy activation', fault);
    const final = await driveCurrentRecord(harness);
    expect(final?.phase, `proxy activation/${fault}: activation did not settle`).toBe('executing');
    if (boundary === 'after-send') {
      expect(activationCalls, `proxy activation/${fault}: activation recovery call count`).toBe(2);
      expect(state.kernelStarts, `proxy activation/${fault}: remote activation effect was applied more than once`).toBe(
        1,
      );
    }
    expectFaultInvariant(harness, state, 'proxy activation', fault);
  });

  it.each(FAULT_SCENARIOS)('preserves settlement invariants at settlement/$label', async (scenario) => {
    const { boundary } = scenario;
    const fault = scenario.label;
    const state = { ...startedRemoteState(), terminalAwaitingSettlement: true };
    let faulted = false;
    let settlementCalls = 0;
    let settlementEffects = 0;
    const harness = createHarness({
      settleOperation: async (_operation, finalProviderSeq) => {
        settlementCalls += 1;
        const observe = (point: FaultBoundary): void => {
          const current = readProviderOperation(harness.db, harness.record.operation);
          expect(current?.phase, `settlement/${fault} at ${point}`).toBe('settlement-pending');
        };
        const release = (): void => {
          settlementEffects += 1;
          state.ledgerPresent = false;
          state.guardianMembershipPresent = false;
          state.terminalAwaitingSettlement = false;
        };
        if (!faulted && !boundary.includes('sqlite')) {
          faulted = true;
          return callAcrossFaultBoundary(scenario, observe, release, () => ({
            state: 'released-after-terminal' as const,
            settledThroughProviderSeq: finalProviderSeq,
          }));
        }
        if (state.terminalAwaitingSettlement) release();
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
    if (boundary === 'after-send') {
      const effectWasApplied = scenario.afterSendEffect === 'applied';
      expect(
        readProviderOperation(harness.db, harness.record.operation)?.phase,
        `settlement/${fault}: ambiguous release lost durable intent`,
      ).toBe('settlement-pending');
      expect(
        state.terminalAwaitingSettlement,
        `settlement/${fault}: remote state did not distinguish the lost send`,
      ).toBe(!effectWasApplied);
      expect(settlementEffects, `settlement/${fault}: unexpected settlement effect before recovery`).toBe(
        effectWasApplied ? 1 : 0,
      );
    }
    expectFaultInvariant(harness, state, 'settlement', fault);
    const final = await driveCurrentRecord(harness);
    expect(final, `settlement/${fault}: tombstone survived confirmed release`).toBeNull();
    if (boundary === 'after-send') {
      expect(settlementCalls, `settlement/${fault}: settlement recovery call count`).toBe(2);
      expect(settlementEffects, `settlement/${fault}: remote settlement effect was applied more than once`).toBe(1);
    }
    expectFaultInvariant(harness, state, 'settlement', fault);
  });

  it.each(FAULT_SCENARIOS)('preserves prestart-release invariants at release/$label', async (scenario) => {
    const { boundary } = scenario;
    const fault = scenario.label;
    const state: RemoteOperationState = {
      prepared: true,
      guardianAuthorized: false,
      kernelStarts: 0,
      ledgerPresent: false,
      guardianMembershipPresent: true,
      terminalAwaitingSettlement: false,
    };
    let faulted = false;
    let releaseCalls = 0;
    let releaseEffects = 0;
    const harness = createHarness({
      cancelOperation: async (operation, prepareAttemptNumber, prepareAttemptKey) => {
        releaseCalls += 1;
        const observe = (point: FaultBoundary): void => {
          const current = readProviderOperation(harness.db, harness.record.operation);
          expect(current?.phase, `release/${fault} at ${point}`).toBe('prestart-cleanup-pending');
        };
        const release = (): void => {
          releaseEffects += 1;
          state.prepared = false;
          state.guardianAuthorized = false;
          state.guardianMembershipPresent = false;
        };
        if (!faulted && !boundary.includes('sqlite')) {
          faulted = true;
          return callAcrossFaultBoundary(scenario, observe, release, () => ({
            state: 'released-never-started' as const,
            operation,
            prepareAttemptNumber,
            prepareAttemptKey,
          }));
        }
        if (state.prepared || state.guardianMembershipPresent) release();
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
    if (boundary === 'after-send') {
      const effectWasApplied = scenario.afterSendEffect === 'applied';
      expect(
        readProviderOperation(harness.db, harness.record.operation)?.phase,
        `release/${fault}: ambiguous release lost durable intent`,
      ).toBe('prestart-cleanup-pending');
      expect(state.prepared, `release/${fault}: remote state did not distinguish the lost send`).toBe(
        !effectWasApplied,
      );
      expect(releaseEffects, `release/${fault}: unexpected prestart release effect before recovery`).toBe(
        effectWasApplied ? 1 : 0,
      );
    }
    expectFaultInvariant(harness, state, 'release', fault);
    const final = await driveCurrentRecord(harness);
    expect(final, `release/${fault}: cleanup row survived confirmed release`).toBeNull();
    if (boundary === 'after-send') {
      expect(releaseCalls, `release/${fault}: prestart release recovery call count`).toBe(2);
      expect(releaseEffects, `release/${fault}: remote prestart release effect was applied more than once`).toBe(1);
    }
    expectFaultInvariant(harness, state, 'release', fault);
  });
});
