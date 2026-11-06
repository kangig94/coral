import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBackgroundPhaseObserver,
  createStartupPhaseObserver,
  observeRecoveryPhase,
  startRecoveryPhase,
} from '#src/recovery/phase-observation.js';

import { createRealTimePort } from '#src/infra/time.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('recovery phase observation', () => {
  it.each(['complete', 'failed'] as const)(
    'reports each phase once with outcome=%s and accumulated counts',
    (outcome) => {
      let now = 9_000n;
      const log = vi.fn();
      const time = { monotonicNow: () => now };
      const jobs = startRecoveryPhase({ time, log, bootId: 'boot-1', phase: 'jobs-startup' });
      const workflow = startRecoveryPhase({ time, log, bootId: 'boot-1', phase: 'workflow' });
      expect(log).toHaveBeenCalledTimes(2);
      log.mockClear();

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

  it('starts each retry before work and sums attempt results once at boot settlement', async () => {
    let now = 0n;
    const log = vi.fn();
    const boot = createStartupPhaseObserver({ time: { monotonicNow: () => now }, log, bootId: 'boot-1' });
    const failure = new Error('receipt adoption failed');
    for (const phase of ['jobs-startup', 'discussion', 'workflow', 'reactor-scan']) {
      await expect(
        observeRecoveryPhase(boot.options(phase), async (observation) => {
          observation.record('rows', { subjects: 2, reads: 3 });
          now += 10n;
          throw failure;
        }),
      ).rejects.toBe(failure);
      await observeRecoveryPhase(boot.options(phase), async (observation) => {
        expect(log.mock.calls.filter(([line]) => line.includes(`phase=${phase} event=start `))).toHaveLength(2);
        observation.record('rows', { subjects: 4, reads: 5 });
        now += 20n;
      });
    }
    expect(log.mock.calls.every(([line]) => line.includes('event=start'))).toBe(true);
    log.mockClear();
    boot.finish();
    boot.finish();
    expect(log).toHaveBeenCalledTimes(4);
    for (const [line] of log.mock.calls) {
      expect(line).toContain('outcome=complete duration_ms=30.000 subjects=6 reads=8');
    }
  });

  it('reports only store-open attempts, including failures and excluding reused handles', async () => {
    const log = vi.fn();
    const boot = createStartupPhaseObserver({ time: { monotonicNow: () => 0n }, log, bootId: 'boot-1' });
    await expect(
      observeRecoveryPhase(boot.options('store-open'), async () => {
        throw new Error('open failed');
      }),
    ).rejects.toThrow('open failed');
    await observeRecoveryPhase(boot.options('store-open'), async () => {});
    startRecoveryPhase({ ...boot.options('store-open'), attempts: 0 }).finish();
    log.mockClear();
    boot.finish();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'recovery-phase boot=boot-1 kind=startup phase=store-open event=finish outcome=complete' +
        ' duration_ms=0.000 attempts=2\n',
    );
  });

  it('keeps the first finish outcome and ignores subsequent records and finishes', () => {
    const log = vi.fn();
    const monotonicNow = vi.fn().mockReturnValueOnce(1n).mockReturnValueOnce(3n);
    const phase = startRecoveryPhase({ time: { monotonicNow }, log, bootId: 'boot-1', phase: 'discussion' });

    log.mockClear();
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

  it('keeps completed background no-op ticks silent, including reads, and cancels their watchdog', async () => {
    const log = vi.fn();
    const phase = startRecoveryPhase({
      time: createRealTimePort(),
      log,
      bootId: 'boot-1',
      phase: 'reactor-scan',
      kind: 'background',
    });
    phase.record('rows', { reads: 12 });
    phase.finish();
    phase.finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports canonical background state transitions once and never treats cancellation as recovery', async () => {
    const log = vi.fn();
    const start = createBackgroundPhaseObserver({
      time: { ...createRealTimePort(), monotonicNow: () => 0n },
      log,
      bootId: 'boot-1',
      phase: 'periodic-reconciliation',
    });
    const passes = [
      { state: null, count: 0 },
      { state: 'entry-1: locked', count: 1, event: 'state=held' },
      { state: 'entry-1: locked', count: 0 },
      { state: 'entry-1: unreadable', count: 1, event: 'state=held' },
      { state: null, cancel: true, count: 0 },
      { state: 'entry-1: unreadable', count: 0 },
      { state: null, abort: true, count: 0 },
      { state: 'entry-1: unreadable', count: 0 },
      { state: null, count: 1, event: 'state=cleared' },
      { state: null, count: 0 },
      { state: 'entry-2: failed', outcome: 'failed', count: 1, event: 'state=held' },
      { state: 'entry-2: failed', outcome: 'failed', count: 0 },
      { state: null, outcome: 'failed', count: 1, event: 'outcome=failed' },
      { state: 'entry-2: failed', count: 0 },
      { state: null, count: 1, event: 'state=cleared' },
      { state: null, count: 0 },
    ] as const;
    for (const pass of passes) {
      log.mockClear();
      const controller = new AbortController();
      const phase = start(controller.signal);
      phase.reportState(pass.state);
      if ('abort' in pass && pass.abort) controller.abort();
      phase.finish('cancel' in pass && pass.cancel ? 'cancelled' : 'outcome' in pass ? pass.outcome : 'complete');
      expect(log, JSON.stringify(pass)).toHaveBeenCalledTimes(pass.count);
      if ('event' in pass) {
        expect(log).toHaveBeenCalledWith(expect.stringContaining(pass.event));
        if (pass.event.startsWith('state=')) expect(log).toHaveBeenCalledWith(expect.stringContaining('subjects=1'));
        else expect(log.mock.calls.some(([line]) => line.includes('state=cleared'))).toBe(false);
        if (pass.state !== null) expect(log).toHaveBeenCalledWith(expect.stringContaining(pass.state));
      }
    }
    const phase = start();
    phase.reportState('entry-2: locked');
    phase.finish();
    log.mockClear();
    const failed = start();
    failed.reportState('[]');
    failed.finish('failed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('outcome=failed'));
    expect(log.mock.calls.some(([line]) => line.includes('state=cleared'))).toBe(false);
    log.mockClear();
    const unchanged = start();
    unchanged.reportState('entry-2: locked');
    unchanged.finish();
    expect(log).not.toHaveBeenCalled();
    const empty = start();
    empty.reportState('[]');
    empty.finish();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('state=cleared'));
    log.mockClear();
    const aborted = new AbortController();
    start(aborted.signal);
    aborted.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains unobserved holds through failed replacement and updater observations until successful recovery', () => {
    const log = vi.fn();
    const start = createBackgroundPhaseObserver({
      time: { ...createRealTimePort(), monotonicNow: () => 0n },
      log,
      bootId: 'boot-1',
      phase: 'failed-observation',
    });
    const original = [{ identity: 'entry-1', reason: 'binding unreadable' }];
    const failure = [{ identity: 'store', reason: 'store unavailable' }];
    const initial = start();
    initial.reportState(JSON.stringify(original));
    initial.finish();
    log.mockClear();
    const interrupted = start();
    interrupted.reportState(JSON.stringify(failure));
    interrupted.finish('failed');
    expect(JSON.parse(log.mock.calls[0][0].split(' detail=')[1])).toEqual({
      counts: { added: 1, changed: 0, cleared: 0 },
      changes: [{ kind: 'added', identity: 'store', reason: ['store unavailable'] }],
    });
    log.mockClear();
    const repeated = start();
    repeated.reportState(JSON.stringify(failure));
    repeated.finish('failed');
    expect(log).not.toHaveBeenCalled();
    const changed = start();
    changed.reportState(() => JSON.stringify([{ identity: 'store', reason: 'store busy' }]));
    changed.finish('failed');
    expect(JSON.parse(log.mock.calls[0][0].split(' detail=')[1])).toEqual({
      counts: { added: 0, changed: 1, cleared: 0 },
      changes: [{ kind: 'changed', identity: 'store', reason: ['store busy'], previousReason: ['store unavailable'] }],
    });
    log.mockClear();
    const recovered = start();
    recovered.reportState(null);
    recovered.finish();
    const cleared = JSON.parse(log.mock.calls[0][0].split(' detail=')[1]);
    expect(cleared.counts).toEqual({ added: 0, changed: 0, cleared: 2 });
    expect(cleared.changes).toEqual([
      { kind: 'cleared', identity: 'entry-1', reason: ['binding unreadable'] },
      { kind: 'cleared', identity: 'store', reason: ['store busy'] },
    ]);
    log.mockClear();
    const clean = start();
    clean.reportState(null);
    clean.finish();
    expect(log).not.toHaveBeenCalled();
  });

  it('reports changed holds beyond the old prefix with bounded samples and complete counts', () => {
    const log = vi.fn();
    const start = createBackgroundPhaseObserver({
      time: { ...createRealTimePort(), monotonicNow: () => 0n },
      log,
      bootId: 'boot-1',
      phase: 'ledger-reconciliation',
    });
    const holds = Array.from({ length: 30 }, (_, index) => ({
      identity: `entry-${String(index).padStart(2, '0')}`,
      reason: `awaiting exact owner absence evidence for retained obligation ${index}`,
    }));
    const pass = (state: typeof holds | null) => {
      const phase = start();
      phase.reportState(state === null ? null : JSON.stringify(state));
      phase.finish();
      return JSON.parse(log.mock.calls.at(-1)![0].split(' detail=')[1]);
    };
    const initial = pass(holds);
    log.mockClear();
    const changed = holds.map((hold, index) =>
      index === holds.length - 1 ? { ...hold, reason: 'recorded owner identity is unreadable' } : hold,
    );
    expect(JSON.stringify(changed).slice(0, 2_048)).toBe(JSON.stringify(holds).slice(0, 2_048));
    const detail = pass(changed);
    expect(log.mock.calls[0][0]).toContain('recorded owner identity is unreadable');
    expect(initial.counts).toEqual({ added: 30, changed: 0, cleared: 0 });
    expect(initial.changes).toHaveLength(10);
    expect(detail).toEqual({
      counts: { added: 0, changed: 1, cleared: 0 },
      changes: [
        {
          kind: 'changed',
          identity: holds.at(-1)!.identity,
          reason: [changed.at(-1)!.reason],
          previousReason: [holds.at(-1)!.reason],
        },
      ],
    });
    log.mockClear();
    const mixed = pass([...changed.slice(1), { identity: 'new-entry', reason: 'locked' }]);
    expect(mixed.counts).toEqual({ added: 1, changed: 0, cleared: 1 });
    expect(mixed.changes).toEqual([
      { kind: 'added', identity: 'new-entry', reason: ['locked'] },
      { kind: 'cleared', identity: holds[0].identity, reason: [holds[0].reason] },
    ]);
    const cleared = pass(null);
    expect(cleared.counts).toEqual({ added: 0, changed: 0, cleared: 30 });
    expect(cleared.changes).toHaveLength(10);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('state=cleared'));
  });

  it('preserves every reason for one hold identity and ignores reason ordering', () => {
    const log = vi.fn();
    const start = createBackgroundPhaseObserver({
      time: { ...createRealTimePort(), monotonicNow: () => 0n },
      log,
      bootId: 'boot-1',
      phase: 'epoch-reconciliation',
    });
    const pass = (reasons: string[]) => {
      const phase = start();
      phase.reportState(JSON.stringify(reasons.map((reason) => ({ identity: 'epoch-path', reason }))));
      phase.finish();
    };
    pass(['registration unavailable', 'live holder']);
    log.mockClear();
    pass(['live holder', 'registration unavailable']);
    expect(log).not.toHaveBeenCalled();
    pass(['live holder', 'closure unavailable']);
    expect(JSON.parse(log.mock.calls[0][0].split(' detail=')[1])).toEqual({
      counts: { added: 0, changed: 1, cleared: 0 },
      changes: [
        {
          kind: 'changed',
          identity: 'epoch-path',
          reason: ['closure unavailable', 'live holder'],
          previousReason: ['live holder', 'registration unavailable'],
        },
      ],
    });
  });

  it('keeps unobserved holds when a pass updates partial state and never applies a cancelled update', () => {
    const log = vi.fn();
    const start = createBackgroundPhaseObserver({
      time: { ...createRealTimePort(), monotonicNow: () => 0n },
      log,
      bootId: 'boot-1',
      phase: 'partial-reconciliation',
    });
    const initial = start();
    initial.reportState('entry-1: pending');
    initial.finish();
    log.mockClear();
    const partial = start();
    partial.reportState((previous) => previous);
    partial.finish();
    expect(log).not.toHaveBeenCalled();
    const update = vi.fn(() => null);
    const cancelled = start();
    cancelled.reportState(update);
    cancelled.finish('cancelled');
    expect(update).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    const controller = new AbortController();
    const aborted = start(controller.signal);
    aborted.reportState(update);
    controller.abort();
    aborted.finish();
    expect(update).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    const damaged = start();
    damaged.reportState(() => {
      throw new Error('cannot summarize partial state');
    });
    expect(() => damaged.finish()).not.toThrow();
    expect(log).not.toHaveBeenCalled();
    const recovered = start();
    recovered.reportState((previous) => {
      expect(previous).toBe('entry-1: pending');
      return null;
    });
    recovered.finish();
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('state=cleared'));
  });

  it('keeps a background phase quiet until it finishes below the five-second watchdog threshold', async () => {
    let now = 0n;
    const log = vi.fn();
    const phase = startRecoveryPhase({
      time: { ...createRealTimePort(), monotonicNow: () => now },
      log,
      bootId: 'boot-1',
      phase: 'reactor-scan',
      kind: 'background',
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(log).not.toHaveBeenCalled();
    now = 4_999n;
    phase.finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['failed', 'subjects', 'slow', 'hung'] as const)(
    'reports a background %s tick without start noise',
    async (reason) => {
      let now = 0n;
      const log = vi.fn();
      const phase = startRecoveryPhase({
        time: { ...createRealTimePort(), monotonicNow: () => now },
        log,
        bootId: 'boot-1',
        phase: 'reactor-scan',
        kind: 'background',
      });
      expect(log).not.toHaveBeenCalled();
      if (reason === 'subjects') phase.record('sessions', { subjects: 1 });
      if (reason === 'slow') now = 5_000n;
      if (reason === 'hung') {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(log).toHaveBeenCalledExactlyOnceWith(
          'recovery-phase boot=boot-1 kind=background phase=reactor-scan event=still-running after_ms=5000\n',
        );
        now = 60_000n;
      }
      phase.finish(reason === 'failed' ? 'failed' : 'complete');
      phase.finish();
      const last = log.mock.calls.at(-1)?.[0];
      expect(last).toContain(`event=finish outcome=${reason === 'failed' ? 'failed' : 'complete'}`);
      expect(log.mock.calls.some(([line]) => line.includes('event=start'))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('contains throwing background logs and cancels the watchdog after completion', async () => {
    const log = vi.fn(() => {
      throw new Error('log failed');
    });
    const phase = startRecoveryPhase({
      time: createRealTimePort(),
      log,
      bootId: 'boot-1',
      phase: 'reactor-scan',
      kind: 'background',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    phase.record('sessions', { subjects: 1 });
    expect(() => phase.finish()).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
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
      expect(input.log).toHaveBeenLastCalledWith(
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
      expect(input.log).toHaveBeenLastCalledWith(
        'recovery-phase boot=boot-1 kind=startup phase=workflow event=finish outcome=failed' +
          ' duration_ms=0.000 subjects=0 reads=0 sources={}\n',
      );
    });
  });
});
