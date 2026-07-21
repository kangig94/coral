// Cross-domain handoff coverage for workflow recovery across a daemon swap.
// Exercises the harness against an in-flight workflow projection: events
// land on Core A's journal, Core A shuts down with handoff mode, Core B
// composes against the shared store, and `workflowRecover.resumeAll`
// (production default behavior) reads the same journal and dispatches the
// in-progress slot.
//
// The second skipped scenario from the original stub ("does not finalize an
// interrupted workflow child on the old daemon") is gated by
// `tests/unit/jobs/shell/launch-quiesce.test.ts` at the contract boundary —
// duplicating it at integration level adds churn without surfacing new
// behavior, so it stays unimplemented.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitWorkflowEvents } from '#src/workflow/projections.js';
import { loadJobProjectionDetails } from '#src/jobs/read-queries.js';
import { workflowRecover } from '#src/workflow/recover.js';
import { workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import { buildWorkflowPlan } from '#src/workflow/plan.js';
import { parseExpression } from '#src/workflow/parser.js';
import type { JobTerminal } from '#src/jobs/records.js';
import type { WaitStreamEvent, WaitStreamRequest } from '#src/jobs/wait.js';
import type { WorkflowExecutionPort } from '#src/workflow/execution-contract.js';

import { createHandoffCoresHarness, type HandoffCoresHarness } from './handoff-cores-harness.js';

const PROJECT_ROOT = '/handoff-workflow-project';
const WORKFLOW_ID = 'workflow-handoff-1';

function workflowPlanForTest() {
  return buildWorkflowPlan(WORKFLOW_ID, parseExpression('architect'), { defaultProvider: 'codex' });
}

function terminalEvent(jobId: string, content: string): WaitStreamEvent {
  const result: JobTerminal = { content, outcome: { kind: 'completed' } };
  return {
    type: 'terminal',
    jobId,
    seq: 0,
    remainingJobIds: [],
    resultPath: `/tmp/coral-handoff-workflow/${jobId}/result.md`,
    result,
  };
}

async function* emitOnce(events: WaitStreamEvent[]): AsyncGenerator<WaitStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

const harnesses: HandoffCoresHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.cleanup();
  }
});

describe('workflow handoff (cross-domain integration)', () => {
  it('replacement recovery resumes a running workflow slot from the shared journal', async () => {
    const harness = createHandoffCoresHarness();
    harnesses.push(harness);

    const incumbent = await harness.bootCore({ instanceId: 'incumbent' });
    const plan = workflowPlanForTest();
    const slotJobId = plan.slots[0].slotId;

    commitWorkflowEvents(
      harness.db,
      (c) => {
        c.append(workflowPlanDeclaredEvent(WORKFLOW_ID, plan));
        return undefined;
      },
      harness.runtime.time,
      permissiveProviderLookupPort,
    );
    const progressStore = incumbent.core.storeServicesRef.get().progressStore;
    initTestJob(progressStore, {
      jobId: WORKFLOW_ID,
      sessionId: 'workflow-session-1',
      provider: 'codex',
      projectRoot: PROJECT_ROOT,
      backendNamespace: incumbent.core.identity.namespace,
      jobKind: 'workflow',
      providerScope: TEST_PROVIDER_SCOPE,
      initialPhase: 'running',
    });
    initTestJob(progressStore, {
      jobId: slotJobId,
      sessionId: 'session-slot-1',
      provider: 'codex',
      projectRoot: PROJECT_ROOT,
      backendNamespace: incumbent.core.identity.namespace,
      initialPhase: 'running',
    });
    harness.db
      .prepare(
        `INSERT INTO projection_jobs (
           job_id, phase, session_id, provider, project_root, backend_namespace,
           job_kind, parent_workflow_job_id, workflow_slot, created_at, last_seq
         )
         VALUES (?, 'running', ?, ?, ?, ?, 'provider', ?, ?, '2026-04-27T00:00:00.000Z', 17)
         ON CONFLICT(job_id) DO UPDATE SET
           phase = excluded.phase,
           parent_workflow_job_id = excluded.parent_workflow_job_id,
           workflow_slot = excluded.workflow_slot,
           last_seq = excluded.last_seq`,
      )
      .run(
        slotJobId,
        'session-slot-1',
        'codex',
        PROJECT_ROOT,
        incumbent.core.identity.namespace,
        WORKFLOW_ID,
        slotJobId,
      );

    await incumbent.shutdown('replaced');
    expect(incumbent.core.runtimeState.getLifecycle()).toBe('stopped');

    const waitRequests: WaitStreamRequest[] = [];
    const finalizeWorkflow = vi.fn();
    const resumedIds: string[] = [];

    const replacement = await harness.bootCore({
      instanceId: 'replacement',
      runStartupRecoveryFn: async ({
        knownDiscussSources,
        getDiscussStoreForSource,
        getDiscussContext,
        createInvocationContext,
        signal,
        recoverPersistedDiscussFn,
        progressStore,
      }) => {
        const discussResumes = await recoverPersistedDiscussFn({
          knownDiscussSources,
          getDiscussStoreForSource,
          getDiscussContext,
          createInvocationContext,
          signal,
        });

        const stubExecution: WorkflowExecutionPort = {
          coralDispatch: vi.fn(async () => ({
            status: 'running' as const,
            job: 'should-not-relaunch',
            session: 'should-not-relaunch',
          })),
          resume: vi.fn(),
          abort: vi.fn(() => ({ aborted: [], notFound: [] })),
          awaitLaunch: vi.fn(async () => 'ready' as const),
          waitStream: vi.fn((req: WaitStreamRequest) => {
            waitRequests.push({
              ...req,
              jobIds: [...req.jobIds],
              ...(req.cursor ? { cursor: { afterSeq: req.cursor.afterSeq } } : {}),
            });
            return emitOnce(req.jobIds.map((jobId) => terminalEvent(jobId, `result:${jobId}`)));
          }),
          waitForJobTerminal: vi.fn(async () => {}),
        } as unknown as WorkflowExecutionPort;

        const resumed = await workflowRecover.resumeAll({
          db: progressStore.getDb(),
          progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => stubExecution,
          createInvocationContext,
          finalizeWorkflow,
          time: harness.runtime.time,
        });
        resumedIds.push(...resumed);

        return discussResumes;
      },
    });

    expect(resumedIds).toEqual([WORKFLOW_ID]);
    expect(waitRequests).toHaveLength(1);
    expect(waitRequests[0]).toMatchObject({
      jobIds: [slotJobId],
      cursor: { afterSeq: 17 },
    });
    expect(finalizeWorkflow).toHaveBeenCalledTimes(1);

    await replacement.shutdown('test-cleanup');
  });
});
