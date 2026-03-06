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
      name: 'phase1',
      model: 'o4-mini',
      working_directory: '/tmp/work',
      effort: 'high',
      bypass: true,
    });

    expect(parsed).toMatchObject({
      op: 'exec',
      prompt: 'Analyze this change',
      session: 'session-1',
      name: 'phase1',
      model: 'o4-mini',
      working_directory: '/tmp/work',
      effort: 'high',
      bypass: true,
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
    })).toThrow('At least one job ID required');
  });

  it('abortInputSchema rejects empty jobs array', () => {
    expect(() => abortInputSchema.parse({
      jobs: [],
    })).toThrow('At least one job ID required');
  });
});
