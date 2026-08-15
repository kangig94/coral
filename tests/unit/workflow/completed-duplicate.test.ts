import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commit, type AppendContext, type CommitContext } from '#src/store/append.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { workflowCompletedEvent, workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { JobLaunchRequestBody } from '#src/jobs/launch.js';
import { appendJobTerminalRecorded } from '#src/jobs/terminal/recording.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import type { WorkflowPlan } from '#src/workflow/plan.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';

// Spec §6.5: workflow stream identity is the truth — a workflow has exactly
// one completion. The append validator rejects a second `workflow.completed`
// so the second terminal never overwrites the first via
// `upsertProjectionWorkflow`.

const NOW = new Date('2026-04-19T00:00:00.000Z');

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function ctx(): AppendContext {
  return {
    now: () => NOW,
    reducers: composeReducers(workflowRegistry, jobsRegistry),
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

function workflowRootLaunch(workflowId: string): CoralEventInput<JobLaunchRequestBody> {
  return {
    type: 'job.launch.requested',
    stream: { kind: 'job', id: workflowId },
    refs: { jobId: workflowId, workflowId },
    body: {
      owner: { kind: 'workflow', id: workflowId },
      projectRoot: fixtureCanonicalWorkDir('/workspace'),
      backendNamespace: 'tests',
      jobKind: 'workflow',
      pool: 'default',
      enqueueSequence: 0,
      request: {
        prompt: 'test workflow',
        cwd: fixtureCanonicalWorkDir('/workspace'),
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: NOW.toISOString(),
    },
  };
}

function appendFinalizationPair<Scope>(
  c: CommitContext<Scope>,
  workflowId: string,
  outcome: 'completed' | 'aborted',
): void {
  c.append(workflowCompletedEvent(workflowId, { outcome, stepDetails: [] }));
  appendJobTerminalRecorded(c, {
    jobId: workflowId,
    terminal: {
      content: '',
      durationMs: 1,
      outcome: outcome === 'completed' ? { kind: 'completed' } : { kind: 'aborted', reason: 'signal_abort' },
    },
  });
}

describe('workflow.completed duplicate validator', () => {
  it('rejects a second completion on a stream that already has one', () => {
    const db = createDb();
    try {
      commit(
        db,
        (c) => {
          c.append(workflowPlanDeclaredEvent('workflow-1', plan(['workflow-1:0:0']), TEST_PROVIDER_SCOPE));
          c.append(workflowRootLaunch('workflow-1'));
          appendFinalizationPair(c, 'workflow-1', 'completed');
          return undefined;
        },
        ctx(),
      );

      expect(() =>
        commit(
          db,
          (c) => {
            appendFinalizationPair(c, 'workflow-1', 'aborted');
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
            c.append(workflowPlanDeclaredEvent('workflow-2', plan(['workflow-2:0:0']), TEST_PROVIDER_SCOPE));
            c.append(workflowRootLaunch('workflow-2'));
            appendFinalizationPair(c, 'workflow-2', 'completed');
            appendFinalizationPair(c, 'workflow-2', 'aborted');
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
          c.append(workflowPlanDeclaredEvent('workflow-a', plan(['workflow-a:0:0']), TEST_PROVIDER_SCOPE));
          c.append(workflowPlanDeclaredEvent('workflow-b', plan(['workflow-b:0:0']), TEST_PROVIDER_SCOPE));
          c.append(workflowRootLaunch('workflow-a'));
          c.append(workflowRootLaunch('workflow-b'));
          appendFinalizationPair(c, 'workflow-a', 'completed');
          appendFinalizationPair(c, 'workflow-b', 'aborted');
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
