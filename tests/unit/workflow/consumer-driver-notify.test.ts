
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commit } from '#src/store/append.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { readWorkflowProjection } from '#src/workflow/read-queries.js';
import { createWorkflowJournal } from '#src/workflow/projections.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  return db;
}

describe('workflow consumer-driver notify', () => {
  it('projects the workflow after a coordinator-bound append', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    // Cursor-only base consumer; commit-time reducer writes projection_workflows.
    driver.register({
      id: 'workflow',
      authority: 'journal',
      kind: 'cursor',
      registrationKind: 'base',
    });

    try {
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
      const upcasters = createDefaultUpcasterRegistry();
      const coordinatorCommit = (cb: Parameters<typeof commit>[1]) => {
        const appended = commit(db, cb, {
          now: () => new Date('2026-04-19T00:00:00.000Z'),
          reducers,
          upcasters,
          providers: permissiveProviderLookupPort,
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
