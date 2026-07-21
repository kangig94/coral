import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { workflowDrainEnteredEvent, workflowRegistry } from '#src/workflow/events.js';
import { listWorkflowProjections, readWorkflowProjection } from '#src/workflow/read-queries.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

describe('workflow lifecycle projection codec', () => {
  it('rejects lifecycle text outside the shared strict schema on singular and list reads', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db);
      db.prepare(
        `INSERT INTO projection_workflows (workflow_id, plan, provider_scope, lifecycle, last_seq)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('workflow-invalid', JSON.stringify({ slots: [] }), JSON.stringify(TEST_PROVIDER_SCOPE), 'complete', 1);

      expect(() => readWorkflowProjection(db, 'workflow-invalid')).toThrow();
      expect(() => listWorkflowProjections(db)).toThrow();
      expect(() =>
        commitInputs(
          db,
          [
            workflowDrainEnteredEvent('workflow-invalid', {
              firstFailureSlotId: 'workflow-invalid:0:0',
              drainDeadline: 1,
            }),
          ],
          {
            now: () => new Date('2026-07-22T00:00:00.000Z'),
            reducers: composeReducers(workflowRegistry),
            bodyCodec: createEventBodyCodec(),
            providers: permissiveProviderLookupPort,
          },
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
