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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { seedTestJobSession } from '#tests/helpers/session.js';
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

const PROJECT_ROOT = mkdtempSync(join(tmpdir(), 'coral-handoff-workflow-project-'));
const WORKFLOW_ID = 'workflow-handoff-1';

afterAll(() => {
  rmSync(PROJECT_ROOT, { recursive: true, force: true });
});

function workflowPlanForTest() {
  return buildWorkflowPlan(WORKFLOW_ID, parseExpression('architect'), { defaultProvider: 'codex' });
}

function terminalEvent(jobId: string, content: string): WaitStreamEvent {
  const result: JobTerminal = { content, durationMs: 0, outcome: { kind: 'completed' } };
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
        c.append(workflowPlanDeclaredEvent(WORKFLOW_ID, plan, TEST_PROVIDER_SCOPE));
        return undefined;
      },
      harness.runtime.time,
      permissiveProviderLookupPort,
    );
    const progressStore = incumbent.core.storeServicesRef.get().progressStore;
    progressStore.appendLaunchRequested(WORKFLOW_ID, {
      jobId: WORKFLOW_ID,
      owner: { kind: 'workflow', id: WORKFLOW_ID },
      sessionId: null,
      provider: null,
      projectRoot: PROJECT_ROOT,
      backendNamespace: incumbent.core.identity.namespace,
      jobKind: 'workflow',
      pool: 'default',
      enqueueSequence: progressStore.nextEnqueueSequence(),
      request: {
        prompt: '',
        cwd: PROJECT_ROOT,
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: new Date(harness.runtime.time.now()).toISOString(),
    });
    progressStore.commit((c) => {
      c.append({
        type: 'job.runtime.started',
        stream: { kind: 'job', id: WORKFLOW_ID },
        namespace: incumbent.core.identity.namespace,
        project: PROJECT_ROOT,
        refs: { jobId: WORKFLOW_ID, workflowId: WORKFLOW_ID },
        body: { transport: 'workflow', startedAt: new Date(harness.runtime.time.now()).toISOString() },
      });
      return undefined;
    });
    seedTestJobSession(progressStore, {
      jobId: slotJobId,
      sessionId: 'session-slot-1',
      provider: 'codex',
      projectRoot: PROJECT_ROOT,
      backendNamespace: incumbent.core.identity.namespace,
    });
    progressStore.appendLaunchRequested(slotJobId, {
      jobId: slotJobId,
      owner: { kind: 'workflow', id: WORKFLOW_ID },
      sessionId: 'session-slot-1',
      provider: 'codex',
      projectRoot: PROJECT_ROOT,
      backendNamespace: incumbent.core.identity.namespace,
      jobKind: 'provider',
      parentWorkflowJobId: WORKFLOW_ID,
      workflowSlotId: slotJobId,
      workflowSlotGeneration: 0,
      pool: 'default',
      enqueueSequence: progressStore.nextEnqueueSequence(),
      providerAction: 'exec',
      request: {
        prompt: '',
        cwd: PROJECT_ROOT,
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: new Date(harness.runtime.time.now()).toISOString(),
    });
    progressStore.commit((c) => {
      c.append({
        type: 'job.runtime.started',
        stream: { kind: 'job', id: slotJobId },
        namespace: incumbent.core.identity.namespace,
        project: PROJECT_ROOT,
        refs: {
          jobId: slotJobId,
          sessionId: 'session-slot-1',
          parentJobId: WORKFLOW_ID,
          workflowId: WORKFLOW_ID,
          workflowSlotId: slotJobId,
        },
        body: { transport: 'workflow', startedAt: new Date(harness.runtime.time.now()).toISOString() },
      });
      return undefined;
    });
    const expectedCursor = progressStore.readStatus(slotJobId)?.lastSeq;
    expect(expectedCursor).toBeTypeOf('number');

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
            kind: 'provider-session' as const,
            status: 'running' as const,
            jobId: 'should-not-relaunch',
            sessionId: 'should-not-relaunch',
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
          releaseFailedWorkflowDescendants: () => [],
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
      cursor: { afterSeq: expectedCursor },
    });
    expect(finalizeWorkflow).toHaveBeenCalledTimes(1);

    await replacement.shutdown('test-cleanup');
  });
});
