import { describe, expect, it } from 'vitest';
import {
  abortInputSchema,
  jobAbortSchema,
  jobWaitSchema,
  sessionCreateSchema,
  sessionForkSchema,
  sessionMessageSchema,
  waitInputSchema,
  workflowRequestSchema,
} from '../schemas.js';

describe('sessionCreateSchema', () => {
  it('parses the minimal session create body and defaults bypassPermissions to false', () => {
    const parsed = sessionCreateSchema.parse({
      provider: 'codex',
      prompt: 'Analyze this change',
      projectRoot: '/tmp/project',
    });

    expect(parsed).toEqual({
      provider: 'codex',
      prompt: 'Analyze this change',
      projectRoot: '/tmp/project',
      bypassPermissions: false,
    });
  });

  it('accepts all optional fields', () => {
    const parsed = sessionCreateSchema.parse({
      provider: 'claude',
      prompt: 'Analyze this change',
      projectRoot: '/tmp/project',
      model: 'o4-mini',
      agent: 'architect',
      workDir: '/tmp/project/work',
      owner: 'session-abc.123',
      effort: 'max',
      claudeModelCap: 'opus',
      bypassPermissions: true,
      systemPrompt: 'Keep answers concise',
    });

    expect(parsed).toMatchObject({
      provider: 'claude',
      model: 'o4-mini',
      agent: 'architect',
      workDir: '/tmp/project/work',
      owner: 'session-abc.123',
      effort: 'max',
      claudeModelCap: 'opus',
      bypassPermissions: true,
      systemPrompt: 'Keep answers concise',
    });
  });

  it('rejects invalid provider names', () => {
    expect(() =>
      sessionCreateSchema.parse({
        provider: 'Claude',
        prompt: 'Analyze this change',
        projectRoot: '/tmp/project',
      }),
    ).toThrow();
  });

  it('rejects unknown keys via strict mode', () => {
    const result = sessionCreateSchema.safeParse({
      provider: 'codex',
      prompt: 'Analyze this change',
      projectRoot: '/tmp/project',
      extra: true,
    });

    expect(result.success).toBe(false);
  });
});

describe('sessionMessageSchema', () => {
  it('requires prompt and projectRoot', () => {
    expect(() =>
      sessionMessageSchema.parse({
        projectRoot: '/tmp/project',
      }),
    ).toThrow();

    expect(() =>
      sessionMessageSchema.parse({
        prompt: 'Continue',
      }),
    ).toThrow();
  });

  it('does not apply a parse-time default for bypassPermissions', () => {
    const parsed = sessionMessageSchema.parse({
      prompt: 'Continue',
      projectRoot: '/tmp/project',
    });

    expect(parsed).toEqual({
      prompt: 'Continue',
      projectRoot: '/tmp/project',
    });
    expect(parsed).not.toHaveProperty('bypassPermissions');
  });

  it('accepts explicit continuation overrides', () => {
    const parsed = sessionMessageSchema.parse({
      prompt: 'Continue',
      projectRoot: '/tmp/project',
      model: 'gpt-5',
      workDir: '/tmp/project/work',
      owner: 'owner-1',
      effort: 'medium',
      claudeModelCap: 'sonnet',
      bypassPermissions: false,
      systemPrompt: 'Stay focused',
    });

    expect(parsed).toMatchObject({
      model: 'gpt-5',
      workDir: '/tmp/project/work',
      owner: 'owner-1',
      effort: 'medium',
      claudeModelCap: 'sonnet',
      bypassPermissions: false,
      systemPrompt: 'Stay focused',
    });
  });

  it('rejects unknown keys via strict mode', () => {
    const result = sessionMessageSchema.safeParse({
      prompt: 'Continue',
      projectRoot: '/tmp/project',
      provider: 'codex',
    });

    expect(result.success).toBe(false);
  });
});

describe('sessionForkSchema', () => {
  it('requires projectRoot but allows prompt to be omitted', () => {
    const parsed = sessionForkSchema.parse({
      projectRoot: '/tmp/project',
    });

    expect(parsed).toEqual({
      projectRoot: '/tmp/project',
    });
    expect(parsed).not.toHaveProperty('bypassPermissions');
  });

  it('accepts an empty prompt when provided', () => {
    const parsed = sessionForkSchema.parse({
      prompt: '',
      projectRoot: '/tmp/project',
    });

    expect(parsed.prompt).toBe('');
  });

  it('rejects unknown keys via strict mode', () => {
    const result = sessionForkSchema.safeParse({
      projectRoot: '/tmp/project',
      extra: true,
    });

    expect(result.success).toBe(false);
  });
});

describe('jobWaitSchema', () => {
  it('parses a valid wait body with a strict cursor shape', () => {
    const parsed = jobWaitSchema.parse({
      jobIds: ['job-1', 'job-2'],
      projectRoot: '/tmp/project',
      timeoutSeconds: 30,
      cursor: {
        jobs: {
          'job-1': 4,
        },
      },
    });

    expect(parsed).toEqual({
      jobIds: ['job-1', 'job-2'],
      projectRoot: '/tmp/project',
      timeoutSeconds: 30,
      cursor: {
        jobs: {
          'job-1': 4,
        },
      },
    });
  });

  it('rejects empty jobIds arrays', () => {
    expect(() =>
      jobWaitSchema.parse({
        jobIds: [],
        projectRoot: '/tmp/project',
      }),
    ).toThrow('At least one job required');
  });

  it('rejects invalid cursor values and unknown cursor keys', () => {
    expect(
      jobWaitSchema.safeParse({
        jobIds: ['job-1'],
        projectRoot: '/tmp/project',
        cursor: {
          jobs: {
            'job-1': -1,
          },
        },
      }).success,
    ).toBe(false);

    expect(
      jobWaitSchema.safeParse({
        jobIds: ['job-1'],
        projectRoot: '/tmp/project',
        cursor: {
          jobs: {},
          extra: true,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects legacy inline-only fields via strict mode', () => {
    expect(
      jobWaitSchema.safeParse({
        jobIds: ['job-1'],
        projectRoot: '/tmp/project',
        inline: true,
      }).success,
    ).toBe(false);
  });
});

describe('jobAbortSchema', () => {
  it('parses a valid abort body', () => {
    expect(
      jobAbortSchema.parse({
        jobs: ['job-1'],
        projectRoot: '/tmp/project',
      }),
    ).toEqual({
      jobs: ['job-1'],
      projectRoot: '/tmp/project',
    });
  });

  it('rejects empty job lists and unknown keys', () => {
    expect(() =>
      jobAbortSchema.parse({
        jobs: [],
        projectRoot: '/tmp/project',
      }),
    ).toThrow('At least one job required');

    expect(
      jobAbortSchema.safeParse({
        jobs: ['job-1'],
        projectRoot: '/tmp/project',
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('workflowRequestSchema', () => {
  it('parses a minimal workflow request without defaulting provider', () => {
    const parsed = workflowRequestSchema.parse({
      expression: 'architect -> resolver',
      startPrompt: 'hello',
      projectRoot: '/tmp/project',
    });

    expect(parsed).toEqual({
      expression: 'architect -> resolver',
      startPrompt: 'hello',
      projectRoot: '/tmp/project',
    });
    expect(parsed).not.toHaveProperty('provider');
  });

  it('accepts supported optional fields', () => {
    const parsed = workflowRequestSchema.parse({
      expression: 'architect',
      startPrompt: 'hello',
      context: 'extra context',
      provider: 'claude',
      workDir: '/tmp/project/work',
      projectRoot: '/tmp/project',
      owner: 'owner-1',
      claudeModelCap: 'haiku',
    });

    expect(parsed).toMatchObject({
      context: 'extra context',
      provider: 'claude',
      workDir: '/tmp/project/work',
      owner: 'owner-1',
      claudeModelCap: 'haiku',
    });
  });

  it('rejects effort and other unknown keys via strict mode', () => {
    expect(
      workflowRequestSchema.safeParse({
        expression: 'architect',
        startPrompt: 'hello',
        projectRoot: '/tmp/project',
        effort: 'high',
      }).success,
    ).toBe(false);
  });
});

describe('legacy shared schemas kept for current consumers', () => {
  it('waitInputSchema rejects empty jobs array', () => {
    expect(() =>
      waitInputSchema.parse({
        jobs: [],
      }),
    ).toThrow('At least one job required');
  });

  it('abortInputSchema rejects empty jobs array', () => {
    expect(() =>
      abortInputSchema.parse({
        jobs: [],
      }),
    ).toThrow('At least one job required');
  });
});
