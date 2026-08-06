import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createBootstrapNonceCredential } from '#src/provider-proxy/bootstrap-capsule.js';
import {
  createControlEndpoint,
  type ControlChallenge,
  type ControlEndpoint,
  type ControlEndpointRole,
  type ControlMethod,
} from '#src/provider-proxy/control-endpoint.js';

const BOOTSTRAP_NONCE = 'a'.repeat(64);

type Client = Readonly<{
  call(
    method: string,
    params: unknown,
  ): Promise<{
    result?: unknown;
    error?: { code: number; message: string; data?: { code?: string; reason?: string } };
  }>;
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
  options: { echo?: (params: unknown) => void; pairing?: ControlEndpointRole['pairing'] } = {},
): Promise<{
  endpoint: ControlEndpoint;
  socketPath: string;
  observer: { onControlLost: ReturnType<typeof vi.fn> };
  challenges: ControlChallenge[];
  accepted: ControlChallenge[];
  /** Lapses the lease without an EOF, which is how a wedged coordinator loses control. */
  lapseControl(): void;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'coral-ctl-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'c.sock');
  const challenges: ControlChallenge[] = [];
  const accepted: ControlChallenge[] = [];
  let outstanding: ControlChallenge | null = null;
  let controlLive = false;
  let minted = 0;
  // Mirrors the real wiring: an observed EOF is control loss, and the deadline machine is what records it.
  const observer = { onControlLost: vi.fn(() => (controlLive = false)) };

  const bootstrapNonce = createBootstrapNonceCredential(BOOTSTRAP_NONCE);
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
              bootstrapNonce.spend((params as { bootstrapNonce?: unknown } | null)?.bootstrapNonce);
              return { role: 'guardian' };
            },
          },
        ],
        ['role.work.v1', { authority: 'active', handle: () => ({ state: 'worked' }) }],
        // A second opening method with its own credential — the successor's analogue of a handoff grant.
        [
          'role.redeem.v1',
          {
            authority: 'establishes-control',
            handle: () => ({ role: 'successor' }),
          },
        ],
        [
          'role.echo.v1',
          {
            authority: 'active',
            handle: (params) => {
              options.echo?.(params);
              return { state: 'worked' };
            },
          },
        ],
        // Throws a raw ZodError, unwrapped — the shape a real role produces from its own `.parse()` calls,
        // which control-endpoint.ts must map to the closed set without knowing anything about zod or roles.
        [
          'role.strict.v1',
          {
            authority: 'active',
            handle: (params) =>
              z
                .object({
                  a: z.string(),
                  b: z.string(),
                  c: z.string(),
                  d: z.string(),
                  e: z.string(),
                  f: z.string(),
                  g: z.string(),
                  h: z.string(),
                })
                .parse(params),
          },
        ],
      ]),
      pairing: options.pairing,
    },
    // A minimal stand-in for the deadline machine: it owns the outstanding challenge and consumes it on a
    // matching echo, which is the property the endpoint depends on.
    challenges: {
      // Control liveness is tracked apart from the outstanding challenge, because the real machine ends
      // control two ways: an observed EOF, and a lease that lapses while the socket is still open.
      controlIsLive: () => controlLive,
      issueFirstChallenge: (challenge) => {
        outstanding = challenge;
        controlLive = true;
        return { accepted: true };
      },
      admitSuccessor: (challenge) => {
        if (controlLive) return { accepted: false, reason: 'control-active' };
        outstanding = challenge;
        controlLive = true;
        return { accepted: true };
      },
      echoChallenge: (challenge, nextChallenge) => {
        if (outstanding === null || challenge !== outstanding) return { accepted: false, reason: 'challenge-mismatch' };
        outstanding = nextChallenge;
        // Round-trip evidence pushes control loss into the future, so an echo revives a lapsed lease.
        controlLive = true;
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
  return {
    endpoint,
    socketPath,
    observer,
    challenges,
    accepted,
    lapseControl: () => {
      controlLive = false;
    },
  };
}

function connect(socketPath: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const pending = new Map<
      number,
      (value: { result?: unknown; error?: { code: number; message: string; data?: { code?: string } } }) => void
    >();
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

    // The consumed challenge cannot re-earn evidence. "not accepted" is the wrapper text every refusal
    // reason shares, so assert the specific reason this authority actually reported instead.
    const replay = await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });
    expect(replay.error?.message).toContain('challenge-mismatch');
    expect(replay.error?.data?.code).toBe('invalid_request');
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

  it('refuses a successor whose credential arrives after the incumbent reasserts control', async () => {
    const set = await startEndpoint();
    const incumbent = await connect(set.socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    // The lease lapses, so the successor's connection is admitted rather than refused at accept.
    set.lapseControl();
    const successor = await connect(set.socketPath);
    // ...and then the incumbent's heartbeat lands first, reviving its control before the redeem arrives.
    await incumbent.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    const refused = await successor.call('role.redeem.v1', {});

    // A valid credential is not a licence to displace a coordinator that is merely slow. Accept-time
    // refusal cannot cover this race, so admission is where the deadline machine gets the final word.
    expect(refused.error?.message).toContain('control-active');
    expect(refused.error?.data?.code).toBe('invalid_state');
    // 'invalid_state' alone cannot tell "retry" from "give up" — the reason has to travel as its own
    // structured field, not only inside the human-readable message, for a caller to act on it.
    expect(refused.error?.data?.reason).toBe('control-active');
    expect(set.endpoint.currentEpoch()).toBe(1);
  });

  it('hands a successor the next epoch once control has lapsed, without reporting the new tenancy lost', async () => {
    const { socketPath, observer, endpoint } = await startEndpoint();
    const incumbent = await connect(socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    // Control lapses the way the deadline machine sees it: the outstanding challenge goes unanswered.
    incumbent.close();
    await vi.waitFor(() => expect(observer.onControlLost).toHaveBeenCalledExactlyOnceWith(1));

    const successor = await connect(socketPath);
    const redeemed = await successor.call('role.redeem.v1', {});

    expect(redeemed.result).toEqual({ role: 'successor', controlEpoch: 2, heartbeatChallenge: 'challenge-2' });
    const beat = await successor.call('role.heartbeat.v1', { controlEpoch: 2, heartbeatChallenge: 'challenge-2' });
    expect(beat.result).toEqual({ state: 'active', nextHeartbeatChallenge: 'challenge-3' });
    // The predecessor's socket must not be able to report a loss that lands on the successor's tenancy.
    expect(observer.onControlLost).toHaveBeenCalledExactlyOnceWith(1);
    expect(endpoint.currentEpoch()).toBe(2);
  });

  it('destroys the displaced connection without ending the tenancy that replaced it', async () => {
    const set = await startEndpoint();
    const { socketPath, observer, endpoint } = set;
    const incumbent = await connect(socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await incumbent.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });
    // A wedged predecessor: its lease lapses while its socket stays open, so socket liveness and control
    // liveness disagree — the case a successor could never get past when admission read the socket.
    set.lapseControl();

    const successor = await connect(socketPath);
    await successor.call('role.redeem.v1', {});

    await vi.waitFor(() => expect(incumbent.socket.destroyed).toBe(true));
    // Recording the replacement before destroying the predecessor is what keeps its close from being read
    // as a control loss at all: the tenancy it would name is already gone, and reporting one here would
    // hand the deadline machine an EOF that collapses the successor's own control window.
    expect(observer.onControlLost).not.toHaveBeenCalled();
    expect(endpoint.currentEpoch()).toBe(2);
  });

  it('refuses a second tenancy on the connection that already holds one', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    const second = await client.call('role.redeem.v1', {});

    // Establishing here would destroy the displaced socket, which is this very connection.
    expect(second.error?.message).toContain('already holds a control tenancy');
    expect(client.socket.destroyed).toBe(false);
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

  it('does not hang close() on a connection that was accepted but never claimed a slot', async () => {
    const { socketPath, endpoint } = await startEndpoint();
    // Connects and sends nothing: never opens, never pairs. Before every accepted socket was tracked, close()
    // awaited server.close()'s callback, which Node fires only once every existing connection has ended —
    // and this one would never end on its own.
    await connect(socketPath);

    const closed = await Promise.race([
      endpoint.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);

    expect(closed).toBe(true);
  });

  it('refuses establishing control from the socket that already holds pairing', async () => {
    const { socketPath } = await startEndpoint({ pairing: { openMethod: 'role.pair.v1', secret: 'shared-secret' } });
    const client = await connect(socketPath);

    const paired = await client.call('role.pair.v1', { pairingSecret: 'shared-secret' });
    expect(paired.result).toEqual({ state: 'paired' });

    // The mirror of the already-covered "control may not also pair" direction: one connection holding both
    // authorities would collapse the distinction the two-ACK staging rule depends on, whichever order it
    // claims them in.
    const opened = await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    expect(opened.error?.message).toContain('may not also open control');
    expect(opened.error?.data?.code).toBe('unauthorized_control');
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
      echo: (params: unknown) => {
        received.push(params);
      },
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

  it('reports a handler-thrown ZodError under the closed set rather than leaking it raw', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    // Missing every required field, so the ZodError this throws pretty-prints as a multi-issue JSON dump —
    // exactly the shape that must not reach the wire as the whole payload.
    const failed = await client.call('role.strict.v1', {});

    expect(failed.error?.code).toBe(-32_600);
    expect(failed.error?.data?.code).toBe('protocol_violation');
    // Bounded, not the raw dump verbatim: eight missing-field issues pretty-print to well over this length.
    expect(failed.error?.message.length ?? 0).toBeLessThanOrEqual(203);
  });
});
