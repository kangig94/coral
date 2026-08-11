import type { ProviderProxySetLifecycle } from './provider-proxy-set-lifecycle.js';

export class ProviderProxySetLifecycleRef {
  #lifecycle: ProviderProxySetLifecycle | null = null;

  connect(lifecycle: ProviderProxySetLifecycle): void {
    if (this.#lifecycle !== null && this.#lifecycle !== lifecycle) {
      throw new Error('provider_proxy_set_lifecycle_already_connected');
    }
    this.#lifecycle = lifecycle;
  }

  get(): ProviderProxySetLifecycle | null {
    return this.#lifecycle;
  }
}
