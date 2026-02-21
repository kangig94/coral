import { describe, it, expect } from 'vitest';
import {
  discussCreateSchema,
  discussBidSchema,
  discussWaitSchema,
  discussSpeakSchema,
  discussTranscriptSchema,
  discussStateSchema,
  discussEndSchema,
  discussEpochSummarySchema,
  discussPersonaSeedSchema,
  sessionIdPattern,
} from '../schemas.js';

describe('sessionIdPattern', () => {
  it('should match valid session IDs (yymmdd-HHmm-xxxx)', () => {
    expect(sessionIdPattern.test('260221-1430-a3x7')).toBe(true);
    expect(sessionIdPattern.test('260101-0000-zzzz')).toBe(true);
  });
  it('should reject invalid session IDs', () => {
    expect(sessionIdPattern.test('260221-1430')).toBe(false); // missing suffix
    expect(sessionIdPattern.test('20260221-143052')).toBe(false); // missing suffix
    expect(sessionIdPattern.test('20260221-143052-a3x7')).toBe(false); // old 8-digit-year format
    expect(sessionIdPattern.test('2026-02-21-143052-a3x7')).toBe(false); // wrong date format
    expect(sessionIdPattern.test('')).toBe(false);
    expect(sessionIdPattern.test('../etc/passwd')).toBe(false);
  });
});

describe('discussCreateSchema', () => {
  const valid = {
    topic: 'Microservices vs Monolith',
    agents: [
      { name: 'architect', persona: 'Senior software architect...' },
      { name: 'critic', persona: 'Critical thinker...' },
    ],
  };

  it('should accept valid input with defaults', () => {
    const result = discussCreateSchema.parse(valid);
    expect(result.quota_per_epoch).toBe(3);
    expect(result.recent_turns).toBe(5);
  });

  it('should reject < 2 agents', () => {
    expect(() => discussCreateSchema.parse({ ...valid, agents: [valid.agents[0]] })).toThrow();
  });

  it('should reject > 8 agents', () => {
    const manyAgents = Array.from({ length: 9 }, (_, i) => ({ name: `agent${i}`, persona: 'p' }));
    expect(() => discussCreateSchema.parse({ ...valid, agents: manyAgents })).toThrow();
  });

  it('should reject duplicate agent names', () => {
    expect(() =>
      discussCreateSchema.parse({
        ...valid,
        agents: [
          { name: 'architect', persona: 'p1' },
          { name: 'architect', persona: 'p2' },
        ],
      }),
    ).toThrow(/unique/i);
  });

  it('should reject agent names with invalid characters', () => {
    expect(() =>
      discussCreateSchema.parse({
        ...valid,
        agents: [{ name: 'invalid!', persona: 'p' }, { name: 'critic', persona: 'p' }],
      }),
    ).toThrow();
  });

  it('should enforce quota_per_epoch bounds', () => {
    expect(() => discussCreateSchema.parse({ ...valid, quota_per_epoch: 0 })).toThrow();
    expect(() => discussCreateSchema.parse({ ...valid, quota_per_epoch: 11 })).toThrow();
    expect(discussCreateSchema.parse({ ...valid, quota_per_epoch: 1 }).quota_per_epoch).toBe(1);
    expect(discussCreateSchema.parse({ ...valid, quota_per_epoch: 10 }).quota_per_epoch).toBe(10);
  });
});

describe('discussBidSchema', () => {
  const validSession = '260221-1430-a3x7';

  it('should accept valid bid', () => {
    const result = discussBidSchema.parse({ session: validSession, agent_name: 'architect', score: 75 });
    expect(result.score).toBe(75);
  });

  it('should accept boundary scores', () => {
    expect(discussBidSchema.parse({ session: validSession, agent_name: 'a', score: 0 }).score).toBe(0);
    expect(discussBidSchema.parse({ session: validSession, agent_name: 'a', score: 100 }).score).toBe(100);
  });

  it('should reject score out of range', () => {
    expect(() => discussBidSchema.parse({ session: validSession, agent_name: 'a', score: -1 })).toThrow();
    expect(() => discussBidSchema.parse({ session: validSession, agent_name: 'a', score: 101 })).toThrow();
  });

  it('should reject invalid session ID format', () => {
    expect(() => discussBidSchema.parse({ session: 'bad-session', agent_name: 'a', score: 50 })).toThrow();
    expect(() => discussBidSchema.parse({ session: '../etc', agent_name: 'a', score: 50 })).toThrow();
  });
});

describe('discussWaitSchema', () => {
  const session = '260221-1430-a3x7';

  it('should accept all_bids up to 60s', () => {
    const result = discussWaitSchema.parse({ session, condition: 'all_bids', timeout_seconds: 60 });
    expect(result.condition).toBe('all_bids');
  });

  it('should reject all_bids timeout > 60s', () => {
    expect(() => discussWaitSchema.parse({ session, condition: 'all_bids', timeout_seconds: 61 })).toThrow();
  });

  it('should accept speech_delivered up to 120s', () => {
    const result = discussWaitSchema.parse({ session, condition: 'speech_delivered', timeout_seconds: 120 });
    expect(result.condition).toBe('speech_delivered');
  });

  it('should reject speech_delivered timeout > 120s', () => {
    expect(() => discussWaitSchema.parse({ session, condition: 'speech_delivered', timeout_seconds: 121 })).toThrow();
  });

  it('should accept action_needed with agent_name up to 180s', () => {
    const result = discussWaitSchema.parse({ session, condition: 'action_needed', timeout_seconds: 180, agent_name: 'alice' });
    expect(result.agent_name).toBe('alice');
  });

  it('should reject action_needed without agent_name', () => {
    expect(() => discussWaitSchema.parse({ session, condition: 'action_needed', timeout_seconds: 60 })).toThrow(/agent_name/i);
  });

  it('should reject invalid condition', () => {
    expect(() => discussWaitSchema.parse({ session, condition: 'unknown', timeout_seconds: 10 })).toThrow();
  });

  it('should reject timeout < 1', () => {
    expect(() => discussWaitSchema.parse({ session, condition: 'all_bids', timeout_seconds: 0 })).toThrow();
  });
});

describe('discussEndSchema', () => {
  const session = '260221-1430-a3x7';

  it('should accept normal end', () => {
    const result = discussEndSchema.parse({ session });
    expect(result.force).toBe(false);
  });

  it('should require reason when force=true', () => {
    expect(() => discussEndSchema.parse({ session, force: true })).toThrow(/reason/i);
    expect(() => discussEndSchema.parse({ session, force: true, reason: '   ' })).toThrow(/reason/i);
    expect(discussEndSchema.parse({ session, force: true, reason: 'timeout' }).reason).toBe('timeout');
  });
});

describe('discussEpochSummarySchema', () => {
  const session = '260221-1430-a3x7';

  it('should accept valid input', () => {
    const result = discussEpochSummarySchema.parse({ session, epoch: 1, summary: 'Key points...' });
    expect(result.epoch).toBe(1);
  });

  it('should reject epoch < 1', () => {
    expect(() => discussEpochSummarySchema.parse({ session, epoch: 0, summary: 'x' })).toThrow();
  });

  it('should reject empty summary', () => {
    expect(() => discussEpochSummarySchema.parse({ session, epoch: 1, summary: '' })).toThrow();
  });
});

describe('discussTranscriptSchema', () => {
  const session = '260221-1430-a3x7';

  it('should default mode to recent', () => {
    const result = discussTranscriptSchema.parse({ session });
    expect(result.mode).toBe('recent');
  });

  it('should accept all modes', () => {
    expect(discussTranscriptSchema.parse({ session, mode: 'full' }).mode).toBe('full');
    expect(discussTranscriptSchema.parse({ session, mode: 'summary' }).mode).toBe('summary');
  });

  it('should enforce last_n bounds', () => {
    expect(() => discussTranscriptSchema.parse({ session, last_n: 0 })).toThrow();
    expect(() => discussTranscriptSchema.parse({ session, last_n: 51 })).toThrow();
    expect(discussTranscriptSchema.parse({ session, last_n: 10 }).last_n).toBe(10);
  });
});

describe('discussStateSchema', () => {
  it('should accept valid session ID', () => {
    const result = discussStateSchema.parse({ session: '260221-1430-a3x7' });
    expect(result.session).toBeTruthy();
  });
});

describe('discussSpeakSchema', () => {
  const session = '260221-1430-a3x7';

  it('should require non-empty content', () => {
    expect(() => discussSpeakSchema.parse({ session, agent_name: 'a', content: '' })).toThrow();
  });

  it('should accept valid speech', () => {
    const result = discussSpeakSchema.parse({ session, agent_name: 'architect', content: 'Microservices are...' });
    expect(result.content).toBeTruthy();
  });
});

describe('discussPersonaSeedSchema', () => {
  const valid = {
    controversy_axes: [
      { axis: 'cost', positions: ['high', 'low'] },
      { axis: 'risk', positions: ['high', 'low'] },
    ],
    n: 4,
    seed: 42,
  };

  it('should parse valid input', () => {
    const result = discussPersonaSeedSchema.parse(valid);
    expect(result.n).toBe(4);
    expect(result.seed).toBe(42);
  });

  it('should reject duplicate axis names', () => {
    expect(() =>
      discussPersonaSeedSchema.parse({
        ...valid,
        controversy_axes: [
          { axis: 'cost', positions: ['high', 'low'] },
          { axis: 'cost', positions: ['strict', 'relaxed'] },
        ],
      }),
    ).toThrow(/axis names must be unique/i);
  });

  it('should reject duplicate positions within an axis', () => {
    expect(() =>
      discussPersonaSeedSchema.parse({
        ...valid,
        controversy_axes: [
          { axis: 'cost', positions: ['high', 'high'] },
          { axis: 'risk', positions: ['high', 'low'] },
        ],
      }),
    ).toThrow(/positions within an axis must be unique/i);
  });

  it('should reject out-of-range n', () => {
    expect(() => discussPersonaSeedSchema.parse({ ...valid, n: 0 })).toThrow();
    expect(() => discussPersonaSeedSchema.parse({ ...valid, n: 9 })).toThrow();
  });

  it('should default seed to null and accept explicit null', () => {
    const withNull = discussPersonaSeedSchema.parse({ ...valid, seed: null });
    const withoutSeed = discussPersonaSeedSchema.parse({
      controversy_axes: valid.controversy_axes,
      n: valid.n,
    });
    expect(withNull.seed).toBeNull();
    expect(withoutSeed.seed).toBeNull();
  });
});
