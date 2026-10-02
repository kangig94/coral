import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimerHandle } from '#src/infra/port-types.js';
import { type ProcessIncarnation, type ProcessLiveness } from '#src/infra/node-process.js';
import { ControlClientError } from '#src/provider-proxy/control-client.js';
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
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import {
  ProviderProxySetLifecycle,
  type ProviderProxySetLifecycleDeps,
  type ProviderProxySetOperatorExitCapability,
} from '#src/coordinator/services/provider-proxy-set/index.js';
import { ProviderProxySetOperatorDispositionStore } from '#src/coordinator/services/provider-proxy-set/operator-disposition-store.js';
import { type ProviderProxySetRecordedContainmentReaper } from '#src/coordinator/services/provider-proxy-set/recorded-containment-reaper.js';
import type { ProviderContainmentDisappearanceConsumer } from '#src/coordinator/services/provider-containment-disappearance.js';
import {
  providerProxySetAddress,
  providerProxySetIdentityFromRecord,
} from '#src/coordinator/services/provider-proxy-set/identity.js';
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
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
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

function terminalAuthorityFault(): ProviderProxyAuthorityFault {
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
  fenceProviderOperationMutations?: ProviderProxySetLifecycleDeps['fenceProviderOperationMutations'];
  reportLifecycle?: ProviderProxySetLifecycleDeps['reportLifecycle'];
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
    time: deps.time,
    controlEstablished: deps.controlEstablished,
    recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
      'containment-proof': ({ identity, signal }) => collectProof(identity, signal),
      'capsule-retirement': () => ({ kind: 'retired' }),
      'disappearance-consumer': ({ notice }) => deps.disappearanceConsumer.containmentDisappeared(notice),
    }),
    reapRecordedContainment: deps.reapRecordedContainment ?? reapContainmentEvidence,
    reportLifecycle: deps.reportLifecycle ?? (() => undefined),
    operatorDispositionStore: new ProviderProxySetOperatorDispositionStore(
      new InMemoryStorage(deps.time),
      DURABLE_DISPOSITION_RUN_DIR,
    ),
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

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
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
});
