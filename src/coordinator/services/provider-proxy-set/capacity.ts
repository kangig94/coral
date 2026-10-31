import type { Runtime } from '../../../runtime/ports.js';
import { getMaxWorkers, parsePositiveInt } from '../../live/worker-limits.js';

export const CORAL_MAX_PROVIDER_PROXY_SETS_ENV = 'CORAL_MAX_PROVIDER_PROXY_SETS';
export const CORAL_PROVIDER_PROXY_SET_IDLE_MS_ENV = 'CORAL_PROVIDER_PROXY_SET_IDLE_MS';

const MAX_PROVIDER_PROXY_SETS = 20;
// Node fires a timer longer than 2**31 - 1 ms after 1 ms instead, with TimeoutOverflowWarning (measured, node 26).
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
// A provider proxy role process measured about 105 MB resident (linux x64, node 26).
const DEFAULT_PROVIDER_PROXY_SET_IDLE_MS = 60_000;

export type ProviderProxySetIdleRetirement = Readonly<{ kind: 'after-idle'; ms: number }> | Readonly<{ kind: 'never' }>;

export type ProviderProxySetCapacity = Readonly<{
  maxSets: number;
  idleRetirement: ProviderProxySetIdleRetirement;
}>;

export function resolveProviderProxySetCapacity(env: Pick<Runtime['env'], 'get'>): ProviderProxySetCapacity {
  return {
    maxSets: Math.min(
      parsePositiveInt(env.get(CORAL_MAX_PROVIDER_PROXY_SETS_ENV), getMaxWorkers(env)),
      MAX_PROVIDER_PROXY_SETS,
    ),
    idleRetirement: {
      kind: 'after-idle',
      ms: Math.min(
        parsePositiveInt(env.get(CORAL_PROVIDER_PROXY_SET_IDLE_MS_ENV), DEFAULT_PROVIDER_PROXY_SET_IDLE_MS),
        MAX_TIMER_DELAY_MS,
      ),
    },
  };
}
