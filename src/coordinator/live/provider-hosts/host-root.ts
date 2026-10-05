import { join } from 'node:path';
import { localProviderHostRoot } from '../../../infra/bundle-manifest.js';

/** One placement supplies both the spec root and the guardian entrypoint. */
export type ProviderProxyPlacement = Readonly<{ hostRoot: string; entrypoint: string | null }>;

export function providerProxyPlacement(retainedHostRoot: string | null): ProviderProxyPlacement {
  return Object.freeze(
    retainedHostRoot === null
      ? { hostRoot: localProviderHostRoot(), entrypoint: null }
      : {
          hostRoot: join(retainedHostRoot, 'bridge'),
          entrypoint: join(retainedHostRoot, 'bridge', 'coral-backend.cjs'),
        },
  );
}
