import { describe, expect, it } from 'vitest';

import { socketPathForRunDir } from '#src/infra/path/coordinator.js';
import { providerProxyEndpoint, type ProviderProxyEndpointEnvironment } from '#src/infra/path/provider-proxy.js';
import {
  isRelocatedSocket,
  socketFallbackDir,
  socketFallbackUid,
  socketPathByteLimit,
} from '#src/infra/path/unix-socket.js';

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

describe('a relocated socket path fits AF_UNIX on every platform', () => {
  const HEADROOM_RATIO = 0.75;
  const WIDEST_UID = -Number.MAX_VALUE;
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

  it.each(PLATFORMS)('keeps a relocated coordinator socket under the %s limit, with margin', (platform) => {
    const relocated = socketPathForRunDir(DEEP_RUN_DIR, 'prod', { platform, uid: WIDEST_UID });

    expect(relocated.startsWith(`${socketFallbackDir(WIDEST_UID)}/`)).toBe(true);
    expect(Buffer.byteLength(relocated, 'utf8')).toBeLessThan(socketPathByteLimit(platform) * HEADROOM_RATIO);
  });

  it.each(PLATFORMS)('keeps a relocated provider endpoint under the %s limit, with margin', (platform) => {
    const uid = WIDEST_OWNER_UID;
    const relocated = providerProxyEndpoint(PROVIDER_IDENTITY, {
      baseDir: DEEP_RUN_DIR,
      platform,
      uid,
      storage: secureStorage(uid),
    });

    expect(relocated.startsWith(`${socketFallbackDir(uid)}/`)).toBe(true);
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
      const uid = WIDEST_OWNER_UID;
      const coordinator = socketPathForRunDir(coordinatorRunDirForCandidateLength(104), 'prod', { platform, uid });

      expect(coordinator.startsWith(`${socketFallbackDir(uid)}/`)).toBe(true);
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

      expect(provider.startsWith(`${socketFallbackDir(uid)}/`)).toBe(true);
    },
  );

  it('keeps 104-byte Linux candidates beside the run directory', () => {
    const uid = 4242;
    const coordinator = socketPathForRunDir(coordinatorRunDirForCandidateLength(104), 'prod', {
      platform: 'linux',
      uid,
    });
    const provider = providerProxyEndpoint(PROVIDER_IDENTITY, {
      baseDir: providerBaseDirForCandidateLength(104),
      platform: 'linux',
      uid,
      storage: secureStorage(uid),
    });

    expect(Buffer.byteLength(coordinator, 'utf8')).toBe(104);
    expect(Buffer.byteLength(provider, 'utf8')).toBe(104);
    expect(coordinator.startsWith(`${socketFallbackDir(uid)}/`)).toBe(false);
    expect(provider.startsWith(`${socketFallbackDir(uid)}/`)).toBe(false);
  });
});

describe('the relocated address is a fixed shape, not whatever the helper happens to build', () => {
  const UID = 4242;

  it('is the per-uid directory directly under the shared root', () => {
    expect(socketFallbackDir(UID)).toBe(`/tmp/coral-${UID}`);
  });

  it.each([
    ['the fallback itself', `/tmp/coral-${UID}`, true],
    ['another uid fallback', `/tmp/coral-${UID + 1}`, true],
    ['a sibling sharing its prefix', `/tmp/coral-${UID}-other`, false],
    ['a child of it', `/tmp/coral-${UID}/nested`, false],
    ['a non-canonical uid', `/tmp/coral-0${UID}`, false],
  ])('classifies %s as relocated=%s', (_label, directory, expected) => {
    expect(isRelocatedSocket(directory)).toBe(expected);
  });

  it.each([UID, Number.NaN, -1])('recovers the uid encoded by the fallback helper from %s', (uid) => {
    expect(Object.is(socketFallbackUid(socketFallbackDir(uid)), uid)).toBe(true);
  });
});
