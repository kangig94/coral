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
    const result = discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'architect', score: 75, thought: 'I want to address the scalability concern.' });
    expect(result.op).toBe('bid');
  });

  it('should parse speak op', () => {
    const result = discussAgentOpSchema.parse({ op: 'speak', session, agent_name: 'architect', content: 'Hello' });
    expect(result.op).toBe('speak');
  });

  it('should reject bid without thought', () => {
    expect(() => discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: 75 })).toThrow();
  });

  it('should reject bid with empty thought', () => {
    expect(() => discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: 75, thought: '' })).toThrow();
  });

  it('should reject invalid bid scores', () => {
    expect(() => discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: -1, thought: 'x' })).toThrow();
    expect(() => discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: 101, thought: 'x' })).toThrow();
  });

  it('should accept whitespace-only thought (min(1) allows spaces)', () => {
    expect(() => discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: 75, thought: ' ' })).not.toThrow();
    expect(() => discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: 75, thought: '\t' })).not.toThrow();
  });

  it('should reject non-string thought values', () => {
    expect(() => discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: 75, thought: 42 } as never)).toThrow();
    expect(() => discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: 75, thought: null } as never)).toThrow();
    expect(() => discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: 75, thought: true } as never)).toThrow();
  });

  it('should reject extra fields on bid payload (strict schema)', () => {
    expect(() => discussAgentOpSchema.parse({ op: 'bid', session, agent_name: 'a', score: 75, thought: 'valid', extra: 'x' } as never)).toThrow();
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

  it('parses _1_seed with valid demographics payload', () => {
    const result = discussLeadOpSchema.parse({
      op: '_1_seed',
      controversy_axes: [{ axis: 'cost', positions: ['high', 'low'] }],
      demographics: {
        origin_weights: { US: 0.5, DE: 0.3, NG: 0.2 },
        outlier_ratio: 0.2,
      },
      n: 3,
      seed: 12,
    });
    if (result.op !== '_1_seed') return;
    expect(result.demographics).toEqual({
      origin_weights: { US: 0.5, DE: 0.3, NG: 0.2 },
      outlier_ratio: 0.2,
    });
  });

  it('defaults outlier_ratio when omitted from demographics', () => {
    const result = discussLeadOpSchema.parse({
      op: '_1_seed',
      controversy_axes: [{ axis: 'cost', positions: ['high', 'low'] }],
      demographics: {
        origin_weights: { US: 1 },
      },
      n: 1,
      seed: 12,
    });
    if (result.op !== '_1_seed') return;
    expect(result.demographics?.outlier_ratio).toBe(0.2);
  });

  it('rejects empty origin_weights', () => {
    expect(() =>
      discussLeadOpSchema.parse({
        op: '_1_seed',
        controversy_axes: [{ axis: 'cost', positions: ['high', 'low'] }],
        demographics: {
          origin_weights: {},
          outlier_ratio: 0.2,
        },
        n: 1,
      } as never),
    ).toThrow();
  });

  it('rejects negative origin weights in demographics', () => {
    expect(() =>
      discussLeadOpSchema.parse({
        op: '_1_seed',
        controversy_axes: [{ axis: 'cost', positions: ['high', 'low'] }],
        demographics: {
          origin_weights: { US: -0.5 },
          outlier_ratio: 0.2,
        },
        n: 1,
      } as never),
    ).toThrow();
  });

  it('rejects outlier_ratio above 0.5', () => {
    expect(() =>
      discussLeadOpSchema.parse({
        op: '_1_seed',
        controversy_axes: [{ axis: 'cost', positions: ['high', 'low'] }],
        demographics: {
          origin_weights: { US: 0.5 },
          outlier_ratio: 0.75,
        },
        n: 1,
      } as never),
    ).toThrow();
  });

  it('rejects unknown fields in demographics payload', () => {
    expect(() =>
      discussLeadOpSchema.parse({
        op: '_1_seed',
        controversy_axes: [{ axis: 'cost', positions: ['high', 'low'] }],
        demographics: {
          origin_weights: { US: 0.5 },
          outlier_ratio: 0.2,
          unexpected: true,
        },
        n: 1,
      } as never),
    ).toThrow();
  });

  it('parses seed op without demographics', () => {
    const result = discussLeadOpSchema.parse({
      op: '_1_seed',
      controversy_axes: [{ axis: 'cost', positions: ['high', 'low'] }],
      n: 3,
      seed: null,
    });
    if (result.op !== '_1_seed') return;
    expect(result.demographics).toBeUndefined();
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


describe('demographicsShape via seedShape: outlier_ratio edge values', () => {
  const baseAxes = [{ axis: 'cost', positions: ['high', 'low'] }];

  it('outlier_ratio = 0 is valid (minimum boundary)', () => {
    const result = discussLeadOpSchema.parse({
      op: '_1_seed',
      controversy_axes: baseAxes,
      demographics: { origin_weights: { US: 1 }, outlier_ratio: 0 },
      n: 2,
      seed: 1,
    });
    if (result.op !== '_1_seed') return;
    expect(result.demographics?.outlier_ratio).toBe(0);
  });

  it('outlier_ratio = 0.5 is valid (maximum boundary)', () => {
    const result = discussLeadOpSchema.parse({
      op: '_1_seed',
      controversy_axes: baseAxes,
      demographics: { origin_weights: { US: 1 }, outlier_ratio: 0.5 },
      n: 2,
      seed: 1,
    });
    if (result.op !== '_1_seed') return;
    expect(result.demographics?.outlier_ratio).toBe(0.5);
  });

  it('outlier_ratio just below 0 (-1e-15) is rejected by schema', () => {
    expect(() =>
      discussLeadOpSchema.parse({
        op: '_1_seed',
        controversy_axes: baseAxes,
        demographics: { origin_weights: { US: 1 }, outlier_ratio: -1e-15 },
        n: 2,
        seed: 1,
      } as never),
    ).toThrow();
  });

  it('outlier_ratio = -0.001 is rejected by schema', () => {
    expect(() =>
      discussLeadOpSchema.parse({
        op: '_1_seed',
        controversy_axes: baseAxes,
        demographics: { origin_weights: { US: 1 }, outlier_ratio: -0.001 },
        n: 2,
        seed: 1,
      } as never),
    ).toThrow();
  });

  it('outlier_ratio = 0.500001 is rejected by schema', () => {
    expect(() =>
      discussLeadOpSchema.parse({
        op: '_1_seed',
        controversy_axes: baseAxes,
        demographics: { origin_weights: { US: 1 }, outlier_ratio: 0.500001 },
        n: 2,
        seed: 1,
      } as never),
    ).toThrow();
  });

  it('origin_weight = 0 is rejected by schema (must be strictly positive)', () => {
    expect(() =>
      discussLeadOpSchema.parse({
        op: '_1_seed',
        controversy_axes: baseAxes,
        demographics: { origin_weights: { US: 0 }, outlier_ratio: 0.2 },
        n: 1,
        seed: 1,
      } as never),
    ).toThrow();
  });

  it('origin_weight = Number.POSITIVE_INFINITY is rejected by schema (finite required)', () => {
    expect(() =>
      discussLeadOpSchema.parse({
        op: '_1_seed',
        controversy_axes: baseAxes,
        demographics: { origin_weights: { US: Infinity } },
        n: 1,
        seed: 1,
      } as never),
    ).toThrow();
  });
});
