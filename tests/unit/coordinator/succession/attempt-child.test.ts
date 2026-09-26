import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { receiveSuccessionAttemptChild } from '#src/coordinator/succession/attempt-child.js';
import { createRealTimePort } from '#src/infra/time.js';
import type { SuccessionAttemptPorts } from '#src/runtime/succession-attempt.js';
import type { IpcListener } from '#src/transport/ipc/server.js';

const ATTEMPT_ID = '00000000-0000-4000-8000-000000000002';

type FakeChannel = SuccessionAttemptPorts['channel'] & {
  deliver(message: unknown, handle?: unknown): void;
  sent: unknown[];
  failures: boolean[];
};

function fakePorts(env: Record<string, string> = { CORAL_SUCCESSION_ATTEMPT_ID: ATTEMPT_ID }, available = true) {
  const events = new EventEmitter();
  const channel: FakeChannel = {
    available,
    connected: true,
    sent: [],
    failures: [],
    send: (message, callback) => {
      channel.sent.push(message);
      callback?.(null);
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
    },
    fail: (serving) => {
      channel.failures.push(serving);
    },
    deliver: (message, handle) => {
      events.emit('message', message, handle);
    },
  };
  const ports: SuccessionAttemptPorts = {
    time: createRealTimePort(),
    spawn: () => {
      throw new Error('a received attempt never spawns');
    },
    processIncarnation: () => null,
    env: (name) => env[name],
    channel,
  };
  return { ports, channel };
}

function start(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'start',
    attemptId: ATTEMPT_ID,
    bootToken: 'boot-token',
    socketPaths: ['/run/coral.sock'],
    epochKey: 'lineage:7',
    receiptIds: ['receipt-1'],
    recovery: false,
    ...overrides,
  };
}

async function settled<T>(promise: Promise<T>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  return done;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('succession attempt child channel', () => {
  it('should not treat a process without an attempt id as an attempt child', async () => {
    await expect(receiveSuccessionAttemptChild(fakePorts({}).ports)).resolves.toBeNull();
  });

  it('should refuse an attempt child that has no private channel', async () => {
    await expect(receiveSuccessionAttemptChild(fakePorts(undefined, false).ports)).rejects.toThrow(
      /private spawn channel/u,
    );
  });

  it('should wait through foreign and malformed start messages for its own well-formed start', async () => {
    const { ports, channel } = fakePorts();
    const received = receiveSuccessionAttemptChild(ports);

    channel.deliver(start({ attemptId: 'another-attempt' }));
    channel.deliver(start({ bootToken: undefined }));
    channel.deliver(start({ recovery: 'yes' }));
    channel.deliver({ kind: 'start' });
    channel.deliver('not an object');
    expect(await settled(received)).toBe(false);

    channel.deliver(start({ recovery: true }));
    await expect(received).resolves.toMatchObject({
      attemptId: ATTEMPT_ID,
      bootToken: 'boot-token',
      epochKey: 'lineage:7',
      receiptIds: ['receipt-1'],
      recovery: true,
    });
    expect(channel.failures).toEqual([]);
  });

  it('should fail the attempt on an abort before serving', async () => {
    const { ports, channel } = fakePorts();
    const received = receiveSuccessionAttemptChild(ports);
    channel.deliver(start());
    await received;

    channel.deliver({ kind: 'abort', attemptId: 'another-attempt' });
    expect(channel.failures).toEqual([]);
    channel.deliver({ kind: 'abort', attemptId: ATTEMPT_ID });
    expect(channel.failures).toEqual([false]);
  });

  it('should fail the attempt once a finite commit deadline passes, and ignore a non-finite one', async () => {
    const { ports, channel } = fakePorts();
    const received = receiveSuccessionAttemptChild(ports);
    channel.deliver(start());
    await received;

    channel.deliver({ kind: 'deadline', attemptId: ATTEMPT_ID, at: Number.NaN });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(channel.failures).toEqual([]);

    channel.deliver({ kind: 'deadline', attemptId: ATTEMPT_ID, at: Date.now() + 5 });
    await vi.waitFor(() => expect(channel.failures).toEqual([false]));
  });

  it('should refuse a listener for an address outside its claim before adopting anything', async () => {
    const { ports, channel } = fakePorts();
    const received = receiveSuccessionAttemptChild(ports);
    channel.deliver(start());
    const child = await received;
    if (child === null) throw new Error('expected an attempt child');
    const listener = { compatibilityListeners: [] } as unknown as IpcListener;
    const adoption = child.adoptListeners(listener);
    const rejected = expect(adoption).rejects.toThrow(/unclaimed IPC listener/u);

    channel.deliver({ kind: 'listener', attemptId: ATTEMPT_ID, socketPath: '/run/other.sock' }, {});

    await rejected;
    expect(channel.failures).toEqual([false]);
    expect(channel.sent).not.toContainEqual(expect.objectContaining({ kind: 'listener-accepted' }));
  });
});
