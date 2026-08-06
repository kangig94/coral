import { describe, expect, it } from 'vitest';

import { PROVIDER_ROLE_FLAGS, parseProviderRoleArgv } from '#src/provider-proxy/role-argv.js';

const CAPSULE_PATH = '/home/coral/.coral/gen2/run/provider-guardian.bootstrap.json';

describe('parseProviderRoleArgv', () => {
  it.each(Object.entries(PROVIDER_ROLE_FLAGS))(
    'parses %s into role %s with the following capsule path',
    (flag, role) => {
      expect(parseProviderRoleArgv(['node', 'coral-backend.cjs', flag, CAPSULE_PATH])).toEqual({
        role,
        capsulePath: CAPSULE_PATH,
      });
    },
  );

  it('yields none for argv naming no provider-role flag', () => {
    expect(parseProviderRoleArgv(['node', 'coral-backend.cjs'])).toEqual({ role: 'none' });
    expect(parseProviderRoleArgv(['node', 'coral-backend.cjs', '--smoke-open-store', '--path', '/tmp/x'])).toEqual({
      role: 'none',
    });
  });

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

  it('refuses a role flag with no following capsule path', () => {
    expect(() => parseProviderRoleArgv(['node', 'coral-backend.cjs', '--provider-guardian'])).toThrow(
      /did not name a capsule path/u,
    );
  });

  it('refuses a relative capsule path', () => {
    expect(() =>
      parseProviderRoleArgv(['node', 'coral-backend.cjs', '--provider-proxy', 'relative/capsule.json']),
    ).toThrow(/non-canonical capsule path/u);
  });

  it('refuses a non-canonical absolute capsule path', () => {
    expect(() =>
      parseProviderRoleArgv(['node', 'coral-backend.cjs', '--provider-reaper', '/home/coral/../coral/capsule.json']),
    ).toThrow(/non-canonical capsule path/u);
  });

  it('refuses a capsule path containing a NUL byte', () => {
    expect(() =>
      parseProviderRoleArgv(['node', 'coral-backend.cjs', '--provider-proxy', `/home/coral/capsule\0.json`]),
    ).toThrow(/non-canonical capsule path/u);
  });
});
