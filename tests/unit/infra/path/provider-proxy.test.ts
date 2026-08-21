import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { socketFallbackDir } from '#src/infra/path/unix-socket.js';
import {
  providerGuardianBootstrapCapsulePath,
  providerGuardianEndpoint,
  providerProxyBootstrapCapsulePath,
  providerProxyEndpoint,
  providerReaperBootstrapCapsulePath,
  providerReaperEndpoint,
  type ProviderProxyEndpointEnvironment,
  type ProviderProxyEndpointIdentity,
} from '#src/infra/path/provider-proxy.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const BUILD_SET_ID = '33333333-3333-4333-8333-333333333333';
const HOST_FINGERPRINT = 'a'.repeat(64);
const CURRENT_UID = process.getuid?.() ?? Number(statSync(tmpdir(), { bigint: true }).uid);

const identity: ProviderProxyEndpointIdentity = {
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: BUILD_SET_ID,
  hostFingerprint: HOST_FINGERPRINT,
  proxyInstanceId: UUID_A,
};

function secureStorage(mode = 0o40700n): ProviderProxyEndpointEnvironment['storage'] {
  return {
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    lstatSync: () => ({
      dev: 1n,
      ino: 1n,
      mode,
      uid: BigInt(CURRENT_UID),
      size: 0n,
      mtimeNs: 0n,
      isDirectory: () => true,
      isFile: () => false,
    }),
  };
}

function environment(overrides: Partial<ProviderProxyEndpointEnvironment> = {}): ProviderProxyEndpointEnvironment {
  return {
    baseDir: '/short',
    platform: 'linux',
    uid: CURRENT_UID,
    storage: secureStorage(),
    ...overrides,
  };
}

function pathOfLength(length: number): string {
  return `/${'t'.repeat(length - 1)}`;
}

describe('provider proxy paths', () => {
  it('places short endpoints in the flavor-specific generation run directory', () => {
    expect(providerProxyEndpoint(identity, environment())).toMatch(/^\/short\/gen2\/run\/provider-[0-9a-f]{24}\.sock$/);
    expect(providerProxyEndpoint({ ...identity, flavor: 'dev' }, environment())).toMatch(
      /^\/short\/gen2\/run-dev\/provider-[0-9a-f]{24}\.sock$/,
    );
  });

  it('places one disjoint capsule path per role in the flavor-specific generation run directory', () => {
    const common = {
      generation: 'gen2' as const,
      flavor: 'prod' as const,
      buildSetId: BUILD_SET_ID,
      hostFingerprint: HOST_FINGERPRINT,
    };
    const paths = [
      providerGuardianBootstrapCapsulePath({ ...common, guardianInstanceId: UUID_A }, { baseDir: '/short' }),
      providerReaperBootstrapCapsulePath({ ...common, reaperInstanceId: UUID_A }, { baseDir: '/short' }),
      providerProxyBootstrapCapsulePath({ ...common, proxyInstanceId: UUID_A }, { baseDir: '/short' }),
    ];

    expect(new Set(paths).size).toBe(3);
    for (const path of paths) {
      expect(path).toMatch(/^\/short\/gen2\/run\/provider-[0-9a-f]{24}\.bootstrap\.json$/);
    }
    expect(
      providerProxyBootstrapCapsulePath({ ...common, flavor: 'dev', proxyInstanceId: UUID_A }, { baseDir: '/short' }),
    ).toMatch(/^\/short\/gen2\/run-dev\/provider-[0-9a-f]{24}\.bootstrap\.json$/);
  });

  it('keeps proxy, guardian, and reaper endpoint identities disjoint for identical set inputs', () => {
    const env = environment();
    const common = {
      generation: 'gen2' as const,
      flavor: 'prod' as const,
      buildSetId: BUILD_SET_ID,
      hostFingerprint: HOST_FINGERPRINT,
    };

    const endpoints = [
      providerProxyEndpoint({ ...common, proxyInstanceId: UUID_A }, env),
      providerGuardianEndpoint({ ...common, guardianInstanceId: UUID_A }, env),
      providerReaperEndpoint({ ...common, reaperInstanceId: UUID_A }, env),
    ];

    expect(new Set(endpoints).size).toBe(3);
  });

  it('changes each endpoint when its process instance id changes', () => {
    const env = environment();
    const common = {
      generation: 'gen2' as const,
      flavor: 'prod' as const,
      buildSetId: BUILD_SET_ID,
      hostFingerprint: HOST_FINGERPRINT,
    };

    expect(providerProxyEndpoint({ ...common, proxyInstanceId: UUID_A }, env)).not.toBe(
      providerProxyEndpoint({ ...common, proxyInstanceId: UUID_B }, env),
    );
    expect(providerGuardianEndpoint({ ...common, guardianInstanceId: UUID_A }, env)).not.toBe(
      providerGuardianEndpoint({ ...common, guardianInstanceId: UUID_B }, env),
    );
    expect(providerReaperEndpoint({ ...common, reaperInstanceId: UUID_A }, env)).not.toBe(
      providerReaperEndpoint({ ...common, reaperInstanceId: UUID_B }, env),
    );
  });

  it('creates and uses a current-uid mode-0700 fallback directory', () => {
    const mkdir = vi.fn();
    const endpoint = providerProxyEndpoint(
      identity,
      environment({ baseDir: pathOfLength(200), storage: { ...secureStorage(), mkdirSync: mkdir } }),
    );
    const fallbackDirectory = socketFallbackDir(CURRENT_UID);

    expect(mkdir).toHaveBeenCalledWith(fallbackDirectory, { recursive: true, mode: 0o700 });
    expect(endpoint.startsWith(`${fallbackDirectory}/provider-`)).toBe(true);
  });

  it('tightens an existing fallback directory of its own whose mode is not 0700', () => {
    const loose = secureStorage(0o40755n);
    let mode = 0o40755n;
    const storage: ProviderProxyEndpointEnvironment['storage'] = {
      ...loose,
      chmodSync: vi.fn((_path: string, next: number) => {
        mode = 0o40000n | BigInt(next);
      }),
      lstatSync: (path) => ({ ...loose.lstatSync(path, { bigint: true }), mode }),
    };

    const endpoint = providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage }));

    expect(storage.chmodSync).toHaveBeenCalledWith(socketFallbackDir(CURRENT_UID), 0o700);
    expect(endpoint.startsWith(`${socketFallbackDir(CURRENT_UID)}/provider-`)).toBe(true);
  });

  it('refuses a fallback directory whose mode cannot be tightened', () => {
    const loose = secureStorage(0o40755n);

    expect(() =>
      providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage: loose })),
    ).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_insecure',
        context: expect.objectContaining({ refusal: 'foreign' }),
      }),
    );
  });

  it('refuses a fallback directory owned by another uid', () => {
    const loose = secureStorage();
    const storage: ProviderProxyEndpointEnvironment['storage'] = {
      ...loose,
      lstatSync: (path) => ({ ...loose.lstatSync(path, { bigint: true }), uid: BigInt(CURRENT_UID) + 1n }),
    };

    expect(() => providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage }))).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_insecure',
        context: expect.objectContaining({ refusal: 'foreign' }),
      }),
    );
  });

  it('refuses a fallback directory whose entry is a symlink, without following it', () => {
    const loose = secureStorage();
    const storage: ProviderProxyEndpointEnvironment['storage'] = {
      ...loose,
      lstatSync: (path) => ({ ...loose.lstatSync(path, { bigint: true }), mode: 0o120777n }),
    };

    expect(() => providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage }))).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_insecure',
        context: expect.objectContaining({ refusal: 'foreign' }),
      }),
    );
  });

  it('separates a directory it could not observe from one it observed as foreign', () => {
    const loose = secureStorage();
    const storage: ProviderProxyEndpointEnvironment['storage'] = {
      ...loose,
      lstatSync: () => {
        throw new Error('EIO: i/o error, lstat');
      },
    };

    expect(() => providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage }))).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_insecure',
        context: expect.objectContaining({ refusal: 'unverified', cause: 'EIO: i/o error, lstat' }),
      }),
    );
  });
});
