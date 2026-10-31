import { describe, expect, it } from 'vitest';

import {
  MAX_PROXY_LIVE_PROVIDER_ROOTS,
  PROVIDER_ROOT_ROTATION_THRESHOLD,
  providerRootAdmissionRefusal,
} from '#src/provider-proxy/provider-root-authority.js';

describe('provider root admission', () => {
  it('should count roots still spawning against the rotation budget', () => {
    const lastSlot = PROVIDER_ROOT_ROTATION_THRESHOLD - 1;

    expect(providerRootAdmissionRefusal({ spent: lastSlot, spawning: 0, live: 0 })).toBeNull();
    expect(providerRootAdmissionRefusal({ spent: lastSlot, spawning: 1, live: 0 })).toBe(
      'provider_root_generation_draining',
    );
  });

  it('should admit live roots up to the cap, counting spawning ones', () => {
    expect(providerRootAdmissionRefusal({ spent: 0, spawning: 1, live: MAX_PROXY_LIVE_PROVIDER_ROOTS - 2 })).toBeNull();
    expect(providerRootAdmissionRefusal({ spent: 0, spawning: 1, live: MAX_PROXY_LIVE_PROVIDER_ROOTS - 1 })).toBe(
      'provider_root_live_capacity',
    );
  });
});
