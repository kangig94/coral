import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSuccessionAttemptChannel,
  receiveSuccessionAttemptChild,
} from '#src/coordinator/succession/attempt-child.js';
import { createRealTimePort } from '#src/infra/time.js';
import type { SuccessionAttemptPorts } from '#src/runtime/succession-attempt.js';
import type { IpcListener } from '#src/transport/ipc/server.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const ATTEMPT_ID = '00000000-0000-4000-8000-000000000002';

type FakeChannel = SuccessionAttemptPorts['channel'] & {
  deliver(message: unknown, handle?: unknown): void;
  sent: unknown[];
  handles: unknown[];
  failures: boolean[];
};

function fakePorts(env: Record<string, string> = { CORAL_SUCCESSION_ATTEMPT_ID: ATTEMPT_ID }, available = true) {
  const events = new EventEmitter();
  const channel: FakeChannel = {
    available,
    connected: true,
    sent: [],
    handles: [],
    failures: [],
    send: (message, callback) => {
      channel.sent.push(message);
      callback?.(null);
    },
    sendHandle: (message, handle, callback) => {
      channel.sent.push(message);
      channel.handles.push(handle);
      callback(null);
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

/** A listener whose accepted connections go to whatever forward is installed, as the IPC listener's do. */
function parkingListener(): IpcListener & { park(socket: unknown, pendingFrameBase64: string): void } {
  let forward: ((socket: never, pendingFrameBase64: string) => void) | null = null;
  const served = vi.fn();
  const listener = {
    server: { listening: false },
    compatibilityListeners: [],
    acceptSocket: (socket: never, pendingFrameBase64 = '') =>
      forward === null ? served(socket, pendingFrameBase64) : forward(socket, pendingFrameBase64),
    forwardConnections: (next: (socket: never, pendingFrameBase64: string) => void) => {
      forward = next;
      return () => {
        forward = null;
      };
    },
    park: (socket: unknown, pendingFrameBase64: string) => listener.acceptSocket(socket as never, pendingFrameBase64),
  };
  return listener as unknown as IpcListener & { park(socket: unknown, pendingFrameBase64: string): void };
}

async function adoptedChild(channel: FakeChannel, ports: SuccessionAttemptPorts) {
  const received = receiveSuccessionAttemptChild(ports);
  channel.deliver(start());
  const child = await received;
  if (child === null) throw new Error('expected an attempt child');
  const listener = parkingListener();
  const adoption = child.adoptListeners(listener);
  channel.deliver({ kind: 'listener', attemptId: ATTEMPT_ID, socketPath: '/run/coral.sock' }, { on: vi.fn() });
  channel.deliver({ kind: 'listeners-complete', attemptId: ATTEMPT_ID });
  await adoption;
  return listener;
}

describe('succession attempt child channel', () => {
  it('should wait for a forwarded handle send callback before draining the incumbent', async () => {
    const events = new EventEmitter();
    const callbacks: {
      forward?: (socket: Socket, pendingFrameBase64: string) => void;
      finishSend?: () => void;
    } = {};
    const child = Object.assign(events, {
      pid: process.pid,
      connected: true,
      send: (message: { kind: string; socketPath?: string }, handle: unknown, callback: (error: null) => void) => {
        if (message.kind === 'connection') callbacks.finishSend = () => callback(null);
        else {
          callback(null);
          queueMicrotask(() => {
            if (message.kind === 'start') events.emit('message', { kind: 'listener-ready', attemptId: ATTEMPT_ID });
            if (message.kind === 'listener') {
              events.emit('message', {
                kind: 'listener-accepted',
                attemptId: ATTEMPT_ID,
                socketPath: message.socketPath,
              });
            }
            if (message.kind === 'listeners-complete')
              events.emit('message', { kind: 'listeners-accepted', attemptId: ATTEMPT_ID });
          });
        }
        void handle;
        return true;
      },
    });
    const listener = {
      server: { listening: true },
      socketPath: '/run/coral.sock',
      compatibilityListeners: [],
      forwardConnections: (callback: (socket: Socket, pendingFrameBase64: string) => void) => {
        callbacks.forward = callback;
        return () => {
          callbacks.forward = undefined;
        };
      },
      drainConnections: async () => undefined,
    } as unknown as IpcListener;
    const creating = createSuccessionAttemptChannel(
      { ...fakePorts().ports, processIncarnation: () => testIncarnation(process.pid) },
      child as unknown as Parameters<typeof createSuccessionAttemptChannel>[1],
      ATTEMPT_ID,
      listener,
      'boot-token',
      { epochKey: 'lineage:7', receipts: [] },
    );
    events.emit('message', { kind: 'child-online', attemptId: ATTEMPT_ID });
    const attempt = await creating;
    await attempt.transferListeners(listener);
    attempt.forwardConnections(listener);
    const socket = new Socket();
    callbacks.forward?.(socket, '');

    const draining = attempt.drainIncumbentConnections(listener);
    expect(await settled(draining)).toBe(false);
    callbacks.finishSend?.();
    await expect(draining).resolves.toBeUndefined();
    socket.destroy();

    const stalled = new Socket();
    callbacks.forward?.(stalled, '');
    await attempt.drainIncumbentConnections(listener, 5);
    expect(stalled.destroyed).toBe(true);
    callbacks.finishSend?.();
  });

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
    await vi.waitFor(() => expect(channel.failures).toEqual([false]));
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
    await vi.waitFor(() => expect(channel.sent).toContainEqual({ kind: 'release-request', attemptId: ATTEMPT_ID }));
    expect(channel.failures).toEqual([]);
    channel.deliver({ kind: 'release-ready', attemptId: ATTEMPT_ID });
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

  it('should return every connection it parked to the incumbent before an abort ends it', async () => {
    const { ports, channel } = fakePorts();
    const listener = await adoptedChild(channel, ports);
    channel.deliver({ kind: 'deadline', attemptId: ATTEMPT_ID, at: Date.now() + 60_000 });
    const forwarded = { pause: vi.fn() };
    const accepted = { pause: vi.fn() };
    channel.deliver(
      { kind: 'connection', attemptId: ATTEMPT_ID, socketPath: '/run/coral.sock', pendingFrameBase64: 'e30=' },
      forwarded,
    );
    listener.park(accepted, '');
    expect(channel.handles).toEqual([]);

    channel.deliver({ kind: 'abort', attemptId: ATTEMPT_ID });

    await vi.waitFor(() => expect(channel.failures).toEqual([false]));
    expect(channel.handles).toEqual(expect.arrayContaining([forwarded, accepted]));
    const returned = channel.sent.filter((message) => (message as { kind?: string }).kind === 'connection');
    expect(returned).toEqual(
      expect.arrayContaining([
        { kind: 'connection', attemptId: ATTEMPT_ID, socketPath: '/run/coral.sock', pendingFrameBase64: 'e30=' },
        { kind: 'connection', attemptId: ATTEMPT_ID, socketPath: '/run/coral.sock', pendingFrameBase64: '' },
      ]),
    );
    expect(channel.sent.at(-1)).toEqual({ kind: 'connections-released', attemptId: ATTEMPT_ID });
  });

  it('should acknowledge abort after returning sockets during a deadline release', async () => {
    const { ports, channel } = fakePorts();
    const listener = await adoptedChild(channel, ports);
    channel.deliver({ kind: 'deadline', attemptId: ATTEMPT_ID, at: Date.now() + 5 });
    const socket = new Socket();
    listener.park(socket, '');
    await vi.waitFor(() => expect(channel.sent).toContainEqual({ kind: 'release-request', attemptId: ATTEMPT_ID }));

    channel.deliver({ kind: 'abort', attemptId: ATTEMPT_ID });
    channel.deliver({ kind: 'release-ready', attemptId: ATTEMPT_ID });

    await vi.waitFor(() => expect(channel.failures).toEqual([false]));
    expect(channel.handles).toContain(socket);
    expect(channel.sent).toContainEqual({ kind: 'connections-released', attemptId: ATTEMPT_ID });
    socket.destroy();
  });

  it('should return a connection it accepts before its commit window opens, and keep serving its attempt', async () => {
    const { ports, channel } = fakePorts();
    const listener = await adoptedChild(channel, ports);
    const accepted = { pause: vi.fn() };

    listener.park(accepted, 'e30=');

    expect(channel.handles).toEqual([accepted]);
    expect(channel.sent).toContainEqual({
      kind: 'connection',
      attemptId: ATTEMPT_ID,
      socketPath: '/run/coral.sock',
      pendingFrameBase64: 'e30=',
    });
    expect(channel.failures).toEqual([]);
  });

  it.each([
    ['its own commit deadline', { kind: 'deadline', attemptId: ATTEMPT_ID, at: Date.now() + 5 }],
    ['a listener outside its claim', { kind: 'listener', attemptId: ATTEMPT_ID, socketPath: '/run/other.sock' }],
  ])('should return its parked connections while the channel lives when it fails on %s', async (_cause, failure) => {
    const { ports, channel } = fakePorts();
    await adoptedChild(channel, ports);
    channel.deliver({ kind: 'deadline', attemptId: ATTEMPT_ID, at: Date.now() + 60_000 });
    const forwarded = { pause: vi.fn() };
    channel.deliver(
      { kind: 'connection', attemptId: ATTEMPT_ID, socketPath: '/run/coral.sock', pendingFrameBase64: 'e30=' },
      forwarded,
    );
    expect(channel.handles).toEqual([]);

    channel.deliver(failure, {});

    await vi.waitFor(() => expect(channel.sent).toContainEqual({ kind: 'release-request', attemptId: ATTEMPT_ID }));
    expect(channel.handles).toEqual([]);
    channel.deliver({ kind: 'release-ready', attemptId: ATTEMPT_ID });

    await vi.waitFor(() => expect(channel.failures).toEqual([false]));
    expect(channel.handles).toEqual([forwarded]);
  });
});
