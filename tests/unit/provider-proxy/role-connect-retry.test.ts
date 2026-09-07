import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ControlClientModule from '#src/provider-proxy/control-client.js';

const connectControlClient = vi.hoisted(() => vi.fn());

vi.mock('#src/provider-proxy/control-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ControlClientModule>()),
  connectControlClient,
}));

import { connectRoleControlWithRetry } from '#src/provider-proxy/role-spawn.js';

describe('role control connection retry timing', () => {
  beforeEach(() => {
    connectControlClient.mockReset();
  });

  it('exhausts its deadline on real elapsed time rather than on attempt count', async () => {
    const failure = new Error('control socket not ready');
    connectControlClient.mockRejectedValue(failure);
    const readings = [0n, 60_000n];
    const sleep = vi.fn(async () => {});

    await expect(
      connectRoleControlWithRetry('/tmp/role.sock', {} as ControlClientModule.ControlClientTimer, {
        connectTimeoutMs: 50,
        retryIntervalMs: 100,
        overallDeadlineMs: 200,
        monotonicNow: () => readings.shift() ?? 60_000n,
        sleep,
      }),
    ).rejects.toBe(failure);

    expect(connectControlClient).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries while the deadline still has time', async () => {
    const failure = new Error('control socket not ready');
    connectControlClient.mockRejectedValue(failure);
    const readings = [0n, 50n, 100n, 250n];
    const sleep = vi.fn(async () => {});

    await expect(
      connectRoleControlWithRetry('/tmp/role.sock', {} as ControlClientModule.ControlClientTimer, {
        connectTimeoutMs: 50,
        retryIntervalMs: 100,
        overallDeadlineMs: 200,
        monotonicNow: () => readings.shift() ?? 250n,
        sleep,
      }),
    ).rejects.toBe(failure);

    expect(connectControlClient).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
