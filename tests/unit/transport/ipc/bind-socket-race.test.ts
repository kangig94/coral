import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

afterEach(() => {
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
    const listenErrors = ['EADDRINUSE', 'EADDRINUSE'];
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
    const mkdirSync = vi.fn();
    const unlinkSync = vi.fn();
    const createConnection = vi.fn(() => {
      const socket = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
      socket.destroy = vi.fn();
      queueMicrotask(() => socket.emit('error', errno('ECONNREFUSED')));
      return socket;
    });

    vi.doMock('node:fs', () => ({
      chmodSync,
      mkdirSync,
      unlinkSync,
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
    expect(server.listen).toHaveBeenCalledTimes(2);
    expect(chmodSync).not.toHaveBeenCalled();
  });
});
