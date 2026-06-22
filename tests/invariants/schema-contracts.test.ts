import { describe, expect, it } from 'vitest';
import { jobAbortSchema, jobWaitSchema } from '#src/transport/rpc/jobs.js';
import { agentIdentSchema, sessionCreateSchema } from '#src/sessions/command-schemas.js';
import { workflowCommandSchema } from '#src/workflow/input.js';
import { workflowRequestSchema } from '#src/transport/rpc/workflow.js';

const AGENT_IDENT_CASES: ReadonlyArray<readonly [input: string, accepted: boolean, canonicalForm: string | null]> = [
  ['architect', true, 'architect'],
  ['coral:architect', true, 'coral:architect'],
  ['my-plugin:my-agent', true, 'my-plugin:my-agent'],
  ['ns-1:agent-2', true, 'ns-1:agent-2'],
  ['architect.md', true, 'architect'],
  ['coral:architect.md', true, 'coral:architect'],
  ['a.md', true, 'a'],
  ['coral:', false, null],
  ['MyAgent', false, null],
  ['', false, null],
  ['INVALID!', false, null],
  ['architect.md.md', false, null],
  ['.md', false, null],
] as const;

describe('agentIdentSchema', () => {
  it.each(AGENT_IDENT_CASES)('parses %s with accepted=%s and canonical form %s', (input, accepted, canonicalForm) => {
    const result = agentIdentSchema.safeParse(input);

    expect(result.success).toBe(accepted);
    if (accepted) {
      if (!result.success) {
        throw new Error(`Expected ${input} to be accepted by agentIdentSchema`);
      }
      expect(result.data).toBe(canonicalForm);
    }
  });
});

describe('sessionCreateSchema', () => {
  it('parses the minimal session create body without a bypassPermissions default', () => {
    const parsed = sessionCreateSchema.parse({
      provider: 'codex',
      prompt: 'Analyze this change',
      projectRoot: '/tmp/project',
    });

    expect(parsed).toEqual({
      provider: 'codex',
      prompt: 'Analyze this change',
      projectRoot: '/tmp/project',
    });
    expect(parsed).not.toHaveProperty('bypassPermissions');
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

  it('normalizes a trailing .md suffix on agent names', () => {
    const parsed = sessionCreateSchema.parse({
      provider: 'claude',
      prompt: 'Analyze this change',
      projectRoot: '/tmp/project',
      agent: 'architect.md',
    });

    expect(parsed.agent).toBe('architect');
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

  it.each(['coral:', 'MyAgent', ''] as const)('rejects invalid agent %s', (agent) => {
    expect(() =>
      sessionCreateSchema.parse({
        provider: 'codex',
        prompt: 'Analyze this change',
        projectRoot: '/tmp/project',
        agent,
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

describe('jobWaitSchema', () => {
  it('parses a valid wait body without a cursor field', () => {
    const parsed = jobWaitSchema.parse({
      jobIds: ['job-1', 'job-2'],
      projectRoot: '/tmp/project',
      timeoutSeconds: 30,
    });

    expect(parsed).toEqual({
      jobIds: ['job-1', 'job-2'],
      projectRoot: '/tmp/project',
      timeoutSeconds: 30,
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

  it('parses an IPC wait cursor when provided in the request body', () => {
    const input = {
      jobIds: ['job-1'],
      projectRoot: '/tmp/project',
      cursor: {
        afterSeq: 4,
      },
    };

    expect(jobWaitSchema.parse(input)).toEqual(input);
  });

  it('rejects removed inline-only fields via strict mode', () => {
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
  it("applies provider default of 'claude' when omitted", () => {
    const parsed = workflowRequestSchema.parse({
      expression: 'architect -> resolver',
      startPrompt: 'hello',
      projectRoot: '/tmp/project',
    });

    expect(parsed).toEqual({
      expression: 'architect -> resolver',
      startPrompt: 'hello',
      provider: 'claude',
      projectRoot: '/tmp/project',
    });
    expect(parsed.provider).toBe('claude');
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
      effort: 'high',
      claudeModelCap: 'haiku',
    });

    expect(parsed).toMatchObject({
      context: 'extra context',
      provider: 'claude',
      workDir: '/tmp/project/work',
      owner: 'owner-1',
      effort: 'high',
      claudeModelCap: 'haiku',
    });
  });

  it('re-parses canonical workflow commands idempotently', () => {
    const parsed = workflowCommandSchema.parse({
      expression: 'architect',
      startPrompt: 'hello',
      workDir: '/tmp/work',
    });

    expect(workflowCommandSchema.parse(parsed)).toEqual(parsed);
  });

  it('rejects removed start_prompt under strict mode', () => {
    const parsed = workflowRequestSchema.safeParse({
      expression: 'architect',
      start_prompt: 'hello',
      startPrompt: 'hello',
      projectRoot: '/tmp/project',
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected parse failure');
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Unrecognized key(s) in object: 'start_prompt'",
        }),
      ]),
    );
  });

  it('rejects removed work_dir under strict mode', () => {
    const parsed = workflowRequestSchema.safeParse({
      expression: 'architect',
      startPrompt: 'hello',
      work_dir: '/tmp/removed',
      projectRoot: '/tmp/project',
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected parse failure');
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Unrecognized key(s) in object: 'work_dir'",
        }),
      ]),
    );
  });

  it('rejects unrelated unknown keys via strict mode', () => {
    expect(
      workflowRequestSchema.safeParse({
        expression: 'architect',
        startPrompt: 'hello',
        projectRoot: '/tmp/project',
        extra: true,
      }).success,
    ).toBe(false);
  });
});
