import { describe, expect, it } from 'vitest';

import { planRecovery } from '#src/jobs/reconcile/plan.js';
import type { JobLaunch, JobRuntime, JobStatus } from '#src/jobs/records.js';

function recoveryPlan(parentWorkflowJobId?: string, runtimeRecord: JobRuntime | null = null) {
  const launchRecord: JobLaunch = {
    jobId: 'queued-job',
    owner: { kind: 'provider-session', id: 'session' },
    sessionId: 'session',
    provider: 'codex',
    projectRoot: '/project',
    backendNamespace: 'test',
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 1,
    providerAction: 'exec',
    ...(parentWorkflowJobId === undefined ? {} : { parentWorkflowJobId }),
    request: { prompt: 'run', cwd: '/project', bypassPermissions: false, coralEnv: {} },
    createdAt: '2026-10-18T00:00:00.000Z',
  };
  const status: JobStatus = {
    jobId: launchRecord.jobId,
    owner: launchRecord.owner,
    sessionId: launchRecord.sessionId,
    provider: launchRecord.provider,
    projectRoot: launchRecord.projectRoot,
    workDir: null,
    backendNamespace: launchRecord.backendNamespace,
    jobKind: 'provider',
    phase: runtimeRecord === null ? 'queued' : 'running',
    updatedAt: launchRecord.createdAt,
  };
  return planRecovery({
    jobIds: [launchRecord.jobId],
    readJob: () => ({
      jobId: launchRecord.jobId,
      hasLaunchRequest: true,
      hasRuntimeStart: runtimeRecord !== null,
      hasTerminalRecord: false,
      status,
      launchRecord,
      runtimeRecord,
    }),
    listSessionRefs: () => [],
    readSession: () => null,
    isPidAlive: () => true,
  });
}

describe('queued job recovery classification', () => {
  it('terminalizes a workflow child using its launch parent before registering queued work', () => {
    const plan = recoveryPlan('workflow');

    expect(plan.register).toEqual([]);
    expect(plan.cleanup).toEqual([
      expect.objectContaining({ type: 'markError', jobId: 'queued-job', fault: { kind: 'ghost_launch' } }),
    ]);
  });

  it('restores an ordinary queued job', () => {
    const plan = recoveryPlan();

    expect(plan.register).toEqual([expect.objectContaining({ type: 'registerQueued', jobId: 'queued-job' })]);
    expect(plan.cleanup).toEqual([]);
  });

  it('keeps an existing workflow child execution registered for runtime recovery', () => {
    const plan = recoveryPlan('workflow', {
      transport: 'app-server',
      startTime: '2026-10-18T00:00:00.000Z',
      providerMeta: { provider: 'codex', leaseState: 'waiting' },
    });

    expect(plan.register).toEqual([expect.objectContaining({ type: 'registerRunning', jobId: 'queued-job' })]);
    expect(plan.cleanup).toEqual([]);
  });
});
