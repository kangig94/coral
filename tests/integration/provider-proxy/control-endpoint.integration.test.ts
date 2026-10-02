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
  const operator = vi.fn(() => ({ state: 'abandoned' }));
  const nonce = createBootstrapNonceCredential(BOOTSTRAP_NONCE);
  const redemptions = new Map<string, { role: string; redemptionReceipt: string }>();
  const endpoint = createControlEndpoint({
    socketPath,
    role: {
      heartbeatMethod: 'role.heartbeat.v1',
      pairing: { openMethod: 'role.pair.v1', secret: 'shared-secret' },
      methods: new Map<string, ControlMethod>([
        ['role.operator.v1', { authority: 'operator', handle: operator }],
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
    operator,
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

it('refuses operator abandonment while coordinator control is live', async () => {
  const set = await startEndpoint();
  const incumbent = await connect(set.socketPath);
  await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
  const pairing = await connect(set.socketPath);
  await pairing.call('role.pair.v1', { pairingSecret: 'shared-secret' });
  const provisional = await connect(set.socketPath);

  await expect(provisional.call('role.operator.v1', {})).resolves.toMatchObject({
    error: { data: { code: 'invalid_state' } },
  });
  expect(set.operator).not.toHaveBeenCalled();
});

it('keeps a provisionally accepted socket when successor control is admitted after expiry', async () => {
  const set = await startEndpoint();
  const incumbent = await connect(set.socketPath);
  await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
  const pairing = await connect(set.socketPath);
  await pairing.call('role.pair.v1', { pairingSecret: 'shared-secret' });
  const provisional = await connect(set.socketPath);
  set.lapseControl();

  const opened = await provisional.call('role.redeem.v1', { successorId: 'successor' });
  const control = opened.result as { controlEpoch: number; heartbeatChallenge: string };
  await expect(
    provisional.call('role.heartbeat.v1', {
      controlEpoch: control.controlEpoch,
      heartbeatChallenge: control.heartbeatChallenge,
    }),
  ).resolves.toMatchObject({ result: { state: 'active' } });
  await expect(provisional.call('role.echo.v1', {})).resolves.toMatchObject({ result: { state: 'worked' } });
});
