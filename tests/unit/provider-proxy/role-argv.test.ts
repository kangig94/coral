import { describe, expect, it } from 'vitest';

import { parseProviderRoleArgv } from '#src/provider-proxy/role-argv.js';

const CAPSULE_PATH = '/home/coral/.coral/gen2/run/provider-guardian.bootstrap.json';

describe('parseProviderRoleArgv', () => {
  it('refuses argv naming two role flags', () => {
    expect(() =>
      parseProviderRoleArgv([
        'node',
        'coral-backend.cjs',
        '--provider-guardian',
        CAPSULE_PATH,
        '--provider-reaper',
        CAPSULE_PATH,
      ]),
    ).toThrow(/more than one mode/u);
  });

  it('refuses a repeated identical flag rather than silently claiming the first capsule and stranding the second', () => {
    const secondCapsulePath = '/home/coral/.coral/gen2/run/provider-proxy-b.bootstrap.json';
    expect(() =>
      parseProviderRoleArgv([
        'node',
        'coral-backend.cjs',
        '--provider-proxy',
        CAPSULE_PATH,
        '--provider-proxy',
        secondCapsulePath,
      ]),
    ).toThrow(/more than once/u);
  });

  it('refuses a relative capsule path', () => {
    expect(() =>
      parseProviderRoleArgv(['node', 'coral-backend.cjs', '--provider-proxy', 'relative/capsule.json']),
    ).toThrow(/non-canonical capsule path/u);
  });
});
