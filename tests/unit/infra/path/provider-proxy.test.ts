import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';

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

const FALLBACK_DIRECTORY = socketFallbackDir(CURRENT_UID);
const FALLBACK_ROOT = dirname(FALLBACK_DIRECTORY);

function secureStorage(mode = 0o40700n): ProviderProxyEndpointEnvironment['storage'] {
  let current = mode;
  const stat = (value: bigint) => ({
    dev: 1n,
    ino: 1n,
    mode: value,
    uid: BigInt(CURRENT_UID),
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

  it('requests and uses a current-uid mode-0700 fallback directory', () => {
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
    const storage = secureStorage(0o40755n);

    const endpoint = providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage }));

    expect(storage.chmodSync).toHaveBeenCalledWith(FALLBACK_DIRECTORY, 0o700);
    expect(endpoint.startsWith(`${socketFallbackDir(CURRENT_UID)}/provider-`)).toBe(true);
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

    expect(() => providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage }))).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_insecure',
        message:
          `Provider endpoint fallback directory '${FALLBACK_DIRECTORY}' belongs to another user, so it cannot be a directory owned by uid ${CURRENT_UID} with mode 0700. ` +
          'Ask its owner or an administrator to remove it, then start Coral again.',
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

    expect(() => providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage }))).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_insecure',
        message:
          `Provider endpoint fallback directory '${FALLBACK_DIRECTORY}' is not a directory owned by uid ${CURRENT_UID} with mode 0700. ` +
          'Remove it, then start Coral again.',
        context: expect.objectContaining({ refusal: 'unusable' }),
      }),
    );
  });

  it('reports an unsecurable fallback directory with the observation and administrator remediation', () => {
    const loose = secureStorage();
    const storage: ProviderProxyEndpointEnvironment['storage'] = {
      ...loose,
      statSync: (path) =>
        path === FALLBACK_ROOT
          ? { ...loose.statSync(path, { bigint: true }), mode: 0o40777n }
          : loose.statSync(path, { bigint: true }),
    };

    expect(() => providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage }))).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_insecure',
        message:
          `Provider endpoint fallback directory '${FALLBACK_DIRECTORY}' cannot be held as a directory owned by uid ${CURRENT_UID} with mode 0700: its parent '${FALLBACK_ROOT}' is writable by other users and does not restrict deletion. ` +
          "Give this host's administrator this observation, then start Coral again after the directory is repaired.",
        context: expect.objectContaining({ refusal: 'unsecurable' }),
      }),
    );
  });

  it('reports a fallback directory it could not observe as unverified', () => {
    const loose = secureStorage();
    const storage: ProviderProxyEndpointEnvironment['storage'] = {
      ...loose,
      lstatSync: () => {
        throw new Error(`EACCES: permission denied, lstat '${FALLBACK_DIRECTORY}'`);
      },
    };

    expect(() => providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage }))).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_unverified',
        message:
          `The provider endpoint fallback directory could not be verified as a directory owned by uid ${CURRENT_UID} with mode 0700: EACCES: permission denied, lstat '${FALLBACK_DIRECTORY}'. ` +
          'Resolve the reported filesystem error, then start Coral again.',
        context: expect.objectContaining({
          refusal: 'unverified',
          cause: `EACCES: permission denied, lstat '${FALLBACK_DIRECTORY}'`,
        }),
      }),
    );
  });

  it.each([
    ['an Error', new Error('real'), 'real'],
    ['an Error subclass', new TypeError('wrong type'), 'wrong type'],
    ['an Error with no message', new Error(''), 'the storage adapter threw without an observation'],
    ['an errno-like object with a code', { code: 'EIO' }, 'EIO'],
    ['an errno-like object with a message', { message: 'adapter offline' }, 'adapter offline'],
    ['a plain object', { operation: 'lstat' }, 'the storage adapter threw without an observation'],
    ['a string', 'EIO primitive', 'EIO primitive'],
    ['an empty string', '', 'the storage adapter threw without an observation'],
    ['a whitespace-only string', '   ', 'the storage adapter threw without an observation'],
    ['a number', 17, '17'],
    ['a bigint', 17n, '17'],
    ['a boolean', false, 'false'],
    ['null', null, 'the storage adapter threw without an observation'],
    ['no observation', undefined, 'the storage adapter threw without an observation'],
    ['a symbol', Symbol('EIO'), 'Symbol(EIO)'],
    ['an array', ['EIO'], 'the storage adapter threw without an observation'],
    ['a function', () => undefined, 'the storage adapter threw without an observation'],
  ])('renders %s storage failure in the provider diagnostic', (_label, thrown, expectedCause) => {
    const storage = {
      ...secureStorage(),
      lstatSync: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Unknown adapter failures must retain primitive observations.
        throw thrown;
      },
    };

    expect(() => providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage }))).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_unverified',
        message: expect.stringContaining(`with mode 0700: ${expectedCause}.`),
        context: expect.objectContaining({ refusal: 'unverified', cause: expectedCause }),
      }),
    );
    expect(() => providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage }))).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining('undefined') }),
    );
  });

  it('does not prescribe a filesystem-error repair when an observation reports no owner', () => {
    const loose = secureStorage();
    const storage: ProviderProxyEndpointEnvironment['storage'] = {
      ...loose,
      lstatSync: (path) =>
        path === FALLBACK_ROOT
          ? loose.lstatSync(path, { bigint: true })
          : { ...loose.lstatSync(path, { bigint: true }), uid: undefined },
    };

    expect(() => providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), storage }))).toThrowError(
      expect.objectContaining({
        code: 'proxy_endpoint_unverified',
        message: expect.stringContaining(
          'Start Coral on a filesystem that reports owner identity for the fallback directory; the observation succeeded but did not identify an owner.',
        ),
        context: expect.objectContaining({ refusal: 'unverified', cause: 'the directory reported no owner' }),
      }),
    );
  });

  it.each([Number.NaN, 0xffff_ffff, Number.MAX_SAFE_INTEGER])(
    'names an owner uid the filesystem cannot represent from the fallback address (%s)',
    (uid) => {
      expect(() => providerProxyEndpoint(identity, environment({ baseDir: pathOfLength(200), uid }))).toThrowError(
        expect.objectContaining({
          code: 'proxy_endpoint_unverified',
          message: expect.stringContaining(
            'Start Coral in an environment that provides an owner uid the filesystem can represent',
          ),
        }),
      );
    },
  );
});
