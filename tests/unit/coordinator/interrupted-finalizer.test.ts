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
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import type { JobStatus } from '#src/jobs/records.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

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

function createHarness(
  options: { artifactRecorded?: boolean; sessionFinalized?: boolean; sessionFinalizeError?: Error } = {},
) {
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
    if (options.sessionFinalizeError !== undefined) throw options.sessionFinalizeError;
    if (options.sessionFinalized === false) return false;
    commitOptions.appendBeforeRelease?.({ append });
    return true;
  });
  const remove = vi.fn(() => order.push('abort-remove'));
  const launchCoordinator = new LaunchCoordinator({ runtime: new SimulationRuntime() });
  const launchPermit = launchCoordinator.restoreActiveLaunch(
    'interrupted-job',
    'fixture',
    { kind: 'provider-session', id: 'interrupted-session' },
    'default',
  );
  const releaseExact = launchCoordinator.releaseLaunch.bind(launchCoordinator);
  const releaseLaunch = vi.spyOn(launchCoordinator, 'releaseLaunch').mockImplementation((permit) => {
    order.push('admission-release');
    return releaseExact(permit);
  });
  const mkdirSync = vi.fn(() => order.push('artifact-mkdir'));
  const writeAtomicSync = vi.fn(() => {
    order.push('artifact-write');
    return true;
  });

  return {
    order,
    append,
    recordArtifactHandleAtomic,
    finalizeJobContinuityAtomic,
    remove,
    releaseLaunch,
    launchCoordinator,
    launchPermit,
    deps: {
      runtime: {
        time: { now: () => Date.parse('2026-07-22T00:01:00.000Z') },
        paths: { coral: { exports: { jobsRoot: '/jobs' } } },
        storage: { mkdirSync, writeAtomicSync },
      },
      sessionManager: { recordArtifactHandleAtomic, finalizeJobContinuityAtomic },
      abortRegistry: { remove },
      launchAdmission: launchCoordinator,
      launchPermit,
    } as never,
  };
}

describe('interrupted app-server recovery finalizer', () => {
  it('records a provider-acknowledged user cancellation as user_abort', async () => {
    const harness = createHarness();
    const userAbortPlan = { ...plan, reason: 'user_abort' } as unknown as AppServerInterruptedRecoveryPlan;

    await finalizeInterruptedAppServerRecovery(userAbortPlan, { kind: 'user-aborted' }, status, harness.deps);

    expect(harness.finalizeJobContinuityAtomic).toHaveBeenCalledWith(
      'interrupted-session',
      expect.objectContaining({
        expectedActiveJobId: 'interrupted-job',
        expectedVersion: 7,
        mutation: { kind: 'preserve' },
      }),
    );
    expect(harness.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'job.terminal.recorded',
        body: expect.objectContaining({
          terminal: expect.objectContaining({ outcome: { kind: 'aborted', reason: 'user_abort' } }),
        }),
      }),
    );
    expect(harness.remove).toHaveBeenCalledWith('interrupted-job');
    expect(harness.launchPermit.reservationId).not.toBe('');
    expect(harness.releaseLaunch).toHaveBeenCalledWith(harness.launchPermit);
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toBeNull();
  });

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
    expect(harness.launchPermit.reservationId).not.toBe('');
    expect(harness.releaseLaunch).toHaveBeenCalledWith(harness.launchPermit);
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toBeNull();
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
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toMatchObject({
      kind: 'active',
      holder: { kind: 'recovery' },
    });
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
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toMatchObject({ kind: 'active' });
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
  });

  it('preserves local ownership when the final session CAS throws', async () => {
    const harness = createHarness({ sessionFinalizeError: new Error('session store unavailable') });

    await expect(finalizeInterruptedAppServerRecovery(plan, performed, status, harness.deps)).rejects.toThrow(
      'session store unavailable',
    );

    expect(harness.order).toEqual(['artifact-cas', 'session-cas']);
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toMatchObject({ kind: 'active' });
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
    expect(harness.launchPermit.reservationId).not.toBe('');
    expect(harness.releaseLaunch).toHaveBeenCalledWith(harness.launchPermit);
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toBeNull();
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
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toMatchObject({ kind: 'active' });
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
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toMatchObject({ kind: 'active' });
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
  });
});
