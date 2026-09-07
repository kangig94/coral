import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  acquireProviderProxySet,
  type ProviderProxyAcquisitionSteps,
  type ProviderProxyAcquisitionResult,
} from '#src/coordinator/live/provider-proxy/index.js';
import {
  buildGuardianSpawnUndo,
  isProviderProxyAcquisitionAbsenceEvidenceFor,
  reobserveDurableProviderProxyAcquisitionContainment,
} from '#src/coordinator/live/provider-proxy/spawn-undo.js';
import { controlExchangeForTest, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import {
  GUARDIAN_CONSTRUCTION_CONTAINMENT_SETTLED_EXIT_CODE,
  providerProxyDisappearanceReceipt,
  type GuardianIdentity,
  type ProxyIdentity,
  type ReaperIdentity,
} from '#src/provider-proxy/protocol.js';
import { buildEnforcementOutcomeHandlers } from '#src/provider-proxy/role-main.js';
import type { SpawnedRoleProcess } from '#src/provider-proxy/role-spawn.js';
import type { Runtime } from '#src/runtime/ports.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const immediateRetryTime = { sleep: async () => undefined };

const guardian: GuardianIdentity = {
  guardianInstanceId: '11111111-1111-4111-8111-111111111111',
  pid: 101,
  incarnation: testIncarnation(101),
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: '22222222-2222-4222-8222-222222222222',
  hostFingerprint: 'a'.repeat(64),
  canonicalControlEndpoint: '/tmp/guardian.sock',
};

const reaper: ReaperIdentity = {
  reaperInstanceId: '33333333-3333-4333-8333-333333333333',
  pid: 102,
  incarnation: testIncarnation(102),
  guardianInstanceId: guardian.guardianInstanceId,
  generation: guardian.generation,
  flavor: guardian.flavor,
  buildSetId: guardian.buildSetId,
  hostFingerprint: guardian.hostFingerprint,
  canonicalControlEndpoint: '/tmp/reaper.sock',
  containmentKind: 'detached-process-group',
};

const proxy: ProxyIdentity = {
  proxyInstanceId: '44444444-4444-4444-8444-444444444444',
  guardianInstanceId: guardian.guardianInstanceId,
  reaperInstanceId: reaper.reaperInstanceId,
  pid: 103,
  incarnation: testIncarnation(103),
  processGroupId: 103,
  generation: guardian.generation,
  flavor: guardian.flavor,
  buildSetId: guardian.buildSetId,
  hostFingerprint: guardian.hostFingerprint,
  canonicalEndpoint: '/tmp/proxy.sock',
};

function guardianSpawnWithEvents(): Readonly<{ child: EventEmitter; spawned: SpawnedRoleProcess }> {
  const child = new EventEmitter();
  return {
    child,
    spawned: {
      child,
      pid: guardian.pid,
      incarnation: guardian.incarnation,
    } as unknown as SpawnedRoleProcess,
  };
}

function failAcquisitionAfterGuardianSpawn(
  undo: ReturnType<typeof buildGuardianSpawnUndo>,
  reason: string,
): Promise<ProviderProxyAcquisitionResult> {
  const steps: ProviderProxyAcquisitionSteps = {
    createCapsules: async () => ({ label: 'capsules', run: () => undefined }),
    spawnGuardian: async () => ({
      kind: 'guardian-containment',
      label: 'guardian',
      setAddress: {
        buildSetId: guardian.buildSetId,
        hostFingerprint: guardian.hostFingerprint,
        proxyInstanceId: proxy.proxyInstanceId,
      },
      run: undo,
      guardianIdentity: undo.guardianIdentity,
      captureRecoveryProof: undo.captureRecoveryProof,
    }),
    establishControl: async () => {
      throw new Error(reason);
    },
  };
  return acquireProviderProxySet({
    steps,
    time: immediateRetryTime,
    deadlineSignal: new AbortController().signal,
    acceptHold: () => ({ kind: 'accepted', owner: 'durable-provider-proxy-acquisition-hold-store' }),
  });
}

describe('guardian spawn undo', () => {
  it('does not retire construction-settled containment while its exact recorded reaper remains alive', async () => {
    const reaperLiveness = 'alive' as const;
    const runtime = {
      env: { platform: () => 'linux' },
      process: {
        readProcessIncarnation: (pid: number) => (pid === reaper.pid ? reaper.incarnation : null),
        observeLiveness: () => reaperLiveness,
      },
    } as unknown as Runtime;
    const subject = {
      guardianIdentity: { pid: guardian.pid, incarnation: guardian.incarnation, processGroupId: guardian.pid },
      reaper: { kind: 'recorded' as const, pid: reaper.pid, incarnation: reaper.incarnation },
      constructionContainmentSettled: true,
      proxy: { kind: 'possible-unidentified' as const },
    };

    await expect(
      reobserveDurableProviderProxyAcquisitionContainment(runtime, subject, new AbortController().signal),
    ).resolves.toEqual({ kind: 'held', observation: 'alive', reason: 'reaper_alive' });
  });

  it('accepts guardian process-group absence as decisive for an unidentified possible reaper', async () => {
    const killedGroups = new Set<number>();
    let monotonicNow = 0n;
    const runtime = {
      env: { platform: () => 'linux' },
      process: {
        kill: (pid: number, signal: NodeJS.Signals | 0) => {
          if (signal === 'SIGKILL') killedGroups.add(pid);
          return true;
        },
        observeLiveness: (pid: number) => (killedGroups.has(pid) ? 'absent' : 'alive'),
        observeRecordedProcessAsync: async () => 'alive' as const,
        readProcessIncarnation: () => guardian.incarnation,
      },
      time: {
        monotonicNow: () => monotonicNow,
        sleep: async (ms: number) => {
          monotonicNow += BigInt(ms);
        },
      },
    } as unknown as Runtime;
    const subject = {
      guardianIdentity: { pid: guardian.pid, incarnation: guardian.incarnation, processGroupId: guardian.pid },
      reaper: { kind: 'possible-unidentified' as const },
      constructionContainmentSettled: false,
      proxy: { kind: 'not-created' as const },
    };

    const outcome = await reobserveDurableProviderProxyAcquisitionContainment(
      runtime,
      subject,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({ kind: 'containment-absent' });
    if (outcome.kind !== 'containment-absent') throw new Error(`expected confirmed absence, received ${outcome.kind}`);
    expect(isProviderProxyAcquisitionAbsenceEvidenceFor(outcome.evidence, subject)).toBe(true);
  });

  it('settles acquisition cleanup when the guardian confirms absence before holder publication', async () => {
    const { child, spawned } = guardianSpawnWithEvents();
    const undo = buildGuardianSpawnUndo({} as Runtime, spawned, 'linux', () => guardian.incarnation);
    undo.retainPossibleProxy();
    const holderAuthority = createControlHolderAuthority();
    const scheduledCallbacks: Array<() => void> = [];
    const exitProcess = vi.fn((code: number) => {
      child.emit('close', code, null);
    });
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'guardian',
      roleIdentity: { pid: guardian.pid, incarnation: guardian.incarnation },
      deadlines: { markExited: vi.fn() },
      close: async () => undefined,
      exitProcess,
      grantWasInstalled: () => holderAuthority.phase() === 'published',
      now: () => 60_000,
      retryUnattributable: () => null,
      schedule: (callback) => scheduledCallbacks.push(callback),
    });

    handlers.onOutcome({ kind: 'containment-absent', disappearanceReceipt: 'pre-adoption-absence' });
    scheduledCallbacks.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const result = await failAcquisitionAfterGuardianSpawn(undo, 'coordinator resumed after the adoption deadline');

    expect(exitProcess).toHaveBeenCalledWith(GUARDIAN_CONSTRUCTION_CONTAINMENT_SETTLED_EXIT_CODE);
    expect(result).toMatchObject({
      kind: 'provider_proxy_acquisition_failed',
      cut: 'control establishment',
      strandedArtifacts: [],
    });
  });

  it('keeps acquisition cleanup held when the unbound guardian dies by signal', async () => {
    const { child, spawned } = guardianSpawnWithEvents();
    const undo = buildGuardianSpawnUndo({} as Runtime, spawned, 'linux', () => guardian.incarnation);
    undo.retainPossibleProxy();
    child.emit('close', null, 'SIGKILL');
    const result = await failAcquisitionAfterGuardianSpawn(undo, 'coordinator resumed after guardian death');

    expect(result).toMatchObject({
      kind: 'provider_proxy_acquisition_held',
      cut: 'control establishment',
      strandedArtifacts: ['guardian'],
      recoverySubject: { reaper: { kind: 'possible-unidentified' } },
    });
    if (result.kind !== 'provider_proxy_acquisition_held') throw new Error(`expected hold, received ${result.kind}`);
    await expect(result.recoveryCapability.retry(new AbortController().signal)).resolves.toMatchObject({
      kind: 'held',
      reason: expect.stringContaining('construction containment settled or the proxy identity transfers'),
    });
  });

  it('reaps transferred proxy and guardian groups and accepts the guardian group absence for the reaper', async () => {
    const killedGroups = new Set<number>();
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 'SIGKILL') killedGroups.add(pid);
      return true;
    });
    let monotonicNow = 0n;
    const runtime = {
      process: {
        kill,
        observeLiveness: (pid: number) => (killedGroups.has(pid) ? 'absent' : 'alive'),
        observeRecordedProcessAsync: async () => 'alive' as const,
      },
      time: {
        monotonicNow: () => monotonicNow,
        sleep: async (ms: number) => {
          monotonicNow += BigInt(ms);
        },
      },
    } as unknown as Runtime;
    const undo = buildGuardianSpawnUndo(
      runtime,
      {
        child: { on: vi.fn().mockReturnThis() },
        pid: guardian.pid,
        incarnation: guardian.incarnation,
      } as unknown as SpawnedRoleProcess,
      'linux',
      (pid) => (pid === proxy.pid ? proxy.incarnation : guardian.incarnation),
    );
    undo.bindProxyIdentity(proxy);

    await expect(undo()).resolves.toBeUndefined();

    expect(kill.mock.calls).toEqual([
      [-proxy.pid, 'SIGTERM'],
      [-proxy.pid, 'SIGKILL'],
      [-guardian.pid, 'SIGTERM'],
      [-guardian.pid, 'SIGKILL'],
    ]);
    const proof = undo.captureRecoveryProof();
    expect(isProviderProxyAcquisitionAbsenceEvidenceFor(proof.absenceEvidence(), proof.subject)).toBe(true);
  });

  it('holds the transferred proxy group without signaling the guardian when attribution is lost', async () => {
    const kill = vi.fn(() => true);
    let groupObservations = 0;
    const runtime = {
      process: {
        kill,
        observeLiveness: (pid: number) => {
          if (pid !== -proxy.pid) return 'alive';
          groupObservations += 1;
          return groupObservations <= 1 ? 'alive' : 'unknown';
        },
        observeRecordedProcessAsync: async () => 'alive' as const,
      },
      time: {
        monotonicNow: () => 0n,
        sleep: async () => undefined,
      },
    } as unknown as Runtime;
    const undo = buildGuardianSpawnUndo(
      runtime,
      {
        child: { on: vi.fn().mockReturnThis() },
        pid: guardian.pid,
        incarnation: guardian.incarnation,
      } as unknown as SpawnedRoleProcess,
      'linux',
      (pid) => (pid === proxy.pid ? proxy.incarnation : guardian.incarnation),
    );
    undo.bindProxyIdentity(proxy);

    await expect(undo()).rejects.toThrow('proxy process-group cleanup is holding');

    expect(kill).not.toHaveBeenCalled();
  });

  it('keeps the control recovery channel open after a teardown refusal without sending a signal', async () => {
    const kill = vi.fn();
    const runtime = {
      process: { kill },
      time: { now: () => 0, sleep: async () => undefined },
    } as unknown as Runtime;
    const close = vi.fn();
    const exchange = vi
      .fn<ControlClient['exchange']>()
      .mockResolvedValueOnce(
        controlExchangeForTest({
          kind: 'response',
          response: {
            kind: 'result',
            value: { state: 'teardown-latched-absence-unconfirmed', reason: 'containment is unattributable' },
          },
        }),
      )
      .mockResolvedValueOnce(
        controlExchangeForTest({
          kind: 'response',
          response: { kind: 'result', value: { state: 'containment-absent', disappearanceReceipt: 'gone' } },
        }),
      );
    const client = {
      exchange,
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close,
    } satisfies ControlClient;
    const undo = buildGuardianSpawnUndo(
      runtime,
      {
        child: { on: vi.fn().mockReturnThis() },
        pid: guardian.pid,
        incarnation: guardian.incarnation,
      } as unknown as SpawnedRoleProcess,
      'linux',
      () => guardian.incarnation,
    );
    undo.bindControl({ client, guardian, reaper, proxy });
    const steps: ProviderProxyAcquisitionSteps = {
      createCapsules: async () => ({ label: 'capsules', run: () => undefined }),
      spawnGuardian: async () => ({
        kind: 'guardian-containment',
        label: 'guardian',
        setAddress: {
          buildSetId: guardian.buildSetId,
          hostFingerprint: guardian.hostFingerprint,
          proxyInstanceId: proxy.proxyInstanceId,
        },
        run: undo,
        guardianIdentity: undo.guardianIdentity,
        captureRecoveryProof: undo.captureRecoveryProof,
      }),
      establishControl: async () => {
        throw new Error('publication failed');
      },
    };

    const result = await acquireProviderProxySet({
      steps,
      time: immediateRetryTime,
      acceptHold: () => ({ kind: 'accepted', owner: 'durable-provider-proxy-acquisition-hold-store' }),
      deadlineSignal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      kind: 'provider_proxy_acquisition_held',
      cut: 'control establishment',
      strandedArtifacts: ['guardian'],
      guardianIdentity: undo.guardianIdentity,
    });
    expect(exchange).toHaveBeenCalledWith(
      'guardian.containment-commit.v1',
      { guardian, reaper, proxy },
      expect.any(Number),
    );
    expect(close).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    if (result.kind !== 'provider_proxy_acquisition_held') throw new Error(`expected hold, received ${result.kind}`);
    if (!('guardianIdentity' in result)) throw new Error('expected an identity-bound guardian hold');
    const outcome = await result.recoveryCapability.retry(new AbortController().signal);
    expect(outcome).toMatchObject({
      kind: 'absence-confirmed',
      evidence: {
        recoverySubject: result.recoverySubject,
        disappearanceReceipt: providerProxyDisappearanceReceipt(result.guardianIdentity, [
          { pid: reaper.pid, incarnation: reaper.incarnation },
        ]),
      },
      strandedArtifacts: [],
    });
    if (outcome.kind !== 'absence-confirmed') throw new Error('expected confirmed absence');
    const proof = undo.captureRecoveryProof();
    const unrelatedSubject = {
      ...proof.subject,
      guardianIdentity: { ...proof.subject.guardianIdentity, pid: proof.subject.guardianIdentity.pid + 1 },
    };
    const attemptedCrossSubjectMint = (
      proof.absenceEvidence as unknown as (subject: typeof unrelatedSubject) => ReturnType<typeof proof.absenceEvidence>
    )(unrelatedSubject);
    expect(attemptedCrossSubjectMint.recoverySubject).toBe(proof.subject);
    expect(isProviderProxyAcquisitionAbsenceEvidenceFor(attemptedCrossSubjectMint, unrelatedSubject)).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });
});
