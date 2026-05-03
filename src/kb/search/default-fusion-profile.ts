import type { FusionProfile } from './contract.js';

function frozenMap<K, V>(entries: readonly (readonly [K, V])[]): ReadonlyMap<K, V> {
  const map = new Map(entries);
  const blockMutation = () => {
    throw new TypeError('defaultFusionProfile is frozen');
  };
  map.set = blockMutation as never;
  map.delete = blockMutation as never;
  map.clear = blockMutation as never;
  return Object.freeze(map);
}

export const defaultFusionProfile: FusionProfile = Object.freeze({
  classWeights: frozenMap<string, number>([
    ['lexical', 1.0],
    ['semantic', 1.0],
    ['structural', 1.0],
  ]),
  overrides: frozenMap<string, number>([['graph', 0.22]]),
  rrfK: 60,
});
