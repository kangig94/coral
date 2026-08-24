import type * as NodeFsPromises from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

const { readFileAsync } = vi.hoisted(() => ({
  readFileAsync: vi.fn<typeof NodeFsPromises.readFile>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  readFileAsync.mockImplementation(actual.readFile);
  return { ...actual, readFile: readFileAsync };
});

import { createRealRuntime, observeProcessIdentitiesWithoutSubprocesses } from '#src/runtime/real.js';
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

  it.runIf(process.platform === 'linux')(
    'forwards the deadline signal through the production Linux read binding',
    async () => {
      readFileAsync.mockImplementationOnce(async (_path, options) => {
        if (typeof options !== 'object' || options === null || options.signal === undefined) {
          throw new Error('Production process observation did not forward an AbortSignal.');
        }

        await new Promise<void>((_resolve, reject) => {
          const rejectAsAborted = () => reject(new DOMException('The operation was aborted', 'AbortError'));
          if (options.signal?.aborted) rejectAsAborted();
          else options.signal?.addEventListener('abort', rejectAsAborted, { once: true });
        });
        throw new Error('Aborted process observation unexpectedly resumed.');
      });

      const runtime = createRealRuntime('dev');
      const owner = { pid: process.pid, incarnation: testIncarnation(process.pid) };

      await expect(runtime.process.observeProcessIdentities([owner], 1)).resolves.toEqual([
        { owner, evidence: { kind: 'unobservable', cause: 'deadline-expired' } },
      ]);
      expect(readFileAsync).toHaveBeenCalledWith(
        '/proc/sys/kernel/random/boot_id',
        expect.objectContaining({ encoding: 'utf-8', signal: expect.any(AbortSignal) }),
      );
    },
  );

  it.runIf(process.platform === 'linux')(
    'settles the production Linux observer within its deadline budget',
    async () => {
      const runtime = createRealRuntime('dev');
      const incarnation = runtime.process.readProcessIncarnation(process.pid, 'linux');
      expect(incarnation).not.toBeNull();
      if (incarnation === null) throw new Error('Expected the current Linux process to have an incarnation.');
      const owners = Array.from({ length: 64 }, () => ({ pid: process.pid, incarnation }));
      const startedAt = Date.now();
      const observations = await runtime.process.observeProcessIdentities(owners, 500);

      expect(observations).toHaveLength(owners.length);
      expect(
        observations.every(
          (observation) =>
            observation.evidence.kind === 'incarnation' ||
            (observation.evidence.kind === 'unobservable' && observation.evidence.cause === 'deadline-expired'),
        ),
      ).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(750);
    },
  );
});
