import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectControlClient, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createControlEndpoint, type ControlChallengeAuthority } from '#src/provider-proxy/control-endpoint.js';
import { createControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const timer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as NodeJS.Timeout),
};

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
