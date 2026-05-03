import type { FusionProfile } from './contract.js';

export const defaultFusionProfile: FusionProfile = Object.freeze({
  classWeights: new Map<string, number>([
    ['lexical', 1.0],
    ['semantic', 1.0],
    ['structural', 1.0],
  ]),
  overrides: new Map<string, number>([['graph', 0.22]]),
  rrfK: 60,
});
