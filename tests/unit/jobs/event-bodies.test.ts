import { describe, expect, it } from 'vitest';

import {
  jobQueueQueuedBodySchema,
  jobRuntimeStartedBodySchema,
  providerHostRefSchema,
} from '#src/jobs/event-bodies.js';
import { jobLaunchRequestBodySchema } from '#src/jobs/launch.js';
import { jobTerminalSchema } from '#src/jobs/terminal/result.js';
import { jobCreatedEvent } from '#src/jobs/event-bus.js';

describe('job event body schemas', () => {
  it('encodes HostRef ownership in the lease-mode structure', () => {
    const identity = { provider: 'codex', fingerprint: '0'.repeat(64), instanceId: 'instance-1' };

    expect(providerHostRefSchema.safeParse({ ...identity, leaseMode: 'shared' }).success).toBe(true);
    expect(providerHostRefSchema.safeParse({ ...identity, leaseMode: 'shared', ownerJobId: 'job-a' }).success).toBe(
      false,
    );
    expect(providerHostRefSchema.safeParse({ ...identity, leaseMode: 'job-exclusive' }).success).toBe(false);
    expect(
      providerHostRefSchema.safeParse({ ...identity, leaseMode: 'job-exclusive', ownerJobId: 'job-a' }).success,
    ).toBe(true);
  });

  it('accepts only complete, explicitly discriminated durable runtime variants', () => {
    expect(
      jobRuntimeStartedBodySchema.safeParse({
        transport: 'durable-cli',
        pid: 1234,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        tailWatermark: 4096,
        startedAt: '2026-06-12T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      jobRuntimeStartedBodySchema.safeParse({
        transport: 'app-server',
        startedAt: '2026-06-12T00:00:00.000Z',
        providerMeta: {
          provider: 'fixture',
          leaseState: 'waiting',
          staleHostIdentity: 'must-not-be-accepted',
        },
      }).success,
    ).toBe(false);
    expect(
      jobRuntimeStartedBodySchema.safeParse({
        transport: 'workflow',
        startedAt: '2026-06-12T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      jobRuntimeStartedBodySchema.safeParse({
        transport: 'app-server',
        startedAt: '2026-06-12T00:00:00.000Z',
        providerMeta: {
          provider: 'fixture',
          leaseState: 'acquired',
          hostRef: {
            provider: 'fixture',
            fingerprint: '0'.repeat(64),
            instanceId: 'instance-1',
            leaseMode: 'shared',
          },
        },
      }).success,
    ).toBe(true);

    expect(
      jobRuntimeStartedBodySchema.safeParse({
        transport: 'durable-cli',
        pid: Infinity,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        startedAt: '2026-06-12T00:00:00.000Z',
      }).success,
    ).toBe(false);

    expect(
      jobRuntimeStartedBodySchema.safeParse({
        transport: 'durable-cli',
        pid: 1234,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        tailWatermark: Number.NaN,
        startedAt: '2026-06-12T00:00:00.000Z',
      }).success,
    ).toBe(false);

    for (const invalid of [
      {
        pid: 1234,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        startedAt: '2026-06-12T00:00:00.000Z',
      },
      {
        transport: 'durable-cli',
        pid: 0,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        startedAt: '2026-06-12T00:00:00.000Z',
      },
      {
        transport: 'durable-cli',
        pid: 1234,
        stdoutPath: '',
        stderrPath: '/tmp/stderr',
        startedAt: '2026-06-12T00:00:00.000Z',
      },
      {
        transport: 'app-server',
        startedAt: '2026-06-12T00:00:00.000Z',
        providerMeta: { provider: 'codex', leaseState: 'waiting', privateThreadId: 'thread-1' },
      },
      {
        transport: 'app-server',
        startedAt: '2026-06-12T00:00:00.000Z',
        providerMeta: { provider: 'claude', leaseState: 'waiting', claudeTransport: 'print' },
      },
    ]) {
      expect(jobRuntimeStartedBodySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('does not manufacture missing queue or terminal fields while decoding', () => {
    expect(jobQueueQueuedBodySchema.safeParse({ queuePosition: 1 }).success).toBe(false);
    expect(jobTerminalSchema.safeParse({ content: 'done', outcome: { kind: 'completed' } }).success).toBe(false);
  });

  it('rejects launch pools outside the persisted admission vocabulary', () => {
    const providerLaunch = {
      owner: { kind: 'provider-session', id: 'session-1' },
      sessionId: 'session-1',
      provider: 'codex',
      providerAction: 'exec',
      projectRoot: '/workspace/project',
      backendNamespace: 'namespace-1',
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 1,
      request: {
        prompt: 'hello',
        cwd: '/workspace/project',
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: '2026-06-12T00:00:00.000Z',
    };
    expect(jobLaunchRequestBodySchema.safeParse(providerLaunch).success).toBe(true);
    expect(jobLaunchRequestBodySchema.safeParse({ ...providerLaunch, pool: 'unknown' }).success).toBe(false);
  });

  it('projects created events as exact provider, workflow, and KB variants', () => {
    const common = {
      projectRoot: '/workspace/project',
      backendNamespace: 'namespace-1',
      pool: 'default' as const,
      enqueueSequence: 1,
      createdAt: '2026-06-12T00:00:00.000Z',
    };
    const providerLaunch = jobLaunchRequestBodySchema.parse({
      ...common,
      owner: { kind: 'provider-session', id: 'session-1' },
      sessionId: 'session-1',
      provider: 'codex',
      providerAction: 'exec',
      jobKind: 'provider',
      request: {
        prompt: 'hello',
        cwd: '/workspace/project',
        bypassPermissions: false,
        coralEnv: {},
      },
    });
    const workflowLaunch = jobLaunchRequestBodySchema.parse({
      ...common,
      owner: { kind: 'workflow', id: 'workflow-1' },
      jobKind: 'workflow',
      request: {
        prompt: 'run',
        cwd: '/workspace/project',
        bypassPermissions: false,
        coralEnv: {},
      },
    });
    const kbLaunch = jobLaunchRequestBodySchema.parse({
      ...common,
      owner: { kind: 'system-task', id: 'kb-task-1' },
      jobKind: 'kb',
      operation: 'kb.reindex',
      request: {},
    });

    expect(jobCreatedEvent('provider-job', providerLaunch)).toEqual({
      kind: 'provider',
      jobId: 'provider-job',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: '/workspace/project',
    });
    expect(jobCreatedEvent('workflow-job', workflowLaunch)).toEqual({
      kind: 'workflow',
      jobId: 'workflow-job',
      workflowId: 'workflow-1',
      projectRoot: '/workspace/project',
    });
    expect(jobCreatedEvent('kb-job', kbLaunch)).toEqual({
      kind: 'kb',
      jobId: 'kb-job',
      systemTaskId: 'kb-task-1',
      projectRoot: '/workspace/project',
    });
  });
});
