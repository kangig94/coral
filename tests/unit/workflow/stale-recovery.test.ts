import { describe, expect, it, vi } from 'vitest';

import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { LaunchedAtom, WorkflowExecutionPort } from '#src/workflow/execution-contract.js';
import { recoverStaleAtom } from '#src/workflow/stale-recovery.js';
import type { AwaitStepState } from '#src/workflow/wait.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

const ctx: InvocationContext = {
  projectRoot: '/tmp/coral-workflow-project',
  pluginRoot: '/tmp/coral-workflow-plugin',
  coralEnv: {},
  principal: testProjectPrincipal('/tmp/coral-workflow-project'),
};

function atom(overrides: Partial<LaunchedAtom> = {}): LaunchedAtom {
  return {
    slotId: 'workflow-1:0:0',
    jobId: 'job-stale',
    sessionId: 'session-stale',
    providerName: 'claude',
    agent: 'architect',
    tagName: 'architect',
    stepIndex: 0,
    atomIndex: 0,
    atomKey: '0:0',
    ...overrides,
  };
}

function stateFor(staleAtom: LaunchedAtom): AwaitStepState {
  return {
    pending: new Map([[staleAtom.jobId, staleAtom]]),
    results: new Map(),
    cursor: { afterSeq: 0 },
    lastActivityAt: new Map([[staleAtom.atomKey, 1_000]]),
    staleRetries: new Map(),
    expectedStaleAborts: new Set(),
    failureDrain: null,
  };
}

function executionPort(overrides: Partial<WorkflowExecutionPort> = {}): WorkflowExecutionPort {
  return {
    coralDispatch: vi.fn(async () => ({ status: 'running' as const, job: 'job-new', session: 'session-new' })),
    resume: vi.fn(async () => ({ status: 'running' as const, job: 'job-resumed', session: 'session-stale' })),
    recordContinuationLease: vi.fn(async () => {}),
    claimContinuationLease: vi.fn(async () => true),
    clearContinuationLease: vi.fn(async () => true),
    abort: vi.fn((jobIds: string[]) => ({ aborted: [...jobIds], notFound: [] })),
    awaitLaunch: vi.fn(async (): Promise<'ready'> => 'ready'),
    waitStream: vi.fn(async function* () {}),
    waitForJobTerminal: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('recoverStaleAtom continuation lease', () => {
  it('records the lease before aborting and claims it after resume admission', async () => {
    const staleAtom = atom();
    const port = executionPort();

    await expect(
      recoverStaleAtom(stateFor(staleAtom), port, ctx, {
        time: { now: () => 100_000 },
        staleTimeoutMs: 1,
        staleAbortTimeoutMs: 30_000,
        onProgress: vi.fn(),
        buildPartialStepDetails: () => [],
      }),
    ).resolves.toBe(true);

    expect(port.recordContinuationLease).toHaveBeenCalledWith({
      sessionId: 'session-stale',
      jobId: 'job-stale',
      reason: 'stale_recovery',
      expiresAt: expect.any(String),
    });
    expect(port.abort).toHaveBeenCalledWith(['job-stale']);
    expect(vi.mocked(port.recordContinuationLease).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(port.abort).mock.invocationCallOrder[0],
    );
    expect(port.claimContinuationLease).toHaveBeenCalledWith({
      sessionId: 'session-stale',
      staleJobId: 'job-stale',
      resumedJobId: 'job-resumed',
    });
    expect(vi.mocked(port.resume).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(port.claimContinuationLease).mock.invocationCallOrder[0],
    );
  });

  it('continues with the resumed job when lease claim returns false after resume admission', async () => {
    const staleAtom = atom();
    const state = stateFor(staleAtom);
    const onProgress = vi.fn();
    const port = executionPort({
      claimContinuationLease: vi.fn(async () => false),
    });

    await expect(
      recoverStaleAtom(state, port, ctx, {
        time: { now: () => 100_000 },
        staleTimeoutMs: 1,
        staleAbortTimeoutMs: 30_000,
        onProgress,
        buildPartialStepDetails: () => [],
      }),
    ).resolves.toBe(true);

    expect(port.claimContinuationLease).toHaveBeenCalledWith({
      sessionId: 'session-stale',
      staleJobId: 'job-stale',
      resumedJobId: 'job-resumed',
    });
    expect(port.awaitLaunch).toHaveBeenCalledWith('job-resumed', expect.any(Number));
    expect(port.clearContinuationLease).not.toHaveBeenCalled();
    expect(state.pending.has('job-stale')).toBe(false);
    expect(state.pending.get('job-resumed')).toMatchObject({
      jobId: 'job-resumed',
      sessionId: 'session-stale',
    });
    expect(onProgress).toHaveBeenCalledWith(
      expect.stringContaining('resumed; continuation lease claim was already unavailable'),
    );
  });

  it('does not abort when lease recording fails', async () => {
    const staleAtom = atom();
    const port = executionPort({
      recordContinuationLease: vi.fn(async () => {
        throw new Error('append failed');
      }),
    });

    await expect(
      recoverStaleAtom(stateFor(staleAtom), port, ctx, {
        time: { now: () => 100_000 },
        staleTimeoutMs: 1,
        staleAbortTimeoutMs: 30_000,
        onProgress: vi.fn(),
        buildPartialStepDetails: () => [],
      }),
    ).rejects.toMatchObject({
      message: "Step 0, atom 'architect' stale recovery lease failed: append failed",
    });

    expect(port.abort).not.toHaveBeenCalled();
    expect(port.resume).not.toHaveBeenCalled();
  });

  it('clears the continuation lease with launch_failed when resumed launch fails', async () => {
    const staleAtom = atom();
    const port = executionPort({
      awaitLaunch: vi.fn(async (): Promise<'error'> => 'error'),
    });

    await expect(
      recoverStaleAtom(stateFor(staleAtom), port, ctx, {
        time: { now: () => 100_000 },
        staleTimeoutMs: 1,
        staleAbortTimeoutMs: 30_000,
        onProgress: vi.fn(),
        buildPartialStepDetails: () => [],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Step 0, atom 'architect' resume failed"),
    });

    expect(port.clearContinuationLease).toHaveBeenCalledWith({
      sessionId: 'session-stale',
      jobId: 'job-resumed',
      outcome: 'launch_failed',
    });
  });
});
