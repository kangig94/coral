import { proxyOperationInspectResultSchema } from '#src/provider-proxy/protocol.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createProviderProxySetInheritance } from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import { registerProviderProxySetForTest } from '#tests/helpers/provider-proxy-registration.js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimerHandle } from '#src/infra/port-types.js';
import { type ProcessIncarnation, type ProcessLiveness } from '#src/infra/node-process.js';
import { ControlClientError, controlExchangeForTest, type ControlClient } from '#src/provider-proxy/control-client.js';
import {
  createProviderProxyOperationAuthority,
  providerProxyOperationControlIsHeld,
  ProviderProxyOperationControlHeldError,
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
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import {
  ProviderProxySetLifecycle,
  type ProviderProxySetLifecycleDeps,
  type ProviderProxySetOperatorExitCapability,
} from '#src/coordinator/services/provider-proxy-set/index.js';
import { ProviderProxySetOperatorDispositionStore } from '#src/coordinator/services/provider-proxy-set/operator-disposition-store.js';
import {
  createProviderProxySetRecordedContainmentReaper,
  type ProviderProxySetRecordedContainmentReaper,
} from '#src/coordinator/services/provider-proxy-set/recorded-containment-reaper.js';
import type { ProviderContainmentDisappearanceConsumer } from '#src/coordinator/services/provider-containment-disappearance.js';
import {
  providerProxySetAddress,
  providerProxySetIdentityFromRecord,
  ProviderProxySetInheritanceCorruptionError,
  type ProviderProxySetIdentity,
} from '#src/coordinator/services/provider-proxy-set/identity.js';
import type { ProviderProxySetContainmentEvidence } from '#src/provider-proxy/containment-proof-contract.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { FailureDomainObservation } from '#src/infra/failure-domain.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  insertProviderOperation,
  providerOperationMutationAdmission,
  ProviderOperationMutationAdmission,
  type ProviderOperationMutationSetFence,
} from '#src/store/provider-operation-journal.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import {
  createTestProviderProxyContainmentProofProducer,
  createTestProviderProxyRecoveryDispatcher,
} from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';
import {
  unexercisedControllerSuccessionControls,
  unexercisedProviderHostControls,
} from '#tests/helpers/provider-host-controls.js';
import { retireProviderHandoffCapsule } from '#src/coordinator/services/provider-proxy-capsule-discovery.js';
import type * as MonotonicClockModule from '#src/infra/monotonic-clock.js';
import { PROXY_TEARDOWN_RESERVE_MS } from '#src/provider-proxy/orphan-deadline.js';
import { ProcessContainmentInvariantError } from '#src/infra/process-containment.js';
import {
  createOwnedProviderProxyAcquisitionControlSession,
  providerProxyControlSessionOwner,
} from '#src/coordinator/live/provider-proxy/control-session.js';
import { isProviderProxyRecoveryFatalError } from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import { handoffCapsuleV3Schema } from '#src/provider-proxy/handoff-capsule.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { heartbeatObservationFromExchange } from '#src/provider-proxy/heartbeat-observation.js';

const containmentClock = vi.hoisted(() => ({ milliseconds: null as bigint | null }));
vi.mock('#src/infra/monotonic-clock.js', async (original) => {
  const actual = await original<typeof MonotonicClockModule>();
  return {
    ...actual,
    createMonotonicClock: (scope: symbol, dependencies?: Parameters<typeof actual.createMonotonicClock>[1]) =>
      actual.createMonotonicClock(
        scope,
        containmentClock.milliseconds === null
          ? dependencies
          : {
              ...dependencies,
              readMilliseconds: () => containmentClock.milliseconds ?? 0n,
              sleep: async (milliseconds: number) => {
                containmentClock.milliseconds = (containmentClock.milliseconds ?? 0n) + BigInt(milliseconds);
              },
            },
      ),
  };
});

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
const reapContainmentEvidence: ProviderProxySetRecordedContainmentReaper = async () => ({
  kind: 'containment-absent',
  disappearanceReceipt: 'fixture-containment-absence',
});
const ignoreControlEstablished = (): void => undefined;
const containmentOperationPolicy: ContainmentRequiredControlCallPolicy = {
  method: 'operation.cancel.v1',
  phase: 'prestart-cleanup-pending',
  effect: 'mutation',
  indeterminate: 'requires-containment',
  preEffectProtocolCodes: new Set(),
};

function terminalAuthorityFault(): Extract<ProviderProxyAuthorityFault, { kind: 'heartbeat-failed' }> {
  return {
    kind: 'heartbeat-failed',
    role: 'proxy',
    method: 'control.heartbeat.v1',
    terminalReason: 'teardown-latched',
    error: 'teardown latched',
  };
}

function lifecycleFor(deps: {
  claims: ProviderProxySetClaimMirror;
  time: ManualClock;
  controlEstablished: ProviderProxySetLifecycleDeps['controlEstablished'];
  disappearanceConsumer: ProviderContainmentDisappearanceConsumer;
  proveContainmentAbsent: (
    identity: ReturnType<typeof providerProxySetIdentityFromRecord>,
    signal: AbortSignal,
  ) => Promise<ProviderProxySetContainmentEvidence>;
  reapRecordedContainment?: ProviderProxySetRecordedContainmentReaper;
  failureDomainContainment?: ProviderProxySetLifecycleDeps['failureDomainContainment'];
  fenceProviderOperationMutations?: ProviderProxySetLifecycleDeps['fenceProviderOperationMutations'];
  reportLifecycle?: ProviderProxySetLifecycleDeps['reportLifecycle'];
  capacity?: ProviderProxySetLifecycleDeps['capacity'];
  onSlotReleased?: ProviderProxySetLifecycleDeps['onSlotReleased'];
  operatorDispositionStore?: ProviderProxySetOperatorDispositionStore;
}): ProviderProxySetLifecycle {
  const mutationAdmission = new ProviderOperationMutationAdmission();
  const collectProof = async (identity: ReturnType<typeof providerProxySetIdentityFromRecord>, signal: AbortSignal) => {
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    sealedProofDatabases.push(db);
    const mutationFence = mutationAdmission.closeSet(identity);
    const authorization = authorizeProviderProxySetContainmentProof(identity, {
      mutationFence,
      closeAdmission: async () => {
        if (mutationFence.kind === 'holding') await mutationFence.retryAfter;
      },
    });
    const evidence = await deps.proveContainmentAbsent(identity, signal);
    const observations =
      evidence.kind === 'enforcers-observed'
        ? {
            guardian: evidence.observations.find(({ role }) => role === 'guardian')?.observation ?? 'unknown',
            reaper: evidence.observations.find(({ role }) => role === 'reaper')?.observation ?? 'unknown',
          }
        : { guardian: 'absent' as const, reaper: 'absent' as const };
    return createProviderProxySetContainmentProver(
      containmentProofRuntime(identity, observations, 'unknown').runtime,
    ).collectContainmentProof(authorization, db, signal);
  };
  const lifecycle = new ProviderProxySetLifecycle({
    buildSetId: FIXTURE_BUILD_SET_ID,
    claims: deps.claims,
    capacity: deps.capacity ?? { maxSets: 4, idleRetirement: { kind: 'never' } },
    ...(deps.onSlotReleased === undefined ? {} : { onSlotReleased: deps.onSlotReleased }),
    time: deps.time,
    controlEstablished: deps.controlEstablished,
    recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
      'containment-proof': ({ identity, signal }) => collectProof(identity, signal),
      'capsule-retirement': () => ({ kind: 'retired' }),
      'disappearance-consumer': ({ notice }) => deps.disappearanceConsumer.containmentDisappeared(notice),
    }),
    reapRecordedContainment: deps.reapRecordedContainment ?? reapContainmentEvidence,
    ...(deps.failureDomainContainment === undefined ? {} : { failureDomainContainment: deps.failureDomainContainment }),
    reportLifecycle: deps.reportLifecycle ?? (() => undefined),
    operatorDispositionStore:
      deps.operatorDispositionStore ??
      new ProviderProxySetOperatorDispositionStore(new InMemoryStorage(deps.time), DURABLE_DISPOSITION_RUN_DIR),
    writerIncarnation: randomUUID(),
    collectOperatorDispositionContainmentProof: collectProof,
    reobserveAcquisitionContainment: async () => ({
      kind: 'held',
      observation: 'unknown',
      reason: 'unobserved test acquisition',
    }),
    fenceProviderOperationMutations:
      deps.fenceProviderOperationMutations ?? ((identity) => mutationAdmission.closeSet(identity)),
  });
  lifecycle.activateDurableOperatorDispositions();
  return lifecycle;
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function setReference(identity: ReturnType<typeof providerProxySetIdentityFromRecord>): string {
  return `proxyInstanceId=${identity.proxyInstanceId},buildSetId=${identity.buildSetId}`;
}

async function drainMicrotasks(count = 10): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

class ManualClock {
  nowMs = 0;
  readonly timers: Array<{ at: number; active: boolean; callback: () => void }> = [];

  now = (): number => this.nowMs;
  monotonicNow = (): bigint => BigInt(this.nowMs);

  setTimeout = (callback: () => void, ms: number): TimerHandle => {
    const timer = { at: this.nowMs + ms, active: true, callback };
    this.timers.push(timer);
    return {
      unref: () => undefined,
      __timer: timer,
    } as TimerHandle;
  };

  clearTimeout = (handle: TimerHandle | null): void => {
    const timer = (handle as (TimerHandle & { __timer?: { active: boolean } }) | null)?.__timer;
    if (timer !== undefined) timer.active = false;
  };

  elapse(ms: number): void {
    this.nowMs += ms;
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

function fakeAuthority(options: {
  record: ReturnType<typeof providerOperationRecord>;
  faults?: ProviderProxyAuthorityFaultLatch;
  stopAndReap?: DurableProviderProxyOperationAuthority['stopAndReap'];
  initiateControlClose?: DurableProviderProxyOperationAuthority['initiateControlClose'];
  adoptionWindowMs?: number;
}): DurableProviderProxyOperationAuthority {
  const record = options.record;
  const faults = options.faults ?? createProviderProxyAuthorityFaultLatch();
  const stopAndReap = options.stopAndReap ?? (async () => ({ unconfirmed: 'not proved' }) as const);
  const unused = async (): Promise<never> => {
    throw new Error('unexpected operation call');
  };
  return {
    proxyInstanceId: record.operation.proxyInstanceId,
    providerHosts: unexercisedProviderHostControls,
    ...unexercisedControllerSuccessionControls,
    autonomousDeadline: {
      orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
      adoptionWindowMs: options.adoptionWindowMs ?? Number.MAX_SAFE_INTEGER,
      heartbeatHoldBound: {
        spanMs: Number.MAX_SAFE_INTEGER,
        materialSchedulerLatenessMs: Math.floor(Number.MAX_SAFE_INTEGER / 4),
      },
    },
    setIdentity: providerProxySetIdentityFromRecord(record),
    faulted: faults.faulted,
    onFault: faults.onFault,
    onIncident: faults.onIncident,
    redeemControl: unused,
    promoteControl: unused,
    registerSuccessionOperation: async () => ({ kind: 'registered' }),
    stopAndReap,
    commitContainment: async (signal) => {
      const result = await stopAndReap(signal);
      return 'disappearanceReceipt' in result
        ? { kind: 'containment-absent', disappearanceReceipt: result.disappearanceReceipt }
        : { kind: 'outcome-unknown', error: result.unconfirmed };
    },
    stopHeartbeats: () => undefined,
    initiateControlClose: options.initiateControlClose ?? (async () => undefined),
    prepareOperation: unused,
    inspectOperation: unused,
    authorizeOperation: unused,
    activatePreparedOperation: unused,
    attachOperation: unused,
    cancelOperation: unused,
    settleOperation: unused,
    sendOperation: unused,
    buildOperationControl: () => ({ stop: unused }),
  };
}

function containmentProofDatabase(record: ReturnType<typeof providerOperationRecord>): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  insertProviderOperation(db, record);
  return db;
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

async function authorizedOperatorExitForProof(
  record: ReturnType<typeof providerOperationRecord>,
  reapRecordedContainment: ProviderProxySetRecordedContainmentReaper,
  failureDomainContainment?: ProviderProxySetLifecycleDeps['failureDomainContainment'],
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
    ...(failureDomainContainment === undefined ? {} : { failureDomainContainment }),
    fenceProviderOperationMutations: (identity) => {
      mutationFence = mutationAdmission.closeSet(identity);
      return mutationFence;
    },
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
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

function operationRecoveryFixture(
  inspectOperation: DurableProviderProxyOperationAuthority['inspectOperation'],
  adoptionWindowMs?: number,
) {
  const record = providerOperationRecord('executing');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([record]);
  const faults = createProviderProxyAuthorityFaultLatch();
  const stopAndReap = vi.fn<DurableProviderProxyOperationAuthority['stopAndReap']>(async () => ({
    unconfirmed: 'not absent',
  }));
  const base = fakeAuthority({ record, faults, stopAndReap, adoptionWindowMs });
  const authority = {
    ...createProviderProxyOperationAuthority({
      base: base as never,
      setIdentity: base.setIdentity,
      clients: {} as never,
      faults,
      mutationRpcTimeoutMs: 1_000,
    }),
    inspectOperation,
  };
  const time = new ManualClock();
  const dispositionStore = new ProviderProxySetOperatorDispositionStore(
    new InMemoryStorage(time),
    DURABLE_DISPOSITION_RUN_DIR,
  );
  const lifecycle = lifecycleFor({
    claims,
    time,
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
    operatorDispositionStore: dispositionStore,
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
  return { record, claims, faults, authority, time, lifecycle, stopAndReap, dispositionStore };
}

function operationCancellationFault(operation: ReturnType<typeof providerOperationRecord>['operation']) {
  return {
    kind: 'operation-control-failed' as const,
    policy: containmentOperationPolicy,
    error: 'unknown cancellation',
    inspection: { operation, prepareAttemptKey: 'b'.repeat(64) },
  };
}

function releasedAttempt(fault: ReturnType<typeof operationCancellationFault>) {
  return {
    state: 'released-never-started' as const,
    operation: fault.inspection.operation,
    prepareAttemptNumber: 1,
    prepareAttemptKey: fault.inspection.prepareAttemptKey,
  };
}

function recordIncompatibleHeartbeat(fixture: ReturnType<typeof operationRecoveryFixture>): void {
  const error = new ControlClientError('control_call_failed', 'unsupported heartbeat', 'remote-response', {
    kind: 'json-rpc-error',
    jsonRpcCode: -32601,
    protocolCode: 'method_not_found',
    admissionReason: null,
    heartbeatRefusal: null,
  });
  fixture.lifecycle.recordAuthorityIncident(fixture.authority.setIdentity, {
    kind: 'heartbeat-observation',
    role: 'proxy',
    method: 'control.heartbeat.v1',
    schedulerLatenessMs: 0,
    observation: heartbeatObservationFromExchange(
      controlExchangeForTest({
        kind: 'response',
        response: {
          kind: 'refusal',
          error,
          failure: {
            kind: 'json-rpc-error',
            jsonRpcCode: -32601,
            protocolCode: 'method_not_found',
            admissionReason: null,
            heartbeatRefusal: null,
          },
        },
      }),
    ),
  });
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
    registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);

    faults.latch({
      kind: 'operation-control-failed',
      policy: containmentOperationPolicy,
      error: 'mutation outcome unknown',
    });

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(providerProxyOperationControlIsHeld(authority)).toBe(true);
    expect(providerProxyOperationControlIsHeld(underlyingAuthority)).toBe(true);
    expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
    expect(lifecycle.acquisitionFor(authority.setIdentity)).toMatchObject({
      kind: 'owned-pending',
      owner: 'provider-proxy-set-lifecycle',
    });
    await expect(underlyingAuthority.cancelOperation(record.operation, 1, 'b'.repeat(64))).rejects.toMatchObject({
      code: 'operation-control-outcome-unknown',
    });
    const heldSend = underlyingAuthority.sendOperation(record.operation, {
      text: 'Change direction',
      clientMessageId: '33333333-3333-4333-8333-333333333333',
    });
    await expect(heldSend).rejects.toBeInstanceOf(ProviderProxyOperationControlHeldError);
    await expect(heldSend).rejects.toMatchObject({ code: 'operation-control-outcome-unknown' });
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

  it('should restore dispatch after exact cancellation release evidence and rearm subsequent faults', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const faults = createProviderProxyAuthorityFaultLatch();
    const base = fakeAuthority({ record });
    const proxy = {
      exchange: vi.fn(async () =>
        controlExchangeForTest({
          kind: 'response',
          response: {
            kind: 'result',
            value: {
              state: 'released-never-started',
              operation: record.operation,
              prepareAttemptNumber: 1,
              prepareAttemptKey: 'b'.repeat(64),
            },
          },
        }),
      ),
    };
    const underlying = createProviderProxyOperationAuthority({
      base: base as never,
      setIdentity: base.setIdentity,
      clients: { proxy } as never,
      faults,
      mutationRpcTimeoutMs: 1_000,
    });
    const authority = { ...underlying };
    const lifecycle = lifecycleFor({
      claims,
      time: new ManualClock(),
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: vi.fn() },
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
    faults.latch({
      kind: 'operation-control-failed',
      policy: containmentOperationPolicy,
      error: 'unknown cancellation',
      inspection: { operation: record.operation, prepareAttemptKey: 'b'.repeat(64) },
    });
    await drainMicrotasks();
    expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority);
    expect(providerProxyOperationControlIsHeld(underlying)).toBe(false);
    expect(lifecycle.snapshot().operatorDispositions).toEqual([]);
    expect(claims.operationsFor(authority.setIdentity)).toEqual([record.operation]);
    faults.latch({ kind: 'operation-control-failed', policy: containmentOperationPolicy, error: 'next unknown' });
    expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
    expect(providerProxyOperationControlIsHeld(underlying)).toBe(true);
  });

  it.each(['absent', 'late-release'] as const)(
    'should automatically contain a %s observation despite live claims and healthy control',
    async (observation) => {
      const record = providerOperationRecord('executing');
      const claims = new ProviderProxySetClaimMirror();
      claims.initialize([record]);
      const faults = createProviderProxyAuthorityFaultLatch();
      const stopAndReap = vi.fn(async () => ({ unconfirmed: 'not absent' }) as const);
      const inspected = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
      if (observation === 'absent') inspected.resolve({ state: 'absent' });
      const inspectOperation = vi.fn(() => inspected.promise);
      const authority = { ...fakeAuthority({ record, faults, stopAndReap }), inspectOperation };
      const time = new ManualClock();
      const lifecycle = lifecycleFor({
        claims,
        time,
        controlEstablished: ignoreControlEstablished,
        disappearanceConsumer: { containmentDisappeared: vi.fn() },
        proveContainmentAbsent: noContainmentProof,
      });
      lifecycle.initializeClaimSlots();
      lifecycle.completeStartupDiscovery();
      registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
      faults.latch({
        kind: 'operation-control-failed',
        policy: containmentOperationPolicy,
        error: 'unknown cancellation',
        inspection: { operation: record.operation, prepareAttemptKey: 'b'.repeat(64) },
      });
      await drainMicrotasks();
      expect(lifecycle.snapshot().operatorDispositions).toEqual([
        expect.objectContaining({ waitingFor: 'operation-control-outcome-unknown', boundMs: 30_000 }),
      ]);
      expect(stopAndReap).not.toHaveBeenCalled();
      for (let second = 0; second < 29; second += 1) {
        time.elapse(1_000);
        time.runDue();
        await drainMicrotasks();
      }
      time.elapse(999);
      time.runDue();
      await drainMicrotasks();
      expect(stopAndReap).not.toHaveBeenCalled();
      time.elapse(1);
      time.runDue();
      await drainMicrotasks();
      inspected.resolve({
        state: 'released-never-started',
        operation: record.operation,
        prepareAttemptNumber: 1,
        prepareAttemptKey: 'b'.repeat(64),
      });
      await drainMicrotasks();
      expect(inspectOperation).toHaveBeenCalledWith(record.operation, 'b'.repeat(64));
      expect(stopAndReap).toHaveBeenCalledOnce();
      expect(lifecycle.snapshot().states).toEqual(['containing']);
      expect(claims.operationsFor(authority.setIdentity)).toEqual([record.operation]);
      expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
      expect(providerProxyOperationControlIsHeld(authority)).toBe(true);
      expect(lifecycle.snapshot().operatorDispositions).toEqual([
        expect.objectContaining({
          disposition: 'awaiting-containment-absence',
          waitingFor: 'containment-outcome-unknown',
        }),
      ]);
    },
  );

  it.each(['same-attempt', 'different-attempt', 'different-operation'] as const)(
    'should retain every overlapping %s mutation until all observations decide',
    async (overlap) => {
      const first = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
      const second = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
      const fixture = operationRecoveryFixture(
        vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      );
      const a = operationCancellationFault(fixture.record.operation);
      const b = operationCancellationFault({
        ...fixture.record.operation,
        operationId: overlap === 'different-operation' ? randomUUID() : fixture.record.operation.operationId,
      });
      if (overlap === 'different-attempt') b.inspection.prepareAttemptKey = 'c'.repeat(64);
      fixture.faults.latch(a);
      fixture.faults.latch(b);
      fixture.time.elapse(1_000);
      fixture.time.runDue();
      first.resolve(releasedAttempt(a));
      await drainMicrotasks();
      expect(fixture.lifecycle.authorityFor(fixture.authority.setIdentity)).toBeNull();
      expect(providerProxyOperationControlIsHeld(fixture.authority)).toBe(true);
      expect(fixture.lifecycle.snapshot().operatorDispositions).toEqual([
        expect.objectContaining({ waitingFor: 'operation-control-outcome-unknown' }),
      ]);
      if (overlap === 'different-operation') {
        for (let second = 1; second < 30; second += 1) {
          fixture.time.elapse(1_000);
          fixture.time.runDue();
          await drainMicrotasks();
        }
        expect(fixture.stopAndReap).toHaveBeenCalledOnce();
        expect(providerProxyOperationControlIsHeld(fixture.authority)).toBe(true);
        return;
      }
      second.resolve(releasedAttempt(b));
      await drainMicrotasks();
      expect(fixture.lifecycle.authorityFor(fixture.authority.setIdentity)).toBe(fixture.authority);
      expect(providerProxyOperationControlIsHeld(fixture.authority)).toBe(false);
    },
  );

  it.each(['teardown-latched', 'local-failure'] as const)(
    'should process a concurrent terminal heartbeat %s before inspection decides',
    async (terminalReason) => {
      const inspected = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
      const fixture = operationRecoveryFixture(vi.fn(() => inspected.promise));
      const fault = operationCancellationFault(fixture.record.operation);
      fixture.faults.latch(fault);
      fixture.faults.latch({ ...terminalAuthorityFault(), terminalReason });
      inspected.resolve(releasedAttempt(fault));
      await drainMicrotasks();
      expect(fixture.lifecycle.authorityFor(fixture.authority.setIdentity)).toBeNull();
      expect(providerProxyOperationControlIsHeld(fixture.authority)).toBe(true);
      expect(fixture.lifecycle.snapshot().states).toEqual([
        terminalReason === 'teardown-latched' ? 'containing' : 'reattachment-hold',
      ]);
    },
  );

  it('should give a new operation hold its full bound after an older heartbeat gate expires', async () => {
    const fixture = operationRecoveryFixture(vi.fn(async () => ({ state: 'absent' }) as const));
    recordIncompatibleHeartbeat(fixture);
    elapseOperatorExitObservations(fixture.time, fixture.lifecycle, 30_000);
    fixture.faults.latch(operationCancellationFault(fixture.record.operation));
    await drainMicrotasks();
    expect(fixture.stopAndReap).not.toHaveBeenCalled();
    for (let second = 0; second < 29; second += 1) {
      fixture.time.elapse(1_000);
      fixture.time.runDue();
      await drainMicrotasks();
    }
    fixture.time.elapse(999);
    fixture.time.runDue();
    await drainMicrotasks();
    expect(fixture.stopAndReap).not.toHaveBeenCalled();
    fixture.time.elapse(1);
    fixture.time.runDue();
    await drainMicrotasks();
    expect(fixture.stopAndReap).toHaveBeenCalledOnce();
  });

  it('should preserve a coexisting heartbeat operator gate after operation recovery', async () => {
    const inspected = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
    const fixture = operationRecoveryFixture(vi.fn(() => inspected.promise));
    recordIncompatibleHeartbeat(fixture);
    elapseOperatorExitObservations(fixture.time, fixture.lifecycle, 10_000);
    const address = providerProxySetAddress(fixture.authority.setIdentity);
    const before = fixture.lifecycle.authorizeOperatorExit(address);
    const dispositionsBefore = fixture.lifecycle.snapshot().operatorDispositions;
    const fault = operationCancellationFault(fixture.record.operation);
    fixture.faults.latch(fault);
    inspected.resolve(releasedAttempt(fault));
    await drainMicrotasks();
    expect(fixture.lifecycle.authorityFor(fixture.authority.setIdentity)).toBe(fixture.authority);
    expect(fixture.lifecycle.authorizeOperatorExit(address)).toEqual(before);
    expect(fixture.lifecycle.snapshot().operatorDispositions).toEqual(dispositionsBefore);
  });

  it('should cancel its own timer when claims retire without disturbing the containment deadline', async () => {
    const inspected = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
    const fixture = operationRecoveryFixture(vi.fn(() => inspected.promise));
    const fault = operationCancellationFault(fixture.record.operation);
    fixture.faults.latch(fault);
    const staleTimer = fixture.time.timers.find((timer) => timer.active && timer.at === 1_000)!;
    fixture.claims.applyMutation({ kind: 'deleted', record: fixture.record });
    fixture.lifecycle.claimsChanged(fixture.authority.setIdentity);
    await drainMicrotasks();
    expect(staleTimer.active).toBe(false);
    const deadlines = fixture.time.timers.filter((timer) => timer.active);
    const containmentDeadline = deadlines.find((timer) => timer.at === fixture.time.nowMs + 30_000);
    expect(containmentDeadline).toBeDefined();
    staleTimer.callback();
    inspected.resolve(releasedAttempt(fault));
    await drainMicrotasks();
    expect(fixture.time.timers.filter((timer) => timer.active)).toEqual(deadlines);
    expect(fixture.lifecycle.snapshot().states).toEqual(['containing']);
    expect(providerProxyOperationControlIsHeld(fixture.authority)).toBe(true);
    const release = fixture.lifecycle.containmentAbsent(fixture.authority.setIdentity, 'verified-containment-absence');
    expect(release.kind).not.toBe('held');
    await drainMicrotasks();
    expect(containmentDeadline!.active).toBe(false);
  });

  it.each(['prepared', 'permanent-refusal'] as const)(
    'should decide an exact prepare from retained %s evidence',
    async (state) => {
      const result =
        state === 'prepared'
          ? {
              state,
              reservation: randomUUID(),
              leaseExpiresInMs: 1000,
              providerRoot: { pid: 701, incarnation: testIncarnation(701) },
              jointContainmentReceipt: 'contained',
            }
          : { state, code: 'proxy_prepare_refused', disposition: 'local-fallback', reason: 'released' };
      const fixture = operationRecoveryFixture(vi.fn(async () => proxyOperationInspectResultSchema.parse(result)));
      const fault = operationCancellationFault(fixture.record.operation);
      fixture.faults.latch({ ...fault, policy: { ...fault.policy, method: 'operation.prepare.v1' } });
      await drainMicrotasks();
      expect(fixture.lifecycle.authorityFor(fixture.authority.setIdentity)).toBe(fixture.authority);
      expect(fixture.stopAndReap).not.toHaveBeenCalled();
    },
  );

  it.each(['operation', 'attempt'] as const)(
    'should retain cancellation uncertainty when inspection names the wrong %s',
    async (mismatch) => {
      const record = providerOperationRecord('executing');
      const fault = operationCancellationFault(record.operation);
      const result = releasedAttempt(fault);
      if (mismatch === 'operation') result.operation = { ...record.operation, operationId: randomUUID() };
      else result.prepareAttemptKey = 'c'.repeat(64);
      const fixture = operationRecoveryFixture(vi.fn(async () => result));
      fixture.faults.latch(fault);
      await drainMicrotasks();
      expect(fixture.lifecycle.authorityFor(fixture.authority.setIdentity)).toBeNull();
      for (let second = 0; second < 30; second += 1) {
        fixture.time.elapse(1000);
        fixture.time.runDue();
        await drainMicrotasks();
      }
      expect(fixture.stopAndReap).toHaveBeenCalledOnce();
    },
  );

  it.each(['channel', 'failed-transfer'] as const)(
    'should carry unresolved operations and their deadline through %s recovery',
    async (transition) => {
      const oldInspection = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
      const newInspection = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
      const fixture = operationRecoveryFixture(vi.fn(() => oldInspection.promise));
      const promoted = {
        ...fakeAuthority({ record: fixture.record }),
        inspectOperation: vi.fn(() => newInspection.promise),
      };
      fixture.authority.redeemControl = async () => ({ kind: 'redeemed' }) as never;
      fixture.authority.promoteControl = async () => promoted;
      const fault = operationCancellationFault(fixture.record.operation);
      fixture.faults.latch(fault);
      for (let second = 0; second < 5; second += 1) {
        fixture.time.elapse(1000);
        fixture.time.runDue();
        await drainMicrotasks();
      }
      if (transition === 'failed-transfer') {
        fixture.authority.initiateControlClose = vi
          .fn()
          .mockRejectedValueOnce(new Error('transfer failed'))
          .mockResolvedValue(undefined);
        await expect(fixture.lifecycle.releaseControlForTransfer('transfer')).rejects.toThrow('transfer failed');
        fixture.lifecycle.reclaimTransferredControl();
      } else {
        fixture.faults.reportIncident({
          kind: 'control-channel-fault',
          role: 'proxy',
          cause: 'closed',
          error: new ControlClientError('control_client_closed', 'closed', 'closed'),
        });
      }
      await drainMicrotasks();
      expect(promoted.inspectOperation).toHaveBeenCalledWith(
        fault.inspection.operation,
        fault.inspection.prepareAttemptKey,
      );
      expect(fixture.lifecycle.authorityFor(promoted.setIdentity)).toBeNull();
      expect(providerProxyOperationControlIsHeld(promoted)).toBe(true);
      oldInspection.resolve(releasedAttempt(fault));
      await drainMicrotasks();
      expect(fixture.lifecycle.authorityFor(promoted.setIdentity)).toBeNull();
      expect(fixture.lifecycle.snapshot().operatorDispositions).toEqual([
        expect.objectContaining({ waitingFor: 'operation-control-outcome-unknown', elapsedMs: 5000, attempts: 2 }),
      ]);
      for (let second = 0; second < 24; second += 1) {
        fixture.time.elapse(1000);
        fixture.time.runDue();
        await drainMicrotasks();
      }
      expect(fixture.stopAndReap).not.toHaveBeenCalled();
      fixture.time.elapse(1000);
      fixture.time.runDue();
      await drainMicrotasks();
      expect(fixture.lifecycle.snapshot().states).toEqual(['containing']);
      newInspection.resolve(releasedAttempt(fault));
      await drainMicrotasks();
      expect(fixture.lifecycle.authorityFor(promoted.setIdentity)).toBeNull();
    },
  );

  it('should reobserve through promoted control before restoring dispatch and accept late old mutation faults', async () => {
    const oldInspection = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
    const newInspection = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
    const fixture = operationRecoveryFixture(vi.fn(() => oldInspection.promise));
    const promoted = {
      ...fakeAuthority({ record: fixture.record }),
      inspectOperation: vi.fn(() => newInspection.promise),
    };
    fixture.authority.redeemControl = async () => ({ kind: 'redeemed' }) as never;
    fixture.authority.promoteControl = async () => promoted;
    const fault = operationCancellationFault(fixture.record.operation);
    fixture.faults.latch(fault);
    fixture.faults.reportIncident({
      kind: 'control-channel-fault',
      role: 'proxy',
      cause: 'closed',
      error: new ControlClientError('control_client_closed', 'closed', 'closed'),
    });
    await drainMicrotasks();
    newInspection.resolve(releasedAttempt(fault));
    await drainMicrotasks();
    expect(fixture.lifecycle.authorityFor(promoted.setIdentity)).toBe(promoted);
    const late = operationCancellationFault({ ...fault.inspection.operation, operationId: randomUUID() });
    fixture.faults.latch(late);
    await drainMicrotasks();
    expect(fixture.lifecycle.authorityFor(promoted.setIdentity)).toBeNull();
    expect(promoted.inspectOperation).toHaveBeenCalledWith(
      late.inspection.operation,
      late.inspection.prepareAttemptKey,
    );
    expect(fixture.stopAndReap).not.toHaveBeenCalled();
  });

  it('should preserve a draining recovery and count started inspections cumulatively by method', async () => {
    const first = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
    const second = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
    const fixture = operationRecoveryFixture(
      vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    );
    const a = operationCancellationFault(fixture.record.operation);
    const b = operationCancellationFault({ ...fixture.record.operation, operationId: randomUUID() });
    fixture.faults.latch(a);
    expect(fixture.lifecycle.snapshot().operatorDispositions).toEqual([
      expect.objectContaining({ method: 'operation.cancel.v1', attempts: 1 }),
    ]);
    fixture.faults.latch(b);
    expect(fixture.lifecycle.snapshot().operatorDispositions).toEqual([
      expect.objectContaining({ method: 'operation.cancel.v1', attempts: 1 }),
    ]);
    fixture.time.elapse(1000);
    fixture.time.runDue();
    await drainMicrotasks();
    expect(fixture.lifecycle.snapshot().operatorDispositions).toEqual([
      expect.objectContaining({ method: 'operation.cancel.v1', attempts: 2 }),
    ]);
    const persistedRecovery = () => fixture.dispositionStore.read().records.map(({ disposition }) => disposition);
    expect(persistedRecovery()).toEqual([
      expect.objectContaining({
        waitingFor: 'operation-control-outcome-unknown',
        attempts: 2,
        elapsedMs: 1000,
        boundMs: 30000,
      }),
    ]);
    fixture.lifecycle.beginGracefulDrain(fixture.authority.setIdentity);
    expect(fixture.lifecycle.snapshot().states).toEqual(['draining']);
    expect(fixture.lifecycle.snapshot().operatorDispositions).toEqual([
      expect.objectContaining({ waitingFor: 'operation-control-outcome-unknown', attempts: 2, boundMs: 30000 }),
    ]);
    expect(persistedRecovery()).toEqual([
      expect.objectContaining({
        waitingFor: 'operation-control-outcome-unknown',
        attempts: 2,
        elapsedMs: 1000,
        boundMs: 30000,
      }),
    ]);
    first.resolve(releasedAttempt(a));
    await drainMicrotasks();
    expect(fixture.lifecycle.snapshot().operatorDispositions).toEqual([
      expect.objectContaining({ waitingFor: 'operation-control-outcome-unknown', attempts: 2 }),
    ]);
    expect(fixture.lifecycle.authorityFor(fixture.authority.setIdentity)).toBeNull();
    second.resolve(releasedAttempt(b));
    await drainMicrotasks();
    expect(fixture.lifecycle.authorityFor(fixture.authority.setIdentity)).toBe(fixture.authority);
    expect(fixture.stopAndReap).not.toHaveBeenCalled();
  });

  it('should retire reattachment before a late unclaimed mutation starts containment', async () => {
    const contained = deferred<{ unconfirmed: string }>();
    const fixture = operationRecoveryFixture(
      vi.fn(async () => ({ state: 'absent' }) as const),
      2000,
    );
    fixture.stopAndReap.mockImplementation(() => contained.promise);
    fixture.authority.redeemControl = () => new Promise(() => {});
    fixture.faults.reportIncident({
      kind: 'control-channel-fault',
      role: 'proxy',
      cause: 'closed',
      error: new ControlClientError('control_client_closed', 'closed', 'closed'),
    });
    await drainMicrotasks();
    expect(fixture.lifecycle.snapshot().states).toEqual(['reattaching']);
    fixture.claims.applyMutation({ kind: 'deleted', record: fixture.record });
    fixture.lifecycle.claimsChanged(fixture.authority.setIdentity);
    fixture.faults.latch(operationCancellationFault(fixture.record.operation));
    await drainMicrotasks();
    expect(fixture.stopAndReap).toHaveBeenCalledOnce();
    const containmentDeadline = fixture.time.timers.find((timer) => timer.active && timer.at === 30000);
    expect(containmentDeadline).toBeDefined();
    for (let second = 0; second < 2; second += 1) {
      fixture.time.elapse(1000);
      fixture.time.runDue();
      await drainMicrotasks();
    }
    contained.resolve({ unconfirmed: 'containment remains observable' });
    await drainMicrotasks();
    expect(fixture.lifecycle.snapshot().operatorDispositions).toEqual(
      expect.arrayContaining([expect.objectContaining({ waitingFor: 'containment-outcome-unknown' })]),
    );
    expect(containmentDeadline?.active).toBe(true);
    fixture.time.elapse(28000);
    fixture.time.runDue();
    await drainMicrotasks();
    fixture.time.elapse(2000);
    fixture.time.runDue();
    await drainMicrotasks();
    expect(fixture.stopAndReap).toHaveBeenCalledTimes(2);
  });

  it('should keep the containment bound while channel reattachment has no answer', async () => {
    const inspected = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>>();
    const fixture = operationRecoveryFixture(vi.fn(() => inspected.promise));
    fixture.authority.redeemControl = () => new Promise(() => {});
    const fault = operationCancellationFault(fixture.record.operation);
    fixture.faults.latch(fault);
    fixture.faults.reportIncident({
      kind: 'control-channel-fault',
      role: 'proxy',
      cause: 'closed',
      error: new ControlClientError('control_client_closed', 'closed', 'closed'),
    });
    await drainMicrotasks();
    expect(fixture.lifecycle.snapshot().states).toEqual(['reattaching']);
    for (let second = 0; second < 30; second += 1) {
      fixture.time.elapse(1000);
      fixture.time.runDue();
      await drainMicrotasks();
    }
    expect(fixture.lifecycle.snapshot().states).toEqual(['containing']);
    expect(fixture.stopAndReap).toHaveBeenCalledOnce();
    inspected.resolve(releasedAttempt(fault));
    await drainMicrotasks();
    expect(fixture.lifecycle.authorityFor(fixture.authority.setIdentity)).toBeNull();
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
});

it.each([
  { kind: 'populated', stage: 'after-reaper' },
  { kind: 'missing', stage: 'after-reaper' },
  { kind: 'unknown', stage: 'after-reaper' },
  { kind: 'absent', stage: 'after-reaper' },
  { kind: 'missing', stage: 'prior-attempt-await' },
] as const)(
  'refreshes the same set leaf before releasing representation when it becomes $kind during $stage',
  async ({ kind, stage }) => {
    const record = providerOperationRecord('executing');
    const identity = providerProxySetIdentityFromRecord(record);
    const db = containmentProofDatabase(record);
    const process = containmentProofRuntime(identity, { guardian: 'absent', reaper: 'absent' });
    let observation: FailureDomainObservation = { kind: stage === 'prior-attempt-await' ? 'missing' : 'absent' };
    let reaped = false;
    let transitionQueued = false;
    const reap: ProviderProxySetRecordedContainmentReaper = async () => {
      reaped = true;
      return { kind: 'containment-absent', disappearanceReceipt: 'post-reaper-set-absence' };
    };
    const harness = await authorizedOperatorExitForProof(record, reap, () => ({
      observe: () => {
        if (stage === 'after-reaper' && reaped && !transitionQueued) {
          transitionQueued = true;
          queueMicrotask(() => {
            observation = kind === 'unknown' ? { kind, reason: 'EACCES' } : { kind };
          });
        }
        return observation;
      },
    }));
    try {
      const proof = await createProviderProxySetContainmentProver(process.runtime).collectContainmentProof(
        harness.capability.containmentProofAuthorization,
        db,
        new AbortController().signal,
      );
      if (stage === 'prior-attempt-await') {
        observation = { kind: 'absent' };
        transitionQueued = true;
        queueMicrotask(() => {
          observation = { kind };
        });
      }
      const outcome = await harness.lifecycle.completeOperatorExit(harness.capability, proof, false);
      expect(transitionQueued).toBe(true);
      if (kind === 'absent') {
        expect(outcome.kind).toBe('contained');
      } else {
        expect(outcome).toEqual(
          expect.objectContaining({
            kind: stage === 'prior-attempt-await' ? 'identity-unobservable' : 'containment-unconfirmed',
            effect: { signalsSent: [], containmentAbsent: false, representationAction: 'none' },
          }),
        );
        expect(harness.lifecycle.snapshot().represented).toBe(1);
        expect(harness.lifecycle.snapshot().states).toEqual(['containment-wait']);
        observation = { kind: 'missing' };
        expect(harness.lifecycle.containmentAbsenceObserver(identity)()).toBe(false);
        expect(harness.lifecycle.containmentAbsent(identity, 'later-control-receipt').kind).toBe('held');
        expect(harness.lifecycle.snapshot().represented).toBe(1);
      }
    } finally {
      db.close();
    }
  },
);

it('owns an operation containment request through route removal, the mutation fence and ordinary absence delivery', async () => {
  const record = providerOperationRecord('proxy-activation-pending');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const stopAndReap = vi.fn(async () => ({ disappearanceReceipt: 'operation-release-absence' }));
  const authority = fakeAuthority({ record, stopAndReap });
  const time = new ManualClock();
  const fenced = vi.fn();
  const lifecycle = lifecycleFor({
    claims,
    time,
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: {
      containmentDisappeared: vi.fn(async () => ({
        kind: 'accepted' as const,
        acceptance: { kind: 'accepted' as const, operation: record.operation, disposition: 'record-absent' as const },
      })),
    },
    proveContainmentAbsent: noContainmentProof,
    fenceProviderOperationMutations: (identity) => {
      fenced(identity);
      return new ProviderOperationMutationAdmission().closeSet(identity);
    },
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  const admission = lifecycle.beginFreshAcquisition('operation-route');
  if (admission.kind !== 'accepted') throw new Error('acquisition refused');
  lifecycle.acquisitionSucceeded(admission.slotId, authority, TEST_PUBLICATION_RECEIPT);
  expect(lifecycle.routeFor('operation-route')).toBe(authority);
  expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority);
  lifecycle.requestOperationContainment(authority.setIdentity, 'provider_activation_ack_invalid');
  expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
  expect(lifecycle.routeFor('operation-route')).toBeNull();
  expect(fenced).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(stopAndReap).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));
});

it('retires a set once it has held no live claim for its idle window, releasing its route as idle-retired', async () => {
  const record = providerOperationRecord('executing');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([record]);
  const stopAndReap = vi.fn(async () => ({ disappearanceReceipt: 'idle-retirement-absence' }));
  const authority = fakeAuthority({ record, stopAndReap });
  const time = new ManualClock();
  const onSlotReleased = vi.fn();
  const lifecycle = lifecycleFor({
    claims,
    time,
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
    capacity: { maxSets: 4, idleRetirement: { kind: 'after-idle', ms: 1_000 } },
    onSlotReleased,
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  const admission = lifecycle.beginFreshAcquisition('idle-route');
  if (admission.kind !== 'accepted') throw new Error('acquisition refused');
  lifecycle.acquisitionSucceeded(admission.slotId, authority, TEST_PUBLICATION_RECEIPT);

  time.elapse(1_000);
  time.runDue();
  await drainMicrotasks();
  expect(stopAndReap).not.toHaveBeenCalled();

  claims.applyMutation({ kind: 'deleted', record });
  lifecycle.claimsChanged(authority.setIdentity);
  time.elapse(999);
  time.runDue();
  await drainMicrotasks();
  expect(stopAndReap).not.toHaveBeenCalled();
  expect(lifecycle.routeFor('idle-route')).toBe(authority);

  time.elapse(1);
  time.runDue();
  await vi.waitFor(() => expect(stopAndReap).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(onSlotReleased).toHaveBeenCalledWith('idle-route', 'idle-retired'));
  expect(lifecycle.snapshot().represented).toBe(0);
});

it('re-arms idle retirement when control reattachment returns an idle set to service', async () => {
  const record = providerOperationRecord('executing');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const stopAndReap = vi.fn(async () => ({ disappearanceReceipt: 'idle-retirement-absence' }));
  const faults = createProviderProxyAuthorityFaultLatch();
  const promoted = fakeAuthority({ record, stopAndReap });
  const authority: DurableProviderProxyOperationAuthority = {
    ...fakeAuthority({ record, faults, stopAndReap }),
    redeemControl: async () => ({ kind: 'redeemed' }) as never,
    promoteControl: async () => promoted,
  };
  const time = new ManualClock();
  const lifecycle = lifecycleFor({
    claims,
    time,
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
    capacity: { maxSets: 4, idleRetirement: { kind: 'after-idle', ms: 1_000 } },
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);

  time.elapse(900);
  faults.reportIncident({
    kind: 'control-channel-fault',
    role: 'guardian',
    cause: 'closed',
    error: new ControlClientError('control_client_closed', 'guardian closed', 'closed'),
  });
  expect(lifecycle.acquisitionFor(authority.setIdentity)).toMatchObject({
    kind: 'owned-pending',
    status: 'reattaching',
  });
  time.elapse(100);
  time.runDue();
  await vi.waitFor(() => expect(lifecycle.authorityFor(authority.setIdentity)).toBe(promoted));
  expect(stopAndReap).not.toHaveBeenCalled();

  time.elapse(1_000);
  time.runDue();
  await vi.waitFor(() => expect(stopAndReap).toHaveBeenCalledOnce());
});

it('gives a set back a full idle window when reattachment returns it before its old deadline', async () => {
  const record = providerOperationRecord('executing');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const stopAndReap = vi.fn(async () => ({ disappearanceReceipt: 'idle-retirement-absence' }));
  const faults = createProviderProxyAuthorityFaultLatch();
  const promoted = fakeAuthority({ record, stopAndReap });
  const authority: DurableProviderProxyOperationAuthority = {
    ...fakeAuthority({ record, faults, stopAndReap }),
    redeemControl: async () => ({ kind: 'redeemed' }) as never,
    promoteControl: async () => promoted,
  };
  const time = new ManualClock();
  const lifecycle = lifecycleFor({
    claims,
    time,
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
    capacity: { maxSets: 4, idleRetirement: { kind: 'after-idle', ms: 1_000 } },
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);

  time.elapse(900);
  faults.reportIncident({
    kind: 'control-channel-fault',
    role: 'guardian',
    cause: 'closed',
    error: new ControlClientError('control_client_closed', 'guardian closed', 'closed'),
  });
  await vi.waitFor(() => expect(lifecycle.authorityFor(authority.setIdentity)).toBe(promoted));
  time.elapse(100);
  time.runDue();
  await drainMicrotasks();
  expect(stopAndReap).not.toHaveBeenCalled();

  time.elapse(900);
  time.runDue();
  await vi.waitFor(() => expect(stopAndReap).toHaveBeenCalledOnce());
});

it('restarts the idle window when a claim arrives and leaves before it expires', async () => {
  const record = providerOperationRecord('executing');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const stopAndReap = vi.fn(async () => ({ disappearanceReceipt: 'idle-retirement-absence' }));
  const authority = fakeAuthority({ record, stopAndReap });
  const time = new ManualClock();
  const lifecycle = lifecycleFor({
    claims,
    time,
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
    capacity: { maxSets: 4, idleRetirement: { kind: 'after-idle', ms: 1_000 } },
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);

  time.elapse(600);
  claims.applyMutation({ kind: 'upserted', record });
  lifecycle.claimsChanged(authority.setIdentity);
  claims.applyMutation({ kind: 'deleted', record });
  lifecycle.claimsChanged(authority.setIdentity);
  time.elapse(400);
  time.runDue();
  await drainMicrotasks();
  expect(stopAndReap).not.toHaveBeenCalled();

  time.elapse(600);
  time.runDue();
  await vi.waitFor(() => expect(stopAndReap).toHaveBeenCalledOnce());
});

it.each(['controller transfer', 'fault containment'] as const)(
  "cancels a set's idle window when %s takes it out of service",
  async (exit) => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const faults = createProviderProxyAuthorityFaultLatch();
    const authority = fakeAuthority({ record, faults });
    const time = new ManualClock();
    const lifecycle = lifecycleFor({
      claims,
      time,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: vi.fn() },
      proveContainmentAbsent: noContainmentProof,
      capacity: { maxSets: 4, idleRetirement: { kind: 'after-idle', ms: 1_000 } },
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
    const idleWindow = () => time.timers.filter((timer) => timer.active && timer.at === 1_000);
    expect(idleWindow()).toHaveLength(1);

    if (exit === 'controller transfer') await lifecycle.releaseControlForTransfer('transfer-attempt');
    else faults.latch(terminalAuthorityFault());
    await drainMicrotasks();

    expect(idleWindow()).toHaveLength(0);
  },
);

it('admits fresh sets only up to the configured limit', () => {
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const lifecycle = lifecycleFor({
    claims,
    time: new ManualClock(),
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
    capacity: { maxSets: 3, idleRetirement: { kind: 'never' } },
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();

  expect(['first', 'second', 'third', 'fourth'].map((route) => lifecycle.beginFreshAcquisition(route).kind)).toEqual([
    'accepted',
    'accepted',
    'accepted',
    'capacity',
  ]);
});

it('retains only as many established sets as the configured limit', async () => {
  const first = providerOperationRecord('executing');
  const second = providerOperationRecord('executing', {
    operation: { ...first.operation, proxyInstanceId: '00000000-0000-4000-8000-000000000030' },
  });
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const stopAndReap = vi.fn(async () => ({ disappearanceReceipt: 'excess-capacity-absence' }));
  const lifecycle = lifecycleFor({
    claims,
    time: new ManualClock(),
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
    capacity: { maxSets: 1, idleRetirement: { kind: 'never' } },
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  registerProviderProxySetForTest(lifecycle, fakeAuthority({ record: first, stopAndReap }), TEST_PUBLICATION_RECEIPT);
  registerProviderProxySetForTest(lifecycle, fakeAuthority({ record: second, stopAndReap }), TEST_PUBLICATION_RECEIPT);

  await vi.waitFor(() => expect(stopAndReap).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(1));
});

it.each(['proxy-activation-pending', 'activation-resolution-pending'] as const)(
  'refuses released operator containment on an available stuck %s set with live claims',
  (phase) => {
    const record = providerOperationRecord(phase);
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const authority = fakeAuthority({ record });
    const lifecycle = lifecycleFor({
      claims,
      time: new ManualClock(),
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: vi.fn() },
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
    expect(lifecycle.authorizeOperatorExit(providerProxySetAddress(authority.setIdentity))).toEqual({
      kind: 'not-held',
      state: 'available',
    });
  },
);

it('preserves all live claims when one operation requests containment and records its exit', async () => {
  const record = providerOperationRecord('executing');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([record]);
  const stopAndReap = vi.fn();
  const authority = fakeAuthority({ record, stopAndReap });
  const lifecycle = lifecycleFor({
    claims,
    time: new ManualClock(),
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
  lifecycle.requestOperationContainment(authority.setIdentity, 'provider_operation_retries_exhausted');
  await drainMicrotasks();
  expect(stopAndReap).not.toHaveBeenCalled();
  expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority);
  expect(JSON.stringify(lifecycle.snapshot())).toContain('operation-control-outcome-unknown');
});

it.each([
  { timing: 'initial', phase: 'executing', exhausted: false },
  { timing: 'initial', phase: 'settlement-pending', exhausted: false },
  { timing: 'during-fence', phase: 'executing', exhausted: false },
  { timing: 'during-fence', phase: 'settlement-pending', exhausted: false },
  { timing: 'during-fence', phase: 'settlement-pending', exhausted: true },
] as const)(
  'defers retirement for another $phase operation present $timing (exhausted=$exhausted) until it leaves',
  async ({ timing, phase, exhausted }) => {
    const record = providerOperationRecordSchema.parse({
      ...providerOperationRecord('settlement-pending'),
      settlementFailure: { elapsedMs: 120_000, observedAtMs: 100, containmentRequested: true },
    });
    const otherRecord = providerOperationRecord(phase, { job: 9 });
    const other =
      otherRecord.phase === 'settlement-pending' && exhausted
        ? { ...otherRecord, settlementFailure: { elapsedMs: 120_000, observedAtMs: 100, containmentRequested: true } }
        : otherRecord;
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize(timing === 'initial' ? [record, other] : [record]);
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'not yet absent' }) as const);
    const authority = fakeAuthority({ record, stopAndReap });
    const gate = deferred<void>();
    const admission = new ProviderOperationMutationAdmission();
    let fenceWaits = timing === 'during-fence';
    const lifecycle = lifecycleFor({
      claims,
      time: new ManualClock(),
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: vi.fn() },
      proveContainmentAbsent: noContainmentProof,
      fenceProviderOperationMutations: (identity) => {
        const fence = admission.closeSet(identity);
        return fenceWaits
          ? {
              ...fence,
              kind: 'holding',
              pendingMutations: ['other-operation'],
              exit: 'admitted-provider-operation-mutation-settlement',
              retryAfter: gate.promise,
            }
          : fence;
      },
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
    const request = { kind: 'settlement-retries-exhausted', operation: record.operation } as const;
    lifecycle.requestOperationContainment(authority.setIdentity, request);
    if (timing === 'during-fence') {
      claims.applyMutation({ kind: 'upserted', record: other });
      fenceWaits = false;
      gate.resolve();
    }
    await drainMicrotasks();
    expect(stopAndReap).not.toHaveBeenCalled();
    expect(claims.claimsFor(authority.setIdentity)).toHaveLength(exhausted ? 0 : 1);
    expect(claims.operationsFor(authority.setIdentity)).toHaveLength(2);
    expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority);

    claims.applyMutation({ kind: 'deleted', record: other });
    expect(claims.claimsFor(authority.setIdentity)).toEqual([]);
    lifecycle.requestOperationContainment(authority.setIdentity, request);
    await vi.waitFor(() => expect(stopAndReap).toHaveBeenCalledOnce());
    expect(claims.claimFor(record.operation)).not.toBeNull();
    expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
  },
);

it('rechecks exact operation identities when an exhausted sibling is replaced under the fence', async () => {
  const record = providerOperationRecordSchema.parse({
    ...providerOperationRecord('settlement-pending'),
    settlementFailure: { elapsedMs: 120_000, observedAtMs: 100, containmentRequested: true },
  });
  const sibling = { ...record, operation: { ...record.operation, jobId: randomUUID() } };
  const replacement = { ...sibling, operation: { ...sibling.operation, operationId: randomUUID() } };
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([record, sibling]);
  const stopAndReap = vi.fn(async () => ({ unconfirmed: 'not yet absent' }) as const);
  const authority = fakeAuthority({ record, stopAndReap });
  const reportLifecycle = vi.fn();
  const gate = deferred<void>();
  const admission = new ProviderOperationMutationAdmission();
  let fenceWaits = true;
  const lifecycle = lifecycleFor({
    claims,
    time: new ManualClock(),
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
    reportLifecycle,
    fenceProviderOperationMutations: (identity) => {
      const fence = admission.closeSet(identity);
      return fenceWaits
        ? {
            ...fence,
            kind: 'holding',
            pendingMutations: ['sibling-replacement'],
            exit: 'admitted-provider-operation-mutation-settlement',
            retryAfter: gate.promise,
          }
        : fence;
    },
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
  const request = { kind: 'settlement-retries-exhausted', operation: record.operation } as const;
  lifecycle.requestOperationContainment(authority.setIdentity, request);
  claims.applyMutation({ kind: 'deleted', record: sibling });
  claims.applyMutation({ kind: 'upserted', record: replacement });
  fenceWaits = false;
  gate.resolve();
  await drainMicrotasks();
  expect(stopAndReap).not.toHaveBeenCalled();
  expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority);

  lifecycle.requestOperationContainment(authority.setIdentity, request);
  await vi.waitFor(() => expect(stopAndReap).toHaveBeenCalledOnce());
  expect(claims.claimsFor(authority.setIdentity)).toEqual([]);
  expect(reportLifecycle).toHaveBeenCalledWith(
    'info',
    expect.stringContaining(
      'action=stop-and-reap reason=operation_release_failed fault=none subject=retirement liveClaims=0',
    ),
  );
});

it('requires the exact durable settlement escalation fact rather than trusting the request', async () => {
  const record = providerOperationRecord('settlement-pending');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([record]);
  const stopAndReap = vi.fn(async () => ({ unconfirmed: 'not yet absent' }) as const);
  const authority = fakeAuthority({ record, stopAndReap });
  const lifecycle = lifecycleFor({
    claims,
    time: new ManualClock(),
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
  const request = { kind: 'settlement-retries-exhausted', operation: record.operation } as const;
  lifecycle.requestOperationContainment(authority.setIdentity, request);
  await drainMicrotasks();
  expect(stopAndReap).not.toHaveBeenCalled();

  const eligible = providerOperationRecordSchema.parse({
    ...record,
    settlementFailure: { elapsedMs: 120_000, observedAtMs: 100, containmentRequested: true },
  });
  claims.applyMutation({ kind: 'upserted', record: eligible });
  lifecycle.requestOperationContainment(authority.setIdentity, {
    ...request,
    operation: { ...record.operation, operationId: randomUUID() },
  });
  await drainMicrotasks();
  expect(stopAndReap).not.toHaveBeenCalled();
  lifecycle.requestOperationContainment(authority.setIdentity, request);
  await vi.waitFor(() => expect(stopAndReap).toHaveBeenCalledOnce());
});

it('delivers ordinary disappearance to live claims when an operation release failure meets teardown-latched authority', async () => {
  const record = providerOperationRecord('activation-resolution-pending');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([record]);
  const stopAndReap = vi.fn(async () => ({ disappearanceReceipt: 'teardown-latched-absence' }));
  const faults = createProviderProxyAuthorityFaultLatch();
  const authority = fakeAuthority({ record, stopAndReap, faults });
  const consumed = vi.fn(async () => ({
    kind: 'accepted' as const,
    acceptance: {
      kind: 'accepted' as const,
      operation: record.operation,
      disposition: 'terminalization-committed' as const,
    },
  }));
  const lifecycle = lifecycleFor({
    claims,
    time: new ManualClock(),
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: consumed },
    proveContainmentAbsent: noContainmentProof,
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
  lifecycle.requestOperationContainment(authority.setIdentity, 'provider_activation_ack_invalid');
  faults.latch(terminalAuthorityFault());
  expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
  await vi.waitFor(() => expect(consumed).toHaveBeenCalledOnce());
  expect(consumed).toHaveBeenCalledWith(expect.objectContaining({ disappearanceReceipt: 'teardown-latched-absence' }));
});

it('reserves sequential inheritance attempts and rejects stale registration without touching accepted authority', () => {
  const record = providerOperationRecord('executing');
  const authority = fakeAuthority({ record });
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const lifecycle = lifecycleFor({
    claims,
    time: new ManualClock(),
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
    proveContainmentAbsent: noContainmentProof,
  });
  const reserve = () => {
    const judgement = lifecycle.acquisitionFor(authority.setIdentity);
    expect(judgement.kind).toBe('unowned');
    if (judgement.kind !== 'unowned') throw new Error('expected unowned');
    const reservation = judgement.admission.reserve();
    if (reservation.kind !== 'admitted') throw new Error('expected admission');
    return reservation.token;
  };
  const first = reserve();
  expect(lifecycle.acquisitionFor(authority.setIdentity)).toMatchObject({
    kind: 'owned-pending',
    status: 'inheritance-admitted',
  });
  lifecycle.releaseInheritanceAdmission(first);
  expect(lifecycle.registerInheritedSet(authority, TEST_PUBLICATION_RECEIPT, null, 'protected', first)).toEqual({
    kind: 'admission-expired',
    retryOwner: 'provider-proxy-set-inheritance',
  });
  const second = reserve();
  expect(lifecycle.registerInheritedSet(authority, TEST_PUBLICATION_RECEIPT, null, 'protected', first)).toEqual({
    kind: 'admission-expired',
    retryOwner: 'provider-proxy-set-inheritance',
  });
  expect(lifecycle.acquisitionFor(authority.setIdentity)).toMatchObject({
    kind: 'owned-pending',
    status: 'inheritance-admitted',
  });
  lifecycle.releaseInheritanceAdmission(first);
  expect(lifecycle.registerInheritedSet(authority, TEST_PUBLICATION_RECEIPT, null, 'protected', second).kind).toBe(
    'accepted',
  );
  const candidate = fakeAuthority({ record });
  expect(lifecycle.registerInheritedSet(candidate, TEST_PUBLICATION_RECEIPT, null, 'protected', first)).toMatchObject({
    kind: 'superseded',
    owner: 'provider-proxy-set-lifecycle',
  });
  expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority);
  expect(lifecycle.registerInheritedSet(authority, TEST_PUBLICATION_RECEIPT, null, 'protected', second).kind).toBe(
    'accepted',
  );
});

it('does not redeem retained containment ownership on simultaneous or sequential ordinary inheritance calls', async () => {
  const record = providerOperationRecord('executing');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([record]);
  const faults = createProviderProxyAuthorityFaultLatch();
  const authority = fakeAuthority({ record, faults });
  const lifecycle = lifecycleFor({
    claims,
    time: new ManualClock(),
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
    proveContainmentAbsent: noContainmentProof,
  });
  lifecycle.initializeClaimSlots();
  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
  faults.latch({ kind: 'operation-control-failed', policy: containmentOperationPolicy, error: 'unknown delivery' });
  const readIncarnation = vi.fn(() => authority.setIdentity.guardianIncarnation);
  const runtime = createRealRuntime('prod');
  const inheritance = createProviderProxySetInheritance({
    runtime: { ...runtime, process: { ...runtime.process, readProcessIncarnation: readIncarnation } },
    identity: { instanceId: randomUUID(), buildSetId: record.operation.buildSetId, flavor: 'prod' },
    operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
    containmentProver: createProviderProxySetContainmentProver(runtime),
    reapRecordedContainment: async () => {
      throw new Error('unexpected reap');
    },
    acquisitionFor: (identity) => lifecycle.acquisitionFor(identity),
    releaseInheritanceAdmission: (token) => lifecycle.releaseInheritanceAdmission(token),
    registerInheritedSet: () => {
      throw new Error('unexpected registration');
    },
  });
  const db = newRawDatabase(':memory:');
  try {
    const signal = new AbortController().signal;
    const first = inheritance.inheritProviderProxySet(record, db, signal);
    const second = inheritance.inheritProviderProxySet(record, db, signal);
    for (const result of await Promise.all([first, second]))
      expect(result).toMatchObject({ kind: 'temporarily-unavailable', incident: { kind: 'lifecycle-owned-pending' } });
    await expect(inheritance.inheritProviderProxySet(record, db, signal)).resolves.toMatchObject({
      kind: 'temporarily-unavailable',
    });
    expect(readIncarnation).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it('keeps conflicting identities visible at inheritance admission', () => {
  const record = providerOperationRecord('executing');
  const authority = fakeAuthority({ record });
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const lifecycle = lifecycleFor({
    claims,
    time: new ManualClock(),
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
    proveContainmentAbsent: noContainmentProof,
  });
  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
  const conflicting = lifecycle.acquisitionFor({
    ...authority.setIdentity,
    guardianPid: authority.setIdentity.guardianPid + 1,
  });
  if (conflicting.kind !== 'unowned') throw new Error('expected unowned identity');
  expect(() => conflicting.admission.reserve()).toThrow('provider_proxy_set_identity_alias');
});

it('expires an old admission across internal acquisition and complete retirement', async () => {
  const record = providerOperationRecord('executing');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const lifecycle = lifecycleFor({
    claims,
    time: new ManualClock(),
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
  });
  lifecycle.completeStartupDiscovery();
  const identity = providerProxySetIdentityFromRecord(record);
  const judgement = lifecycle.acquisitionFor(identity);
  if (judgement.kind !== 'unowned') throw new Error('expected unowned');
  const admission = judgement.admission.reserve();
  if (admission.kind !== 'admitted') throw new Error('expected admission');
  const fresh = lifecycle.beginFreshAcquisition('internal-promotion');
  if (fresh.kind !== 'accepted') throw new Error('expected fresh admission');
  const faults = createProviderProxyAuthorityFaultLatch();
  expect(
    lifecycle.acquisitionSucceeded(fresh.slotId, fakeAuthority({ record, faults }), TEST_PUBLICATION_RECEIPT).kind,
  ).toBe('accepted');
  faults.latch(terminalAuthorityFault());
  void lifecycle.containmentAbsent(identity, 'exact-test-disappearance');
  await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));
  expect(
    lifecycle.registerInheritedSet(
      fakeAuthority({ record }),
      TEST_PUBLICATION_RECEIPT,
      null,
      'protected',
      admission.token,
    ).kind,
  ).toBe('admission-expired');
  const corrected = lifecycle.acquisitionFor({ ...identity, guardianPid: identity.guardianPid + 1 });
  if (corrected.kind !== 'unowned') throw new Error('expected corrected identity to be unowned');
  const next = corrected.admission.reserve();
  expect(next.kind).toBe('admitted');
  if (next.kind === 'admitted') lifecycle.releaseInheritanceAdmission(next.token);
});

it('deduplicates simultaneous unowned attempts and releases admission for the next failed attempt', async () => {
  const record = providerOperationRecord('executing');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const lifecycle = lifecycleFor({
    claims,
    time: new ManualClock(),
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
  });
  const runtime = createRealRuntime('prod');
  const readProcessIncarnation = vi.fn(() => null);
  const inheritance = createProviderProxySetInheritance({
    runtime: { ...runtime, process: { ...runtime.process, readProcessIncarnation } },
    identity: { instanceId: randomUUID(), buildSetId: record.operation.buildSetId, flavor: 'prod' },
    operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
    containmentProver: createProviderProxySetContainmentProver(runtime),
    reapRecordedContainment: async () => {
      throw new Error('unexpected reap');
    },
    acquisitionFor: (identity) => lifecycle.acquisitionFor(identity),
    releaseInheritanceAdmission: (token) => lifecycle.releaseInheritanceAdmission(token),
    registerInheritedSet: () => {
      throw new Error('unexpected registration');
    },
  });
  const db = newRawDatabase(':memory:');
  try {
    const signal = new AbortController().signal;
    const results = await Promise.all([
      inheritance.inheritProviderProxySet(record, db, signal),
      inheritance.inheritProviderProxySet(record, db, signal),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(readProcessIncarnation).toHaveBeenCalledOnce();
    await inheritance.inheritProviderProxySet(record, db, signal);
    expect(readProcessIncarnation).toHaveBeenCalledTimes(2);
    expect(lifecycle.acquisitionFor(providerProxySetIdentityFromRecord(record)).kind).toBe('unowned');
  } finally {
    db.close();
  }
});

it('releases an admission-only identity index entry so corrected identity can use the same address', () => {
  const record = providerOperationRecord('executing');
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const lifecycle = lifecycleFor({
    claims,
    time: new ManualClock(),
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
  });
  const identity = providerProxySetIdentityFromRecord(record);
  const first = lifecycle.acquisitionFor(identity);
  if (first.kind !== 'unowned') throw new Error('expected unowned');
  const reservation = first.admission.reserve();
  if (reservation.kind !== 'admitted') throw new Error('expected admission');
  lifecycle.releaseInheritanceAdmission(reservation.token);
  const corrected = lifecycle.acquisitionFor({ ...identity, guardianPid: identity.guardianPid + 1 });
  if (corrected.kind !== 'unowned') throw new Error('expected unowned corrected identity');
  const next = corrected.admission.reserve();
  expect(next.kind).toBe('admitted');
  if (next.kind === 'admitted') lifecycle.releaseInheritanceAdmission(next.token);
});

it('clears a durable inheritance hold after successful inheritance', () => {
  const record = providerOperationRecord('executing');
  const authority = fakeAuthority({ record });
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([record]);
  const time = new ManualClock();
  const store = new ProviderProxySetOperatorDispositionStore(new InMemoryStorage(time), DURABLE_DISPOSITION_RUN_DIR);
  const lifecycle = lifecycleFor({
    claims,
    time,
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
    operatorDispositionStore: store,
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  lifecycle.recordInheritanceObservation(authority.setIdentity, {
    kind: 'temporarily-unavailable',
    incident: { kind: 'transfer-status-unconfirmed' },
  });
  expect(store.read().records).toEqual([
    expect.objectContaining({
      subjectKey: 'inheritance-observation',
      disposition: expect.objectContaining({ disposition: 'held' }),
    }),
  ]);
  expect(lifecycle.snapshot().operatorSets).toHaveLength(1);

  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
  lifecycle.recordInheritanceObservation(authority.setIdentity, {
    kind: 'inherited',
    set: authority,
    publicationReceipt: TEST_PUBLICATION_RECEIPT,
    protection: 'protected',
  });

  expect(store.read().records).toEqual([]);
  expect(lifecycle.snapshot().operatorSets).toEqual([]);
  expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority);
});

it('preserves another durable same-set disposition when inheritance clears its subject', () => {
  const record = providerOperationRecord('executing');
  const authority = fakeAuthority({ record });
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([record]);
  const time = new ManualClock();
  const store = new ProviderProxySetOperatorDispositionStore(new InMemoryStorage(time), DURABLE_DISPOSITION_RUN_DIR);
  const lifecycle = lifecycleFor({
    claims,
    time,
    controlEstablished: ignoreControlEstablished,
    disappearanceConsumer: { containmentDisappeared: vi.fn() },
    proveContainmentAbsent: noContainmentProof,
    operatorDispositionStore: store,
  });
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  registerProviderProxySetForTest(lifecycle, authority, TEST_PUBLICATION_RECEIPT);
  lifecycle.requestOperationContainment(authority.setIdentity, 'provider_operation_retries_exhausted');
  const sibling = store.read().records.find((held) => held.subjectKey === 'operation-release');
  expect(sibling).toBeDefined();
  lifecycle.recordInheritanceObservation(authority.setIdentity, {
    kind: 'temporarily-unavailable',
    incident: { kind: 'transfer-status-unconfirmed' },
  });
  expect(store.read().records).toHaveLength(2);
  expect(lifecycle.snapshot().operatorSets[0]?.holds).toHaveLength(2);

  lifecycle.recordInheritanceObservation(authority.setIdentity, {
    kind: 'inherited',
    set: authority,
    publicationReceipt: TEST_PUBLICATION_RECEIPT,
    protection: 'protected',
  });

  expect(store.read().records).toEqual([sibling]);
  expect(lifecycle.snapshot().operatorSets).toEqual([
    expect.objectContaining({
      holds: [expect.objectContaining({ disposition: 'held', waitingFor: 'operation-control-outcome-unknown' })],
    }),
  ]);
  expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority);
});

describe('exact-capsule recovery', () => {
  const record = providerOperationRecord('settlement-pending');
  const identity = providerProxySetIdentityFromRecord(record);
  const { canonicalEndpoint, ...capsuleIdentity } = identity;
  const capsule = handoffCapsuleV3Schema.parse({
    ...capsuleIdentity,
    version: 3,
    generation: 'gen2',
    flavor: 'prod',
    proxyEndpoint: canonicalEndpoint,
    grantId: randomUUID(),
    secret: 'a'.repeat(64),
    orphanTimeoutMs: 60_000,
    teardownReserveMs: 14_000,
  });
  const receipt = { kind: 'provider-proxy-set-published' } as PublicationReceipt;

  function recoveredAuthority(): DurableProviderProxyOperationAuthority {
    const faults = createProviderProxyAuthorityFaultLatch();
    const unused = async (): Promise<never> => {
      throw new Error('Unexpected recovered operation call');
    };
    return {
      proxyInstanceId: identity.proxyInstanceId,
      setIdentity: identity,
      providerHosts: unexercisedProviderHostControls,
      ...unexercisedControllerSuccessionControls,
      autonomousDeadline: {
        orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
        adoptionWindowMs: Number.MAX_SAFE_INTEGER,
        heartbeatHoldBound: { spanMs: Number.MAX_SAFE_INTEGER, materialSchedulerLatenessMs: Number.MAX_SAFE_INTEGER },
      },
      faulted: faults.faulted,
      onFault: faults.onFault,
      onIncident: faults.onIncident,
      redeemControl: unused,
      promoteControl: unused,
      registerSuccessionOperation: async () => ({ kind: 'registered' }),
      stopAndReap: async () => ({ unconfirmed: 'not observed' }),
      commitContainment: async () => ({ kind: 'outcome-unknown', error: 'not observed' }),
      stopHeartbeats: () => undefined,
      initiateControlClose: async () => undefined,
      prepareOperation: unused,
      inspectOperation: unused,
      authorizeOperation: unused,
      activatePreparedOperation: unused,
      attachOperation: unused,
      cancelOperation: unused,
      settleOperation: unused,
      sendOperation: unused,
      buildOperationControl: () => ({ stop: unused }),
    };
  }

  it('keeps repeated unknown exact-capsule redemptions local and clears the durable hold on redemption', async () => {
    const runtime = new SimulationRuntime();
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const proof = createTestProviderProxyContainmentProofProducer(runtime, db);
    const fatal = vi.fn();
    const redeem = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('initial capsule observation failed'), { code: 'EIO' }))
      .mockRejectedValueOnce(new Error('repeated capsule observation failed'))
      .mockResolvedValue({
        kind: 'redeemed',
        set: recoveredAuthority(),
        publicationReceipt: receipt,
        protection: 'protected',
      });
    const dispositions = new ProviderProxySetOperatorDispositionStore(runtime.storage, '/coral/run');
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: identity.buildSetId,
      claims,
      capacity: { maxSets: 4, idleRetirement: { kind: 'never' } },
      time: runtime.time,
      controlEstablished: vi.fn(),
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher(
        { 'capsule-redemption': redeem, 'containment-proof': proof },
        fatal,
      ),
      reapRecordedContainment: async () => {
        throw new Error('Unknown capsule observation must not authorize reaping');
      },
      operatorDispositionStore: dispositions,
      writerIncarnation: randomUUID(),
      collectOperatorDispositionContainmentProof: (identity, signal) => proof({ identity, signal }),
      reobserveAcquisitionContainment: async () => ({ kind: 'held', observation: 'unknown', reason: 'not observed' }),
      fenceProviderOperationMutations: (identity) => providerOperationMutationAdmission(db).closeSet(identity),
      reportLifecycle: vi.fn(),
    });
    lifecycle.activateDurableOperatorDispositions();
    try {
      lifecycle.installDiscoveredCapsules([{ path: '/coral/capsule.json', capsule }], {
        observeRecordedProcess: () => 'unknown',
      });
      await drainMicrotasks(80);
      for (const attempt of [1, 2]) {
        expect(redeem).toHaveBeenCalledTimes(attempt);
        expect(fatal).not.toHaveBeenCalled();
        expect(lifecycle.snapshot()).toMatchObject({
          startupDiscoveryCompleted: true,
          operatorSets: [
            expect.objectContaining({
              autonomousDisposition: expect.objectContaining({ kind: 'control-or-containment' }),
              holds: [
                expect.objectContaining({
                  disposition: 'held',
                  incidentReason: 'observation-unknown:capsule-redemption',
                }),
              ],
            }),
          ],
        });
        expect(dispositions.read().records).toEqual([
          expect.objectContaining({
            subjectKey: 'inheritance-observation',
            disposition: expect.objectContaining({
              disposition: 'held',
              incidentReason: 'observation-unknown:capsule-redemption',
            }),
          }),
        ]);
        expect(lifecycle.beginFreshAcquisition(`unrelated-launch-${attempt}`).kind).toBe('accepted');
        runtime.time.tick(attempt * 1000);
        await drainMicrotasks(80);
      }
      expect(redeem).toHaveBeenCalledTimes(3);
      expect(fatal).not.toHaveBeenCalled();
      expect(dispositions.read().records.some(({ subjectKey }) => subjectKey === 'inheritance-observation')).toBe(
        false,
      );
      expect(
        lifecycle
          .snapshot()
          .operatorSets.flatMap(({ holds }) => holds)
          .some(({ incidentReason }) => incidentReason === 'observation-unknown:capsule-redemption'),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it.each(['typed-invariant', 'malformed-result', 'identity-disagreement'] as const)(
    'keeps exact-capsule %s fatal',
    async (violation) => {
      const fatal = vi.fn();
      const retry = vi.fn();
      const typed = new ProviderProxySetInheritanceCorruptionError(
        'capsule_identity_disagreement',
        'Invalid capsule identity',
      );
      const dispatcher = createTestProviderProxyRecoveryDispatcher(
        {
          'capsule-redemption': async () => {
            if (violation === 'typed-invariant') throw typed;
            if (violation === 'malformed-result') return { kind: 'invalid' } as never;
            const otherProxyInstanceId = randomUUID();
            return {
              kind: 'redeemed',
              set: {
                ...recoveredAuthority(),
                proxyInstanceId: otherProxyInstanceId,
                setIdentity: { ...identity, proxyInstanceId: otherProxyInstanceId },
              },
              publicationReceipt: receipt,
              protection: 'protected',
            };
          },
        },
        fatal,
      );
      dispatcher
        .begin('exact-capsule-recovery', { setIdentity: identity, capsule }, { evidence: vi.fn(), retry, fatal })
        .start({
          sourceId: 'redemption',
          producerId: 'capsule-redemption',
          input: { capsule, capsulePath: '/coral/capsule.json', signal: new AbortController().signal },
        });
      await vi.waitFor(() => expect(fatal).toHaveBeenCalled());
      expect(isProviderProxyRecoveryFatalError(fatal.mock.calls[0]?.[0])).toBe(true);
      if (violation === 'typed-invariant') expect(fatal.mock.calls[0]?.[0].cause).toBe(typed);
      expect(retry).not.toHaveBeenCalled();
    },
  );

  it('clears recovered acquisition publication holds without clearing another same-set disposition', async () => {
    const runtime = new SimulationRuntime();
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const proof = createTestProviderProxyContainmentProofProducer(runtime, db);
    const fatal = vi.fn();
    const authority = recoveredAuthority();
    let finishRedemption!: (outcome: {
      kind: 'redeemed';
      set: DurableProviderProxyOperationAuthority;
      publicationReceipt: PublicationReceipt;
      protection: 'protected';
    }) => void;
    const redemption = new Promise<{
      kind: 'redeemed';
      set: DurableProviderProxyOperationAuthority;
      publicationReceipt: PublicationReceipt;
      protection: 'protected';
    }>((resolve) => {
      finishRedemption = resolve;
    });
    const redeem = vi.fn().mockRejectedValueOnce(new Error('reobserve capsule')).mockReturnValue(redemption);
    const dispositions = new ProviderProxySetOperatorDispositionStore(runtime.storage, '/coral/run');
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: identity.buildSetId,
      claims,
      capacity: { maxSets: 4, idleRetirement: { kind: 'never' } },
      time: runtime.time,
      controlEstablished: vi.fn(),
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher(
        { 'capsule-redemption': redeem, 'containment-proof': proof },
        fatal,
      ),
      reapRecordedContainment: async () => {
        throw new Error('Publication uncertainty cannot authorize reaping');
      },
      operatorDispositionStore: dispositions,
      writerIncarnation: randomUUID(),
      collectOperatorDispositionContainmentProof: (identity, signal) => proof({ identity, signal }),
      reobserveAcquisitionContainment: async () => ({ kind: 'held', observation: 'unknown', reason: 'not observed' }),
      fenceProviderOperationMutations: (identity) => providerOperationMutationAdmission(db).closeSet(identity),
      reportLifecycle: vi.fn(),
    });
    const faults = createProviderProxyAuthorityFaultLatch();
    const client: ControlClient = {
      exchange: async () =>
        controlExchangeForTest({
          kind: 'not-sent',
          cause: 'connection-already-closed',
          error: new Error('publication channel closed'),
        }),
      close: vi.fn(),
      faulted: new Promise(() => {}),
      onFault: () => () => {},
    };
    const base = {
      ...authority,
      controlReattachment: {
        redeem: async (): Promise<never> => {
          throw new Error('Unexpected session redemption');
        },
        promote: async (): Promise<never> => {
          throw new Error('Unexpected session promotion');
        },
      },
    };
    const sharedIdentity = {
      generation: 'gen2' as const,
      flavor: 'prod' as const,
      buildSetId: identity.buildSetId,
      hostFingerprint: identity.hostFingerprint,
    };
    const session = createOwnedProviderProxyAcquisitionControlSession(
      providerProxyControlSessionOwner.providerHostManager,
      {
        base,
        setIdentity: identity,
        capsulePath: '/coral/capsule.json',
        capsuleBinding: capsule,
        mutationRpcTimeoutMs: 1000,
        clients: { guardian: client, reaper: client, proxy: client },
        heartbeats: { guardian: { stop: vi.fn() }, reaper: { stop: vi.fn() }, proxy: { stop: vi.fn() } },
        faults,
        guardianIdentity: {
          ...sharedIdentity,
          guardianInstanceId: identity.guardianInstanceId,
          pid: identity.guardianPid,
          incarnation: identity.guardianIncarnation,
          canonicalControlEndpoint: identity.guardianControlEndpoint,
        },
        reaperIdentity: {
          ...sharedIdentity,
          guardianInstanceId: identity.guardianInstanceId,
          reaperInstanceId: identity.reaperInstanceId,
          pid: identity.reaperPid,
          incarnation: identity.reaperIncarnation,
          canonicalControlEndpoint: identity.reaperControlEndpoint,
          containmentKind: identity.containmentKind,
        },
        proxyIdentity: {
          ...sharedIdentity,
          guardianInstanceId: identity.guardianInstanceId,
          reaperInstanceId: identity.reaperInstanceId,
          proxyInstanceId: identity.proxyInstanceId,
          pid: identity.proxyPid,
          incarnation: identity.proxyIncarnation,
          processGroupId: identity.proxyProcessGroupId,
          canonicalEndpoint: identity.canonicalEndpoint,
        },
      },
    );
    lifecycle.activateDurableOperatorDispositions();
    lifecycle.completeStartupDiscovery();
    try {
      const acquisition = lifecycle.beginFreshAcquisition('publication-route');
      expect(acquisition.kind).toBe('accepted');
      if (acquisition.kind !== 'accepted') throw new Error('Expected fresh acquisition');
      lifecycle.acquisitionPublicationUnknown(
        acquisition.slotId,
        {
          kind: 'handed-over',
          session,
          incident: { kind: 'publication-unknown', role: 'guardian', reason: 'publication unconfirmed' },
        },
        (value) => value,
      );
      await drainMicrotasks(80);
      expect(client.close).toHaveBeenCalledTimes(3);
      expect(redeem).toHaveBeenCalledTimes(1);
      expect(lifecycle.authorizeOperatorExit(providerProxySetAddress(identity)).kind).toBe('deadline-pending');
      const sibling = dispositions
        .read()
        .records.find(({ subjectKey }) => subjectKey === JSON.stringify(['operator-exit', null]));
      expect(sibling).toBeDefined();
      expect(dispositions.read().records).toHaveLength(3);
      runtime.time.tick(1000);
      await drainMicrotasks(80);
      expect(redeem).toHaveBeenCalledTimes(2);
      finishRedemption({ kind: 'redeemed', set: authority, publicationReceipt: receipt, protection: 'protected' });
      await drainMicrotasks(80);
      expect(lifecycle.authorityFor(identity)).toBe(authority);
      expect(dispositions.read().records).toEqual([
        expect.objectContaining({
          key: sibling?.key,
          subjectKey: sibling?.subjectKey,
          disposition: sibling?.disposition,
        }),
      ]);
      expect(lifecycle.snapshot().operatorSets).toEqual([
        expect.objectContaining({
          holds: [
            expect.objectContaining({ disposition: 'operator-exit-refused', waitingFor: 'set-adoption-deadline' }),
          ],
        }),
      ]);
      expect(fatal).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each(['invariant', 'observation'] as const)(
    'classifies a real exact-capsule reap %s at its recovery owner',
    async (failure) => {
      const runtime = new SimulationRuntime();
      vi.spyOn(runtime.process, 'readProcessIncarnation').mockReturnValue(null);
      vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue('absent');
      const kill = vi.spyOn(runtime.process, 'kill');
      runtime.process.observeRecordedProcessAsync = async () => {
        throw Object.assign(new Error('Process observation unavailable'), { code: 'EIO' });
      };
      const reapIdentity =
        failure === 'invariant' ? { ...identity, proxyProcessGroupId: identity.proxyPid + 1 } : identity;
      const reapCapsule = handoffCapsuleV3Schema.parse({
        ...capsule,
        proxyProcessGroupId: reapIdentity.proxyProcessGroupId,
      });
      const db = newRawDatabase(':memory:');
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const claims = new ProviderProxySetClaimMirror();
      claims.initialize([]);
      const prover = createProviderProxySetContainmentProver(runtime);
      const proof = ({ identity, signal }: { identity: ProviderProxySetIdentity; signal: AbortSignal }) => {
        const mutationFence = providerOperationMutationAdmission(db).closeSet(identity);
        return prover.collectContainmentProof(
          authorizeProviderProxySetContainmentProof(identity, {
            mutationFence,
            closeAdmission: async () => {
              if (mutationFence.kind === 'holding') await mutationFence.retryAfter;
            },
          }),
          db,
          signal,
        );
      };
      const fatal = vi.fn();
      const redeem = vi.fn(async () => ({
        kind: 'temporarily-unavailable' as const,
        incident: { kind: 'transfer-status-unconfirmed' as const },
      }));
      const reap = vi.fn(createProviderProxySetRecordedContainmentReaper(runtime));
      const dispositions = new ProviderProxySetOperatorDispositionStore(runtime.storage, '/coral/run');
      const lifecycle = new ProviderProxySetLifecycle({
        buildSetId: reapIdentity.buildSetId,
        claims,
        capacity: { maxSets: 4, idleRetirement: { kind: 'never' } },
        time: runtime.time,
        controlEstablished: vi.fn(),
        recoveryDispatcher: createTestProviderProxyRecoveryDispatcher(
          { 'capsule-redemption': redeem, 'containment-proof': proof },
          fatal,
        ),
        reapRecordedContainment: reap,
        operatorDispositionStore: dispositions,
        writerIncarnation: randomUUID(),
        collectOperatorDispositionContainmentProof: (identity, signal) => proof({ identity, signal }),
        reobserveAcquisitionContainment: async () => ({ kind: 'held', observation: 'unknown', reason: 'not observed' }),
        fenceProviderOperationMutations: (identity) => providerOperationMutationAdmission(db).closeSet(identity),
        reportLifecycle: vi.fn(),
      });
      lifecycle.activateDurableOperatorDispositions();
      try {
        lifecycle.installDiscoveredCapsules([{ path: '/coral/reap.handoff.v3.json', capsule: reapCapsule }], {
          observeRecordedProcess: () => 'unknown',
        });
        await drainMicrotasks(80);
        expect(reap).toHaveBeenCalledOnce();
        expect(kill).not.toHaveBeenCalled();
        if (failure === 'invariant') {
          await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
          const error = fatal.mock.calls[0]?.[0];
          expect(isProviderProxyRecoveryFatalError(error)).toBe(true);
          expect(error.cause).toBeInstanceOf(ProcessContainmentInvariantError);
          expect(error.cause).toMatchObject({
            code: 'process_identity_unverified',
            context: { pid: reapIdentity.proxyPid, processGroupId: reapIdentity.proxyProcessGroupId },
          });
          runtime.time.tick(1000);
          await drainMicrotasks(80);
          expect(reap).toHaveBeenCalledOnce();
        } else {
          expect(fatal).not.toHaveBeenCalled();
          expect(dispositions.read().records).toEqual([
            expect.objectContaining({
              subjectKey: 'inheritance-observation',
              disposition: expect.objectContaining({
                disposition: 'held',
                incidentReason: 'recorded-containment-unavailable:observation-failed',
              }),
            }),
          ]);
          expect(lifecycle.snapshot().operatorSets).toEqual([
            expect.objectContaining({
              holds: [
                expect.objectContaining({
                  disposition: 'held',
                  incidentReason: 'recorded-containment-unavailable:observation-failed',
                }),
              ],
            }),
          ]);
          runtime.time.tick(1000);
          await drainMicrotasks(80);
          expect(reap).toHaveBeenCalledTimes(2);
          expect(fatal).not.toHaveBeenCalled();
        }
      } finally {
        db.close();
      }
    },
  );

  it.each([
    { signalDelivered: false, decision: 'redemption' as const },
    { signalDelivered: true, decision: 'absence' as const },
  ])(
    'retains a real exact-capsule deadline hold until $decision decides (signalDelivered=$signalDelivered)',
    async ({ signalDelivered, decision }) => {
      const runtime = new SimulationRuntime();
      let decided = false;
      let processesAbsent = !signalDelivered;
      let overrunPending = !signalDelivered;
      vi.spyOn(runtime.process, 'readProcessIncarnation').mockImplementation((pid) => {
        if (decided && decision === 'redemption') {
          if (pid === identity.guardianPid) return identity.guardianIncarnation;
          if (pid === identity.reaperPid) return identity.reaperIncarnation;
        }
        return !processesAbsent && pid === identity.proxyPid ? identity.proxyIncarnation : null;
      });
      vi.spyOn(runtime.process, 'observeLiveness').mockImplementation((pid) => {
        if (decided && decision === 'redemption') return 'alive';
        return !processesAbsent && (pid === identity.proxyPid || pid === -identity.proxyProcessGroupId)
          ? 'alive'
          : 'absent';
      });
      const kill = vi.spyOn(runtime.process, 'kill').mockReturnValue(true);
      runtime.process.observeRecordedProcessAsync = async () => {
        if (overrunPending) {
          overrunPending = false;
          containmentClock.milliseconds = (containmentClock.milliseconds ?? 0n) + BigInt(PROXY_TEARDOWN_RESERVE_MS + 1);
        }
        return processesAbsent ? 'absent' : 'alive';
      };
      const db = newRawDatabase(':memory:');
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const claims = new ProviderProxySetClaimMirror();
      claims.initialize([]);
      const prover = createProviderProxySetContainmentProver(runtime);
      const proof = ({
        identity: observedIdentity,
        signal,
      }: {
        identity: ProviderProxySetIdentity;
        signal: AbortSignal;
      }) => {
        const mutationFence = providerOperationMutationAdmission(db).closeSet(observedIdentity);
        return prover.collectContainmentProof(
          authorizeProviderProxySetContainmentProof(observedIdentity, {
            mutationFence,
            closeAdmission: async () => {
              if (mutationFence.kind === 'holding') await mutationFence.retryAfter;
            },
          }),
          db,
          signal,
        );
      };
      const realReap = createProviderProxySetRecordedContainmentReaper(runtime);
      const signalObserved = vi.fn();
      const reap = vi.fn<ProviderProxySetRecordedContainmentReaper>(
        (observedIdentity, sealed, signal, onSignal, assertSignalAuthorized, absenceObserver) => {
          overrunPending = !decided && !signalDelivered;
          return realReap(
            observedIdentity,
            sealed,
            signal,
            (sent) => {
              signalObserved(sent);
              if (!decided) overrunPending = true;
              onSignal(sent);
            },
            assertSignalAuthorized,
            absenceObserver,
          );
        },
      );
      const fatal = vi.fn();
      const authority = recoveredAuthority();
      const redeem = vi.fn(async () => {
        if (decided && decision === 'redemption')
          return {
            kind: 'redeemed' as const,
            set: authority,
            publicationReceipt: receipt,
            protection: 'protected' as const,
          };
        throw new Error('Capsule redemption observation did not decide');
      });
      const dispositions = new ProviderProxySetOperatorDispositionStore(runtime.storage, '/coral/run');
      const lifecycle = new ProviderProxySetLifecycle({
        buildSetId: identity.buildSetId,
        claims,
        capacity: { maxSets: 4, idleRetirement: { kind: 'never' } },
        time: runtime.time,
        controlEstablished: vi.fn(),
        recoveryDispatcher: createTestProviderProxyRecoveryDispatcher(
          {
            'capsule-redemption': redeem,
            'containment-proof': proof,
            'capsule-retirement': ({ path }) => retireProviderHandoffCapsule(runtime.storage, path),
          },
          fatal,
        ),
        reapRecordedContainment: reap,
        operatorDispositionStore: dispositions,
        writerIncarnation: randomUUID(),
        collectOperatorDispositionContainmentProof: (observedIdentity, signal) =>
          proof({ identity: observedIdentity, signal }),
        reobserveAcquisitionContainment: async () => ({ kind: 'held', observation: 'unknown', reason: 'not observed' }),
        fenceProviderOperationMutations: (observedIdentity) =>
          providerOperationMutationAdmission(db).closeSet(observedIdentity),
        reportLifecycle: vi.fn(),
      });
      lifecycle.activateDurableOperatorDispositions();
      try {
        containmentClock.milliseconds = 0n;
        expect(dispositions.read().records).toEqual([]);
        lifecycle.installDiscoveredCapsules([{ path: '/coral/deadline.handoff.v3.json', capsule }], {
          observeRecordedProcess: () => 'unknown',
        });
        await drainMicrotasks(80);
        const reason = `identity-unobservable:signalDelivered=${signalDelivered}`;
        expect(reap).toHaveBeenCalledOnce();
        expect(await reap.mock.results[0]?.value).toEqual({ kind: 'identity-unobservable', signalDelivered });
        expect(dispositions.read().records).toEqual([
          expect.objectContaining({
            subjectKey: 'inheritance-observation',
            disposition: expect.objectContaining({ disposition: 'held', incidentReason: reason }),
          }),
        ]);
        expect(lifecycle.snapshot().operatorSets).toEqual([
          expect.objectContaining({
            holds: [expect.objectContaining({ disposition: 'held', incidentReason: reason })],
          }),
        ]);
        expect(lifecycle.beginFreshAcquisition('unrelated-deadline-launch').kind).toBe('accepted');
        expect(lifecycle.authorizeOperatorExit(providerProxySetAddress(identity)).kind).toBe('deadline-pending');
        const sibling = dispositions
          .read()
          .records.find(({ subjectKey }) => subjectKey === JSON.stringify(['operator-exit', null]));
        expect(sibling).toBeDefined();
        runtime.time.tick(1000);
        await drainMicrotasks(80);
        expect(reap).toHaveBeenCalledTimes(2);
        expect(await reap.mock.results[1]?.value).toEqual({ kind: 'identity-unobservable', signalDelivered });
        expect(dispositions.read().records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ key: sibling?.key, disposition: sibling?.disposition }),
            expect.objectContaining({
              subjectKey: 'inheritance-observation',
              disposition: expect.objectContaining({ incidentReason: reason }),
            }),
          ]),
        );
        expect(signalObserved).toHaveBeenCalledTimes(signalDelivered ? 2 : 0);
        expect(kill).toHaveBeenCalledTimes(signalDelivered ? 2 : 0);
        decided = true;
        processesAbsent = true;
        runtime.time.tick(2000);
        await drainMicrotasks(80);
        expect(fatal).not.toHaveBeenCalled();
        await vi.waitFor(() =>
          expect(dispositions.read().records.some(({ subjectKey }) => subjectKey === 'inheritance-observation')).toBe(
            false,
          ),
        );
        expect(
          lifecycle
            .snapshot()
            .operatorSets.flatMap(({ holds }) => holds)
            .some(({ incidentReason }) => incidentReason === reason),
        ).toBe(false);
        if (decision === 'redemption') {
          expect(redeem).toHaveBeenCalledTimes(3);
          expect(dispositions.read().records).toEqual(
            expect.arrayContaining([expect.objectContaining({ key: sibling?.key, disposition: sibling?.disposition })]),
          );
        } else {
          expect(await reap.mock.results[2]?.value).toMatchObject({ kind: 'containment-absent' });
          await vi.waitFor(() => expect(dispositions.read().records).toEqual([]));
        }
        expect(fatal).not.toHaveBeenCalled();
      } finally {
        containmentClock.milliseconds = null;
        db.close();
      }
    },
  );
});
