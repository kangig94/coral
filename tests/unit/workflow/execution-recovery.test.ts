import { testConversationFacet } from '#tests/helpers/session.js';
import { describe, expect, it, vi } from 'vitest';

import { createFailedWorkflowDescendantReleaser } from '#src/coordinator/services/workflow-recovery-descendants.js';
import { createWorkflowRecoveryFinalizer } from '#src/coordinator/services/workflow-recovery-finalizer.js';
import { JobStore } from '#src/jobs/store.js';
import { appendJobExecutionEnded, appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { aggregateWorkflowUsage } from '#src/jobs/workflow-usage.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { parseExpression } from '#src/workflow/parser.js';
import { buildWorkflowPlan } from '#src/workflow/plan.js';
import { readWorkflowView } from '#src/workflow/read-queries.js';
import { recoverAll } from '#src/workflow/recover.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import {
  EXECUTION_JOB_ID as jobId,
  OTHER_EXECUTION_JOB_ID as workflowId,
  EXECUTION_NOW,
  executionHarness,
  executionInput,
  openedJob,
  requestedExecution,
} from '#tests/helpers/job-executions.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

function fixture() {
  const h = executionHarness(workflowRegistry);
  const runtime = new SimulationRuntime();
  const projectRoot = fixtureCanonicalWorkDir(process.cwd());
  const plan = buildWorkflowPlan(workflowId, parseExpression('architect'), { defaultProvider: 'codex' });
  const slotId = plan.slots[0].slotId;
  h.append(
    workflowPlanDeclaredEvent(workflowId, plan, TEST_PROVIDER_SCOPE),
    executionInput(
      'job.opened',
      {
        jobKind: 'workflow',
        owner: { kind: 'workflow', id: workflowId },
        projectRoot,
        cwd: projectRoot,
        bypassPermissions: false,
        createdAt: EXECUTION_NOW,
      },
      workflowId,
    ),
    { ...requestedExecution(), stream: { kind: 'job', id: workflowId } },
    executionInput(
      'job.execution.started',
      { execution: 1, transport: 'workflow', startedAt: EXECUTION_NOW },
      workflowId,
    ),
    openedJob({
      projectRoot,
      conversation: testConversationFacet('codex', projectRoot),
      owner: { kind: 'workflow', id: workflowId },
      workflowSlotId: slotId,
    }),
    requestedExecution(),
  );
  const finish = (execution: number) =>
    h.commit((commit) => {
      const accepted = appendJobExecutionOutcomeAccepted(commit, {
        jobId,
        execution,
        terminal: {
          content: execution === 1 ? '' : 'replacement result',
          durationMs: 1,
          outcome: execution === 1 ? { kind: 'aborted', reason: 'signal_abort' } : { kind: 'completed' },
        },
        diagnostics: { usage: { inputTokens: execution * 10, costUsd: execution / 4 } },
      });
      appendJobExecutionEnded(commit, { jobId, execution, causeRef: accepted });
      return undefined;
    });
  finish(1);
  h.append(requestedExecution(2, { originatingClientMessageId: undefined }));
  const store = new JobStore('tests', runtime, createEventBodyCodec(), {
    db: h.db,
    reducers: h.ctx.reducers,
    providers: permissiveProviderLookupPort,
  });
  const abort = vi.fn(() => ({ aborted: [], notFound: [] }));
  const releaseAdoptedJob = vi.fn();
  const release = createFailedWorkflowDescendantReleaser({
    progressStore: store,
    runtime,
    coordinatorCommit: h.commit,
    getExecutionService: () => ({ abort }),
    createInvocationContext: () => ({
      projectRoot,
      pluginRoot: '/plugin',
      coralEnv: {},
      principal: testProjectPrincipal(projectRoot),
    }),
    releaseAdoptedJob,
    log: () => {},
  });
  return { ...h, runtime, projectRoot, slotId, finish, store, release, abort, releaseAdoptedJob };
}

describe('workflow slot execution recovery', () => {
  it('closes from execution #2 after the same slot job ended #1 as aborted', async () => {
    const f = fixture();
    try {
      f.finish(2);
      expect(readWorkflowView(f.db, workflowId, f.readCtx)?.slotOutcomes[f.slotId]).toMatchObject({
        jobId,
        execution: 2,
        phase: 'completed',
      });
      expect(
        await recoverAll({
          db: f.db,
          progressStore: f.store,
          ids: f.runtime.ids,
          time: f.runtime.time,
          finalizeWorkflow: createWorkflowRecoveryFinalizer({
            runtime: f.runtime,
            progressStore: f.store,
            coordinatorCommit: f.commit,
          }),
          releaseFailedWorkflowDescendants: f.release,
        }),
      ).toEqual([workflowId]);
      expect(f.store.loadJobProjectionDetail(workflowId).exit).toMatchObject({
        content: 'replacement result',
        outcome: { kind: 'completed' },
      });
      expect(aggregateWorkflowUsage(f.db, workflowId)).toEqual({ inputTokens: 30, costUsd: 0.75 });
    } finally {
      f.db.close();
    }
  });

  it('refuses old descendant cleanup after the same job has advanced to the next execution', () => {
    const f = fixture();
    try {
      const old = { jobId, execution: 1, projectRoot: f.projectRoot };
      f.commit((commit) => {
        expect(f.release.composeAtomic(commit, [old])).toEqual([]);
        return undefined;
      });
      f.release.cleanup([old]);
      expect(f.abort).not.toHaveBeenCalled();
      expect(f.releaseAdoptedJob).not.toHaveBeenCalled();
      f.finish(2);
      f.commit((commit) => {
        expect(f.release.composeAtomic(commit, [{ ...old, execution: 2 }])).toEqual([{ jobId, execution: 2 }]);
        return undefined;
      });
    } finally {
      f.db.close();
    }
  });
});
