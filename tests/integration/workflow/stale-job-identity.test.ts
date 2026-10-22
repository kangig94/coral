import { describe, expect, it, vi } from 'vitest';

import { parseExpression } from '#src/workflow/parser.js';
import { buildWorkflowPlan, compileWorkflowPlan } from '#src/workflow/plan.js';
import { launchAtomWithRetry } from '#src/workflow/launch.js';
import { workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import { recoverStaleAtom } from '#src/workflow/stale-recovery.js';
import { aggregateWorkflowUsage } from '#src/jobs/workflow-usage.js';
import { readWorkflowView } from '#src/workflow/read-queries.js';
import { waitForAtoms, type AwaitStepState } from '#src/workflow/wait.js';
import type { WorkflowExecutionPort } from '#src/workflow/execution-contract.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { conversationIdentityFixture } from '#tests/integration/jobs/conversation-identity-fixture.js';

describe('workflow stale replacement conversation identity', () => {
  it.each([false, true])(
    'ignores delayed and duplicate old ends while the replacement fails=%s',
    async (failOnResume) => {
      const f = conversationIdentityFixture({ stall: true, managedArtifacts: true, failOnResume });
      const workflowId = f.runtime.ids.uuid();
      const plan = buildWorkflowPlan(workflowId, parseExpression('architect'), { defaultProvider: 'codex' });
      const jobId = f.runtime.ids.uuid();
      const slot = compileWorkflowPlan(plan, { jobIds: new Map([[plan.slots[0].slotId, jobId]]) })[0];
      f.runtime.storage.mkdirSync('/plugin/agents', { recursive: true });
      f.runtime.storage.writeFileSync('/plugin/agents/architect.md', '---\n---\nWorkflow stale fixture');
      try {
        f.commit((commit) => {
          commit.append(workflowPlanDeclaredEvent(workflowId, plan, TEST_PROVIDER_SCOPE));
          return undefined;
        });
        const atom = await f.drive(
          launchAtomWithRetry({
            slot,
            atomIndex: 0,
            stepPrompt: 'original',
            executionSvc: f.service,
            ctx: f.ctx,
            workflowJobId: workflowId,
            completedStepDetails: [],
          }),
        );
        const originalSelection = {
          jobId,
          requestedSeq: atom.requestedSeq,
          epochKey: atom.epochKey,
          awaitingArtifact: false,
        };
        const state: AwaitStepState = {
          pending: new Map([[jobId, atom]]),
          results: new Map(),
          cursor: undefined,
          lastActivityAt: new Map(),
          staleRetries: new Map(),
          expectedStaleAborts: new Map(),
          executionSelections: [originalSelection],
          observedIdleMs: new Map([[atom.atomKey, 1000]]),
          lastObservedAtMonotonicMs: f.runtime.time.monotonicNow(),
          observedDrainMs: 0,
          failureDrain: null,
          unobservable: new Set(),
          abortAbsent: new Set(),
        };
        expect(
          await f.drive(
            recoverStaleAtom(state, f.service, f.ctx, {
              time: f.runtime.time,
              staleTimeoutMs: 1000,
              staleAbortTimeoutMs: 10_000,
              workflowJobId: workflowId,
              onProgress: () => {},
              buildPartialStepDetails: () => [],
            }),
          ),
        ).toBe(true);
        expect(state.pending.get(jobId)).toMatchObject({ execution: 2 });
        expect(state.expectedStaleAborts.size).toBe(0);

        const oldEvents: WaitStreamEvent[] = [];
        await f.drive(
          (async () => {
            for await (const event of f.service.waitStream({
              jobIds: [jobId],
              executionSelections: [originalSelection],
              timeoutSeconds: 1,
            }))
              if (event.type === 'terminal') oldEvents.push(event);
          })(),
        );
        expect(oldEvents).toHaveLength(1);
        const oldEnd = oldEvents[0];
        const ended = vi.fn();
        const failureDrain = vi.fn();
        const progress: string[] = [];
        const port: WorkflowExecutionPort = {
          coralDispatch: (...args) => f.service.coralDispatch(...args),
          resume: (...args) => f.service.resume(...args),
          abort: (...args) => f.service.abort(...args),
          awaitLaunch: (...args) => f.service.awaitLaunch(...args),
          waitStream: async function* (request) {
            yield oldEnd;
            yield oldEnd;
            for await (const event of f.service.waitStream(request)) {
              yield event;
              if (event.type === 'terminal') yield event;
            }
          },
        };
        f.finish(jobId);
        const result = f.drive(
          waitForAtoms([...state.pending.values()], port, f.ctx, {
            time: f.runtime.time,
            staleTimeoutMs: 0,
            staleCheckIntervalMs: 1000,
            staleAbortTimeoutMs: 10_000,
            drainDeadlineMs: 10_000,
            workflowJobId: workflowId,
            onProgress: (message) => progress.push(message),
            onAtomTerminal: ended,
            onFailureDrain: failureDrain,
            initialState: {
              cursor: state.cursor,
              executionSelections: state.executionSelections,
              expectedStaleAborts: new Map([[jobId, atom]]),
            },
          }),
        );
        if (failOnResume) {
          await expect(result).rejects.toMatchObject({ failedJobId: jobId, aborted: false });
          expect(ended).not.toHaveBeenCalled();
          expect(failureDrain.mock.calls[0]?.[0].expectedStaleAborts.get(jobId)).toMatchObject({ execution: 1 });
        } else {
          expect([...(await result).values()]).toEqual([
            'Your previous execution timed out due to inactivity. Continue where you left off.',
          ]);
          expect(ended).toHaveBeenCalledOnce();
        }
        expect(progress.filter((message) => message.endsWith('done') || message.endsWith('error'))).toHaveLength(1);
        f.assertIdentity(jobId, [1, 2]);
        expect(f.discarded).toHaveLength(2);
        expect(aggregateWorkflowUsage(f.db, workflowId)).toEqual({ inputTokens: 20, outputTokens: 10, costUsd: 0.5 });
      } finally {
        await f.dispose();
      }
    },
  );

  it('aborts and replaces stale executions twice without replacing the slot job', async () => {
    const f = conversationIdentityFixture({ stall: true, managedArtifacts: true });
    const workflowId = f.runtime.ids.uuid();
    const plan = buildWorkflowPlan(workflowId, parseExpression('architect'), { defaultProvider: 'codex' });
    const jobId = f.runtime.ids.uuid();
    const slot = compileWorkflowPlan(plan, { jobIds: new Map([[plan.slots[0].slotId, jobId]]) })[0];
    f.runtime.storage.mkdirSync('/plugin/agents', { recursive: true });
    f.runtime.storage.writeFileSync('/plugin/agents/architect.md', '---\neffort: high\n---\nWorkflow identity fixture');

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
        expectedStaleAborts: new Map(),
        executionSelections: [
          { jobId, requestedSeq: atom.requestedSeq, epochKey: atom.epochKey, awaitingArtifact: false },
        ],
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
        expect(state.pending.get(jobId)?.execution).toBe(execution);
        expect(state.expectedStaleAborts.size).toBe(0);
        expect(f.store.readStatus(jobId)).toMatchObject({ execution });
        expect(readWorkflowView(f.db, workflowId, f.readCtx)?.slotOutcomes[slot.slotId]).toMatchObject({
          jobId,
          execution,
        });
      }
      expect(f.service.abort([jobId]).aborted).toEqual([jobId]);
      await f.drive(f.service.waitForJobTerminal(jobId, 10_000));

      expect(f.store.listJobIds()).toEqual([jobId]);
      expect(f.restored).toEqual([
        'workflow input\n',
        'workflow input\nYour previous execution timed out due to inactivity. Continue where you left off.\n',
      ]);
      expect(f.discarded).toEqual([[f.nativePath(jobId)], [f.nativePath(jobId)], [f.nativePath(jobId)]]);
      expect(f.runtime.storage.existsSync(f.nativePath(jobId))).toBe(false);
      expect(aggregateWorkflowUsage(f.db, workflowId)).toEqual({ inputTokens: 30, outputTokens: 15, costUsd: 0.75 });
      f.assertIdentity(jobId, [1, 2, 3]);
      expect(f.requests.slice(1).map((request) => request.conversationRef)).toEqual([
        `thread-${jobId}`,
        `thread-${jobId}`,
      ]);
      expect(f.requests.map((request) => request.effort)).toEqual(['high', 'high', 'high']);
    } finally {
      await f.dispose();
    }
  });
});
