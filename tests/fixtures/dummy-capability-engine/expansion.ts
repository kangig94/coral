import type { Expansion } from '#src/expansion/contract.js';

import { DUMMY_CACHE_CAPABILITY } from './manifest.js';

const expansion: Expansion = (host) => {
  if (host.id === 'dummy-capability-provider') {
    host.bind(DUMMY_CACHE_CAPABILITY, {
      get(key: string): string {
        return `cache:${key}`;
      },
    });
    return;
  }

  if (host.id === 'dummy-capability-consumer') {
    const cache = host.require<{ get(key: string): string }>(DUMMY_CACHE_CAPABILITY);
    cache.get('probe');
  }
};

export default expansion;
