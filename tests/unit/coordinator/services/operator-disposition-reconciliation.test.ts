import { describe, expect, it, vi } from 'vitest';
import {
  authorizeProviderProxySetContainmentProof,
  createProviderProxySetContainmentProver,
  providerProxySetContainmentEvidenceFor,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import { reobserveDurableProviderProxySetDisposition } from '#src/coordinator/services/provider-proxy-set/operator-disposition-reconciliation.js';
import {
  durableProviderProxySetOperatorDispositionRecord,
  ProviderProxySetOperatorDispositionStore,
} from '#src/coordinator/services/provider-proxy-set/operator-disposition-store.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { providerOperationMutationAdmission } from '#src/store/provider-operation-journal.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

describe('operator disposition reobservation', () => {
  it.each(['alive'] as const)(
    'persists a released-compatible hold for an absent proxy with %s enforcers',
    async (enforcerObservation) => {
      const identity = providerProxySetIdentityFromRecord(providerOperationRecord('executing'));
      const db = newRawDatabase(':memory:');
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const runtime = createRealRuntime('prod');
      const prover = createProviderProxySetContainmentProver({
        ...runtime,
        process: {
          ...runtime.process,
          readProcessIncarnation: (pid) =>
            pid === identity.guardianPid
              ? identity.guardianIncarnation
              : pid === identity.reaperPid
                ? identity.reaperIncarnation
                : null,
          observeLiveness: (pid) => (pid === identity.proxyPid ? 'absent' : enforcerObservation),
        },
      });
      const store = new ProviderProxySetOperatorDispositionStore(
        new InMemoryStorage(new VirtualTime()),
        '/tmp/disposition-test',
      );
      const record = durableProviderProxySetOperatorDispositionRecord({
        writerIncarnation: 'old',
        setIdentity: identity,
        subjectKey: 'proxy',
        disposition: { disposition: 'held', incidentReason: 'control loss', waitingFor: 'control-reattachment' },
        status: { kind: 'stale', markedByIncarnation: 'new', markedAtMs: 1 },
      });
      expect(store.replace([record]).kind).toBe('recorded');
      try {
        const fence = providerOperationMutationAdmission(db).closeSet(identity);
        const proof = await prover.collectContainmentProof(
          authorizeProviderProxySetContainmentProof(identity, {
            mutationFence: fence,
            closeAdmission: async () => {},
          }),
          db,
          new AbortController().signal,
        );
        expect(providerProxySetContainmentEvidenceFor(proof, identity).kind).toBe('proxy-absent');
        const reobserveContainment = vi.fn();
        const observation = await reobserveDurableProviderProxySetDisposition({
          identity,
          signal: new AbortController().signal,
          collectProof: async () => proof,
          reobserveContainment,
        });
        expect(observation.kind).toBe('publish-hold');
        if (observation.kind !== 'publish-hold') throw new Error('Expected hold');
        expect(
          store.replace([
            {
              ...record,
              status: {
                kind: 'successor-observed',
                observedByIncarnation: 'new',
                observedAtMs: 2,
                evidence: observation.evidence,
              },
            },
          ]).kind,
        ).toBe('recorded');
        expect(store.read().records[0]?.status).toMatchObject({
          kind: 'successor-observed',
          evidence: { kind: 'enforcers-observed' },
        });
        expect(reobserveContainment).not.toHaveBeenCalled();
        expect(fence.isHeld()).toBe(false);
      } finally {
        db.close();
      }
    },
  );
});
