import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { socketFallbackDir } from '#src/infra/path/unix-socket.js';
import { generationRoot } from '#src/infra/path/root.js';
import {
  providerProxyEndpoint,
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
