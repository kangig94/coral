import { describe, expect, it } from 'vitest';

import { makeEvent, type DiscussDomainEvent } from '#src/discuss/events.js';

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
