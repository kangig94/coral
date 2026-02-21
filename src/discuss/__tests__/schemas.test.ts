import { describe, it, expect } from 'vitest';
import {
  discussOpSchema,
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

describe('discussOpSchema', () => {
  const session = '260221-1430-a3x7';
  const baseCreate = {
    op: 'create' as const,
    topic: 'Microservices vs Monolith',
    agents: [
      { name: 'architect', persona: 'Senior software architect...' },
      { name: 'critic', persona: 'Critical thinker...' },
    ],
  };

  it('should parse create op with defaults', () => {
    const result = discussOpSchema.parse(baseCreate);
    expect(result.op).toBe('create');
    if (result.op !== 'create') throw new Error('unexpected op');
    expect(result.quota_per_epoch).toBe(3);
    expect(result.recent_turns).toBe(5);
  });

  it('should parse bid op', () => {
    const result = discussOpSchema.parse({ op: 'bid', session, agent_name: 'architect', score: 75 });
    expect(result.op).toBe('bid');
  });

  it('should parse wait op', () => {
    const result = discussOpSchema.parse({ op: 'wait', session, condition: 'all_bids', timeout_seconds: 5 });
    expect(result.op).toBe('wait');
  });

  it('should parse speak op', () => {
    const result = discussOpSchema.parse({ op: 'speak', session, agent_name: 'architect', content: 'Hello' });
    expect(result.op).toBe('speak');
  });

  it('should parse transcript op and default mode to recent', () => {
    const result = discussOpSchema.parse({ op: 'transcript', session });
    expect(result.op).toBe('transcript');
    if (result.op !== 'transcript') throw new Error('unexpected op');
    expect(result.mode).toBe('recent');
  });

  it('should parse state op', () => {
    const result = discussOpSchema.parse({ op: 'state', session });
    expect(result.op).toBe('state');
  });

  it('should parse end op', () => {
    const result = discussOpSchema.parse({ op: 'end', session });
    expect(result.op).toBe('end');
  });

  it('should parse epoch_summary op', () => {
    const result = discussOpSchema.parse({ op: 'epoch_summary', session, epoch: 1, summary: 'Key points...' });
    expect(result.op).toBe('epoch_summary');
  });

  it('should reject invalid op discriminator value', () => {
    expect(() => discussOpSchema.parse({ op: 'invalid_op' })).toThrow();
  });

  it('should reject missing op discriminator', () => {
    expect(() => discussOpSchema.parse({ session })).toThrow();
  });

  it('should reject create with < 2 agents', () => {
    expect(() => discussOpSchema.parse({ ...baseCreate, agents: [baseCreate.agents[0]] })).toThrow();
  });

  it('should reject create with > 8 agents', () => {
    const manyAgents = Array.from({ length: 9 }, (_, i) => ({ name: `agent${i}`, persona: 'p' }));
    expect(() => discussOpSchema.parse({ ...baseCreate, agents: manyAgents })).toThrow();
  });

  it('should reject duplicate agent names in create', () => {
    expect(() =>
      discussOpSchema.parse({
        ...baseCreate,
        agents: [
          { name: 'architect', persona: 'p1' },
          { name: 'architect', persona: 'p2' },
        ],
      }),
    ).toThrow(/unique/i);
  });

  it('should reject invalid agent name chars in create', () => {
    expect(() =>
      discussOpSchema.parse({
        ...baseCreate,
        agents: [{ name: 'invalid!', persona: 'p' }, { name: 'critic', persona: 'p' }],
      }),
    ).toThrow();
  });

  it('should enforce create quota_per_epoch bounds', () => {
    expect(() => discussOpSchema.parse({ ...baseCreate, quota_per_epoch: 0 })).toThrow();
    expect(() => discussOpSchema.parse({ ...baseCreate, quota_per_epoch: 11 })).toThrow();
    const min = discussOpSchema.parse({ ...baseCreate, quota_per_epoch: 1 });
    const max = discussOpSchema.parse({ ...baseCreate, quota_per_epoch: 10 });
    expect(min.op).toBe('create');
    expect(max.op).toBe('create');
  });

  it('should reject bid score out of range', () => {
    expect(() => discussOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: -1 })).toThrow();
    expect(() => discussOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: 101 })).toThrow();
  });

  it('should reject bid with invalid session ID format', () => {
    expect(() => discussOpSchema.parse({ op: 'bid', session: 'bad-session', agent_name: 'a', score: 50 })).toThrow();
    expect(() => discussOpSchema.parse({ op: 'bid', session: '../etc', agent_name: 'a', score: 50 })).toThrow();
  });

  it('should reject wait with invalid condition', () => {
    expect(() => discussOpSchema.parse({ op: 'wait', session, condition: 'unknown', timeout_seconds: 10 })).toThrow();
  });

  it('should reject wait with timeout < 1', () => {
    expect(() => discussOpSchema.parse({ op: 'wait', session, condition: 'all_bids', timeout_seconds: 0 })).toThrow();
  });

  it('should allow wait action_needed without agent_name structurally', () => {
    const result = discussOpSchema.parse({ op: 'wait', session, condition: 'action_needed', timeout_seconds: 10 });
    expect(result.op).toBe('wait');
  });

  it('should reject speak with empty content', () => {
    expect(() => discussOpSchema.parse({ op: 'speak', session, agent_name: 'a', content: '' })).toThrow();
  });

  it('should accept transcript modes and enforce last_n bounds', () => {
    const full = discussOpSchema.parse({ op: 'transcript', session, mode: 'full' });
    const summary = discussOpSchema.parse({ op: 'transcript', session, mode: 'summary' });
    expect(full.op).toBe('transcript');
    expect(summary.op).toBe('transcript');
    expect(() => discussOpSchema.parse({ op: 'transcript', session, last_n: 0 })).toThrow();
    expect(() => discussOpSchema.parse({ op: 'transcript', session, last_n: 51 })).toThrow();
  });

  it('should keep end validation structural only', () => {
    const result = discussOpSchema.parse({ op: 'end', session, force: true });
    expect(result.op).toBe('end');
  });

  it('should reject epoch_summary with epoch < 1', () => {
    expect(() => discussOpSchema.parse({ op: 'epoch_summary', session, epoch: 0, summary: 'x' })).toThrow();
  });

  it('should reject epoch_summary with empty summary', () => {
    expect(() => discussOpSchema.parse({ op: 'epoch_summary', session, epoch: 1, summary: '' })).toThrow();
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
