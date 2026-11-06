import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { createHostPressureMonitor } from '#src/infra/host-pressure.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof childProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
afterEach(() => vi.restoreAllMocks());

const fixture = fileURLToPath(new URL('../../fixtures/host-pressure/ignore-term.mjs', import.meta.url));

function output(child: ChildProcess, word: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(deadline);
      child.stdout?.off('data', onData);
      child.off('close', onClose);
      child.off('error', onError);
    };
    const onData = (chunk: Buffer): void => {
      if (!chunk.toString().includes(word)) return;
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`Owned fixture closed before ${word}`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Owned fixture did not report ${word}`));
    }, 5_000);
    child.stdout?.on('data', onData);
    child.once('close', onClose);
    child.once('error', onError);
  });
}

describe.skipIf(process.platform === 'win32')('host pressure subprocess ownership', () => {
  it.each(['deadline', 'shutdown'] as const)('reaps a sysctl fixture ignoring SIGTERM on %s', async (trigger) => {
    const actual = await vi.importActual<typeof childProcess>('node:child_process');
    const children: Array<{ child: ChildProcess; closed: Promise<void> }> = [];
    vi.mocked(childProcess.execFile).mockImplementation(((...args: Parameters<typeof childProcess.execFile>) => {
      const child = actual.execFile(process.execPath, [fixture, '1200'], args[2], args[3]);
      children.push({ child, closed: new Promise<void>((resolve) => child.once('close', () => resolve())) });
      return child;
    }) as typeof childProcess.execFile);
    const clock = new VirtualTime();
    const monitor = createHostPressureMonitor('darwin', clock, { get: () => 'observe' });
    try {
      const refresh = monitor.refresh();
      const owned = children[0];
      if (owned === undefined) throw new Error('Expected owned sysctl child');
      await output(owned.child, 'ready');
      const terminated = output(owned.child, 'term');
      const stop = trigger === 'shutdown' ? monitor.stop() : null;
      if (trigger === 'deadline') clock.tick(1000);
      await terminated;
      await refresh;
      expect(owned.child.exitCode).toBeNull();
      expect(owned.child.signalCode).toBeNull();
      expect(children).toHaveLength(1);
      if (trigger === 'deadline') expect(monitor.refresh()).toBe(refresh);
      let stopped = false;
      if (stop !== null)
        void Promise.resolve(stop).then(() => {
          stopped = true;
        });
      await Promise.resolve();
      expect(stopped).toBe(false);
      clock.tick(4999);
      expect(owned.child.signalCode).toBeNull();
      clock.tick(1);
      await owned.closed;
      expect(owned.child.signalCode).toBe('SIGKILL');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await stop;
      if (trigger === 'shutdown') {
        await monitor.refresh();
        expect(children).toHaveLength(1);
      } else {
        const next = monitor.refresh();
        expect(next).not.toBe(refresh);
        expect(children).toHaveLength(2);
      }
    } finally {
      const stopping = monitor.stop();
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await Promise.all(children.map(({ closed }) => closed));
      await stopping;
    }
  });
});
