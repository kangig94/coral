import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDeferred } from '#src/infra/deferred.js';
import { decode, encode, type JsonRpcRequest } from '#src/transport/json-rpc.js';
import { subscribeIpcMethod } from '#src/transport/ipc/client.js';

const tempDirs: string[] = [];
const servers: NetServer[] = [];

function makeSocketPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-subscription-primitive-'));
  tempDirs.push(root);
  return join(root, `${name}.sock`);
}

function writeFrame(socket: Socket, envelope: unknown): void {
  socket.write(`${encode(envelope as never)}\n`);
}

async function startSubscriptionServer(
  socketPath: string,
  handler: (socket: Socket, request: JsonRpcRequest) => void | Promise<void>,
): Promise<void> {
  mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      void (async () => {
        buffer += chunk.toString('utf-8');
        const frames = buffer.split('\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (frame.trim().length === 0) {
            continue;
          }
          const request = decode(frame);
          if (request.kind !== 'request') {
            continue;
          }
          await handler(socket, request);
        }
      })().catch((error: unknown) => {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('subscription primitive', () => {
  it('opens and receives a scripted notification sequence', async () => {
    const socketPath = makeSocketPath('receive');
    const events = [
      { type: 'queued', jobId: 'job-1', sessionId: 'session-1', queuePosition: 1, runningJobIds: [] },
      { type: 'progress', jobId: 'job-1', eventId: 1, message: 'working' },
      {
        type: 'terminal',
        jobId: 'job-1',
        remainingJobIds: [],
        resultPath: '/tmp/result.md',
        result: { content: 'done', outcome: { kind: 'completed' } },
      },
    ] as const;

    await startSubscriptionServer(socketPath, async (socket, request) => {
      expect(request.method).toBe('jobs.wait');
      expect(request.params).toEqual({
        jobIds: ['job-1'],
        projectRoot: '/tmp/project',
        timeoutSeconds: 30,
      });
      writeFrame(socket, {
        kind: 'response',
        id: request.id,
        result: { status: 'subscribed', method: request.method },
      });
      for (const event of events) {
        writeFrame(socket, {
          kind: 'notification',
          method: request.method,
          params: event,
        });
      }
      socket.end();
    });

    const subscription = await subscribeIpcMethod<typeof events[number]>(socketPath, 'jobs.wait', {
      jobIds: ['job-1'],
      projectRoot: '/tmp/project',
      timeoutSeconds: 30,
    });
    const received: Array<(typeof events)[number]> = [];

    for await (const event of subscription) {
      received.push(event);
    }

    expect(received).toEqual(events);
  });

  it('supports explicit close and idempotent close', async () => {
    const socketPath = makeSocketPath('close');
    const socketClosed = createDeferred<void>();

    await startSubscriptionServer(socketPath, async (socket, request) => {
      socket.once('close', () => socketClosed.resolve());
      writeFrame(socket, {
        kind: 'response',
        id: request.id,
        result: { status: 'subscribed', method: request.method },
      });
    });

    const subscription = await subscribeIpcMethod(socketPath, 'jobs.wait', {
      jobIds: ['job-1'],
      projectRoot: '/tmp/project',
    });
    const iterator = subscription[Symbol.asyncIterator]();

    await subscription.close();
    await subscription.close();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await socketClosed.promise;
  });

  it('treats server-side hangup as end-of-stream', async () => {
    const socketPath = makeSocketPath('hangup');
    const progressEvent = { type: 'progress', jobId: 'job-1', eventId: 7, message: 'still running' } as const;

    await startSubscriptionServer(socketPath, async (socket, request) => {
      writeFrame(socket, {
        kind: 'response',
        id: request.id,
        result: { status: 'subscribed', method: request.method },
      });
      writeFrame(socket, {
        kind: 'notification',
        method: request.method,
        params: progressEvent,
      });
      socket.end();
    });

    const subscription = await subscribeIpcMethod<typeof progressEvent>(socketPath, 'jobs.wait', {
      jobIds: ['job-1'],
      projectRoot: '/tmp/project',
    });
    const iterator = subscription[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: progressEvent });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('rejects the active read when the client aborts', async () => {
    const socketPath = makeSocketPath('abort');
    const socketClosed = createDeferred<void>();

    await startSubscriptionServer(socketPath, async (socket, request) => {
      socket.once('close', () => socketClosed.resolve());
      writeFrame(socket, {
        kind: 'response',
        id: request.id,
        result: { status: 'subscribed', method: request.method },
      });
    });

    const controller = new AbortController();
    const subscription = await subscribeIpcMethod(socketPath, 'jobs.wait', {
      jobIds: ['job-1'],
      projectRoot: '/tmp/project',
    }, { signal: controller.signal });
    const iterator = subscription[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    controller.abort();

    await expect(nextPromise).rejects.toThrow('terminated');
    await socketClosed.promise;
  });

  it('rejects when the server responds with an error envelope instead of a subscription ack', async () => {
    const socketPath = makeSocketPath('error-ack');

    await startSubscriptionServer(socketPath, async (socket, request) => {
      writeFrame(socket, {
        kind: 'error',
        id: request.id,
        error: {
          code: -32_602,
          message: 'Invalid params',
          data: { issues: [{ path: ['jobIds'], message: 'At least one job is required' }] },
        },
      });
      socket.end();
    });

    await expect(
      subscribeIpcMethod(socketPath, 'jobs.wait', {
        jobIds: [],
        projectRoot: '/tmp/project',
      }),
    ).rejects.toThrow('Invalid params');
  });
});
