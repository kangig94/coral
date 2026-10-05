import { progressVisitFromEvents } from '#tests/helpers/wait-progress.js';
import { describe, expect, it } from 'vitest';

import { planCarrierWaitEvents, type CarrierWaitObservation } from '#src/jobs/shell/wait.js';

const JOB_A = 'job-a';
const JOB_B = 'job-b';

function observation(jobId: string, liveness: CarrierWaitObservation['liveness']): CarrierWaitObservation {
  return { jobId, liveness, storedPhase: 'running', observedMaxJournalSeq: 9 };
}

describe('planCarrierWaitEvents', () => {
  it('turns an absent carrier into one nonterminal interruption', () => {
    const pending = new Set([JOB_A, JOB_B]);

    const reported = new Set<string>();
    const plan = planCarrierWaitEvents([observation(JOB_A, 'absent')], pending, reported);
    expect(planCarrierWaitEvents([observation(JOB_A, 'absent')], pending, reported).interrupted).toEqual([]);

    expect(plan.interrupted).toEqual([
      {
        type: 'interrupted',
        jobId: JOB_A,
        storedPhase: 'running',
        observedMaxJournalSeq: 9,
        remainingJobIds: [JOB_A, JOB_B],
        observation: { kind: 'carrier_interrupted', reason: 'carrier_absent' },
        continuity: 'unavailable',
        outcome: 'unknown',
      },
    ]);
    // Nothing left `pending`: the job is still running as far as the journal is concerned, and only the
    // journal may end it.
    expect(pending).toEqual(new Set([JOB_A, JOB_B]));
  });

  it('preserves unknown for a missing observer reply', () => {
    const plan = planCarrierWaitEvents([observation(JOB_A, 'live')], new Set([JOB_A, JOB_B]), new Set());
    expect(plan.unknownJobIds).toEqual([JOB_B]);
  });

  it('collects unknowns for the waiting snapshot in sorted order and emits nothing for them', () => {
    const plan = planCarrierWaitEvents(
      [observation(JOB_B, 'unknown'), observation(JOB_A, 'unknown')],
      new Set([JOB_A, JOB_B]),
      new Set(),
    );

    expect(plan.interrupted).toEqual([]);
    expect(plan.unknownJobIds).toEqual([JOB_A, JOB_B]);
  });
});

it.each(['initial', 'poll', 'throw'])('the stream deadline bounds %s carrier observation', async (stall) => {
  const { WaitCoordinator } = await import('#src/jobs/shell/wait.js');
  const { VirtualTime, flushMicrotasks } = await import('#tools/simulation/core/virtual-time.js');
  const time = new VirtualTime();
  const stuck = new Promise<never>(() => {});
  let calls = 0;
  const wait = new WaitCoordinator({
    visitProgress: progressVisitFromEvents(
      () => [],
      () => 0,
    ),
    time,
    eventBus: { on: () => {}, off: () => {} },
    sessionManager: { get: () => null },
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] },
    loadJobProjectionDetail: () => ({
      status: { jobId: JOB_A, phase: 'running' },
      launch: null,
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
    subscribeJobEvents: () => ({ [Symbol.asyncIterator]: () => ({ next: () => stuck, return: () => stuck }) }),
    observeCarriers: async () => {
      calls++;
      if (stall === 'throw') throw new Error('observer unavailable');
      return stall === 'poll' && calls === 1 ? [observation(JOB_A, 'unknown')] : stuck;
    },
  } as never);
  const stream = wait.waitForJobs({ jobIds: [JOB_A], timeoutSeconds: 1 });
  const next = stream.next();
  await flushMicrotasks(20);
  for (let i = 0; i < 4; i++) {
    time.tick(250);
    await flushMicrotasks(20);
  }
  await expect(next).resolves.toMatchObject({
    done: false,
    value: { type: 'waiting', waitingJobIds: [JOB_A], carrierUnknownJobIds: [JOB_A] },
  });
  await stream.return(undefined);
  expect(calls).toBe(stall === 'initial' ? 1 : 2);
});
