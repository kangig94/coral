import { randomUUID } from 'node:crypto';

import { vi } from 'vitest';

import { createProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import {
  createProviderProxyAuthorityFaultLatch,
  type ProviderProxyAuthorityFault,
  type ProviderProxyAuthorityIncident,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { JobStore } from '#src/jobs/store.js';
import {
  controlExchangeForTest,
  type ControlClient,
  type ControlExchange,
} from '#src/provider-proxy/control-client.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { insertProviderOperation, subscribeProviderOperationMutations } from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

export type RetryOrdering = 'before-effect' | 'after-effect';
export type RetryMethod = 'attach' | 'stop';

function executingRecord(method: RetryMethod): Extract<ProviderOperationRecord, { phase: 'executing' }> {
  const record = providerOperationRecord('executing');
  if (record.phase !== 'executing') throw new Error('expected an executing provider operation fixture');
  if (method === 'attach') return record;
  const withStopIntent = providerOperationRecordSchema.parse({
    ...record,
    controlIntent: {
      kind: 'stop',
      cause: 'user_abort',
      requestedAt: '2026-08-09T12:34:57.000Z',
    },
  });
  if (withStopIntent.phase !== 'executing') throw new Error('expected durable stop intent to remain executing');
  return withStopIntent;
}

function statefulRetryEndpoint(method: RetryMethod, ordering: RetryOrdering) {
  const failure = Object.assign(new Error(`${method} response lost ${ordering}`), { code: 'control_call_failed' });
  const attachmentWatermarks: number[] = [];
  const stopIntents: string[] = [];
  let attachedWatermark: number | null = null;
  let stoppedFor: string | null = null;
  let attachmentEffects = 0;
  let stopEffects = 0;
  let targetAttempts = 0;

  const applyTargetEffect = (apply: () => void): void => {
    targetAttempts += 1;
    if (targetAttempts === 1 && ordering === 'before-effect') throw failure;
    apply();
    if (targetAttempts === 1 && ordering === 'after-effect') throw failure;
  };
  const applyAttachment = (watermark: number): void => {
    if (attachedWatermark === null) {
      attachedWatermark = watermark;
      attachmentEffects += 1;
      return;
    }
    if (attachedWatermark !== watermark) throw new Error('attachment retry changed the durable watermark');
  };
  const applyStop = (cause: string): void => {
    if (stoppedFor === null) {
      stoppedFor = cause;
      stopEffects += 1;
      return;
    }
    if (stoppedFor !== cause) throw new Error('stop retry changed the durable intent');
  };

  const client = {
    exchange: vi.fn(async (controlMethod: string, params: unknown): Promise<ControlExchange> => {
      let value: unknown;
      if (controlMethod === 'operation.attach.v1') {
        const watermark = (params as { committedThroughProviderSeq: number }).committedThroughProviderSeq;
        attachmentWatermarks.push(watermark);
        if (method === 'attach') applyTargetEffect(() => applyAttachment(watermark));
        else applyAttachment(watermark);
        value = { state: 'attached', replayFromProviderSeq: watermark + 1 };
      } else if (controlMethod === 'operation.stop.v1' && method === 'stop') {
        const cause = (params as { cause: string }).cause;
        stopIntents.push(cause);
        applyTargetEffect(() => applyStop(cause));
        value = { state: 'terminal-awaiting-journal-ack', committedThroughProviderSeq: attachedWatermark };
      } else {
        throw new Error(`unexpected control exchange: ${controlMethod}`);
      }
      return controlExchangeForTest({ kind: 'response', response: { kind: 'result', value } });
    }),
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => undefined,
  } satisfies ControlClient;

  return {
    client,
    failure,
    attachmentWatermarks,
    stopIntents,
    attachmentEffectCount: () => attachmentEffects,
    stopEffectCount: () => stopEffects,
  };
}

function seedExecutingJob(progressStore: JobStore, record: Extract<ProviderOperationRecord, { phase: 'executing' }>) {
  const db = progressStore.getDb();
  const sessionId = randomUUID();
  seedTestSessionProjection(db, {
    sessionId,
    provider: 'codex',
    projectRoot: process.cwd(),
    backendNamespace: 'operation-retry-test',
    activeJobId: record.operation.jobId,
  });
  progressStore.appendLaunchRequested(record.operation.jobId, {
    jobId: record.operation.jobId,
    owner: { kind: 'provider-session', id: sessionId },
    sessionId,
    provider: 'codex',
    projectRoot: process.cwd(),
    backendNamespace: 'operation-retry-test',
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 1,
    providerAction: 'exec',
    request: { prompt: 'test', cwd: process.cwd(), bypassPermissions: false, coralEnv: {} },
    createdAt: '2026-08-09T12:34:55.000Z',
  });
  insertProviderOperation(db, record);
}

export function createProviderOperationRetryHarness(method: RetryMethod, ordering: RetryOrdering) {
  const record = executingRecord(method);
  const endpoint = statefulRetryEndpoint(method, ordering);
  const runtime = createRealRuntime('prod');
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const progressStore = new JobStore(
    `operation-${method}-${ordering}-${randomUUID()}`,
    runtime,
    createEventBodyCodec(),
    { db, providers: permissiveProviderLookupPort },
  );
  seedExecutingJob(progressStore, record);

  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([record]);
  const unsubscribeClaims = subscribeProviderOperationMutations(db, (mutation) => claims.applyMutation(mutation));
  const faults = createProviderProxyAuthorityFaultLatch();
  const incidents: ProviderProxyAuthorityIncident[] = [];
  const terminalFaults: ProviderProxyAuthorityFault[] = [];
  faults.onIncident((observation) => incidents.push(observation));
  faults.onFault((fault) => terminalFaults.push(fault));
  const stopAndReap = vi.fn(async () => ({ unconfirmed: 'not requested' }) as const);
  const idleClient = {
    exchange: async (controlMethod: string): Promise<never> => {
      throw new Error(`unexpected role control exchange: ${controlMethod}`);
    },
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => undefined,
  } satisfies ControlClient;
  const authority = createProviderProxyOperationAuthority({
    base: {
      proxyInstanceId: record.operation.proxyInstanceId,
      autonomousDeadline: {
        orphanTimeoutMs: 37_000,
        adoptionWindowMs: 23_000,
        heartbeatHoldBound: { spanMs: 23_000, materialSchedulerLatenessMs: 5_750 },
      },
      stopAndReap,
      stopHeartbeats: () => undefined,
      initiateControlClose: async () => undefined,
      controlReattachment: {} as never,
      registerSuccessionOperation: async () => ({ kind: 'registered' as const }),
    },
    setIdentity: providerProxySetIdentityFromRecord(record),
    clients: { proxy: endpoint.client, guardian: idleClient, reaper: idleClient },
    faults,
    mutationRpcTimeoutMs: 5_000,
  });
  const registry = { activate: vi.fn(), attach: vi.fn(), settled: vi.fn(), stop: vi.fn() };
  const unexpected = (): never => {
    throw new Error('unexpected non-executing reconciler path');
  };
  const recoveryDispatcher = createTestProviderProxyRecoveryDispatcher(
    { 'disappearance-terminalization': async () => unexpected() },
    unexpected,
  );
  const reconciler = new ProviderOperationReconciler({
    getProgressStore: () => progressStore,
    authorityFor: () => authority,
    startupSetRecovery: { recoverSetAtStartup: async () => ({ kind: 'authority', authority }) },
    registry,
    materializePrepare: unexpected,
    recoverLocalJob: async () => unexpected(),
    completeLocalRecovery: unexpected,
    terminalization: { terminalize: unexpected },
    recoveryDispatcher,
    backendNamespace: 'operation-retry-test',
    time: {
      now: () => 100,
      setTimeout: () => ({ unref: () => undefined }),
      clearTimeout: () => undefined,
    },
    onFatal: unexpected,
  } satisfies ConstructorParameters<typeof ProviderOperationReconciler>[0]);

  return {
    authority,
    claims,
    endpoint,
    incidents,
    progressStore,
    reconciler,
    record,
    registry,
    stopAndReap,
    terminalFaults,
    unsubscribeClaims,
  };
}
