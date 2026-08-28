import type { ProviderProxySetContainmentEvidence } from '#src/provider-proxy/containment-proof-contract.js';

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
