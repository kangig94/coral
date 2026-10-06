import { describe, expect, it } from 'vitest';
import { jobAbortSchema, jobWaitSchema, jobWaitSnapshotSchema } from '#src/transport/rpc/jobs.js';
import { MAX_WAIT_JOB_IDS } from '#src/jobs/wait/stream-event.js';
import { sessionCreateSchema } from '#src/sessions/command-schemas.js';
import { workflowRequestSchema } from '#src/transport/rpc/workflow.js';

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
});

describe('jobWaitSchema', () => {
  it.each([jobWaitSchema, jobWaitSnapshotSchema])('rejects duplicate membership at wait ingress', (schema) => {
    expect(() =>
      schema.parse({
        jobIds: ['a', 'a'],
        projectRoot: '/tmp',
        ...(schema === jobWaitSchema ? {} : {}),
      }),
    ).toThrow('Each job ID must appear only once; remove duplicate job IDs.');
  });

  it('bounds jobIds at the wait cap so one request cannot ask for an unbounded fan-out', () => {
    const atCap = Array.from({ length: MAX_WAIT_JOB_IDS }, (_unused, index) => `job-${index}`);

    expect(jobWaitSchema.parse({ jobIds: atCap, projectRoot: '/tmp/project' }).jobIds).toHaveLength(MAX_WAIT_JOB_IDS);
    expect(() => jobWaitSchema.parse({ jobIds: [...atCap, 'job-over'], projectRoot: '/tmp/project' })).toThrow(
      `At most ${MAX_WAIT_JOB_IDS} jobs`,
    );
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
});

describe('jobAbortSchema', () => {
  it('rejects empty job lists', () => {
    expect(() =>
      jobAbortSchema.parse({
        jobs: [],
        projectRoot: '/tmp/project',
      }),
    ).toThrow('At least one job required');
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
});
