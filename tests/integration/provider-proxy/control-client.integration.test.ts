import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  connectControlClient,
  type ControlClientTimer,
  type ProviderEventHandler,
} from '#src/provider-proxy/control-client.js';
import { PROVIDER_EVENT_METHOD } from '#src/provider-proxy/protocol.js';

const OPERATION = {
  jobId: '11111111-1111-1111-1111-111111111111',
  operationId: '22222222-2222-2222-2222-222222222222',
  proxyInstanceId: '33333333-3333-3333-3333-333333333333',
  buildSetId: '44444444-4444-4444-4444-444444444444',
};

function providerEventFrame(id: number, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: PROVIDER_EVENT_METHOD,
    params: { operation: OPERATION, providerSeq: 1, event: { kind: 'progress', message: 'tick' }, ...overrides },
  })}\n`;
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/**
 * A timer this suite fires itself rather than waiting on real elapsed time. `connectControlClient` and
 * `exchange()` both register their budget synchronously (inside a `new Promise` executor, which runs before
 * control returns to the caller), so a test can call `fireAll()` in the same tick and deterministically win
 * the race against any real socket event — which cannot arrive before the next tick. Nothing here needs a
 * millisecond to actually elapse.
 */
function manualTimer(): ControlClientTimer & { fireAll(): void } {
  const pending = new Map<{ unref: () => void }, () => void>();
  return {
    setTimeout(callback: () => void, _ms: number) {
      const handle = { unref: () => {} };
      pending.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle as { unref: () => void });
    },
    fireAll(): void {
      for (const [handle, callback] of [...pending]) {
        pending.delete(handle);
        callback();
      }
    },
  };
}

/** A bare stand-in for the far end of the channel: raw accept, raw write, raw destroy — no protocol logic. */
async function startTestServer(): Promise<{ socketPath: string; accepted: Promise<Socket> }> {
  const directory = mkdtempSync(join(tmpdir(), 'coral-control-client-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'c.sock');
  const sockets: Socket[] = [];
  let resolveAccepted!: (socket: Socket) => void;
  const accepted = new Promise<Socket>((resolve) => {
    resolveAccepted = resolve;
  });
  const server: NetServer = createServer((socket) => {
    sockets.push(socket);
    resolveAccepted(socket);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return { socketPath, accepted };
}

function respondToNextRequest(serverSocket: Socket, buildResponse: (id: number | string) => unknown): void {
  serverSocket.once('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString('utf8').split('\n')[0]) as { id: number | string };
    serverSocket.write(`${JSON.stringify(buildResponse(request.id))}\n`);
  });
}

describe('control client', () => {
  it('names a correlated result as a response', async () => {
    const { socketPath, accepted } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000);
    cleanups.push(() => client.close());
    const serverSocket = await accepted;
    respondToNextRequest(serverSocket, (id) => ({ jsonrpc: '2.0', id, result: { ok: true } }));

    await expect(client.exchange('role.work.v1', {}, 5_000)).resolves.toEqual({
      kind: 'response',
      response: { kind: 'result', value: { ok: true } },
    });
  });

  it('names a correlated JSON-RPC error as a refusal', async () => {
    const { socketPath, accepted } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000);
    cleanups.push(() => client.close());
    const serverSocket = await accepted;
    respondToNextRequest(serverSocket, (id) => ({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32_600,
        message: 'Control admission was refused (control-active).',
        data: { code: 'invalid_state', reason: 'control-active' },
      },
    }));

    const outcome = await client.exchange('role.redeem.v1', {}, 5_000);

    expect(outcome).toEqual({
      kind: 'response',
      response: {
        kind: 'refusal',
        failure: {
          kind: 'json-rpc-error',
          jsonRpcCode: -32_600,
          protocolCode: 'invalid_state',
          admissionReason: 'control-active',
          heartbeatRefusal: null,
        },
        error: expect.objectContaining({
          code: 'control_call_failed',
          origin: 'remote-response',
          message: 'Control admission was refused (control-active).',
        }),
      },
    });
  });

  it('names an unanswered written request that exceeds its budget as no-response', async () => {
    const { socketPath, accepted } = await startTestServer();
    const timer = manualTimer();
    const client = await connectControlClient(socketPath, timer, 5_000);
    cleanups.push(() => client.close());
    await accepted;

    const exchange = client.exchange('role.slow.v1', {}, 30);
    timer.fireAll();

    await expect(exchange).resolves.toEqual({
      kind: 'no-response',
      cause: 'timeout',
      error: expect.objectContaining({
        code: 'control_call_failed',
        origin: 'timeout',
        message: 'role.slow.v1 exceeded its 30ms budget.',
      }),
    });
  });

  it('names a reset with a written request pending as delivery-unconfirmed', async () => {
    const { socketPath, accepted } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000);
    cleanups.push(() => client.close());
    const serverSocket = await accepted;

    const exchange = client.exchange('role.work.v1', {}, 5_000);
    serverSocket.destroy();

    // A reset says the request may or may not have arrived, which is not the same as the peer declining to
    // answer one it received.
    await expect(exchange).resolves.toMatchObject({
      kind: 'delivery-unconfirmed',
      cause: 'socket-error-after-write',
    });
  });

  it('names an invalid unattributable frame as a channel fault', async () => {
    const { socketPath, accepted } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000);
    cleanups.push(() => client.close());
    const serverSocket = await accepted;

    const exchange = client.exchange('role.work.v1', {}, 5_000);
    serverSocket.write('not-json\n');

    await expect(exchange).resolves.toEqual({
      kind: 'channel-fault',
      cause: 'invalid-unattributable-frame',
      error: expect.objectContaining({
        code: 'control_call_failed',
        origin: 'remote-response',
        remoteFailure: { kind: 'invalid-frame' },
      }),
    });
  });

  it('dispatches provider.event.v1 to the installed handler and writes back its validated result', async () => {
    const received: unknown[] = [];
    const handler: ProviderEventHandler = (request) => {
      received.push(request);
      return { kind: 'ack', committedThroughProviderSeq: request.providerSeq };
    };
    const { socketPath, accepted } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000, handler);
    cleanups.push(() => client.close());
    const serverSocket = await accepted;

    const reply = await new Promise<{ id: number; result?: unknown }>((resolve) => {
      serverSocket.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8').split('\n')[0])));
      serverSocket.write(providerEventFrame(7));
    });

    expect(received).toEqual([{ operation: OPERATION, providerSeq: 1, event: { kind: 'progress', message: 'tick' } }]);
    expect(reply).toEqual({ id: 7, jsonrpc: '2.0', result: { kind: 'ack', committedThroughProviderSeq: 1 } });
  });
});
