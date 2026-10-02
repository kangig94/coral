import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
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
  await child.coordinatorPid;
  await flushMicrotasks();
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
