import { describe, expect, it, vi } from 'vitest';

import type { CauseRef, CauseRefToken } from '#src/causality/cause-ref.js';
import type { CommitContext } from '#src/store/append.js';
import type { ResolvableCoralEventInput } from '#src/store/envelope.js';
import { selectFinalCauseRef } from '#src/coordinator/services/workflow-finalization.js';
import type { WorkflowFinalizationIntent } from '#src/workflow/finalization.js';
import { createWorkflowRecoveryFinalizer } from '#src/coordinator/services/workflow-recovery-finalizer.js';
import type { AtomicFailedWorkflowDescendantReleaser, WorkflowRecoveryDescendant } from '#src/workflow/recover.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

type RecordedInput = {
  readonly input: ResolvableCoralEventInput<unknown, unknown>;
  readonly token: CauseRefToken<unknown>;
};

function createContextRecorder(): {
  readonly appended: RecordedInput[];
  readonly c: CommitContext<unknown>;
} {
  const appended: RecordedInput[] = [];
  return {
    appended,
    c: {
      append(input) {
        const token = { slot: appended.length } as unknown as CauseRefToken<unknown>;
        appended.push({ input, token });
        return token;
      },
    },
  };
}

const WORKFLOW_JOB_ID = 'workflow-1';
const STEP_DETAILS = [] as Extract<WorkflowFinalizationIntent, { outcome: 'failed' }>['stepDetails'];

describe('selectFinalCauseRef precedence', () => {
  it('uses causeRef directly and does NOT append a lifecycle_fault when both are set', () => {
    const { appended, c } = createContextRecorder();
    const causeRef: CauseRef = {
      stream: { kind: 'job', id: 'job-1' },
      seq: 7,
    };
    const intent: Extract<WorkflowFinalizationIntent, { outcome: 'failed' }> = {
      outcome: 'failed',
      workflowJobId: WORKFLOW_JOB_ID,
      causeRef,
      lifecycleFault: { kind: 'wrapper_crashed', message: 'should be discarded' },
      stepDetails: STEP_DETAILS,
    };

    const result = selectFinalCauseRef(c, WORKFLOW_JOB_ID, intent);

    expect(result).toBe(causeRef);
    expect(appended).toEqual([]);
  });

  it('appends workflow.lifecycle_fault and returns its token when only lifecycleFault is set', () => {
    const { appended, c } = createContextRecorder();
    const intent: Extract<WorkflowFinalizationIntent, { outcome: 'failed' }> = {
      outcome: 'failed',
      workflowJobId: WORKFLOW_JOB_ID,
      lifecycleFault: { kind: 'wrapper_crashed', message: 'wrapper exploded' },
      stepDetails: STEP_DETAILS,
    };

    const result = selectFinalCauseRef(c, WORKFLOW_JOB_ID, intent);

    expect(appended).toHaveLength(1);
    expect(appended[0].input).toMatchObject({
      type: 'workflow.lifecycle_fault',
      stream: { kind: 'workflow', id: WORKFLOW_JOB_ID },
      body: { kind: 'wrapper_crashed', message: 'wrapper exploded' },
    });
    expect(result).toBe(appended[0].token);
  });

  it('materializes a normally recovered workflow only after its terminal commit', () => {
    const runtime = new SimulationRuntime();
    const { appended, c } = createContextRecorder();
    const order: string[] = [];
    const materializeResultArtifact = vi.fn((jobId: string) => {
      order.push(`materialize:${jobId}`);
      return `/jobs/${jobId}/result.md`;
    });
    const finalizer = createWorkflowRecoveryFinalizer({
      runtime,
      progressStore: {
        readStatus: () => ({ backendNamespace: 'ns', projectRoot: '/project' }) as never,
        readRuntimeProjection: () => ({ transport: 'workflow', startTime: new Date(runtime.time.now()).toISOString() }),
        ensureResultArtifact: vi.fn(() => '/jobs/workflow-1/result.md'),
        materializeResultArtifact,
      },
      coordinatorCommit: ((callback: (context: CommitContext<unknown>) => unknown) => {
        order.push('commit:start');
        callback(c);
        order.push('commit:end');
      }) as never,
    });

    finalizer({
      outcome: 'completed',
      workflowJobId: 'workflow-1',
      finalOutput: 'done',
      stepDetails: STEP_DETAILS,
    });

    expect(order).toEqual(['commit:start', 'commit:end', 'materialize:workflow-1']);
    expect(appended.map(({ input }) => input.type)).toEqual(['workflow.completed', 'job.terminal.recorded']);
    expect(materializeResultArtifact).toHaveBeenCalledExactlyOnceWith('workflow-1');
  });

  it('composes workflow finalization, exact descendant release, and continuation clear in one commit', () => {
    const runtime = new SimulationRuntime();
    const { appended, c } = createContextRecorder();
    const order: string[] = [];
    const coordinatorCommit = vi.fn((cb: (context: CommitContext<unknown>) => unknown) => {
      order.push('commit:start');
      cb(c);
      order.push('commit:end');
    });
    const materializeResultArtifact = vi.fn(() => '/jobs/workflow-1/result.md');
    const finalizer = createWorkflowRecoveryFinalizer({
      runtime,
      progressStore: {
        readStatus: () => null,
        readRuntimeProjection: () => null,
        ensureResultArtifact: vi.fn(() => '/jobs/workflow-1/result.md'),
        materializeResultArtifact,
      },
      coordinatorCommit: coordinatorCommit as never,
    });
    const descendants: readonly WorkflowRecoveryDescendant[] = [
      {
        jobId: 'workflow-1:slot:0',
        sessionId: 'session-1',
        projectRoot: fixtureCanonicalWorkDir('/project'),
        expectedSessionVersion: 4,
      },
    ];
    const releaseDescendants = (() => []) as unknown as AtomicFailedWorkflowDescendantReleaser;
    releaseDescendants.composeAtomic = (_commit, received) => {
      order.push('descendants');
      expect(received).toBe(descendants);
      return [{ jobId: 'workflow-1:slot:0', sessionId: 'session-1', sessionClaimRelease: 'released' }];
    };
    releaseDescendants.cleanup = () => {};
    const intent: WorkflowFinalizationIntent = {
      outcome: 'failed',
      workflowJobId: 'workflow-1',
      lifecycleFault: { kind: 'recovery_failed', message: 'decoded domain error' },
      stepDetails: [],
    };

    const releases = finalizer.atomicClose?.({
      intent,
      recording: { namespace: 'ns', project: '/project', startedAt: new Date(runtime.time.now()).toISOString() },
      descendants,
      releaseDescendants,
      clearContinuation: () => {
        order.push('continuation');
        return true;
      },
    });

    expect(releases).toEqual([{ jobId: 'workflow-1:slot:0', sessionId: 'session-1', sessionClaimRelease: 'released' }]);
    expect(order).toEqual(['commit:start', 'descendants', 'continuation', 'commit:end']);
    expect(appended.map(({ input }) => input.type)).toEqual([
      'workflow.lifecycle_fault',
      'workflow.completed',
      'job.terminal.recorded',
    ]);
    expect(materializeResultArtifact).toHaveBeenCalledExactlyOnceWith('workflow-1');
  });
});
