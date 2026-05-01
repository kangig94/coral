import * as fs from 'node:fs';
import { join } from 'node:path';

import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commit, type AppendContext } from '#src/store/append.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { composeReducers } from '#src/store/reducers.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { workflowCompletedEvent, workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import type { WorkflowPlan } from '#src/workflow/plan.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

// Spec §6.5: workflow stream identity is the truth — a workflow has exactly
// one completion. The append validator rejects a second `workflow.completed`
// so the second terminal never overwrites the first via
// `upsertProjectionWorkflow`.

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const NOW = new Date('2026-04-19T00:00:00.000Z');

const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
  return db;
}

function ctx(): AppendContext {
  return {
    now: () => NOW,
    reducers: composeReducers(workflowRegistry),
    upcasters: createDefaultUpcasterRegistry(),
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

describe('workflow.completed duplicate validator', () => {
  it('rejects a second completion on a stream that already has one', () => {
    const db = createDb();
    try {
      commit(
        db,
        (c) => {
          c.append(workflowPlanDeclaredEvent('workflow-1', plan(['workflow-1:0:0'])));
          c.append(workflowCompletedEvent('workflow-1', { outcome: 'completed', stepDetails: [] }));
          return undefined;
        },
        ctx(),
      );

      expect(() =>
        commit(
          db,
          (c) => {
            c.append(workflowCompletedEvent('workflow-1', { outcome: 'aborted', stepDetails: [] }));
            return undefined;
          },
          ctx(),
        ),
      ).toThrow(/workflow_completed_duplicate|already present/);
    } finally {
      db.close();
    }
  });

  it('rejects two completions in the same commit batch', () => {
    const db = createDb();
    try {
      expect(() =>
        commit(
          db,
          (c) => {
            c.append(workflowPlanDeclaredEvent('workflow-2', plan(['workflow-2:0:0'])));
            c.append(workflowCompletedEvent('workflow-2', { outcome: 'completed', stepDetails: [] }));
            c.append(workflowCompletedEvent('workflow-2', { outcome: 'aborted', stepDetails: [] }));
            return undefined;
          },
          ctx(),
        ),
      ).toThrow(/workflow_completed_duplicate|already present/);
    } finally {
      db.close();
    }
  });

  it('allows one completion per distinct workflow id in the same batch', () => {
    const db = createDb();
    try {
      const appended = commit(
        db,
        (c) => {
          c.append(workflowPlanDeclaredEvent('workflow-a', plan(['workflow-a:0:0'])));
          c.append(workflowPlanDeclaredEvent('workflow-b', plan(['workflow-b:0:0'])));
          c.append(workflowCompletedEvent('workflow-a', { outcome: 'completed', stepDetails: [] }));
          c.append(workflowCompletedEvent('workflow-b', { outcome: 'aborted', stepDetails: [] }));
          return undefined;
        },
        ctx(),
      );

      expect(appended.map((event) => event.type)).toContain('workflow.completed');
    } finally {
      db.close();
    }
  });
});
