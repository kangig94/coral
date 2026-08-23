import { describe, expect, it, vi } from 'vitest';

import { observeProcessIdentitiesWithoutSubprocesses } from '#src/runtime/real.js';
import type { TimePort } from '#src/infra/port-types.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const BOOT_ID = '9f2a1c44-1f3e-4a8b-9d31-6c0f2b7e5a10';

function statLine(startTicks: string): string {
  const afterComm = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 100))];
  return `4321 (node worker) ${afterComm.join(' ')} ${startTicks} 0 0\n`;
}

const time: Pick<TimePort, 'setTimeout' | 'clearTimeout'> = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

describe('process identity batch observation', () => {
  it('takes liveness without reading incarnation files on a subprocess-backed platform', async () => {
    const alive = { pid: 11, incarnation: testIncarnation(11) };
    const absent = { pid: 12, incarnation: testIncarnation(12) };
    const readFile = vi.fn<() => Promise<string>>();

    await expect(
      observeProcessIdentitiesWithoutSubprocesses([alive, absent], 500, {
        platform: 'darwin',
        observeLiveness: (pid) => (pid === absent.pid ? 'absent' : 'alive'),
        readFile,
        time,
      }),
    ).resolves.toEqual([
      { owner: alive, evidence: { kind: 'unobservable', cause: 'probe-not-available' } },
      { owner: absent, evidence: { kind: 'pid-absent' } },
    ]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('shares one asynchronous Linux boot-id read and compares each stat incarnation', async () => {
    const matching = { pid: 21, incarnation: `linux:${BOOT_ID}:701` as ReturnType<typeof testIncarnation> };
    const reused = { pid: 22, incarnation: `linux:${BOOT_ID}:702` as ReturnType<typeof testIncarnation> };
    const readFile = vi.fn(async (path: string) => {
      if (path === '/proc/sys/kernel/random/boot_id') return `${BOOT_ID}\n`;
      if (path === '/proc/21/stat') return statLine('701');
      return statLine('999');
    });

    await expect(
      observeProcessIdentitiesWithoutSubprocesses([matching, reused], 500, {
        platform: 'linux',
        observeLiveness: () => 'alive',
        readFile,
        time,
      }),
    ).resolves.toEqual([
      { owner: matching, evidence: { kind: 'incarnation', incarnation: matching.incarnation } },
      { owner: reused, evidence: { kind: 'incarnation', incarnation: `linux:${BOOT_ID}:999` } },
    ]);
    expect(readFile.mock.calls.filter(([path]) => path === '/proc/sys/kernel/random/boot_id')).toHaveLength(1);
  });

  it('aborts unfinished production reads at the shared deadline', async () => {
    const owner = { pid: 31, incarnation: testIncarnation(31) };
    const readFile = vi.fn(
      (_path: string, options: { signal: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    );

    const startedAt = Date.now();
    await expect(
      observeProcessIdentitiesWithoutSubprocesses([owner], 20, {
        platform: 'linux',
        observeLiveness: () => 'alive',
        readFile,
        time,
      }),
    ).resolves.toEqual([{ owner, evidence: { kind: 'unobservable', cause: 'deadline-expired' } }]);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
