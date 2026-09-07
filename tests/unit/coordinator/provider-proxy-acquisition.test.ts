import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';

import {
  acquireProviderProxySet,
  type AcquisitionUndo,
  type ProviderProxyAcquisitionSteps,
} from '#src/coordinator/live/provider-proxy/index.js';
import {
  closeProviderProxyAcquisitionSession,
  createOwnedProviderProxyAcquisitionControlSession,
  handOverProviderProxyAcquisitionControlSession,
  providerProxyAcquisitionSessionDescriptor,
  providerProxyControlSessionOwner,
} from '#src/coordinator/live/provider-proxy/control-session.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import type { ProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';
import type { HandoffCapsuleV3 } from '#src/provider-proxy/handoff-capsule.js';
import { providerProxyDisappearanceReceipt } from '#src/provider-proxy/protocol.js';
import { providerProxySetAddress } from '#src/coordinator/services/provider-proxy-set/identity.js';

const SET: ProviderProxyOperationAuthority = {
  proxyInstanceId: 'p1',
  autonomousDeadline: {
    orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
    adoptionWindowMs: Number.MAX_SAFE_INTEGER,
    heartbeatHoldBound: {
      spanMs: Number.MAX_SAFE_INTEGER,
      materialSchedulerLatenessMs: Math.floor(Number.MAX_SAFE_INTEGER / 4),
    },
  },
  registerSuccessionOperation: async () => ({ kind: 'registered' as const }),
  stopAndReap: async () => ({ disappearanceReceipt: 'gone' }),
  commitContainment: async () => ({ kind: 'containment-absent', disappearanceReceipt: 'gone' }),
  stopHeartbeats: () => {},
  initiateControlClose: async () => {},
  setIdentity: {
    buildSetId: 'build-1',
    hostFingerprint: 'f'.repeat(64),
    guardianInstanceId: 'g1',
    guardianPid: 1,
    guardianIncarnation: testIncarnation(1),
    guardianControlEndpoint: '/tmp/guardian.sock',
    proxyInstanceId: 'p1',
    proxyPid: 2,
    reaperInstanceId: 'r1',
    reaperPid: 3,
    reaperIncarnation: testIncarnation(1),
    reaperControlEndpoint: '/tmp/reaper.sock',
    containmentKind: 'detached',
    proxyIncarnation: testIncarnation(1),
    proxyProcessGroupId: 2,
    canonicalEndpoint: '/tmp/proxy.sock',
  },
};
const acceptHoldForTest = () => ({
  kind: 'accepted' as const,
  owner: 'durable-provider-proxy-acquisition-hold-store' as const,
});
const immediateRetryTime = { sleep: async () => undefined };
const PUBLICATION_RECEIPT = { kind: 'provider-proxy-set-published' } as PublicationReceipt;

type Recorded = { readonly log: string[]; readonly steps: ProviderProxyAcquisitionSteps };

/** Every step healthy unless a cut is named; the undo of each step appends to the same log. */
function steps(options: { failAt?: 'capsules' | 'spawn' | 'control'; failUndo?: string } = {}): Recorded {
  const log: string[] = [];
  const undo = (label: string): AcquisitionUndo => ({
    label,
    run: () => {
      if (options.failUndo === label) throw new Error(`${label} could not be removed`);
      log.push(`undo:${label}`);
    },
  });
  return {
    log,
    steps: {
      createCapsules: async () => {
        log.push('capsules');
        if (options.failAt === 'capsules') throw new Error('capsule path already exists');
        return undo('capsules');
      },
      spawnGuardian: async () => {
        log.push('spawn');
        if (options.failAt === 'spawn') throw new Error('guardian exited immediately');
        return undo('guardian');
      },
      establishControl: async () => {
        log.push('control');
        if (options.failAt === 'control') throw new Error('containment ACK never arrived');
        return {
          kind: 'established',
          set: SET as never,
          publicationReceipt: PUBLICATION_RECEIPT,
          undo: undo('control'),
        };
      },
    },
  };
}

const live = (): AbortSignal => new AbortController().signal;
const PUBLICATION_UNKNOWN_CAPSULE = { version: 3 } as HandoffCapsuleV3;

function publicationUnknownHandoff() {
  const client: ControlClient = {
    exchange: async () => {
      throw new Error('not used');
    },
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => undefined,
  };
  const session = createOwnedProviderProxyAcquisitionControlSession(
    providerProxyControlSessionOwner.controlEstablishment,
    {
      base: SET as never,
      setIdentity: SET.setIdentity,
      clients: { guardian: client, reaper: client, proxy: client },
      heartbeats: {
        guardian: { stop: () => undefined },
        reaper: { stop: () => undefined },
        proxy: { stop: () => undefined },
      },
      faults: createProviderProxyAuthorityFaultLatch(),
      guardianIdentity: {} as never,
      reaperIdentity: {} as never,
      proxyIdentity: {} as never,
      capsulePath: '/capsules/publication-unknown.handoff.v3.json',
      capsuleBinding: PUBLICATION_UNKNOWN_CAPSULE,
      mutationRpcTimeoutMs: 1,
    },
  );
  return handOverProviderProxyAcquisitionControlSession(session, providerProxyControlSessionOwner.acquisition, {
    kind: 'publication-unknown',
    role: 'guardian',
    reason: 'publication response was lost',
  });
}

describe('provider proxy set acquisition', () => {
  it('publishes the set only after every step has passed', async () => {
    const recorded = steps();

    const result = await acquireProviderProxySet({
      steps: recorded.steps,
      time: immediateRetryTime,
      acceptHold: acceptHoldForTest,
      deadlineSignal: live(),
    });

    expect(result).toEqual({ kind: 'acquired', set: SET, publicationReceipt: PUBLICATION_RECEIPT });
    expect(recorded.log).toEqual(['capsules', 'spawn', 'control']);
  });

  it.each([
    ['capsules' as const, 'capsule creation', []],
    ['spawn' as const, 'guardian spawn', ['undo:capsules']],
    ['control' as const, 'control establishment', ['undo:guardian', 'undo:capsules']],
  ])('unwinds exactly what the %s cut had created', async (failAt, cut, expectedUndo) => {
    const recorded = steps({ failAt });

    const result = await acquireProviderProxySet({
      steps: recorded.steps,
      time: immediateRetryTime,
      acceptHold: acceptHoldForTest,
      deadlineSignal: live(),
    });

    expect(result).toMatchObject({ kind: 'provider_proxy_acquisition_failed', cut, strandedArtifacts: [] });
    // Newest first: closing a control before removing the capsule that authorised it keeps the window in
    // which a stale capsule is redeemable as short as it can be.
    expect(recorded.log.filter((entry) => entry.startsWith('undo:'))).toEqual(expectedUndo);
  });

  it('keeps unwinding after a cleanup action fails, and names what it left behind', async () => {
    const recorded = steps({ failAt: 'control', failUndo: 'guardian' });
    const cleanupFailures: string[] = [];

    const result = await acquireProviderProxySet({
      steps: recorded.steps,
      time: immediateRetryTime,
      acceptHold: acceptHoldForTest,
      deadlineSignal: live(),
      onCleanupFailure: (label) => cleanupFailures.push(label),
    });

    // Abandoning the rest on the first cleanup error is how an abandoned set keeps its endpoint.
    expect(result).toMatchObject({ strandedArtifacts: ['guardian'] });
    expect(recorded.log).toContain('undo:capsules');
    expect(cleanupFailures).toEqual(['guardian']);
  });

  it('publishes a pre-identity guardian spawn hold with the acquisition-abandonment exit', async () => {
    const recorded = steps();
    const recoverySubject = { kind: 'spawned-process-group' as const, processGroupId: 101 };
    const recoveryCapability = {
      retry: vi.fn(async () => ({ kind: 'held' as const, reason: 'spawned_process_group_alive' })),
    };
    const operatorExit = {
      kind: 'abandon-provider-proxy-acquisition' as const,
      abandon: vi.fn(() => ({
        kind: 'operator-abandoned' as const,
        recoverySubject,
        processAbsenceProven: false as const,
        successor: { owner: 'operator-command' as const, acceptance: 'accepted' as const },
      })),
    };
    const acquisitionSteps: ProviderProxyAcquisitionSteps = {
      ...recorded.steps,
      spawnGuardian: async () => ({
        kind: 'provider_proxy_role_spawn_held',
        reason: 'guardian incarnation unavailable',
        setAddress: {
          buildSetId: SET.setIdentity.buildSetId,
          hostFingerprint: SET.setIdentity.hostFingerprint,
          proxyInstanceId: SET.setIdentity.proxyInstanceId,
        },
        recoverySubject,
        operatorExit,
        recoveryCapability,
      }),
    };
    const acceptHold = vi.fn(acceptHoldForTest);

    const result = await acquireProviderProxySet({
      steps: acquisitionSteps,
      time: immediateRetryTime,
      acceptHold,
      deadlineSignal: live(),
    });

    expect(result).toMatchObject({
      kind: 'provider_proxy_acquisition_held',
      cut: 'guardian spawn',
      recoverySubject,
      operatorExit: { kind: 'abandon-provider-proxy-acquisition' },
      recoveryCapability,
    });
    expect(acceptHold).toHaveBeenCalledWith(expect.objectContaining({ recoverySubject, recoveryCapability }));
    expect(recorded.log).toContain('undo:capsules');
  });

  it('retains recovery capability until a held guardian retry confirms absence', async () => {
    const log: string[] = [];
    let guardianAbsent = false;
    const guardianIdentity = {
      pid: 101,
      incarnation: testIncarnation(101),
      processGroupId: 101,
    };
    const acquisitionSteps: ProviderProxyAcquisitionSteps = {
      createCapsules: async () => ({
        label: 'capsules',
        run: () => {
          log.push('undo:capsules');
        },
      }),
      spawnGuardian: async () => ({
        kind: 'guardian-containment',
        label: 'guardian',
        setAddress: {
          buildSetId: SET.setIdentity.buildSetId,
          hostFingerprint: SET.setIdentity.hostFingerprint,
          proxyInstanceId: SET.setIdentity.proxyInstanceId,
        },
        guardianIdentity,
        captureRecoveryProof: () => {
          const subject = {
            guardianIdentity,
            reaper: { kind: 'possible-unidentified' as const },
            constructionContainmentSettled: false,
            proxy: { kind: 'possible-unidentified' as const },
          };
          return {
            subject,
            absenceEvidence: () =>
              ({
                recoverySubject: subject,
                disappearanceReceipt: providerProxyDisappearanceReceipt(guardianIdentity, []),
              }) as never,
          };
        },
        run: () => {
          log.push('undo:guardian');
          if (!guardianAbsent) throw new Error('guardian absence is unobservable');
        },
      }),
      establishControl: async (registerUndo) => {
        registerUndo({
          kind: 'recovery-capability',
          label: 'handoff capsule',
          run: () => {
            log.push('undo:handoff capsule');
          },
        });
        throw new Error('publication refused');
      },
    };

    const acceptHold = vi
      .fn()
      .mockReturnValueOnce({
        kind: 'held' as const,
        owner: 'provider-host-acquisition' as const,
        reason: 'durable store temporarily unavailable',
        waitingFor: 'store-repair' as const,
        exit: 'provider-proxy-set-operator-disposition-store-retry' as const,
      })
      .mockReturnValue({
        kind: 'accepted' as const,
        owner: 'durable-provider-proxy-acquisition-hold-store' as const,
      });
    const cleanupFailures: string[] = [];
    const retryDelay = vi.fn(async () => undefined);
    const result = await acquireProviderProxySet({
      steps: acquisitionSteps,
      time: { sleep: retryDelay },
      deadlineSignal: live(),
      acceptHold,
      onCleanupFailure: (label) => cleanupFailures.push(label),
    });

    expect(result).toMatchObject({
      kind: 'provider_proxy_acquisition_held',
      guardianIdentity,
      strandedArtifacts: ['guardian'],
    });
    expect(log).toEqual(['undo:guardian', 'undo:capsules']);
    expect(acceptHold).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledWith(1_000);
    expect(acceptHold).toHaveBeenCalledWith(
      expect.objectContaining({
        setAddress: providerProxySetAddress(SET.setIdentity),
        recoverySubject: expect.objectContaining({ proxy: { kind: 'possible-unidentified' } }),
      }),
    );
    expect(cleanupFailures).toContain('durable acquisition hold');
    if (result.kind !== 'provider_proxy_acquisition_held') throw new Error(`expected hold, received ${result.kind}`);
    if (!('guardianIdentity' in result)) throw new Error('expected an identity-bound guardian hold');
    guardianAbsent = true;
    await expect(result.recoveryCapability.retry(live())).resolves.toMatchObject({
      kind: 'absence-confirmed',
      evidence: {
        recoverySubject: result.recoverySubject,
        disappearanceReceipt: providerProxyDisappearanceReceipt(result.guardianIdentity, []),
      },
      strandedArtifacts: [],
    });
    expect(log).toEqual(['undo:guardian', 'undo:capsules', 'undo:guardian', 'undo:handoff capsule']);
  });

  it('hands over the live control-session owner without unwinding a publication-unknown set', async () => {
    const recorded = steps();
    recorded.steps.establishControl = async () => publicationUnknownHandoff();

    const result = await acquireProviderProxySet({
      steps: recorded.steps,
      time: immediateRetryTime,
      acceptHold: acceptHoldForTest,
      deadlineSignal: live(),
    });

    if (result.kind !== 'handed-over') throw new Error(`expected handoff, received ${result.kind}`);
    expect(result.incident).toEqual({
      kind: 'publication-unknown',
      role: 'guardian',
      reason: 'publication response was lost',
    });
    expect(providerProxyAcquisitionSessionDescriptor(result.session)).toEqual({
      setIdentity: SET.setIdentity,
      capsulePath: '/capsules/publication-unknown.handoff.v3.json',
      capsuleBinding: PUBLICATION_UNKNOWN_CAPSULE,
    });
    expect(recorded.log).toEqual(['capsules', 'spawn']);
    closeProviderProxyAcquisitionSession(result.session, 'test complete');
  });

  it('does not begin a step once the acquisition deadline has elapsed', async () => {
    const recorded = steps();

    const result = await acquireProviderProxySet({
      steps: recorded.steps,
      time: immediateRetryTime,
      acceptHold: acceptHoldForTest,
      deadlineSignal: AbortSignal.abort(),
    });

    expect(result).toMatchObject({ cut: 'capsule creation', reason: 'the acquisition deadline elapsed' });
    // Nothing was created, so there is nothing to unwind — and nothing was spawned that could outlive this.
    expect(recorded.log).toEqual([]);
  });

  it('does not let a hung cleanup action hold the acquisition open past its deadline', async () => {
    const recorded = steps({ failAt: 'control' });
    const originalSpawn = recorded.steps.spawnGuardian;
    recorded.steps.spawnGuardian = async () => {
      const undo = await originalSpawn();
      if (undo.kind === 'provider_proxy_role_spawn_held') {
        throw new Error('expected an identity-bound guardian undo');
      }
      // Simulates a control-close RPC that never returns — exactly what would otherwise hold the caller's
      // single-flight slot open forever.
      return { label: undo.label, run: () => new Promise<void>(() => {}) };
    };
    const cleanupFailures: string[] = [];

    const result = await acquireProviderProxySet({
      steps: recorded.steps,
      time: immediateRetryTime,
      acceptHold: acceptHoldForTest,
      deadlineSignal: AbortSignal.timeout(50),
      onCleanupFailure: (label) => cleanupFailures.push(label),
    });

    // The hung undo is reported as stranded instead of awaited forever; the attempt still resolves reporting
    // the original failure, and the capsules undo — which does not hang — still runs to completion.
    expect(result).toMatchObject({ kind: 'provider_proxy_acquisition_failed', cut: 'control establishment' });
    expect(cleanupFailures).toEqual(['guardian']);
    expect(recorded.log).toContain('undo:capsules');
  });

  it('keeps an already-published set when the deadline elapses after control establishment returns', async () => {
    const recorded = steps();
    const deadline = new AbortController();
    const original = recorded.steps.establishControl;
    const racing: ProviderProxyAcquisitionSteps = {
      ...recorded.steps,
      establishControl: async (registerUndo, assertPublicationMayBegin) => {
        const result = await original(registerUndo, assertPublicationMayBegin);
        deadline.abort();
        return result;
      },
    };

    const result = await acquireProviderProxySet({
      steps: racing,
      time: immediateRetryTime,
      acceptHold: acceptHoldForTest,
      deadlineSignal: deadline.signal,
    });

    expect(result).toEqual({ kind: 'acquired', set: SET, publicationReceipt: PUBLICATION_RECEIPT });
    expect(recorded.log.filter((entry) => entry.startsWith('undo:'))).toEqual([]);
  });

  it('refuses to begin publication after the acquisition deadline has elapsed', async () => {
    const recorded = steps();
    const deadline = new AbortController();
    recorded.steps.establishControl = async (registerUndo, assertPublicationMayBegin) => {
      registerUndo({
        label: 'control',
        run: () => {
          recorded.log.push('undo:control');
        },
      });
      deadline.abort();
      assertPublicationMayBegin();
      throw new Error('publication began after its gate');
    };

    const result = await acquireProviderProxySet({
      steps: recorded.steps,
      time: immediateRetryTime,
      acceptHold: acceptHoldForTest,
      deadlineSignal: deadline.signal,
    });

    expect(result).toMatchObject({
      kind: 'provider_proxy_acquisition_failed',
      cut: 'readiness publication',
      reason: 'the acquisition deadline elapsed before the set was published',
    });
    expect(recorded.log.filter((entry) => entry.startsWith('undo:'))).toEqual([
      'undo:control',
      'undo:guardian',
      'undo:capsules',
    ]);
  });
});
