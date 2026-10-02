import type { ProviderHostAdministrationAuthority, ProviderHostManager } from '../live/provider-hosts/index.js';
import {
  ProviderHostAdministrationService,
  type ProviderHostAdministrationOwner,
} from '../services/provider-host-administration.js';
import type { createCoordinatorCoreContext } from './core-context.js';

export function createProviderHostOwners(core: ReturnType<typeof createCoordinatorCoreContext>) {
  const { world } = core;
  const localProviderHosts = world.providerHostManager as ProviderHostManager &
    Partial<ProviderHostAdministrationAuthority>;
  const holdsProviderHost = (
    record: ReturnType<ProviderHostAdministrationAuthority['listProviderHosts']>[number],
  ): boolean => record.status === 'live' || record.status === 'shutdown-held' || record.status === 'reclamation-failed';
  const localProviderHostOwner: ProviderHostAdministrationOwner = {
    ownerId: `coordinator:${world.identity.instanceId}`,
    listProviderHosts: () => {
      if (localProviderHosts.listProviderHosts === undefined) {
        throw new Error('provider_host_inventory_unavailable: local manager has no administration authority');
      }
      return localProviderHosts.listProviderHosts();
    },
    inspectProviderHost: (hostRef) => {
      if (localProviderHosts.inspectProviderHost === undefined) {
        throw new Error('provider_host_inventory_unavailable: local manager has no administration authority');
      }
      return localProviderHosts.inspectProviderHost(hostRef);
    },
    terminalEviction: (hostRef) => {
      if (localProviderHosts.terminalEviction === undefined) {
        throw new Error('provider_host_inventory_unavailable: local manager has no administration authority');
      }
      return localProviderHosts.terminalEviction(hostRef);
    },
    evictProviderHost: async (hostRef) => {
      if (localProviderHosts.evictHost === undefined) {
        throw new Error('provider_host_inventory_unavailable: local manager has no administration authority');
      }
      return localProviderHosts.evictHost(hostRef);
    },
  };
  const providerHostAdministration = new ProviderHostAdministrationService({
    owners: () => {
      const proxySets = world.providerProxyAuthority?.liveSets() ?? [];
      return [
        localProviderHostOwner,
        ...proxySets.map(
          (set): ProviderHostAdministrationOwner => ({
            ownerId: `provider-proxy:${set.proxyInstanceId}`,
            listProviderHosts: () => set.providerHosts.list(),
            inspectProviderHost: (hostRef) => set.providerHosts.inspect(hostRef),
            terminalEviction: (hostRef) => set.providerHosts.terminalEviction(hostRef),
            evictProviderHost: (hostRef) => set.providerHosts.evict(hostRef),
          }),
        ),
      ];
    },
  });

  return { localProviderHosts, holdsProviderHost, providerHostAdministration };
}
