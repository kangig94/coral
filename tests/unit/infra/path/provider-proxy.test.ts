import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { socketFallbackDir } from '#src/infra/path/unix-socket.js';
import { generationRoot } from '#src/infra/path/root.js';
import {
  providerGuardianEndpoint,
  providerProxyEndpoint,
  providerReaperEndpoint,
  type ProviderProxyEndpointEnvironment,
  type ProviderProxyEndpointIdentity,
} from '#src/infra/path/provider-proxy.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
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

const RELOCATED_BASE_DIR = pathOfLength(200);
const FALLBACK_DIRECTORY = socketFallbackDir(generationRoot({ baseDir: RELOCATED_BASE_DIR }));
const FALLBACK_ROOT = dirname(FALLBACK_DIRECTORY);

function secureStorage(mode = 0o40700n, ownerUid = CURRENT_UID): ProviderProxyEndpointEnvironment['storage'] {
  let current = mode;
  const stat = (value: bigint) => ({
    dev: 1n,
    ino: 1n,
    nlink: 1n,
    mode: value,
    uid: BigInt(ownerUid),
    size: 0n,
    mtimeNs: 0n,
    isDirectory: () => (value & 0o170000n) === 0o040000n,
    isFile: () => false,
  });
  return {
    mkdirSync: vi.fn(),
    chmodSync: vi.fn((_path: string, next: number) => {
      current = (current & 0o170000n) | BigInt(next);
    }),
    lstatSync: (path: string) => (path === FALLBACK_ROOT ? stat(0o41777n) : stat(current)),
    statSync: (path: string) => (path === FALLBACK_ROOT ? stat(0o41777n) : stat(current)),
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

  it('requests and uses a current-uid mode-0700 fallback directory', () => {
    const mkdir = vi.fn();
    const endpoint = providerProxyEndpoint(
      identity,
      environment({ baseDir: RELOCATED_BASE_DIR, storage: { ...secureStorage(), mkdirSync: mkdir } }),
    );

    expect(mkdir).toHaveBeenCalledWith(FALLBACK_DIRECTORY, { recursive: true, mode: 0o700 });
    expect(endpoint.startsWith(`${FALLBACK_DIRECTORY}/provider-`)).toBe(true);
  });

  it('keeps one relocated endpoint address for one state root when the calling uid changes', () => {
    const userEndpoint = providerProxyEndpoint(
      identity,
      environment({ baseDir: RELOCATED_BASE_DIR, uid: 1_000, storage: secureStorage(0o40700n, 1_000) }),
    );
    const sudoEndpoint = providerProxyEndpoint(
      identity,
      environment({ baseDir: RELOCATED_BASE_DIR, uid: 0, storage: secureStorage(0o40700n, 0) }),
    );

    expect(userEndpoint).toBe(sudoEndpoint);
  });

  it('relocates a multibyte base path at the Linux byte threshold', () => {
    const suffix = `/gen2/run/provider-${'0'.repeat(24)}.sock`;
    const baseDir = `${pathOfLength(108 - Buffer.byteLength(suffix, 'utf8') - Buffer.byteLength('é', 'utf8'))}é`;
    const candidateShape = `${baseDir}${suffix}`;

    expect(candidateShape).toHaveLength(107);
    expect(Buffer.byteLength(candidateShape, 'utf8')).toBe(108);

    const endpoint = providerProxyEndpoint(identity, environment({ baseDir }));

    expect(endpoint.startsWith(`${socketFallbackDir(generationRoot({ baseDir }))}/provider-`)).toBe(true);
  });

  it('tightens an existing fallback directory of its own whose mode is not 0700', () => {
    const storage = secureStorage(0o40755n);

    const endpoint = providerProxyEndpoint(identity, environment({ baseDir: RELOCATED_BASE_DIR, storage }));

    expect(storage.chmodSync).toHaveBeenCalledWith(FALLBACK_DIRECTORY, 0o700);
    expect(endpoint.startsWith(`${FALLBACK_DIRECTORY}/provider-`)).toBe(true);
  });

  it('refuses a fallback directory owned by another uid', () => {
    const loose = secureStorage();
    const storage: ProviderProxyEndpointEnvironment['storage'] = {
      ...loose,
      lstatSync: (path) =>
        path === FALLBACK_ROOT
          ? loose.lstatSync(path, { bigint: true })
          : { ...loose.lstatSync(path, { bigint: true }), uid: BigInt(CURRENT_UID) + 1n },
    };

    expect(() => providerProxyEndpoint(identity, environment({ baseDir: RELOCATED_BASE_DIR, storage }))).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_insecure',
        context: expect.objectContaining({ refusal: 'foreign' }),
      }),
    );
  });

  it('refuses a fallback directory whose entry is a symlink of its own, without following it', () => {
    const loose = secureStorage();
    const storage: ProviderProxyEndpointEnvironment['storage'] = {
      ...loose,
      lstatSync: (path) =>
        path === FALLBACK_ROOT
          ? loose.lstatSync(path, { bigint: true })
          : { ...loose.lstatSync(path, { bigint: true }), mode: 0o120777n, isDirectory: () => false },
    };

    expect(() => providerProxyEndpoint(identity, environment({ baseDir: RELOCATED_BASE_DIR, storage }))).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_insecure',
        context: expect.objectContaining({ refusal: 'unusable' }),
      }),
    );
  });

  it('refuses a fallback directory beneath an unsafe parent', () => {
    const loose = secureStorage();
    const storage: ProviderProxyEndpointEnvironment['storage'] = {
      ...loose,
      statSync: (path) =>
        path === FALLBACK_ROOT
          ? { ...loose.statSync(path, { bigint: true }), mode: 0o40777n }
          : loose.statSync(path, { bigint: true }),
    };

    expect(() => providerProxyEndpoint(identity, environment({ baseDir: RELOCATED_BASE_DIR, storage }))).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_insecure',
        context: expect.objectContaining({ refusal: 'unsecurable' }),
      }),
    );
  });
});
