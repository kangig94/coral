import * as fs from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { appendEvents } from '#src/store/append.js';
import { createEmptyRegistry } from '#src/store/envelope.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { composeReducers } from '#src/store/reducers.js';
import { rebuildProjections } from '#src/store/rebuild.js';
import { parseExpression } from '#src/workflow/parser.js';
import {
  workflowCompletedEvent,
  workflowDrainEnteredEvent,
  workflowPlanDeclaredEvent,
  workflowPlanRevisedEvent,
  workflowRegistry,
} from '#src/workflow/events.js';
import { buildWorkflowPlan, compileWorkflowPlan, replacePlanSlot } from '#src/workflow/plan.js';
import { readWorkflowView } from '#src/workflow/read-queries.js';

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const NOW = new Date('2026-04-19T00:00:00.000Z');

describe('workflow reducer equivalence', () => {
  it('rebuilds projection_workflows.plan rows byte-identically from workflow domain events', () => {
    const db = new Database(':memory:');
    try {
      applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
      const reducers = composeReducers(workflowRegistry);
      const upcasters = createEmptyRegistry();

      const declaredPlan = buildWorkflowPlan('workflow-1', parseExpression('architect -> resolver'), {
        defaultProvider: 'codex',
      });
      const revisedPlan = replacePlanSlot(declaredPlan, declaredPlan.slots[1].slotId, {
        provider: 'claude',
      });

      const appended = appendEvents(
        db,
        [
          workflowPlanDeclaredEvent('workflow-1', declaredPlan),
          // drain.entered is projection-only state: replay must preserve the drain window
          // without reviving the deleted workflow checkpoint persistence layer.
          workflowDrainEnteredEvent('workflow-1', {
            firstFailureSlotId: declaredPlan.slots[1].slotId,
            drainDeadline: Date.parse('2026-04-19T00:00:15.000Z'),
          }),
          workflowPlanRevisedEvent('workflow-1', revisedPlan),
          workflowCompletedEvent('workflow-1', { outcome: 'failed' }),
        ],
        { now: () => NOW, reducers, upcasters },
      );

      const before = db
        .prepare(
          `SELECT workflow_id, plan, last_seq
           FROM projection_workflows
          WHERE workflow_id = ?
          LIMIT 1`,
        )
        .get('workflow-1');

      expect(before).toEqual({
        workflow_id: 'workflow-1',
        plan: JSON.stringify(revisedPlan),
        last_seq: appended.at(-1)?.seq,
      });

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        upcasters,
      });

      const after = db
        .prepare(
          `SELECT workflow_id, plan, last_seq
           FROM projection_workflows
          WHERE workflow_id = ?
          LIMIT 1`,
        )
        .get('workflow-1');

      expect(after).toStrictEqual(before);
    } finally {
      db.close();
    }
  });

  it('builds WorkflowView slot outcomes from child job projections', () => {
    const db = new Database(':memory:');
    try {
      applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
      const reducers = composeReducers(jobsRegistry, workflowRegistry);
      const upcasters = createEmptyRegistry();
      const plan = buildWorkflowPlan('workflow-1', parseExpression('architect -> resolver'), {
        defaultProvider: 'codex',
      });
      const plannedSlots = compileWorkflowPlan(plan, {
        jobIds: new Map([
          [plan.slots[0].slotId, 'job-1'],
          [plan.slots[1].slotId, 'job-2'],
        ]),
      });
      const causeRef = { stream: { kind: 'workflow' as const, id: 'workflow-1' }, seq: 1 };

      appendEvents(
        db,
        [
          workflowPlanDeclaredEvent('workflow-1', plan),
          ...plannedSlots.map((slot) => ({
            type: 'job.launch.requested' as const,
            stream: { kind: 'job' as const, id: slot.jobId },
            refs: { sessionId: `session-${slot.jobId}`, parentJobId: 'workflow-1', workflowSlotId: slot.slotId },
            bodyVersion: 1,
            body: {
              sessionId: `session-${slot.jobId}`,
              provider: slot.provider,
              providerAction: 'exec' as const,
              projectRoot: '/workspace/coral',
              coordinatorNamespace: 'tests',
              jobKind: 'provider' as const,
              pool: 'default',
              enqueueSequence: slot.stepIndex + 1,
              request: {
                prompt: slot.instruction,
                cwd: '/workspace/coral',
                bypassPermissions: false,
                coralEnv: {},
              },
              createdAt: '2026-04-19T00:00:00.000Z',
            },
          })),
          {
            type: 'job.terminal.recorded',
            stream: { kind: 'job' as const, id: 'job-1' },
            refs: { sessionId: 'session-job-1', parentJobId: 'workflow-1', workflowSlotId: plan.slots[0].slotId },
            bodyVersion: 1,
            body: {
              terminal: {
                outcome: { kind: 'completed' as const },
                durationMs: 1,
                content: 'done',
              },
            },
          },
          {
            type: 'job.terminal.recorded',
            stream: { kind: 'job' as const, id: 'job-2' },
            refs: { sessionId: 'session-job-2', parentJobId: 'workflow-1', workflowSlotId: plan.slots[1].slotId },
            bodyVersion: 1,
            body: {
              terminal: {
                outcome: { kind: 'failed' as const, causeRef },
                durationMs: 2,
                content: '',
              },
            },
          },
          workflowCompletedEvent('workflow-1', { outcome: 'failed', causeRef }),
        ],
        { now: () => NOW, reducers, upcasters },
      );

      expect(readWorkflowView(db, 'workflow-1', { schemas: reducers.schemas, upcasters })).toMatchObject({
        workflowId: 'workflow-1',
        outcome: 'failed',
        causeRef,
        slotOutcomes: {
          [plan.slots[0].slotId]: { jobId: 'job-1', phase: 'completed', causeRef: null },
          [plan.slots[1].slotId]: { jobId: 'job-2', phase: 'error', causeRef },
        },
      });
    } finally {
      db.close();
    }
  });
});
