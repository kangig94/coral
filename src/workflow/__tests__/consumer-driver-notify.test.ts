import { readFileSync, readdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { StoragePort } from '../../runtime/ports.js';
import { appendEvents } from '../../store/append.js';
import { createEmptyRegistry } from '../../store/envelope.js';
import { applyMigrations } from '../../store/migrations.js';
import { composeReducers } from '../../store/reducers.js';
import { ConsumerDriver } from '../../coordinator/consumer-driver.js';
import { discussRegistry } from '../../discuss/store-registry.js';
import { jobsRegistry } from '../../jobs/events.js';
import { sessionsRegistry } from '../../sessions/events.js';
import { registerWorkflowConsumer } from '../consumer.js';
import { createWorkflowJournal, readWorkflowProjection } from '../projections.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '../events.js';

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
  it('notifies the registered workflow consumer exactly once for a coordinator-bound append', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    const notifySpy = vi.spyOn(driver, 'notify');
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

      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(notifySpy).toHaveBeenCalledWith('journal', 1);

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
