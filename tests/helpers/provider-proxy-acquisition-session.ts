import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { vi } from 'vitest';

import {
  createOwnedProviderProxyAcquisitionControlSession,
  type OwnedProviderProxyAcquisitionControlSession,
  type ProviderProxyControlSessionOwner,
} from '#src/coordinator/live/provider-proxy/control-session.js';
import type { ProviderProxySetRecoveryAuthority } from '#src/coordinator/live/provider-proxy/set-authority.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { providerProxySetIdentityFromCapsule } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { ControlClientError, controlExchangeForTest, type ControlClient } from '#src/provider-proxy/control-client.js';
import { handoffCapsuleV3Schema, type HandoffCapsuleV3 } from '#src/provider-proxy/handoff-capsule.js';
import { guardianIdentitySchema, proxyIdentitySchema, reaperIdentitySchema } from '#src/provider-proxy/protocol.js';

function publicationUnknownCapsule(): HandoffCapsuleV3 {
  return {
    version: 3,
    grantId: '00000000-0000-4000-8000-000000000001',
    secret: 'c'.repeat(64),
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: '00000000-0000-4000-8000-000000000002',
    hostFingerprint: 'a'.repeat(64),
    guardianInstanceId: '00000000-0000-4000-8000-000000000003',
    reaperInstanceId: '00000000-0000-4000-8000-000000000004',
    proxyInstanceId: '00000000-0000-4000-8000-000000000005',
    guardianControlEndpoint: '/tmp/publication-unknown-guardian.sock',
    reaperControlEndpoint: '/tmp/publication-unknown-reaper.sock',
    proxyEndpoint: '/tmp/publication-unknown-proxy.sock',
    orphanTimeoutMs: 30_000,
    teardownReserveMs: 14_000,
    guardianPid: 101,
    guardianIncarnation: testIncarnation(101),
    proxyPid: 202,
    reaperPid: 303,
    reaperIncarnation: testIncarnation(303),
    containmentKind: 'posix-group',
    proxyIncarnation: testIncarnation(202),
    proxyProcessGroupId: 202,
  };
}

function recoveryAuthority(capsule: HandoffCapsuleV3): ProviderProxySetRecoveryAuthority {
  const authority: ProviderProxySetRecoveryAuthority = {
    proxyInstanceId: capsule.proxyInstanceId,
    stopAndReap: async () => ({ disappearanceReceipt: 'publication-unknown-fixture-absent' }),
    commitContainment: async () => ({
      kind: 'containment-absent',
      disappearanceReceipt: 'publication-unknown-fixture-absent',
    }),
    stopHeartbeats: () => undefined,
    initiateControlClose: async () => undefined,
    autonomousDeadline: {
      orphanTimeoutMs: capsule.orphanTimeoutMs,
      adoptionWindowMs: Number.MAX_SAFE_INTEGER,
      heartbeatHoldBound: {
        spanMs: Number.MAX_SAFE_INTEGER,
        materialSchedulerLatenessMs: Math.floor(Number.MAX_SAFE_INTEGER / 4),
      },
    },
    controlReattachment: {
      redeem: () => new Promise<never>(() => undefined),
      promote: async () => authority,
    },
    installRecoveryCredential: async () => ({ kind: 'cancelled' }),
    registerSuccessionOperation: async () => ({ kind: 'registered' }),
  };
  return authority;
}

function publicationUnknownExchange() {
  return controlExchangeForTest({
    kind: 'no-response',
    cause: 'timeout',
    error: new ControlClientError('control_call_failed', 'publication response was lost', 'timeout'),
  });
}

function controlClient(exchange: ControlClient['exchange'], close: ControlClient['close']): ControlClient {
  return {
    exchange,
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close,
  };
}

export function createPublicationUnknownAcquisitionSessionFixture<Owner extends ProviderProxyControlSessionOwner>(
  owner: Owner,
  capsule: HandoffCapsuleV3 = publicationUnknownCapsule(),
): Readonly<{
  session: OwnedProviderProxyAcquisitionControlSession<Owner>;
  capsuleBinding: HandoffCapsuleV3;
  setIdentity: ReturnType<typeof providerProxySetIdentityFromCapsule>;
  guardianIdentity: ReturnType<typeof guardianIdentitySchema.parse>;
  reaperIdentity: ReturnType<typeof reaperIdentitySchema.parse>;
  proxyIdentity: ReturnType<typeof proxyIdentitySchema.parse>;
  guardianExchange: ReturnType<typeof vi.fn<ControlClient['exchange']>>;
  proxyExchange: ReturnType<typeof vi.fn<ControlClient['exchange']>>;
  faults: ReturnType<typeof createProviderProxyAuthorityFaultLatch>;
  close: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}> {
  const capsuleBinding = handoffCapsuleV3Schema.parse(capsule);
  const setIdentity = providerProxySetIdentityFromCapsule(capsuleBinding);
  const guardianIdentity = guardianIdentitySchema.parse({
    guardianInstanceId: capsuleBinding.guardianInstanceId,
    pid: capsuleBinding.guardianPid,
    incarnation: capsuleBinding.guardianIncarnation,
    generation: capsuleBinding.generation,
    flavor: capsuleBinding.flavor,
    buildSetId: capsuleBinding.buildSetId,
    hostFingerprint: capsuleBinding.hostFingerprint,
    canonicalControlEndpoint: capsuleBinding.guardianControlEndpoint,
  });
  const reaperIdentity = reaperIdentitySchema.parse({
    reaperInstanceId: capsuleBinding.reaperInstanceId,
    pid: capsuleBinding.reaperPid,
    incarnation: capsuleBinding.reaperIncarnation,
    guardianInstanceId: capsuleBinding.guardianInstanceId,
    generation: capsuleBinding.generation,
    flavor: capsuleBinding.flavor,
    buildSetId: capsuleBinding.buildSetId,
    hostFingerprint: capsuleBinding.hostFingerprint,
    canonicalControlEndpoint: capsuleBinding.reaperControlEndpoint,
    containmentKind: capsuleBinding.containmentKind,
  });
  const proxyIdentity = proxyIdentitySchema.parse({
    proxyInstanceId: capsuleBinding.proxyInstanceId,
    pid: capsuleBinding.proxyPid,
    incarnation: capsuleBinding.proxyIncarnation,
    processGroupId: capsuleBinding.proxyProcessGroupId,
    guardianInstanceId: capsuleBinding.guardianInstanceId,
    reaperInstanceId: capsuleBinding.reaperInstanceId,
    generation: capsuleBinding.generation,
    flavor: capsuleBinding.flavor,
    buildSetId: capsuleBinding.buildSetId,
    hostFingerprint: capsuleBinding.hostFingerprint,
    canonicalEndpoint: capsuleBinding.proxyEndpoint,
  });
  const guardianExchange = vi.fn<ControlClient['exchange']>(async () => publicationUnknownExchange());
  const reaperExchange = vi.fn<ControlClient['exchange']>(async () => publicationUnknownExchange());
  const proxyExchange = vi.fn<ControlClient['exchange']>(async () => publicationUnknownExchange());
  const close = vi.fn();
  const stop = vi.fn();
  const faults = createProviderProxyAuthorityFaultLatch();
  const session = createOwnedProviderProxyAcquisitionControlSession(owner, {
    base: recoveryAuthority(capsuleBinding),
    setIdentity,
    clients: {
      guardian: controlClient(guardianExchange, close),
      reaper: controlClient(reaperExchange, close),
      proxy: controlClient(proxyExchange, close),
    },
    heartbeats: {
      guardian: { stop },
      reaper: { stop },
      proxy: { stop },
    },
    faults,
    guardianIdentity,
    reaperIdentity,
    proxyIdentity,
    capsulePath: '/capsules/publication-unknown.handoff.v3.json',
    capsuleBinding,
    mutationRpcTimeoutMs: 1,
  });
  return {
    session,
    capsuleBinding,
    setIdentity,
    guardianIdentity,
    reaperIdentity,
    proxyIdentity,
    guardianExchange,
    proxyExchange,
    faults,
    close,
    stop,
  };
}
