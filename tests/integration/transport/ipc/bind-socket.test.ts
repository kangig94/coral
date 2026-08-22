// Phase B coverage for `bindSocket` (the tagged-result EADDRINUSE primitive)
// and the ownership-safe `closeIpcServer` close path.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import type * as Fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { socketFallbackDir } from '#src/infra/path/unix-socket.js';
import { bindSocket, closeIpcServer, type IpcListener } from '#src/transport/ipc/server.js';

const fsDouble = vi.hoisted(() => ({
  actualLstatSync: undefined as typeof Fs.lstatSync | undefined,
  actualStatSync: undefined as typeof Fs.statSync | undefined,
  lstatSync: vi.fn<typeof Fs.lstatSync>(),
  statSync: vi.fn<typeof Fs.statSync>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  fsDouble.actualLstatSync = actual.lstatSync;
  fsDouble.actualStatSync = actual.statSync;
  fsDouble.lstatSync.mockImplementation(actual.lstatSync);
  fsDouble.statSync.mockImplementation(actual.statSync);
  return { ...actual, lstatSync: fsDouble.lstatSync, statSync: fsDouble.statSync };
});

const tempDirs: string[] = [];
const createdFallbackLinks: string[] = [];
const createdFallbackDirectories: string[] = [];
const cleanupServers: NetServer[] = [];

// `Stats` carries `isDirectory`/`isFile` on its prototype, so a spread drops them while the declared return
// type still promises them.
function overriding(observed: Fs.BigIntStats, overrides: Partial<Fs.BigIntStats>): Fs.BigIntStats {
  return Object.assign(Object.create(Object.getPrototypeOf(observed) as object) as Fs.BigIntStats, observed, overrides);
}

function reportFallbackParent(uid: bigint, mode: bigint): void {
  const parent = fsDouble.actualStatSync!('/tmp', { bigint: true });
  fsDouble.statSync.mockImplementationOnce((() => overriding(parent, { uid, mode })) as unknown as typeof Fs.statSync);
}

function reportFallbackEntryUid(directory: string, uid: bigint): void {
  const entry = fsDouble.actualLstatSync!(directory, { bigint: true });
  fsDouble.lstatSync.mockImplementationOnce((() => overriding(entry, { uid })) as unknown as typeof Fs.lstatSync);
}

function anotherUid(uid: number): number {
  return uid === 0xffff_ffff ? 0 : uid + 1;
}

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
  for (const directory of createdFallbackDirectories.splice(0)) {
    rmdirSync(directory);
  }
  vi.restoreAllMocks();
  fsDouble.lstatSync.mockReset();
  fsDouble.lstatSync.mockImplementation(fsDouble.actualLstatSync!);
  fsDouble.statSync.mockReset();
  fsDouble.statSync.mockImplementation(fsDouble.actualStatSync!);
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
    vi.spyOn(process, 'getuid').mockReturnValue(Number.NaN);
    const server = createServer();
    cleanupServers.push(server);

    await expect(bindSocket(server, join(socketFallbackDir(Number.NaN), 'relocated.sock'))).rejects.toThrow(
      expect.objectContaining({
        code: 'coordinator_socket_dir_unverified',
        userMessage: expect.not.stringContaining('Socket directory'),
      }),
    );
    expect(server.listening).toBe(false);
  });

  it('asserts a fallback directory against the uid encoded in its address', async () => {
    const addressUid = 9_000_000 + process.pid;
    const laterUid = anotherUid(addressUid);
    vi.spyOn(process, 'getuid').mockReturnValue(laterUid);
    const directory = socketFallbackDir(addressUid);
    mkdirSync(directory, { mode: 0o700 });
    createdFallbackDirectories.push(directory);
    reportFallbackParent(0n, 0o041777n);
    reportFallbackEntryUid(directory, BigInt(laterUid));
    const server = createServer();
    cleanupServers.push(server);

    await expect(bindSocket(server, join(directory, 'relocated.sock'))).rejects.toThrow(
      expect.objectContaining({
        code: 'coordinator_socket_dir_insecure',
        context: expect.objectContaining({ reason: 'foreign', uid: addressUid }),
      }),
    );
    expect(server.listening).toBe(false);
  });

  // The entry is reported as this uid's so the owner check passes and the type check is what refuses:
  // without that the symlink is simply foreign, and this would assert a mapping it never reached.
  it('maps an owned symlink to unusable and renders that reason, without listening', async () => {
    const uid = 9_000_000 + process.pid;
    vi.spyOn(process, 'getuid').mockReturnValue(uid);
    const directory = socketFallbackDir(uid);
    const target = mkdtempSync(join(tmpdir(), 'coral-relocated-target-'));
    tempDirs.push(target);
    symlinkSync(target, directory);
    createdFallbackLinks.push(directory);
    reportFallbackParent(0n, 0o041777n);
    reportFallbackEntryUid(directory, BigInt(uid));

    const server = createServer();
    cleanupServers.push(server);

    await expect(bindSocket(server, join(directory, 'relocated.sock'))).rejects.toThrow(
      expect.objectContaining({
        code: 'coordinator_socket_dir_insecure',
        context: expect.objectContaining({ reason: 'unusable' }),
        userMessage: expect.stringContaining('is not a directory'),
      }),
    );
    expect(server.listening).toBe(false);
    expect(existsSync(join(target, 'relocated.sock'))).toBe(false);
  });

  it('maps a foreign refusal reached through a repeated separator and renders its reason', async () => {
    const entryUid = process.getuid?.() ?? 0;
    const uid = anotherUid(entryUid);
    vi.spyOn(process, 'getuid').mockReturnValue(uid);
    const directory = socketFallbackDir(uid);
    mkdirSync(directory, { mode: 0o700 });
    createdFallbackDirectories.push(directory);
    reportFallbackParent(0n, 0o041777n);
    const socketPath = `${directory}//foreign.sock`;
    const server = createServer();
    cleanupServers.push(server);

    await expect(bindSocket(server, socketPath)).rejects.toThrow(
      expect.objectContaining({
        code: 'coordinator_socket_dir_insecure',
        context: expect.objectContaining({ reason: 'foreign' }),
        userMessage: expect.stringContaining('and that path belongs to another user.'),
      }),
    );
    expect(server.listening).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  });

  it.each([
    ['a dot segment', '/./'],
    ['a repeated separator', '//'],
  ])('examines the effective parent for a relocated path with %s', async (_label, separator) => {
    const uid = anotherUid(process.getuid?.() ?? 0);
    const observedUid = BigInt(anotherUid(uid));
    vi.spyOn(process, 'getuid').mockReturnValue(uid);
    const directory = socketFallbackDir(uid);
    mkdirSync(directory, { mode: 0o700 });
    createdFallbackDirectories.push(directory);
    reportFallbackParent(observedUid, 0o040700n);
    reportFallbackEntryUid(directory, BigInt(uid));
    const socketPath = `${directory}${separator}unsecurable.sock`;
    const effectiveParent = dirname(directory);
    const server = createServer();
    cleanupServers.push(server);

    const error = await bindSocket(server, socketPath).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: 'coordinator_socket_dir_insecure',
      context: expect.objectContaining({
        reason: 'unsecurable',
        directory,
        socketPath,
        cause: expect.stringContaining(`parent '${effectiveParent}'`),
      }),
    });
    const userMessage = (error as { userMessage: string }).userMessage;
    expect(userMessage).toContain(`parent '${effectiveParent}'`);
    expect(userMessage).toContain(`uid ${observedUid}`);
    expect(userMessage).toContain(`uid ${uid}`);
    expect(userMessage).toContain('or root');
    expect(server.listening).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
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
