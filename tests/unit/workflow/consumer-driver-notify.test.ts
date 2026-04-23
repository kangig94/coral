import { readFileSync, readdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { StoragePort } from '#src/runtime/ports.js';
import { appendEvents } from '#src/store/append.js';
import { createEmptyRegistry } from '#src/store/envelope.js';
import { applyMigrations } from '#src/store/migrations.js';
import { composeReducers } from '#src/store/reducers.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import { discussRegistry } from '#src/discuss/store-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { registerWorkflowConsumer } from '#src/workflow/consumer.js';
import { createWorkflowJournal, readWorkflowProjection } from '#src/workflow/projections.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyMigrations({ db, storage: nodeStorage });
  return db;
}

describe('workflow consumer-driver notify', () => {
  it('projects the workflow after a coordinator-bound append', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    registerWorkflowConsumer(driver, db);

    try {
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
      const upcasters = createEmptyRegistry();
      const coordinatorAppendEvents = (inputs: Parameters<typeof appendEvents>[1]) => {
        const appended = appendEvents(db, inputs, {
          now: () => new Date('2026-04-19T00:00:00.000Z'),
          reducers,
          upcasters,
        });
        if (appended.length > 0) {
          driver.notify('journal', appended[appended.length - 1].seq);
        }
      };

      const journal = createWorkflowJournal({ appendEvents: coordinatorAppendEvents });
      journal.append([
        workflowPlanDeclaredEvent('workflow-1', {
          workflowId: 'workflow-1',
          slots: [
            {
              slotId: 'workflow-1:0:0',
              jobId: 'job-1',
              stepIndex: 0,
              tagName: 'architect',
              atomKey: '0:0',
              label: 'architect',
              provider: 'codex',
              instruction: 'architect',
            },
          ],
        }),
      ]);

      await driver.drainAll();
      expect(readWorkflowProjection(db, 'workflow-1')).toMatchObject({
        workflowId: 'workflow-1',
        lastSeq: 1,
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });
});
