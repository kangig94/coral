import type * as MockedNodeNetModule from 'node:net';
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof MockedNodeNetModule>();
  const { EventEmitter } = await import('node:events');
  const listeners = new Map<string, (socket: MemorySocket) => void>();
  class MemorySocket extends EventEmitter {
    destroyed = false;
    peer!: MemorySocket;
    write(data: string, done?: () => void): boolean {
      done?.();
      setImmediate(() => {
        if (!this.peer.destroyed) this.peer.emit('data', Buffer.from(data));
      });
      return true;
    }
    destroy(): this {
      if (this.destroyed) return this;
      this.destroyed = true;
      queueMicrotask(() => this.emit('close'));
      this.peer.destroy();
      return this;
    }
    end(data?: string, done?: () => void): this {
      if (data !== undefined) this.write(data);
      setImmediate(() => {
        done?.();
        this.destroy();
      });
      return this;
    }
  }
  return {
    ...actual,
    createServer: (accept: (socket: MemorySocket) => void) => {
      const server = new EventEmitter();
      let path = '';
      return Object.assign(server, {
        listen: (socketPath: string) => {
          path = socketPath;
          listeners.set(path, accept);
          queueMicrotask(() => server.emit('listening'));
        },
        close: (done: () => void) => {
          listeners.delete(path);
          done();
        },
      });
    },
    createConnection: (path: string) => {
      const client = new MemorySocket();
      const server = new MemorySocket();
      client.peer = server;
      server.peer = client;
      queueMicrotask(() => {
        const accept = listeners.get(path);
        if (accept === undefined) throw new Error(`No in-memory endpoint at ${path}`);
        accept(server);
        client.emit('connect');
      });
      return client;
    },
  };
});
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectControlClient, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createControlEndpoint, type ControlChallengeAuthority } from '#src/provider-proxy/control-endpoint.js';
import { createControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { strictControlExchangeResult } from '#tests/support/control-exchange.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const timer = {
  setTimeout: () => ({}),
  clearTimeout: () => {},
};

async function provisionalConnectionFixture() {
  const directory = '/control-test';
  const socketPath = join(directory, 'role.sock');
  let controlLive = false;
  let challenge = 0;
  const nextChallenge = () => `challenge-${++challenge}`;
  const challenges: ControlChallengeAuthority = {
    issueFirstChallenge: () => {
      controlLive = true;
      return { accepted: true, challenge: nextChallenge() };
    },
    admitSuccessor: () =>
      controlLive ? { accepted: false, reason: 'control-active' } : { accepted: true, challenge: nextChallenge() },
    reattachControl: () => ({ accepted: true }),
    controlIsLive: () => controlLive,
    echoChallenge: () => {
      controlLive = true;
      return { accepted: true, nextChallenge: nextChallenge() };
    },
  };
  const operator = vi.fn(() => ({ state: 'abandoned' }));
  const active = vi.fn(() => ({ state: 'active' }));
  const endpoint = createControlEndpoint({
    socketPath,
    role: {
      heartbeatMethod: 'role.heartbeat.v1',
      pairing: { openMethod: 'role.pair.v1', secret: 'shared-secret' },
      methods: new Map([
        [
          'role.open.v1',
          {
            authority: 'establishes-control' as const,
            handle: (params: unknown) => {
              const holder = params as { instanceId: string; pid: number };
              return {
                holder: {
                  instanceId: holder.instanceId,
                  pid: holder.pid,
                  incarnation: testIncarnation(holder.pid),
                },
                fields: { state: 'opened' },
              };
            },
          },
        ],
        ['role.operator.v1', { authority: 'operator' as const, handle: operator }],
        ['role.active.v1', { authority: 'active' as const, handle: active }],
      ]),
    },
    challenges,
    observer: { onControlLost: () => {} },
    timer,
    holderAuthority: createControlHolderAuthority(),
    requestTimeoutMs: 1_000,
  });
  await endpoint.listen();
  cleanups.push(() => endpoint.close());

  const clients: ControlClient[] = [];
  const connect = async (): Promise<ControlClient> => {
    const client = await connectControlClient(socketPath, timer, 1_000);
    clients.push(client);
    return client;
  };
  cleanups.push(() => clients.forEach((client) => client.close()));

  const incumbent = await connect();
  await strictControlExchangeResult(incumbent, 'role.open.v1', { instanceId: 'incumbent', pid: 4_001 }, 1_000);
  const pairing = await connect();
  await strictControlExchangeResult(pairing, 'role.pair.v1', { pairingSecret: 'shared-secret' }, 1_000);
  const provisional = await connect();

  return {
    active,
    lapseControl: () => {
      controlLive = false;
    },
    operator,
    provisional,
  };
}

describe('control endpoint operator authority', () => {
  it('refuses operator abandonment while coordinator control is live', async () => {
    const fixture = await provisionalConnectionFixture();
    const refused = await fixture.provisional.exchange('role.operator.v1', {}, 1000);
    expect(refused).toMatchObject({
      kind: 'response',
      response: {
        kind: 'refusal',
        failure: { kind: 'json-rpc-error', protocolCode: 'invalid_state' },
      },
    });
    expect(fixture.operator).not.toHaveBeenCalled();
  });
});

describe('control endpoint provisional admission', () => {
  it('keeps a provisionally accepted socket when successor control is admitted after expiry', async () => {
    const fixture = await provisionalConnectionFixture();
    fixture.lapseControl();

    const opened = (await strictControlExchangeResult(
      fixture.provisional,
      'role.open.v1',
      { instanceId: 'successor', pid: 4_002 },
      1_000,
    )) as { controlEpoch: number; heartbeatChallenge: string };
    await strictControlExchangeResult(
      fixture.provisional,
      'role.heartbeat.v1',
      {
        controlEpoch: opened.controlEpoch,
        heartbeatChallenge: opened.heartbeatChallenge,
      },
      1_000,
    );
    await expect(strictControlExchangeResult(fixture.provisional, 'role.active.v1', {}, 1_000)).resolves.toEqual({
      state: 'active',
    });
    expect(fixture.active).toHaveBeenCalledOnce();
  });
});
