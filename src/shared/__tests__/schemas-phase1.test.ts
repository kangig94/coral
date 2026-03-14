import { describe, expect, it } from 'vitest';
import {
  abortInputSchema,
  sharedExecSchema,
  sharedForkSchema,
  sharedResumeSchema,
  waitInputSchema,
} from '../schemas.js';

describe('Phase 1 shared schemas', () => {
  it('sharedExecSchema validates valid exec input', () => {
    const parsed = sharedExecSchema.parse({
      op: 'exec',
      prompt: 'Analyze this change',
      session: 'session-1',
      work_dir: '/tmp/work',
      model: 'o4-mini',
      bypass_permissions: true,
      system_prompt: 'Follow the policy',
    });

    expect(parsed).toMatchObject({
      op: 'exec',
      prompt: 'Analyze this change',
      session: 'session-1',
      work_dir: '/tmp/work',
      model: 'o4-mini',
      bypass_permissions: true,
      system_prompt: 'Follow the policy',
    });
  });

  it('sharedResumeSchema requires session', () => {
    expect(() => sharedResumeSchema.parse({
      op: 'resume',
      prompt: 'Continue',
    })).toThrow();
  });

  it('sharedForkSchema requires session', () => {
    expect(() => sharedForkSchema.parse({
      op: 'fork',
    })).toThrow();
  });

  it('waitInputSchema rejects empty jobs array', () => {
    expect(() => waitInputSchema.parse({
      jobs: [],
    })).toThrow('At least one job required');
  });

  it('abortInputSchema rejects empty jobs array', () => {
    expect(() => abortInputSchema.parse({
      jobs: [],
    })).toThrow('At least one job required');
  });
});

describe('waitInputSchema — inline removed', () => {
  it('should reject inline field (strict mode)', () => {
    const result = waitInputSchema.safeParse({ jobs: ['job-1'], inline: true });
    expect(result.success).toBe(false);
  });

  it('should reject legacy include_result field (strict mode)', () => {
    const result = waitInputSchema.safeParse({ jobs: ['job-1'], include_result: true });
    expect(result.success).toBe(false);
  });
});
