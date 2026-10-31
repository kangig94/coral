import { describe, expect, it } from 'vitest';

import { resolveProviderProxySetCapacity } from '#src/coordinator/services/provider-proxy-set/capacity.js';

const MAX_SETS = 'CORAL_MAX_PROVIDER_PROXY_SETS';
const IDLE_MS = 'CORAL_PROVIDER_PROXY_SET_IDLE_MS';

function capacityFor(values: Readonly<Record<string, string>>) {
  return resolveProviderProxySetCapacity({ get: (name: string) => values[name] });
}

describe('provider proxy set capacity', () => {
  it('should default the set limit to the worker limit, not a fixed count', () => {
    expect(capacityFor({}).maxSets).toBe(10);
    expect(capacityFor({ CORAL_MAX_WORKERS: '7' }).maxSets).toBe(7);
    expect(capacityFor({ CORAL_MAX_WORKERS: '7', [MAX_SETS]: 'many' }).maxSets).toBe(7);
  });

  it('should honour an explicit set limit up to twenty', () => {
    expect(capacityFor({ [MAX_SETS]: '3' }).maxSets).toBe(3);
    expect(capacityFor({ [MAX_SETS]: '50' }).maxSets).toBe(20);
  });

  it('should keep an idle window a timer can actually wait for', () => {
    expect(capacityFor({}).idleRetirement).toEqual({ kind: 'after-idle', ms: 60_000 });
    expect(capacityFor({ [IDLE_MS]: '1500' }).idleRetirement).toEqual({ kind: 'after-idle', ms: 1_500 });
    expect(capacityFor({ [IDLE_MS]: '0' }).idleRetirement).toEqual({
      kind: 'after-idle',
      ms: 60_000,
    });
    expect(capacityFor({ [IDLE_MS]: '2592000000' }).idleRetirement).toEqual({
      kind: 'after-idle',
      ms: 2 ** 31 - 1,
    });
  });
});
