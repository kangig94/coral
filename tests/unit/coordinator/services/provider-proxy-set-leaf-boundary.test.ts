import { expect, it, vi } from 'vitest';
import type { FailureDomainContainment } from '#src/infra/failure-domain.js';
import {
  authorizeProviderProxySetContainmentProof,
  createProviderProxySetContainmentProver,
  providerProxySetContainmentEvidenceFor,
  releaseProviderProxySetContainmentProofFence,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { createProviderProxySetRecordedContainmentReaper } from '#src/coordinator/services/provider-proxy-set/recorded-containment-reaper.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { providerOperationMutationAdmission } from '#src/store/provider-operation-journal.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const siblingInstanceId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function leaf(kind: 'populated' | 'absent' | 'missing') {
  return {
    observe: vi.fn<FailureDomainContainment['observe']>(() => ({ kind })),
    kill: vi.fn<FailureDomainContainment['kill']>(() => ({ kind: 'refused', errno: 'EACCES' })),
  } satisfies FailureDomainContainment;
}

it.each([
  { subject: 'populated', sibling: 'absent', expected: 'identity-unobservable', kills: 1 },
  { subject: 'absent', sibling: 'populated', expected: 'containment-absent', kills: 0 },
  { subject: 'missing', sibling: 'populated', expected: 'containment-absent', kills: 0 },
] as const)(
  'reaps the subject set when its leaf is $subject and the sibling leaf is $sibling',
  async ({ subject, sibling, expected, kills }) => {
    const runtime = new SimulationRuntime();
    vi.spyOn(runtime.env, 'platform').mockReturnValue('linux');
    const identity = providerProxySetIdentityFromRecord(providerOperationRecord('prepare-pending'));
    expect(identity.proxyInstanceId).not.toBe(siblingInstanceId);
    const subjectAddress = `set-${identity.proxyInstanceId}/containment`;
    const siblingAddress = `set-${siblingInstanceId}/containment`;
    const subjectLeaf = leaf(subject);
    const siblingLeaf = leaf(sibling);
    const lookup = vi.spyOn(runtime.process, 'failureDomainContainment').mockImplementation((address) => {
      if (address === subjectAddress) return subjectLeaf;
      if (address === siblingAddress) return siblingLeaf;
      throw new Error(`Unexpected set leaf: ${address}`);
    });
    for (const pid of [identity.proxyPid, identity.guardianPid, identity.reaperPid, -identity.proxyProcessGroupId])
      expect(runtime.process.observeLiveness(pid)).toBe('absent');
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const fence = providerOperationMutationAdmission(db).closeSet(identity);
    const signal = new AbortController().signal;
    const proof = await createProviderProxySetContainmentProver(runtime).collectContainmentProof(
      authorizeProviderProxySetContainmentProof(identity, {
        mutationFence: fence,
        closeAdmission: async () => {},
      }),
      db,
      signal,
    );
    try {
      expect(providerProxySetContainmentEvidenceFor(proof, identity).kind).toBe('reap-required');
      const outcome = await createProviderProxySetRecordedContainmentReaper(runtime)(identity, proof, signal, () => {});
      expect(outcome.kind).toBe(expected);
      expect(lookup).toHaveBeenCalledWith(subjectAddress);
      expect(subjectLeaf.observe).toHaveBeenCalled();
      expect(subjectLeaf.kill).toHaveBeenCalledTimes(kills);
      expect(siblingLeaf.observe).not.toHaveBeenCalled();
      expect(siblingLeaf.kill).not.toHaveBeenCalled();
    } finally {
      releaseProviderProxySetContainmentProofFence(proof);
      db.close();
    }
  },
);
