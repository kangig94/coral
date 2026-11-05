import { expect, it, vi } from 'vitest';
import { attemptProviderProxySetInheritance } from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { readAddressedHandoffCapsule } from '#src/provider-proxy/handoff-capsule-discovery.js';
import {
  closeRedeemedProviderProxyControl,
  providerProxyControlRedemptionBundle,
  redeemProviderProxyControl,
} from '#src/coordinator/live/provider-proxy/control-redemption.js';
import { createProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/set-authority.js';
import { createProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { HandoffCapsuleV3 } from '#src/provider-proxy/handoff-capsule.js';

vi.mock('#src/provider-proxy/handoff-capsule-discovery.js', () => ({ readAddressedHandoffCapsule: vi.fn() }));
vi.mock('#src/coordinator/live/provider-proxy/control-redemption.js', async (original) => ({
  ...(await original<object>()),
  closeRedeemedProviderProxyControl: vi.fn(),
  redeemProviderProxyControl: vi.fn(),
  providerProxyControlRedemptionBundle: vi.fn(),
}));
vi.mock('#src/coordinator/live/provider-proxy/set-authority.js', () => ({ createProviderProxySetAuthority: vi.fn() }));
vi.mock('#src/coordinator/live/provider-proxy/operation-route.js', () => ({
  createProviderProxyOperationAuthority: vi.fn(),
}));

it('hands the superseded redemption to its channel and heartbeat disposer', async () => {
  const record = providerOperationRecord('executing');
  const identity = providerProxySetIdentityFromRecord(record);
  const capsule = {
    ...identity,
    version: 3,
    grantId: identity.buildSetId,
    secret: 'secret',
    orphanTimeoutMs: 60000,
    teardownReserveMs: 5000,
    generation: 'gen2',
    flavor: 'prod',
    proxyEndpoint: identity.canonicalEndpoint,
  } as HandoffCapsuleV3;
  vi.mocked(readAddressedHandoffCapsule).mockReturnValue({ path: '/unused.handoff.v3.json', capsule });
  vi.mocked(redeemProviderProxyControl).mockResolvedValue({ kind: 'redeemed' } as never);
  const clients = { guardian: { close: vi.fn() }, reaper: { close: vi.fn() }, proxy: { close: vi.fn() } };
  const heartbeats = { guardian: { stop: vi.fn() }, reaper: { stop: vi.fn() }, proxy: { stop: vi.fn() } };
  vi.mocked(providerProxyControlRedemptionBundle).mockReturnValue({
    setIdentity: identity,
    clients,
    heartbeats,
    guardianIdentity: {},
    reaperIdentity: {},
    proxyIdentity: {},
  } as never);
  vi.mocked(createProviderProxySetAuthority).mockReturnValue({
    installRecoveryCredential: async () => ({ kind: 'installed' }),
  } as never);
  const candidate = { setIdentity: identity };
  vi.mocked(createProviderProxyOperationAuthority).mockReturnValue(candidate as never);
  const register = vi.fn(() => ({ kind: 'superseded', owner: 'provider-proxy-set-lifecycle', identity }) as const);
  const db = newRawDatabase(':memory:');
  try {
    const outcome = await attemptProviderProxySetInheritance(
      record,
      db,
      {
        runtime: createRealRuntime('prod'),
        coordinatorIdentity: {
          instanceId: identity.buildSetId,
          buildSetId: identity.buildSetId,
          pid: 1,
          incarnation: identity.guardianIncarnation,
          generation: 'gen2',
          flavor: 'prod',
        },
        operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
        collectContainmentProof: async () => {
          throw new Error('unexpected containment');
        },
        reapRecordedContainment: async () => {
          throw new Error('unexpected reap');
        },
        registerInheritedSet: register,
      },
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      kind: 'temporarily-unavailable',
      incident: { kind: 'lifecycle-owned-pending', status: 'superseded' },
    });
    expect(register).toHaveBeenCalledOnce();
    expect(closeRedeemedProviderProxyControl).toHaveBeenCalledExactlyOnceWith(
      await vi.mocked(redeemProviderProxyControl).mock.results[0].value,
    );
  } finally {
    db.close();
  }
});
