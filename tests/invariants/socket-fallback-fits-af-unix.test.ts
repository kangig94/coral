import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';

import { socketPathForRunDir } from '#src/infra/path/coordinator.js';
import { providerProxyEndpoint, type ProviderProxyEndpointEnvironment } from '#src/infra/path/provider-proxy.js';
import { generationRoot } from '#src/infra/path/root.js';
import { isRelocatedSocket, socketFallbackDir, socketPathByteLimit } from '#src/infra/path/unix-socket.js';

const PLATFORM_LIMITS = {
  aix: 104,
  android: 104,
  cygwin: 104,
  darwin: 104,
  freebsd: 104,
  haiku: 104,
  linux: 108,
  netbsd: 104,
  openbsd: 104,
  sunos: 104,
  win32: 104,
} as const satisfies Record<NodeJS.Platform, number>;

const PLATFORMS = Object.keys(PLATFORM_LIMITS) as NodeJS.Platform[];
const DEEP_RUN_DIR = `/${'r'.repeat(200)}`;
const PROVIDER_IDENTITY = {
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: '33333333-3333-4333-8333-333333333333',
  hostFingerprint: 'a'.repeat(64),
  proxyInstanceId: '11111111-1111-4111-8111-111111111111',
};

function pathOfLength(length: number): string {
  return `/${'r'.repeat(length - 1)}`;
}

function coordinatorRunDirForCandidateLength(length: number): string {
  return pathOfLength(length - Buffer.byteLength('/coordinator.sock', 'utf8'));
}

function providerBaseDirForCandidateLength(length: number): string {
  const suffix = `/gen2/run/provider-${'0'.repeat(24)}.sock`;
  return pathOfLength(length - Buffer.byteLength(suffix, 'utf8'));
}

describe('relocated socket paths stay within the configured conservative byte ceilings', () => {
  const HEADROOM_RATIO = 0.75;
  // The widest uid the assertion will accept as an owner: `uid_t` is 32 bits, so no address it agrees to
  // check can encode a longer one.
  const WIDEST_OWNER_UID = 0xffff_fffe;

  function privateDirectory(uid: number) {
    return {
      dev: 1n,
      ino: 1n,
      mode: 0o40700n,
      uid: BigInt(uid),
      size: 0n,
      mtimeNs: 0n,
      isDirectory: () => true,
      isFile: () => false,
    };
  }

  function secureStorage(uid: number): ProviderProxyEndpointEnvironment['storage'] {
    return {
      mkdirSync: () => undefined,
      chmodSync: () => undefined,
      lstatSync: () => privateDirectory(uid),
      statSync: () => privateDirectory(uid),
    };
  }

  it.each(PLATFORMS)('keeps a relocated coordinator socket below 75% of the ceiling on %s', (platform) => {
    const relocated = socketPathForRunDir(DEEP_RUN_DIR, 'prod', { platform });

    expect(relocated.startsWith(`${socketFallbackDir(dirname(DEEP_RUN_DIR))}/`)).toBe(true);
    expect(Buffer.byteLength(relocated, 'utf8')).toBeLessThan(socketPathByteLimit(platform) * HEADROOM_RATIO);
  });

  it.each(PLATFORMS)('keeps a relocated provider endpoint below 75% of the ceiling on %s', (platform) => {
    const uid = WIDEST_OWNER_UID;
    const relocated = providerProxyEndpoint(PROVIDER_IDENTITY, {
      baseDir: DEEP_RUN_DIR,
      platform,
      uid,
      storage: secureStorage(uid),
    });

    expect(relocated.startsWith(`${socketFallbackDir(generationRoot({ baseDir: DEEP_RUN_DIR }))}/`)).toBe(true);
    expect(Buffer.byteLength(relocated, 'utf8')).toBeLessThan(socketPathByteLimit(platform) * HEADROOM_RATIO);
  });

  it.each(Object.entries(PLATFORM_LIMITS))('uses the conservative AF_UNIX ceiling on %s', (platform, limit) => {
    expect(socketPathByteLimit(platform)).toBe(limit);
  });

  it('uses the conservative ceiling for an unrecognised platform', () => {
    expect(socketPathByteLimit('future-platform')).toBe(104);
  });

  it.each(['darwin', 'freebsd', 'openbsd', 'future-platform'])(
    'relocates a 104-byte coordinator candidate on %s',
    (platform) => {
      const runDir = coordinatorRunDirForCandidateLength(104);
      const coordinator = socketPathForRunDir(runDir, 'prod', { platform });

      expect(coordinator.startsWith(`${socketFallbackDir(dirname(runDir))}/`)).toBe(true);
    },
  );

  it.each(['darwin', 'freebsd', 'openbsd', 'future-platform'])(
    'relocates a 104-byte provider candidate on %s',
    (platform) => {
      const uid = WIDEST_OWNER_UID;
      const provider = providerProxyEndpoint(PROVIDER_IDENTITY, {
        baseDir: providerBaseDirForCandidateLength(104),
        platform,
        uid,
        storage: secureStorage(uid),
      });

      expect(
        provider.startsWith(
          `${socketFallbackDir(generationRoot({ baseDir: providerBaseDirForCandidateLength(104) }))}/`,
        ),
      ).toBe(true);
    },
  );

  it('keeps 104-byte Linux candidates beside the run directory', () => {
    const uid = 4242;
    const coordinator = socketPathForRunDir(coordinatorRunDirForCandidateLength(104), 'prod', {
      platform: 'linux',
    });
    const provider = providerProxyEndpoint(PROVIDER_IDENTITY, {
      baseDir: providerBaseDirForCandidateLength(104),
      platform: 'linux',
      uid,
      storage: secureStorage(uid),
    });

    expect(Buffer.byteLength(coordinator, 'utf8')).toBe(104);
    expect(Buffer.byteLength(provider, 'utf8')).toBe(104);
    expect(isRelocatedSocket(dirname(coordinator))).toBe(false);
    expect(isRelocatedSocket(dirname(provider))).toBe(false);
  });
});

describe('the relocated address is a fixed shape, not whatever the helper happens to build', () => {
  const STATE_ROOT = '/home/user/.coral/gen2';

  it('is the installation directory directly under the shared root', () => {
    expect(socketFallbackDir(STATE_ROOT)).toMatch(/^\/tmp\/coral-[0-9a-f]{16}$/u);
  });

  it.each([
    ['the fallback itself', socketFallbackDir(STATE_ROOT), true],
    ['another installation fallback', socketFallbackDir('/srv/coral/gen2'), true],
    ['a sibling sharing its prefix', `${socketFallbackDir(STATE_ROOT)}-other`, false],
    ['a child of it', `${socketFallbackDir(STATE_ROOT)}/nested`, false],
    ['a non-canonical hash', '/tmp/coral-abc', false],
  ])('classifies %s as relocated=%s', (_label, directory, expected) => {
    expect(isRelocatedSocket(directory)).toBe(expected);
  });
});
