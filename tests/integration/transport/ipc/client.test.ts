import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decode,
  encode,
  type JsonRpcRequestEnvelope,
  type JsonRpcResponseEnvelope,
} from '#src/transport/ipc/json-rpc.js';
import { IpcLifecycleRefusal, IpcRequestTimeout, requestIpcMethod } from '#src/transport/ipc/client.js';

import { createDeferred } from '#tools/testing/deferred.js';
import { createRealTimePort } from '#src/infra/time.js';

const tempDirs: string[] = [];
const servers: NetServer[] = [];
const accepted: Socket[] = [];

function makeSocketPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-client-test-'));
  tempDirs.push(root);
  return join(root, `${name}.sock`);
}

async function startReplyServer(
  socketPath: string,
  reply: (request: JsonRpcRequestEnvelope) => JsonRpcResponseEnvelope | Promise<JsonRpcResponseEnvelope>,
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

/**
 * A server that accepts and never answers. It retains what it accepted because a client-side `destroy()` of
 * an unanswered request leaves the accepted socket open — with no `'data'` listener its EOF is never read —
 * and `close()` does not return while one is (measured on Node 24, darwin).
 */
async function startSilentServer(
  socketPath: string,
  received: ReturnType<typeof createDeferred<void>>,
): Promise<NetServer> {
  mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer((socket) => {
    accepted.push(socket);
    socket.once('data', () => received.resolve());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of accepted.splice(0)) {
    socket.destroy();
  }
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

  it('converts a shipped lifecycle refusal into a typed error', async () => {
    const socketPath = makeSocketPath('refusal');
    await startReplyServer(socketPath, (request) => ({
      kind: 'response',
      id: request.id,
      result: { code: 'backend_shutting_down', message: 'Backend shutting down' },
    }));
    const refusal = await requestIpcMethod(socketPath, 'jobs.abort', { jobId: 'job-1' }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(IpcLifecycleRefusal);
    expect(refusal).toMatchObject({
      code: 'backend_shutting_down',
      method: 'jobs.abort',
      socketPath,
    });
  });

  it('expires an unanswered request through the injected clock', async () => {
    const socketPath = makeSocketPath('silent');
    const received = createDeferred<void>();
    await startSilentServer(socketPath, received);
    vi.useFakeTimers();
    const request = requestIpcMethod(
      socketPath,
      'jobs.list',
      {},
      {
        timeoutMs: 25,
        time: createRealTimePort(),
      },
    ).catch((error: unknown) => error);
    await received.promise;
    await vi.advanceTimersByTimeAsync(25);
    expect(await request).toBeInstanceOf(IpcRequestTimeout);
  });
});
