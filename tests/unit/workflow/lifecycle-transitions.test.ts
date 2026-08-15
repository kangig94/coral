import { currentCoralStoreFormat } from '#src/store-format.js';
import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema } from '#src/store/db.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { applyReducer, composeReducers, type ComposedReducers } from '#src/store/reducers.js';
import {
  workflowCompletedEvent,
  workflowDrainEnteredEvent,
  workflowLifecycleFaultEvent,
  workflowPlanDeclaredEvent,
  workflowRegistry,
} from '#src/workflow/events.js';
import { readWorkflowProjection } from '#src/workflow/read-queries.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const NOW = new Date('2026-07-22T00:00:00.000Z');

function reduceWorkflowEvent(
  db: Parameters<typeof applyReducer>[0],
  reducers: ComposedReducers,
  seq: number,
  input: CoralEventInput,
): void {
  applyReducer(db, { ...input, seq, ts: NOW.toISOString() }, reducers);
}

function declaration(workflowId: string) {
  return workflowPlanDeclaredEvent(
    workflowId,
    {
      slots: [
        {
          slotId: `${workflowId}:0:0`,
          dependencies: [],
          provider: 'codex',
          instruction: 'test',
        },
      ],
    },
    TEST_PROVIDER_SCOPE,
  );
}

describe('workflow lifecycle transitions', () => {
  it('projects declaration as active and permits only failed completion after a lifecycle fault', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(workflowRegistry);
      reduceWorkflowEvent(db, reducers, 1, declaration('workflow-fault'));
      reduceWorkflowEvent(
        db,
        reducers,
        2,
        workflowLifecycleFaultEvent('workflow-fault', { kind: 'unknown', message: 'failed' }),
      );
      reduceWorkflowEvent(
        db,
        reducers,
        3,
        workflowCompletedEvent('workflow-fault', {
          outcome: 'failed',
          causeRef: { stream: { kind: 'workflow', id: 'workflow-fault' }, seq: 2 },
          stepDetails: [],
        }),
      );
      expect(readWorkflowProjection(db, 'workflow-fault')?.lifecycle).toBe('failed');
    } finally {
      db.close();
    }
  });

  it('rejects drain and fault transitions after completion', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(workflowRegistry);
      reduceWorkflowEvent(db, reducers, 1, declaration('workflow-terminal'));
      reduceWorkflowEvent(
        db,
        reducers,
        2,
        workflowCompletedEvent('workflow-terminal', { outcome: 'completed', stepDetails: [] }),
      );

      expect(() =>
        reduceWorkflowEvent(
          db,
          reducers,
          3,
          workflowDrainEnteredEvent('workflow-terminal', {
            firstFailureSlotId: 'workflow-terminal:0:0',
            drainDeadline: 1,
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'workflow_lifecycle_invalid' }));
      expect(() =>
        reduceWorkflowEvent(
          db,
          reducers,
          3,
          workflowLifecycleFaultEvent('workflow-terminal', { kind: 'unknown', message: 'late' }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'workflow_lifecycle_invalid' }));
    } finally {
      db.close();
    }
  });

  it('projects drain entry as draining and rejects re-entry', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(workflowRegistry);
      reduceWorkflowEvent(db, reducers, 1, declaration('workflow-drain'));
      reduceWorkflowEvent(
        db,
        reducers,
        2,
        workflowDrainEnteredEvent('workflow-drain', {
          firstFailureSlotId: 'workflow-drain:0:0',
          drainDeadline: 1,
        }),
      );
      expect(readWorkflowProjection(db, 'workflow-drain')?.lifecycle).toBe('draining');
      expect(() =>
        reduceWorkflowEvent(
          db,
          reducers,
          3,
          workflowDrainEnteredEvent('workflow-drain', {
            firstFailureSlotId: 'workflow-drain:0:0',
            drainDeadline: 2,
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'workflow_lifecycle_invalid' }));
    } finally {
      db.close();
    }
  });

  it('rejects a completion outcome that contradicts an earlier lifecycle fault', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(workflowRegistry);
      reduceWorkflowEvent(db, reducers, 1, declaration('workflow-contradiction'));
      reduceWorkflowEvent(
        db,
        reducers,
        2,
        workflowLifecycleFaultEvent('workflow-contradiction', { kind: 'unknown', message: 'failed' }),
      );
      expect(() =>
        reduceWorkflowEvent(
          db,
          reducers,
          3,
          workflowCompletedEvent('workflow-contradiction', { outcome: 'completed', stepDetails: [] }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'workflow_lifecycle_invalid' }));
      expect(readWorkflowProjection(db, 'workflow-contradiction')?.lifecycle).toBe('faulted');
    } finally {
      db.close();
    }
  });

  it('applies the same monotonic guard while reducers replay projection events', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(workflowRegistry);
      reduceWorkflowEvent(db, reducers, 1, declaration('workflow-rebuild'));
      reduceWorkflowEvent(
        db,
        reducers,
        2,
        workflowCompletedEvent('workflow-rebuild', { outcome: 'aborted', stepDetails: [] }),
      );

      expect(() =>
        applyReducer(
          db,
          {
            seq: 3,
            ts: NOW.toISOString(),
            type: 'workflow.drain.entered',
            stream: { kind: 'workflow', id: 'workflow-rebuild' },
            refs: { workflowId: 'workflow-rebuild' },
            body: { firstFailureSlotId: 'workflow-rebuild:0:0', drainDeadline: 1 },
          },
          reducers,
        ),
      ).toThrowError(expect.objectContaining({ code: 'workflow_lifecycle_invalid' }));
      expect(readWorkflowProjection(db, 'workflow-rebuild')?.lifecycle).toBe('aborted');
    } finally {
      db.close();
    }
  });
});
