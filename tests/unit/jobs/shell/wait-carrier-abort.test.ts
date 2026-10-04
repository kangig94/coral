import { it, expect, vi } from 'vitest';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { subscribeJobEvents } from '#src/jobs/shell/event-subscription.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { createRealTimePort } from '#src/infra/time.js';

it.each(['direct', 'v2', 'live'])(
  'ends an aborted %s wait promptly when carrier observation was in progress',
  async (mode) => {
    let finishObservation!: (value: []) => void;
    let observationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      observationStarted = resolve;
    });
    const observation = new Promise<[]>((resolve) => {
      finishObservation = resolve;
    });
    const time = createRealTimePort();
    const pollTimer = vi.spyOn(time, 'setTimeout');
    const wait = new WaitCoordinator({
      time,
      eventBus: { on: () => {}, off: () => {} },
      sessionManager: { get: () => null },
      launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] },
      loadJobProjectionDetail: () => ({
        status: { jobId: 'job-1', phase: 'running' },
        launch: null,
        runtime: null,
        exit: null,
      }),
      readJobEvents: () => [],
      aggregateWorkflowUsage: () => undefined,
      getCurrentJournalSeq: () => 0,
      resultJobsRoot: '/unused',
      subscribeJobEvents,
      observeCarriers: () => {
        observationStarted();
        return observation;
      },
    } as never);
    const controller = new AbortController();
    const request = { jobIds: ['job-1'], timeoutSeconds: 1, abortSignal: controller.signal };
    const addressing = new JobAddressing(
      {
        time,
        read: () => ({ jobId: 'job-1', epochKey: 'epoch-1', disposition: 'active-owner' }),
        unknownLocationHolds: () => [],
      } as never,
      {
        epochKey: () => 'epoch-1',
        waitStream: (r) => wait.waitForJobs(r),
        detail: () => null,
        abort: () => {
          throw new Error('unused');
        },
      },
      () => false,
      () => 'pending',
    );
    const stream =
      mode !== 'v2' ? wait.waitForJobs(request) : addressing.waitStream({ ...request, supportsWaitV2: true });
    const pending = stream.next();
    await started;
    if (mode === 'live') {
      finishObservation([]);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    controller.abort();

    let closing: ReturnType<typeof stream.return> | undefined;
    if (mode === 'v2') {
      await pending;
      closing = stream.return(undefined);
    }
    // Let the real production event subscription finish while the external observation is still in flight.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const pulse = new Promise<void>((resolve) => setTimeout(resolve, 0));
    const start = performance.now();
    finishObservation([]);
    const result = await (closing ?? pending);
    await pulse;
    const elapsed = performance.now() - start;
    const timers = pollTimer.mock.calls.length;
    await stream.return(undefined);
    expect.soft(timers).toBeLessThan(10);
    expect.soft(elapsed).toBeLessThan(200);
    expect(result.done).toBe(true);
  },
);
