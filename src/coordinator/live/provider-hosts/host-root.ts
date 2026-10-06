import { localProviderHostRoot } from '../../../infra/bundle-manifest.js';

export type ProviderProxyPlacement = Readonly<{ hostRoot: string; entrypoint: string | null }>;

export function providerProxyPlacement(): ProviderProxyPlacement {
  return Object.freeze({ hostRoot: localProviderHostRoot(), entrypoint: null });
}
