import { vi } from 'vitest';

import type { JobProgressStore } from '#src/jobs/contracts/job-store.js';
import type { TimePort } from '#src/infra/port-types.js';
import type { ProviderProxyRecoveryProducerPorts } from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { providerOperationPrepareAttempt } from '#src/coordinator/services/provider-proxy-operation-activation.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { createProviderOperationStartupOwnership } from '#src/coordinator/services/recovery/provider-operation-startup-ownership.js';
import type { ProviderOperationPrepareMaterializationResult } from '#src/coordinator/services/provider-operation-prepare.js';
import type { ProviderOperationRecoveryAcceptance } from '#src/coordinator/services/recovery/provider-operation-job-recovery.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import type { ProviderOperationBindingPort } from '#src/jobs/contracts/provider-operation-lifecycle.js';
import {
  terminalizeProviderOperation,
  type ProviderOperationTerminalizationPort,
} from '#src/jobs/provider-operation-terminalization.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { readProviderOperation } from '#src/store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { unexercisedProviderHostControls } from '#tests/helpers/provider-host-controls.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import {
  asJointActivationReceipt,
  asJointContainmentReceipt,
  asReservation,
} from '#tests/helpers/provider-proxy-correlation.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

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

const ACTIVATION_ACK = {
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

export type ProviderOperationReconcilerHarnessOverrides = {
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
  binding?: (source: ProviderOperationBindingPort) => ProviderOperationBindingPort;
};

export function createProviderOperationReconcilerHarness(overrides: ProviderOperationReconcilerHarnessOverrides = {}) {
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
      projectRoot: fixtureCanonicalWorkDir(process.cwd()),
      workDir: fixtureCanonicalWorkDir(process.cwd()),
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
      projectRoot: fixtureCanonicalWorkDir(process.cwd()),
      backendNamespace: 'tests',
      pool: 'curate',
      enqueueSequence: 1,
      createdAt: '2026-08-09T12:34:55.000Z',
      jobKind: 'provider',
      providerAction: 'exec',
      request: {
        prompt: 'do the thing',
        cwd: fixtureCanonicalWorkDir(process.cwd()),
        bypassPermissions: false,
        coralEnv: {},
      },
    }),
  };
  const phasesBeforeMutation: string[] = [];
  const readPhase = (): string => readProviderOperation(db, record.operation)?.phase ?? 'missing';
  const authority: DurableProviderProxyOperationAuthority = {
    proxyInstanceId: record.operation.proxyInstanceId,
    providerHosts: unexercisedProviderHostControls,
    autonomousDeadline: {
      orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
      adoptionWindowMs: Number.MAX_SAFE_INTEGER,
      heartbeatHoldBound: {
        spanMs: Number.MAX_SAFE_INTEGER,
        materialSchedulerLatenessMs: Math.floor(Number.MAX_SAFE_INTEGER / 4),
      },
    },
    faulted: new Promise<never>(() => {}),
    onFault: () => () => undefined,
    onIncident: () => () => undefined,
    redeemControl: () => new Promise<never>(() => undefined),
    promoteControl: async () => {
      throw new Error('unused');
    },
    setIdentity: {
      buildSetId: record.operation.buildSetId,
      hostFingerprint: record.locator.hostFingerprint,
      guardianInstanceId: record.locator.guardian.instanceId,
      guardianPid: record.locator.guardian.pid,
      guardianIncarnation: record.locator.guardian.incarnation,
      guardianControlEndpoint: record.locator.guardian.controlEndpoint,
      proxyInstanceId: record.locator.proxy.instanceId,
      proxyPid: record.locator.proxy.pid,
      reaperInstanceId: record.locator.reaper.instanceId,
      reaperPid: record.locator.reaper.pid,
      reaperIncarnation: record.locator.reaper.incarnation,
      reaperControlEndpoint: record.locator.reaper.controlEndpoint,
      containmentKind: record.locator.containment.kind,
      proxyIncarnation: record.locator.proxy.incarnation,
      proxyProcessGroupId: record.locator.containment.processGroupId,
      canonicalEndpoint: record.locator.proxy.controlEndpoint,
    },
    registerSuccessionOperation:
      overrides.registerSuccessionOperation ?? (async () => ({ kind: 'registered' as const })),
    stopAndReap: async () => ({ disappearanceReceipt: 'gone' }),
    commitContainment: async () => ({ kind: 'containment-absent', disappearanceReceipt: 'gone' }),
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
          providerRoot: { pid: 104, incarnation: testIncarnation(1_003) },
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
        return ACTIVATION_ACK;
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
  const startupRuntime = createRealRuntime('prod');
  const startupBinding = new LaunchCoordinator({ runtime: startupRuntime });
  const startupLaunch = progressStore.readLaunchProjection(record.operation.jobId);
  if (startupLaunch === null || startupLaunch.provider === null) {
    throw new Error('expected provider launch projection');
  }
  const startupPermit = startupBinding.restoreActiveLaunch(
    record.operation.jobId,
    startupLaunch.provider,
    startupLaunch.owner,
    startupLaunch.pool,
  );
  startupBinding.prepareProviderOperationBinding(startupPermit, record.operation);
  let startupOwnershipService: ReturnType<typeof createProviderOperationStartupOwnership> | null = null;
  const getStartupOwnershipService = () => {
    if (startupOwnershipService !== null) return startupOwnershipService;
    startupBinding.cancelProviderOperationBinding(startupPermit, record.operation);
    startupBinding.releaseLaunch(startupPermit);
    startupOwnershipService = createProviderOperationStartupOwnership({
      runtime: startupRuntime,
      progressStore,
      binding: startupBinding,
      log: () => undefined,
    });
    return startupOwnershipService;
  };
  const startupOwnership = {
    binding: startupBinding,
    ownershipFor: (records: readonly ProviderOperationRecord[]) =>
      getStartupOwnershipService().hydrate({ records, unreadable: [] }),
    releaseStartupOwnership: (operation: ProviderOperationRecord['operation']) =>
      startupOwnershipService?.release(operation) ?? { kind: 'not-owned' as const },
  };
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
  const reconcilerDependencies = {
    getProgressStore: () => progressStore,
    authorityFor: overrides.authorityFor ?? (() => authority),
    ...(overrides.acquireAuthority === undefined ? {} : { acquireAuthority: overrides.acquireAuthority }),
    startupSetRecovery: {
      recoverSetAtStartup: async () => ({ kind: 'authority', authority }),
    },
    registry,
    binding: overrides.binding?.(startupOwnership.binding) ?? startupOwnership.binding,
    releaseStartupOwnership: startupOwnership.releaseStartupOwnership,
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
  } satisfies ConstructorParameters<typeof ProviderOperationReconciler>[0];
  const createReconciler = (): ProviderOperationReconciler => new ProviderOperationReconciler(reconcilerDependencies);
  const reconciler = createReconciler();
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
    startupOwnership,
    recoveryDispatcher,
    fatalErrors,
    dispatcherFatalErrors,
    reconcilerFatalErrors,
    phasesBeforeMutation,
    begin,
    restart: createReconciler,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
