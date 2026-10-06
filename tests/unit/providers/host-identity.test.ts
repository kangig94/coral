import { describe, expect, it } from 'vitest';
import { hostFingerprintFromSpec, hostKeyFromSpec } from '#src/providers/host-identity.js';
import type { ProviderServerSpec } from '#src/providers/contract.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const spec: ProviderServerSpec = {
  provider: 'codex',
  command: 'codex',
  args: ['app-server'],
  cwd: fixtureCanonicalWorkDir('/work'),
  leaseMode: 'shared',
  idleRetirement: 'unleased-and-host-idle',
  env: { Z: 'z', A: 'a' },
};

describe('stable provider host identity', () => {
  it('canonicalizes nested object keys while preserving executable arguments and values', () => {
    const reordered = { ...spec, env: { A: 'a', Z: 'z' } };
    expect(hostKeyFromSpec(spec)).toBe(hostKeyFromSpec(reordered));
    expect(hostFingerprintFromSpec(spec)).toBe(hostFingerprintFromSpec(reordered));
    expect(hostFingerprintFromSpec({ ...spec, env: { A: 'changed', Z: 'z' } })).not.toBe(hostFingerprintFromSpec(spec));
    expect(hostFingerprintFromSpec({ ...spec, args: ['different'] })).not.toBe(hostFingerprintFromSpec(spec));
  });
  it('keeps lease policy in the fingerprint and out of the executable key', () => {
    const exclusive: ProviderServerSpec = { ...spec, leaseMode: 'job-exclusive', idleRetirement: undefined };
    expect(hostKeyFromSpec(spec)).toBe(hostKeyFromSpec(exclusive));
    expect(hostFingerprintFromSpec(spec)).not.toBe(hostFingerprintFromSpec(exclusive));
  });
});
