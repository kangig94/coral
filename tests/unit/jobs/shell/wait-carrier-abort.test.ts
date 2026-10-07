import { nextDelivered } from '#tests/helpers/wait-stream.js';
import { progressVisitFromEvents, progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { it, expect } from 'vitest';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { subscribeJobEvents } from '#src/jobs/shell/event-subscription.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { createRealTimePort } from '#src/infra/time.js';

it.each(['direct', 'addressed', 'live'])(
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
    const wait = new WaitCoordinator({
      visitProgress: progressVisitFromEvents(() => []),
      time,
      eventBus: { on: () => {}, off: () => {} },
      sessionManager: { get: () => null },
      launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] },
      readJobLastSeq: () => null,
      loadJobWaitDetail: () => ({
        status: { jobId: 'job-1', phase: 'running' },
        runtime: null,
        exit: null,
      }),

      aggregateWorkflowUsage: () => undefined,
      getCurrentJournalSeq: () => 0,
      resultJobsRoot: '/unused',
      observeResultAvailability: (jobId: string) => ({
        kind: 'available',
        resultPath: `${'/unused'}/${jobId}/result.md`,
      }),
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
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'epoch-1',
        observeWaitCarriers: (ids, signal) => wait.observeWaitCarriers(ids, signal),
        detail: () => null,
        readWaitAdmission: (jobId, epochKey) => wait.readWaitAdmissions([jobId], epochKey)[0],
        abort: () => {
          throw new Error('unused');
        },
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
    );
    const stream = mode !== 'addressed' ? wait.waitForOutcomes(request) : addressing.waitStream(request);
    const pending = nextDelivered(stream);
    await started;
    if (mode === 'live') {
      finishObservation([]);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    controller.abort();

    let closing: ReturnType<typeof stream.return> | undefined;
    if (mode === 'addressed') {
      await pending;
      closing = stream.return(undefined);
    }
    // Let the real production event subscription finish while the external observation is still in flight.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    finishObservation([]);
    const result = await (closing ?? pending);
    await stream.return(undefined);
    expect(result.done).toBe(true);
  },
);
