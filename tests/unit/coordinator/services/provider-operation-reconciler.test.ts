import { describe, expect, it, vi } from 'vitest';

import type { JobProgressStore } from '#src/jobs/contracts/job-store.js';
import type { TimePort } from '#src/infra/port-types.js';
import type { ProviderProxyRecoveryProducerPorts } from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { providerOperationPrepareAttempt } from '#src/coordinator/services/provider-proxy-operation-activation.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set-identity.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set-claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set-lifecycle.js';
import type { ProviderProxyAuthorityFault } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import type { ProviderOperationPrepareMaterializationResult } from '#src/coordinator/services/provider-operation-prepare.js';
import type { ProviderOperationRecoveryAcceptance } from '#src/coordinator/services/recovery/index.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import {
  ProviderOperationReconciler,
  providerOperationTerminationVerdict,
  type ProviderOperationReconciliationEvidence,
} from '#src/coordinator/services/provider-operation-reconciler.js';
import type { ProviderOperationReconcilerFatalError } from '#src/coordinator/services/provider-operation-reconciler.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import {
  compareAndSwapProviderOperation,
  insertProviderOperation,
  readProviderOperation,
  readProviderOperationDueSelections,
  readProviderOperationsDue,
  subscribeProviderOperationMutations,
} from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { OperationSupervisor } from '#src/provider-proxy/operation-supervisor.js';
import { proxyOperationAttachResultSchema } from '#src/provider-proxy/protocol.js';
import { createGrantRegistry, handoffSecretDigest, type HandoffCapsule } from '#src/provider-proxy/handoff-capsule.js';
import {
  ProviderOperationAtomicTerminalizationError,
  ProviderOperationTerminalMetadataError,
  terminalizeProviderOperation,
  type ProviderOperationTerminalizationPort,
} from '#src/jobs/provider-operation-terminalization.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import {
  asJointActivationReceipt,
  asJointContainmentReceipt,
  asReservation,
} from '#tests/helpers/provider-proxy-correlation.js';

function proxyHeartbeatFault(error: unknown): ProviderProxyAuthorityFault {
  return { kind: 'heartbeat-failed', role: 'proxy', method: 'control.heartbeat.v1', error };
}

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
      [providerOperationRecord('prepare-pending'), { kind: 'unresolved' }, 'pending'],
    ] satisfies ReadonlyArray<readonly [ProviderOperationRecord, ProviderOperationReconciliationEvidence, string]>;

    for (const [record, evidence, expected] of cases) {
      expect(providerOperationTerminationVerdict(record, evidence).kind).toBe(expected);
    }
  });
});

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
  const lifecycle = new ProviderProxySetLifecycle({
    claims,
    controlEstablished: () => undefined,
    time: {
      now: () => 100,
      setTimeout: () => ({ unref: () => undefined }),
      clearTimeout: () => undefined,
    },
    recoveryDispatcher: createTestProviderProxyRecoveryDispatcher(
      {
        'containment-proof': async () => null,
        'disappearance-consumer': ({ notice }) => reconciler.containmentDisappeared(notice),
      },
      (error) => {
        throw error;
      },
    ),
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  lifecycle.registerInheritedSet(authority);
  return lifecycle;
}

describe('provider proxy exactly-once containment schedules', () => {
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
    cwd: fixtureCanonicalWorkDir('/workspace'),
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

function operationUuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function legacyDueKey(record: ProviderOperationRecord): string {
  const fixed = (value: number): string => String(value).padStart(String(Number.MAX_SAFE_INTEGER).length, '0');
  return (
    `provider_operation_saga.v1:due:${fixed(record.retryNotBeforeMs)}:` +
    `${record.operation.jobId}:${record.operation.operationId}:${record.operation.proxyInstanceId}:` +
    `${record.operation.buildSetId}:${fixed(record.revision)}`
  );
}

function canonicalOperationKey(record: ProviderOperationRecord): string {
  return (
    `provider_operation_saga.v1:record:${record.operation.jobId}:${record.operation.operationId}:` +
    `${record.operation.proxyInstanceId}:${record.operation.buildSetId}`
  );
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function providerRecoveryAccepted(jobId: string): ProviderOperationRecoveryAcceptance {
  return { state: 'accepted', jobId, owner: 'recovery-coordinator' };
}

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
        state: 'staged',
        providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
        receipt: jointContainmentReceipt,
      }),
      confirmActivation: async () => undefined,
      abortAndRelease: async () => undefined,
    }),
    pushProviderEvent: () => ({
      controlEpoch: 1,
      response: Promise.resolve({ kind: 'ack', committedThroughProviderSeq: 0 }),
    }),
    faultProviderEventControl: () => undefined,
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
    recoverLocalJob?: (
      record: Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }>,
      signal: AbortSignal,
    ) => Promise<ProviderOperationRecoveryAcceptance>;
    completeLocalRecovery?: (jobId: string) => void;
    authorityFor?: (record: ProviderOperationRecord) => DurableProviderProxyOperationAuthority | null;
    acquireAuthority?: (
      record: ProviderOperationRecord,
      signal: AbortSignal,
    ) => Promise<DurableProviderProxyOperationAuthority | null>;
    stopOperation?: (
      cause: Parameters<ReturnType<DurableProviderProxyOperationAuthority['buildOperationControl']>['stop']>[0],
    ) => Promise<void>;
    terminalize?: ProviderOperationTerminalizationPort['terminalize'];
    disappearanceTerminalization?: ProviderProxyRecoveryProducerPorts['disappearance-terminalization'];
    time?: Pick<TimePort, 'setTimeout' | 'clearTimeout'>;
    onError?: (message: string) => void;
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
      projectRoot: fixtureCanonicalWorkDir('/workspace'),
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
      projectRoot: fixtureCanonicalWorkDir('/workspace'),
      backendNamespace: 'tests',
      pool: 'curate',
      enqueueSequence: 1,
      createdAt: '2026-08-09T12:34:55.000Z',
      jobKind: 'provider',
      providerAction: 'exec',
      request: {
        prompt: 'do the thing',
        cwd: fixtureCanonicalWorkDir('/workspace'),
        bypassPermissions: false,
        coralEnv: {},
      },
    }),
  };
  const phasesBeforeMutation: string[] = [];
  const readPhase = (): string => readProviderOperation(db, record.operation)?.phase ?? 'missing';
  const authority: DurableProviderProxyOperationAuthority = {
    proxyInstanceId: record.operation.proxyInstanceId,
    faulted: new Promise<never>(() => {}),
    onFault: () => () => undefined,
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
    terminalize:
      overrides.terminalize ??
      ((terminalRecord: ProviderOperationRecord, directive: Parameters<typeof terminalizeProviderOperation>[2]) =>
        terminalizeProviderOperation(progressStore, terminalRecord, directive, now)),
  };
  const fatalErrors: Error[] = [];
  const dispatcherFatalErrors: Error[] = [];
  const reconcilerFatalErrors: Error[] = [];
  const recoveryDispatcher = createTestProviderProxyRecoveryDispatcher(
    {
      'disappearance-terminalization':
        overrides.disappearanceTerminalization ??
        (({ record, directive }) => terminalization.terminalize(record, directive)),
    },
    (error) => {
      dispatcherFatalErrors.push(error);
      fatalErrors.push(error);
    },
  );
  const reconciler = new ProviderOperationReconciler({
    getProgressStore: () => progressStore,
    authorityFor: overrides.authorityFor ?? (() => authority),
    ...(overrides.acquireAuthority === undefined ? {} : { acquireAuthority: overrides.acquireAuthority }),
    startupSetRecovery: {
      recoverSetAtStartup: async () => ({ kind: 'authority', authority }),
    },
    registry,
    materializePrepare: overrides.materializePrepare ?? (() => ({ state: 'prepared', prepared })),
    recoverLocalJob:
      overrides.recoverLocalJob ?? (async (localRecord) => providerRecoveryAccepted(localRecord.operation.jobId)),
    completeLocalRecovery: overrides.completeLocalRecovery ?? (() => undefined),
    terminalization,
    recoveryDispatcher,
    backendNamespace: 'tests',
    onFatal: (error) => {
      reconcilerFatalErrors.push(error);
      fatalErrors.push(error);
    },
    ...(overrides.onError === undefined ? {} : { onError: overrides.onError }),
    time: {
      now: () => now,
      setTimeout: overrides.time?.setTimeout ?? (() => ({ unref: () => undefined })),
      clearTimeout: overrides.time?.clearTimeout ?? (() => undefined),
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
    recoveryDispatcher,
    fatalErrors,
    dispatcherFatalErrors,
    reconcilerFatalErrors,
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

    await vi.waitFor(() => {
      expect(attachCalls).toBe(2);
      expect(harness.registry.attach).toHaveBeenCalledOnce();
    });
    expect(readProviderOperation(harness.db, recovered.operation)?.phase).toBe('executing');
  });

  it('removes successful executing reattachment from durable due work', async () => {
    const attachmentCalls = new Map<string, number>();
    const harness = createHarness({
      attachOperation: async (operation, committedThroughProviderSeq) => {
        attachmentCalls.set(operation.operationId, (attachmentCalls.get(operation.operationId) ?? 0) + 1);
        return { state: 'attached', replayFromProviderSeq: committedThroughProviderSeq + 1 };
      },
    });
    const retryOwned = {
      ...providerOperationRecord('executing', { retryCount: 1, retryNotBeforeMs: 0 }),
      lastError: { observedAtMs: 1, code: 'attach_failed', message: 'retry attachment' },
    } as Extract<ProviderOperationRecord, { phase: 'executing' }>;
    const legacyHealthy = providerOperationRecord('executing', {
      operation: { ...retryOwned.operation, operationId: operationUuid(20) },
    });
    insertProviderOperation(harness.db, retryOwned);
    insertProviderOperation(harness.db, legacyHealthy);
    harness.db
      .prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(legacyDueKey(legacyHealthy), canonicalOperationKey(legacyHealthy));

    for (let poll = 0; poll < 2; poll += 1) {
      for (const due of readProviderOperationsDue(harness.db, 100, 32)) {
        await harness.reconciler.reconcile(due, harness.authority);
      }
    }

    expect({
      attachmentCalls: [
        attachmentCalls.get(retryOwned.operation.operationId),
        attachmentCalls.get(legacyHealthy.operation.operationId),
      ],
      retryOwnership: readProviderOperation(harness.db, retryOwned.operation),
      dueRows: readProviderOperationsDue(harness.db, 100, 32),
    }).toMatchObject({
      attachmentCalls: [1, 1],
      retryOwnership: { retryCount: 0, lastError: null },
      dueRows: [],
    });
  });

  it('drains a full retry-owned page when the pump advances every watermark before attach returns', async () => {
    const journal = { db: null as ReturnType<typeof createHarness>['db'] | null };
    const attachmentCalls = new Map<string, number>();
    const prepareTarget = vi.fn(async () => ({
      state: 'pending-activation' as const,
      reservation: asReservation('00000000-0000-4000-8000-000000000007'),
      leaseExpiresInMs: 15_000,
      providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
      jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
    }));
    const harness = createHarness({
      prepareOperation: prepareTarget,
      attachOperation: async (operation, committedThroughProviderSeq) => {
        attachmentCalls.set(operation.operationId, (attachmentCalls.get(operation.operationId) ?? 0) + 1);
        if (journal.db === null) throw new Error('journal fixture is not initialized');
        const current = readProviderOperation(journal.db, operation);
        if (current?.phase !== 'executing') throw new Error('expected executing attachment row');
        const advanced = { ...current, revision: current.revision + 1, committedThroughProviderSeq: 1 };
        expect(compareAndSwapProviderOperation(journal.db, current, advanced).kind).toBe('updated');
        return { state: 'attached', replayFromProviderSeq: committedThroughProviderSeq + 1 };
      },
    });
    journal.db = harness.db;
    const base = providerOperationRecord('executing');
    const predecessors = Array.from({ length: 32 }, (_, index) => ({
      ...providerOperationRecord('executing', {
        operation: { ...base.operation, operationId: operationUuid(100 + index) },
        retryCount: 1,
        retryNotBeforeMs: 0,
      }),
      lastError: { observedAtMs: 1, code: 'attach_failed', message: 'retry attachment' },
    })) as readonly Extract<ProviderOperationRecord, { phase: 'executing' }>[];
    const target = providerOperationRecord('prepare-pending', {
      operation: { ...base.operation, operationId: operationUuid(999) },
      retryNotBeforeMs: 1,
    });
    for (const record of predecessors) insertProviderOperation(harness.db, record);
    insertProviderOperation(harness.db, target);

    for (let scan = 0; scan < 4; scan += 1) {
      harness.reconciler.wake();
      await nextEventLoopTurn();
    }

    const predecessorAttachmentCalls = predecessors.reduce(
      (total, record) => total + (attachmentCalls.get(record.operation.operationId) ?? 0),
      0,
    );
    expect({
      predecessorAttachmentCalls,
      targetPrepareCalls: prepareTarget.mock.calls.length,
      earlierDueRows: readProviderOperationsDue(harness.db, 100, 32).filter((record) =>
        predecessors.some((predecessor) => predecessor.operation.operationId === record.operation.operationId),
      ).length,
    }).toEqual({ predecessorAttachmentCalls: 32, targetPrepareCalls: 1, earlierDueRows: 0 });
  });

  it('finishes every selected disappearance-owned due turn', async () => {
    const rejectTerminalization: Array<() => void> = [];
    let targetRecoveries = 0;
    const harness = createHarness({
      disappearanceTerminalization: ({ record }) =>
        new Promise((_, reject) => {
          rejectTerminalization.push(() =>
            reject(
              new ProviderOperationAtomicTerminalizationError(
                record.operation,
                new Error('held-disappearance-terminalization'),
              ),
            ),
          );
        }),
      recoverLocalJob: async (record) => {
        targetRecoveries += 1;
        return providerRecoveryAccepted(record.operation.jobId);
      },
    });
    const base = providerOperationRecord('executing');
    const predecessors = Array.from({ length: 32 }, (_, index) => ({
      ...providerOperationRecord('executing', {
        operation: { ...base.operation, operationId: operationUuid(300 + index) },
        retryCount: 1,
        retryNotBeforeMs: 0,
      }),
      lastError: { observedAtMs: 1, code: 'attach_failed', message: 'retry attachment' },
    })) as readonly Extract<ProviderOperationRecord, { phase: 'executing' }>[];
    const target = providerOperationRecord('local-recovery-pending', {
      operation: { ...base.operation, operationId: operationUuid(999) },
      retryNotBeforeMs: 1,
    });
    for (const record of predecessors) insertProviderOperation(harness.db, record);
    insertProviderOperation(harness.db, target);

    const deliveries = predecessors.map((record) =>
      harness.reconciler.containmentDisappeared({
        operation: record.operation,
        setIdentity: providerProxySetIdentityFromRecord(record),
        disappearanceReceipt: `selected-ready-${record.operation.operationId}`,
      }),
    );
    const yielded: ProviderOperationRecord[] = [];
    const unsubscribe = subscribeProviderOperationMutations(harness.db, (mutation) => {
      if (
        mutation.kind === 'upserted' &&
        predecessors.some(
          (predecessor) => predecessor.operation.operationId === mutation.record.operation.operationId,
        ) &&
        mutation.record.retryNotBeforeMs === 125
      ) {
        yielded.push(mutation.record);
      }
    });

    harness.reconciler.wake();
    await nextEventLoopTurn();
    expect(rejectTerminalization).toHaveLength(32);
    expect(targetRecoveries).toBe(0);
    for (const reject of rejectTerminalization) reject();
    await Promise.all(deliveries);
    await nextEventLoopTurn();
    expect.soft(yielded).toHaveLength(32);

    for (let scan = 1; scan < 4; scan += 1) {
      harness.reconciler.wake();
      await nextEventLoopTurn();
    }
    expect(targetRecoveries).toBe(1);
    await vi.waitFor(() => expect(readProviderOperation(harness.db, target.operation)).toBeNull());
    harness.advance(26);
    const replacements = readProviderOperationDueSelections(harness.db, 126, 32);
    unsubscribe();

    expect(replacements).toHaveLength(32);
    for (const replacement of replacements) {
      const canonical = readProviderOperation(harness.db, replacement.record.operation);
      expect(replacement.record).toEqual(canonical);
      expect(replacement.record).toMatchObject({ revision: 1, retryNotBeforeMs: 125 });
    }
    expect(harness.fatalErrors).toEqual([]);
  });

  it('stops the active due page on an already-dispatched lifecycle fatal', async () => {
    type ControlledTimer = ReturnType<TimePort['setTimeout']>;
    const timers = new Set<ControlledTimer>();
    const warnings: string[] = [];
    let rejectTerminalization!: (error: Error) => void;
    let laterLocalRecoveryCalls = 0;
    const harness = createHarness({
      disappearanceTerminalization: () =>
        new Promise((_, reject) => {
          rejectTerminalization = reject;
        }),
      recoverLocalJob: async (record) => {
        laterLocalRecoveryCalls += 1;
        return providerRecoveryAccepted(record.operation.jobId);
      },
      onError: (message) => warnings.push(message),
      time: {
        setTimeout: () => {
          const timer: ControlledTimer = { unref: () => undefined };
          timers.add(timer);
          return timer;
        },
        clearTimeout: (timer) => {
          if (timer !== null) timers.delete(timer);
        },
      },
    });
    const first = {
      ...providerOperationRecord('executing', { retryCount: 1, retryNotBeforeMs: 0 }),
      lastError: { observedAtMs: 1, code: 'attach_failed', message: 'retry attachment' },
    } as Extract<ProviderOperationRecord, { phase: 'executing' }>;
    const later = providerOperationRecord('local-recovery-pending', {
      operation: { ...first.operation, operationId: operationUuid(999) },
      retryNotBeforeMs: 1,
    });
    insertProviderOperation(harness.db, first);
    insertProviderOperation(harness.db, later);
    const delivery = harness.reconciler.containmentDisappeared({
      operation: first.operation,
      setIdentity: providerProxySetIdentityFromRecord(first),
      disappearanceReceipt: 'active-page-fatal',
    });

    harness.reconciler.wake();
    await nextEventLoopTurn();
    rejectTerminalization(new ProviderOperationTerminalMetadataError(first.operation));
    await expect(delivery).rejects.toMatchObject({
      name: 'ProviderProxySetLifecycleFatalError',
      stage: 'disappearance-delivery',
      producerId: 'disappearance-terminalization',
    });
    await nextEventLoopTurn();

    expect({
      dispatcherGlobalFatalCalls: harness.dispatcherFatalErrors.length,
      reconcilerOnFatalCalls: harness.reconcilerFatalErrors.length,
      warnings: warnings.length,
      laterLocalRecoveryCalls,
      activePollTimers: timers.size,
    }).toEqual({
      dispatcherGlobalFatalCalls: 1,
      reconcilerOnFatalCalls: 0,
      warnings: 0,
      laterLocalRecoveryCalls: 0,
      activePollTimers: 0,
    });
  });

  it('retires healthy legacy occupants before due membership returns', async () => {
    let targetRecoveries = 0;
    const harness = createHarness({
      terminalize: () => {
        throw new ProviderOperationAtomicTerminalizationError(base.operation, new Error('legacy-disappearance-reset'));
      },
      recoverLocalJob: async (record) => {
        targetRecoveries += 1;
        return providerRecoveryAccepted(record.operation.jobId);
      },
    });
    const base = providerOperationRecord('executing');
    const predecessors = Array.from({ length: 32 }, (_, index) =>
      providerOperationRecord('executing', {
        operation: { ...base.operation, operationId: operationUuid(200 + index) },
        retryNotBeforeMs: 0,
      }),
    );
    const target = providerOperationRecord('local-recovery-pending', {
      operation: { ...base.operation, operationId: operationUuid(999) },
      retryNotBeforeMs: 1,
    });
    for (const record of predecessors) {
      insertProviderOperation(harness.db, record);
      harness.db
        .prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run(legacyDueKey(record), canonicalOperationKey(record));
    }
    insertProviderOperation(harness.db, target);
    await Promise.allSettled(
      predecessors.map((record) =>
        harness.reconciler.containmentDisappeared({
          operation: record.operation,
          setIdentity: providerProxySetIdentityFromRecord(record),
          disappearanceReceipt: `legacy-ready-${record.operation.operationId}`,
        }),
      ),
    );
    await nextEventLoopTurn();

    for (let scan = 0; scan < 4; scan += 1) {
      harness.reconciler.wake();
      await nextEventLoopTurn();
    }

    expect(targetRecoveries).toBe(1);
    expect(readProviderOperationDueSelections(harness.db, 100, 32)).toEqual([]);
  });

  it('fail-stops when selected due work cannot be durably finished', async () => {
    type ControlledTimer = ReturnType<TimePort['setTimeout']> & { callback: () => void };
    const timers = new Set<ControlledTimer>();
    const warnings: string[] = [];
    const harness = createHarness({
      terminalize: () => {
        throw new ProviderOperationAtomicTerminalizationError(
          selected.operation,
          new Error('repair-disappearance-reset'),
        );
      },
      onError: (message) => warnings.push(message),
      time: {
        setTimeout: (callback) => {
          const timer: ControlledTimer = { callback, unref: () => undefined };
          timers.add(timer);
          return timer;
        },
        clearTimeout: (timer) => {
          if (timer !== null) timers.delete(timer as ControlledTimer);
        },
      },
    });
    const selected = {
      ...providerOperationRecord('executing', { retryCount: 1, retryNotBeforeMs: 0 }),
      lastError: { observedAtMs: 1, code: 'attach_failed', message: 'retry attachment' },
    } as Extract<ProviderOperationRecord, { phase: 'executing' }>;
    insertProviderOperation(harness.db, selected);
    await expect(
      harness.reconciler.containmentDisappeared({
        operation: selected.operation,
        setIdentity: providerProxySetIdentityFromRecord(selected),
        disappearanceReceipt: 'repair-ready',
      }),
    ).resolves.toMatchObject({ kind: 'operational-failure' });
    await nextEventLoopTurn();
    const dueSelection = readProviderOperationDueSelections(harness.db, 100, 1)[0];
    if (dueSelection === undefined) throw new Error('expected one selected due row');
    harness.db.exec(`
      CREATE TEMP TRIGGER fail_due_turn_repair
      BEFORE DELETE ON meta
      WHEN OLD.key = '${dueSelection.rawKey}' AND OLD.value = '${dueSelection.rawValue}'
      BEGIN
        SELECT RAISE(ABORT, 'due-turn-repair-sentinel');
      END
    `);

    harness.reconciler.start();
    expect(timers.size).toBe(1);
    harness.reconciler.wake();
    await vi.waitFor(() => expect(warnings.length + harness.fatalErrors.length).toBe(1));
    harness.reconciler.wake();
    await nextEventLoopTurn();

    expect({ fatalCount: harness.fatalErrors.length, warnings, activeTimers: timers.size }).toEqual({
      fatalCount: 1,
      warnings: [],
      activeTimers: 0,
    });
    expect(harness.fatalErrors[0]).toMatchObject({
      name: 'ProviderOperationReconcilerFatalError',
      stage: 'due-turn-repair',
      operation: selected.operation,
      rawKey: dueSelection.rawKey,
    } satisfies Partial<ProviderOperationReconcilerFatalError>);
  });

  it('does not convert attachment completion failures into provider retry ownership', async () => {
    const sentinel = new Error('completion observer sentinel');
    const harness = createHarness();
    const recovered = {
      ...providerOperationRecord('executing', { retryCount: 1, retryNotBeforeMs: 0 }),
      lastError: { observedAtMs: 1, code: 'attach_failed', message: 'retry attachment' },
    } as Extract<ProviderOperationRecord, { phase: 'executing' }>;
    insertProviderOperation(harness.db, recovered);
    let throwOnce = true;
    const unsubscribe = subscribeProviderOperationMutations(harness.db, (mutation) => {
      if (throwOnce && mutation.kind === 'upserted' && mutation.record.lastError === null) {
        throwOnce = false;
        throw sentinel;
      }
    });
    let completionOutcome: 'rejected-sentinel' | 'fulfilled' = 'fulfilled';
    try {
      await harness.reconciler.reconcile(recovered, harness.authority).catch((error: unknown) => {
        if (error !== sentinel) throw error;
        completionOutcome = 'rejected-sentinel';
      });
    } finally {
      unsubscribe();
    }

    expect({
      completionOutcome,
      record: readProviderOperation(harness.db, recovered.operation),
      dueRows: readProviderOperationsDue(harness.db, Number.MAX_SAFE_INTEGER, 1),
    }).toMatchObject({
      completionOutcome: 'rejected-sentinel',
      record: { phase: 'executing', retryCount: 0, lastError: null },
      dueRows: [],
    });
  });

  it('fences a blocked executing attach and acknowledges disappearance only after terminalization', async () => {
    let resolveAttach!: (result: { state: 'attached'; replayFromProviderSeq: number }) => void;
    const attachBlocked = new Promise<{ state: 'attached'; replayFromProviderSeq: number }>((resolve) => {
      resolveAttach = resolve;
    });
    const harness = createHarness({ attachOperation: () => attachBlocked });
    const recovered = providerOperationRecord('executing');
    insertProviderOperation(harness.db, recovered);

    const drive = harness.reconciler.reconcile(recovered, harness.authority);
    await vi.waitFor(() => expect(readProviderOperation(harness.db, recovered.operation)?.phase).toBe('executing'));

    const acceptance = harness.reconciler.containmentDisappeared({
      operation: recovered.operation,
      setIdentity: providerProxySetIdentityFromRecord(recovered),
      disappearanceReceipt: 'exact-absence-receipt',
    });
    const accepted = await Promise.race([
      acceptance,
      new Promise<'acceptance-timed-out'>((resolve) => setTimeout(() => resolve('acceptance-timed-out'), 50)),
    ]);

    expect(accepted).not.toBe('acceptance-timed-out');
    if (accepted === 'acceptance-timed-out') throw new Error('disappearance acceptance did not preempt attach');
    if (accepted.kind !== 'accepted') throw new Error('disappearance terminalization unexpectedly requested retry');
    expect(accepted.acceptance.disposition).toBe('terminalization-committed');
    expect(readProviderOperation(harness.db, recovered.operation)).toBeNull();
    expect(harness.registry.attach).not.toHaveBeenCalled();

    if (recovered.phase !== 'executing') throw new Error('expected executing fixture');
    resolveAttach({ state: 'attached', replayFromProviderSeq: recovered.committedThroughProviderSeq + 1 });
    await drive;
    await Promise.resolve();
    expect(harness.registry.attach).not.toHaveBeenCalled();
    expect(readProviderOperation(harness.db, recovered.operation)).toBeNull();
  });

  it('retains retry-safe disappearance delivery without forgetting the notice', async () => {
    const harness = createHarness();
    const terminalize = harness.terminalization.terminalize;
    const terminalizeCalls = vi
      .spyOn(harness.terminalization, 'terminalize')
      .mockImplementationOnce(() => {
        throw new ProviderOperationAtomicTerminalizationError(
          harness.record.operation,
          new Error('transient terminalization failure'),
        );
      })
      .mockImplementation(terminalize);
    const recovered = providerOperationRecord('executing');
    insertProviderOperation(harness.db, recovered);
    const notice = {
      operation: recovered.operation,
      setIdentity: providerProxySetIdentityFromRecord(recovered),
      disappearanceReceipt: 'retryable-absence-receipt',
    };

    await expect(harness.reconciler.containmentDisappeared(notice)).resolves.toMatchObject({
      kind: 'operational-failure',
    });
    expect(terminalizeCalls).toHaveBeenCalledTimes(1);
    expect(readProviderOperation(harness.db, recovered.operation)?.phase).toBe('executing');

    let retryError: string | null = null;
    await harness.reconciler.containmentDisappeared(notice).catch((error: unknown) => {
      retryError = error instanceof Error ? error.message : String(error);
    });
    expect({
      retryError,
      terminalizeCalls: terminalizeCalls.mock.calls.length,
      phase: readProviderOperation(harness.db, recovered.operation)?.phase ?? 'missing',
    }).toEqual({ retryError: null, terminalizeCalls: 2, phase: 'missing' });
  });

  it('rejects a conflicting disappearance receipt after delivery failure', async () => {
    const harness = createHarness();
    const terminalizeCalls = vi.spyOn(harness.terminalization, 'terminalize').mockImplementationOnce(() => {
      throw new ProviderOperationAtomicTerminalizationError(
        harness.record.operation,
        new Error('transient terminalization failure'),
      );
    });
    const recovered = providerOperationRecord('executing');
    insertProviderOperation(harness.db, recovered);
    const notice = {
      operation: recovered.operation,
      setIdentity: providerProxySetIdentityFromRecord(recovered),
      disappearanceReceipt: 'first-absence-receipt',
    };

    await expect(harness.reconciler.containmentDisappeared(notice)).resolves.toMatchObject({
      kind: 'operational-failure',
    });
    await expect(
      harness.reconciler.containmentDisappeared({
        ...notice,
        disappearanceReceipt: 'conflicting-absence-receipt',
      }),
    ).rejects.toThrow('containment_disappearance_conflict');
    expect(terminalizeCalls).toHaveBeenCalledTimes(1);
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
    const acquireAuthority = vi.fn(async (_record: ProviderOperationRecord, _signal: AbortSignal) => {
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
      startupSetRecovery: {
        recoverSetAtStartup: async (work, signal) => {
          const startupRecord = readProviderOperation(harness.db, work.operations[0]);
          if (startupRecord === null) throw new Error('startup record disappeared');
          const startupAuthority = await acquireAuthority(startupRecord, signal);
          if (startupAuthority === null) throw new Error('startup authority unexpectedly absent');
          return { kind: 'authority', authority: startupAuthority };
        },
      },
      registry: harness.registry,
      materializePrepare: () => MATERIALIZED_PREPARED,
      recoverLocalJob: async (record) => providerRecoveryAccepted(record.operation.jobId),
      completeLocalRecovery: () => undefined,
      terminalization: harness.terminalization,
      recoveryDispatcher: harness.recoveryDispatcher,
      backendNamespace: 'tests',
      onFatal: (error) => {
        throw error;
      },
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
    const acquireAuthority = vi.fn(async (_record: ProviderOperationRecord, _signal: AbortSignal) => harness.authority);
    const reconciler = new ProviderOperationReconciler({
      getProgressStore: () => harness.progressStore,
      authorityFor: () => null,
      acquireAuthority,
      startupSetRecovery: {
        recoverSetAtStartup: async (work, signal) => {
          const startupRecord = readProviderOperation(harness.db, work.operations[0]);
          if (startupRecord === null) throw new Error('startup record disappeared');
          const startupAuthority = await acquireAuthority(startupRecord, signal);
          if (startupAuthority === null) throw new Error('startup authority unexpectedly absent');
          return { kind: 'authority', authority: startupAuthority };
        },
      },
      registry: harness.registry,
      materializePrepare: () => MATERIALIZED_PREPARED,
      recoverLocalJob: async (record) => providerRecoveryAccepted(record.operation.jobId),
      completeLocalRecovery: () => undefined,
      terminalization: harness.terminalization,
      recoveryDispatcher: harness.recoveryDispatcher,
      backendNamespace: 'tests',
      onFatal: (error) => {
        throw error;
      },
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
    const acquireAuthority = vi.fn(async (_record: ProviderOperationRecord, _signal: AbortSignal) => null);
    const registry = { activate: vi.fn(), attach: vi.fn(), settled: vi.fn(), stop: vi.fn() };
    const reconciler = new ProviderOperationReconciler({
      getProgressStore: () => harness.progressStore,
      authorityFor: () => null,
      acquireAuthority,
      startupSetRecovery: {
        recoverSetAtStartup: async (work, signal) => {
          const startupRecord = readProviderOperation(harness.db, work.operations[0]);
          if (startupRecord === null) throw new Error('startup record disappeared');
          await acquireAuthority(startupRecord, signal);
          return {
            kind: 'retry-scheduled',
            reason: 'No live control authority is available for this proxy set.',
            nextAttemptAtMs: 125,
          };
        },
      },
      registry,
      materializePrepare: () => MATERIALIZED_PREPARED,
      recoverLocalJob: async (record) => providerRecoveryAccepted(record.operation.jobId),
      completeLocalRecovery: () => undefined,
      terminalization: harness.terminalization,
      recoveryDispatcher: harness.recoveryDispatcher,
      backendNamespace: 'tests',
      onFatal: (error) => {
        throw error;
      },
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

  it('deletes a live publication handoff and resolves local authorization without generic recovery', async () => {
    const recoverLocalJob = vi.fn(async (record) => providerRecoveryAccepted(record.operation.jobId));
    const completeLocalRecovery = vi.fn();
    const harness = createHarness({
      prepareOperation: async () => ({
        state: 'permanent-refusal',
        code: 'provider_creation_refused',
        disposition: 'local-fallback',
        reason: 'The provider must run locally.',
      }),
      recoverLocalJob,
      completeLocalRecovery,
    });

    await expect(harness.begin()).resolves.toEqual({
      kind: 'local-authorized',
      reason: 'The provider must run locally.',
    });

    expect(readProviderOperation(harness.db, harness.record.operation)).toBeNull();
    expect(recoverLocalJob).not.toHaveBeenCalled();
    expect(completeLocalRecovery).not.toHaveBeenCalled();
  });

  it('resolves a live handoff when exact deletion committed before reporting an error', async () => {
    const harness = createHarness({
      prepareOperation: async () => ({
        state: 'permanent-refusal',
        code: 'provider_creation_refused',
        disposition: 'local-fallback',
        reason: 'The provider must run locally.',
      }),
    });
    const restoreCommitFault = installSqliteCommitFault(harness, 'after-sqlite-commit', null);

    try {
      await expect(harness.begin()).resolves.toEqual({
        kind: 'local-authorized',
        reason: 'The provider must run locally.',
      });
      expect(readProviderOperation(harness.db, harness.record.operation)).toBeNull();
    } finally {
      restoreCommitFault();
    }
  });

  it('persists prepare capacity as a local handoff before exact recovery accepts it', async () => {
    const accepted = deferred();
    const recoverLocalJob = vi.fn(async (record) => {
      await accepted.promise;
      return providerRecoveryAccepted(record.operation.jobId);
    });
    const completeLocalRecovery = vi.fn();
    const harness = createHarness({
      prepareOperation: async () => ({
        state: 'capacity',
        retryable: true,
        code: 'operation_ledger_capacity',
        reason: 'operation-ledgers',
      }),
      recoverLocalJob,
      completeLocalRecovery,
    });
    insertProviderOperation(harness.db, harness.record);

    const reconciliation = harness.reconciler.reconcile(harness.record);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect({
      sagaPhase: readProviderOperation(harness.db, harness.record.operation)?.phase ?? null,
      recoverCalls: recoverLocalJob.mock.calls.length,
      localCompletions: completeLocalRecovery.mock.calls.length,
    }).toEqual({
      sagaPhase: 'local-recovery-pending',
      recoverCalls: 1,
      localCompletions: 0,
    });

    accepted.resolve();
    await reconciliation;
  });

  it('keeps local recovery durable until exact generic recovery accepts it', async () => {
    const accepted = deferred();
    const recoverLocalJob = vi.fn(async (record) => {
      await accepted.promise;
      return providerRecoveryAccepted(record.operation.jobId);
    });
    const completeLocalRecovery = vi.fn();
    const authorityFor = vi.fn(() => null);
    const harness = createHarness({ recoverLocalJob, completeLocalRecovery, authorityFor });
    const record = providerOperationRecord('local-recovery-pending');
    insertProviderOperation(harness.db, record);

    const reconciliation = harness.reconciler.reconcile(record);
    await vi.waitFor(() => expect(recoverLocalJob).toHaveBeenCalledOnce());
    expect(readProviderOperation(harness.db, record.operation)).toEqual(record);
    expect(authorityFor).not.toHaveBeenCalled();
    expect(completeLocalRecovery).not.toHaveBeenCalled();

    accepted.resolve();
    await reconciliation;
    expect(readProviderOperation(harness.db, record.operation)).toBeNull();
    expect(completeLocalRecovery).toHaveBeenCalledWith(record.operation.jobId);
  });

  it('leaves local-recovery-pending rows to the generic startup recovery pass', async () => {
    const recoverLocalJob = vi.fn(async (record) => providerRecoveryAccepted(record.operation.jobId));
    const authorityFor = vi.fn(() => null);
    const harness = createHarness({ recoverLocalJob, authorityFor });
    const record = providerOperationRecord('local-recovery-pending');
    insertProviderOperation(harness.db, record);

    await harness.reconciler.reconcileAtStartup(new AbortController().signal);

    expect(readProviderOperation(harness.db, record.operation)).toEqual(record);
    expect(recoverLocalJob).not.toHaveBeenCalled();
    expect(authorityFor).not.toHaveBeenCalled();
  });

  it('records a retry when exact generic recovery rejects the local handoff', async () => {
    const acceptedRecoveries = 0;
    const recoverLocalJob = vi.fn(async () => {
      throw new Error('local recovery unavailable');
    });
    const completeLocalRecovery = vi.fn();
    const authorityFor = vi.fn(() => null);
    const harness = createHarness({ recoverLocalJob, completeLocalRecovery, authorityFor });
    const record = providerOperationRecord('local-recovery-pending');
    insertProviderOperation(harness.db, record);

    await harness.reconciler.reconcile(record);

    const durable = readProviderOperation(harness.db, record.operation);
    expect({
      sagaPhase: durable?.phase ?? null,
      acceptedRecoveries,
    }).toEqual({
      sagaPhase: 'local-recovery-pending',
      acceptedRecoveries: 0,
    });
    expect(durable).toMatchObject({
      phase: 'local-recovery-pending',
      revision: record.revision + 1,
      retryCount: 1,
      lastError: expect.objectContaining({ message: 'local recovery unavailable' }),
    });
    expect(authorityFor).not.toHaveBeenCalled();
    expect(completeLocalRecovery).not.toHaveBeenCalled();
  });

  it('retains the handoff when exact recovery accepts a different job', async () => {
    const recoverLocalJob = vi.fn(async () => providerRecoveryAccepted('another-job'));
    const completeLocalRecovery = vi.fn();
    const harness = createHarness({ recoverLocalJob, completeLocalRecovery, authorityFor: () => null });
    const record = providerOperationRecord('local-recovery-pending');
    insertProviderOperation(harness.db, record);

    await harness.reconciler.reconcile(record);

    expect(readProviderOperation(harness.db, record.operation)).toMatchObject({
      phase: 'local-recovery-pending',
      revision: record.revision + 1,
      retryCount: 1,
      lastError: expect.objectContaining({
        message: `Exact recovery did not accept provider-operation job '${record.operation.jobId}'.`,
      }),
    });
    expect(completeLocalRecovery).not.toHaveBeenCalled();
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

  it('keeps a thrown materialization dependency outage retryable without rotating the attempt', async () => {
    const prepareOperation = vi.fn();
    const materializePrepare = vi.fn(async () => {
      throw new Error('temporary credential store unavailable');
    });
    const harness = createHarness({
      prepareOperation,
      inspectOperation: async () => ({ state: 'absent' }),
      materializePrepare,
    });
    insertProviderOperation(harness.db, harness.record);

    await harness.reconciler.reconcile(harness.record, harness.authority);

    expect({
      materializations: materializePrepare.mock.calls.length,
      durable: readProviderOperation(harness.db, harness.record.operation),
      terminalEvents: harness.appended,
    }).toMatchObject({
      materializations: 1,
      durable: {
        phase: 'prepare-pending',
        prepareAttemptNumber: 1,
        prepareAttemptKey: harness.record.prepareAttemptKey,
        retryCount: 1,
        lastError: expect.objectContaining({ message: 'temporary credential store unavailable' }),
      },
      terminalEvents: [],
    });
    expect(prepareOperation).not.toHaveBeenCalled();
  });

  it('releases and terminalizes an expired recovered authorization instead of retrying it', async () => {
    const sentPrepareAttemptNumbers: number[] = [];
    const prepareOperation = vi.fn(async (attempt) => {
      sentPrepareAttemptNumbers.push(attempt.request.prepareAttemptNumber);
      return {
        state: 'pending-activation' as const,
        reservation: asReservation('00000000-0000-4000-8000-000000000007'),
        leaseExpiresInMs: 15_000,
        providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
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
  onFault: () => void = () => {},
): Promise<T> {
  const { boundary } = scenario;
  observe('before-send');
  if (boundary === 'before-send') {
    onFault();
    throw injectedTransportError(boundary);
  }
  observe('after-send');
  if (boundary === 'after-send') {
    if (scenario.afterSendEffect === 'applied') applyRemoteEffect();
    onFault();
    throw injectedTransportError(boundary);
  }
  applyRemoteEffect();
  observe('before-reply');
  if (boundary === 'before-reply') {
    onFault();
    throw injectedTransportError(boundary);
  }
  const result = reply();
  observe('after-reply');
  if (boundary === 'after-reply') {
    onFault();
    throw injectedTransportError(boundary);
  }
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
    let preparedAtFault = false;
    let prepareEffectsAtFault = 0;
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
          return callAcrossFaultBoundary(
            scenario,
            observe,
            applyPrepare,
            () => ({
              state: 'pending-activation' as const,
              reservation: asReservation('00000000-0000-4000-8000-000000000007'),
              leaseExpiresInMs: 15_000,
              providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
              jointContainmentReceipt: asJointContainmentReceipt('containment-receipt'),
            }),
            () => {
              preparedAtFault = state.prepared;
              prepareEffectsAtFault = prepareEffects;
            },
          );
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
      expect(preparedAtFault, `prepare/${fault}: remote state did not distinguish the lost send`).toBe(
        effectWasApplied,
      );
      expect(prepareEffectsAtFault, `prepare/${fault}: unexpected prepare effect before recovery`).toBe(
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
