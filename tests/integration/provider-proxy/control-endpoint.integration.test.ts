import { once } from 'node:events';
import { createDeferred } from '#tools/testing/deferred.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBootstrapNonceCredential } from '#src/provider-proxy/bootstrap-capsule.js';
import {
  createControlEndpoint,
  type ControlChallengeAuthority,
  type ControlMethod,
  type ControlTenancyHolder,
} from '#src/provider-proxy/control-endpoint.js';
import { createControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';

const BOOTSTRAP_NONCE = 'a'.repeat(64);

/** Fixture holder identities must be deterministic and distinguish processes that share an instance id. */
function holderFor(instanceId: string, pid = 1): ControlTenancyHolder {
  return { instanceId, pid, incarnation: testIncarnation(`${instanceId}:${pid}`) };
}

type EndpointReply = {
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: { code?: string; reason?: string; heartbeatRefusal?: string; nextHeartbeatChallenge?: string };
  };
};

type Client = Readonly<{
  call(method: string, params: unknown): Promise<EndpointReply>;
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

async function startEndpoint(echo: (params: unknown) => void = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'coral-ctl-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'c.sock');
  let outstanding = '';
  let controlLive = false;
  let minted = 0;
  const mint = () => (outstanding = `challenge-${++minted}`);
  const observer = {
    onControlLost: vi.fn(() => {
      controlLive = false;
    }),
    onControlActive: vi.fn(),
  };
  const challengeAuthority: ControlChallengeAuthority = {
    controlIsLive: () => controlLive,
    issueFirstChallenge: () => {
      controlLive = true;
      return { accepted: true, challenge: mint() };
    },
    admitSuccessor: () =>
      controlLive ? { accepted: false, reason: 'control-active' } : { accepted: true, challenge: mint() },
    reattachControl: () => ({ accepted: true }),
    echoChallenge: (challenge) => {
      const matched = challenge === outstanding;
      const nextChallenge = mint();
      if (!matched) return { accepted: false, reason: 'challenge-mismatch', nextChallenge };
      controlLive = true;
      return { accepted: true, nextChallenge };
    },
  };
  const nonce = createBootstrapNonceCredential(BOOTSTRAP_NONCE);
  const redemptions = new Map<string, { role: string; redemptionReceipt: string }>();
  const endpoint = createControlEndpoint({
    socketPath,
    role: {
      heartbeatMethod: 'role.heartbeat.v1',
      methods: new Map<string, ControlMethod>([
        [
          'role.open.v1',
          {
            authority: 'establishes-control',
            handle: (params) => {
              nonce.spend((params as { bootstrapNonce: string }).bootstrapNonce);
              return { holder: holderFor('incumbent'), fields: { role: 'guardian' } };
            },
          },
        ],
        [
          'role.redeem.v1',
          {
            authority: 'establishes-control',
            handle: (params) => {
              const id = (params as { successorId?: string }).successorId ?? 'successor';
              if (!redemptions.has(id))
                redemptions.set(id, { role: 'successor', redemptionReceipt: `receipt-${redemptions.size + 1}` });
              return { holder: holderFor(id), fields: redemptions.get(id)! };
            },
          },
        ],
        [
          'role.echo.v1',
          {
            authority: 'active',
            handle: (params) => {
              echo(params);
              return { state: 'worked' };
            },
          },
        ],
      ]),
    },
    challenges: challengeAuthority,
    observer,
    timer: realTimer(),
    holderAuthority: createControlHolderAuthority(),
    requestTimeoutMs: 5_000,
  });
  await endpoint.listen();
  cleanups.push(() => endpoint.close());
  return {
    endpoint,
    socketPath,
    observer,
    lapseControl: () => {
      controlLive = false;
    },
  };
}

function connect(socketPath: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const pending = new Map<number, (value: EndpointReply) => void>();
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
      cleanups.push(() => {
        socket.destroy();
      });
      resolve(client);
    });
  });
}

describe('provider-proxy control endpoint', () => {
  it('returns the identical opening to a same-successor retry on a new socket, and keeps the first challenge live', async () => {
    const set = await startEndpoint();
    const { socketPath } = set;
    const incumbent = await connect(socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    set.lapseControl();

    const first = await connect(socketPath);
    const opened = await first.call('role.redeem.v1', { successorId: 'successor-new-socket' });
    expect(opened.result).toMatchObject({ role: 'successor', redemptionReceipt: expect.any(String) });

    // The reply never reached the successor — network partition, timeout, anything — so it retries on a
    // brand-new connection while the first is still open and its challenge still unechoed.
    const firstClosed = once(first.socket, 'close');
    const retry = await connect(socketPath);
    const retried = await retry.call('role.redeem.v1', { successorId: 'successor-new-socket' });

    // The severe defect: today this mints a fresh epoch and challenge, destroying the one the successor is
    // still holding — so the fix is proven by every field of the reply being byte-identical, including the
    // registry's own memoized receipt.
    expect(retried.result).toEqual(opened.result);

    // And proof the outstanding challenge itself survived, not just the reply: the exact challenge from the
    // *first* redemption is still the one this tenancy answers to.
    const { controlEpoch, heartbeatChallenge } = opened.result as { controlEpoch: number; heartbeatChallenge: string };
    expect(set.observer.onControlActive).not.toHaveBeenCalled();
    const beat = await retry.call('role.heartbeat.v1', { controlEpoch, heartbeatChallenge });
    expect(beat.result).toMatchObject({ state: 'active' });
    expect(set.observer.onControlActive).toHaveBeenCalledExactlyOnceWith(controlEpoch);

    // The superseded first connection is retired without being read as a loss of the tenancy it opened.
    await firstClosed;
    expect(set.observer.onControlLost).not.toHaveBeenCalled();
  });

  it('carries a multi-byte payload intact when its frame is split across socket writes', async () => {
    const received: unknown[] = [];
    const delivered = createDeferred<void>();
    const set = await startEndpoint((params) => {
      received.push(params);
      delivered.resolve();
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
    await new Promise<void>((resolve, reject) => {
      client.socket.write(frame.subarray(0, cut), (error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    client.socket.write(frame.subarray(cut));

    await delivered.promise;
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ text });
  });
});

/** A pre-encoded request frame `pushOnTenancy` can write — the shape any `provider.event.v1` push takes,
 *  though `pushOnTenancy` itself is transport-only and does not inspect `method`. */
function pushFrame(id: number): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method: 'provider.event.v1', params: { hello: 'world' } })}\n`;
}

describe('provider-proxy control endpoint: pushOnTenancy', () => {
  it('rejects a push outstanding on a predecessor connection rather than letting the successor answer it', async () => {
    const set = await startEndpoint();
    const { socketPath, endpoint } = set;
    const incumbent = await connect(socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await incumbent.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    const pushed = endpoint.pushOnTenancy(pushFrame(1), 5_000).response;
    // Attached in the same tick `pushed` is created: the rejection this test provokes below fires from a
    // socket 'close' callback several ticks later, and Node flags a promise as unhandled by whether a handler
    // was attached *before* that callback runs — not by whether one is attached eventually.
    const rejected = expect(pushed).rejects.toMatchObject({ code: 'control_endpoint_push_lost' });
    // The incumbent never answers; instead its lease lapses and a successor redeems while the push is still
    // outstanding — the epoch rotates, but the pending push was bound to the *socket* it was written on.
    set.lapseControl();
    const successor = await connect(socketPath);
    await successor.call('role.redeem.v1', {});

    // The predecessor's connection is destroyed on redemption, which is what must reject this push — a reply
    // arriving on the successor's own (different) socket could never satisfy it even without this cleanup,
    // but nothing here should leave it hanging either.
    await rejected;
  });
});
