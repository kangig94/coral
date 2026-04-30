import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server as NetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { decode, encode, type JsonRpcRequest, type JsonRpcResponse } from '#src/transport/json-rpc.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';
import { CoralSetupError } from '#src/runtime/errors.js';

const tempDirs: string[] = [];
const servers: NetServer[] = [];

function makeSocketPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-client-test-'));
  tempDirs.push(root);
  return join(root, `${name}.sock`);
}

async function startReplyServer(
  socketPath: string,
  reply: (request: JsonRpcRequest) => JsonRpcResponse | Promise<JsonRpcResponse>,
): Promise<NetServer> {
  mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      void (async () => {
        buffer += chunk.toString('utf-8');
        const frames = buffer.split('\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (frame.trim().length === 0) continue;
          const request = decode(frame);
          if (request.kind !== 'request') {
            continue;
          }
          socket.end(`${encode(await reply(request))}\n`);
        }
      })().catch((error: unknown) => {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ipc client', () => {
  it('sends a JSON-RPC request and resolves the response payload', async () => {
    const socketPath = makeSocketPath('request');
    await startReplyServer(socketPath, async (request) => ({
      kind: 'response',
      id: request.id,
      result: { ok: true, method: request.method, params: request.params },
    }));

    await expect(requestIpcMethod(socketPath, 'jobs.list', { all: true })).resolves.toEqual({
      ok: true,
      method: 'jobs.list',
      params: { all: true },
    });
  });

  it('retries once on ECONNREFUSED before succeeding', async () => {
    vi.resetModules();
    const socketPath = makeSocketPath('retry');
    const response = {
      kind: 'response',
      id: 1,
      result: { retried: true, method: 'transport.health' },
    } as const;
    const connectionCalls: string[] = [];

    class FakeSocket extends EventEmitter {
      destroyed = false;
      writableEnded = false;

      constructor(private readonly behavior: 'refused' | 'success') {
        super();
        queueMicrotask(() => {
          if (behavior === 'refused') {
            const error = new Error('ECONNREFUSED') as NodeJS.ErrnoException;
            error.code = 'ECONNREFUSED';
            this.emit('error', error);
            this.emit('close');
            return;
          }
          this.emit('connect');
        });
      }

      write(_chunk: string) {
        queueMicrotask(() => {
          this.emit('data', Buffer.from(`${encode(response)}\n`));
        });
        return true;
      }

      end() {
        this.writableEnded = true;
        this.emit('close');
      }

      destroy(error?: Error) {
        this.destroyed = true;
        if (error) {
          this.emit('error', error);
        }
        this.emit('close');
        return this;
      }
    }

    vi.doMock('node:net', () => ({
      createConnection: (path: string) => {
        connectionCalls.push(path);
        return new FakeSocket(connectionCalls.length === 1 ? 'refused' : 'success');
      },
    }));

    const { requestIpcMethod: requestWithRetry } = await import('#src/transport/ipc/client.js');
    await expect(requestWithRetry(socketPath, 'transport.health')).resolves.toEqual(response.result);
    expect(connectionCalls).toEqual([socketPath, socketPath]);
  });

  it('throws CoralSetupError with remediation on persistent connection failure', async () => {
    const socketPath = makeSocketPath('missing');

    let thrown: unknown;
    try {
      await requestIpcMethod(socketPath, 'transport.health', undefined, { timeoutMs: 25 });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect((thrown as CoralSetupError).remediation).toContain('stale socket');
  });
});
