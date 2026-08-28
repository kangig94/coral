import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { TimerHandle } from '#src/infra/port-types.js';
import {
  createRecordedProcessObserver,
  observeProcessLiveness,
  probeProcessIncarnation,
  type ProcessIncarnation,
  type ProcessLiveness,
  type RecordedProcessObserver,
} from '#src/infra/node-process.js';
import type {
  HandoffCapsule,
  HandoffCapsuleV1,
  HandoffCapsuleV2,
  HandoffCapsuleV3,
} from '#src/provider-proxy/handoff-capsule.js';
import {
  ControlClientError,
  controlExchangeForTest,
  type ControlExchange,
} from '#src/provider-proxy/control-client.js';
import { heartbeatObservationFromExchange } from '#src/provider-proxy/heartbeat-observation.js';
import type { ProviderProxyHeartbeatHoldBound } from '#src/provider-proxy/orphan-deadline.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import {
  createProviderProxyAuthorityFaultLatch,
  type ContainmentRequiredControlCallPolicy,
  type ProviderProxyAuthorityFault,
  type ProviderProxyAuthorityFaultLatch,
  type ProviderProxyAuthorityIncident,
  type ProviderProxyHeartbeatObservation,
  type RetrySafeControlCallPolicy,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import {
  ProviderProxySetLifecycle,
  type CapsuleRetirementAttemptOutcome,
  type ProviderProxySetLifecycleDeps,
  type ProviderProxySetLifecycleProgressViolation,
} from '#src/coordinator/services/provider-proxy-set/index.js';
import type {
  DisappearanceDeliveryAttemptOutcome,
  ProviderContainmentDisappearanceConsumer,
} from '#src/coordinator/services/provider-containment-disappearance.js';
import type { ProviderRepresentationAbandonmentConsumer } from '#src/coordinator/services/provider-representation-abandonment.js';
import type {
  ProviderProxyRecoveryDispatcher,
  ProviderProxySetLifecycleFatalError,
} from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import { isProviderProxyRecoveryFatalError } from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import {
  providerProxySetAddress,
  providerProxySetIdentityFromRecord,
} from '#src/coordinator/services/provider-proxy-set/identity.js';
import type {
  ProviderProxySetContainmentProof,
  ProviderProxySetRedemptionOutcome,
} from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { ProviderOperationTerminalMetadataError } from '#src/jobs/provider-operation-terminalization.js';
import type { ProviderOperationTerminalDirective } from '#src/store/provider-operation-record.js';

/** The build this fixture lifecycle belongs to — the same one `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';
/** Mirrors the unexported `PRESERVE_REPORT_INTERVAL_MS` in `provider-proxy-set/index.ts`. */
const PRESERVE_REPORT_INTERVAL_MS = 60_000;

const enforcersUnobservable: ProviderProxySetContainmentProof = {
  kind: 'enforcer-unobservable',
  roles: ['guardian', 'reaper'],
};
const noContainmentProof = async (): Promise<ProviderProxySetContainmentProof> => enforcersUnobservable;
/** Nothing observed is never absence, so every discovered capsule is retained and no retirement begins. */
const retainsEveryCapsule = { observeRecordedProcess: () => 'unknown' as const };
/** Every recorded process proven gone — the one observation that may retire a capsule. */
const observesEveryRoleAbsent = { observeRecordedProcess: () => 'absent' as const };
const FOREIGN_BUILD_SET_ID = '88888888-8888-4888-8888-888888888888';
const ignoreControlEstablished = (): void => undefined;
const operationPolicy: RetrySafeControlCallPolicy = {
  method: 'operation.settle.v1',
  phase: 'settlement-pending',
  effect: 'mutation',
  indeterminate: 'retry-safe',
  preEffectProtocolCodes: new Set(),
};
const containmentOperationPolicy: ContainmentRequiredControlCallPolicy = {
  method: 'operation.cancel.v1',
  phase: 'prestart-cleanup-pending',
  effect: 'mutation',
  indeterminate: 'requires-containment',
  preEffectProtocolCodes: new Set(),
};
const reportLifecycleIsRequired: Record<PropertyKey, never> extends Pick<
  ProviderProxySetLifecycleDeps,
  'reportLifecycle'
>
  ? false
  : true = true;

/**
 * The whole capability handed to capsule installation: one answer about one recorded process. A second key here
 * would let installation act on a process it may only observe.
 */
const _installationInputsCarryOnlyObservation: keyof Parameters<
  ProviderProxySetLifecycle['installDiscoveredCapsules']
>[1] extends 'observeRecordedProcess'
  ? true
  : false = true;
/** A process port on the dependency contract would carry spawn, exec and kill along with the observation. */
const _lifecycleDepsCarryNoProcessPort: 'process' extends keyof ProviderProxySetLifecycleDeps ? false : true = true;

function terminalAuthorityFault(): ProviderProxyAuthorityFault {
  return {
    kind: 'heartbeat-failed',
    role: 'proxy',
    method: 'control.heartbeat.v1',
    terminalReason: 'teardown-latched',
    error: 'teardown latched',
  };
}

type HeartbeatTestObservation =
  | Readonly<{ kind: 'accepted'; nextChallenge?: string }>
  | Readonly<{ kind: 'challenge-mismatch'; nextChallenge?: string }>
  | Readonly<{ kind: 'unusable'; error?: string | ControlClientError }>
  | Readonly<{ kind: 'method-not-found'; error?: string | ControlClientError }>
  | Readonly<{ kind: 'no-response-before-deadline'; error?: string | ControlClientError }>;

function heartbeatRefusalExchange(error: ControlClientError): ControlExchange {
  if (error.remoteFailure === null) throw new Error('test heartbeat refusal lacks remote failure');
  return controlExchangeForTest({
    kind: 'response',
    response: { kind: 'refusal', failure: error.remoteFailure, error },
  });
}

function heartbeatAuthorityObservation(
  observation: HeartbeatTestObservation,
  options: Readonly<{
    role?: ProviderProxyHeartbeatObservation['role'];
    method?: ProviderProxyHeartbeatObservation['method'];
    schedulerLatenessMs?: number;
  }> = {},
): ProviderProxyHeartbeatObservation {
  const message = 'error' in observation ? String(observation.error ?? observation.kind) : observation.kind;
  let exchange: ControlExchange;
  switch (observation.kind) {
    case 'accepted':
      exchange = controlExchangeForTest({
        kind: 'response',
        response: {
          kind: 'result',
          value: { state: 'active', nextHeartbeatChallenge: observation.nextChallenge ?? 'next-challenge' },
        },
      });
      break;
    case 'challenge-mismatch': {
      const error = new ControlClientError('control_call_failed', message, 'remote-response', {
        kind: 'json-rpc-error',
        jsonRpcCode: -32_600,
        protocolCode: 'invalid_request',
        admissionReason: null,
        heartbeatRefusal: {
          reason: 'challenge-mismatch',
          nextHeartbeatChallenge: observation.nextChallenge ?? 'resynchronized-challenge',
        },
      });
      exchange = heartbeatRefusalExchange(error);
      break;
    }
    case 'method-not-found': {
      const error = new ControlClientError('control_call_failed', message, 'remote-response', {
        kind: 'json-rpc-error',
        jsonRpcCode: -32_601,
        protocolCode: 'method_not_found',
        admissionReason: null,
        heartbeatRefusal: null,
      });
      exchange = heartbeatRefusalExchange(error);
      break;
    }
    case 'unusable': {
      const error = new ControlClientError('control_call_failed', message, 'remote-response', {
        kind: 'json-rpc-error',
        jsonRpcCode: -32_600,
        protocolCode: 'invalid_request',
        admissionReason: null,
        heartbeatRefusal: null,
      });
      exchange = heartbeatRefusalExchange(error);
      break;
    }
    case 'no-response-before-deadline': {
      const error =
        observation.error instanceof ControlClientError
          ? observation.error
          : new ControlClientError('control_call_failed', message, 'timeout');
      exchange = controlExchangeForTest({ kind: 'no-response', cause: 'timeout', error });
      break;
    }
  }
  return {
    kind: 'heartbeat-observation',
    role: options.role ?? 'guardian',
    method: options.method ?? 'guardian.heartbeat.v1',
    observation: heartbeatObservationFromExchange(exchange),
    schedulerLatenessMs: options.schedulerLatenessMs ?? 0,
  };
}

type ProviderProxySetLifecycleFixtureDeps = Omit<
  ProviderProxySetLifecycleDeps,
  'recoveryDispatcher' | 'reportLifecycle' | 'buildSetId'
> &
  Readonly<{
    recoveryDispatcher?: ProviderProxyRecoveryDispatcher;
    reportLifecycle?: ProviderProxySetLifecycleDeps['reportLifecycle'];
    disappearanceConsumer: ProviderContainmentDisappearanceConsumer;
    abandonmentConsumer?: ProviderRepresentationAbandonmentConsumer;
    proveContainmentAbsent(
      identity: ReturnType<typeof providerProxySetIdentityFromRecord>,
      signal: AbortSignal,
    ): Promise<ProviderProxySetContainmentProof>;
    retireCapsule?(path: string): Promise<CapsuleRetirementAttemptOutcome> | CapsuleRetirementAttemptOutcome;
    onFatal?(error: ProviderProxySetLifecycleFatalError): void;
    redeemCapsule?(
      capsule: HandoffCapsule,
      capsulePath: string,
      signal: AbortSignal,
    ): Promise<ProviderProxySetRedemptionOutcome>;
  }>;

function lifecycleFor(deps: ProviderProxySetLifecycleFixtureDeps): ProviderProxySetLifecycle {
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
      'containment-proof': ({ identity, signal }) => deps.proveContainmentAbsent(identity, signal),
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
    ...lifecycleDeps
  } = deps;
  return new ProviderProxySetLifecycle({
    buildSetId: FIXTURE_BUILD_SET_ID,
    ...lifecycleDeps,
    recoveryDispatcher: suppliedDispatcher ?? recoveryDispatcher,
    reportLifecycle: lifecycleDeps.reportLifecycle ?? (() => undefined),
  });
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

/**
 * Runs a manual clock forward one scheduled wake at a time until nothing is waiting, always waking a
 * millisecond after the requested time so that a retry which reported lateness would be caught reporting it.
 * Bounded so a schedule that never terminates fails the count assertion that called this rather than hanging
 * the suite.
 */
async function settleScheduledWork(clock: ManualClock): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await drainMicrotasks();
    const pending = clock.timers.filter((timer) => timer.active);
    if (pending.length === 0) return;
    clock.elapse(Math.max(...pending.map((timer) => timer.at)) + 1 - clock.nowMs);
    clock.runDue();
  }
  await drainMicrotasks();
}

function fakeAuthority(
  options: {
    record?: ReturnType<typeof providerOperationRecord>;
    fault?: ReturnType<typeof deferred<ProviderProxyAuthorityFault>>;
    faults?: ProviderProxyAuthorityFaultLatch;
    stopAndReap?: DurableProviderProxyOperationAuthority['stopAndReap'];
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
  const authority: DurableProviderProxyOperationAuthority = {
    proxyInstanceId: record.operation.proxyInstanceId,
    autonomousDeadline: {
      orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
      adoptionWindowMs: options.adoptionWindowMs ?? Number.MAX_SAFE_INTEGER,
      heartbeatHoldBound: options.heartbeatHoldBound ?? {
        spanMs: Number.MAX_SAFE_INTEGER,
        materialSchedulerLatenessMs: Number.MAX_SAFE_INTEGER,
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
    stopAndReap: options.stopAndReap ?? (async () => ({ unconfirmed: 'not proved' })),
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

function capsuleFor(
  authority: DurableProviderProxyOperationAuthority,
  overrides: Partial<HandoffCapsuleV1> = {},
): HandoffCapsule {
  const identity = authority.setIdentity;
  return {
    version: 1,
    grantId: randomUUID(),
    secret: 'c'.repeat(64),
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: identity.buildSetId,
    hostFingerprint: identity.hostFingerprint,
    guardianInstanceId: identity.guardianInstanceId,
    reaperInstanceId: identity.reaperInstanceId,
    proxyInstanceId: identity.proxyInstanceId,
    guardianControlEndpoint: identity.guardianControlEndpoint,
    reaperControlEndpoint: identity.reaperControlEndpoint,
    proxyEndpoint: identity.canonicalEndpoint,
    orphanTimeoutMs: 30_000,
    teardownReserveMs: 14_000,
    ...overrides,
  };
}

function capsuleV2For(authority: DurableProviderProxyOperationAuthority): HandoffCapsuleV2 {
  const identity = authority.setIdentity;
  return {
    ...capsuleFor(authority),
    version: 2,
    guardianPid: identity.guardianPid,
    guardianProcessStartedAtSeconds: 1_700_000_001,
    proxyPid: identity.proxyPid,
    reaperPid: identity.reaperPid,
    reaperProcessStartedAtSeconds: 1_700_000_003,
    containmentKind: identity.containmentKind,
    proxyProcessStartedAtSeconds: 1_700_000_002,
    proxyProcessGroupId: identity.proxyProcessGroupId,
  };
}

/** This build's own capsule shape written by another build — the case an upgrade actually produces. */
function foreignCapsuleV3For(authority: DurableProviderProxyOperationAuthority): HandoffCapsuleV3 {
  return { ...capsuleV3For(authority), buildSetId: FOREIGN_BUILD_SET_ID };
}

type RecordedCapsule = HandoffCapsuleV2 | HandoffCapsuleV3;
type RecordedRoleName = 'guardian' | 'reaper' | 'proxy';
type RecordedRole = Readonly<{ pid: number; incarnation?: ProcessIncarnation }>;

function recordedRole(capsule: RecordedCapsule, role: RecordedRoleName): RecordedRole {
  const pid = { guardian: capsule.guardianPid, reaper: capsule.reaperPid, proxy: capsule.proxyPid }[role];
  if (capsule.version === 2) return { pid };
  return {
    pid,
    incarnation: {
      guardian: capsule.guardianIncarnation,
      reaper: capsule.reaperIncarnation,
      proxy: capsule.proxyIncarnation,
    }[role],
  };
}

/**
 * What a fresh look at one recorded role finds, said as what the two readers report rather than as the
 * conclusion — the conclusion is the production predicate's to draw, and stating it here would assert the
 * answer into the question.
 *
 * A throwing liveness reader is the only route to `unknown`: through the real `observeProcessLiveness`,
 * `ESRCH` is `absent` and `EPERM` is `alive`, so nothing short of an unexpected errno produces it.
 */
type RoleProbe = Readonly<{
  incarnation?: 'matches' | 'differs';
  liveness: ProcessLiveness | 'throws';
}>;

function scriptedObservation(
  capsule: RecordedCapsule,
  probes: Readonly<Record<RecordedRoleName, RoleProbe>>,
): Readonly<{
  observeRecordedProcess: RecordedProcessObserver;
  observed: RecordedRole[];
  incarnationReads: number[];
}> {
  const roles: readonly RecordedRoleName[] = ['guardian', 'reaper', 'proxy'];
  const scripted = new Map(roles.map((role) => [recordedRole(capsule, role).pid, probes[role]]));
  const recorded = new Map(roles.flatMap((role) => [[role, recordedRole(capsule, role)] as const]));
  const probeFor = (pid: number): RoleProbe => {
    const probe = scripted.get(pid);
    if (probe === undefined) throw new Error(`no probe is scripted for pid ${pid}`);
    return probe;
  };
  const observed: RecordedRole[] = [];
  const incarnationReads: number[] = [];
  const observe = createRecordedProcessObserver({
    readIncarnation: (pid) => {
      incarnationReads.push(pid);
      const probe = probeFor(pid);
      if (probe.incarnation === undefined) return null;
      if (probe.incarnation === 'differs') return testIncarnation(`another-process-on-${pid}`);
      const token = [...recorded.values()].find((role) => role.pid === pid)?.incarnation;
      if (token === undefined) throw new Error(`pid ${pid} records no incarnation to match`);
      return token;
    },
    observeLiveness: (pid) => {
      const probe = probeFor(pid);
      if (probe.liveness === 'throws') throw new Error('the liveness probe failed');
      return probe.liveness;
    },
  });
  return {
    observed,
    incarnationReads,
    observeRecordedProcess: (role) => {
      observed.push({ ...role });
      return observe(role);
    },
  };
}

function capsuleV3For(authority: DurableProviderProxyOperationAuthority): HandoffCapsuleV3 {
  const identity = authority.setIdentity;
  return {
    ...capsuleFor(authority),
    version: 3,
    guardianPid: identity.guardianPid,
    guardianIncarnation: identity.guardianIncarnation,
    proxyPid: identity.proxyPid,
    reaperPid: identity.reaperPid,
    reaperIncarnation: identity.reaperIncarnation,
    containmentKind: identity.containmentKind,
    proxyIncarnation: identity.proxyIncarnation,
    proxyProcessGroupId: identity.proxyProcessGroupId,
  };
}

/**
 * The three facts a retirement-exhaustion warning must carry: which capsule is still on disk, that the hold
 * ended on its bound rather than still running, and what the last attempt reported. An operator can act on
 * none of it without all three; the prose carrying them owes nothing.
 */
function retirementWarningFacts(message: string): Readonly<{
  capsulePath: string | null;
  attempts: string | null;
  lastIncident: string | null;
}> {
  return {
    capsulePath: /\S+\.json/.exec(message)?.[0] ?? null,
    attempts: /\d+ attempts/.exec(message)?.[0] ?? null,
    lastIncident: /\(([a-z-]+(?: code=[A-Z]+)?)\)/.exec(message)?.[1] ?? null,
  };
}

describe('ProviderProxySetLifecycle', () => {
  it('requires the lifecycle reporter in its dependency contract', () => {
    expect(reportLifecycleIsRequired).toBe(true);
  });

  it('reports repeated operation incidents without consuming the terminal fault latch', async () => {
    const faults = createProviderProxyAuthorityFaultLatch();
    const incident = {
      kind: 'operation-control-failed',
      policy: operationPolicy,
      error: 'settlement timeout',
    } as const;
    const incidents: ProviderProxyAuthorityIncident[] = [];
    let terminalFaultObserved = false;
    void faults.faulted.then(() => {
      terminalFaultObserved = true;
    });
    faults.onIncident((next) => {
      incidents.push(next);
    });

    faults.reportIncident(incident);
    faults.reportIncident(incident);
    await Promise.resolve();

    expect(incidents).toEqual([incident, incident]);
    expect(terminalFaultObserved).toBe(false);

    const terminalFault = terminalAuthorityFault();
    faults.latch(terminalFault);
    await expect(faults.faulted).resolves.toEqual(terminalFault);
  });

  it('reports an exact preserve decision for an operation incident', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const authority = fakeAuthority({ record, faults, stopAndReap });
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
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident({
      kind: 'operation-control-failed',
      policy: operationPolicy,
      error: 'settlement timeout',
    });

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(reportLifecycle.mock.calls).toEqual([
      [
        'info',
        `Provider proxy set action=preserve reason=retry_safe_operation_control_failure fault=operation-control-failed subject=operation.settle.v1 liveClaims=1 set=${setReference(authority.setIdentity)} error=settlement timeout`,
      ],
    ]);
  });

  it('preserves a claim-bearing set when a heartbeat echo is unanswered', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const authority = fakeAuthority({ record, faults, stopAndReap });
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
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(lifecycle.routeFor('codex-route')).toBeNull();
    expect(reportLifecycle.mock.calls).toEqual([
      [
        'info',
        `Provider proxy set action=preserve reason=heartbeat_echo_indeterminate fault=heartbeat-indeterminate subject=guardian liveClaims=1 set=${setReference(authority.setIdentity)} error=heartbeat timed out incidentReason=unanswered`,
      ],
    ]);
  });

  it('ends a heartbeat preserve episode only when that role accepts an echo', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const authority = fakeAuthority({ record, faults });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);
    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );
    reportLifecycle.mockClear();

    clock.elapse(120_000);
    clock.runDue();

    expect(reportLifecycle).not.toHaveBeenCalled();

    faults.reportIncident(heartbeatAuthorityObservation({ kind: 'accepted' }));

    expect(reportLifecycle).toHaveBeenCalledExactlyOnceWith('info', expect.stringContaining('subject=guardian'));
    expect(reportLifecycle).toHaveBeenCalledWith('info', expect.stringContaining('summary=recovered suppressed=0'));
  });

  it('clears the exclusive heartbeat window when that role accepts an echo', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      heartbeatHoldBound: { spanMs: 1, materialSchedulerLatenessMs: 1 },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    const noResponse = (): void =>
      faults.reportIncident(heartbeatAuthorityObservation({ kind: 'no-response-before-deadline' }));
    const unusable = (): void => faults.reportIncident(heartbeatAuthorityObservation({ kind: 'unusable' }));

    noResponse();
    unusable();
    faults.reportIncident(heartbeatAuthorityObservation({ kind: 'accepted' }));
    clock.elapse(2);
    noResponse();
    unusable();

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({
        states: ['available'],
        operatorDispositions: [expect.objectContaining({ disposition: 'held', incidentReason: 'unclassified' })],
      }),
    );
  });

  it('reports summary=periodic for a heartbeat hold past the suppression window, the same as for operation-control', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const authority = fakeAuthority({ record, faults });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );
    reportLifecycle.mockClear();

    clock.elapse(PRESERVE_REPORT_INTERVAL_MS);
    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );

    // `main` said "suppressed repeats while the preservation condition remains active" — true of either
    // preserve kind. `summary=periodic` must not be narrowed to operation-control alone.
    expect(reportLifecycle).toHaveBeenCalledExactlyOnceWith(
      'info',
      expect.stringContaining('summary=periodic suppressed=0'),
    );
  });

  it('never schedules a recovery timer for a heartbeat hold, even across repeated incidents past the suppression window', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const authority = fakeAuthority({ record, faults });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );
    clock.elapse(1_000);
    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );
    clock.elapse(PRESERVE_REPORT_INTERVAL_MS);
    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );
    reportLifecycle.mockClear();

    // No accepted echo ever arrives. If any of the three branches above scheduled a recovery timer for this
    // heartbeat-indeterminate report, this would silently close the hold and log `summary=recovered`.
    clock.elapse(10 * PRESERVE_REPORT_INTERVAL_MS);
    clock.runDue();

    expect(reportLifecycle).not.toHaveBeenCalled();
  });

  it('escalates a silence hold after a full span without material scheduler lateness', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      heartbeatHoldBound: { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );
    reportLifecycle.mockClear();

    clock.elapse(2_500);
    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out again' }),
    );
    expect(reportLifecycle.mock.calls.some(([, message]) => message.includes('stop-and-reap'))).toBe(false);

    clock.elapse(2_500);
    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat still unanswered' }),
    );

    expect(reportLifecycle).toHaveBeenCalledWith(
      'warn',
      `Provider proxy set action=stop-and-reap reason=heartbeat_hold_exhausted fault=heartbeat-hold-exhausted subject=guardian liveClaims=1 set=${setReference(authority.setIdentity)} error=heartbeat still unanswered attempts=3 elapsedMs=5000 schedulerLatenessMs=0 lastIncidentReason=unanswered`,
    );
    expect(stopAndReap).toHaveBeenCalledOnce();
  });

  it("keeps concurrent role evidence visible when one role's heartbeat recovers", () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const faults = createProviderProxyAuthorityFaultLatch();
    const authority = fakeAuthority({ faults });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'guardian timed out' }),
    );
    faults.reportIncident(
      heartbeatAuthorityObservation(
        { kind: 'no-response-before-deadline', error: 'proxy timed out' },
        { role: 'proxy', method: 'control.heartbeat.v1' },
      ),
    );

    expect(lifecycle.snapshot().operatorDispositions).toHaveLength(2);
    expect(lifecycle.snapshot().operatorDispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          disposition: 'held',
          role: 'guardian',
          method: 'guardian.heartbeat.v1',
        }),
        expect.objectContaining({ disposition: 'held', role: 'proxy', method: 'control.heartbeat.v1' }),
      ]),
    );

    faults.reportIncident(heartbeatAuthorityObservation({ kind: 'accepted' }));

    expect(lifecycle.snapshot().operatorDispositions).toEqual([
      expect.objectContaining({ disposition: 'held', role: 'proxy', method: 'control.heartbeat.v1' }),
    ]);
  });

  it('keeps a claim-bearing answered-but-unusable set until disappearance reaches the claim', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const stopHeartbeats = vi.fn();
    const initiateControlClose = vi.fn(async () => undefined);
    const absence = deferred<ProviderProxySetContainmentProof>();
    const containmentDisappeared = vi.fn(
      async (notice: Parameters<ProviderContainmentDisappearanceConsumer['containmentDisappeared']>[0]) => ({
        kind: 'accepted' as const,
        acceptance: {
          kind: 'accepted' as const,
          operation: notice.operation,
          disposition: 'terminalization-committed' as const,
        },
      }),
    );
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      stopHeartbeats,
      initiateControlClose,
      heartbeatHoldBound: { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared },
      time: clock,
      proveContainmentAbsent: () => absence.promise,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    const unusable = (error: string): void =>
      faults.reportIncident(heartbeatAuthorityObservation({ kind: 'unusable', error }));

    unusable('answer could not be decoded');
    expect(lifecycle.snapshot().operatorDispositions).toEqual([
      expect.objectContaining({
        disposition: 'held',
        role: 'guardian',
        method: 'guardian.heartbeat.v1',
        incidentReason: 'unclassified',
        waitingFor: 'heartbeat-evidence-window',
      }),
    ]);
    clock.elapse(5_000);
    unusable('answer still could not be decoded');

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(stopHeartbeats).toHaveBeenCalledOnce();
    expect(initiateControlClose).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot()).toEqual(expect.objectContaining({ represented: 1, states: ['containing'] }));
    expect(lifecycle.snapshot().operatorDispositions).toEqual([
      expect.objectContaining({
        disposition: 'awaiting-containment-absence',
        role: 'guardian',
        method: 'guardian.heartbeat.v1',
        incidentReason: 'unclassified',
        waitingFor: 'independent-containment-absence',
      }),
    ]);
    expect(reportLifecycle).toHaveBeenCalledWith(
      'warn',
      `Provider proxy set action=await-containment-absence reason=heartbeat_answer_unusable_hold_exhausted fault=heartbeat-answer-unusable-hold-exhausted subject=guardian liveClaims=1 set=${setReference(authority.setIdentity)} error=answer still could not be decoded attempts=2 elapsedMs=5000 schedulerLatenessMs=0 lastIncidentReason=unclassified`,
    );
    absence.resolve({ kind: 'absent', receipt: 'answered-unusable-absence' });
    await vi.waitFor(() => expect(containmentDisappeared).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));
  });

  it('keeps a claim-bearing method-not-found set until disappearance reaches the claim', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const stopHeartbeats = vi.fn();
    const initiateControlClose = vi.fn(async () => undefined);
    const absence = deferred<ProviderProxySetContainmentProof>();
    const containmentDisappeared = vi.fn(
      async (notice: Parameters<ProviderContainmentDisappearanceConsumer['containmentDisappeared']>[0]) => ({
        kind: 'accepted' as const,
        acceptance: {
          kind: 'accepted' as const,
          operation: notice.operation,
          disposition: 'terminalization-committed' as const,
        },
      }),
    );
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      stopHeartbeats,
      initiateControlClose,
      heartbeatHoldBound: { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared },
      time: clock,
      proveContainmentAbsent: () => absence.promise,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident(
      heartbeatAuthorityObservation(
        { kind: 'no-response-before-deadline', error: 'proxy timed out' },
        { role: 'proxy', method: 'control.heartbeat.v1' },
      ),
    );
    reportLifecycle.mockClear();
    faults.reportIncident(heartbeatAuthorityObservation({ kind: 'method-not-found', error: 'method not found' }));

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(stopHeartbeats).toHaveBeenCalledOnce();
    expect(initiateControlClose).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot()).toEqual(expect.objectContaining({ represented: 1, states: ['containing'] }));
    expect(reportLifecycle).toHaveBeenLastCalledWith(
      'warn',
      `Provider proxy set action=await-containment-absence reason=heartbeat_protocol_incompatible fault=heartbeat-method-not-found subject=guardian liveClaims=1 set=${setReference(authority.setIdentity)} error=method not found incidentReason=method-not-found`,
    );
    absence.resolve({ kind: 'absent', receipt: 'method-not-found-absence' });
    await vi.waitFor(() => expect(containmentDisappeared).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));
  });

  it('requires independent containment absence for a no-claim method-not-found set', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const stopHeartbeats = vi.fn();
    const initiateControlClose = vi.fn(async () => undefined);
    const authority = fakeAuthority({ faults, stopAndReap, stopHeartbeats, initiateControlClose });
    const absence = deferred<ProviderProxySetContainmentProof>();
    const reportLifecycle = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: () => absence.promise,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident(heartbeatAuthorityObservation({ kind: 'method-not-found', error: 'method not found' }));

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(stopHeartbeats).toHaveBeenCalledOnce();
    expect(initiateControlClose).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot().states).toEqual(['containing']);
    // Only the guardian was observed, so only the guardian's subject has a disposition.
    expect(lifecycle.snapshot().operatorDispositions).toEqual([
      expect.objectContaining({
        setIdentity: {
          buildSetId: authority.setIdentity.buildSetId,
          hostFingerprint: authority.setIdentity.hostFingerprint,
          proxyInstanceId: authority.setIdentity.proxyInstanceId,
        },
        disposition: 'awaiting-containment-absence',
        role: 'guardian',
        method: 'guardian.heartbeat.v1',
        incidentReason: 'method-not-found',
        waitingFor: 'independent-containment-absence',
      }),
    ]);
    expect(reportLifecycle).toHaveBeenCalledExactlyOnceWith(
      'warn',
      `Provider proxy set action=await-containment-absence reason=heartbeat_protocol_incompatible fault=heartbeat-method-not-found subject=guardian liveClaims=0 set=${setReference(authority.setIdentity)} error=method not found incidentReason=method-not-found`,
    );
    absence.resolve({ kind: 'absent', receipt: 'method-not-found-no-claim-absence' });
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));
    expect(lifecycle.snapshot().operatorDispositions).toEqual([]);
  });

  it('requires containment absence after a no-claim unusable-answer window exhausts', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const stopHeartbeats = vi.fn();
    const initiateControlClose = vi.fn(async () => undefined);
    const clock = new ManualClock();
    const authority = fakeAuthority({
      faults,
      stopAndReap,
      stopHeartbeats,
      initiateControlClose,
      heartbeatHoldBound: { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 },
    });
    const absence = deferred<ProviderProxySetContainmentProof>();
    const reportLifecycle = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: () => absence.promise,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident(heartbeatAuthorityObservation({ kind: 'unusable', error: 'first unusable answer' }));
    clock.elapse(5_000);
    faults.reportIncident(heartbeatAuthorityObservation({ kind: 'unusable', error: 'second unusable answer' }));

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().represented).toBe(1);
    expect(reportLifecycle).toHaveBeenLastCalledWith(
      'warn',
      `Provider proxy set action=await-containment-absence reason=heartbeat_answer_unusable_hold_exhausted fault=heartbeat-answer-unusable-hold-exhausted subject=guardian liveClaims=0 set=${setReference(authority.setIdentity)} error=second unusable answer attempts=2 elapsedMs=5000 schedulerLatenessMs=0 lastIncidentReason=unclassified`,
    );
    absence.resolve({ kind: 'absent', receipt: 'answered-unusable-no-claim-absence' });
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));
  });

  it('ends a silence window when unusable answers arrive before another unanswered incident', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const initiateControlClose = vi.fn(async () => undefined);
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      initiateControlClose,
      heartbeatHoldBound: { spanMs: 23_000, materialSchedulerLatenessMs: 5_750 },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    const noResponse = (): void =>
      faults.reportIncident(heartbeatAuthorityObservation({ kind: 'no-response-before-deadline' }));
    const unusable = (): void => faults.reportIncident(heartbeatAuthorityObservation({ kind: 'unusable' }));

    noResponse();
    for (let second = 1; second <= 22; second += 1) {
      clock.elapse(1_000);
      unusable();
    }
    clock.elapse(1_000);
    noResponse();

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(initiateControlClose).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().states).toEqual(['available']);
  });

  it('does not escalate a heartbeat hold when scheduler lateness materially caused the span', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      heartbeatHoldBound: { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );

    clock.elapse(23_000);
    faults.reportIncident(
      heartbeatAuthorityObservation(
        { kind: 'no-response-before-deadline', error: 'heartbeat timed out' },
        { schedulerLatenessMs: 18_000 },
      ),
    );

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(reportLifecycle.mock.calls.some(([, message]) => message.includes('stop-and-reap'))).toBe(false);
  });

  it('does not escalate a heartbeat hold when only the wall clock crosses the span', () => {
    // A clock correction or a resumed VM moves `now()` and leaves monotonic time where it was. The hold
    // measures how long this coordinator has actually been asking, so a jump must buy no progress at all —
    // otherwise the same two-observation reap returns through the instrument.
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      heartbeatHoldBound: { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );

    clock.stepWallClock(60_000);
    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(reportLifecycle.mock.calls.some(([, message]) => message.includes('stop-and-reap'))).toBe(false);
  });

  it('escalates a heartbeat hold on monotonic time even while the wall clock runs backwards', () => {
    // The mirror of the case above, and the one that matters more: a backward correction must not be able to
    // delete the proxy role's only automatic exit, because no enforcer deadline stands behind it.
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      heartbeatHoldBound: { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );

    clock.elapse(6_000);
    clock.stepWallClock(-60_000);
    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );

    expect(stopAndReap).toHaveBeenCalledOnce();
  });

  it('never escalates a heartbeat window from challenge-mismatch observations alone', () => {
    // A resynchronized challenge is the peer answering correctly — this coordinator's own prior
    // acknowledgement of an earlier echo was lost, not the peer's response. It must never start, advance, or
    // help satisfy a hold whose whole premise is continuous silence.
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      heartbeatHoldBound: { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    // Six incidents over 12000ms clear the span by a wide margin if they were counted.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      faults.reportIncident(
        heartbeatAuthorityObservation({
          kind: 'challenge-mismatch',
          nextChallenge: `resynchronized-${attempt}`,
        }),
      );
      clock.elapse(2_000);
    }

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(reportLifecycle.mock.calls.some(([, message]) => message.includes('stop-and-reap'))).toBe(false);
  });

  it('clears the exclusive heartbeat window without opening a preserve episode when the tenancy resynchronizes', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      heartbeatHoldBound: { spanMs: 23_000, materialSchedulerLatenessMs: 5_750 },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    const noResponse = (): void =>
      faults.reportIncident(heartbeatAuthorityObservation({ kind: 'no-response-before-deadline' }));
    const unusable = (): void => faults.reportIncident(heartbeatAuthorityObservation({ kind: 'unusable' }));

    noResponse();
    unusable();
    reportLifecycle.mockClear();
    clock.elapse(1_000);
    faults.reportIncident(heartbeatAuthorityObservation({ kind: 'challenge-mismatch' }));
    // Two incident shapes opened two preserve reports, so resynchronization recovers each one.
    expect(reportLifecycle.mock.calls.map(([severity]) => severity)).toEqual(['info', 'info']);
    expect(reportLifecycle.mock.calls.every(([, message]) => message.includes('summary=recovered'))).toBe(true);
    expect(
      reportLifecycle.mock.calls.some(([, message]) => message.includes('incidentReason=challenge-resynchronized')),
    ).toBe(false);
    reportLifecycle.mockClear();
    clock.elapse(24_000);
    noResponse();
    unusable();

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(reportLifecycle.mock.calls.some(([, message]) => message.includes('stop-and-reap'))).toBe(false);
    expect(lifecycle.snapshot().states).toEqual(['available']);
  });

  it('does not split a silence hold when consecutive no-response exchanges have different error identities', () => {
    // The defect this guards against: keying the hold by `[subject, errorIdentity]` (as `preserveReports`
    // does for its own, unrelated log-coalescing purpose) gives each error shape its own `firstObservedAtMonotonicMs`.
    // Every incident below carries an error identity `preserveErrorIdentity` has never seen before on this
    // role/method, so the buggy per-identity keying would find `report === undefined` every single time and
    // could never satisfy its own `report !== undefined` escalation guard — it would hold this role's
    // heartbeat open forever no matter how long the run continues. The fix measures the run itself.
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      heartbeatHoldBound: { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    // The transport can name timeout and connection-closed-after-write without changing the observation:
    // both are no response to a request that was sent, and both advance the one silence window.
    const timeout = new ControlClientError('control_call_failed', 'heartbeat timed out', 'timeout');
    const closed = new ControlClientError('control_client_closed', 'the control channel closed', 'closed');

    faults.reportIncident(heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: timeout }));
    clock.elapse(2_500);
    faults.reportIncident(heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: closed }));
    reportLifecycle.mockClear();

    clock.elapse(2_500);
    faults.reportIncident(heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: timeout }));

    expect(reportLifecycle).toHaveBeenCalledExactlyOnceWith(
      'warn',
      `Provider proxy set action=stop-and-reap reason=heartbeat_hold_exhausted fault=heartbeat-hold-exhausted subject=guardian liveClaims=1 set=${setReference(authority.setIdentity)} error=heartbeat timed out attempts=3 elapsedMs=5000 schedulerLatenessMs=0 lastIncidentReason=unanswered`,
    );
    expect(stopAndReap).toHaveBeenCalledOnce();
  });

  it('does not escalate a heartbeat hold whose span has not yet elapsed, even with attempts to spare', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'unused' }) as const);
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      heartbeatHoldBound: { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );
    clock.elapse(4_999);
    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(reportLifecycle.mock.calls.some(([, message]) => message.includes('stop-and-reap'))).toBe(false);
  });

  it('prefers evicting an operation-control report over a live heartbeat hold', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const authority = fakeAuthority({ record, faults });
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
    lifecycle.registerInheritedSet(authority);

    // The oldest report of all, inserted first: a live heartbeat hold that must survive eviction pressure.
    faults.reportIncident(
      heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
    );

    // 32 distinct operation-control-failed keys fill the set to capacity (1 heartbeat + 31 operation-control),
    // and the 32nd forces an eviction.
    for (let code = 0; code < 32; code += 1) {
      faults.reportIncident({
        kind: 'operation-control-failed',
        policy: operationPolicy,
        error: new ControlClientError('control_call_failed', `remote failure ${code}`, 'remote-response', {
          kind: 'json-rpc-error',
          jsonRpcCode: code,
          protocolCode: null,
          admissionReason: null,
          heartbeatRefusal: null,
        }),
      });
    }

    const evicted = reportLifecycle.mock.calls.filter(([, message]) => message.includes('summary=evicted'));
    expect(evicted).toEqual([['info', expect.stringContaining('error=remote failure 0 summary=evicted suppressed=0')]]);

    // The heartbeat hold's own record survived eviction: an accepted echo still finds it and closes it.
    reportLifecycle.mockClear();
    faults.reportIncident(heartbeatAuthorityObservation({ kind: 'accepted' }));
    expect(reportLifecycle).toHaveBeenCalledExactlyOnceWith(
      'info',
      expect.stringContaining('summary=recovered suppressed=0'),
    );
  });

  it('keys preserve reports by set and method and flushes a suppressed count before authority loss', () => {
    const firstRecord = providerOperationRecord('executing');
    const secondProxyInstanceId = randomUUID();
    const secondRecord = providerOperationRecord('executing', {
      operation: {
        ...firstRecord.operation,
        jobId: randomUUID(),
        operationId: randomUUID(),
        proxyInstanceId: secondProxyInstanceId,
        buildSetId: randomUUID(),
      },
      locator: {
        ...firstRecord.locator,
        hostFingerprint: 'b'.repeat(64),
        proxy: {
          ...firstRecord.locator.proxy,
          instanceId: secondProxyInstanceId,
          controlEndpoint: '/tmp/second-proxy.sock',
        },
        guardian: {
          ...firstRecord.locator.guardian,
          instanceId: randomUUID(),
          controlEndpoint: '/tmp/second-guardian.sock',
        },
        reaper: {
          ...firstRecord.locator.reaper,
          instanceId: randomUUID(),
          controlEndpoint: '/tmp/second-reaper.sock',
        },
      },
    });
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([firstRecord, secondRecord]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const firstFaults = createProviderProxyAuthorityFaultLatch();
    const secondFaults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'still live' }) as const);
    const firstAuthority = fakeAuthority({ record: firstRecord, faults: firstFaults, stopAndReap });
    const secondAuthority = fakeAuthority({ record: secondRecord, faults: secondFaults, stopAndReap });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(firstAuthority);
    lifecycle.registerInheritedSet(secondAuthority);

    const otherMethodPolicy: RetrySafeControlCallPolicy = {
      ...operationPolicy,
      method: 'operation.cancel.v1',
      phase: 'prestart-cleanup-pending',
    };
    const report = (faults: ProviderProxyAuthorityFaultLatch, policy: RetrySafeControlCallPolicy): void =>
      faults.reportIncident({
        kind: 'operation-control-failed',
        policy,
        error: 'settlement timeout',
      });
    report(firstFaults, operationPolicy);
    report(firstFaults, otherMethodPolicy);
    report(secondFaults, operationPolicy);
    report(secondFaults, otherMethodPolicy);
    report(firstFaults, operationPolicy);
    firstFaults.latch(terminalAuthorityFault());

    const firstReference = setReference(firstAuthority.setIdentity);
    const secondReference = setReference(secondAuthority.setIdentity);
    expect(reportLifecycle.mock.calls).toEqual([
      [
        'info',
        `Provider proxy set action=preserve reason=retry_safe_operation_control_failure fault=operation-control-failed subject=operation.settle.v1 liveClaims=1 set=${firstReference} error=settlement timeout`,
      ],
      [
        'info',
        `Provider proxy set action=preserve reason=retry_safe_operation_control_failure fault=operation-control-failed subject=operation.cancel.v1 liveClaims=1 set=${firstReference} error=settlement timeout`,
      ],
      [
        'info',
        `Provider proxy set action=preserve reason=retry_safe_operation_control_failure fault=operation-control-failed subject=operation.settle.v1 liveClaims=1 set=${secondReference} error=settlement timeout`,
      ],
      [
        'info',
        `Provider proxy set action=preserve reason=retry_safe_operation_control_failure fault=operation-control-failed subject=operation.cancel.v1 liveClaims=1 set=${secondReference} error=settlement timeout`,
      ],
      [
        'info',
        `Provider proxy set action=preserve reason=retry_safe_operation_control_failure fault=operation-control-failed subject=operation.settle.v1 liveClaims=1 set=${firstReference} error=settlement timeout summary=closed suppressed=1`,
      ],
      [
        'warn',
        `Provider proxy set action=stop-and-reap reason=provider_authority_lost fault=heartbeat-failed subject=proxy liveClaims=1 set=${firstReference} error=teardown latched terminalReason=teardown-latched`,
      ],
    ]);
    expect(stopAndReap).toHaveBeenCalledOnce();
  });

  it('coalesces changing remote messages that have the same normalized error identity', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const authority = fakeAuthority({ record, faults });
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
    lifecycle.registerInheritedSet(authority);

    const remoteFailure = {
      kind: 'json-rpc-error' as const,
      jsonRpcCode: -32_603,
      protocolCode: null,
      admissionReason: null,
      heartbeatRefusal: null,
    };
    faults.reportIncident({
      kind: 'operation-control-failed',
      policy: operationPolicy,
      error: new ControlClientError('control_call_failed', 'remote failure 1', 'remote-response', remoteFailure),
    });
    faults.reportIncident({
      kind: 'operation-control-failed',
      policy: operationPolicy,
      error: new ControlClientError('control_call_failed', 'remote failure 2', 'remote-response', remoteFailure),
    });

    expect(reportLifecycle).toHaveBeenCalledOnce();
    expect(reportLifecycle).toHaveBeenCalledWith('info', expect.stringContaining('error=remote failure 1'));
  });

  it('reports suppressed preserve failures after the signature becomes inactive', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const authority = fakeAuthority({ record, faults });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    const incident: ProviderProxyAuthorityIncident = {
      kind: 'operation-control-failed',
      policy: operationPolicy,
      error: 'settlement timeout',
    };
    faults.reportIncident(incident);
    clock.elapse(30_000);
    faults.reportIncident(incident);
    clock.elapse(30_000);
    clock.runDue();

    expect(reportLifecycle).toHaveBeenCalledOnce();

    clock.elapse(30_000);
    clock.runDue();

    expect(reportLifecycle.mock.calls).toEqual([
      ['info', expect.stringContaining('error=settlement timeout')],
      ['info', expect.stringContaining('error=settlement timeout summary=recovered suppressed=1')],
    ]);
  });

  it('bounds preserve report signatures and records eviction', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const reportLifecycle = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const authority = fakeAuthority({ record, faults });
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
    lifecycle.registerInheritedSet(authority);

    for (let code = 0; code < 33; code += 1) {
      faults.reportIncident({
        kind: 'operation-control-failed',
        policy: operationPolicy,
        error: new ControlClientError('control_call_failed', `remote failure ${code}`, 'remote-response', {
          kind: 'json-rpc-error',
          jsonRpcCode: code,
          protocolCode: null,
          admissionReason: null,
          heartbeatRefusal: null,
        }),
      });
    }

    expect(reportLifecycle).toHaveBeenCalledTimes(34);
    expect(reportLifecycle.mock.calls.filter(([, message]) => message.includes('summary=evicted'))).toEqual([
      ['info', expect.stringContaining('error=remote failure 0 summary=evicted suppressed=0')],
    ]);
  });

  it('reports an exact stop-and-reap decision for a containment-qualified operation fault', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'still live' }) as const);
    const authority = fakeAuthority({ record, stopAndReap });
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
    lifecycle.registerInheritedSet(authority);

    latchAuthorityFault(authority, {
      kind: 'operation-control-failed',
      policy: containmentOperationPolicy,
      error: 'mutation outcome unknown',
    });

    expect(stopAndReap).toHaveBeenCalledOnce();
    expect(reportLifecycle.mock.calls).toEqual([
      [
        'warn',
        `Provider proxy set action=stop-and-reap reason=provider_authority_lost fault=operation-control-failed subject=operation.cancel.v1 liveClaims=1 set=${setReference(authority.setIdentity)} error=mutation outcome unknown`,
      ],
    ]);
  });

  it('reattaches a channel incident atomically, restores routing, and rejects displaced callbacks', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'still live' }) as const);
    const oldFaults = createProviderProxyAuthorityFaultLatch();
    const promotedFaults = createProviderProxyAuthorityFaultLatch();
    const closeOld = vi.fn(async () => undefined);
    const promoted = fakeAuthority({ record, faults: promotedFaults });
    const authority = fakeAuthority({
      record,
      faults: oldFaults,
      stopAndReap,
      initiateControlClose: closeOld,
      redeemControl: async () => ({ kind: 'redeemed' }) as never,
      promoteControl: async () => promoted,
    });
    const controlEstablished = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle: () => undefined,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const admission = lifecycle.beginFreshAcquisition('reattachment-route');
    if (admission.kind !== 'accepted') throw new Error('expected reattachment admission');
    lifecycle.acquisitionSucceeded(admission.slotId, authority);

    oldFaults.reportIncident({
      kind: 'control-channel-fault',
      role: 'guardian',
      cause: 'closed',
      error: new ControlClientError('control_client_closed', 'guardian channel closed', 'closed'),
    });
    await drainMicrotasks();

    expect(lifecycle.routeFor('reattachment-route')).toBe(promoted);
    expect(lifecycle.snapshot().states).toEqual(['available']);
    expect(controlEstablished.mock.calls.map(([established]) => established)).toEqual([authority, promoted]);
    expect(closeOld).toHaveBeenCalledOnce();
    expect(stopAndReap).not.toHaveBeenCalled();

    oldFaults.latch({
      kind: 'operation-control-failed',
      policy: containmentOperationPolicy,
      error: new Error('displaced generation callback'),
    });

    expect(lifecycle.routeFor('reattachment-route')).toBe(promoted);
    expect(lifecycle.snapshot().states).toEqual(['available']);
    expect(stopAndReap).not.toHaveBeenCalled();
  });

  it('restores draining after reattachment when the channel ended during a drain', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const faults = createProviderProxyAuthorityFaultLatch();
    const promoted = fakeAuthority({ record });
    const authority = fakeAuthority({
      record,
      faults,
      redeemControl: async () => ({ kind: 'redeemed' }) as never,
      promoteControl: async () => promoted,
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const admission = lifecycle.beginFreshAcquisition('draining-reattachment');
    if (admission.kind !== 'accepted') throw new Error('expected reattachment admission');
    lifecycle.acquisitionSucceeded(admission.slotId, authority);
    lifecycle.beginGracefulDrain(authority.setIdentity);

    faults.reportIncident({
      kind: 'control-channel-fault',
      role: 'proxy',
      cause: 'invalid-unattributable-frame',
      error: new ControlClientError('control_call_failed', 'invalid frame', 'remote-response', {
        kind: 'invalid-frame',
      }),
    });
    await drainMicrotasks();

    expect(lifecycle.snapshot().states).toEqual(['draining']);
    expect(lifecycle.routeFor('draining-reattachment')).toBeNull();
  });

  it('stops redemption immediately on refusal and awaits independent absence without reaping', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const faults = createProviderProxyAuthorityFaultLatch();
    const redeemControl = vi.fn(async () => ({
      kind: 'refused' as const,
      refusal: { kind: 'identity-disagreement' as const },
    }));
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'must not run' }) as const);
    const clock = new ManualClock();
    const authority = fakeAuthority({ record, faults, redeemControl, stopAndReap, adoptionWindowMs: 100 });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    faults.reportIncident({
      kind: 'control-channel-fault',
      role: 'reaper',
      cause: 'closed',
      error: new ControlClientError('control_client_closed', 'reaper closed', 'closed'),
    });
    await drainMicrotasks();
    clock.elapse(99);
    clock.runDue();
    await drainMicrotasks();

    expect(redeemControl).toHaveBeenCalledOnce();
    expect(stopAndReap).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({
        states: ['containing'],
        operatorDispositions: [
          expect.objectContaining({
            disposition: 'awaiting-containment-absence',
            incidentReason: 'control_reattachment_refused',
            cause: 'closed',
          }),
        ],
      }),
    );
  });

  it('keeps one absolute bound across retries and a second fault, then awaits absence without reaping', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const faults = createProviderProxyAuthorityFaultLatch();
    const redeemControl = vi.fn<DurableProviderProxyOperationAuthority['redeemControl']>(
      async () =>
        ({
          kind: 'unavailable',
          incident: { kind: 'role-control-unavailable' },
          error: new Error('unavailable'),
        }) as never,
    );
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'must not run' }) as const);
    const clock = new ManualClock();
    const authority = fakeAuthority({ record, faults, redeemControl, stopAndReap, adoptionWindowMs: 2_000 });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);
    const firstObservedAt = clock.monotonicNow();

    const channelIncident = {
      kind: 'control-channel-fault' as const,
      role: 'guardian' as const,
      cause: 'closed' as const,
      error: new ControlClientError('control_client_closed', 'guardian closed', 'closed'),
    };
    faults.reportIncident(channelIncident);
    await drainMicrotasks();
    clock.elapse(1_000);
    clock.runDue();
    await drainMicrotasks();
    lifecycle.recordAuthorityIncident(authority.setIdentity, channelIncident);
    clock.elapse(1_000);
    clock.runDue();
    await drainMicrotasks();

    expect(clock.monotonicNow() - firstObservedAt).toBe(2_000n);
    expect(redeemControl.mock.calls.length).toBeGreaterThan(1);
    expect(stopAndReap).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({
        states: ['containing'],
        operatorDispositions: [
          expect.objectContaining({
            disposition: 'awaiting-containment-absence',
            incidentReason: 'control_reattachment_bound_expired',
            elapsedMs: 2_000,
            boundMs: 2_000,
          }),
        ],
      }),
    );
  });

  it('gates exact-set operator exit on held state and the monotonic adoption deadline, then names every refusal', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const faults = createProviderProxyAuthorityFaultLatch();
    const clock = new ManualClock();
    const authority = fakeAuthority({ record, faults, adoptionWindowMs: 2_000 });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);
    const address = providerProxySetAddress(authority.setIdentity);

    expect(lifecycle.authorizeOperatorExit({ ...address, proxyInstanceId: randomUUID() })).toEqual({
      kind: 'set-not-found',
    });
    expect(lifecycle.authorizeOperatorExit(address)).toEqual({ kind: 'not-held', state: 'available' });

    faults.reportIncident({
      kind: 'control-channel-fault',
      role: 'guardian',
      cause: 'closed',
      error: new ControlClientError('control_client_closed', 'guardian closed', 'closed'),
    });
    await drainMicrotasks();

    expect(lifecycle.authorizeOperatorExit(address)).toEqual({ kind: 'deadline-pending', remainingMs: 2_000 });
    expect(lifecycle.snapshot().operatorDispositions).toContainEqual(
      expect.objectContaining({
        setIdentity: address,
        setToken: expect.stringMatching(/^pps1\./u),
        disposition: 'operator-exit-refused',
        liveClaims: 1,
        incidentReason: 'operator_exit_deadline_pending',
        waitingFor: 'set-adoption-deadline',
      }),
    );

    clock.elapse(2_000);
    const authorization = lifecycle.authorizeOperatorExit(address);
    if (authorization.kind !== 'authorized') throw new Error(`expected authorization, received ${authorization.kind}`);

    await expect(
      lifecycle.completeOperatorExit(authorization.capability, { kind: 'enforcer-alive', roles: ['guardian'] }, false),
    ).resolves.toEqual({ kind: 'enforcer-alive', setIdentity: address, roles: ['guardian'] });
    expect(lifecycle.snapshot().operatorDispositions).toContainEqual(
      expect.objectContaining({
        disposition: 'operator-exit-refused',
        incidentReason: 'operator_exit_enforcer-alive',
        waitingFor: 'operator-abandonment',
      }),
    );

    await expect(
      lifecycle.completeOperatorExit(
        authorization.capability,
        { kind: 'enforcer-unobservable', roles: ['reaper'] },
        false,
      ),
    ).resolves.toEqual({ kind: 'enforcer-unobservable', setIdentity: address, roles: ['reaper'] });
    await expect(
      lifecycle.completeOperatorExit(authorization.capability, { kind: 'store-unreadable' }, true),
    ).resolves.toEqual({ kind: 'store-unreadable', setIdentity: address });
    expect(lifecycle.snapshot().operatorDispositions).toContainEqual(
      expect.objectContaining({
        disposition: 'operator-exit-refused',
        incidentReason: 'operator_exit_store_unreadable',
        waitingFor: 'store-repair',
      }),
    );
  });

  it('gates fault containment on its first attempt deadline and rejects a capability from the prior attempt', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const authority = fakeAuthority({ record });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);
    const address = providerProxySetAddress(authority.setIdentity);

    latchAuthorityFault(authority, terminalAuthorityFault());
    expect(lifecycle.snapshot().states).toEqual(['containing']);
    expect(lifecycle.authorizeOperatorExit(address)).toEqual({
      kind: 'deadline-pending',
      remainingMs: 30_000,
    });
    clock.stepWallClock(60_000);
    expect(lifecycle.authorizeOperatorExit(address)).toEqual({
      kind: 'deadline-pending',
      remainingMs: 30_000,
    });

    clock.elapse(30_000);
    const firstAuthorization = lifecycle.authorizeOperatorExit(address);
    if (firstAuthorization.kind !== 'authorized') {
      throw new Error(`expected authorization, received ${firstAuthorization.kind}`);
    }
    clock.runDue();
    await drainMicrotasks();
    expect(lifecycle.snapshot().states).toEqual(['containment-wait']);
    expect(lifecycle.authorizeOperatorExit(address).kind).toBe('authorized');
    await expect(
      lifecycle.completeOperatorExit(
        firstAuthorization.capability,
        { kind: 'enforcer-unobservable', roles: ['guardian', 'reaper'] },
        true,
      ),
    ).resolves.toEqual({ kind: 'authorization-stale', setIdentity: address });
  });

  it('returns a pending claim disposition when exact-absence delivery has not settled', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const faults = createProviderProxyAuthorityFaultLatch();
    const clock = new ManualClock();
    const disappearanceAcceptance =
      deferred<Awaited<ReturnType<ProviderContainmentDisappearanceConsumer['containmentDisappeared']>>>();
    const containmentDisappeared = vi.fn<ProviderContainmentDisappearanceConsumer['containmentDisappeared']>(
      () => disappearanceAcceptance.promise,
    );
    const authority = fakeAuthority({ record, faults, adoptionWindowMs: 100 });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);
    faults.reportIncident({
      kind: 'control-channel-fault',
      role: 'proxy',
      cause: 'closed',
      error: new ControlClientError('control_client_closed', 'proxy closed', 'closed'),
    });
    await drainMicrotasks();
    clock.elapse(100);

    const authorization = lifecycle.authorizeOperatorExit(providerProxySetAddress(authority.setIdentity));
    if (authorization.kind !== 'authorized') throw new Error(`expected authorization, received ${authorization.kind}`);
    await expect(
      lifecycle.completeOperatorExit(
        authorization.capability,
        { kind: 'absent', receipt: 'operator-exact-absence' },
        false,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: 'contained',
        disappearanceReceipt: 'operator-exact-absence',
        claimDischarge: { kind: 'initial-disposition-retry-owned' },
      }),
    );
    expect(lifecycle.snapshot().represented).toBe(1);

    disappearanceAcceptance.resolve({
      kind: 'accepted',
      acceptance: {
        kind: 'accepted',
        operation: record.operation,
        disposition: 'terminalization-committed',
      },
    });
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));
  });

  it.each([
    {
      resultKind: 'contained' as const,
      proof: { kind: 'absent' as const, receipt: 'operator-exact-absence' },
      abandonUnobservable: false,
    },
    {
      resultKind: 'abandoned' as const,
      proof: {
        kind: 'enforcer-unobservable' as const,
        roles: ['guardian', 'reaper'] as const,
      },
      abandonUnobservable: true,
    },
  ])(
    'reports an already-settled $resultKind discharge as completed',
    async ({ resultKind, proof, abandonUnobservable }) => {
      const claims = new ProviderProxySetClaimMirror();
      claims.initialize([]);
      const faults = createProviderProxyAuthorityFaultLatch();
      const clock = new ManualClock();
      const authority = fakeAuthority({ faults, adoptionWindowMs: 100 });
      const lifecycle = lifecycleFor({
        claims,
        controlEstablished: ignoreControlEstablished,
        disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
        time: clock,
        proveContainmentAbsent: noContainmentProof,
      });
      lifecycle.initializeClaimSlots();
      lifecycle.completeStartupDiscovery();
      lifecycle.registerInheritedSet(authority);
      faults.reportIncident({
        kind: 'control-channel-fault',
        role: 'proxy',
        cause: 'closed',
        error: new ControlClientError('control_client_closed', 'proxy closed', 'closed'),
      });
      await drainMicrotasks();
      clock.elapse(100);

      const authorization = lifecycle.authorizeOperatorExit(providerProxySetAddress(authority.setIdentity));
      if (authorization.kind !== 'authorized') {
        throw new Error(`expected authorization, received ${authorization.kind}`);
      }
      await expect(
        lifecycle.completeOperatorExit(authorization.capability, proof, abandonUnobservable),
      ).resolves.toEqual(
        expect.objectContaining({
          kind: resultKind,
          claimDischarge: { kind: 'completed' },
        }),
      );
      expect(lifecycle.snapshot().represented).toBe(0);
    },
  );

  it('abandons representation through the distinct claim consumer without constructing a stop-and-reap action', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const faults = createProviderProxyAuthorityFaultLatch();
    const clock = new ManualClock();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'must not run' }) as const);
    const initiateControlClose = vi.fn(async () => undefined);
    const abandonmentAcceptance =
      deferred<Awaited<ReturnType<ProviderRepresentationAbandonmentConsumer['representationAbandoned']>>>();
    const representationAbandoned = vi.fn<ProviderRepresentationAbandonmentConsumer['representationAbandoned']>(
      () => abandonmentAcceptance.promise,
    );
    const authority = fakeAuthority({
      record,
      faults,
      adoptionWindowMs: 100,
      stopAndReap,
      initiateControlClose,
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      abandonmentConsumer: { representationAbandoned },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);
    faults.reportIncident({
      kind: 'control-channel-fault',
      role: 'proxy',
      cause: 'closed',
      error: new ControlClientError('control_client_closed', 'proxy closed', 'closed'),
    });
    await drainMicrotasks();
    clock.elapse(100);

    const authorization = lifecycle.authorizeOperatorExit(providerProxySetAddress(authority.setIdentity));
    if (authorization.kind !== 'authorized') throw new Error(`expected authorization, received ${authorization.kind}`);
    const completion = lifecycle.completeOperatorExit(
      authorization.capability,
      { kind: 'enforcer-unobservable', roles: ['guardian', 'reaper'] },
      true,
    );
    await expect(completion).resolves.toEqual(
      expect.objectContaining({
        kind: 'abandoned',
        processObservation: 'enforcer-unobservable',
        claimDischarge: { kind: 'initial-disposition-retry-owned' },
      }),
    );
    expect(lifecycle.snapshot().represented).toBe(1);

    abandonmentAcceptance.resolve({
      kind: 'accepted',
      acceptance: {
        kind: 'accepted',
        operation: record.operation,
        disposition: 'terminalization-committed',
      },
    });
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));

    expect(representationAbandoned).toHaveBeenCalledWith({
      operation: record.operation,
      setIdentity: authority.setIdentity,
    });
    expect(stopAndReap).not.toHaveBeenCalled();
    expect(initiateControlClose).toHaveBeenCalledOnce();
  });

  it.each([{ winner: 'role-control' as const }, { winner: 'containment-proof' as const }])(
    'races containment sources and preserves every disappearance notice when $winner reports first',
    async ({ winner }) => {
      const first = providerOperationRecord('executing');
      const second = providerOperationRecord('executing', {
        operation: { ...first.operation, jobId: randomUUID(), operationId: randomUUID() },
        locator: first.locator,
      });
      const claims = new ProviderProxySetClaimMirror();
      claims.initialize([first, second]);
      const roleControlResult = deferred<Awaited<ReturnType<DurableProviderProxyOperationAuthority['stopAndReap']>>>();
      const absenceResult = deferred<ProviderProxySetContainmentProof>();
      const signals: { roleControl?: AbortSignal; containmentProof?: AbortSignal } = {};
      const stopAndReap = vi.fn((signal: AbortSignal) => {
        signals.roleControl = signal;
        return roleControlResult.promise;
      });
      const proveContainmentAbsent = vi.fn(
        (_identity: ReturnType<typeof providerProxySetIdentityFromRecord>, signal: AbortSignal) => {
          signals.containmentProof = signal;
          return absenceResult.promise;
        },
      );
      const notices: Parameters<ProviderContainmentDisappearanceConsumer['containmentDisappeared']>[0][] = [];
      const containmentDisappeared = vi.fn(
        async (notice: Parameters<ProviderContainmentDisappearanceConsumer['containmentDisappeared']>[0]) => {
          notices.push(notice);
          return {
            kind: 'accepted' as const,
            acceptance: {
              kind: 'accepted' as const,
              operation: notice.operation,
              disposition: 'terminalization-committed' as const,
            },
          };
        },
      );
      const authority = fakeAuthority({ record: first, stopAndReap });
      const lifecycle = lifecycleFor({
        claims,
        controlEstablished: ignoreControlEstablished,
        disappearanceConsumer: { containmentDisappeared },
        time: new ManualClock(),
        proveContainmentAbsent,
      });
      lifecycle.initializeClaimSlots();
      lifecycle.completeStartupDiscovery();
      lifecycle.registerInheritedSet(authority);

      latchAuthorityFault(authority, terminalAuthorityFault());

      expect(stopAndReap).toHaveBeenCalledOnce();
      expect(proveContainmentAbsent).toHaveBeenCalledOnce();
      const disappearanceReceipt = 'guardian:guardian-receipt;reaper:reaper-receipt';
      if (winner === 'role-control') {
        roleControlResult.resolve({ disappearanceReceipt });
      } else {
        absenceResult.resolve({ kind: 'absent', receipt: disappearanceReceipt });
      }
      await vi.waitFor(() => expect(notices).toHaveLength(2));

      expect(signals.roleControl?.aborted).toBe(true);
      expect(signals.containmentProof?.aborted).toBe(true);
      expect(notices).toEqual(
        expect.arrayContaining([
          { operation: first.operation, setIdentity: authority.setIdentity, disappearanceReceipt },
          { operation: second.operation, setIdentity: authority.setIdentity, disappearanceReceipt },
        ]),
      );

      if (winner === 'role-control') {
        absenceResult.resolve({ kind: 'absent', receipt: 'guardian:late-guardian;reaper:late-reaper' });
      } else {
        roleControlResult.resolve({
          disappearanceReceipt: 'guardian:late-guardian;reaper:late-reaper',
        });
      }
      await drainMicrotasks();
      expect(containmentDisappeared).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));
    },
  );

  // The rule with no version exceptions: a capsule this build cannot derive a set identity from is represented
  // so its address cannot be aliased, and dialed by nothing. It also does not deny an overlapping acquisition,
  // because there is no identity here to deny one against — a `capsule-foreign` slot holds an address, a path
  // and a reason, and no authority. Before this, a V1 took a third path that redeemed it and rewrote the file
  // in place at the V1 name, which discovery re-derives and rejects on the very next boot.
  it('represents a capsule it cannot inherit without dialing it or denying an overlapping fresh set', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const capsule = capsuleFor(authority);
    const proveContainmentAbsent = vi.fn(noContainmentProof);
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent,
      redeemCapsule: async () => {
        throw new Error('unconfirmed redemption');
      },
    });

    lifecycle.initializeClaimSlots();
    lifecycle.installDiscoveredCapsules([{ path: '/capsules/zero-claim.handoff.json', capsule }], retainsEveryCapsule);
    await Promise.resolve();

    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({ startupDiscoveryCompleted: true, represented: 1, states: ['capsule-foreign'] }),
    );
    expect(
      lifecycle.beginFreshAcquisition('same-host-route', {
        buildSetId: capsule.buildSetId,
        hostFingerprint: capsule.hostFingerprint,
      }).kind,
    ).toBe('accepted');
    // Nothing was asked of the roles behind it — no redemption, and no containment proof either. The
    // `redeemCapsule` above throws precisely so that reaching it would fail this test rather than pass it.
    expect(proveContainmentAbsent).not.toHaveBeenCalled();
  });

  it('contains an unmatched zero-claim redemption before evaluating publication', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const established = vi.fn();
    const reportLifecycle = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: established,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      redeemCapsule: async () => ({ kind: 'redeemed', set: authority }),
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules(
      [{ path: '/capsules/unmatched.handoff.v3.json', capsule: capsuleV3For(authority) }],
      retainsEveryCapsule,
    );
    await vi.waitFor(() => expect(lifecycle.snapshot().states).toEqual(['containing']));

    expect(established).not.toHaveBeenCalled();
    expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
    expect(reportLifecycle.mock.calls).toEqual([
      [
        'info',
        `Provider proxy set action=stop-and-reap reason=unclaimed_discovery fault=none subject=retirement liveClaims=0 set=${setReference(authority.setIdentity)} error=none`,
      ],
    ]);
  });

  it('preserves an unclaimed discovery that gains a claim while redemption is in flight', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'still claimed' }) as const);
    const authority = fakeAuthority({ record, stopAndReap });
    const redemption = deferred<ProviderProxySetRedemptionOutcome>();
    const established = vi.fn();
    const reportLifecycle = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: established,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      redeemCapsule: () => redemption.promise,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules(
      [{ path: '/capsules/claim-race.handoff.v3.json', capsule: capsuleV3For(authority) }],
      retainsEveryCapsule,
    );
    claims.applyMutation({ kind: 'upserted', record });
    redemption.resolve({ kind: 'redeemed', set: authority });
    await vi.waitFor(() => expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority));

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(established).toHaveBeenCalledWith(authority);
    expect(lifecycle.snapshot().states).toEqual(['available']);
    expect(reportLifecycle).not.toHaveBeenCalled();
  });

  it('keeps a claim-bearing protocol-incompatible capsule until disappearance reaches the claim', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    // A claim held before `initializeClaimSlots` is claim-matched and creates no capsule slot, so the
    // redemption this case is about never runs. The claim has to arrive while redemption is in flight.
    claims.initialize([]);
    const authority = fakeAuthority({ record });
    const redemption = deferred<ProviderProxySetRedemptionOutcome>();
    const absence = deferred<ProviderProxySetContainmentProof>();
    const proveContainmentAbsent = vi
      .fn<ProviderProxySetLifecycleFixtureDeps['proveContainmentAbsent']>()
      .mockResolvedValueOnce(enforcersUnobservable)
      .mockImplementationOnce(() => absence.promise);
    const containmentDisappeared = vi.fn(
      async (notice: Parameters<ProviderContainmentDisappearanceConsumer['containmentDisappeared']>[0]) => ({
        kind: 'accepted' as const,
        acceptance: {
          kind: 'accepted' as const,
          operation: notice.operation,
          disposition: 'terminalization-committed' as const,
        },
      }),
    );
    const reportLifecycle = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared },
      time: new ManualClock(),
      proveContainmentAbsent,
      redeemCapsule: () => redemption.promise,
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules(
      [{ path: '/capsules/protocol-incompatible.handoff.v3.json', capsule: capsuleV3For(authority) }],
      retainsEveryCapsule,
    );
    claims.applyMutation({ kind: 'upserted', record });
    redemption.resolve({ kind: 'protocol-incompatible', role: 'guardian', method: 'guardian.heartbeat.v1' });
    await vi.waitFor(() => expect(reportLifecycle).toHaveBeenCalledOnce());

    expect(lifecycle.snapshot().represented).toBe(1);
    expect(proveContainmentAbsent).toHaveBeenCalledTimes(2);
    expect(reportLifecycle).toHaveBeenCalledExactlyOnceWith(
      'warn',
      `Provider proxy set action=await-containment-absence reason=heartbeat_protocol_incompatible fault=heartbeat-method-not-found subject=guardian liveClaims=1 set=${setReference(authority.setIdentity)} error=this set speaks a heartbeat protocol this build cannot use incidentReason=method-not-found`,
    );
    absence.resolve({ kind: 'absent', receipt: 'protocol-incompatible-absence' });
    await vi.waitFor(() => expect(containmentDisappeared).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));
  });

  it('keeps a no-claim protocol-incompatible capsule until independent absence proof', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const reportLifecycle = vi.fn();
    const absence = deferred<ProviderProxySetContainmentProof>();
    const proveContainmentAbsent = vi
      .fn<ProviderProxySetLifecycleFixtureDeps['proveContainmentAbsent']>()
      .mockResolvedValueOnce(enforcersUnobservable)
      .mockImplementationOnce(() => absence.promise);
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent,
      redeemCapsule: async () => ({
        kind: 'protocol-incompatible',
        role: 'guardian',
        method: 'guardian.heartbeat.v1',
      }),
      reportLifecycle,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules(
      [{ path: '/capsules/no-claim-protocol-incompatible.handoff.v3.json', capsule: capsuleV3For(authority) }],
      retainsEveryCapsule,
    );
    await vi.waitFor(() => expect(reportLifecycle).toHaveBeenCalledOnce());

    expect(lifecycle.snapshot().represented).toBe(1);
    expect(reportLifecycle).toHaveBeenCalledExactlyOnceWith(
      'warn',
      `Provider proxy set action=await-containment-absence reason=heartbeat_protocol_incompatible fault=heartbeat-method-not-found subject=guardian liveClaims=0 set=${setReference(authority.setIdentity)} error=this set speaks a heartbeat protocol this build cannot use incidentReason=method-not-found`,
    );
    absence.resolve({ kind: 'absent', receipt: 'no-claim-protocol-incompatible-absence' });
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));
  });

  it('retires an unmatched exact v3 capsule after independent absence proof', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const proveContainmentAbsent = vi.fn(
      async (): Promise<ProviderProxySetContainmentProof> => ({
        kind: 'absent',
        receipt: 'exact-v3-absence',
      }),
    );
    const retireCapsule = vi.fn(async () => ({ kind: 'retired' as const }));
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent,
      redeemCapsule: async () => {
        return {
          kind: 'temporarily-unavailable',
          incident: { kind: 'recovery-deadline', timeoutMs: 45_000 },
        };
      },
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules(
      [{ path: '/capsules/unmatched-v3.handoff.json', capsule: capsuleV3For(authority) }],
      retainsEveryCapsule,
    );
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));

    expect(proveContainmentAbsent).toHaveBeenCalledOnce();
    expect(retireCapsule).toHaveBeenCalledWith('/capsules/unmatched-v3.handoff.json');
  });

  it('fails exact capsule recovery on redeemed identity corruption', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const clock = new ManualClock();
    const authority = fakeAuthority();
    const corrupted = {
      ...authority,
      setIdentity: { ...authority.setIdentity, guardianPid: authority.setIdentity.guardianPid + 1 },
    };
    const fatals = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      redeemCapsule: async () => ({ kind: 'redeemed', set: corrupted }),
      onFatal: fatals,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules(
      [{ path: '/capsules/corrupt-v3.handoff.json', capsule: capsuleV3For(authority) }],
      retainsEveryCapsule,
    );
    await drainMicrotasks();

    expect({
      fatalCalls: fatals.mock.calls.length,
      fatal: fatals.mock.calls[0]?.[0],
      snapshot: lifecycle.snapshot(),
      activeTimers: clock.timers.filter((timer) => timer.active).length,
    }).toMatchObject({
      fatalCalls: 1,
      fatal: {
        name: 'ProviderProxySetLifecycleFatalError',
        stage: 'capsule-recovery',
        setIdentity: authority.setIdentity,
      },
      snapshot: { represented: 1, states: ['capsule-recovering'] },
      activeTimers: 0,
    });
  });

  it('dispatches exact capsule fatal evidence on arrival', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const clock = new ManualClock();
    const authority = fakeAuthority();
    const redemption = deferred<ProviderProxySetRedemptionOutcome>();
    const neverProvesAbsence = new Promise<ProviderProxySetContainmentProof>(() => undefined);
    const fatals = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: () => neverProvesAbsence,
      redeemCapsule: () => redemption.promise,
      onFatal: fatals,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.installDiscoveredCapsules(
      [{ path: '/capsules/arrival-fatal-v3.handoff.json', capsule: capsuleV3For(authority) }],
      retainsEveryCapsule,
    );
    const corrupted = {
      ...authority,
      setIdentity: { ...authority.setIdentity, guardianPid: authority.setIdentity.guardianPid + 1 },
    };

    redemption.resolve({ kind: 'redeemed', set: corrupted });
    await drainMicrotasks();

    expect({
      fatalCalls: fatals.mock.calls.length,
      snapshot: lifecycle.snapshot(),
      activeTimers: clock.timers.filter((timer) => timer.active).length,
    }).toEqual({
      fatalCalls: 1,
      snapshot: {
        startupDiscoveryCompleted: true,
        represented: 1,
        available: 0,
        states: ['capsule-recovering'],
        pendingOperationCounts: [],
        operatorDispositions: [],
      },
      activeTimers: 0,
    });
  });

  it('fails capsule recovery on redeemed identity corruption', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const clock = new ManualClock();
    const authority = fakeAuthority();
    const redemption = deferred<ProviderProxySetRedemptionOutcome>();
    const fatals = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      redeemCapsule: () => redemption.promise,
      onFatal: fatals,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.installDiscoveredCapsules(
      [{ path: '/capsules/corrupt.handoff.v3.json', capsule: capsuleV3For(authority) }],
      retainsEveryCapsule,
    );
    const corrupted = {
      ...authority,
      setIdentity: { ...authority.setIdentity, guardianInstanceId: randomUUID() },
    };

    redemption.resolve({ kind: 'redeemed', set: corrupted });
    await drainMicrotasks();

    expect({
      fatalCalls: fatals.mock.calls.length,
      states: lifecycle.snapshot().states,
      activeTimers: clock.timers.filter((timer) => timer.active).length,
    }).toEqual({ fatalCalls: 1, states: ['capsule-recovering'], activeTimers: 0 });
  });

  it('fail-stops duplicate capsule addresses, grants, and claim-binding aliases during discovery', () => {
    const record = providerOperationRecord('executing');
    const authority = fakeAuthority({ record });
    const original = capsuleFor(authority);
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);

    const noClaims = new ProviderProxySetClaimMirror();
    noClaims.initialize([]);
    const duplicateAddress = lifecycleFor({
      claims: noClaims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
    });
    duplicateAddress.initializeClaimSlots();
    expect(() =>
      duplicateAddress.installDiscoveredCapsules(
        [
          { path: '/capsules/a.handoff.json', capsule: original },
          { path: '/capsules/b.handoff.json', capsule: { ...original, grantId: randomUUID() } },
        ],
        retainsEveryCapsule,
      ),
    ).toThrow('provider_proxy_capsule_address_alias');

    const duplicateGrant = lifecycleFor({
      claims: noClaims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
    });
    duplicateGrant.initializeClaimSlots();
    expect(() =>
      duplicateGrant.installDiscoveredCapsules(
        [
          { path: '/capsules/a.handoff.json', capsule: original },
          {
            path: '/capsules/c.handoff.json',
            capsule: {
              ...original,
              hostFingerprint: 'd'.repeat(64),
              proxyInstanceId: randomUUID(),
            },
          },
        ],
        retainsEveryCapsule,
      ),
    ).toThrow('provider_proxy_capsule_grant_alias');

    const claimAlias = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
    });
    claimAlias.initializeClaimSlots();
    expect(() =>
      claimAlias.installDiscoveredCapsules(
        [
          {
            path: '/capsules/claim.handoff.json',
            capsule: { ...original, guardianInstanceId: randomUUID() },
          },
        ],
        retainsEveryCapsule,
      ),
    ).toThrow('provider_proxy_capsule_claim_identity_mismatch');
  });
  it('continues containment when decision reporting throws after the authority fault latch resolves', async () => {
    const clock = new ManualClock();
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopHeartbeats = vi.fn();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'still live' }) as const);
    const authority = fakeAuthority({ record, faults, stopAndReap, stopHeartbeats });
    // The callback observes the very lifecycle it is passed into, so the reference is published after
    // construction through a holder rather than forward-declared.
    const constructed: { lifecycle: ProviderProxySetLifecycle | null } = { lifecycle: null };
    const reportLifecycle = vi.fn(() => {
      expect(constructed.lifecycle?.routeFor('codex-route')).toBe(authority);
      expect(stopHeartbeats).not.toHaveBeenCalled();
      throw new Error('decision log sink failed');
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle,
    });
    constructed.lifecycle = lifecycle;
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const admission = lifecycle.beginFreshAcquisition('codex-route');
    if (admission.kind !== 'accepted') throw new Error('expected acquisition admission');
    lifecycle.acquisitionSucceeded(admission.slotId, authority);
    expect(lifecycle.routeFor('codex-route')).toBe(authority);

    const authorityFault: ProviderProxyAuthorityFault = {
      kind: 'heartbeat-failed',
      role: 'proxy',
      method: 'control.heartbeat.v1',
      terminalReason: 'teardown-latched',
      error: 'teardown latched',
    };
    faults.latch(authorityFault);
    faults.latch(authorityFault);

    expect(lifecycle.routeFor('codex-route')).toBeNull();
    expect(lifecycle.snapshot().states).toEqual(['containing']);
    expect(stopHeartbeats).toHaveBeenCalledOnce();
    expect(stopAndReap).toHaveBeenCalledOnce();
    expect(reportLifecycle.mock.calls).toEqual([
      [
        'warn',
        `Provider proxy set action=stop-and-reap reason=provider_authority_lost fault=heartbeat-failed subject=proxy liveClaims=1 set=${setReference(authority.setIdentity)} error=teardown latched terminalReason=teardown-latched`,
      ],
    ]);
    await authority.faulted;
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
    lifecycle.registerInheritedSet(authority);
    latchAuthorityFault(authority, terminalAuthorityFault());

    lifecycle.containmentAbsent(authority.setIdentity, 'public-proof-receipt');

    expect(closeObservations).toEqual([['absence-delivery-pending']]);
    expect(containmentDisappeared).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({ represented: 1, states: ['absence-delivery-pending'], pendingOperationCounts: [1] }),
    );
    expect(() => lifecycle.containmentAbsent(authority.setIdentity, 'public-proof-receipt')).not.toThrow();
    expect(() => lifecycle.containmentAbsent(authority.setIdentity, 'conflicting-receipt')).toThrow(
      'provider_proxy_containment_absence_conflict',
    );
  });

  it('dispatches post-start disappearance corruption through the global fatal route', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const fatals: ProviderProxySetLifecycleFatalError[] = [];
    const delivery = vi.fn(
      async (notice: Parameters<ProviderContainmentDisappearanceConsumer['containmentDisappeared']>[0]) => ({
        kind: 'accepted' as const,
        acceptance: {
          kind: 'accepted' as const,
          operation: { ...notice.operation, operationId: randomUUID() },
          disposition: 'record-absent' as const,
        },
      }),
    );
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: delivery },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      onFatal: (error) => fatals.push(error),
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const authority = fakeAuthority({ record });
    lifecycle.registerInheritedSet(authority);
    latchAuthorityFault(authority, terminalAuthorityFault());

    const acceptance = lifecycle.containmentAbsent(authority.setIdentity, 'corrupt-disappearance-identity');
    const outcome = await acceptance.initialDisposition.then(
      () => ({ kind: 'fulfilled' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    expect({
      initialDisposition: outcome.kind,
      branded: outcome.kind === 'rejected' && isProviderProxyRecoveryFatalError(outcome.error),
      fatal: outcome.kind === 'rejected' ? outcome.error : null,
      dispatcherGlobalFatalCalls: fatals.length,
      sameFatal: outcome.kind === 'rejected' && fatals[0] === outcome.error,
      representedPendingRows: lifecycle.snapshot().pendingOperationCounts[0],
      activeRetryTimers: clock.timers.filter((timer) => timer.active).length,
      laterDeliveryCalls: delivery.mock.calls.length - 1,
    }).toMatchObject({
      initialDisposition: 'rejected',
      branded: true,
      fatal: { stage: 'disappearance-delivery', producerId: 'disappearance-consumer' },
      dispatcherGlobalFatalCalls: 1,
      sameFatal: true,
      representedPendingRows: 1,
      activeRetryTimers: 0,
      laterDeliveryCalls: 0,
    });
  });

  it('forwards nested disappearance fatal evidence without republishing it', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const globalFatals: ProviderProxySetLifecycleFatalError[] = [];
    const directive: ProviderOperationTerminalDirective = {
      kind: 'terminal-failed',
      code: 'provider_lost',
      reason: 'nested disappearance fatal',
    };
    const dispatcher: ProviderProxyRecoveryDispatcher = createTestProviderProxyRecoveryDispatcher(
      {
        'containment-proof': noContainmentProof,
        'disappearance-terminalization': () => {
          throw new ProviderOperationTerminalMetadataError(record.operation);
        },
        'disappearance-consumer': ({ notice }) =>
          new Promise<DisappearanceDeliveryAttemptOutcome>((_resolve, reject) => {
            const inner = dispatcher.begin(
              'disappearance-delivery',
              { operation: notice.operation, setIdentity: notice.setIdentity },
              {
                evidence: () => reject(new Error('nested terminalization unexpectedly produced evidence')),
                retry: () => reject(new Error('nested terminalization unexpectedly requested retry')),
                fatal: reject,
              },
            );
            inner.start({
              sourceId: 'terminalization',
              producerId: 'disappearance-terminalization',
              input: { record, directive },
            });
          }),
      },
      (error) => globalFatals.push(error),
    );
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      recoveryDispatcher: dispatcher,
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const authority = fakeAuthority({ record });
    lifecycle.registerInheritedSet(authority);
    latchAuthorityFault(authority, terminalAuthorityFault());

    const acceptance = lifecycle.containmentAbsent(authority.setIdentity, 'nested-disappearance-fatal');
    const outcome = await acceptance.initialDisposition.then(
      () => ({ kind: 'fulfilled' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    expect({
      initialDisposition: outcome.kind,
      globalFatalCalls: globalFatals.length,
      branded: outcome.kind === 'rejected' && isProviderProxyRecoveryFatalError(outcome.error),
      sameObject: outcome.kind === 'rejected' && outcome.error === globalFatals[0],
      fatalIdentities: globalFatals.map((fatal) => ({
        branded: isProviderProxyRecoveryFatalError(fatal),
        sameOutcome: outcome.kind === 'rejected' && outcome.error === fatal,
        producerId: fatal.producerId,
        causeName: fatal.cause instanceof Error ? fatal.cause.name : typeof fatal.cause,
      })),
      representedPendingRows: lifecycle.snapshot().pendingOperationCounts[0],
      activeRetryTimers: clock.timers.filter((timer) => timer.active).length,
    }).toEqual({
      initialDisposition: 'rejected',
      globalFatalCalls: 1,
      branded: true,
      sameObject: true,
      fatalIdentities: [
        {
          branded: true,
          sameOutcome: true,
          producerId: 'disappearance-terminalization',
          causeName: 'ProviderOperationTerminalMetadataError',
        },
      ],
      representedPendingRows: 1,
      activeRetryTimers: 0,
    });
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
    const retireCapsule = vi.fn(async () => ({ kind: 'retired' as const }));
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
            : secondAcceptance.promise,
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
    lifecycle.registerInheritedSet(authority, '/capsules/set.handoff.json');

    latchAuthorityFault(authority, terminalAuthorityFault());
    await vi.waitFor(() => expect(lifecycle.snapshot().pendingOperationCounts).toEqual([1]));
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
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));

    expect(retireCapsule).toHaveBeenCalledWith('/capsules/set.handoff.json');
  });

  it('retains the slot until capsule retirement succeeds', async () => {
    const clock = new ManualClock();
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const retireCapsule = vi
      .fn(async (): Promise<CapsuleRetirementAttemptOutcome> => ({ kind: 'retired' }))
      .mockResolvedValueOnce({
        kind: 'temporarily-unavailable',
        incident: { kind: 'capsule-directory-durability-unavailable' },
      });
    const authority = fakeAuthority({
      stopAndReap: async () => ({ disappearanceReceipt: 'exact-absence' }),
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority, '/capsules/set.handoff.json');

    latchAuthorityFault(authority, terminalAuthorityFault());
    const acceptance = lifecycle.containmentAbsent(authority.setIdentity, 'exact-absence');
    await vi.waitFor(() => expect(retireCapsule).toHaveBeenCalledOnce());
    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({ represented: 1, states: ['absence-delivery-pending'] }),
    );
    await expect(acceptance.initialDisposition).resolves.toEqual({
      kind: 'operational-retry-owned',
      incidents: [
        expect.objectContaining({
          stage: 'capsule-retirement',
          code: 'capsule_retirement_unavailable',
          reason: 'capsule-directory-durability-unavailable',
        }),
      ],
    });

    clock.elapse(1_000);
    clock.runDue();
    await vi.waitFor(() => expect(lifecycle.snapshot().represented).toBe(0));
    expect(retireCapsule).toHaveBeenCalledTimes(2);
  });

  it('keeps unconfirmed containment represented, retries, and reports late scheduler wakes', async () => {
    const clock = new ManualClock();
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const violations: ProviderProxySetLifecycleProgressViolation[] = [];
    const decisions: string[] = [];
    let attempts = 0;
    const authority = fakeAuthority({
      stopAndReap: async () => {
        attempts += 1;
        return { unconfirmed: 'still ambiguous' };
      },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      onProgressPremiseViolation: (violation) => violations.push(violation),
      reportLifecycle: (_severity, message) => decisions.push(message),
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const admission = lifecycle.beginFreshAcquisition('route');
    if (admission.kind !== 'accepted') throw new Error('expected acquisition admission');
    lifecycle.acquisitionSucceeded(admission.slotId, authority);
    latchAuthorityFault(authority, terminalAuthorityFault());
    latchAuthorityFault(authority, terminalAuthorityFault());
    expect(attempts).toBe(1);

    clock.elapse(30_500);
    clock.runDue();
    await Promise.resolve();
    await Promise.resolve();
    expect(lifecycle.snapshot().states).toEqual(['containment-wait']);

    clock.elapse(1_500);
    clock.runDue();
    await Promise.resolve();
    expect(attempts).toBe(2);
    expect(lifecycle.snapshot().represented).toBe(1);
    expect(violations).toEqual([
      expect.objectContaining({ stage: 'containment-attempt-deadline', latenessMs: 500 }),
      expect.objectContaining({ stage: 'containment-retry', latenessMs: 500 }),
    ]);
    expect(decisions).toEqual([
      `Provider proxy set action=stop-and-reap reason=provider_authority_lost fault=heartbeat-failed subject=proxy liveClaims=0 set=${setReference(authority.setIdentity)} error=teardown latched terminalReason=teardown-latched`,
    ]);
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
    lifecycle.acquisitionSucceeded(admission.slotId, authority);
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

  it('drains a claim-bearing fifth inherited set until its claim reaches zero', () => {
    const records = Array.from({ length: 5 }, (_, offset) => {
      const index = offset + 1;
      const base = providerOperationRecord('executing');
      const proxyInstanceId = randomUUID();
      return providerOperationRecord('executing', {
        operation: {
          ...base.operation,
          jobId: randomUUID(),
          operationId: randomUUID(),
          proxyInstanceId,
          buildSetId: randomUUID(),
        },
        locator: {
          ...base.locator,
          hostFingerprint: String(index).repeat(64),
          guardian: {
            ...base.locator.guardian,
            instanceId: randomUUID(),
            controlEndpoint: `/tmp/guardian-${index}.sock`,
          },
          reaper: {
            ...base.locator.reaper,
            instanceId: randomUUID(),
            controlEndpoint: `/tmp/reaper-${index}.sock`,
          },
          proxy: {
            ...base.locator.proxy,
            instanceId: proxyInstanceId,
            controlEndpoint: `/tmp/proxy-${index}.sock`,
          },
        },
      });
    });
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize(records);
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'still claimed' }) as const);
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

    const authorities = records.map((record) => fakeAuthority({ record, stopAndReap }));
    for (const authority of authorities) lifecycle.registerInheritedSet(authority);
    const drainRecord = reportLifecycle.mock.calls.find(([, message]) => message.includes('reason=excess_capacity'));
    const excessIndex = authorities.findIndex((authority) =>
      drainRecord?.[1].includes(`set=${setReference(authority.setIdentity)}`),
    );
    const excessAuthority = authorities[excessIndex];
    const excessRecord = records[excessIndex];
    if (excessAuthority === undefined || excessRecord === undefined) throw new Error('expected excess authority');

    expect(lifecycle.snapshot()).toEqual(
      expect.objectContaining({ represented: 5, available: 4, states: expect.arrayContaining(['draining']) }),
    );
    expect(lifecycle.beginFreshAcquisition('new-route')).toEqual({
      kind: 'capacity',
      code: 'provider_proxy_set_capacity',
    });
    expect(stopAndReap).not.toHaveBeenCalled();
    claims.applyMutation({ kind: 'deleted', record: excessRecord });
    lifecycle.claimsChanged(excessAuthority.setIdentity);

    expect(stopAndReap).toHaveBeenCalledOnce();
    expect(reportLifecycle.mock.calls).toEqual([
      [
        'info',
        `Provider proxy set action=drain reason=excess_capacity fault=none subject=retirement liveClaims=1 set=${setReference(excessAuthority.setIdentity)} error=none`,
      ],
      [
        'info',
        `Provider proxy set action=stop-and-reap reason=excess_capacity fault=none subject=retirement liveClaims=0 set=${setReference(excessAuthority.setIdentity)} error=none`,
      ],
    ]);
  });

  it('completes a graceful drain after a retry-safe incident', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'still claimed' }) as const);
    const stopHeartbeats = vi.fn();
    const faults = createProviderProxyAuthorityFaultLatch();
    const authority: DurableProviderProxyOperationAuthority = {
      ...fakeAuthority({ record, faults, stopAndReap }),
      stopHeartbeats,
    };
    const decisionObservations: Array<
      Readonly<{ severity: 'info' | 'warn'; message: string; route: boolean; stopped: boolean }>
    > = [];
    const constructed: { lifecycle: ProviderProxySetLifecycle | null } = { lifecycle: null };
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      reportLifecycle: (severity, message) =>
        decisionObservations.push({
          severity,
          message,
          route: constructed.lifecycle?.routeFor('graceful-route') === authority,
          stopped: stopHeartbeats.mock.calls.length > 0,
        }),
    });
    constructed.lifecycle = lifecycle;
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const admission = lifecycle.beginFreshAcquisition('graceful-route');
    if (admission.kind !== 'accepted') throw new Error('expected acquisition admission');
    lifecycle.acquisitionSucceeded(admission.slotId, authority);

    lifecycle.beginGracefulDrain(authority.setIdentity);
    expect(stopAndReap).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().states).toEqual(['draining']);
    expect(lifecycle.routeFor('graceful-route')).toBeNull();
    faults.reportIncident({
      kind: 'operation-control-failed',
      policy: operationPolicy,
      error: 'settlement timeout',
    });
    claims.applyMutation({ kind: 'deleted', record });
    lifecycle.claimsChanged(authority.setIdentity);
    expect(stopAndReap).toHaveBeenCalledOnce();
    expect(decisionObservations).toEqual([
      {
        severity: 'info',
        message: `Provider proxy set action=drain reason=graceful_idle fault=none subject=retirement liveClaims=1 set=${setReference(authority.setIdentity)} error=none`,
        route: true,
        stopped: false,
      },
      {
        severity: 'info',
        message: `Provider proxy set action=preserve reason=retry_safe_operation_control_failure fault=operation-control-failed subject=operation.settle.v1 liveClaims=1 set=${setReference(authority.setIdentity)} error=settlement timeout`,
        route: false,
        stopped: false,
      },
      {
        severity: 'info',
        message: `Provider proxy set action=stop-and-reap reason=graceful_idle fault=none subject=retirement liveClaims=0 set=${setReference(authority.setIdentity)} error=none`,
        route: false,
        stopped: false,
      },
    ]);
    expect(stopHeartbeats).toHaveBeenCalledOnce();
  });

  it('discards a heartbeat hold when the set enters graceful drain', () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const clock = new ManualClock();
    const faults = createProviderProxyAuthorityFaultLatch();
    const stopAndReap = vi.fn(async () => ({ unconfirmed: 'still claimed' }) as const);
    const authority = fakeAuthority({
      record,
      faults,
      stopAndReap,
      heartbeatHoldBound: { spanMs: 1, materialSchedulerLatenessMs: Number.MAX_SAFE_INTEGER },
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority);

    const unanswered = (): void =>
      faults.reportIncident(
        heartbeatAuthorityObservation({ kind: 'no-response-before-deadline', error: 'heartbeat timed out' }),
      );

    unanswered();
    lifecycle.beginGracefulDrain(authority.setIdentity);
    clock.elapse(2);
    unanswered();
    unanswered();

    expect(lifecycle.snapshot().states).toEqual(['draining']);
    expect(stopAndReap).not.toHaveBeenCalled();
  });

  // The two capsules this build must represent but never dial. Reaching a role is what makes the difference
  // fatal rather than merely useless: `handoff.redeem` is build-gated (`assertNamedCoordinatorBuild`), a
  // foreign set answers `identity_mismatch`, and the recovery policy classifies that as `refused` — which
  // retires fatally before any seam weighs the absence evidence, taking the coordinator down over a set it
  // never owned. A shipped V2 is the same problem from the other side: reachable, but its process identity is
  // seconds this build cannot verify. Revert either branch and `redeemCapsule` runs here.
  it('represents a capsule it cannot inherit and never dials it', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const identity = authority.setIdentity;
    const redeemCapsule = vi.fn(
      async (): Promise<ProviderProxySetRedemptionOutcome> => ({ kind: 'redeemed', set: authority }),
    );
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: () => undefined,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      redeemCapsule,
    });
    lifecycle.initializeClaimSlots();

    const shippedV2 = capsuleV2For(authority);

    lifecycle.installDiscoveredCapsules(
      [
        {
          path: '/capsules/other-build-v1.handoff.json',
          capsule: capsuleFor(authority, { buildSetId: '99999999-9999-4999-8999-999999999999' }),
        },
        {
          // The case an upgrade actually produces: this build's own capsule shape, written by another build.
          path: '/capsules/other-build-v3.handoff.json',
          capsule: { ...capsuleV3For(authority), buildSetId: '88888888-8888-4888-8888-888888888888' },
        },
        { path: '/capsules/shipped-v2.handoff.json', capsule: shippedV2 },
        {
          // A fourth, so counting these again would exceed the four-slot limit outright. With three, a single
          // acquisition still fits inside the limit and the assertion below passes whether they are counted or
          // not — which is exactly how it passed while counting them.
          path: '/capsules/other-build-v1-b.handoff.json',
          capsule: capsuleFor(authority, {
            buildSetId: '66666666-6666-4666-8666-666666666666',
            grantId: randomUUID(),
          }),
        },
      ],
      retainsEveryCapsule,
    );

    expect(lifecycle.snapshot().states).toEqual([
      'capsule-foreign',
      'capsule-foreign',
      'capsule-foreign',
      'capsule-foreign',
    ]);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(redeemCapsule, 'a capsule this build cannot redeem must never be dialed').not.toHaveBeenCalled();

    // Capacity exists for sets this coordinator runs. A foreign slot holds no authority, route or claim, so
    // counting it would let capsules left by another build deny this one its own sets — four permanently, and
    // one for the matching host. The V2 above carries exactly this build's buildSetId and hostFingerprint.
    expect(
      lifecycle.beginFreshAcquisition('route-a', {
        buildSetId: FIXTURE_BUILD_SET_ID,
        hostFingerprint: identity.hostFingerprint,
      }),
      'an un-inheritable capsule must not deny acquisition for its own build and host',
    ).toMatchObject({ kind: 'accepted' });
  });

  // AC6's own words: `unknown` is never `absent`. Flipping the production predicate from `=== 'absent'` to
  // `!== 'alive'` retires every capsule these rows retain for an unobservable role, so a row whose deciding
  // answer is `unknown` fails, and so does every row asserting that a later role went unasked.
  const EVIDENCE_LAW: readonly Readonly<{
    name: string;
    capsule(authority: DurableProviderProxyOperationAuthority): RecordedCapsule;
    probes: Readonly<Record<RecordedRoleName, RoleProbe>>;
    observedRoles: readonly RecordedRoleName[];
    retires: boolean;
  }>[] = [
    {
      name: 'retires a v3 capsule whose every recorded incarnation now names another process, although every pid is alive',
      capsule: foreignCapsuleV3For,
      probes: {
        guardian: { incarnation: 'differs', liveness: 'alive' },
        reaper: { incarnation: 'differs', liveness: 'alive' },
        proxy: { incarnation: 'differs', liveness: 'alive' },
      },
      observedRoles: ['guardian', 'reaper', 'proxy'],
      retires: true,
    },
    {
      name: 'retires a v2 capsule on liveness alone, asking for no incarnation it records none of',
      capsule: capsuleV2For,
      probes: { guardian: { liveness: 'absent' }, reaper: { liveness: 'absent' }, proxy: { liveness: 'absent' } },
      observedRoles: ['guardian', 'reaper', 'proxy'],
      retires: true,
    },
    {
      name: 'retains a v3 capsule whose guardian incarnation still matches, and asks nothing of the later roles',
      capsule: foreignCapsuleV3For,
      probes: {
        guardian: { incarnation: 'matches', liveness: 'alive' },
        reaper: { incarnation: 'differs', liveness: 'alive' },
        proxy: { incarnation: 'differs', liveness: 'alive' },
      },
      observedRoles: ['guardian'],
      retires: false,
    },
    {
      name: 'retains a v2 capsule whose guardian pid is alive, and asks nothing of the later roles',
      capsule: capsuleV2For,
      probes: { guardian: { liveness: 'alive' }, reaper: { liveness: 'absent' }, proxy: { liveness: 'absent' } },
      observedRoles: ['guardian'],
      retires: false,
    },
    {
      name: 'retains a v3 capsule whose reaper could not be observed at all, and asks nothing of the proxy',
      capsule: foreignCapsuleV3For,
      probes: {
        guardian: { incarnation: 'differs', liveness: 'alive' },
        reaper: { liveness: 'throws' },
        proxy: { incarnation: 'differs', liveness: 'alive' },
      },
      observedRoles: ['guardian', 'reaper'],
      retires: false,
    },
    {
      name: 'retains a v3 capsule on two absences and one role that could not be observed',
      capsule: foreignCapsuleV3For,
      probes: {
        guardian: { incarnation: 'differs', liveness: 'alive' },
        reaper: { incarnation: 'differs', liveness: 'alive' },
        proxy: { liveness: 'throws' },
      },
      observedRoles: ['guardian', 'reaper', 'proxy'],
      retires: false,
    },
    {
      name: 'retains a v2 capsule on two absences and one role that could not be observed',
      capsule: capsuleV2For,
      probes: { guardian: { liveness: 'absent' }, reaper: { liveness: 'absent' }, proxy: { liveness: 'throws' } },
      observedRoles: ['guardian', 'reaper', 'proxy'],
      retires: false,
    },
  ];

  for (const row of EVIDENCE_LAW) {
    it(row.name, async () => {
      const claims = new ProviderProxySetClaimMirror();
      claims.initialize([]);
      const authority = fakeAuthority();
      const capsule = row.capsule(authority);
      const path = '/capsules/evidence-law.handoff.json';
      const retiredPaths: string[] = [];
      const retireCapsule = vi.fn(async (retiring: string) => {
        retiredPaths.push(retiring);
        return { kind: 'retired' as const };
      });
      const observation = scriptedObservation(capsule, row.probes);
      const lifecycle = lifecycleFor({
        claims,
        controlEstablished: ignoreControlEstablished,
        disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
        time: new ManualClock(),
        proveContainmentAbsent: noContainmentProof,
        retireCapsule,
      });
      lifecycle.initializeClaimSlots();

      lifecycle.installDiscoveredCapsules([{ path, capsule }], observation);
      await drainMicrotasks();

      expect({
        observed: observation.observed,
        incarnationReads: observation.incarnationReads,
        retired: retiredPaths,
        states: lifecycle.snapshot().states,
      }).toEqual({
        observed: row.observedRoles.map((role) => recordedRole(capsule, role)),
        incarnationReads: capsule.version === 3 ? row.observedRoles.map((role) => recordedRole(capsule, role).pid) : [],
        retired: row.retires ? [path] : [],
        states: row.retires ? [] : ['capsule-foreign'],
      });
    });
  }

  // The absence of evidence is not evidence of absence. A capsule that records no process may not be retired,
  // and no probe may be spent asking about a process it does not name.
  it('never retires a v1 capsule, and spends no probe on a process it records none of', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const path = '/capsules/records-no-process.handoff.json';
    const retireCapsule = vi.fn(async () => ({ kind: 'retired' as const }));
    const observeRecordedProcess = vi.fn((): ProcessLiveness => 'absent');
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules([{ path, capsule: capsuleFor(authority) }], { observeRecordedProcess });
    await drainMicrotasks();

    expect({
      observations: observeRecordedProcess.mock.calls.length,
      retired: retireCapsule.mock.calls.length,
      states: lifecycle.snapshot().states,
    }).toEqual({ observations: 0, retired: 0, states: ['capsule-foreign'] });
  });

  it('retires an unclaimed all-absent capsule and releases only the representation of its own path', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const retiredPath = '/capsules/foreign-retired.handoff.v3.json';
    const pendingPath = '/capsules/foreign-pending.handoff.v3.json';
    const attemptedPaths: string[] = [];
    const retireCapsule = vi.fn((path: string) => {
      attemptedPaths.push(path);
      return path === retiredPath
        ? Promise.resolve({ kind: 'retired' as const })
        : new Promise<CapsuleRetirementAttemptOutcome>(() => undefined);
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules(
      [
        { path: retiredPath, capsule: foreignCapsuleV3For(authority) },
        {
          path: pendingPath,
          capsule: {
            ...capsuleV3For(authority),
            buildSetId: '77777777-7777-4777-8777-777777777777',
            grantId: randomUUID(),
          },
        },
      ],
      observesEveryRoleAbsent,
    );

    // Both slots exist while the dispatcher outcome is still pending, and neither denies this build a set of
    // its own — a capsule left by another build must not consume acquisition capacity while it is retiring.
    expect({
      states: lifecycle.snapshot().states,
      admission: lifecycle.beginFreshAcquisition('own-route', {
        buildSetId: FIXTURE_BUILD_SET_ID,
        hostFingerprint: authority.setIdentity.hostFingerprint,
      }).kind,
    }).toEqual({ states: ['capsule-foreign', 'capsule-foreign'], admission: 'accepted' });

    await drainMicrotasks();

    expect({
      attempted: attemptedPaths,
      states: lifecycle.snapshot().states,
    }).toEqual({
      attempted: [retiredPath, pendingPath],
      states: ['capsule-foreign', 'acquiring'],
    });
  });

  it('retries a foreign retirement four times and abandons the fifth without failing the coordinator', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const clock = new ManualClock();
    const authority = fakeAuthority();
    const path = '/capsules/foreign-unavailable.handoff.v3.json';
    const retireCapsule = vi.fn(async () => ({
      kind: 'temporarily-unavailable' as const,
      incident: { kind: 'capsule-directory-durability-unavailable' as const },
    }));
    const reportLifecycle = vi.fn();
    const onFatal = vi.fn();
    const progressViolations: ProviderProxySetLifecycleProgressViolation[] = [];
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
      reportLifecycle,
      onFatal,
      onProgressPremiseViolation: (violation) => progressViolations.push(violation),
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules([{ path, capsule: foreignCapsuleV3For(authority) }], observesEveryRoleAbsent);
    await settleScheduledWork(clock);
    const atTerminal = {
      attempts: retireCapsule.mock.calls.length,
      scheduled: [...clock.scheduledDelays],
      unreferenced: [...clock.unreferencedDelays],
      liveTimers: clock.timers.filter((timer) => timer.active).length,
      states: lifecycle.snapshot().states,
      fatals: onFatal.mock.calls.length,
      // A foreign retirement retry is not containment progress, and no lateness is reported for this seam.
      // Reporting one would hand an operator a containment progress violation about a hold no containment
      // ever depended on.
      progressViolations: [...progressViolations],
      // The attempt count discriminates this warning: a capsule path alone is named by more than one.
      retirementWarnings: reportLifecycle.mock.calls
        .filter((call) => call[0] === 'warn')
        .map((call) => retirementWarningFacts(String(call[1])))
        .filter((facts) => facts.attempts !== null),
    };

    // No owner is left, so no amount of remaining boot can produce a sixth attempt.
    clock.elapse(600_000);
    clock.runDue();
    await drainMicrotasks();

    expect({ ...atTerminal, attemptsAfterTheRestOfTheBoot: retireCapsule.mock.calls.length }).toEqual({
      attempts: 5,
      scheduled: [1_000, 2_000, 4_000, 8_000],
      unreferenced: [1_000, 2_000, 4_000, 8_000],
      liveTimers: 0,
      states: ['capsule-foreign'],
      fatals: 0,
      progressViolations: [],
      retirementWarnings: [
        { capsulePath: path, attempts: '5 attempts', lastIncident: 'capsule-directory-durability-unavailable' },
      ],
      attemptsAfterTheRestOfTheBoot: 5,
    });
  });

  it('carries a rejected foreign retirement to the same terminal and names the errno it could read', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const clock = new ManualClock();
    const authority = fakeAuthority();
    const path = '/capsules/foreign-readonly.handoff.v3.json';
    const retireCapsule = vi.fn((): CapsuleRetirementAttemptOutcome => {
      throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    });
    const reportLifecycle = vi.fn();
    const onFatal = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
      reportLifecycle,
      onFatal,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules([{ path, capsule: foreignCapsuleV3For(authority) }], observesEveryRoleAbsent);
    await settleScheduledWork(clock);

    expect({
      attempts: retireCapsule.mock.calls.length,
      states: lifecycle.snapshot().states,
      fatals: onFatal.mock.calls.length,
      retirementWarnings: reportLifecycle.mock.calls
        .filter((call) => call[0] === 'warn')
        .map((call) => retirementWarningFacts(String(call[1])))
        .filter((facts) => facts.attempts !== null),
    }).toEqual({
      attempts: 5,
      states: ['capsule-foreign'],
      fatals: 0,
      retirementWarnings: [
        { capsulePath: path, attempts: '5 attempts', lastIncident: 'foreign-capsule-retirement-rejected code=EROFS' },
      ],
    });
  });

  it('carries a malformed retirement fulfillment to the same terminal under its own incident', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const clock = new ManualClock();
    const authority = fakeAuthority();
    const path = '/capsules/foreign-malformed.handoff.v3.json';
    // A producer that promises a retry and carries nothing to hold. The owner may read this only as an
    // incident it can name, because an operator sent to the filesystem over a defect in this build looks
    // there for as long as the capsule stays on disk.
    const retireCapsule = vi.fn(() => ({ kind: 'temporarily-unavailable' }) as CapsuleRetirementAttemptOutcome);
    const reportLifecycle = vi.fn();
    const onFatal = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
      reportLifecycle,
      onFatal,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules([{ path, capsule: foreignCapsuleV3For(authority) }], observesEveryRoleAbsent);
    await settleScheduledWork(clock);

    expect({
      attempts: retireCapsule.mock.calls.length,
      states: lifecycle.snapshot().states,
      fatals: onFatal.mock.calls.length,
      retirementWarnings: reportLifecycle.mock.calls
        .filter((call) => call[0] === 'warn')
        .map((call) => retirementWarningFacts(String(call[1])))
        .filter((facts) => facts.attempts !== null),
    }).toEqual({
      attempts: 5,
      states: ['capsule-foreign'],
      fatals: 0,
      retirementWarnings: [
        {
          capsulePath: path,
          attempts: '5 attempts',
          lastIncident: 'foreign-capsule-retirement-contract-violation',
        },
      ],
    });
  });

  it('keeps a failing retirement from clearing the aliases that name its capsule path', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const capsule = foreignCapsuleV3For(authority);
    const retireCapsule = vi.fn((): CapsuleRetirementAttemptOutcome => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();

    // The producer rejects inside the installation loop, so the second entry meets the alias map exactly as
    // the first entry's failed retirement left it. A second path claiming that address without being refused
    // would mean the failure had released a credential this build is still representing.
    expect(() =>
      lifecycle.installDiscoveredCapsules(
        [
          { path: '/capsules/foreign-alias-holder.handoff.v3.json', capsule },
          { path: '/capsules/foreign-alias-rival.handoff.v3.json', capsule: { ...capsule, grantId: randomUUID() } },
        ],
        observesEveryRoleAbsent,
      ),
    ).toThrow('provider_proxy_capsule_address_alias');
    expect(retireCapsule).toHaveBeenCalledTimes(1);
  });

  it("ignores a superseded owner's outcome and releases only what the current owner holds", async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const clock = new ManualClock();
    const authority = fakeAuthority();
    const path = '/capsules/foreign-superseded.handoff.v3.json';
    const capsule = foreignCapsuleV3For(authority);
    const supersededTurn = deferred<CapsuleRetirementAttemptOutcome>();
    const owningTurn = deferred<CapsuleRetirementAttemptOutcome>();
    const turnsInOrder = [supersededTurn, owningTurn];
    let startedAttempts = 0;
    const retireCapsule = vi.fn(() => {
      const turn = turnsInOrder[startedAttempts];
      startedAttempts += 1;
      if (turn === undefined) throw new Error('unexpected retirement attempt');
      return turn.promise;
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();

    // Two capsules at one path: the second installation takes ownership of that path, and the first turn is
    // then a callback with nothing left to speak for.
    lifecycle.installDiscoveredCapsules(
      [
        { path, capsule },
        { path, capsule: { ...capsule, proxyInstanceId: randomUUID(), grantId: randomUUID() } },
      ],
      observesEveryRoleAbsent,
    );
    await drainMicrotasks();

    supersededTurn.resolve({
      kind: 'temporarily-unavailable',
      incident: { kind: 'capsule-directory-durability-unavailable' },
    });
    await drainMicrotasks();
    const afterStaleFailure = {
      scheduled: [...clock.scheduledDelays],
      attempts: retireCapsule.mock.calls.length,
      states: lifecycle.snapshot().states,
    };

    owningTurn.resolve({ kind: 'retired' });
    await settleScheduledWork(clock);

    expect({ afterStaleFailure, afterEvidence: lifecycle.snapshot().states }).toEqual({
      afterStaleFailure: { scheduled: [], attempts: 2, states: ['capsule-foreign', 'capsule-foreign'] },
      afterEvidence: ['capsule-foreign'],
    });
  });

  it('keeps the current owner retrying to its own terminal after a superseded turn resolves retired', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const clock = new ManualClock();
    const authority = fakeAuthority();
    const path = '/capsules/foreign-stale-evidence.handoff.v3.json';
    const capsule = foreignCapsuleV3For(authority);
    const supersededTurn = deferred<CapsuleRetirementAttemptOutcome>();
    const owningTurn = deferred<CapsuleRetirementAttemptOutcome>();
    const deferredTurns = [supersededTurn, owningTurn];
    const durabilityUnavailable = {
      kind: 'temporarily-unavailable' as const,
      incident: { kind: 'capsule-directory-durability-unavailable' as const },
    };
    let startedAttempts = 0;
    const retireCapsule = vi.fn(() => {
      const turn = deferredTurns[startedAttempts];
      startedAttempts += 1;
      return turn?.promise ?? Promise.resolve(durabilityUnavailable);
    });
    const reportLifecycle = vi.fn();
    const onFatal = vi.fn();
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: clock,
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
      reportLifecycle,
      onFatal,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules(
      [
        { path, capsule },
        { path, capsule: { ...capsule, proxyInstanceId: randomUUID(), grantId: randomUUID() } },
      ],
      observesEveryRoleAbsent,
    );
    await drainMicrotasks();

    // `retired` is the outcome that releases things, and this turn no longer speaks for the path: neither
    // representation may go, or a capsule still on disk loses the slot that keeps its address unaliasable.
    supersededTurn.resolve({ kind: 'retired' });
    await drainMicrotasks();
    const afterStaleEvidence = {
      states: lifecycle.snapshot().states,
      attempts: retireCapsule.mock.calls.length,
      scheduled: [...clock.scheduledDelays],
    };

    // The hold the current owner is carrying must still reach its own named end, with every attempt the bound
    // allows: a stale outcome that quietly took its place would leave nothing for an operator to read.
    owningTurn.resolve(durabilityUnavailable);
    await settleScheduledWork(clock);

    expect({
      afterStaleEvidence,
      attempts: retireCapsule.mock.calls.length,
      scheduled: [...clock.scheduledDelays],
      states: lifecycle.snapshot().states,
      fatals: onFatal.mock.calls.length,
      retirementWarnings: reportLifecycle.mock.calls
        .filter((call) => call[0] === 'warn')
        .map((call) => retirementWarningFacts(String(call[1])))
        .filter((facts) => facts.attempts !== null),
    }).toEqual({
      afterStaleEvidence: {
        states: ['capsule-foreign', 'capsule-foreign'],
        attempts: 2,
        scheduled: [],
      },
      attempts: 6,
      scheduled: [1_000, 2_000, 4_000, 8_000],
      states: ['capsule-foreign', 'capsule-foreign'],
      fatals: 0,
      retirementWarnings: [
        { capsulePath: path, attempts: '5 attempts', lastIncident: 'capsule-directory-durability-unavailable' },
      ],
    });
  });

  it('lets a later boot retire a capsule an exhausted owner left readable', async () => {
    const authority = fakeAuthority();
    const path = '/capsules/foreign-survived-a-boot.handoff.v3.json';
    const capsule = foreignCapsuleV3For(authority);
    const bootLifecycle = (
      retireCapsule: ProviderProxySetLifecycleFixtureDeps['retireCapsule'],
      clock: ManualClock,
    ): ProviderProxySetLifecycle => {
      const claims = new ProviderProxySetClaimMirror();
      claims.initialize([]);
      const lifecycle = lifecycleFor({
        claims,
        controlEstablished: ignoreControlEstablished,
        disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
        time: clock,
        proveContainmentAbsent: noContainmentProof,
        retireCapsule,
      });
      lifecycle.initializeClaimSlots();
      return lifecycle;
    };

    const firstBootClock = new ManualClock();
    const firstBootRetire = vi.fn(async () => ({
      kind: 'temporarily-unavailable' as const,
      incident: { kind: 'capsule-directory-durability-unavailable' as const },
    }));
    const firstBoot = bootLifecycle(firstBootRetire, firstBootClock);
    firstBoot.installDiscoveredCapsules([{ path, capsule }], observesEveryRoleAbsent);
    await settleScheduledWork(firstBootClock);

    const secondBootClock = new ManualClock();
    const secondBootAttempts: string[] = [];
    const secondBoot = bootLifecycle(async (retiring: string) => {
      secondBootAttempts.push(retiring);
      return { kind: 'retired' as const };
    }, secondBootClock);
    secondBoot.installDiscoveredCapsules([{ path, capsule }], observesEveryRoleAbsent);
    await settleScheduledWork(secondBootClock);

    expect({
      firstBootAttempts: firstBootRetire.mock.calls.length,
      firstBootStates: firstBoot.snapshot().states,
      secondBootAttempts,
      secondBootStates: secondBoot.snapshot().states,
    }).toEqual({
      firstBootAttempts: 5,
      firstBootStates: ['capsule-foreign'],
      secondBootAttempts: [path],
      secondBootStates: [],
    });
  });

  it('decides retirement for a claim-matched capsule before the branch that creates no foreign slot', async () => {
    const record = providerOperationRecord('executing');
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([record]);
    const authority = fakeAuthority({ record });
    const path = '/capsules/claim-matched-v2.handoff.json';
    const retiredPaths: string[] = [];
    const retireCapsule = vi.fn(async (retiring: string) => {
      retiredPaths.push(retiring);
      return { kind: 'retired' as const };
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();

    lifecycle.installDiscoveredCapsules([{ path, capsule: capsuleV2For(authority) }], observesEveryRoleAbsent);
    const beforeEvidence = lifecycle.snapshot().states;
    await drainMicrotasks();

    expect({
      beforeEvidence,
      retired: retiredPaths,
      afterEvidence: lifecycle.snapshot().states,
    }).toEqual({ beforeEvidence: ['recovering'], retired: [path], afterEvidence: ['recovering'] });

    // The claim is still the one this coordinator holds by identity: releasing it here would strand every
    // operation behind it, and a foreign retirement never held it to release.
    expect(lifecycle.containmentAbsent(authority.setIdentity, 'claim-survived-retirement').kind).toBe('accepted');
  });

  it('retains a capsule whose recorded pid is zero, which a real observation answers alive', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const capsule = { ...foreignCapsuleV3For(authority), guardianPid: 0 };
    const retireCapsule = vi.fn(async () => ({ kind: 'retired' as const }));
    const observeRecordedProcess = createRecordedProcessObserver({
      readIncarnation: (pid) => probeProcessIncarnation(pid),
      observeLiveness: observeProcessLiveness,
    });
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();

    // Said outright rather than left to "any `alive` retains": pid 0 names no recorded process, so no
    // incarnation is readable for it and signal-0 answers for this process's own group instead.
    expect(observeRecordedProcess({ pid: 0, incarnation: capsule.guardianIncarnation })).toBe('alive');

    lifecycle.installDiscoveredCapsules([{ path: '/capsules/zero-pid.handoff.v3.json', capsule }], {
      observeRecordedProcess,
    });
    await drainMicrotasks();

    expect({ retired: retireCapsule.mock.calls.length, states: lifecycle.snapshot().states }).toEqual({
      retired: 0,
      states: ['capsule-foreign'],
    });
  });

  it('hands capsule installation one answer about a recorded process and no way to act on one', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const retireCapsule = vi.fn(async () => ({ kind: 'retired' as const }));
    const kill = vi.spyOn(process, 'kill');
    const lifecycle = lifecycleFor({
      claims,
      controlEstablished: ignoreControlEstablished,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: new ManualClock(),
      proveContainmentAbsent: noContainmentProof,
      retireCapsule,
    });
    lifecycle.initializeClaimSlots();

    try {
      lifecycle.installDiscoveredCapsules(
        [{ path: '/capsules/observation-only.handoff.v3.json', capsule: foreignCapsuleV3For(authority) }],
        { observeRecordedProcess: () => 'alive' },
      );
      await drainMicrotasks();

      expect({
        signals: kill.mock.calls.length,
        retired: retireCapsule.mock.calls.length,
        states: lifecycle.snapshot().states,
      }).toEqual({
        signals: 0,
        retired: 0,
        states: ['capsule-foreign'],
      });
    } finally {
      kill.mockRestore();
    }
  });
});
