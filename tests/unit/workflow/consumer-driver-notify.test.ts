import { readFileSync, readdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { StoragePort } from '#src/runtime/ports.js';
import { commit } from '#src/store/append.js';
import { createDefaultUpcasterRegistry } from '#src/store/envelope.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { composeReducers } from '#src/store/reducers.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { registerJournalProjectionConsumer } from '#src/store/projection-consumer.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { readWorkflowProjection } from '#src/workflow/read-queries.js';
import { createWorkflowJournal } from '#src/workflow/projections.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  return db;
}

describe('workflow consumer-driver notify', () => {
  it('projects the workflow after a coordinator-bound append', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    registerJournalProjectionConsumer(driver, db, 'workflow', workflowRegistry);

    try {
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
      const upcasters = createDefaultUpcasterRegistry();
      const coordinatorCommit = (cb: Parameters<typeof commit>[1]) => {
        const appended = commit(db, cb, {
          now: () => new Date('2026-04-19T00:00:00.000Z'),
          reducers,
          upcasters,
        });
        if (appended.length > 0) {
          driver.notify('journal', appended[appended.length - 1].seq);
        }
      };

      const journal = createWorkflowJournal({ commit: coordinatorCommit });
      journal.commit((c) => {
        c.append(
          workflowPlanDeclaredEvent('workflow-1', {
            slots: [
              {
                slotId: 'workflow-1:0:0',
                dependencies: [],
                provider: 'codex',
                instruction: 'architect',
                agent: 'architect',
              },
            ],
          }),
        );
        return undefined;
      });

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
