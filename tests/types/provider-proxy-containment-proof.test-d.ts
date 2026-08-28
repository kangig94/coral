import type { ProviderProxySetContainmentProof } from '#src/provider-proxy/containment-proof-contract.js';

const observedEnforcerProof: ProviderProxySetContainmentProof = {
  kind: 'enforcers-observed',
  observations: [
    { role: 'guardian', observation: 'absent' },
    { role: 'reaper', observation: 'unknown' },
  ],
};
void observedEnforcerProof;

const contradictoryProof: ProviderProxySetContainmentProof = {
  kind: 'enforcers-observed',
  // @ts-expect-error all-absent evidence must continue through recorded-set reaping and return a receipt.
  observations: [
    { role: 'guardian', observation: 'absent' },
    { role: 'reaper', observation: 'absent' },
  ],
};
void contradictoryProof;
