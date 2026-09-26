import type { ProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/authority.js';
import type { ProviderProxySetRecoveryAuthority } from '#src/coordinator/live/provider-proxy/set-authority.js';

/** Every live set carries administration control, so a fixture may not omit it. This one refuses every call,
 *  so a test that reaches it fails by name instead of reading a fabricated inventory. */
export const unexercisedProviderHostControls: ProviderProxySetAuthority['providerHosts'] = Object.freeze({
  list: () => Promise.reject(new Error('provider-host administration was not exercised')),
  inspect: () => Promise.reject(new Error('provider-host administration was not exercised')),
  terminalEviction: () => Promise.reject(new Error('provider-host administration was not exercised')),
  evict: () => Promise.reject(new Error('provider-host administration was not exercised')),
});

/** A fake set that never takes part in a controller transfer; reaching either member is a test defect. */
export const unexercisedControllerSuccessionControls: Pick<
  ProviderProxySetRecoveryAuthority,
  'installRecoveryCredential' | 'authorizeControllerTransfer'
> = Object.freeze({
  installRecoveryCredential: () => Promise.reject(new Error('recovery credential install was not exercised')),
  authorizeControllerTransfer: () => Promise.reject(new Error('controller transfer was not exercised')),
});
