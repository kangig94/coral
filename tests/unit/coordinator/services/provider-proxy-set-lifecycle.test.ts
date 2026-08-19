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
import { ControlClientError } from '#src/provider-proxy/control-client.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import {
  createProviderProxyAuthorityFaultLatch,
  type ContainmentRequiredControlCallPolicy,
  type ProviderProxyAuthorityFault,
  type ProviderProxyAuthorityFaultLatch,
  type ProviderProxyOperationIncident,
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
import type {
  ProviderProxyRecoveryDispatcher,
  ProviderProxySetLifecycleFatalError,
} from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import { isProviderProxyRecoveryFatalError } from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import type { ProviderProxySetRedemptionOutcome } from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { ProviderOperationTerminalMetadataError } from '#src/jobs/provider-operation-terminalization.js';
import type { ProviderOperationTerminalDirective } from '#src/store/provider-operation-record.js';

/** The build this fixture lifecycle belongs to — the same one `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';

const noContainmentProof = async (): Promise<null> => null;
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
    error: 'control closed',
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
    proveContainmentAbsent(
      identity: ReturnType<typeof providerProxySetIdentityFromRecord>,
      signal: AbortSignal,
    ): Promise<string | null>;
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
    },
    onFatal,
  );
  const {
    proveContainmentAbsent: _proveContainmentAbsent,
    retireCapsule: _retireCapsule,
    onFatal: _onFatal,
    redeemCapsule: _redeemCapsule,
    disappearanceConsumer: _disappearanceConsumer,
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

  now = (): number => this.nowMs;

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
  } = {},
): DurableProviderProxyOperationAuthority {
  const record = options.record ?? providerOperationRecord('executing');
  const fault = options.fault;
  const faults = options.faults ?? (fault === undefined ? createProviderProxyAuthorityFaultLatch() : undefined);
  const authority: DurableProviderProxyOperationAuthority = {
    proxyInstanceId: record.operation.proxyInstanceId,
    setIdentity: providerProxySetIdentityFromRecord(record),
    faulted: faults?.faulted ?? fault?.promise ?? new Promise<never>(() => undefined),
    onFault:
      faults?.onFault ??
      ((listener) => {
        if (fault !== undefined) void fault.promise.then(listener);
        return () => undefined;
      }),
    onIncident: faults?.onIncident ?? (() => () => undefined),
    registerSuccessionOperation: async () => undefined,
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
    const incidents: ProviderProxyOperationIncident[] = [];
    let terminalFaultObserved = false;
    void faults.faulted.then(() => {
      terminalFaultObserved = true;
    });
    faults.onIncident((next) => incidents.push(next));

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
        `Provider proxy set action=stop-and-reap reason=provider_authority_lost fault=heartbeat-failed subject=proxy liveClaims=1 set=${firstReference} error=control closed`,
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

    const incident: ProviderProxyOperationIncident = {
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

  it('reaps live claims after a control-channel fault', () => {
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
      kind: 'control-channel-fault',
      role: 'guardian',
      error: new Error('guardian channel closed') as never,
    });

    expect(stopAndReap).toHaveBeenCalledOnce();
    expect(reportLifecycle).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('action=stop-and-reap reason=provider_authority_lost fault=control-channel-fault'),
    );
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
      const absenceResult = deferred<string | null>();
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
        absenceResult.resolve(disappearanceReceipt);
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
        absenceResult.resolve('guardian:late-guardian;reaper:late-reaper');
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

  it('retires an unmatched exact v3 capsule after independent absence proof', async () => {
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const authority = fakeAuthority();
    const proveContainmentAbsent = vi.fn(async () => 'exact-v3-absence');
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
    const neverProvesAbsence = new Promise<null>(() => undefined);
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
      error: 'control closed',
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
        `Provider proxy set action=stop-and-reap reason=provider_authority_lost fault=heartbeat-failed subject=proxy liveClaims=1 set=${setReference(authority.setIdentity)} error=control closed`,
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
        'containment-proof': async () => null,
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
      `Provider proxy set action=stop-and-reap reason=provider_authority_lost fault=heartbeat-failed subject=proxy liveClaims=0 set=${setReference(authority.setIdentity)} error=control closed`,
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
    // The observer reads the very lifecycle it is passed into, so the reference is published after
    // construction through a holder rather than forward-declared.
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
