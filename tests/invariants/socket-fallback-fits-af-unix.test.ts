import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';

import { socketPathForRunDir } from '#src/infra/path/coordinator.js';
import { providerProxyEndpoint, type ProviderProxyEndpointEnvironment } from '#src/infra/path/provider-proxy.js';
import { generationRoot } from '#src/infra/path/root.js';
import { socketFallbackDir } from '#src/infra/path/unix-socket.js';

const PROVIDER_IDENTITY = {
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: '33333333-3333-4333-8333-333333333333',
  hostFingerprint: 'a'.repeat(64),
  proxyInstanceId: '11111111-1111-4111-8111-111111111111',
};
const PRIVATE_DIRECTORY = {
  dev: 1n,
  ino: 1n,
  nlink: 1n,
  mode: 0o40700n,
  uid: 4242n,
  size: 0n,
  mtimeNs: 0n,
  isDirectory: () => true,
  isFile: () => false,
};
const STORAGE: ProviderProxyEndpointEnvironment['storage'] = {
  mkdirSync: () => undefined,
  chmodSync: () => undefined,
  lstatSync: () => PRIVATE_DIRECTORY,
  statSync: () => PRIVATE_DIRECTORY,
};

describe('AF_UNIX socket path boundaries', () => {
  it('relocates an overlong coordinator socket within the conservative ceiling', () => {
    const runDir = `/${'r'.repeat(200)}`;
    const socket = socketPathForRunDir(runDir, 'prod', { platform: 'darwin' });

    expect(dirname(socket)).toBe(socketFallbackDir(dirname(runDir)));
    expect(Buffer.byteLength(socket, 'utf8')).toBeLessThan(104);
  });

  it('relocates an overlong provider endpoint within the conservative ceiling', () => {
    const baseDir = `/${'r'.repeat(200)}`;
    const socket = providerProxyEndpoint(PROVIDER_IDENTITY, {
      baseDir,
      platform: 'darwin',
      uid: 4242,
      storage: STORAGE,
    });

    expect(dirname(socket)).toBe(socketFallbackDir(generationRoot({ baseDir })));
    expect(Buffer.byteLength(socket, 'utf8')).toBeLessThan(104);
  });

  it('keeps Linux candidates below 108 bytes in place and relocates at 108 bytes', () => {
    for (const length of [107, 108]) {
      const runDir = `/${'r'.repeat(length - 1 - Buffer.byteLength('/coordinator.sock'))}`;
      const coordinator = socketPathForRunDir(runDir, 'prod', { platform: 'linux' });
      expect(coordinator === join(runDir, 'coordinator.sock')).toBe(length < 108);

      const suffix = `/gen2/run/provider-${'0'.repeat(24)}.sock`;
      const baseDir = `/${'r'.repeat(length - 1 - Buffer.byteLength(suffix))}`;
      const provider = providerProxyEndpoint(PROVIDER_IDENTITY, {
        baseDir,
        platform: 'linux',
        uid: 4242,
        storage: STORAGE,
      });
      expect(dirname(provider) === join(generationRoot({ baseDir }), 'run')).toBe(length < 108);
    }
  });
});
