import { describe, it, expect } from 'vitest';
import {
  discussAgentOpSchema,
  discussLeadOpSchema,
  sessionIdPattern,
} from '../schemas.js';

const SESSION_ID = '260221-1430-a3x7';
const session = SESSION_ID;

describe('sessionIdPattern', () => {
  it('should match valid session IDs (yymmdd-HHmm-xxxx)', () => {
    expect(sessionIdPattern.test('260221-1430-a3x7')).toBe(true);
    expect(sessionIdPattern.test('260101-0000-zzzz')).toBe(true);
  });

  it('should reject invalid session IDs', () => {
    expect(sessionIdPattern.test('260221-1430')).toBe(false);
    expect(sessionIdPattern.test('20260221-143052')).toBe(false);
    expect(sessionIdPattern.test('2026-02-21-143052-a3x7')).toBe(false);
    expect(sessionIdPattern.test('')).toBe(false);
  });
});

describe('discussAgentOpSchema', () => {
  it('should parse bid op', () => {
    const result = discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'architect', score: 75 });
    expect(result.op).toBe('bid');
  });

  it('should parse speak op', () => {
    const result = discussAgentOpSchema.parse({ op: 'speak', session, agent_name: 'architect', content: 'Hello' });
    expect(result.op).toBe('speak');
  });

  it('should reject invalid bid scores', () => {
    expect(() => discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: -1 })).toThrow();
    expect(() => discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: 101 })).toThrow();
  });

  it('should reject empty speak content', () => {
    expect(() => discussAgentOpSchema.parse({ op: 'speak', session, agent_name: 'a', content: '' })).toThrow();
  });
});

describe('discussLeadOpSchema', () => {
  const baseCreate = {
    op: '_2_create' as const,
    topic: 'Microservices vs Monolith',
    agents: [
      { name: 'architect', persona: 'Senior software architect...' },
      { name: 'critic', persona: 'Critical thinker...' },
    ],
  };

  it('should parse seed op', () => {
    const result = discussLeadOpSchema.parse({
      op: '_1_seed',
      controversy_axes: [{ axis: 'cost', positions: ['high', 'low'] }],
      n: 2,
      seed: 42,
    });
    expect(result.op).toBe('_1_seed');
  });

  it('should parse create op', () => {
    const result = discussLeadOpSchema.parse(baseCreate);
    expect(result.op).toBe('_2_create');
  });

  it('should reject invalid create payload', () => {
    expect(() =>
      discussLeadOpSchema.parse({ ...baseCreate, topic: '' } as never),
    ).toThrow();
  });

  it('should parse step op', () => {
    const result = discussLeadOpSchema.parse({ op: '_3_step', session, timeout_seconds: 60 });
    expect(result.op).toBe('_3_step');
    if (result.op !== '_3_step') return;
    expect(result.force_stop).toBe(false);
  });

  it('should parse transcript op defaults', () => {
    const result = discussLeadOpSchema.parse({ op: '_4_transcript', session });
    expect(result.op).toBe('_4_transcript');
    if (result.op !== '_4_transcript') return;
    expect(result.mode).toBe('recent');
  });

  it('should parse epoch op', () => {
    const result = discussLeadOpSchema.parse({ op: '_5_epoch', session, summary: 'Key points...' });
    expect(result.op).toBe('_5_epoch');
  });

  it('should parse state op', () => {
    const result = discussLeadOpSchema.parse({ op: '_6_state', session });
    expect(result.op).toBe('_6_state');
  });

  it('should parse end op with optional force', () => {
    const result = discussLeadOpSchema.parse({ op: '_7_end', session, force: true, reason: 'timeout' });
    expect(result.op).toBe('_7_end');
    if (result.op !== '_7_end') return;
    expect(result.force).toBe(true);
  });

  it('should parse create with quorum constraints', () => {
    expect(() => discussLeadOpSchema.parse({ ...baseCreate, agents: [baseCreate.agents[0]] })).toThrow();
    expect(() =>
      discussLeadOpSchema.parse({
        ...baseCreate,
        agents: Array.from({ length: 9 }, (_, i) => ({ name: `agent${i}`, persona: 'p' })),
      } as never)
    ).toThrow();
  });

  it('should reject invalid step timeout', () => {
    expect(() => discussLeadOpSchema.parse({ op: '_3_step', session, timeout_seconds: 0 })).toThrow();
    expect(() => discussLeadOpSchema.parse({ op: '_3_step', session, timeout_seconds: 121 })).toThrow();
  });

  it('should reject invalid epoch payloads', () => {
    expect(() => discussLeadOpSchema.parse({ op: '_5_epoch', session, summary: '' })).toThrow();
  });

  it('should reject session on _2_create', () => {
    expect(() =>
      discussLeadOpSchema.parse({ op: '_2_create', topic: 'x', agents: baseCreate.agents, session } as never),
    ).toThrow();
  });
});
