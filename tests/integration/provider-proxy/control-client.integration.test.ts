import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ControlClientError,
  connectControlClient,
  type ControlClientTimer,
  type ProviderEventHandler,
} from '#src/provider-proxy/control-client.js';
import {
  encodeProxyControlFrame,
  MAX_PROXY_CONTROL_FRAME_BYTES,
  PROVIDER_EVENT_METHOD,
  providerEventRequestSchema,
} from '#src/provider-proxy/protocol.js';
import { providerProxyEmergencyEvent, providerProxyReplayFailureReasonSchema } from '#src/providers/proxy-failure.js';

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
 * `call()` both register their budget synchronously (inside a `new Promise` executor, which runs before
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
async function startTestServer(): Promise<{ socketPath: string; sockets: Socket[] }> {
  const directory = mkdtempSync(join(tmpdir(), 'coral-control-client-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'c.sock');
  const sockets: Socket[] = [];
  const server: NetServer = createServer((socket) => {
    sockets.push(socket);
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
  return { socketPath, sockets };
}

async function waitForAccept(sockets: Socket[]): Promise<Socket> {
  const deadline = Date.now() + 5_000;
  while (sockets.length === 0) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the test server to accept a connection.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return sockets[0];
}

/** Replies to the next request frame the server side receives, echoing back its id. */
function respondToNextRequest(serverSocket: Socket, buildResponse: (id: number | string) => unknown): void {
  serverSocket.once('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString('utf8').split('\n')[0]) as { id: number | string };
    serverSocket.write(`${JSON.stringify(buildResponse(request.id))}\n`);
  });
}

describe('control client', () => {
  it('connects and resolves a call with the server result', async () => {
    const { socketPath, sockets } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000);
    cleanups.push(() => client.close());
    const serverSocket = await waitForAccept(sockets);
    respondToNextRequest(serverSocket, (id) => ({ jsonrpc: '2.0', id, result: { ok: true } }));

    await expect(client.call('role.work.v1', {}, 5_000)).resolves.toEqual({ ok: true });
  });

  it('rejects with control_client_connect_failed when the connect budget is exceeded', async () => {
    // A real, listening server so the socket path is genuine — the manual timer, not a bad path, is what
    // forces the timeout branch: fireAll() runs before Node's real 'connect' event could ever arrive.
    const { socketPath } = await startTestServer();
    const timer = manualTimer();

    const connecting = connectControlClient(socketPath, timer, 25);
    timer.fireAll();

    await expect(connecting).rejects.toMatchObject({
      code: 'control_client_connect_failed',
      protocolCode: undefined,
      message: expect.stringContaining('exceeded 25ms'),
    });
  });

  it('rejects with control_client_connect_failed when the socket path does not exist', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-control-client-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const socketPath = join(directory, 'no-such-socket.sock');
    // The manual timer is never fired here: nothing but the real connect error should be able to settle
    // this promise, which is what proves the rejection is genuinely the connect failure, not a timeout race.
    const timer = manualTimer();

    await expect(connectControlClient(socketPath, timer, 5_000)).rejects.toMatchObject({
      code: 'control_client_connect_failed',
      message: expect.stringContaining('Control connect failed:'),
    });
  });

  it('rejects a pending call with control_client_closed when the socket closes', async () => {
    const { socketPath, sockets } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000);
    cleanups.push(() => client.close());
    const serverSocket = await waitForAccept(sockets);

    const call = client.call('role.work.v1', {}, 5_000);
    serverSocket.destroy();

    await expect(call).rejects.toMatchObject({ code: 'control_client_closed', protocolCode: undefined });
  });

  it('rejects a call that exceeds its own budget with control_call_failed', async () => {
    const { socketPath, sockets } = await startTestServer();
    const timer = manualTimer();
    const client = await connectControlClient(socketPath, timer, 5_000);
    cleanups.push(() => client.close());
    await waitForAccept(sockets);

    // The server never responds; only the per-call budget can settle this.
    const call = client.call('role.slow.v1', {}, 30);
    timer.fireAll();

    await expect(call).rejects.toMatchObject({
      code: 'control_call_failed',
      message: expect.stringContaining('role.slow.v1 exceeded its 30ms budget.'),
    });
  });

  it('destroys the socket when incoming bytes exceed the frame cap before any newline', async () => {
    const { socketPath, sockets } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000);
    cleanups.push(() => client.close());
    const serverSocket = await waitForAccept(sockets);

    const call = client.call('role.work.v1', {}, 5_000);
    // No newline, so the client's reader must bound the accumulating buffer rather than wait for one.
    serverSocket.write('x'.repeat(MAX_PROXY_CONTROL_FRAME_BYTES + 1));

    await expect(call).rejects.toMatchObject({ code: 'control_client_closed' });
  });

  it('refuses an inbound request when no provider-event handler is installed, without dropping the connection', async () => {
    const { socketPath, sockets } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000);
    cleanups.push(() => client.close());
    const serverSocket = await waitForAccept(sockets);
    respondToNextRequest(serverSocket, (id) => ({ jsonrpc: '2.0', id, result: { ok: true } }));

    // The client's own in-flight call is unaffected by an unrelated inbound frame sharing no correlation to it.
    await expect(client.call('role.work.v1', {}, 5_000)).resolves.toEqual({ ok: true });

    const refusal = await new Promise<{ id: number; error: { data?: { code?: string } } }>((resolve) => {
      serverSocket.on('data', function onData(chunk: Buffer) {
        const message = JSON.parse(chunk.toString('utf8').split('\n')[0]) as { id: number };
        if (message.id === 999) {
          serverSocket.off('data', onData);
          resolve(message as { id: number; error: { data?: { code?: string } } });
        }
      });
      serverSocket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'server.callback.v1', params: {} })}\n`);
    });

    expect(refusal.error.data?.code).toBe('protocol_violation');
    // Refused, not dropped: the connection stays usable for whatever the client dials it for next.
    expect(serverSocket.destroyed).toBe(false);
    expect(client.close).not.toThrow();
  });

  it('refuses provider.event.v1 itself when no handler was installed at connect time', async () => {
    const { socketPath, sockets } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000);
    cleanups.push(() => client.close());
    const serverSocket = await waitForAccept(sockets);

    const refusal = await new Promise<{ error: { data?: { code?: string } } }>((resolve) => {
      serverSocket.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8').split('\n')[0])));
      serverSocket.write(providerEventFrame(1));
    });

    expect(refusal.error.data?.code).toBe('protocol_violation');
  });

  it('dispatches provider.event.v1 to the installed handler and writes back its validated result', async () => {
    const received: unknown[] = [];
    const handler: ProviderEventHandler = (request) => {
      received.push(request);
      return { kind: 'ack', committedThroughProviderSeq: request.providerSeq };
    };
    const { socketPath, sockets } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000, handler);
    cleanups.push(() => client.close());
    const serverSocket = await waitForAccept(sockets);

    const reply = await new Promise<{ id: number; result?: unknown }>((resolve) => {
      serverSocket.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8').split('\n')[0])));
      serverSocket.write(providerEventFrame(7));
    });

    expect(received).toEqual([{ operation: OPERATION, providerSeq: 1, event: { kind: 'progress', message: 'tick' } }]);
    expect(reply).toEqual({ id: 7, jsonrpc: '2.0', result: { kind: 'ack', committedThroughProviderSeq: 1 } });
  });

  it('accepts all four encoded proxy-emergency frames through the real strict receiver', async () => {
    const received: unknown[] = [];
    const handler: ProviderEventHandler = (request) => {
      received.push(request);
      return { kind: 'ack', committedThroughProviderSeq: request.providerSeq };
    };
    const { socketPath, sockets } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000, handler);
    cleanups.push(() => client.close());
    const serverSocket = await waitForAccept(sockets);
    const lengths: number[] = [];

    for (const reason of providerProxyReplayFailureReasonSchema.options) {
      const request = providerEventRequestSchema.parse({
        operation: OPERATION,
        providerSeq: Number.MAX_SAFE_INTEGER,
        event: providerProxyEmergencyEvent({ reason }),
      });
      const frame = encodeProxyControlFrame({
        jsonrpc: '2.0',
        id: Number.MAX_SAFE_INTEGER,
        method: PROVIDER_EVENT_METHOD,
        params: request,
      });
      lengths.push(Buffer.byteLength(frame, 'utf8'));

      const reply = new Promise<{ result?: unknown }>((resolve) => {
        serverSocket.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8').split('\n')[0])));
      });
      serverSocket.write(frame);
      await expect(reply).resolves.toEqual({
        jsonrpc: '2.0',
        id: Number.MAX_SAFE_INTEGER,
        result: { kind: 'ack', committedThroughProviderSeq: Number.MAX_SAFE_INTEGER },
      });
    }

    expect(lengths).toEqual([633, 632, 635, 641]);
    expect(received).toHaveLength(4);
  });

  it('refuses provider.event.v1 params that fail strict validation without invoking the handler', async () => {
    const handler = vi.fn<ProviderEventHandler>(() => ({ kind: 'ack', committedThroughProviderSeq: 1 }));
    const { socketPath, sockets } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000, handler);
    cleanups.push(() => client.close());
    const serverSocket = await waitForAccept(sockets);

    const refusal = await new Promise<{ error: { data?: { code?: string } } }>((resolve) => {
      serverSocket.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8').split('\n')[0])));
      // providerSeq must be a positive integer; 0 fails the schema.
      serverSocket.write(providerEventFrame(1, { providerSeq: 0 }));
    });

    expect(refusal.error.data?.code).toBe('invalid_request');
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports a handler rejection as a protocol_violation error response', async () => {
    const handler: ProviderEventHandler = () => {
      throw new Error('durable commit failed');
    };
    const { socketPath, sockets } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000, handler);
    cleanups.push(() => client.close());
    const serverSocket = await waitForAccept(sockets);

    const refusal = await new Promise<{ error: { message: string; data?: { code?: string } } }>((resolve) => {
      serverSocket.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8').split('\n')[0])));
      serverSocket.write(providerEventFrame(1));
    });

    expect(refusal.error.data?.code).toBe('protocol_violation');
    expect(refusal.error.message).toBe('durable commit failed');
  });

  it('surfaces the server error data.code as protocolCode on the rejected error', async () => {
    const { socketPath, sockets } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000);
    cleanups.push(() => client.close());
    const serverSocket = await waitForAccept(sockets);
    respondToNextRequest(serverSocket, (id) => ({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32_600,
        message: 'Control admission was refused (control-active).',
        data: { code: 'invalid_state', reason: 'control-active' },
      },
    }));

    let observed: unknown;
    try {
      await client.call('role.redeem.v1', {}, 5_000);
    } catch (error: unknown) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(ControlClientError);
    expect((observed as ControlClientError).code).toBe('control_call_failed');
    expect((observed as ControlClientError).protocolCode).toBe('invalid_state');
  });

  it('ignores a data.code the closed set does not recognize', async () => {
    const { socketPath, sockets } = await startTestServer();
    const client = await connectControlClient(socketPath, manualTimer(), 5_000);
    cleanups.push(() => client.close());
    const serverSocket = await waitForAccept(sockets);
    respondToNextRequest(serverSocket, (id) => ({
      jsonrpc: '2.0',
      id,
      error: { code: -32_600, message: 'Not from this endpoint.', data: { code: 'not_a_real_code' } },
    }));

    let observed: unknown;
    try {
      await client.call('role.redeem.v1', {}, 5_000);
    } catch (error: unknown) {
      observed = error;
    }

    expect((observed as ControlClientError).protocolCode).toBeUndefined();
  });
});
