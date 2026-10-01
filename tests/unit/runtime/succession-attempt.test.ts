import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { startSuccessionAttempt } from '#src/coordinator/succession/attempt-child.js';
import type { UpgradeIntent } from '#src/infra/upgrade-intent.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';
import type { SuccessionPreparation } from '#src/coordinator/succession/protocol.js';
import type { IpcListener } from '#src/transport/ipc/server.js';

import {
  createRealSuccessionAttemptPorts,
  installReplacementSupervisorChannel,
} from '#src/runtime/succession-attempt.js';

afterEach(() => vi.unstubAllEnvs());

it.each(['before spawn', 'after spawn'] as const)(
  'reports supervisor channel loss %s without asserting child absence',
  async (phase) => {
    vi.stubEnv('CORAL_LAUNCH_ADMISSION', '1');
    const supervisor = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
    installReplacementSupervisorChannel(supervisor as unknown as ChildProcess);
    const child = createRealSuccessionAttemptPorts().spawn('/fixture', 'attempt');
    const errors = vi.fn();
    const disconnected = vi.fn();
    const exited = vi.fn();
    child.on('error', errors);
    child.on('disconnect', disconnected);
    child.on('exit', exited);
    const identity = child.coordinatorPid!.then(
      (pid) => ({ pid }),
      (error: unknown) => ({ error }),
    );
    if (phase === 'after spawn')
      supervisor.emit('message', { kind: 'coral-supervisor-attempt-spawned', attemptId: 'attempt', pid: 12345 });

    supervisor.connected = false;
    supervisor.emit('disconnect');

    expect(disconnected).toHaveBeenCalledOnce();
    expect(exited).not.toHaveBeenCalled();
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(child.connected).toBe(false);
    expect(supervisor.listenerCount('message')).toBe(0);
    if (phase === 'before spawn') {
      expect(errors).toHaveBeenCalledOnce();
      expect(await identity).toEqual({ error: expect.any(Error) });
    } else {
      expect(errors).not.toHaveBeenCalled();
      expect(await identity).toEqual({ pid: 12345 });
    }
  },
);

it('detaches channel-loss observation after a confirmed attempt exit', async () => {
  vi.stubEnv('CORAL_LAUNCH_ADMISSION', '1');
  const supervisor = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
  installReplacementSupervisorChannel(supervisor as unknown as ChildProcess);
  const child = createRealSuccessionAttemptPorts().spawn('/fixture', 'attempt');
  const disconnected = vi.fn();
  const exited = vi.fn();
  child.on('disconnect', disconnected);
  child.on('exit', exited);
  supervisor.emit('message', { kind: 'coral-supervisor-attempt-spawned', attemptId: 'attempt', pid: 12345 });
  expect(await child.coordinatorPid).toBe(12345);
  supervisor.emit('message', {
    kind: 'coral-supervisor-attempt-exit',
    attemptId: 'attempt',
    exitCode: 0,
    signal: null,
  });
  expect(exited).toHaveBeenCalledOnce();
  expect(disconnected).toHaveBeenCalledOnce();
  expect(supervisor.listenerCount('disconnect')).toBe(1);
  supervisor.connected = false;
  supervisor.emit('disconnect');
  expect(disconnected).toHaveBeenCalledOnce();
});

it.each(['error', 'exit'] as const)('settles an unconfirmed spawn on a supervisor %s receipt', async (receipt) => {
  vi.stubEnv('CORAL_LAUNCH_ADMISSION', '1');
  const supervisor = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
  installReplacementSupervisorChannel(supervisor as unknown as ChildProcess);
  const child = createRealSuccessionAttemptPorts().spawn('/fixture', 'attempt');
  const errors = vi.fn();
  child.on('error', errors);
  const identity = child.coordinatorPid!.catch((error: unknown) => error);
  supervisor.emit('message', {
    kind: `coral-supervisor-attempt-${receipt}`,
    attemptId: 'attempt',
    reason: 'launch failed',
    exitCode: 1,
    signal: null,
  });
  expect(errors).toHaveBeenCalledOnce();
  expect(await identity).toBeInstanceOf(Error);
  expect(supervisor.listenerCount('message')).toBe(0);
  expect(supervisor.listenerCount('disconnect')).toBe(1);
  supervisor.connected = false;
  supervisor.emit('disconnect');
  expect(errors).toHaveBeenCalledOnce();
});

it('rejects the launch and consumes both spawn failures when the supervisor disconnects before its reply', async () => {
  vi.stubEnv('CORAL_LAUNCH_ADMISSION', '1');
  const supervisor = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
  installReplacementSupervisorChannel(supervisor as unknown as ChildProcess);
  const launch = startSuccessionAttempt({
    ports: createRealSuccessionAttemptPorts(),
    intent: { attemptId: 'attempt', attemptOwner: { kind: 'incumbent' } } as UpgradeIntent,
    preparation: { attemptId: 'attempt' } as SuccessionPreparation,
    listener: {
      server: { listening: true },
      socketPath: '/fixture.sock',
      compatibilityListeners: [],
    } as unknown as IpcListener,
    bootToken: 'token',
    recoveryBundleDir: '/fixture',
  });
  const rejected = expect(launch).rejects.toThrow('Supervisor disconnected before confirming the succession child');
  supervisor.connected = false;
  supervisor.emit('disconnect');
  await rejected;
});

it('preserves channel loss after spawn without sending retirement through the closed supervisor', async () => {
  vi.stubEnv('CORAL_LAUNCH_ADMISSION', '1');
  const supervisor = Object.assign(new EventEmitter(), { connected: true, send: vi.fn(() => true) });
  installReplacementSupervisorChannel(supervisor as unknown as ChildProcess);
  const ports = createRealSuccessionAttemptPorts();
  const child = ports.spawn('/fixture', 'attempt');
  const launch = startSuccessionAttempt({
    ports: { ...ports, spawn: () => child, processIncarnation: () => 'fixture-incarnation' as ProcessIncarnation },
    intent: { attemptId: 'attempt', attemptOwner: { kind: 'incumbent' } } as UpgradeIntent,
    preparation: { attemptId: 'attempt' } as SuccessionPreparation,
    listener: {
      server: { listening: true },
      socketPath: '/fixture.sock',
      compatibilityListeners: [],
    } as unknown as IpcListener,
    bootToken: 'token',
    recoveryBundleDir: '/fixture',
  });
  const rejected = expect(launch).rejects.toThrow('Succession attempt channel disconnected');
  supervisor.emit('message', { kind: 'coral-supervisor-attempt-spawned', attemptId: 'attempt', pid: 12345 });
  await vi.waitFor(() => expect(child.listenerCount('disconnect')).toBe(1));
  supervisor.send.mockClear();
  supervisor.send.mockImplementation(() => {
    throw new Error('Retirement sent through a closed supervisor');
  });
  supervisor.connected = false;
  supervisor.emit('disconnect');
  await rejected;
  expect(supervisor.send).not.toHaveBeenCalled();
  expect(child.exitCode).toBeNull();
});
