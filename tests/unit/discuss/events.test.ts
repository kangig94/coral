import { describe, expect, it } from 'vitest';

import {
  bidSubmittedPayloadSchema,
  discussEventBodySchemas,
  makeEvent,
  sessionCreatedConfigSchema,
} from '#src/discuss/events.js';
import { toJournalInput } from '#src/discuss/event-registry.js';

const NOW = '2026-03-11T00:00:00.000Z';

describe('discuss event body schemas', () => {
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
        jobId: 'job-1',
        purpose: 'bid',
        attempt: 1,
      }),
    );
    const finished = toJournalInput(
      makeEvent('session-1', '/tmp/project', 'Topic', 4, 'agent.job.finished', NOW, {
        agent: 'alpha',
        jobId: 'job-1',
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
