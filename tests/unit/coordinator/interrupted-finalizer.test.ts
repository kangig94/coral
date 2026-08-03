import { describe, expect, it, vi } from 'vitest';

import {
  finalizeInterruptedAppServerRecovery,
  finalizeInterruptedDurableRecovery,
} from '#src/coordinator/services/recovery/interrupted-finalizer.js';
import type { InterruptedRecoveryCommitError } from '#src/coordinator/services/recovery/interrupted-finalizer.js';
import type {
  AppServerInterruptedRecoveryPlan,
  DurableInterruptedRecoveryPlan,
} from '#src/coordinator/services/recovery/interrupted-plan.js';
import type {
  PerformedDurableRecovery,
  PerformedInterruptedRecovery,
} from '#src/coordinator/services/recovery/interrupted-performer.js';
import type { JobStatus } from '#src/jobs/records.js';

const plan = {
  kind: 'artifacts',
  launchRecord: {
    jobId: 'interrupted-job',
    sessionId: 'interrupted-session',
    provider: 'fixture',
    projectRoot: '/project',
    backendNamespace: 'namespace',
    pool: 'default',
  },
  session: {
    sessionId: 'interrupted-session',
  },
  runtimeRecord: {
    startTime: '2026-07-22T00:00:00.000Z',
  },
  reason: 'restart',
  expectedSessionVersion: 7,
} as unknown as AppServerInterruptedRecoveryPlan;

const status = {
  jobId: 'interrupted-job',
  sessionId: 'interrupted-session',
  backendNamespace: 'namespace',
  projectRoot: '/project',
} as JobStatus;

const performed = {
  kind: 'resolved',
  mutation: {
    kind: 'set_resumable',
    conversationRef: 'thread-recovered',
    providerContinuity: { threadId: 'thread-recovered' },
  },
  probeOutcome: 'verified',
  recoveryConversationRef: 'thread-recovered',
  artifactHandles: [
    {
      handle: '/provider/thread-recovered.jsonl',
      identity: { kind: 'fixture', threadId: 'thread-recovered' },
    },
  ],
} as unknown as PerformedInterruptedRecovery;

const durablePlan = {
  kind: 'durable-artifacts',
  launchRecord: plan.launchRecord,
  session: plan.session,
  runtimeRecord: {
    transport: 'durable-cli',
    pid: 42,
    stdoutPath: '/jobs/interrupted-job/stdout',
    stderrPath: '/jobs/interrupted-job/stderr',
    startTime: '2026-07-22T00:00:00.000Z',
  },
  exit: {
    exitCode: 0,
    signal: null,
    endTime: '2026-07-22T00:01:00.000Z',
  },
  expectedSessionVersion: 7,
} as unknown as DurableInterruptedRecoveryPlan;

const durablePerformed = {
  kind: 'durable-resolved',
  terminal: {
    kind: 'provider',
    value: {
      kind: 'terminal',
      terminal: { content: 'recovered', durationMs: 60_000, outcome: { kind: 'completed' } },
      diagnostics: {},
    },
  },
  mutation: {
    kind: 'set_resumable',
    conversationRef: 'thread-recovered',
    providerContinuity: { threadId: 'thread-recovered' },
  },
  artifactHandles: performed.kind === 'resolved' ? performed.artifactHandles : [],
} as unknown as PerformedDurableRecovery;

function createHarness(options: { artifactRecorded?: boolean; sessionFinalized?: boolean } = {}) {
  const order: string[] = [];
  const append = vi.fn(() => {
    order.push('terminal');
    return {} as never;
  });
  const recordArtifactHandleAtomic = vi.fn(async () => {
    order.push('artifact-cas');
    return options.artifactRecorded === false ? ({ ok: false } as const) : ({ ok: true, nextVersion: 8 } as const);
  });
  const finalizeJobContinuityAtomic = vi.fn(async (_sessionId, commitOptions) => {
    order.push('session-cas');
    if (options.sessionFinalized === false) return false;
    commitOptions.appendBeforeRelease?.({ append });
    return true;
  });
  const remove = vi.fn(() => order.push('abort-remove'));
  const releaseLaunch = vi.fn(() => order.push('admission-release'));
  const jobPools = new Map([['interrupted-job', 'continuation' as const]]);
  const mkdirSync = vi.fn(() => order.push('artifact-mkdir'));
  const writeAtomicSync = vi.fn(() => {
    order.push('artifact-write');
    return true;
  });

  return {
    order,
    recordArtifactHandleAtomic,
    finalizeJobContinuityAtomic,
    remove,
    releaseLaunch,
    jobPools,
    deps: {
      runtime: {
        time: { now: () => Date.parse('2026-07-22T00:01:00.000Z') },
        paths: { coral: { exports: { jobsRoot: '/jobs' } } },
        storage: { mkdirSync, writeAtomicSync },
      },
      sessionManager: { recordArtifactHandleAtomic, finalizeJobContinuityAtomic },
      abortRegistry: { remove },
      launchAdmission: { releaseLaunch },
      jobPools,
    } as never,
  };
}

describe('interrupted app-server recovery finalizer', () => {
  it('persists artifact handles before terminal settlement and carries the advanced CAS version', async () => {
    const harness = createHarness();

    await finalizeInterruptedAppServerRecovery(plan, performed, status, harness.deps);

    expect(harness.recordArtifactHandleAtomic).toHaveBeenCalledWith('interrupted-session', {
      expectedActiveJobId: 'interrupted-job',
      expectedVersion: 7,
      handle: '/provider/thread-recovered.jsonl',
      identity: { kind: 'fixture', threadId: 'thread-recovered' },
      sourceJobId: 'interrupted-job',
    });
    expect(harness.finalizeJobContinuityAtomic).toHaveBeenCalledWith(
      'interrupted-session',
      expect.objectContaining({
        expectedActiveJobId: 'interrupted-job',
        expectedVersion: 8,
        mutation: {
          kind: 'set_resumable',
          conversationRef: 'thread-recovered',
          providerContinuity: { threadId: 'thread-recovered' },
        },
        appendBeforeRelease: expect.any(Function),
      }),
    );
    expect(harness.order).toEqual([
      'artifact-cas',
      'session-cas',
      'terminal',
      'terminal',
      'artifact-mkdir',
      'artifact-write',
      'abort-remove',
      'admission-release',
    ]);
    expect(harness.jobPools.has('interrupted-job')).toBe(false);
    expect(harness.releaseLaunch).toHaveBeenCalledWith('interrupted-job', 'continuation');
  });

  it('fails closed before terminal persistence when artifact-handle CAS is stale', async () => {
    const harness = createHarness({ artifactRecorded: false });

    await expect(finalizeInterruptedAppServerRecovery(plan, performed, status, harness.deps)).rejects.toEqual(
      expect.objectContaining<Partial<InterruptedRecoveryCommitError>>({
        name: 'InterruptedRecoveryCommitError',
        stage: 'artifact-handle',
      }),
    );

    expect(harness.recordArtifactHandleAtomic).toHaveBeenCalled();
    expect(harness.order).toEqual(['artifact-cas']);
    expect(harness.jobPools.has('interrupted-job')).toBe(true);
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
  });

  it('preserves local ownership when the final session CAS is stale', async () => {
    const harness = createHarness({ sessionFinalized: false });

    await expect(finalizeInterruptedAppServerRecovery(plan, performed, status, harness.deps)).rejects.toEqual(
      expect.objectContaining<Partial<InterruptedRecoveryCommitError>>({
        name: 'InterruptedRecoveryCommitError',
        stage: 'session-finalize',
      }),
    );

    expect(harness.order).toEqual(['artifact-cas', 'session-cas']);
    expect(harness.jobPools.has('interrupted-job')).toBe(true);
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
  });
});

describe('interrupted durable recovery finalizer', () => {
  it('uses the same exact-version CAS and ownership-release boundary', async () => {
    const harness = createHarness();

    await finalizeInterruptedDurableRecovery(durablePlan, durablePerformed, status, harness.deps);

    expect(harness.recordArtifactHandleAtomic).toHaveBeenCalledWith('interrupted-session', {
      expectedActiveJobId: 'interrupted-job',
      expectedVersion: 7,
      handle: '/provider/thread-recovered.jsonl',
      identity: { kind: 'fixture', threadId: 'thread-recovered' },
      sourceJobId: 'interrupted-job',
    });
    expect(harness.finalizeJobContinuityAtomic).toHaveBeenCalledWith(
      'interrupted-session',
      expect.objectContaining({
        expectedActiveJobId: 'interrupted-job',
        expectedVersion: 8,
        mutation: durablePerformed.mutation,
        appendBeforeRelease: expect.any(Function),
      }),
    );
    expect(harness.order).toEqual([
      'artifact-cas',
      'session-cas',
      'terminal',
      'artifact-mkdir',
      'artifact-write',
      'abort-remove',
      'admission-release',
    ]);
    expect(harness.jobPools.has('interrupted-job')).toBe(false);
  });

  it('does not persist a durable terminal when the exact final session CAS is stale', async () => {
    const harness = createHarness({ sessionFinalized: false });

    await expect(
      finalizeInterruptedDurableRecovery(durablePlan, durablePerformed, status, harness.deps),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'InterruptedRecoveryCommitError',
        stage: 'session-finalize',
      }),
    );

    expect(harness.order).toEqual(['artifact-cas', 'session-cas']);
    expect(harness.jobPools.has('interrupted-job')).toBe(true);
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
  });

  it('does not terminalize or release ownership after stale artifact evidence', async () => {
    const harness = createHarness({ artifactRecorded: false });

    await expect(
      finalizeInterruptedDurableRecovery(durablePlan, durablePerformed, status, harness.deps),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'InterruptedRecoveryCommitError',
        stage: 'artifact-handle',
      }),
    );

    expect(harness.recordArtifactHandleAtomic).toHaveBeenCalled();
    expect(harness.order).toEqual(['artifact-cas']);
    expect(harness.jobPools.has('interrupted-job')).toBe(true);
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
  });
});
