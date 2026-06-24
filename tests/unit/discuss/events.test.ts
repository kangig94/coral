import { describe, expect, it } from 'vitest';

import {
  bidSubmittedPayloadSchema,
  discussEventBodySchemas,
  discussEventKinds,
  makeEvent,
  sessionCreatedConfigSchema,
  type DiscussDomainEvent,
} from '#src/discuss/events.js';
import { toJournalInput } from '#src/discuss/event-registry.js';

const NOW = '2026-03-11T00:00:00.000Z';

function describeEvent(event: DiscussDomainEvent): string {
  switch (event.kind) {
    case 'bid.submitted':
      return `${event.payload.agent}:${event.payload.score}`;
    case 'session.created':
      return event.payload.input.topic;
    default:
      return event.kind;
  }
}

describe('makeEvent', () => {
  it('constructs a versioned event envelope', () => {
    const event = makeEvent('session-1', '/tmp/project', 'Topic', 4, 'agent.job.started', NOW, {
      agent: 'alpha',
      jobId: 'job-1',
      purpose: 'bid',
      attempt: 2,
    });

    expect(event).toEqual({
      v: 1,
      sessionId: 'session-1',
      projectRoot: '/tmp/project',
      topic: 'Topic',
      seq: 4,
      kind: 'agent.job.started',
      ts: NOW,
      payload: {
        agent: 'alpha',
        jobId: 'job-1',
        purpose: 'bid',
        attempt: 2,
      },
    });
  });

  it('supports kind-based narrowing on the discriminated union', () => {
    const event: DiscussDomainEvent = makeEvent('session-1', '/tmp/project', 'Topic', 2, 'bid.submitted', NOW, {
      agent: 'alpha',
      score: 57,
      thought: 'Need to respond now.',
    });

    expect(describeEvent(event)).toBe('alpha:57');
  });
});

describe('discuss event body schemas', () => {
  it('defines one strict Journal body schema per discuss event kind', () => {
    expect(Object.keys(discussEventBodySchemas).sort()).toEqual([...discussEventKinds].sort());
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

  it('accepts forced bid-round winners in the persisted event schema', () => {
    const event = toJournalInput(
      makeEvent('session-1', '/tmp/project', 'Topic', 5, 'bid.round.closed', NOW, {
        allBids: { alpha: 10, beta: 20 },
        effectiveBids: { alpha: 10, beta: 20 },
        thoughts: { alpha: 'low', beta: 'still useful' },
        outcome: { winner: 'beta', speaker_type: 'forced' },
        stateMutations: { cold_start: false },
      }),
    );

    expect(discussEventBodySchemas['bid.round.closed'].safeParse(event.body).success).toBe(true);
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

    for (const score of [-1, 101, 50.5, Infinity, Number.NaN]) {
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
