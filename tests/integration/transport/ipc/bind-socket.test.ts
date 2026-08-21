// Phase B coverage for `bindSocket` (the tagged-result EADDRINUSE primitive)
// and the ownership-safe `closeIpcServer` close path.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { socketFallbackDir } from '#src/infra/path/unix-socket.js';
import { bindSocket, closeIpcServer, type IpcListener } from '#src/transport/ipc/server.js';

const tempDirs: string[] = [];
const createdFallbackLinks: string[] = [];
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
  // Never recursive, and only for an entry a test proved it created: this path is derived from a uid rather
  // than from mkdtemp, so a recursive remove of one this suite did not make is a remove of someone's data.
  for (const link of createdFallbackLinks.splice(0)) {
    unlinkSync(link);
  }
  vi.restoreAllMocks();
});

describe('bindSocket', () => {
  it('clean bind returns { kind: "bound" }', async () => {
    const socketPath = makeSocketPath('clean');
    const server = createServer();
    cleanupServers.push(server);

    const result = await bindSocket(server, socketPath);
    expect(result).toEqual({ kind: 'bound' });
    expect(server.listening).toBe(true);
  });

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

  it('reports a relocated directory it could not observe under its own code, not the ownership verdict', async () => {
    // A uid no directory can be owned by, so the assertion refuses before it touches the filesystem.
    vi.spyOn(process, 'getuid').mockReturnValue(Number.NaN);
    const server = createServer();
    cleanupServers.push(server);

    await expect(bindSocket(server, join(socketFallbackDir(Number.NaN), 'relocated.sock'))).rejects.toThrow(
      expect.objectContaining({ code: 'coordinator_socket_dir_unverified' }),
    );
    expect(server.listening).toBe(false);
  });

  // Which refusal the assertion reaches is `ensurePrivateSocketDir`'s own test's subject; this one is here
  // for the wiring — that a refusal becomes the documented code and that no listen is attempted after it.
  // The uid is synthetic so the shared per-uid directory named here cannot be one a coordinator on this host
  // is bound in, and the entry it creates is removed only once creating it succeeded.
  it('turns a relocated-directory refusal into its documented code without listening', async () => {
    const uid = 9_000_000 + process.pid;
    vi.spyOn(process, 'getuid').mockReturnValue(uid);
    const directory = socketFallbackDir(uid);
    const target = mkdtempSync(join(tmpdir(), 'coral-relocated-target-'));
    tempDirs.push(target);
    symlinkSync(target, directory);
    createdFallbackLinks.push(directory);

    const server = createServer();
    cleanupServers.push(server);

    await expect(bindSocket(server, join(directory, 'relocated.sock'))).rejects.toThrow(
      expect.objectContaining({ code: 'coordinator_socket_dir_insecure' }),
    );
    expect(server.listening).toBe(false);
    expect(existsSync(join(target, 'relocated.sock'))).toBe(false);
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

describe('closeIpcServer ownership-safe close', () => {
  it('does not unlink a replacement socket path after replacement bind', async () => {
    const socketPath = makeSocketPath('handoff');

    const oldServer = createServer();
    const oldListener: IpcListener = {
      server: oldServer,
      sockets: new Set(),
      socketPath,
      onShutdownRequest: null,
    };
    await new Promise<void>((resolve, reject) => {
      oldServer.once('error', reject);
      oldServer.listen(socketPath, () => {
        oldServer.off('error', reject);
        resolve();
      });
    });

    // Old listener gracefully closes WITHOUT unlinking — path-cleanup is
    // the next binder's job.
    await closeIpcServer(oldListener);
    expect(oldListener.socketPath).toBeNull();
    // The socket path may exist as a stale orphan; the next bind clears it.
    // We accept either presence here — the contract is "old close does not
    // delete a replacement's socket".

    // A replacement immediately binds. `bindSocket` clears any stale orphan
    // and acquires the path.
    const newServer = createServer();
    cleanupServers.push(newServer);
    const result = await bindSocket(newServer, socketPath);
    expect(result).toEqual({ kind: 'bound' });
    expect(newServer.listening).toBe(true);

    // Now simulate a delayed second close call on the OLD listener (e.g.
    // composition guards). It must not unlink the path now owned by newServer.
    await closeIpcServer({
      server: oldServer,
      sockets: new Set(),
      socketPath,
      onShutdownRequest: null,
    });
    expect(newServer.listening).toBe(true);
    const probe = createServer();
    cleanupServers.push(probe);
    const probeResult = await bindSocket(probe, socketPath);
    expect(probeResult).toEqual({ kind: 'incumbent', reason: 'live-listener' });
  });
});
