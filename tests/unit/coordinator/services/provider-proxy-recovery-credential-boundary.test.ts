import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { controlExchangeForTest, type ControlClient } from '#src/provider-proxy/control-client.js';
import { handoffCapsuleV3Schema } from '#src/provider-proxy/handoff-capsule.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import {
  createProviderProxySetInheritance,
  type CreateProviderProxySetInheritanceOptions,
} from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import {
  ProviderProxySetInheritanceCorruptionError,
  providerProxySetIdentityFromRecord,
} from '#src/coordinator/services/provider-proxy-set/identity.js';
import {
  closeRedeemedProviderProxyControl,
  providerProxyControlRedemptionBundle,
  redeemProviderProxyControl,
  type RedeemedProviderProxyControl,
} from '#src/coordinator/live/provider-proxy/control-redemption.js';
import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';
import { readAddressedHandoffCapsule } from '#src/provider-proxy/handoff-capsule-discovery.js';
import type { ProviderProxySetInheritanceAdmission } from '#src/coordinator/services/provider-proxy-set/index.js';
import { isProviderProxyRecoveryFatalError } from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

vi.mock('#src/provider-proxy/handoff-capsule-discovery.js', () => ({ readAddressedHandoffCapsule: vi.fn() }));
vi.mock('#src/coordinator/live/provider-proxy/control-redemption.js', async (original) => ({
  ...(await original<object>()),
  closeRedeemedProviderProxyControl: vi.fn(),
  redeemProviderProxyControl: vi.fn(),
  providerProxyControlRedemptionBundle: vi.fn(),
}));

it.each(['set-inheritance', 'capsule-redemption'] as const)(
  'keeps a wrong recovery-grant acknowledgement fatal through %s',
  async (producerId) => {
    const record = providerOperationRecord('executing');
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
    const path = '/coral/recovery.handoff.v3.json';
    const runtime = new SimulationRuntime();
    runtime.process.readProcessIncarnation = () => testIncarnation(9_000);
    const wrongGrantId = randomUUID();
    const exchange = vi.fn<ControlClient['exchange']>(async () =>
      controlExchangeForTest({
        kind: 'response',
        response: { kind: 'result', value: { state: 'installed-dormant', grantId: wrongGrantId } },
      }),
    );
    const client: ControlClient = {
      exchange,
      close: vi.fn(),
      faulted: new Promise(() => {}),
      onFault: () => () => {},
    };
    const shared = {
      generation: 'gen2' as const,
      flavor: 'prod' as const,
      buildSetId: identity.buildSetId,
      hostFingerprint: identity.hostFingerprint,
    };
    vi.mocked(redeemProviderProxyControl).mockResolvedValue({ kind: 'redeemed' } as RedeemedProviderProxyControl);
    vi.mocked(providerProxyControlRedemptionBundle).mockReturnValue({
      setIdentity: identity,
      clients: { guardian: client, reaper: client, proxy: client },
      heartbeats: { guardian: { stop: vi.fn() }, reaper: { stop: vi.fn() }, proxy: { stop: vi.fn() } },
      faults: createProviderProxyAuthorityFaultLatch(),
      guardianIdentity: {
        ...shared,
        guardianInstanceId: identity.guardianInstanceId,
        pid: identity.guardianPid,
        incarnation: identity.guardianIncarnation,
        canonicalControlEndpoint: identity.guardianControlEndpoint,
      },
      reaperIdentity: {
        ...shared,
        reaperInstanceId: identity.reaperInstanceId,
        guardianInstanceId: identity.guardianInstanceId,
        pid: identity.reaperPid,
        incarnation: identity.reaperIncarnation,
        containmentKind: identity.containmentKind,
        canonicalControlEndpoint: identity.reaperControlEndpoint,
      },
      proxyIdentity: {
        ...shared,
        proxyInstanceId: identity.proxyInstanceId,
        guardianInstanceId: identity.guardianInstanceId,
        reaperInstanceId: identity.reaperInstanceId,
        pid: identity.proxyPid,
        incarnation: identity.proxyIncarnation,
        processGroupId: identity.proxyProcessGroupId,
        canonicalEndpoint: identity.canonicalEndpoint,
      },
      recoveryOperations: [],
      publicationReceipt: { kind: 'provider-proxy-set-published' } as PublicationReceipt,
    });
    vi.mocked(readAddressedHandoffCapsule).mockReturnValue({ path, capsule });
    const options: CreateProviderProxySetInheritanceOptions = {
      runtime,
      identity: { instanceId: randomUUID(), flavor: 'prod', buildSetId: identity.buildSetId },
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
      containmentProver: {
        collectContainmentProof: async () => {
          throw new Error('Unexpected containment observation');
        },
      },
      reapRecordedContainment: async () => {
        throw new Error('Unexpected recorded reap');
      },
      acquisitionFor: () => ({
        kind: 'unowned',
        admission: {
          reserve: () => ({ kind: 'admitted', token: { identity } as ProviderProxySetInheritanceAdmission }),
        },
      }),
      releaseInheritanceAdmission: vi.fn(),
      registerInheritedSet: vi.fn(() => ({ kind: 'accepted', owner: 'provider-proxy-set-lifecycle' }) as const),
    };
    const inheritance = createProviderProxySetInheritance(options);
    const fatal = vi.fn();
    const retry = vi.fn();
    const dispatcher = createTestProviderProxyRecoveryDispatcher(
      {
        'set-inheritance': ({ locator, db, signal }) => inheritance.inheritProviderProxySet(locator, db, signal),
        'capsule-redemption': ({ capsule, capsulePath, signal }) =>
          inheritance.redeemDiscoveredCapsule(capsule, capsulePath, signal),
      },
      fatal,
    );
    const db = newRawDatabase(':memory:');
    const signal = new AbortController().signal;
    try {
      const turn = dispatcher.begin(
        producerId === 'set-inheritance' ? 'startup-set-inheritance' : 'exact-capsule-recovery',
        { setIdentity: identity, capsule },
        { evidence: vi.fn(), retry, fatal },
      );
      if (producerId === 'set-inheritance') {
        turn.start({ sourceId: 'inheritance', producerId, input: { locator: record, db, signal } });
      } else {
        turn.start({ sourceId: 'redemption', producerId, input: { capsule, capsulePath: path, signal } });
      }
      await vi.waitFor(() =>
        expect(exchange).toHaveBeenCalledWith(
          'guardian.handoff-install.v1',
          expect.objectContaining({ grantId: capsule.grantId }),
          expect.any(Number),
        ),
      );
      await vi.waitFor(() => expect(fatal).toHaveBeenCalled());
      const error = fatal.mock.calls[0]?.[0];
      expect(isProviderProxyRecoveryFatalError(error)).toBe(true);
      expect(error.cause).toBeInstanceOf(ProviderProxySetInheritanceCorruptionError);
      expect(error.cause).toMatchObject({ code: 'recovery_credential_identity_disagreement' });
      expect(retry).not.toHaveBeenCalled();
      expect(options.registerInheritedSet).not.toHaveBeenCalled();
      expect(closeRedeemedProviderProxyControl).toHaveBeenCalled();
    } finally {
      db.close();
    }
  },
);
