import { describe, expect, it } from 'vitest';

import { parseExpression } from '#src/workflow/parser.js';
import { buildWorkflowPlan, compileWorkflowPlan } from '#src/workflow/plan.js';
import { launchAtomWithRetry } from '#src/workflow/launch.js';
import { workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import { recoverStaleAtom } from '#src/workflow/stale-recovery.js';
import type { AwaitStepState } from '#src/workflow/wait.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { conversationIdentityFixture } from '#tests/integration/jobs/conversation-identity-fixture.js';

describe('workflow stale replacement conversation identity', () => {
  it('aborts and replaces stale executions twice without replacing the slot job', async () => {
    const f = conversationIdentityFixture({ stall: true });
    const workflowId = f.runtime.ids.uuid();
    const plan = buildWorkflowPlan(workflowId, parseExpression('architect'), { defaultProvider: 'codex' });
    const jobId = f.runtime.ids.uuid();
    const slot = compileWorkflowPlan(plan, { jobIds: new Map([[plan.slots[0]!.slotId, jobId]]) })[0]!;
    f.runtime.storage.mkdirSync('/plugin/agents', { recursive: true });
    f.runtime.storage.writeFileSync('/plugin/agents/architect.md', '---\n---\nWorkflow identity fixture');

    try {
      f.commit((commit) => {
        commit.append(workflowPlanDeclaredEvent(workflowId, plan, TEST_PROVIDER_SCOPE));
        return undefined;
      });
      const atom = await f.drive(
        launchAtomWithRetry({
          slot,
          atomIndex: 0,
          stepPrompt: 'workflow input',
          executionSvc: f.service,
          ctx: f.ctx,
          workflowJobId: workflowId,
          completedStepDetails: [],
        }),
      );
      expect(atom.jobId).toBe(jobId);
      const state: AwaitStepState = {
        pending: new Map([[jobId, atom]]),
        results: new Map(),
        cursor: undefined,
        lastActivityAt: new Map(),
        staleRetries: new Map(),
        expectedStaleAborts: new Set(),
        observedIdleMs: new Map(),
        lastObservedAtMonotonicMs: f.runtime.time.monotonicNow(),
        observedDrainMs: 0,
        failureDrain: null,
        unobservable: new Set(),
        abortAbsent: new Set(),
      };

      for (const execution of [2, 3]) {
        state.observedIdleMs.set(atom.atomKey, 1000);
        expect(
          await f.drive(
            recoverStaleAtom(state, f.service, f.ctx, {
              time: f.runtime.time,
              staleTimeoutMs: 1000,
              staleAbortTimeoutMs: 10_000,
              workflowJobId: workflowId,
              workDir: f.ctx.projectRoot,
              onProgress: () => {},
              buildPartialStepDetails: () => [],
            }),
          ),
        ).toBe(true);
        expect([...state.pending.keys()]).toEqual([jobId]);
        expect(state.pending.get(jobId)?.jobId).toBe(jobId);
        expect(f.store.readStatus(jobId)).toMatchObject({ execution });
      }
      expect(f.service.abort([jobId]).aborted).toEqual([jobId]);
      await f.drive(f.service.waitForJobTerminal(jobId, 10_000));

      expect(f.store.listJobIds()).toEqual([jobId]);
      f.assertIdentity(jobId, [1, 2, 3]);
      expect(f.requests.slice(1).map((request) => request.conversationRef)).toEqual([
        `thread-${jobId}`,
        `thread-${jobId}`,
      ]);
    } finally {
      await f.dispose();
    }
  });
});
