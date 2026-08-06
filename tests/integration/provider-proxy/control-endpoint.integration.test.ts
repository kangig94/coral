import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createControlEndpoint,
  type ControlChallenge,
  type ControlEndpoint,
  type ControlEndpointRole,
} from '#src/provider-proxy/control-endpoint.js';

const BOOTSTRAP_NONCE = 'a'.repeat(64);

type Client = Readonly<{
  call(method: string, params: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  socket: Socket;
  close(): void;
}>;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function realTimer() {
  return {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
  };
}

async function startEndpoint(
  overrides: Partial<ControlEndpointRole> = {},
  observer = { onControlLost: vi.fn() },
): Promise<{
  endpoint: ControlEndpoint;
  socketPath: string;
  observer: { onControlLost: ReturnType<typeof vi.fn> };
  challenges: ControlChallenge[];
  accepted: ControlChallenge[];
}> {
  const directory = mkdtempSync(join(tmpdir(), 'coral-ctl-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'c.sock');
  const challenges: ControlChallenge[] = [];
  const accepted: ControlChallenge[] = [];
  let outstanding: ControlChallenge | null = null;
  let minted = 0;

  const endpoint = createControlEndpoint({
    socketPath,
    role: {
      openMethod: 'role.open.v1',
      heartbeatMethod: 'role.heartbeat.v1',
      bootstrapNonce: BOOTSTRAP_NONCE,
      openResult: () => ({ role: 'guardian' }),
      methods: new Map([['role.work.v1', () => ({ state: 'worked' })]]),
      ...overrides,
    },
    // A minimal stand-in for the deadline machine: it owns the outstanding challenge and consumes it on a
    // matching echo, which is the property the endpoint depends on.
    challenges: {
      issueFirstChallenge: (challenge) => {
        outstanding = challenge;
        return { accepted: true };
      },
      echoChallenge: (challenge, nextChallenge) => {
        if (outstanding === null || challenge !== outstanding) return { accepted: false, reason: 'challenge-mismatch' };
        outstanding = nextChallenge;
        accepted.push(challenge);
        return { accepted: true };
      },
    },
    observer,
    timer: realTimer(),
    mintChallenge: () => {
      minted += 1;
      const challenge = `challenge-${minted}`;
      challenges.push(challenge);
      return challenge;
    },
    requestTimeoutMs: 5_000,
  });

  await endpoint.listen();
  cleanups.push(() => endpoint.close());
  return { endpoint, socketPath, observer, challenges, accepted };
}

function connect(socketPath: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const pending = new Map<number, (value: { result?: unknown; error?: { code: number; message: string } }) => void>();
    let buffer = '';
    let nextId = 1;

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as { id: number | null; result?: unknown; error?: never };
        // A frame-level rejection carries id null; hand it to the oldest waiter so the test can assert it.
        const waiterId = message.id ?? [...pending.keys()][0];
        const resolveWaiter = waiterId === undefined ? undefined : pending.get(waiterId);
        if (resolveWaiter !== undefined && waiterId !== undefined) {
          pending.delete(waiterId);
          resolveWaiter(message);
        }
        newline = buffer.indexOf('\n');
      }
    });
    socket.once('error', reject);
    socket.once('connect', () => {
      const client: Client = {
        socket,
        close: () => socket.destroy(),
        call: (method, params) =>
          new Promise((resolveCall) => {
            const id = nextId;
            nextId += 1;
            pending.set(id, resolveCall);
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
          }),
      };
      cleanups.push(() => socket.destroy());
      resolve(client);
    });
  });
}

describe('provider-proxy control endpoint', () => {
  it('opens exactly one tenancy against the bootstrap nonce and spends it', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);

    const opened = await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    expect(opened.result).toEqual({ role: 'guardian', controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    const replayed = await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    expect(replayed.error?.message).toContain('already spent');
  });

  it('refuses an open that does not present the nonce and establishes no tenancy', async () => {
    const { socketPath, endpoint } = await startEndpoint();
    const client = await connect(socketPath);

    const refused = await client.call('role.open.v1', { bootstrapNonce: 'b'.repeat(64) });

    expect(refused.error?.message).toContain('did not present the bootstrap nonce');
    expect(endpoint.currentEpoch()).toBeNull();
  });

  it('activates on a matching echo, rotates the challenge, and reports round-trip evidence once', async () => {
    const set = await startEndpoint();
    const client = await connect(set.socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    const beat = await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    expect(beat.result).toEqual({ state: 'active', nextHeartbeatChallenge: 'challenge-2' });
    expect(set.accepted).toEqual(['challenge-1']);

    // The consumed challenge cannot re-earn evidence.
    const replay = await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });
    expect(replay.error?.message).toContain('not accepted');
    expect(set.accepted).toEqual(['challenge-1']);
  });

  it('rejects a heartbeat carrying a foreign epoch', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    const wrongEpoch = await client.call('role.heartbeat.v1', { controlEpoch: 2, heartbeatChallenge: 'challenge-1' });

    expect(wrongEpoch.error?.message).toContain('did not name this control tenancy');
  });

  it('serves role methods only once control is active', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    const provisional = await client.call('role.work.v1', {});
    expect(provisional.error?.message).toContain('requires active control');

    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });
    const active = await client.call('role.work.v1', {});
    expect(active.result).toEqual({ state: 'worked' });
  });

  it('reports an unknown method as method-not-found', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);

    const unknown = await client.call('role.absent.v1', {});

    expect(unknown.error?.code).toBe(-32_601);
  });

  it('refuses a second concurrent connection instead of queueing it', async () => {
    const { socketPath } = await startEndpoint();
    const first = await connect(socketPath);
    await first.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    const second = await connect(socketPath);
    const closed = await new Promise<boolean>((resolve) => {
      second.socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 1_000);
    });

    expect(closed).toBe(true);
    expect(first.socket.destroyed).toBe(false);
  });

  it('reports control loss with the epoch that ended', async () => {
    const { socketPath, observer, endpoint } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    client.close();
    await vi.waitFor(() => expect(observer.onControlLost).toHaveBeenCalledExactlyOnceWith(1));
    expect(endpoint.currentEpoch()).toBeNull();
  });

  it('destroys a connection whose accumulating frame passes the cap before any newline', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);

    // No newline, so the reader must bound the pending buffer rather than waiting for a terminator.
    client.socket.write('x'.repeat(17 * 1024 * 1024 + 1));

    const closed = await new Promise<boolean>((resolve) => {
      client.socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 5_000);
    });
    expect(closed).toBe(true);
  });

  it('carries a multi-byte payload intact when its frame is split across socket writes', async () => {
    const received: unknown[] = [];
    const set = await startEndpoint({
      methods: new Map([
        [
          'role.echo.v1',
          (params) => {
            received.push(params);
            return { state: 'worked' };
          },
        ],
      ]),
    });
    const client = await connect(set.socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    // Split the frame mid-character. Decoding each chunk on its own would replace the straddling bytes with
    // U+FFFD, and the damage would sit inside a JSON string where JSON.parse and strict validation both
    // still succeed — silent corruption rather than a rejected frame.
    const text = '안녕하세요 🌊 provider prompt';
    const frame = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'role.echo.v1', params: { text } })}\n`,
    );
    const cut = frame.indexOf(Buffer.from('안')) + 1;
    client.socket.write(frame.subarray(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.socket.write(frame.subarray(cut));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ text });
  });

  it('destroys a connection that sends a frame failing strict JSON-RPC validation', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);

    client.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'role.open.v1', extra: true })}\n`);

    const closed = await new Promise<boolean>((resolve) => {
      client.socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 5_000);
    });
    expect(closed).toBe(true);
  });
});
