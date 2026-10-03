import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSuccessionAttemptChannel,
  receiveSuccessionAttemptChild,
} from '#src/coordinator/succession/attempt-child.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
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
  const time = new VirtualTime();
  const ports: SuccessionAttemptPorts = {
    time,
    spawn: () => {
      throw new Error('a received attempt never spawns');
    },
    processIncarnation: () => null,
    env: (name) => env[name],
    channel,
  };
  return { ports, channel, time };
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

function fakeSocket(): Socket {
  const socket = {
    destroyed: false,
    pause: vi.fn(),
    destroy() {
      socket.destroyed = true;
    },
  };
  return socket as unknown as Socket;
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
  await flushMicrotasks();
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
    const { ports, time } = fakePorts();
    const creating = createSuccessionAttemptChannel(
      { ...ports, processIncarnation: () => testIncarnation(process.pid) },
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
    const socket = fakeSocket();
    callbacks.forward?.(socket, '');

    const draining = attempt.drainIncumbentConnections(listener);
    expect(await settled(draining)).toBe(false);
    callbacks.finishSend?.();
    await expect(draining).resolves.toBeUndefined();
    socket.destroy();

    const stalled = fakeSocket();
    callbacks.forward?.(stalled, '');
    const stalledDrain = attempt.drainIncumbentConnections(listener, 5);
    time.tick(5);
    await stalledDrain;
    expect(stalled.destroyed).toBe(true);
    callbacks.finishSend?.();
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
    const { ports, channel, time } = fakePorts();
    const listener = await adoptedChild(channel, ports);
    channel.deliver({ kind: 'deadline', attemptId: ATTEMPT_ID, at: time.now() + 60_000 });
    const forwarded = { pause: vi.fn() };
    const accepted = { pause: vi.fn() };
    channel.deliver(
      { kind: 'connection', attemptId: ATTEMPT_ID, socketPath: '/run/coral.sock', pendingFrameBase64: 'e30=' },
      forwarded,
    );
    listener.park(accepted, '');
    expect(channel.handles).toEqual([]);

    channel.deliver({ kind: 'abort', attemptId: ATTEMPT_ID });

    await flushMicrotasks();
    expect(channel.failures).toEqual([false]);
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
});

it('contains failed sends and disconnects under default Node rejection behavior, preserving early acknowledgments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-listener-transfer-'));
  try {
    symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'));
    const bundle = join(root, 'attempt.mjs');
    await build({
      entryPoints: ['src/coordinator/succession/attempt-child.ts'],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      loader: { '.sql': 'text' },
    });
    for (const mode of [
      'control',
      'listener',
      'listeners-complete',
      'disconnect-listener',
      'disconnect-listeners-complete',
      'abort',
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import assert from 'node:assert/strict';
        import { EventEmitter } from 'node:events';
        import { createSuccessionAttemptChannel } from ${JSON.stringify(pathToFileURL(bundle).href)};
        const mode = ${JSON.stringify(mode)};
        const child = Object.assign(new EventEmitter(), { pid: 12345, connected: true });
        const attemptId = 'probe';
        child.send = (message, handle, callback) => {
          if (mode === message.kind) { callback(new Error('send failed')); return; }
          if (mode === 'disconnect-' + message.kind) {
            child.emit('disconnect');
            setImmediate(() => callback(new Error('send failed')));
            return;
          }
          if (message.kind === 'listener') child.emit('message', { kind: 'listener-accepted', attemptId, socketPath: message.socketPath });
          if (message.kind === 'listeners-complete') child.emit('message', { kind: 'listeners-accepted', attemptId });
          callback(null);
        };
        const listener = { socketPath: '/tmp/mock.sock', server: { listening: true } };
        const creating = createSuccessionAttemptChannel({ processIncarnation: () => 'probe', time: { setTimeout, clearTimeout } }, child, attemptId, listener, 'boot', { epochKey: 'probe', receipts: [] });
        child.emit('message', { kind: 'child-online', attemptId });
        const attempt = await creating;
        child.emit('message', { kind: 'listener-ready', attemptId });
        if (mode === 'control') await attempt.transferListeners(listener);
        else if (mode === 'abort') await assert.rejects(attempt.abort(), /send failed/);
        else await assert.rejects(attempt.transferListeners(listener), /send failed|disconnected/);
        child.emit('disconnect');
        await new Promise(resolve => setImmediate(resolve));
        console.log('survived');
      `,
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', TMPDIR: tmpdir() },
        },
      );
      expect({ mode, status: result.status, stderr: result.stderr, error: result.error }).toEqual({
        mode,
        status: 0,
        stderr: '',
        error: undefined,
      });
      expect(result.stdout).toContain('survived');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([false, true])('bounds child parking with an additive elapsed budget (legacy: %s)', async (legacy) => {
  const { ports, channel, time } = fakePorts();
  await adoptedChild(channel, ports);
  const deadline = time.now() + 100;
  const wall = time.now.bind(time);
  if (!legacy) Object.assign(time, { now: () => wall() - 3_600_000 });
  channel.deliver({ kind: 'deadline', attemptId: ATTEMPT_ID, at: deadline, ...(legacy ? {} : { timeoutMs: 100 }) });
  time.tick(99);
  expect(channel.sent).not.toContainEqual(expect.objectContaining({ kind: 'release-request' }));
  time.tick(1);
  expect(channel.sent).toContainEqual({ kind: 'release-request', attemptId: ATTEMPT_ID });
  channel.deliver({ kind: 'release-ready', attemptId: ATTEMPT_ID });
  await flushMicrotasks();
  expect(channel.failures).toEqual([false]);
});
