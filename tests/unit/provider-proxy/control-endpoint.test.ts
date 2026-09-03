import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as NodeJS.Timeout),
};

async function provisionalConnectionFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'coral-provisional-control-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
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
    const directory = mkdtempSync(join(tmpdir(), 'coral-operator-control-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const socketPath = join(directory, 'role.sock');
    let controlLive = false;
    const challenges: ControlChallengeAuthority = {
      issueFirstChallenge: () => {
        controlLive = true;
        return { accepted: true, challenge: 'challenge-1' };
      },
      admitSuccessor: () => ({ accepted: false, reason: 'control-active' }),
      reattachControl: () => ({ accepted: true }),
      controlIsLive: () => controlLive,
      echoChallenge: () => ({ accepted: true, nextChallenge: 'challenge-2' }),
    };
    const operator = vi.fn(() => ({ state: 'abandoned' }));
    const endpoint = createControlEndpoint({
      socketPath,
      role: {
        heartbeatMethod: 'role.heartbeat.v1',
        methods: new Map([
          [
            'role.open.v1',
            {
              authority: 'establishes-control' as const,
              handle: () => ({
                holder: { instanceId: randomUUID(), pid: 4_001, incarnation: testIncarnation(4_001) },
                fields: { state: 'opened' },
              }),
            },
          ],
          ['role.operator.v1', { authority: 'operator' as const, handle: operator }],
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
    const coordinator = await connect();
    const opened = await coordinator.exchange('role.open.v1', {}, 1_000);
    expect(opened.kind).toBe('response');

    const attempted = await connect();
    const refused = await attempted.exchange('role.operator.v1', {}, 1_000);

    expect(refused.kind).toBe('response');
    if (refused.kind !== 'response' || refused.response.kind !== 'refusal') {
      throw new Error('operator abandonment was not refused');
    }
    if (refused.response.failure.kind !== 'json-rpc-error') {
      throw new Error('operator abandonment did not return a protocol refusal');
    }
    expect(refused.response.failure.protocolCode).toBe('invalid_state');
    expect(refused.response.error.message).toContain(
      'provider-proxy-set contain <set-token> --abandon-without-absence',
    );
    expect(operator).not.toHaveBeenCalled();
  });
});

describe('control endpoint provisional admission', () => {
  it('evaluates operator authority when the first frame is dispatched', async () => {
    const fixture = await provisionalConnectionFixture();
    fixture.lapseControl();

    await expect(strictControlExchangeResult(fixture.provisional, 'role.operator.v1', {}, 1_000)).resolves.toEqual({
      state: 'abandoned',
    });
    expect(fixture.operator).toHaveBeenCalledOnce();
  });

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
