import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  providerGuardianBootstrapCapsulePath,
  providerGuardianEndpoint,
  providerProxyBootstrapCapsulePath,
  providerProxyEndpoint,
  providerReaperBootstrapCapsulePath,
  providerReaperEndpoint,
  ProviderProxyEndpointError,
  type ProviderProxyEndpointEnvironment,
  type ProviderProxyEndpointIdentity,
} from '#src/infra/path/provider-proxy.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const BUILD_SET_ID = '33333333-3333-4333-8333-333333333333';
const HOST_FINGERPRINT = 'a'.repeat(64);
const CURRENT_UID = process.getuid?.() ?? Number(statSync(tmpdir(), { bigint: true }).uid);
const tempRoots: string[] = [];

const identity: ProviderProxyEndpointIdentity = {
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: BUILD_SET_ID,
  hostFingerprint: HOST_FINGERPRINT,
  proxyInstanceId: UUID_A,
};

function realStorage(): ProviderProxyEndpointEnvironment['storage'] {
  return {
    mkdirSync: (path, options) => mkdirSync(path, options),
    lstatSync: (path) => lstatSync(path),
    statSync: (path) => statSync(path, { bigint: true }),
  };
}

function secureStorage(): ProviderProxyEndpointEnvironment['storage'] {
  return {
    mkdirSync: vi.fn(),
    lstatSync: () => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }),
    statSync: () => ({
      dev: 1n,
      ino: 1n,
      mode: 0o40700n,
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
    tempDirectory: '/tmp',
    uid: CURRENT_UID,
    storage: secureStorage(),
    ...overrides,
  };
}

function pathOfLength(length: number): string {
  return `/${'t'.repeat(length - 1)}`;
}

function fallbackTempDirectoryForLength(targetLength: number): string {
  const filename = basename(providerProxyEndpoint(identity, environment()));
  const suffix = `/coral-${CURRENT_UID}/${filename}`;
  return pathOfLength(targetLength - Buffer.byteLength(suffix, 'utf8'));
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    const tempRoot = mkdtempSync(join(tmpdir(), 'coral-provider-endpoint-'));
    tempRoots.push(tempRoot);
    const endpoint = providerProxyEndpoint(
      identity,
      environment({
        baseDir: pathOfLength(200),
        tempDirectory: tempRoot,
        storage: realStorage(),
      }),
    );
    const fallbackDirectory = join(tempRoot, `coral-${CURRENT_UID}`);
    const stat = statSync(fallbackDirectory, { bigint: true });

    expect(endpoint.startsWith(`${fallbackDirectory}/provider-`)).toBe(true);
    expect(stat.uid).toBe(BigInt(CURRENT_UID));
    expect(stat.mode & 0o777n).toBe(0o700n);
  });

  it('rejects an existing fallback directory whose mode is not 0700', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'coral-provider-endpoint-'));
    tempRoots.push(tempRoot);
    const fallbackDirectory = join(tempRoot, `coral-${CURRENT_UID}`);
    mkdirSync(fallbackDirectory, { mode: 0o700 });
    chmodSync(fallbackDirectory, 0o755);

    expect(() =>
      providerProxyEndpoint(
        identity,
        environment({
          baseDir: pathOfLength(200),
          tempDirectory: tempRoot,
          storage: realStorage(),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'proxy_endpoint_insecure' }));
  });

  it.each([
    { platform: 'darwin', limit: 104 },
    { platform: 'linux', limit: 108 },
  ])('rejects the final $platform path at the $limit-byte AF_UNIX boundary', ({ platform, limit }) => {
    const accepted = providerProxyEndpoint(
      identity,
      environment({
        baseDir: pathOfLength(200),
        platform,
        tempDirectory: fallbackTempDirectoryForLength(limit - 1),
      }),
    );
    expect(Buffer.byteLength(accepted, 'utf8')).toBe(limit - 1);

    expect(() =>
      providerProxyEndpoint(
        identity,
        environment({
          baseDir: pathOfLength(200),
          platform,
          tempDirectory: fallbackTempDirectoryForLength(limit),
        }),
      ),
    ).toThrowError(ProviderProxyEndpointError);

    try {
      providerProxyEndpoint(
        identity,
        environment({
          baseDir: pathOfLength(200),
          platform,
          tempDirectory: fallbackTempDirectoryForLength(limit),
        }),
      );
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'proxy_endpoint_too_long', context: { observedBytes: limit, limit } });
    }
  });
});
