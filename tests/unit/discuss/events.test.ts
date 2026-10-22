import { describe, expect, it } from 'vitest';

import {
  bidSubmittedPayloadSchema,
  discussEventBodySchemas,
  discussRunBindingSchema,
  persistedDiscussRuntimeSchema,
  makeEvent,
  sessionCreatedConfigSchema,
} from '#src/discuss/events.js';
import { toJournalInput } from '#src/discuss/event-registry.js';

const NOW = '2026-03-11T00:00:00.000Z';

describe('discuss event body schemas', () => {
  it('binds an agent to a canonical job UUID', () => {
    const jobId = '10000000-0000-4000-8000-000000000001';
    expect(discussRunBindingSchema.safeParse({ agent: 'alpha', jobId }).success).toBe(true);
    expect(discussRunBindingSchema.safeParse({ agent: 'alpha', jobId: 'job-1' }).success).toBe(false);
    expect(discussRunBindingSchema.safeParse({ agent: 'alpha', executionSessionId: jobId }).success).toBe(false);
  });

  it('requires a positive safe execution ordinal on starts and finishes', () => {
    const jobId = '10000000-0000-4000-8000-000000000001';
    for (const execution of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        discussEventBodySchemas['agent.job.started'].safeParse({
          sourceSeq: 1,
          agent: 'alpha',
          jobId,
          execution,
          purpose: 'bid',
          attempt: 1,
        }).success,
      ).toBe(false);
      expect(
        discussEventBodySchemas['agent.job.finished'].safeParse({
          sourceSeq: 1,
          agent: 'alpha',
          jobId,
          execution,
          outcome: 'completed',
          attempt: 1,
        }).success,
      ).toBe(false);
    }
  });

  it('requires active run state to name its bound job and execution together', () => {
    const jobId = '10000000-0000-4000-8000-000000000001';
    const run = {
      provider: 'codex',
      model: 'gpt-5',
      jobId,
      currentJobId: jobId,
      currentExecution: 2,
      currentJobPurpose: 'bid',
      currentAttempt: 1,
    };
    const runtime = (agent: object) => ({
      controlPhase: 'idle',
      carryForwardMustAnswer: [],
      followUpQueue: [],
      agentRuns: { alpha: agent },
    });
    expect(persistedDiscussRuntimeSchema.safeParse(runtime(run)).success).toBe(true);
    expect(persistedDiscussRuntimeSchema.safeParse(runtime({ ...run, currentExecution: undefined })).success).toBe(
      false,
    );
    expect(persistedDiscussRuntimeSchema.safeParse(runtime({ ...run, jobId: undefined })).success).toBe(false);
    expect(persistedDiscussRuntimeSchema.safeParse(runtime({ ...run, currentJobId: undefined })).success).toBe(false);
  });

  it('rejects unknown Journal body fields', () => {
    const event = makeEvent('session-1', '/tmp/project', 'Topic', 2, 'bid.submitted', NOW, {
      agent: 'alpha',
      score: 57,
      thought: 'Need to respond now.',
    });
    const input = toJournalInput(event);

    expect(discussEventBodySchemas['bid.submitted'].safeParse(input.body).success).toBe(true);
    expect(
      discussEventBodySchemas['bid.submitted'].safeParse({
        ...input.body,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('rejects invalid agent job purpose and outcome vocabulary', () => {
    const started = toJournalInput(
      makeEvent('session-1', '/tmp/project', 'Topic', 3, 'agent.job.started', NOW, {
        agent: 'alpha',
        jobId: '10000000-0000-4000-8000-000000000001',
        execution: 1,
        purpose: 'bid',
        attempt: 1,
      }),
    );
    const finished = toJournalInput(
      makeEvent('session-1', '/tmp/project', 'Topic', 4, 'agent.job.finished', NOW, {
        agent: 'alpha',
        jobId: '10000000-0000-4000-8000-000000000001',
        execution: 1,
        outcome: 'retryable_parse_error',
        attempt: 1,
      }),
    );

    expect(discussEventBodySchemas['agent.job.started'].safeParse(started.body).success).toBe(true);
    expect(discussEventBodySchemas['agent.job.finished'].safeParse(finished.body).success).toBe(true);
    expect(
      discussEventBodySchemas['agent.job.started'].safeParse({
        ...started.body,
        purpose: 'moderator',
      }).success,
    ).toBe(false);
    expect(
      discussEventBodySchemas['agent.job.finished'].safeParse({
        ...finished.body,
        outcome: 'moderator_failed',
      }).success,
    ).toBe(false);
  });

  it('rejects non-finite persisted config numbers', () => {
    expect(
      sessionCreatedConfigSchema.safeParse({
        bidThreshold: 0.75,
        maxEpochs: 3,
        quotaPerEpoch: 2,
      }).success,
    ).toBe(true);

    expect(
      sessionCreatedConfigSchema.safeParse({
        bidThreshold: Infinity,
        maxEpochs: 3,
        quotaPerEpoch: 2,
      }).success,
    ).toBe(false);
  });

  it('requires bid scores to be integer percentages from 0 through 100', () => {
    expect(
      bidSubmittedPayloadSchema.safeParse({
        agent: 'alpha',
        score: 100,
        thought: 'Strong response.',
      }).success,
    ).toBe(true);

    for (const score of [-1, 50.5]) {
      expect(
        bidSubmittedPayloadSchema.safeParse({
          agent: 'alpha',
          score,
          thought: 'Invalid score.',
        }).success,
      ).toBe(false);
    }
  });
});
