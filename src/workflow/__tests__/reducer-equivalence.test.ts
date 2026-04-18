import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { appendEvents } from '../../store/append.js';
import { createEmptyRegistry } from '../../store/envelope.js';
import { applyMigrations } from '../../store/migrations.js';
import { composeReducers } from '../../store/reducers.js';
import { rebuildProjections } from '../../store/rebuild.js';
import { parseExpression } from '../parser.js';
import {
  workflowCompletedEvent,
  workflowDrainEnteredEvent,
  workflowPlanDeclaredEvent,
  workflowPlanRevisedEvent,
  workflowRegistry,
} from '../events.js';
import { buildWorkflowPlan, replacePlanSlot } from '../plan.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../store/migrations');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const NOW = new Date('2026-04-19T00:00:00.000Z');

describe('workflow reducer equivalence (AC4)', () => {
  it('rebuilds projection_workflows.plan rows byte-identically from workflow domain events', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });
      const reducers = composeReducers(workflowRegistry);
      const upcasters = createEmptyRegistry();

      const declaredPlan = buildWorkflowPlan('workflow-1', parseExpression('architect -> resolver'), {
        createJobId: (() => {
          const ids = ['job-1', 'job-2'];
          let index = 0;
          return () => ids[index++] ?? `job-${index}`;
        })(),
        defaultProvider: 'codex',
      });
      const revisedPlan = replacePlanSlot(declaredPlan, declaredPlan.slots[1].slotId, {
        jobId: 'job-2b',
        continuityRef: 'session-2b',
      });

      const appended = appendEvents(
        db,
        [
          workflowPlanDeclaredEvent('workflow-1', declaredPlan),
          workflowDrainEnteredEvent('workflow-1', {
            firstFailureSlotId: declaredPlan.slots[1].slotId,
            drainDeadline: Date.parse('2026-04-19T00:00:15.000Z'),
          }),
          workflowPlanRevisedEvent('workflow-1', revisedPlan),
          workflowCompletedEvent('workflow-1', { outcome: 'failed' }),
        ],
        { now: () => NOW, reducers, upcasters },
      );

      const before = db.prepare(
        `SELECT workflow_id, plan, last_seq
           FROM projection_workflows
          WHERE workflow_id = ?
          LIMIT 1`,
      ).get('workflow-1');

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

      const after = db.prepare(
        `SELECT workflow_id, plan, last_seq
           FROM projection_workflows
          WHERE workflow_id = ?
          LIMIT 1`,
      ).get('workflow-1');

      expect(after).toStrictEqual(before);
    } finally {
      db.close();
    }
  });
});
