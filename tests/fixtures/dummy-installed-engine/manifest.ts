import type { EngineManifest } from '#src/expansion/contract.js';

export const dummyInstalledDbManifest = {
  id: 'dummy-installed-db-engine',
  version: '0.0.0',
  specifier: '#tests/fixtures/dummy-installed-engine/expansion.js',
  tier: 'installed',
  description: 'DB-backed installed manifest fixture.',
} as const satisfies EngineManifest;

export default dummyInstalledDbManifest;
