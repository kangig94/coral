import { rmSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createStorageRetentionScheduler } from '#src/coordinator/composition/storage-retention-scheduler.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

describe('repair hint consumed by a run that starts in an untrusted-clock window', () => {
  it('retries a skipped owner promptly and wakes on repeated hints', async () => {
    const f = createTerminalExportFixture('provider');
    try {
      f.complete();
      const timers: Array<{ fn: () => void; ms: number }> = [];
      const runtime = {
        ...f.runtime,
        time: {
          ...f.runtime.time,
          setTimeout: (fn: () => void, ms: number) => {
            const t = { fn, ms, unref() {} };
            timers.push(t);
            return t as never;
          },
          clearTimeout: (t: unknown) => {
            const i = timers.indexOf(t as never);
            if (i >= 0) timers.splice(i, 1);
          },
        },
      };
      const logs: string[] = [];
      const scheduler = createStorageRetentionScheduler({
        runtime: runtime as never,
        getProgressStore: () => f.store as never,
        openEpoch: () => f.epoch as never,
        activeEpochKey: () => f.epochKey,
        jobLocations: f.index,
        log: (m) => logs.push(m.trim()),
        publish: () => {},
        cleanupScratch: () => {},
      });
      scheduler.start();

      const fire = async () => {
        const t = timers.shift();
        t?.fn();
        for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      };
      await fire();

      rmSync(f.resultPath, { force: true });

      f.jump(86_400_000);
      const owner = f.store.getResultExportOwner();
      expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
      owner.hintRepair(f.jobId);

      await fire();
      expect(existsSync(f.resultPath)).toBe(false);
      expect(timers.some((t) => t.ms <= 1000)).toBe(true);

      f.advance(5_000);
      for (let i = 0; i < 5; i++) owner.hintRepair(f.jobId);

      f.advance(1_001);
      expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
      owner.hintRepair(f.jobId);

      await fire();
      expect(existsSync(f.resultPath)).toBe(true);
      await scheduler.stop();
    } finally {
      f.close();
    }
  });
});
