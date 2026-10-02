import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';

const tempRoots: string[] = [];

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal: NodeJS.Signals) => boolean;
};

function createFakeChild(onKill?: (signal: NodeJS.Signals) => void): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    onKill?.(signal);
    return true;
  });
  return child;
}

afterEach(() => {
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }

  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock('node:child_process');
  vi.unmock('node:path');
});

describe('spawnNodeScript', () => {
  it('sends SIGTERM before SIGKILL after the grace window on timeout', async () => {
    vi.useFakeTimers();

    const killSignals: NodeJS.Signals[] = [];
    const child = createFakeChild((signal) => {
      killSignals.push(signal);
      if (signal === 'SIGKILL') {
        child.emit('close', null, 'SIGKILL');
      }
    });
    const spawnMock = vi.fn(() => child);

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
    }));

    const { spawnNodeScript } = await import('#tests/helpers/multi-process-driver.js');
    const resultPromise = spawnNodeScript({
      scriptPath: '/tmp/worker.cjs',
      args: [],
      env: { ...process.env },
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(killSignals).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS - 1);
    expect(killSignals).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      parsed: undefined,
    });
    expect(killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
