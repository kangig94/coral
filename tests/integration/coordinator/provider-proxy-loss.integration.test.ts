import { describe, expect, it, vi } from 'vitest';

import { ControlClientError } from '#src/provider-proxy/control-client.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { ProviderProxyRoleControlUnavailableError } from '#src/coordinator/live/provider-proxy/role-control.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import {
  authorizeProviderProxySetContainmentProof,
  createProviderProxySetContainmentProver,
  runProviderProxySetContainmentProofMutation,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';
import {
  insertProviderOperation,
  providerOperationMutationAdmission,
  readProviderOperations,
  subscribeProviderOperationMutations,
} from '#src/store/provider-operation-journal.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createProviderOperationReconcilerHarness } from '#tests/helpers/provider-operation-reconciler-harness.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { ProviderProxySetOperatorDispositionStore } from '#src/coordinator/services/provider-proxy-set/operator-disposition-store.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

describe('provider proxy loss recovery', () => {
  it('discharges both executing shared-root claims after guardian confirmation', async () => {
    const executing = providerOperationRecord('executing');
    const sibling = providerOperationRecord('executing', { job: 9 });
    const harness = createProviderOperationReconcilerHarness();
    const time = new VirtualTime();
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const unsubscribe = subscribeProviderOperationMutations(harness.db, (mutation) => claims.applyMutation(mutation));
    insertProviderOperation(harness.db, executing);
    insertProviderOperation(harness.db, sibling);
    const identity = providerProxySetIdentityFromRecord(executing);
    const base = createRealRuntime('prod');
    const runtime = {
      ...base,
      time,
      process: {
        ...base.process,
        readProcessIncarnation: (pid: number) =>
          pid === identity.guardianPid
            ? identity.guardianIncarnation
            : pid === identity.reaperPid
              ? identity.reaperIncarnation
              : testIncarnation('pid-reused'),
        observeLiveness: () => 'alive' as const,
        kill: () => {
          throw new Error('Live enforcers prohibit independent reaping');
        },
      },
    };
    const prover = createProviderProxySetContainmentProver(runtime);
    const collect = async (identity: ReturnType<typeof providerProxySetIdentityFromRecord>, signal: AbortSignal) => {
      const mutationFence = providerOperationMutationAdmission(harness.db).closeSet(identity);
      return prover.collectContainmentProof(
        authorizeProviderProxySetContainmentProof(identity, {
          mutationFence,
          closeAdmission: async () => {
            if (mutationFence.kind === 'holding') await mutationFence.retryAfter;
          },
        }),
        harness.db,
        signal,
      );
    };
    const faults = createProviderProxyAuthorityFaultLatch();
    let confirmed = false;
    const guardianCommit = vi.fn(async () =>
      confirmed
        ? { kind: 'containment-absent' as const, disappearanceReceipt: 'guardian-group-and-roots-absent' }
        : { kind: 'outcome-unknown' as const, error: 'guardian still observing roots' },
    );
    const guardianClose = vi.fn(async () => {});
    const guardianAuthority = {
      commitContainment: guardianCommit,
      stopHeartbeats: () => {},
      initiateControlClose: guardianClose,
      faulted: faults.faulted,
      onFault: faults.onFault,
      onIncident: faults.onIncident,
    };
    const redeem = vi.fn(async () => ({
      kind: 'refused' as const,
      refusal: {
        kind: 'downstream-role-unavailable' as const,
        error: new ProviderProxyRoleControlUnavailableError({
          kind: 'role-control-unavailable',
          role: 'proxy',
          stage: 'connect',
          method: null,
          origin: 'closed',
          controlCode: 'control_client_connect_failed',
        }),
        guardianAuthority,
      },
    }));
    const authority = {
      ...harness.authority,
      faulted: faults.faulted,
      onFault: faults.onFault,
      onIncident: faults.onIncident,
      redeemControl: redeem,
      commitContainment: async () => ({ kind: 'not-sent' as const, error: 'old guardian control epoch' }),
    };
    const dispatcher = createTestProviderProxyRecoveryDispatcher(
      {
        'containment-proof': ({ identity, signal }) => collect(identity, signal),
        'disappearance-consumer': ({ notice, mutationProof }) =>
          runProviderProxySetContainmentProofMutation(mutationProof!, notice.setIdentity, 'test-loss-delivery', () =>
            harness.reconciler.containmentDisappeared(notice),
          ),
      },
      (error) => harness.fatalErrors.push(error),
    );
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: executing.operation.buildSetId,
      claims,
      time,
      controlEstablished: () => {},
      recoveryDispatcher: dispatcher,
      reapRecordedContainment: async () => {
        throw new Error('No raw reaping');
      },
      reportLifecycle: () => {},
      operatorDispositionStore: new ProviderProxySetOperatorDispositionStore(new InMemoryStorage(time), '/coral/run'),
      writerIncarnation: 'loss-test',
      reobserveAcquisitionContainment: async () => ({
        kind: 'held',
        observation: 'unknown',
        reason: 'unobserved acquisition',
      }),
      collectOperatorDispositionContainmentProof: collect,
    });
    lifecycle.activateDurableOperatorDispositions();
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    lifecycle.registerInheritedSet(authority, { kind: 'provider-proxy-set-published' } as PublicationReceipt);
    try {
      faults.reportIncident({
        kind: 'control-channel-fault',
        role: 'proxy',
        cause: 'closed',
        error: new ControlClientError('control_client_closed', 'proxy gone', 'closed'),
      });
      await vi.waitFor(() => expect(guardianCommit).toHaveBeenCalled());
      expect(claims.size).toBe(2);
      expect(harness.appended).toEqual([]);
      expect(guardianClose).not.toHaveBeenCalled();
      confirmed = true;
      for (let index = 0; index < 60 && claims.size > 0; index++) {
        time.tick(1_000);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await vi.waitFor(() => expect(claims.size).toBe(0));
      expect(readProviderOperations(harness.db).records).toEqual([]);
      const terminals = harness.appended.filter(
        (event) => (event as { type: string }).type === 'job.terminal.recorded',
      );
      expect(terminals).toHaveLength(2);
      expect(terminals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stream: { kind: 'job', id: executing.operation.jobId },
            body: expect.objectContaining({
              terminal: expect.objectContaining({ outcome: expect.objectContaining({ kind: 'failed' }) }),
            }),
          }),
        ]),
      );
      expect(harness.appended).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'job.progress.emitted',
            body: expect.objectContaining({
              stage: 'provider_operation_failed',
              detail: expect.objectContaining({ code: 'provider_lost' }),
            }),
          }),
        ]),
      );
      expect(harness.fatalErrors).toEqual([]);
      expect(guardianClose).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      harness.db.close();
    }
  }, 5_000);
});
