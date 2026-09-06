import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireProviderProxySet,
  type ProviderProxyAcquisitionSteps,
} from '#src/coordinator/live/provider-proxy/index.js';
import {
  closeProviderProxyAcquisitionSession,
  createOwnedProviderProxyAcquisitionControlSession,
  handOverProviderProxyAcquisitionControlSession,
  providerProxyAcquisitionSessionDescriptor,
  providerProxyControlSessionOwner,
} from '#src/coordinator/live/provider-proxy/control-session.js';
import {
  createProviderProxySetAuthority,
  type ProviderProxySetAuthorityDependencies,
} from '#src/coordinator/live/provider-proxy/set-authority.js';
import { controlExchangeForTest, type ControlClient } from '#src/provider-proxy/control-client.js';
import { providerProxyDisappearanceReceipt } from '#src/provider-proxy/protocol.js';
import { handoffCapsuleV3Schema } from '#src/provider-proxy/handoff-capsule.js';
import type {
  CoordinatorIdentity,
  GuardianIdentity,
  ProxyIdentity,
  ReaperIdentity,
} from '#src/provider-proxy/protocol.js';

const immediateRetryTime = { sleep: async () => undefined };
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { providerProxySetIdentityFromCapsule } from '#src/coordinator/services/provider-proxy-set/identity.js';

const GUARDIAN: GuardianIdentity = {
  guardianInstanceId: '11111111-1111-4111-8111-111111111111',
  pid: 101,
  incarnation: testIncarnation(101),
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: '44444444-4444-4444-8444-444444444444',
  hostFingerprint: 'a'.repeat(64),
  canonicalControlEndpoint: '/tmp/guardian.sock',
};

const REAPER: ReaperIdentity = {
  reaperInstanceId: '22222222-2222-4222-8222-222222222222',
  pid: 102,
  incarnation: testIncarnation(102),
  guardianInstanceId: GUARDIAN.guardianInstanceId,
  generation: GUARDIAN.generation,
  flavor: GUARDIAN.flavor,
  buildSetId: GUARDIAN.buildSetId,
  hostFingerprint: GUARDIAN.hostFingerprint,
  canonicalControlEndpoint: '/tmp/reaper.sock',
  containmentKind: 'detached-process-group',
};

const PROXY: ProxyIdentity = {
  proxyInstanceId: '33333333-3333-4333-8333-333333333333',
  pid: 103,
  incarnation: testIncarnation(103),
  processGroupId: 103,
  guardianInstanceId: GUARDIAN.guardianInstanceId,
  reaperInstanceId: REAPER.reaperInstanceId,
  generation: GUARDIAN.generation,
  flavor: GUARDIAN.flavor,
  buildSetId: GUARDIAN.buildSetId,
  hostFingerprint: GUARDIAN.hostFingerprint,
  canonicalEndpoint: '/tmp/proxy.sock',
};

const COORDINATOR: CoordinatorIdentity = {
  instanceId: '55555555-5555-4555-8555-555555555555',
  pid: 1,
  incarnation: testIncarnation(1),
  generation: GUARDIAN.generation,
  flavor: GUARDIAN.flavor,
  buildSetId: GUARDIAN.buildSetId,
};

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installedClient(): ControlClient {
  return {
    exchange: async (_method, params) =>
      controlExchangeForTest({
        kind: 'response',
        response: {
          kind: 'result',
          value: { state: 'installed-dormant', grantId: (params as { grantId: string }).grantId },
        },
      }),
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => undefined,
  };
}

function acquisitionSteps(
  outcome: 'refused' | 'unknown',
  cleanupFails = false,
  guardianCleanupHeld = false,
): Readonly<{ steps: ProviderProxyAcquisitionSteps; capsulePath: string; confirmGuardianAbsent(): void }> {
  const root = mkdtempSync(join(tmpdir(), 'coral-acquisition-capsule-'));
  tempRoots.push(root);
  const capsulePath = join(root, 'provider.handoff.v3.json');
  const realRuntime = createRealRuntime('prod', { baseDir: root });
  const runtime: Runtime = cleanupFails
    ? {
        ...realRuntime,
        storage: {
          ...realRuntime.storage,
          rmSync: (path, options) => {
            if (path === capsulePath) throw new Error('handoff capsule could not be removed');
            realRuntime.storage.rmSync(path, options);
          },
        },
      }
    : realRuntime;
  const client = installedClient();
  let guardianAbsent = !guardianCleanupHeld;

  const steps: ProviderProxyAcquisitionSteps = {
    createCapsules: async () => ({ label: 'capsules', run: () => undefined }),
    spawnGuardian: async () => ({
      kind: 'guardian-containment',
      label: 'guardian',
      setAddress: {
        buildSetId: GUARDIAN.buildSetId,
        hostFingerprint: GUARDIAN.hostFingerprint,
        proxyInstanceId: PROXY.proxyInstanceId,
      },
      guardianIdentity: { pid: GUARDIAN.pid, incarnation: GUARDIAN.incarnation, processGroupId: GUARDIAN.pid },
      captureRecoveryProof: () => {
        const subject = {
          guardianIdentity: { pid: GUARDIAN.pid, incarnation: GUARDIAN.incarnation, processGroupId: GUARDIAN.pid },
          reaper: { kind: 'possible-unidentified' as const },
          constructionContainmentSettled: false,
          proxy: { kind: 'possible-unidentified' as const },
        };
        return {
          subject,
          absenceEvidence: () =>
            ({
              recoverySubject: subject,
              disappearanceReceipt: providerProxyDisappearanceReceipt(subject.guardianIdentity, []),
            }) as never,
        };
      },
      run: () => {
        if (!guardianAbsent) throw new Error('guardian absence is unobservable');
      },
    }),
    establishControl: async (registerUndo) => {
      const deps: ProviderProxySetAuthorityDependencies = {
        proxyInstanceId: PROXY.proxyInstanceId,
        guardianClient: client,
        proxyClient: client,
        reaperClient: client,
        guardianIdentity: GUARDIAN,
        reaperIdentity: REAPER,
        proxyIdentityFields: PROXY,
        heartbeats: {
          proxy: { stop: () => undefined },
          guardian: { stop: () => undefined },
          reaper: { stop: () => undefined },
        },
        coordinatorIdentity: COORDINATOR,
        handoffCapsulePath: capsulePath,
        runtime,
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        registerAcquisitionUndo: registerUndo,
      };
      const authority = createProviderProxySetAuthority(deps);
      const installation = await authority.installRecoveryCredential(new AbortController().signal);
      if (installation.kind !== 'installed') throw new Error(`unexpected installation outcome: ${installation.kind}`);
      const capsule = handoffCapsuleV3Schema.parse(JSON.parse(readFileSync(capsulePath, 'utf8')));
      const session = createOwnedProviderProxyAcquisitionControlSession(
        providerProxyControlSessionOwner.controlEstablishment,
        {
          base: authority,
          setIdentity: providerProxySetIdentityFromCapsule(capsule),
          clients: { guardian: client, reaper: client, proxy: client },
          heartbeats: deps.heartbeats,
          faults: createProviderProxyAuthorityFaultLatch(),
          guardianIdentity: GUARDIAN,
          reaperIdentity: REAPER,
          proxyIdentity: PROXY,
          capsulePath,
          capsuleBinding: capsule,
          mutationRpcTimeoutMs: 1,
        },
      );
      if (outcome === 'refused') {
        return closeProviderProxyAcquisitionSession(
          session,
          'provider_proxy_acquisition_publication_refused:guardian:request was not dispatched',
        );
      }
      return handOverProviderProxyAcquisitionControlSession(session, providerProxyControlSessionOwner.acquisition, {
        kind: 'publication-unknown',
        role: 'guardian',
        reason: 'publication response was lost',
      });
    },
  };
  return {
    steps,
    capsulePath,
    confirmGuardianAbsent: () => {
      guardianAbsent = true;
    },
  };
}

const live = (): AbortSignal => new AbortController().signal;
const acceptHoldForTest = () => ({
  kind: 'accepted' as const,
  owner: 'durable-provider-proxy-acquisition-hold-store' as const,
});

describe('fresh acquisition handoff capsule unwind', () => {
  it('removes the capsule after a proven publication refusal', async () => {
    const acquisition = acquisitionSteps('refused');

    const result = await acquireProviderProxySet({
      steps: acquisition.steps,
      time: immediateRetryTime,
      deadlineSignal: live(),
      acceptHold: () => ({ kind: 'accepted', owner: 'durable-provider-proxy-acquisition-hold-store' }),
    });

    expect(result).toMatchObject({
      kind: 'provider_proxy_acquisition_failed',
      cut: 'control establishment',
      strandedArtifacts: [],
    });
    expect(() => statSync(acquisition.capsulePath)).toThrow();
  });

  it('retains the capsule when publication is unknown', async () => {
    const acquisition = acquisitionSteps('unknown');

    const result = await acquireProviderProxySet({
      steps: acquisition.steps,
      time: immediateRetryTime,
      acceptHold: acceptHoldForTest,
      deadlineSignal: live(),
    });

    if (result.kind !== 'handed-over') throw new Error(`expected handoff, received ${result.kind}`);
    expect(providerProxyAcquisitionSessionDescriptor(result.session)).toMatchObject({
      capsulePath: acquisition.capsulePath,
    });
    expect(statSync(acquisition.capsulePath).isFile()).toBe(true);
    closeProviderProxyAcquisitionSession(result.session, 'test complete');
  });

  it('reports the capsule when its undo fails', async () => {
    const acquisition = acquisitionSteps('refused', true);

    const result = await acquireProviderProxySet({
      steps: acquisition.steps,
      time: immediateRetryTime,
      acceptHold: acceptHoldForTest,
      deadlineSignal: live(),
    });

    expect(result).toMatchObject({
      kind: 'provider_proxy_acquisition_failed',
      strandedArtifacts: ['handoff capsule'],
    });
    expect(statSync(acquisition.capsulePath).isFile()).toBe(true);
  });

  it('retains the capsule until held guardian cleanup later confirms absence', async () => {
    const acquisition = acquisitionSteps('refused', false, true);

    const result = await acquireProviderProxySet({
      steps: acquisition.steps,
      time: immediateRetryTime,
      deadlineSignal: live(),
      acceptHold: () => ({ kind: 'accepted', owner: 'durable-provider-proxy-acquisition-hold-store' }),
    });

    expect(result).toMatchObject({
      kind: 'provider_proxy_acquisition_held',
      strandedArtifacts: ['guardian'],
    });
    expect(statSync(acquisition.capsulePath).isFile()).toBe(true);
    if (result.kind !== 'provider_proxy_acquisition_held') throw new Error(`expected hold, received ${result.kind}`);
    acquisition.confirmGuardianAbsent();
    await expect(result.recoveryCapability.retry(live())).resolves.toMatchObject({
      kind: 'absence-confirmed',
      evidence: {
        recoverySubject: result.recoverySubject,
        disappearanceReceipt: providerProxyDisappearanceReceipt(result.guardianIdentity, []),
      },
      strandedArtifacts: [],
    });
    expect(() => statSync(acquisition.capsulePath)).toThrow();
  });
});
