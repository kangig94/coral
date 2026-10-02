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
