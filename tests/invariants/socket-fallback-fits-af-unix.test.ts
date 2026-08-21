import { describe, expect, it } from 'vitest';

import { socketPathForRunDir } from '#src/infra/path/coordinator.js';
import { providerProxyEndpoint, type ProviderProxyEndpointEnvironment } from '#src/infra/path/provider-proxy.js';
import { socketFallbackDir, socketPathByteLimit } from '#src/infra/path/unix-socket.js';

/**
 * Both socket resolvers relocate under `socketFallbackDir` when the path beside the run directory exceeds
 * `sun_path`. That is the last address available — there is nowhere shorter to go, and a path nothing can
 * bind surfaces as `listen EINVAL` naming no limit, no byte count and no variable to change.
 *
 * The bound demands a margin rather than an ordering: a name that merely fits breaks the first time a field
 * is added to what it encodes. The paths measured are what the resolvers return, not a restatement of their
 * grammar, so a name that grows inside either module must move these numbers.
 */
describe('a relocated socket path fits AF_UNIX on every platform', () => {
  const HEADROOM_RATIO = 0.75;
  const WIDEST_UID = -Number.MAX_VALUE;
  const PLATFORMS = ['darwin', 'linux'] as const;
  const DEEP_RUN_DIR = `/${'r'.repeat(200)}`;

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
    const uid = Number.MAX_SAFE_INTEGER;
    const relocated = providerProxyEndpoint(
      {
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: '33333333-3333-4333-8333-333333333333',
        hostFingerprint: 'a'.repeat(64),
        proxyInstanceId: '11111111-1111-4111-8111-111111111111',
      },
      { baseDir: DEEP_RUN_DIR, platform, uid, storage: secureStorage(uid) },
    );

    expect(relocated.startsWith(`${socketFallbackDir(uid)}/`)).toBe(true);
    expect(Buffer.byteLength(relocated, 'utf8')).toBeLessThan(socketPathByteLimit(platform) * HEADROOM_RATIO);
  });
});
