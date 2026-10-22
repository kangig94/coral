import { describe, expect, it } from 'vitest';

import { workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import { launchAtomWithRetry } from '#src/workflow/launch.js';
import { parseExpression } from '#src/workflow/parser.js';
import { buildWorkflowPlan, compileWorkflowPlan } from '#src/workflow/plan.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { conversationIdentityFixture } from '#tests/integration/jobs/conversation-identity-fixture.js';

describe('workflow continuation admission atomicity', () => {
  it('rolls back a failed next request and retries the same job after its native artifacts were discarded', async () => {
    const f = conversationIdentityFixture({ stall: true, managedArtifacts: true });
    const workflowId = f.runtime.ids.uuid();
    const plan = buildWorkflowPlan(workflowId, parseExpression('architect'), { defaultProvider: 'codex' });
    const jobId = f.runtime.ids.uuid();
    const slot = compileWorkflowPlan(plan, { jobIds: new Map([[plan.slots[0].slotId, jobId]]) })[0];
    f.runtime.storage.mkdirSync('/plugin/agents', { recursive: true });
    f.runtime.storage.writeFileSync('/plugin/agents/architect.md', '---\n---\nWorkflow atomicity fixture');
    try {
      f.commit((commit) => {
        commit.append(workflowPlanDeclaredEvent(workflowId, plan, TEST_PROVIDER_SCOPE));
        return undefined;
      });
      await f.drive(
        launchAtomWithRetry({
          slot,
          atomIndex: 0,
          stepPrompt: 'first',
          executionSvc: f.service,
          ctx: f.ctx,
          workflowJobId: workflowId,
          completedStepDetails: [],
        }),
      );
      f.service.abort([jobId]);
      await f.drive(f.service.waitForJobTerminal(jobId, 10_000));
      expect(f.runtime.storage.existsSync(f.nativePath(jobId))).toBe(false);
      const before = f.events(jobId);
      const input = {
        jobId,
        prompt: 'replacement',
        parentWorkflowJobId: workflowId,
        workflowSlotId: slot.slotId,
        owner: { kind: 'workflow' as const, id: workflowId },
      };
      f.db.exec(`CREATE TRIGGER fail_workflow_continuation_admission BEFORE INSERT ON events
        WHEN NEW.type = 'job.execution.admitted' AND json_extract(CAST(NEW.body AS TEXT), '$.execution') = 2
        BEGIN SELECT RAISE(ABORT, 'forced workflow continuation failure'); END`);
      await expect(f.drive(f.service.resume('codex', input, f.ctx))).rejects.toThrow(
        'forced workflow continuation failure',
      );
      expect(f.events(jobId)).toEqual(before);
      expect(f.store.readStatus(jobId)).toMatchObject({ execution: 1, phase: 'aborted' });
      expect(f.admission.getActiveJobIds()).toEqual([]);
      expect(f.store.listJobIds()).toEqual([jobId]);
      expect(f.restored).toEqual([]);
      f.db.exec('DROP TRIGGER fail_workflow_continuation_admission');
      expect(await f.drive(f.service.resume('codex', input, f.ctx))).toMatchObject({ status: 'running', jobId });
      expect(await f.drive(f.service.awaitLaunch(jobId, 2000))).toBe('ready');
      expect(f.store.readStatus(jobId)).toMatchObject({ execution: 2 });
      expect(f.restored).toEqual(['first\n']);
      f.finish(jobId);
      await f.drive(f.service.waitForJobTerminal(jobId, 10_000));
      f.assertIdentity(jobId, [1, 2]);
    } finally {
      await f.dispose();
    }
  });
});
