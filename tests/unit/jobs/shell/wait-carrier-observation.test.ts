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

    const plan = planCarrierWaitEvents([observation(JOB_A, 'absent')], pending, new Set());

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

  it('reports the same absence once across ticks', () => {
    const pending = new Set([JOB_A]);
    const reported = new Set<string>();

    const first = planCarrierWaitEvents([observation(JOB_A, 'absent')], pending, reported);
    const second = planCarrierWaitEvents([observation(JOB_A, 'absent')], pending, reported);

    // Observation runs on every poll tick; the event reports a discovery, so restating it each tick would
    // say the same thing indefinitely while the job is still pending.
    expect(first.interrupted).toHaveLength(1);
    expect(second.interrupted).toEqual([]);
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

  it('says nothing at all about a live carrier', () => {
    const plan = planCarrierWaitEvents([observation(JOB_A, 'live')], new Set([JOB_A]), new Set());

    expect(plan).toEqual({ interrupted: [], unknownJobIds: [] });
  });

  it('ignores a verdict about a job this stream is no longer waiting on', () => {
    // A reply can arrive after its job terminalized. Emitting an interruption for it would contradict a
    // journal terminal that has already been delivered.
    const plan = planCarrierWaitEvents([observation(JOB_B, 'absent')], new Set([JOB_A]), new Set());

    expect(plan).toEqual({ interrupted: [], unknownJobIds: [] });
  });
});
