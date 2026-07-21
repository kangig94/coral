import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commit, type AppendContext } from '#src/store/append.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import type { WorkflowPlan } from '#src/workflow/plan.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';

// M3: a workflow stream owns exactly one declared plan (spec §6.5 line 1006).
// The append validator rejects a second `workflow.plan.declared` so the second
// plan never overwrites the first via `upsertProjectionWorkflow`.

const NOW = new Date('2026-04-19T00:00:00.000Z');

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  return db;
}

function ctx(): AppendContext {
  return {
    now: () => NOW,
    reducers: composeReducers(workflowRegistry),
    bodyCodec: createEventBodyCodec(),
    providers: permissiveProviderLookupPort,
  };
}

function plan(slotIds: readonly string[]): WorkflowPlan {
  return {
    slots: slotIds.map((slotId) => ({
      slotId,
      dependencies: [],
      provider: 'codex',
      instruction: `step-${slotId}`,
    })),
  };
}

describe('workflow.plan.declared duplicate validator (M3)', () => {
  it('rejects a second declaration on a stream that already has one', () => {
    const db = createDb();
    try {
      commit(
        db,
        (c) => {
          c.append(workflowPlanDeclaredEvent('workflow-1', plan(['workflow-1:0:0']), TEST_PROVIDER_SCOPE));
          return undefined;
        },
        ctx(),
      );

      expect(() =>
        commit(
          db,
          (c) => {
            c.append(workflowPlanDeclaredEvent('workflow-1', plan(['workflow-1:0:1']), TEST_PROVIDER_SCOPE));
            return undefined;
          },
          ctx(),
        ),
      ).toThrow(/workflow_plan_declared_duplicate|already present/);

      // The original plan must still be the one stored.
      const row = db.prepare(`SELECT plan FROM projection_workflows WHERE workflow_id = ?`).get('workflow-1') as {
        plan: string;
      };
      expect(JSON.parse(row.plan)).toEqual(plan(['workflow-1:0:0']));
    } finally {
      db.close();
    }
  });

  it('rejects two declarations in the same commit batch', () => {
    const db = createDb();
    try {
      expect(() =>
        commit(
          db,
          (c) => {
            c.append(workflowPlanDeclaredEvent('workflow-2', plan(['workflow-2:0:0']), TEST_PROVIDER_SCOPE));
            c.append(workflowPlanDeclaredEvent('workflow-2', plan(['workflow-2:0:1']), TEST_PROVIDER_SCOPE));
            return undefined;
          },
          ctx(),
        ),
      ).toThrow(/workflow_plan_declared_duplicate|already present/);

      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE stream_kind = 'workflow' AND stream_id = ?`)
        .get('workflow-2') as { n: number };
      expect(count.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('allows one declaration per distinct workflow id in the same batch', () => {
    const db = createDb();
    try {
      const appended = commit(
        db,
        (c) => {
          c.append(workflowPlanDeclaredEvent('workflow-a', plan(['workflow-a:0:0']), TEST_PROVIDER_SCOPE));
          c.append(workflowPlanDeclaredEvent('workflow-b', plan(['workflow-b:0:0']), TEST_PROVIDER_SCOPE));
          return undefined;
        },
        ctx(),
      );

      expect(appended.map((event) => event.stream.id)).toEqual(['workflow-a', 'workflow-b']);
    } finally {
      db.close();
    }
  });
});
