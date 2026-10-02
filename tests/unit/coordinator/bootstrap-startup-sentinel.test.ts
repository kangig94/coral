import type * as NodeProcessModule from '#src/infra/node-process.js';
import type * as AdmissionModule from '#src/infra/coordinator-admission.js';
import type { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCoordinatorServer: vi.fn(),
  writeBootstrapDiagnostic: vi.fn(() => '/state/startup-diagnostic.json'),
  writeStartupErrorSentinel: vi.fn(),
  auditBootstrapFailure: vi.fn(),
  probe: vi.fn(),
}));

vi.mock('#src/coordinator/index.js', () => ({ createCoordinatorServer: mocks.createCoordinatorServer }));
vi.mock('#src/coordinator/bootstrap-diagnostics.js', () => ({
  writeBootstrapDiagnostic: mocks.writeBootstrapDiagnostic,
  writeStartupErrorSentinel: mocks.writeStartupErrorSentinel,
  auditBootstrapFailure: mocks.auditBootstrapFailure,
}));

vi.mock('#src/infra/node-process.js', async (loadOriginal) => ({
  ...(await loadOriginal<typeof NodeProcessModule>()),
  probeProcessIncarnation: mocks.probe,
}));
vi.mock('#src/infra/coordinator-admission.js', async (loadOriginal) => ({
  ...(await loadOriginal<typeof AdmissionModule>()),
  authenticatedLaunchParent: () => ({ pid: process.ppid, incarnation: 'parent' }),
}));

import { main } from '#src/coordinator/bootstrap.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('backend startup sentinel', () => {
  it('writes the sentinel when synchronous coordinator composition fails', async () => {
    const error = new Error(
      'CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS must be at least 36001ms to satisfy the timing policy',
    );
    mocks.createCoordinatorServer.mockImplementation(() => {
      throw error;
    });

    await expect(main()).resolves.toBe(1);

    expect(mocks.writeStartupErrorSentinel).toHaveBeenCalledWith(
      expect.any(String),
      error,
      '/state/startup-diagnostic.json',
    );
  });
});

it('delivers TERM before starting parent grace when identity recovers after refused retirement', async () => {
  vi.useFakeTimers();
  const sent = Object.getOwnPropertyDescriptor(process, 'send');
  const channel: EventEmitter = process;
  const listeners = new Map(['message', 'disconnect'].map((event) => [event, channel.listeners(event)]));
  const sentinelId = process.env.CORAL_SENTINEL_ID;
  process.env.CORAL_SENTINEL_ID = 'test-parent';
  Object.defineProperty(process, 'send', {
    configurable: true,
    value: vi.fn(() => {
      queueMicrotask(() => channel.emit('message', { kind: 'coral-sentinel-armed', id: 'test-parent' }));
      return true;
    }),
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.probe.mockReturnValue('parent');
  mocks.createCoordinatorServer.mockImplementation(() => {
    throw new Error('fixture ends startup');
  });
  try {
    const started = main();
    await vi.advanceTimersByTimeAsync(0);
    await expect(started).resolves.toBe(1);
    mocks.probe.mockReturnValue(null);
    await vi.advanceTimersByTimeAsync(650_000);
    expect(kill).not.toHaveBeenCalled();
    mocks.probe.mockReturnValue('parent');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill.mock.calls).toEqual([[process.ppid, 'SIGTERM']]);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(kill.mock.calls).toEqual([[process.ppid, 'SIGTERM']]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill.mock.calls).toEqual([
      [process.ppid, 'SIGTERM'],
      [process.ppid, 'SIGKILL'],
    ]);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    kill.mockRestore();
    log.mockRestore();
    if (sent === undefined) delete process.send;
    else Object.defineProperty(process, 'send', sent);
    if (sentinelId === undefined) delete process.env.CORAL_SENTINEL_ID;
    else process.env.CORAL_SENTINEL_ID = sentinelId;
    for (const [event, original] of listeners)
      for (const listener of channel.listeners(event))
        if (!original.includes(listener)) channel.removeListener(event, listener as (...args: unknown[]) => void);
  }
});
