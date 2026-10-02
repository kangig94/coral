import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimerHandle } from '#src/infra/port-types.js';
import { type ProcessIncarnation, type ProcessLiveness } from '#src/infra/node-process.js';
import type { HandoffCapsule } from '#src/provider-proxy/handoff-capsule.js';
import { ControlClientError } from '#src/provider-proxy/control-client.js';
import type { ProviderProxyHeartbeatHoldBound } from '#src/provider-proxy/orphan-deadline.js';
import {
  createProviderProxyOperationAuthority,
  providerProxyOperationControlIsHeld,
  type DurableProviderProxyOperationAuthority,
} from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';
import {
  createProviderProxyAuthorityFaultLatch,
  type ContainmentRequiredControlCallPolicy,
  type ProviderProxyAuthorityFault,
  type ProviderProxyAuthorityFaultLatch,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import {
  authorizeProviderProxySetContainmentProof,
  createProviderProxySetContainmentProver,
  inspectProviderProxySetContainmentProof,
  providerProxySetContainmentEvidenceFor,
  verifyProviderProxySetContainmentProofCurrent,
  type ProviderProxySetContainmentProof,
  type ProviderProxySetContainmentProofAuthorization,
  type ProviderProxySetFencedContainmentProof,
  type ProviderProxySetFencedContainmentProofAuthorization,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import {
  ProviderProxySetLifecycle,
  type CapsuleRetirementAttemptOutcome,
  type ProviderProxySetLifecycleDeps,
  type ProviderProxySetOperatorExitCapability,
} from '#src/coordinator/services/provider-proxy-set/index.js';
import { ProviderProxySetOperatorDispositionStore } from '#src/coordinator/services/provider-proxy-set/operator-disposition-store.js';
import { type ProviderProxySetRecordedContainmentReaper } from '#src/coordinator/services/provider-proxy-set/recorded-containment-reaper.js';
import type {
  DisappearanceDeliveryAttemptOutcome,
  ProviderContainmentDisappearanceConsumer,
} from '#src/coordinator/services/provider-containment-disappearance.js';
import type { ProviderRepresentationAbandonmentConsumer } from '#src/coordinator/services/provider-representation-abandonment.js';
import type {
  ProviderProxyRecoveryDispatcher,
  ProviderProxySetLifecycleFatalError,
} from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import {
  providerProxySetAddress,
  providerProxySetIdentityFromRecord,
} from '#src/coordinator/services/provider-proxy-set/identity.js';
import type { ProviderProxySetRedemptionOutcome } from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import type { ProviderProxySetContainmentEvidence } from '#src/provider-proxy/containment-proof-contract.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  insertProviderOperation,
  providerOperationMutationAdmission,
  ProviderOperationMutationAdmission,
  type ProviderOperationMutationSetFence,
} from '#src/store/provider-operation-journal.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import {
  PROVIDER_OPERATION_RECORD_VERSION,
  encodeProviderOperationRecord,
} from '#src/store/provider-operation-record.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';
import {
  unexercisedControllerSuccessionControls,
  unexercisedProviderHostControls,
} from '#tests/helpers/provider-host-controls.js';

/** The build this fixture lifecycle belongs to — the same one `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';
const TEST_PUBLICATION_RECEIPT = {
  kind: 'provider-proxy-set-published',
} as PublicationReceipt;
const DURABLE_DISPOSITION_RUN_DIR = '/coral/run';
const sealedProofDatabases: Database[] = [];

afterEach(() => {
  for (const db of sealedProofDatabases.splice(0)) db.close();
});

const enforcersUnobservable: ProviderProxySetContainmentEvidence = {
  kind: 'enforcers-observed',
  observations: [
    { role: 'guardian', observation: 'unknown' },
    { role: 'reaper', observation: 'unknown' },
  ],
};
const noContainmentProof = async (): Promise<ProviderProxySetContainmentEvidence> => enforcersUnobservable;
let containmentEvidenceSequence = 0;
const containmentEvidenceReceipts = new Map<ProcessIncarnation, string>();
function containmentEvidence(receipt: string): ProviderProxySetContainmentEvidence {
  const incarnation = testIncarnation(90_000 + containmentEvidenceSequence++);
  containmentEvidenceReceipts.set(incarnation, receipt);
  return {
    kind: 'reap-required',
    containment: { pid: 9_000, incarnation, processGroupId: 9_000 },
    recordedRoots: [],
  };
}
const reapContainmentEvidence: ProviderProxySetRecordedContainmentReaper = async (identity, proof) => ({
  kind: 'containment-absent',
  disappearanceReceipt: (() => {
    const evidence = providerProxySetContainmentEvidenceFor(proof, identity);
    return (
      containmentEvidenceReceipts.get(
        evidence.kind === 'reap-required' ? evidence.containment.incarnation : identity.proxyIncarnation,
      ) ?? 'fixture-containment-absence'
    );
  })(),
});
const noOperatorExitEffect = {
  signalsSent: [] as const,
  containmentAbsent: false,
  representationAction: 'none' as const,
};
const ignoreControlEstablished = (): void => undefined;
const containmentOperationPolicy: ContainmentRequiredControlCallPolicy = {
  method: 'operation.cancel.v1',
  phase: 'prestart-cleanup-pending',
  effect: 'mutation',
  indeterminate: 'requires-containment',
  preEffectProtocolCodes: new Set(),
};

function terminalAuthorityFault(): ProviderProxyAuthorityFault {
  return {
    kind: 'heartbeat-failed',
    role: 'proxy',
    method: 'control.heartbeat.v1',
    terminalReason: 'teardown-latched',
    error: 'teardown latched',
  };
}

type ProviderProxySetLifecycleFixtureDeps = Omit<
  ProviderProxySetLifecycleDeps,
  | 'recoveryDispatcher'
  | 'reapRecordedContainment'
  | 'reportLifecycle'
  | 'buildSetId'
  | 'fenceProviderOperationMutations'
  | 'operatorDispositionStore'
  | 'writerIncarnation'
  | 'collectOperatorDispositionContainmentProof'
  | 'reobserveAcquisitionContainment'
> &
  Readonly<{
    recoveryDispatcher?: ProviderProxyRecoveryDispatcher;
    reportLifecycle?: ProviderProxySetLifecycleDeps['reportLifecycle'];
    reapRecordedContainment?: ProviderProxySetRecordedContainmentReaper;
    fenceProviderOperationMutations?: ProviderProxySetLifecycleDeps['fenceProviderOperationMutations'];
    operatorDispositionStore?: ProviderProxySetOperatorDispositionStore;
    writerIncarnation?: string;
    collectOperatorDispositionContainmentProof?: ProviderProxySetLifecycleDeps['collectOperatorDispositionContainmentProof'];
    reobserveAcquisitionContainment?: ProviderProxySetLifecycleDeps['reobserveAcquisitionContainment'];
    activateDurability?: boolean;
    disappearanceConsumer: ProviderContainmentDisappearanceConsumer;
    abandonmentConsumer?: ProviderRepresentationAbandonmentConsumer;
    proveContainmentAbsent(
      identity: ReturnType<typeof providerProxySetIdentityFromRecord>,
      signal: AbortSignal,
    ): Promise<ProviderProxySetContainmentEvidence>;
    retireCapsule?(path: string): Promise<CapsuleRetirementAttemptOutcome> | CapsuleRetirementAttemptOutcome;
    onFatal?(error: ProviderProxySetLifecycleFatalError): void;
    redeemCapsule?(
      capsule: HandoffCapsule,
      capsulePath: string,
      signal: AbortSignal,
    ): Promise<ProviderProxySetRedemptionOutcome>;
  }>;

function lifecycleFor(deps: ProviderProxySetLifecycleFixtureDeps): ProviderProxySetLifecycle {
  const mutationAdmission = new ProviderOperationMutationAdmission();
  const retireCapsule = deps.retireCapsule ?? (() => ({ kind: 'retired' as const }));
  const onFatal = deps.onFatal ?? (() => undefined);
  const recoveryDispatcher = createTestProviderProxyRecoveryDispatcher(
    {
      ...(deps.redeemCapsule === undefined
        ? {}
        : {
            'capsule-redemption': ({ capsule, capsulePath, signal }) =>
              deps.redeemCapsule?.(capsule, capsulePath, signal) ?? Promise.reject(new Error('unconfigured')),
          }),
      'containment-proof': async ({ identity, signal }) => {
        const mutationFence = mutationAdmission.closeSet(identity);
        return sealedContainmentProof(
          identity,
          authorizeProviderProxySetContainmentProof(identity, {
            mutationFence,
            closeAdmission: async () => {
              if (mutationFence.kind === 'holding') await mutationFence.retryAfter;
            },
          }),
          await deps.proveContainmentAbsent(identity, signal),
        );
      },
      'capsule-retirement': ({ path }) => retireCapsule(path),
      'disappearance-consumer': ({ notice }) => deps.disappearanceConsumer.containmentDisappeared(notice),
      ...(deps.abandonmentConsumer === undefined
        ? {}
        : {
            'representation-abandonment-consumer': ({ notice }) =>
              deps.abandonmentConsumer?.representationAbandoned(notice) ?? Promise.reject(new Error('unconfigured')),
          }),
    },
    onFatal,
  );
  const {
    proveContainmentAbsent: _proveContainmentAbsent,
    retireCapsule: _retireCapsule,
    onFatal: _onFatal,
    redeemCapsule: _redeemCapsule,
    disappearanceConsumer: _disappearanceConsumer,
    abandonmentConsumer: _abandonmentConsumer,
    recoveryDispatcher: suppliedDispatcher,
    fenceProviderOperationMutations,
    activateDurability = true,
    ...lifecycleDeps
  } = deps;
  const operatorDispositionStore =
    lifecycleDeps.operatorDispositionStore ??
    new ProviderProxySetOperatorDispositionStore(new InMemoryStorage(lifecycleDeps.time), DURABLE_DISPOSITION_RUN_DIR);
  const lifecycle = new ProviderProxySetLifecycle({
    buildSetId: FIXTURE_BUILD_SET_ID,
    ...lifecycleDeps,
    recoveryDispatcher: suppliedDispatcher ?? recoveryDispatcher,
    reapRecordedContainment: deps.reapRecordedContainment ?? reapContainmentEvidence,
    operatorDispositionStore,
    writerIncarnation: lifecycleDeps.writerIncarnation ?? randomUUID(),
    collectOperatorDispositionContainmentProof:
      lifecycleDeps.collectOperatorDispositionContainmentProof ??
      (async (identity, signal) => {
        const mutationFence = mutationAdmission.closeSet(identity);
        return sealedContainmentProof(
          identity,
          authorizeProviderProxySetContainmentProof(identity, {
            mutationFence,
            closeAdmission: async () => {
              if (mutationFence.kind === 'holding') await mutationFence.retryAfter;
            },
          }),
          await deps.proveContainmentAbsent(identity, signal),
        );
      }),
    reobserveAcquisitionContainment:
      lifecycleDeps.reobserveAcquisitionContainment ??
      (async () => ({
        kind: 'held' as const,
        observation: 'unknown' as const,
        reason: 'fixture acquisition containment remains unobservable',
      })),
    fenceProviderOperationMutations:
      fenceProviderOperationMutations ?? ((identity) => mutationAdmission.closeSet(identity)),
    reportLifecycle: lifecycleDeps.reportLifecycle ?? (() => undefined),
  });
  if (activateDurability) lifecycle.activateDurableOperatorDispositions();
  return lifecycle;
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const authorityFaultEmitters = new WeakMap<
  DurableProviderProxyOperationAuthority,
  (fault: ProviderProxyAuthorityFault) => void
>();

function latchAuthorityFault(
  authority: DurableProviderProxyOperationAuthority,
  fault: ProviderProxyAuthorityFault,
): void {
  const emit = authorityFaultEmitters.get(authority);
  if (emit === undefined) throw new Error('authority fault emitter is not registered');
  emit(fault);
}

function setReference(identity: ReturnType<typeof providerProxySetIdentityFromRecord>): string {
  return `proxyInstanceId=${identity.proxyInstanceId},buildSetId=${identity.buildSetId}`;
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

class ManualClock {
  nowMs = 0;
  readonly timers: Array<{ at: number; active: boolean; callback: () => void }> = [];
  readonly scheduledDelays: number[] = [];
  readonly unreferencedDelays: number[] = [];

  /** Tracked apart from `nowMs` so a test can make the two disagree the way a clock correction does: only
   *  the wall reading may jump or run backwards, and nothing that authorizes a reap may read it. */
  monotonicMs = 0;

  now = (): number => this.nowMs;
  monotonicNow = (): bigint => BigInt(this.monotonicMs);

  /** Moves the wall clock without moving monotonic time, as an NTP correction or a resumed VM does. */
  stepWallClock = (ms: number): void => {
    this.nowMs += ms;
  };

  setTimeout = (callback: () => void, ms: number): TimerHandle => {
    const timer = { at: this.nowMs + ms, active: true, callback };
    this.timers.push(timer);
    this.scheduledDelays.push(ms);
    return {
      unref: () => {
        this.unreferencedDelays.push(ms);
      },
      __timer: timer,
    } as TimerHandle;
  };

  clearTimeout = (handle: TimerHandle | null): void => {
    const timer = (handle as (TimerHandle & { __timer?: { active: boolean } }) | null)?.__timer;
    if (timer !== undefined) timer.active = false;
  };

  /** Ordinary time: both readings advance together, which is what every test that is not about a clock
   *  correction wants. */
  elapse(ms: number): void {
    this.nowMs += ms;
    this.monotonicMs += ms;
  }

  runDue(): void {
    for (const timer of this.timers) {
      if (!timer.active || timer.at > this.nowMs) continue;
      timer.active = false;
      timer.callback();
    }
  }
}

function elapseOperatorExitObservations(
  clock: ManualClock,
  lifecycle: ProviderProxySetLifecycle,
  elapsedMs: number,
): void {
  let remainingMs = elapsedMs;
  while (remainingMs > 0) {
    const stepMs = Math.min(1_000, remainingMs);
    clock.elapse(stepMs);
    lifecycle.snapshot();
    remainingMs -= stepMs;
  }
}

function fakeAuthority(
  options: {
    record?: ReturnType<typeof providerOperationRecord>;
    fault?: ReturnType<typeof deferred<ProviderProxyAuthorityFault>>;
    faults?: ProviderProxyAuthorityFaultLatch;
    stopAndReap?: DurableProviderProxyOperationAuthority['stopAndReap'];
    commitContainment?: DurableProviderProxyOperationAuthority['commitContainment'];
    stopHeartbeats?: DurableProviderProxyOperationAuthority['stopHeartbeats'];
    initiateControlClose?: DurableProviderProxyOperationAuthority['initiateControlClose'];
    heartbeatHoldBound?: ProviderProxyHeartbeatHoldBound;
    adoptionWindowMs?: number;
    redeemControl?: DurableProviderProxyOperationAuthority['redeemControl'];
    promoteControl?: DurableProviderProxyOperationAuthority['promoteControl'];
  } = {},
): DurableProviderProxyOperationAuthority {
  const record = options.record ?? providerOperationRecord('executing');
  const fault = options.fault;
  const faults = options.faults ?? (fault === undefined ? createProviderProxyAuthorityFaultLatch() : undefined);
  const stopAndReap = options.stopAndReap ?? (async () => ({ unconfirmed: 'not proved' }) as const);
  const commitContainment =
    options.commitContainment ??
    (async (signal: AbortSignal) => {
      const result = await stopAndReap(signal);
      return 'disappearanceReceipt' in result
        ? ({ kind: 'containment-absent', disappearanceReceipt: result.disappearanceReceipt } as const)
        : ({ kind: 'outcome-unknown', error: result.unconfirmed } as const);
    });
  const authority: DurableProviderProxyOperationAuthority = {
    proxyInstanceId: record.operation.proxyInstanceId,
    providerHosts: unexercisedProviderHostControls,
    ...unexercisedControllerSuccessionControls,
    autonomousDeadline: {
      orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
      adoptionWindowMs: options.adoptionWindowMs ?? Number.MAX_SAFE_INTEGER,
      heartbeatHoldBound: options.heartbeatHoldBound ?? {
        spanMs: Number.MAX_SAFE_INTEGER,
        materialSchedulerLatenessMs: Math.floor(Number.MAX_SAFE_INTEGER / 4),
      },
    },
    setIdentity: providerProxySetIdentityFromRecord(record),
    faulted: faults?.faulted ?? fault?.promise ?? new Promise<never>(() => undefined),
    onFault:
      faults?.onFault ??
      ((listener) => {
        if (fault !== undefined) void fault.promise.then(listener);
        return () => undefined;
      }),
    onIncident: faults?.onIncident ?? (() => () => undefined),
    redeemControl: options.redeemControl ?? (() => new Promise<never>(() => undefined)),
    promoteControl:
      options.promoteControl ??
      (async () => {
        throw new Error('unused');
      }),
    registerSuccessionOperation: async () => ({ kind: 'registered' as const }),
    stopAndReap,
    commitContainment,
    stopHeartbeats: options.stopHeartbeats ?? (() => undefined),
    initiateControlClose: options.initiateControlClose ?? (async () => undefined),
    prepareOperation: async () => {
      throw new Error('unused');
    },
    inspectOperation: async () => ({ state: 'absent' }),
    authorizeOperation: async () => {
      throw new Error('unused');
    },
    activatePreparedOperation: async () => {
      throw new Error('unused');
    },
    attachOperation: async () => ({ state: 'operation-absent', operation: record.operation }),
    cancelOperation: async () => ({
      state: 'released-never-started',
      operation: record.operation,
      prepareAttemptNumber: 1,
      prepareAttemptKey: 'b'.repeat(64),
    }),
    settleOperation: async (_operation, finalProviderSeq) => ({
      state: 'released-after-terminal',
      settledThroughProviderSeq: finalProviderSeq,
    }),
    buildOperationControl: () => ({ stop: async () => undefined }),
  };
  if (faults !== undefined) authorityFaultEmitters.set(authority, faults.latch);
  else if (fault !== undefined) authorityFaultEmitters.set(authority, fault.resolve);
  return authority;
}

function containmentProofDatabase(record: ReturnType<typeof providerOperationRecord>): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  insertProviderOperation(db, record);
  return db;
}

function insertProviderOperationOutsideAdmission(
  db: Database,
  record: ReturnType<typeof providerOperationRecord>,
): void {
  const { operation } = record;
  const key =
    `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:` +
    `${operation.jobId}:${operation.operationId}:${operation.proxyInstanceId}:${operation.buildSetId}`;
  db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(
    key,
    encodeProviderOperationRecord(record),
  );
}

function containmentProofRuntime(
  identity: ReturnType<typeof providerProxySetIdentityFromRecord>,
  observations: Readonly<Record<'guardian' | 'reaper', ProcessLiveness>>,
  proxyObservation: ProcessLiveness = 'absent',
) {
  const base = createRealRuntime('prod');
  const expectedIncarnations = new Map<number, ProcessIncarnation>([
    [identity.guardianPid, identity.guardianIncarnation],
    [identity.reaperPid, identity.reaperIncarnation],
  ]);
  const observationFor = (pid: number): ProcessLiveness => {
    if (pid === identity.guardianPid) return observations.guardian;
    if (pid === identity.reaperPid) return observations.reaper;
    if (pid === identity.proxyPid) return proxyObservation;
    return 'absent';
  };
  const readProcessIncarnation = vi.fn((pid: number) =>
    observationFor(pid) === 'alive' ? (expectedIncarnations.get(pid) ?? null) : null,
  );
  const observeLiveness = vi.fn((pid: number) => observationFor(pid));
  const kill = vi.fn(() => true);
  return {
    runtime: {
      ...base,
      process: { ...base.process, readProcessIncarnation, observeLiveness, kill },
    },
    kill,
    observeLiveness,
    readProcessIncarnation,
  };
}

function sealedContainmentProof(
  identity: ReturnType<typeof providerProxySetIdentityFromRecord>,
  authorization: ProviderProxySetFencedContainmentProofAuthorization,
  evidence: ProviderProxySetContainmentEvidence,
): Promise<ProviderProxySetFencedContainmentProof>;
function sealedContainmentProof(
  identity: ReturnType<typeof providerProxySetIdentityFromRecord>,
  authorization: ProviderProxySetContainmentProofAuthorization,
  evidence: ProviderProxySetContainmentEvidence,
): Promise<ProviderProxySetContainmentProof>;
async function sealedContainmentProof(
  identity: ReturnType<typeof providerProxySetIdentityFromRecord>,
  authorization: ProviderProxySetContainmentProofAuthorization,
  evidence: ProviderProxySetContainmentEvidence,
): Promise<ProviderProxySetContainmentProof> {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  if (evidence.kind === 'store-unreadable') {
    const unreadableKey =
      `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:${randomUUID()}:${randomUUID()}:` +
      `${identity.proxyInstanceId}:${identity.buildSetId}`;
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(unreadableKey, 'not-json');
  }
  const observations: Readonly<Record<'guardian' | 'reaper', ProcessLiveness>> =
    evidence.kind === 'enforcers-observed'
      ? {
          guardian: evidence.observations.find(({ role }) => role === 'guardian')?.observation ?? 'unknown',
          reaper: evidence.observations.find(({ role }) => role === 'reaper')?.observation ?? 'unknown',
        }
      : { guardian: 'absent', reaper: 'absent' };
  if (evidence.kind === 'reap-required') {
    containmentEvidenceReceipts.set(
      identity.proxyIncarnation,
      containmentEvidenceReceipts.get(evidence.containment.incarnation) ?? 'fixture-containment-absence',
    );
  }
  sealedProofDatabases.push(db);
  return createProviderProxySetContainmentProver(
    containmentProofRuntime(identity, observations, evidence.kind === 'enforcers-observed' ? 'unknown' : 'absent')
      .runtime,
  ).collectContainmentProof(authorization, db, new AbortController().signal);
}

function operatorContainmentProof(
  capability: ProviderProxySetOperatorExitCapability,
  evidence: ProviderProxySetContainmentEvidence,
): Promise<ProviderProxySetFencedContainmentProof> {
  return sealedContainmentProof(capability.setIdentity, capability.containmentProofAuthorization, evidence);
}

async function authorizedOperatorExitForProof(
  record: ReturnType<typeof providerOperationRecord>,
  reapRecordedContainment: ProviderProxySetRecordedContainmentReaper,
  operatorDispositionStore?: ProviderProxySetOperatorDispositionStore,
): Promise<
  Readonly<{
    capability: ProviderProxySetOperatorExitCapability;
    lifecycle: ProviderProxySetLifecycle;
    mutationAdmission: ProviderOperationMutationAdmission;
    mutationFence: ProviderOperationMutationSetFence;
    stopAndReap: DurableProviderProxyOperationAuthority['stopAndReap'];
    clock: ManualClock;
  }>
> {
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const faults = createProviderProxyAuthorityFaultLatch();
  const stopAndReap = vi.fn<DurableProviderProxyOperationAuthority['stopAndReap']>(
    (signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => resolve({ unconfirmed: 'automatic containment attempt was cancelled' }),
          { once: true },
        );
      }),
  );
  const clock = new ManualClock();
  const mutationAdmission = new ProviderOperationMutationAdmission();
  let mutationFence: ProviderOperationMutationSetFence | null = null;
  const authority = fakeAuthority({ record, faults, stopAndReap, adoptionWindowMs: 100 });
  const lifecycle = lifecycleFor({
    claims,
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
    time: clock,
    proveContainmentAbsent: noContainmentProof,
    reapRecordedContainment,
    fenceProviderOperationMutations: (identity) => {
      mutationFence = mutationAdmission.closeSet(identity);
      return mutationFence;
    },
    ...(operatorDispositionStore === undefined ? {} : { operatorDispositionStore }),
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  lifecycle.registerInheritedSet(authority, TEST_PUBLICATION_RECEIPT);
  faults.reportIncident({
    kind: 'control-channel-fault',
    role: 'guardian',
    cause: 'closed',
    error: new ControlClientError('control_client_closed', 'guardian closed', 'closed'),
  });
  await drainMicrotasks();
  clock.elapse(100);
  clock.runDue();
  const authorization = lifecycle.authorizeOperatorExit(providerProxySetAddress(authority.setIdentity));
  if (authorization.kind !== 'authorized') {
    throw new Error(`expected authorization, received ${authorization.kind}`);
  }
  if (mutationFence === null) throw new Error('operator exit did not acquire a mutation fence');
  return { capability: authorization.capability, lifecycle, mutationAdmission, mutationFence, stopAndReap, clock };
}

describe('ProviderProxySetLifecycle', () => {
  it('holds a claim-bearing indeterminate operation-control fault and fences retained mutation authority', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'still live' }) as const);
    const faults = createProviderProxyAuthorityFaultLatch();
    const base = fakeAuthority({ record, stopAndReap });
    const underlyingAuthority = createProviderProxyOperationAuthority({
      base: base as never,
      setIdentity: base.setIdentity,
      clients: {} as never,
      faults,
      mutationRpcTimeoutMs: 1_000,
    });
    const authority: DurableProviderProxyOperationAuthority = { ...underlyingAuthority };
    const retainedControl = underlyingAuthority.buildOperationControl(record.operation);
    const reportLifecycle = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority, TEST_PUBLICATION_RECEIPT);

    faults.latch({
      kind: 'operation-control-failed',
      policy: containmentOperationPolicy,
      error: 'mutation outcome unknown',
    });

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(providerProxyOperationControlIsHeld(authority)).toBe(true);
    expect(providerProxyOperationControlIsHeld(underlyingAuthority)).toBe(true);
    expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
    await expect(underlyingAuthority.cancelOperation(record.operation, 1, 'b'.repeat(64))).rejects.toMatchObject({
      code: 'operation-control-outcome-unknown',
    });
    await expect(retainedControl.stop('user_abort')).rejects.toMatchObject({
      code: 'operation-control-outcome-unknown',
    });
    expect(lifecycle.snapshot().states).toEqual(['available']);
    expect(reportLifecycle.mock.calls).toEqual([
      [
        'warn',
        `Provider proxy set action=preserve reason=containment_refused_live_claims fault=operation-control-failed subject=operation.cancel.v1 liveClaims=1 set=${setReference(authority.setIdentity)} error=mutation outcome unknown`,
      ],
    ]);
    expect(lifecycle.snapshot().operatorDispositions).toEqual([
      expect.objectContaining({
        disposition: 'held',
        method: 'operation.cancel.v1',
        waitingFor: 'operation-control-outcome-unknown',
      }),
    ]);
  });

  it('fences the exact route and waits for an admitted prepare journal publication before proof collection', async () => {
    const record = providerOperationRecord('executing');
    const staged = providerOperationRecord('executing', {
      operation: { ...record.operation, jobId: randomUUID(), operationId: randomUUID() },
      locator: record.locator,
    });
    if (!('providerRoot' in staged)) throw new Error('executing fixture did not retain its provider root');
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const mutationAdmission = providerOperationMutationAdmission(db);
    const mutationStarted = deferred<void>();
    const mutationMayFinish = deferred<void>();
    const mutation = mutationAdmission.run(
      `provider-operation:${staged.operation.operationId}`,
      async () => {
        mutationStarted.resolve();
        await mutationMayFinish.promise;
        insertProviderOperation(db, staged);
      },
      staged.operation,
    );
    await mutationStarted.promise;

    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const initiateControlClose = vi.fn(async () => undefined);
    const faults = createProviderProxyAuthorityFaultLatch();
    const base = fakeAuthority({ record, initiateControlClose });
    const cachedAuthority = createProviderProxyOperationAuthority({
      base: base as never,
      setIdentity: base.setIdentity,
      clients: {} as never,
      faults,
      mutationRpcTimeoutMs: 1_000,
    });
    const authority: DurableProviderProxyOperationAuthority = { ...cachedAuthority };
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      fenceProviderOperationMutations: (identity) => mutationAdmission.closeSet(identity),
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const acquisition = lifecycle.beginFreshAcquisition('operator-fence-route');
    if (acquisition.kind !== 'accepted') throw new Error(`expected admission, received ${acquisition.kind}`);
    lifecycle.acquisitionSucceeded(acquisition.slotId, authority, TEST_PUBLICATION_RECEIPT);
    expect(lifecycle.routeFor('operator-fence-route')).toBe(authority);
    expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority);

    faults.latch(terminalAuthorityFault());
    elapseOperatorExitObservations(clock, lifecycle, 30_000);
    const authorization = lifecycle.authorizeOperatorExit(providerProxySetAddress(authority.setIdentity));
    if (authorization.kind !== 'authorized') {
      throw new Error(`expected authorization, received ${authorization.kind}`);
    }
    expect(lifecycle.routeFor('operator-fence-route')).toBeNull();
    expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
    await expect(cachedAuthority.prepareOperation({} as never)).rejects.toMatchObject({
      code: 'operator-exit-fenced',
    });

    let proofSettled = false;
    const process = containmentProofRuntime(authority.setIdentity, { guardian: 'absent', reaper: 'absent' });
    const proofPending = createProviderProxySetContainmentProver(process.runtime)
      .collectContainmentProof(authorization.capability.containmentProofAuthorization, db, new AbortController().signal)
      .then((proof) => {
        proofSettled = true;
        return proof;
      });
    await drainMicrotasks();
    expect(proofSettled).toBe(false);
    expect(initiateControlClose).not.toHaveBeenCalled();
    expect(process.readProcessIncarnation).not.toHaveBeenCalled();

    mutationMayFinish.resolve();
    await mutation;
    const proof = await proofPending;
    expect(initiateControlClose).toHaveBeenCalledOnce();
    expect(inspectProviderProxySetContainmentProof(proof)?.evidence).toEqual(
      expect.objectContaining({ kind: 'reap-required', recordedRoots: [staged.providerRoot] }),
    );
    db.close();
  });

  it('reaps the recorded proxy group and roots only after both enforcers are absent', async () => {
    const record = providerOperationRecord('executing');
    if (!('providerRoot' in record)) throw new Error('executing fixture did not retain its provider root');
    const db = containmentProofDatabase(record);
    const identity = providerProxySetIdentityFromRecord(record);
    const process = containmentProofRuntime(identity, { guardian: 'absent', reaper: 'absent' });
    const reapedTargets: number[] = [];
    const reapRecordedContainment = vi.fn<ProviderProxySetRecordedContainmentReaper>(
      async (identity, proof, _signal, onSignal) => {
        const evidence = providerProxySetContainmentEvidenceFor(proof, identity);
        if (evidence.kind !== 'reap-required') throw new Error(`expected reap-required, received ${evidence.kind}`);
        reapedTargets.push(-evidence.containment.processGroupId, ...evidence.recordedRoots.map(({ pid }) => pid));
        onSignal('SIGTERM');
        return {
          kind: 'containment-absent',
          disappearanceReceipt: 'real-proof-recorded-containment-absent',
        };
      },
    );
    const harness = await authorizedOperatorExitForProof(record, reapRecordedContainment);

    try {
      const proof = await createProviderProxySetContainmentProver(process.runtime).collectContainmentProof(
        harness.capability.containmentProofAuthorization,
        db,
        new AbortController().signal,
      );
      await expect(harness.lifecycle.completeOperatorExit(harness.capability, proof, false)).resolves.toEqual(
        expect.objectContaining({
          kind: 'contained',
          disappearanceReceipt: 'real-proof-recorded-containment-absent',
          effect: {
            signalsSent: ['SIGTERM'],
            containmentAbsent: true,
            representationAction: 'absence-release-started',
          },
        }),
      );

      expect(inspectProviderProxySetContainmentProof(proof)?.evidence).toEqual({
        kind: 'reap-required',
        containment: {
          pid: identity.proxyPid,
          incarnation: identity.proxyIncarnation,
          processGroupId: identity.proxyProcessGroupId,
        },
        recordedRoots: [record.providerRoot],
      });
      expect(reapedTargets).toEqual([-identity.proxyProcessGroupId, record.providerRoot.pid]);
      expect(reapRecordedContainment).toHaveBeenCalledOnce();
      expect(harness.stopAndReap).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('refuses signal authorization when process identity is unobservable before any signal', async () => {
    const record = providerOperationRecord('executing');
    const reapRecordedContainment = vi.fn<ProviderProxySetRecordedContainmentReaper>(async () => ({
      kind: 'identity-unobservable',
      signalDelivered: false,
    }));
    const harness = await authorizedOperatorExitForProof(record, reapRecordedContainment);
    const setIdentity = providerProxySetAddress(providerProxySetIdentityFromRecord(record));
    const proof = await operatorContainmentProof(harness.capability, containmentEvidence('must-not-be-minted'));

    await expect(harness.lifecycle.completeOperatorExit(harness.capability, proof, false)).resolves.toEqual({
      kind: 'identity-unobservable',
      setIdentity,
      effect: noOperatorExitEffect,
    });

    expect(harness.lifecycle.snapshot()).toEqual(
      expect.objectContaining({
        represented: 1,
        operatorSets: expect.arrayContaining([
          expect.objectContaining({
            setIdentity,
            operatorExit: { kind: 'refused', ground: 'identity-unobservable' },
          }),
        ]),
        operatorDispositions: expect.arrayContaining([
          expect.objectContaining({
            incidentReason: 'operator_exit_identity_unobservable',
            waitingFor: 'operator-abandonment',
          }),
        ]),
      }),
    );
    expect(harness.lifecycle.authorizeOperatorExit(setIdentity).kind).toBe('authorized');
  });

  it('rejects a root published after reaping instead of minting a disappearance receipt', async () => {
    const record = providerOperationRecord('executing');
    const lateRecord = providerOperationRecord('executing', {
      operation: { ...record.operation, jobId: randomUUID(), operationId: randomUUID() },
      locator: record.locator,
    });
    if (!('providerRoot' in lateRecord)) throw new Error('executing fixture did not retain its provider root');
    const lateRootRecord = {
      ...lateRecord,
      providerRoot: { pid: lateRecord.providerRoot.pid + 1, incarnation: testIncarnation(1_004) },
    };
    const db = containmentProofDatabase(record);
    const mutationAdmission = providerOperationMutationAdmission(db);
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const disappearanceConsumer = vi.fn(async () => ({}) as never);
    const reapRecordedContainment = vi.fn<ProviderProxySetRecordedContainmentReaper>(async (identity, proof) => {
      insertProviderOperationOutsideAdmission(db, lateRootRecord);
      const currentness = verifyProviderProxySetContainmentProofCurrent(proof, identity);
      return currentness.kind === 'current'
        ? { kind: 'containment-absent', disappearanceReceipt: 'must-not-be-minted' }
        : currentness;
    });
    const authority = fakeAuthority({ record });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: disappearanceConsumer },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reapRecordedContainment,
      fenceProviderOperationMutations: (identity) => mutationAdmission.closeSet(identity),
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority, TEST_PUBLICATION_RECEIPT);
    latchAuthorityFault(authority, terminalAuthorityFault());
    elapseOperatorExitObservations(clock, lifecycle, 30_000);
    const authorization = lifecycle.authorizeOperatorExit(providerProxySetAddress(authority.setIdentity));
    if (authorization.kind !== 'authorized') {
      throw new Error(`expected authorization, received ${authorization.kind}`);
    }

    try {
      const proof = await createProviderProxySetContainmentProver(
        containmentProofRuntime(authority.setIdentity, { guardian: 'absent', reaper: 'absent' }).runtime,
      ).collectContainmentProof(
        authorization.capability.containmentProofAuthorization,
        db,
        new AbortController().signal,
      );
      await expect(lifecycle.completeOperatorExit(authorization.capability, proof, false)).resolves.toEqual({
        kind: 'authorization-stale',
        setIdentity: providerProxySetAddress(authority.setIdentity),
        effect: noOperatorExitEffect,
      });
      expect(reapRecordedContainment).toHaveBeenCalledOnce();
      expect(disappearanceConsumer).not.toHaveBeenCalled();
      expect(lifecycle.snapshot().represented).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rejects a proof with the same address but a different process identity before reaping', async () => {
    const record = providerOperationRecord('executing');
    const reapRecordedContainment = vi.fn<ProviderProxySetRecordedContainmentReaper>(async () => ({
      kind: 'containment-absent',
      disappearanceReceipt: 'must-not-reap',
    }));
    const harness = await authorizedOperatorExitForProof(record, reapRecordedContainment);
    const identityA = harness.capability.setIdentity;
    const identityB = {
      ...identityA,
      proxyPid: identityA.proxyPid + 10,
      proxyIncarnation: testIncarnation('different-full-identity'),
      proxyProcessGroupId: identityA.proxyProcessGroupId + 10,
    };
    const foreignMutationFence = new ProviderOperationMutationAdmission().closeSet(identityB);
    const foreignAuthorization = authorizeProviderProxySetContainmentProof(identityB, {
      mutationFence: foreignMutationFence,
      closeAdmission: async () => undefined,
    });
    const foreignProof = await sealedContainmentProof(
      identityB,
      foreignAuthorization,
      containmentEvidence('foreign-set-absence'),
    );

    expect(harness.mutationFence.isHeld()).toBe(true);
    await expect(harness.lifecycle.completeOperatorExit(harness.capability, foreignProof, false)).rejects.toThrow(
      'provider_proxy_set_containment_proof_identity_mismatch',
    );
    expect(harness.mutationFence.isHeld()).toBe(false);
    expect(reapRecordedContainment).not.toHaveBeenCalled();
    expect(harness.stopAndReap).not.toHaveBeenCalled();
    expect(harness.lifecycle.snapshot().represented).toBe(1);
  });

  it('rejects a proof minted for the same full identity under a different operator authorization', async () => {
    const record = providerOperationRecord('executing');
    const reapRecordedContainment = vi.fn<ProviderProxySetRecordedContainmentReaper>(async () => ({
      kind: 'containment-absent',
      disappearanceReceipt: 'must-not-reap',
    }));
    const harness = await authorizedOperatorExitForProof(record, reapRecordedContainment);
    const otherMutationFence = new ProviderOperationMutationAdmission().closeSet(harness.capability.setIdentity);
    const otherAuthorization = authorizeProviderProxySetContainmentProof(harness.capability.setIdentity, {
      mutationFence: otherMutationFence,
      closeAdmission: async () => undefined,
    });
    const proof = await sealedContainmentProof(
      harness.capability.setIdentity,
      otherAuthorization,
      containmentEvidence('wrong-authorization'),
    );

    await expect(harness.lifecycle.completeOperatorExit(harness.capability, proof, false)).rejects.toThrow(
      'provider_proxy_set_containment_proof_authorization_mismatch',
    );
    expect(reapRecordedContainment).not.toHaveBeenCalled();
    expect(harness.stopAndReap).not.toHaveBeenCalled();
    expect(harness.lifecycle.snapshot().represented).toBe(1);
  });

  it('installs absence delivery before closing controls and begins durable delivery in the same turn', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const closeObservations: Array<readonly string[]> = [];
    const containmentDisappeared = vi.fn(() => new Promise<never>(() => undefined));
    const authority = fakeAuthority({
      record,
      stopAndReap: () => new Promise<never>(() => undefined),
      initiateControlClose: () => {
        closeObservations.push(lifecycle.snapshot().states);
        return Promise.resolve();
      },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority, TEST_PUBLICATION_RECEIPT);
    latchAuthorityFault(authority, terminalAuthorityFault());

    lifecycle.containmentAbsent(authority.setIdentity, 'public-proof-receipt');

    expect(closeObservations).toEqual([['absence-delivery-pending']]);
    expect(containmentDisappeared).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({ represented: 1, states: ['absence-delivery-pending'], pendingOperationCounts: [1] }),
    );
    expect(lifecycle.liveSets()).toEqual([authority]);
    expect(() => lifecycle.containmentAbsent(authority.setIdentity, 'public-proof-receipt')).not.toThrow();
    expect(() => lifecycle.containmentAbsent(authority.setIdentity, 'conflicting-receipt')).toThrow(
      'provider_proxy_containment_absence_conflict',
    );
  });

  it('retains absence and its capsule until every captured operation acknowledges durable disposition', async () => {
    const first = providerOperationRecord('executing');
    const second = providerOperationRecord('executing', {
      operation: { ...first.operation, jobId: randomUUID(), operationId: randomUUID() },
      locator: first.locator,
    });
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([first, second]);
    const secondAcceptance = deferred<DisappearanceDeliveryAttemptOutcome>();
    const secondDeliveryStarted = deferred<void>();
    const capsuleRetired = deferred<void>();
    const retireCapsule = vi.fn(async () => {
      capsuleRetired.resolve();
      return { kind: 'retired' as const };
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: {
        containmentDisappeared: (notice) =>
          notice.operation.jobId === first.operation.jobId
            ? Promise.resolve({
                kind: 'accepted',
                acceptance: {
                  kind: 'accepted',
                  operation: notice.operation,
                  disposition: 'terminalization-committed',
                },
              })
            : (() => {
                secondDeliveryStarted.resolve();
                return secondAcceptance.promise;
              })(),
      },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const authority = fakeAuthority({
      record: first,
      stopAndReap: async () => ({ disappearanceReceipt: 'exact-absence' }),
    });
    lifecycle.registerInheritedSet(authority, TEST_PUBLICATION_RECEIPT, '/capsules/set.handoff.json');

    latchAuthorityFault(authority, terminalAuthorityFault());
    await secondDeliveryStarted.promise;
    await drainMicrotasks();
    expect(lifecycle.snapshot().pendingOperationCounts).toEqual([1]);
    expect(lifecycle.snapshot().represented).toBe(1);
    expect(retireCapsule).not.toHaveBeenCalled();

    secondAcceptance.resolve({
      kind: 'accepted',
      acceptance: {
        kind: 'accepted',
        operation: second.operation,
        disposition: 'terminalization-committed',
      },
    });
    await capsuleRetired.promise;
    await drainMicrotasks();
    expect(lifecycle.snapshot().represented).toBe(0);

    expect(retireCapsule).toHaveBeenCalledWith('/capsules/set.handoff.json');
  });

  it('ignores a proof result that arrives after its containment attempt token was retired', async () => {
    const clock = new ManualClock();
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const lateProof = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['stopAndReap']>>>();
    const consumer = vi.fn(async () => ({}) as never);
    const authority = fakeAuthority({ stopAndReap: () => lateProof.promise });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: consumer },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const admission = lifecycle.beginFreshAcquisition('route');
    if (admission.kind !== 'accepted') throw new Error('expected acquisition admission');
    lifecycle.acquisitionSucceeded(admission.slotId, authority, TEST_PUBLICATION_RECEIPT);
    latchAuthorityFault(authority, terminalAuthorityFault());

    clock.elapse(30_000);
    clock.runDue();
    expect(lifecycle.snapshot().states).toEqual(['containment-wait']);

    lateProof.resolve({ disappearanceReceipt: 'stale-attempt-receipt' });
    await Promise.resolve();
    await Promise.resolve();

    expect(lifecycle.snapshot()).toEqual(expect.objectContaining({ represented: 1, states: ['containment-wait'] }));
    expect(consumer).not.toHaveBeenCalled();
  });
});
