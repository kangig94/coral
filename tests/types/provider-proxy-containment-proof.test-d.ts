import type { ProviderProxySetContainmentEvidence } from '#src/provider-proxy/containment-proof-contract.js';
import type {
  ProviderProxySetContainmentProof,
  ProviderProxySetContainmentProofAuthorization,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';

const observedEnforcerEvidence: ProviderProxySetContainmentEvidence = {
  kind: 'enforcers-observed',
  observations: [
    { role: 'guardian', observation: 'absent' },
    { role: 'reaper', observation: 'unknown' },
  ],
};
void observedEnforcerEvidence;

const contradictoryEvidence: ProviderProxySetContainmentEvidence = {
  kind: 'enforcers-observed',
  // @ts-expect-error all-absent enforcer evidence must carry exact targets for lifecycle-owned reaping.
  observations: [
    { role: 'guardian', observation: 'absent' },
    { role: 'reaper', observation: 'absent' },
  ],
};
void contradictoryEvidence;

// @ts-expect-error raw observations are not an identity-bound containment proof.
const rawEvidenceIsNotAProof: ProviderProxySetContainmentProof = observedEnforcerEvidence;
void rawEvidenceIsNotAProof;

// @ts-expect-error callers cannot construct a proof without the prover's opaque brand.
const emptyObjectIsNotAProof: ProviderProxySetContainmentProof = {};
void emptyObjectIsNotAProof;

// @ts-expect-error callers cannot mint exact-set proof authorization structurally.
const emptyObjectIsNotAuthorization: ProviderProxySetContainmentProofAuthorization = {};
void emptyObjectIsNotAuthorization;
