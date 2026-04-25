import { describe, expect, it } from 'vitest';

import {
  discussEventBodySchemas,
  discussEventKinds,
  makeEvent,
  type DiscussDomainEvent,
} from '#src/discuss/events.js';
import { toJournalInput } from '#src/discuss/store-registry.js';

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
});
