import { describe, expect, it, vi } from 'vitest';

import {
  createStartupPhaseObserver,
  observeRecoveryPhase,
  startRecoveryPhase,
} from '#src/recovery/phase-observation.js';

describe('recovery phase observation', () => {
  it.each(['complete', 'failed'] as const)(
    'reports each phase once with outcome=%s and accumulated counts',
    (outcome) => {
      let now = 9_000n;
      const log = vi.fn();
      const time = { monotonicNow: () => now };
      const jobs = startRecoveryPhase({ time, log, bootId: 'boot-1', phase: 'jobs-startup' });
      const workflow = startRecoveryPhase({ time, log, bootId: 'boot-1', phase: 'workflow' });
      expect(log).not.toHaveBeenCalled();

      jobs.record('launches', { subjects: 2, reads: 3 });
      jobs.record('launches', { reads: 4 });
      jobs.record('claims', { subjects: 1 });
      jobs.record('claims', { reads: 2 });
      now += 12n;
      jobs.finish(outcome);
      now += 8n;
      workflow.finish();

      expect(log.mock.calls).toEqual([
        [
          `recovery-phase boot=boot-1 kind=startup phase=jobs-startup event=finish outcome=${outcome}` +
            ' duration_ms=12.000 subjects=3 reads=9' +
            ' sources={"launches":{"subjects":2,"reads":7},"claims":{"subjects":1,"reads":2}}\n',
        ],
        [
          'recovery-phase boot=boot-1 kind=startup phase=workflow event=finish outcome=complete' +
            ' duration_ms=20.000 subjects=0 reads=0 sources={}\n',
        ],
      ]);
    },
  );

  it('sums failed and retried attempts and emits each startup phase once at boot settlement', async () => {
    let now = 0n;
    const log = vi.fn();
    const boot = createStartupPhaseObserver({ time: { monotonicNow: () => now }, log, bootId: 'boot-1' });
    const failure = new Error('receipt adoption failed');
    for (const phase of ['store-open', 'jobs-startup', 'discussion', 'workflow', 'reactor-scan']) {
      await expect(
        observeRecoveryPhase(boot.options(phase), async (observation) => {
          observation.record('rows', { subjects: 2, reads: 3 });
          now += 10n;
          throw failure;
        }),
      ).rejects.toBe(failure);
      await observeRecoveryPhase(boot.options(phase), async (observation) => {
        observation.record('rows', { subjects: 4, reads: 5 });
        now += 20n;
      });
    }
    expect(log).not.toHaveBeenCalled();
    boot.finish();
    boot.finish();
    expect(log).toHaveBeenCalledTimes(5);
    for (const [line] of log.mock.calls) {
      expect(line).toContain('outcome=complete duration_ms=30.000 subjects=6 reads=8');
    }
  });

  it('keeps the first finish outcome and ignores subsequent records and finishes', () => {
    const log = vi.fn();
    const monotonicNow = vi.fn().mockReturnValueOnce(1n).mockReturnValueOnce(3n);
    const phase = startRecoveryPhase({ time: { monotonicNow }, log, bootId: 'boot-1', phase: 'discussion' });

    phase.finish('failed');
    phase.record('discussions', { subjects: 10, reads: 20 });
    phase.finish();
    phase.finish('failed');

    expect(monotonicNow).toHaveBeenCalledTimes(2);
    expect(log.mock.calls).toEqual([
      [
        'recovery-phase boot=boot-1 kind=startup phase=discussion event=finish outcome=failed' +
          ' duration_ms=2.000 subjects=0 reads=0 sources={}\n',
      ],
    ]);
  });

  it('emits a background start immediately and a single finish', () => {
    const log = vi.fn();
    const phase = startRecoveryPhase({
      time: { monotonicNow: () => 0n },
      log,
      bootId: 'boot-1',
      phase: 'reactor-scan',
      kind: 'background',
    });
    expect(log.mock.calls).toEqual([
      ['recovery-phase boot=boot-1 kind=background phase=reactor-scan event=start subjects=0 reads=0 sources={}\n'],
    ]);

    phase.finish();
    phase.finish();
    expect(log.mock.calls).toEqual([
      ['recovery-phase boot=boot-1 kind=background phase=reactor-scan event=start subjects=0 reads=0 sources={}\n'],
      [
        'recovery-phase boot=boot-1 kind=background phase=reactor-scan event=finish outcome=complete' +
          ' duration_ms=0.000 subjects=0 reads=0 sources={}\n',
      ],
    ]);
  });

  it('contains throwing logs at both background start and finish', () => {
    const log = vi.fn(() => {
      throw new Error('log failed');
    });
    expect(() => {
      const phase = startRecoveryPhase({
        time: { monotonicNow: () => 0n },
        log,
        bootId: 'boot-1',
        phase: 'reactor-scan',
        kind: 'background',
      });
      phase.record('sessions', { subjects: 1, reads: 1 });
      phase.finish();
      phase.finish();
    }).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
  });

  describe.each([false, true])('observeRecoveryPhase with throwing log=%s', (throwingLog) => {
    const options = () => ({
      time: { monotonicNow: () => 0n },
      log: vi.fn((_message: string) => {
        if (throwingLog) throw new Error('log failed');
      }),
      bootId: 'boot-1',
      phase: 'workflow',
    });

    it('passes the original result through and reports completion', async () => {
      const input = options();
      const result = { recovered: ['workflow-1'] };
      await expect(
        observeRecoveryPhase(input, async (observation) => {
          observation.record('workflows', { subjects: 1, reads: 2 });
          return result;
        }),
      ).resolves.toBe(result);
      expect(input.log).toHaveBeenCalledExactlyOnceWith(
        'recovery-phase boot=boot-1 kind=startup phase=workflow event=finish outcome=complete' +
          ' duration_ms=0.000 subjects=1 reads=2 sources={"workflows":{"subjects":1,"reads":2}}\n',
      );
    });

    it.each(['throw', 'reject'] as const)('passes the original %s through and reports failure', async (failure) => {
      const input = options();
      const error = new Error('recovery failed');
      await expect(
        observeRecoveryPhase(input, () => {
          if (failure === 'throw') throw error;
          return Promise.reject(error);
        }),
      ).rejects.toBe(error);
      expect(input.log).toHaveBeenCalledExactlyOnceWith(
        'recovery-phase boot=boot-1 kind=startup phase=workflow event=finish outcome=failed' +
          ' duration_ms=0.000 subjects=0 reads=0 sources={}\n',
      );
    });
  });
});
