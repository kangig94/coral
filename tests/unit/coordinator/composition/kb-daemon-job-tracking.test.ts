import { describe, expect, it, vi } from 'vitest';

import { createKbDaemonJobTracking } from '#src/coordinator/composition/kb-daemon-job-tracking.js';
import { SuccessionWriterParkedError } from '#src/store/db.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { markJobAsError } from '#src/jobs/reconcile/recovery-effects.js';
import { createMockKbDaemonSupervisor, createOnlineKbDaemonHealth } from '#tools/testing/kb-daemon-supervisor.js';

vi.mock('#src/jobs/reconcile/recovery-effects.js', () => ({ markJobAsError: vi.fn() }));

describe('KB daemon exit settlement across succession', () => {
  it.each(['reclaim', 'commit'] as const)('retains the exit settlement until writer %s', async (outcome) => {
    let unpark!: () => void;
    const unparked = new Promise<void>((resolve) => {
      unpark = resolve;
    });
    let parked = true;
    const progressStore = {
      listJobIds: () => {
        if (parked) throw new SuccessionWriterParkedError(unparked);
        return ['daemon-job'];
      },
      readStatus: () => ({ jobId: 'daemon-job', phase: 'running', jobKind: 'kb' }),
      readRuntimeProjection: () => ({ transport: 'internal', owner: 'kb-daemon' }),
    };
    const world = { log: vi.fn(), eventBus: { on: vi.fn(), off: vi.fn() } };
    let exited!: Parameters<NonNullable<ReturnType<typeof createMockKbDaemonSupervisor>['onExit']>>[0];
    const unsubscribe = vi.fn();
    const tracking = createKbDaemonJobTracking({
      runtime: createRealRuntime('prod'),
      world: world as unknown as Parameters<typeof createKbDaemonJobTracking>[0]['world'],
      getProgressStore: () =>
        progressStore as unknown as ReturnType<Parameters<typeof createKbDaemonJobTracking>[0]['getProgressStore']>,
      kbDaemonSupervisor: createMockKbDaemonSupervisor({
        onExit: (callback) => {
          exited = callback;
          return unsubscribe;
        },
      }),
      internalJobAbortRegistry: { remove: vi.fn(), register: vi.fn() } as unknown as Parameters<
        typeof createKbDaemonJobTracking
      >[0]['internalJobAbortRegistry'],
    });
    vi.mocked(markJobAsError).mockClear();
    exited(createOnlineKbDaemonHealth({ phase: 'stopped', lastError: 'daemon exited' }));
    expect(markJobAsError).not.toHaveBeenCalled();
    if (outcome === 'commit') tracking.disposeKbDaemonExitListener();
    parked = false;
    unpark();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (outcome === 'reclaim') {
      expect(markJobAsError).toHaveBeenCalledOnce();
      tracking.disposeKbDaemonExitListener();
    } else expect(markJobAsError).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
