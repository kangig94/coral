import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.doUnmock('node:fs');
  vi.doUnmock('node:net');
});

describe('bindSocket stale-clear race', () => {
  it('returns incumbent when the second listen sees EADDRINUSE', async () => {
    vi.resetModules();

    const server = new EventEmitter() as EventEmitter & {
      listen: ReturnType<typeof vi.fn>;
      listening: boolean;
    };
    const listenErrors = ['EADDRINUSE', 'EADDRINUSE', 'EADDRINUSE'];
    server.listening = false;
    server.listen = vi.fn(() => {
      const code = listenErrors.shift();
      if (code) {
        queueMicrotask(() => server.emit('error', errno(code)));
      } else {
        queueMicrotask(() => {
          server.listening = true;
          server.emit('listening');
        });
      }
      return server;
    });

    const chmodSync = vi.fn();
    const lockDirs = new Set<string>();
    const lockFiles = new Set<string>();
    const mkdirSync = vi.fn((path: string) => {
      if (path.endsWith('.clear.lock') && lockDirs.has(path)) {
        throw errno('EEXIST');
      }
      if (path.endsWith('.clear.lock')) {
        lockDirs.add(path);
      }
    });
    const unlinkSync = vi.fn();
    const writeFileSync = vi.fn((path: string) => {
      lockFiles.add(path);
    });
    const rmSync = vi.fn((path: string) => {
      lockDirs.delete(path);
      for (const file of [...lockFiles]) {
        if (file.startsWith(`${path}/`)) {
          lockFiles.delete(file);
        }
      }
    });
    const rmdirSync = vi.fn((path: string) => {
      if ([...lockFiles].some((file) => file.startsWith(`${path}/`))) {
        throw errno('ENOTEMPTY');
      }
      if (!lockDirs.delete(path)) {
        throw errno('ENOENT');
      }
    });
    const statSync = vi.fn((path: string) => {
      if (!lockDirs.has(path)) {
        throw errno('ENOENT');
      }
      return { size: 0, mtimeMs: Date.now(), isDirectory: () => true, isFile: () => false };
    });
    const createConnection = vi.fn(() => {
      const socket = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
      socket.destroy = vi.fn();
      queueMicrotask(() => socket.emit('error', errno('ECONNREFUSED')));
      return socket;
    });

    vi.doMock('node:fs', () => ({
      chmodSync,
      mkdirSync,
      rmSync,
      rmdirSync,
      statSync,
      unlinkSync,
      writeFileSync,
    }));
    vi.doMock('node:net', () => ({
      createConnection,
      createServer: vi.fn(),
    }));

    const { bindSocket } = await import('#src/transport/ipc/server.js');

    await expect(bindSocket(server as never, '/tmp/coral.sock')).resolves.toEqual({
      kind: 'incumbent',
      reason: 'live-listener',
    });
    expect(createConnection).toHaveBeenCalledWith('/tmp/coral.sock');
    expect(unlinkSync).toHaveBeenCalledWith('/tmp/coral.sock');
    expect(server.listen).toHaveBeenCalledTimes(3);
    expect(chmodSync).not.toHaveBeenCalled();
  });

  it('serializes stale clear and rebind so only one racing binder wins', async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const socketPath = '/tmp/coral.sock';
    const lockDirs = new Set<string>();
    const lockFiles = new Set<string>();
    let staleSocketFileExists = true;
    let liveSocketBound = false;
    const pendingRebinds: Array<() => void> = [];

    const createServer = () => {
      const server = new EventEmitter() as EventEmitter & {
        listen: ReturnType<typeof vi.fn>;
        listening: boolean;
      };
      server.listening = false;
      server.listen = vi.fn((path: string) => {
        if (path !== socketPath) {
          queueMicrotask(() => server.emit('error', errno('EINVAL')));
          return server;
        }
        if (liveSocketBound || staleSocketFileExists) {
          queueMicrotask(() => server.emit('error', errno('EADDRINUSE')));
          return server;
        }

        pendingRebinds.push(() => {
          liveSocketBound = true;
          server.listening = true;
          server.emit('listening');
        });
        if (pendingRebinds.length === 2) {
          queueMicrotask(() => {
            for (const complete of pendingRebinds.splice(0)) {
              complete();
            }
          });
        } else {
          queueMicrotask(() => {
            if (pendingRebinds.includes(pendingRebinds[0])) {
              pendingRebinds.shift()?.();
            }
          });
        }
        return server;
      });
      return server;
    };

    const chmodSync = vi.fn();
    const mkdirSync = vi.fn((path: string) => {
      if (path.endsWith('.clear.lock') && lockDirs.has(path)) {
        throw errno('EEXIST');
      }
      if (path.endsWith('.clear.lock')) {
        lockDirs.add(path);
      }
    });
    const unlinkSync = vi.fn((path: string) => {
      if (path === socketPath) {
        if (!staleSocketFileExists) {
          throw errno('ENOENT');
        }
        staleSocketFileExists = false;
        return;
      }
      if (!lockFiles.delete(path)) {
        throw errno('ENOENT');
      }
    });
    const writeFileSync = vi.fn((path: string) => {
      lockFiles.add(path);
    });
    const rmSync = vi.fn((path: string) => {
      lockDirs.delete(path);
      for (const file of [...lockFiles]) {
        if (file.startsWith(`${path}/`)) {
          lockFiles.delete(file);
        }
      }
    });
    const rmdirSync = vi.fn((path: string) => {
      if ([...lockFiles].some((file) => file.startsWith(`${path}/`))) {
        throw errno('ENOTEMPTY');
      }
      if (!lockDirs.delete(path)) {
        throw errno('ENOENT');
      }
    });
    const statSync = vi.fn((path: string) => {
      if (!lockDirs.has(path)) {
        throw errno('ENOENT');
      }
      return { size: 0, mtimeMs: Date.now(), isDirectory: () => true, isFile: () => false };
    });
    const createConnection = vi.fn(() => {
      const socket = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
      socket.destroy = vi.fn();
      queueMicrotask(() => {
        socket.emit('error', liveSocketBound ? errno('ECONNRESET') : errno('ECONNREFUSED'));
      });
      return socket;
    });

    vi.doMock('node:fs', () => ({
      chmodSync,
      mkdirSync,
      rmSync,
      rmdirSync,
      statSync,
      unlinkSync,
      writeFileSync,
    }));
    vi.doMock('node:net', () => ({
      createConnection,
      createServer: vi.fn(),
    }));

    const { bindSocket } = await import('#src/transport/ipc/server.js');
    const serverA = createServer();
    const serverB = createServer();

    const binding = Promise.all([bindSocket(serverA as never, socketPath), bindSocket(serverB as never, socketPath)]);
    await vi.runAllTimersAsync();
    const results = await binding;

    expect(results).toEqual(
      expect.arrayContaining([{ kind: 'bound' }, { kind: 'incumbent', reason: 'live-listener' }]),
    );
    expect(results.filter((result) => result.kind === 'bound')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'incumbent')).toHaveLength(1);
  });
});
