// Phase B coverage for `bindSocket` (the tagged-result EADDRINUSE primitive).

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindSocket } from '#src/transport/ipc/server.js';

const tempDirs: string[] = [];
const cleanupServers: NetServer[] = [];

function makeSocketPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-bind-socket-test-'));
  tempDirs.push(root);
  return join(root, `${name}.sock`);
}

async function listenLive(socketPath: string): Promise<NetServer> {
  const server = createServer();
  cleanupServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

afterEach(async () => {
  for (const server of cleanupServers.splice(0)) {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bindSocket', () => {
  it('auto-clears a stale orphan socket file on next bind', async () => {
    const socketPath = makeSocketPath('orphan');
    writeFileSync(socketPath, '');
    expect(existsSync(socketPath)).toBe(true);

    const server = createServer();
    cleanupServers.push(server);
    const result = await bindSocket(server, socketPath);
    expect(result).toEqual({ kind: 'bound' });
    expect(server.listening).toBe(true);
  });

  it('returns { kind: "incumbent" } when a live listener owns the socket', async () => {
    const socketPath = makeSocketPath('incumbent');
    await listenLive(socketPath);

    const server = createServer();
    cleanupServers.push(server);
    const result = await bindSocket(server, socketPath);
    expect(result).toEqual({ kind: 'incumbent', reason: 'live-listener' });
    expect(server.listening).toBe(false);
  });

  it('rethrows non-EADDRINUSE errors from listen', async () => {
    // Path that cannot be bound — too long for unix socket on Linux.
    const veryLong = '/' + 'x'.repeat(200) + '.sock';
    const server = createServer();
    cleanupServers.push(server);

    await expect(bindSocket(server, veryLong)).rejects.toThrow();
    expect(server.listening).toBe(false);
  });
});
