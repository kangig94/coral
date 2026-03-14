import { describe, expect, it } from 'vitest';
import {
  abortInputSchema,
  internalProviderFieldsShape,
  sharedExecSchema,
  sharedForkSchema,
  sharedResumeSchema,
  waitInputSchema,
} from '../schemas.js';

describe('Phase 1 shared schemas', () => {
  it('sharedExecSchema validates valid exec input without internal fields', () => {
    const parsed = sharedExecSchema.parse({
      op: 'exec',
      prompt: 'Analyze this change',
      session: 'session-1',
      work_dir: '/tmp/work',
      model: 'o4-mini',
    });

    expect(parsed).toMatchObject({
      op: 'exec',
      prompt: 'Analyze this change',
      session: 'session-1',
      work_dir: '/tmp/work',
      model: 'o4-mini',
    });
    expect(parsed).not.toHaveProperty('bypass_permissions');
    expect(parsed).not.toHaveProperty('system_prompt');
  });

  it('internal fields are accepted when schema is extended', () => {
    const extended = sharedExecSchema.extend(internalProviderFieldsShape);
    const parsed = extended.parse({
      op: 'bypass_exec',
      prompt: 'Internal call',
      bypass_permissions: true,
      system_prompt: 'Agent context',
    });

    expect(parsed.bypass_permissions).toBe(true);
    expect(parsed.system_prompt).toBe('Agent context');
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
