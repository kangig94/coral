import { currentCoralStoreFormat } from '#src/store-format.js';
import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema } from '#src/store/db.js';
import { commit, type AppendContext } from '#src/store/append.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { applyReducer, composeReducers } from '#src/store/reducers.js';
import {
  workflowCompletedEvent,
  workflowDrainEnteredEvent,
  workflowLifecycleFaultEvent,
  workflowPlanDeclaredEvent,
  workflowRegistry,
} from '#src/workflow/events.js';
import { readWorkflowProjection } from '#src/workflow/read-queries.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const NOW = new Date('2026-07-22T00:00:00.000Z');

function context(): AppendContext {
  return {
    now: () => NOW,
    reducers: composeReducers(workflowRegistry),
    bodyCodec: createEventBodyCodec(),
    providers: permissiveProviderLookupPort,
  };
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
      commit(
        db,
        (c) => {
          c.append(declaration('workflow-fault'));
          c.append(workflowLifecycleFaultEvent('workflow-fault', { kind: 'unknown', message: 'failed' }));
          c.append(
            workflowCompletedEvent('workflow-fault', {
              outcome: 'failed',
              causeRef: { stream: { kind: 'workflow', id: 'workflow-fault' }, seq: 2 },
              stepDetails: [],
            }),
          );
          return undefined;
        },
        context(),
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
      commit(
        db,
        (c) => {
          c.append(declaration('workflow-terminal'));
          c.append(workflowCompletedEvent('workflow-terminal', { outcome: 'completed', stepDetails: [] }));
          return undefined;
        },
        context(),
      );

      expect(() =>
        commit(
          db,
          (c) => {
            c.append(
              workflowDrainEnteredEvent('workflow-terminal', {
                firstFailureSlotId: 'workflow-terminal:0:0',
                drainDeadline: 1,
              }),
            );
            return undefined;
          },
          context(),
        ),
      ).toThrowError(expect.objectContaining({ code: 'workflow_lifecycle_invalid' }));
      expect(() =>
        commit(
          db,
          (c) => {
            c.append(workflowLifecycleFaultEvent('workflow-terminal', { kind: 'unknown', message: 'late' }));
            return undefined;
          },
          context(),
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
      commit(
        db,
        (c) => {
          c.append(declaration('workflow-drain'));
          c.append(
            workflowDrainEnteredEvent('workflow-drain', {
              firstFailureSlotId: 'workflow-drain:0:0',
              drainDeadline: 1,
            }),
          );
          return undefined;
        },
        context(),
      );
      expect(readWorkflowProjection(db, 'workflow-drain')?.lifecycle).toBe('draining');
      expect(() =>
        commit(
          db,
          (c) => {
            c.append(
              workflowDrainEnteredEvent('workflow-drain', {
                firstFailureSlotId: 'workflow-drain:0:0',
                drainDeadline: 2,
              }),
            );
            return undefined;
          },
          context(),
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
      expect(() =>
        commit(
          db,
          (c) => {
            c.append(declaration('workflow-contradiction'));
            c.append(workflowLifecycleFaultEvent('workflow-contradiction', { kind: 'unknown', message: 'failed' }));
            c.append(workflowCompletedEvent('workflow-contradiction', { outcome: 'completed', stepDetails: [] }));
            return undefined;
          },
          context(),
        ),
      ).toThrowError(expect.objectContaining({ code: 'workflow_lifecycle_invalid' }));
      expect(readWorkflowProjection(db, 'workflow-contradiction')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('applies the same monotonic guard while reducers replay projection events', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(workflowRegistry);
      commit(
        db,
        (c) => {
          c.append(declaration('workflow-rebuild'));
          c.append(workflowCompletedEvent('workflow-rebuild', { outcome: 'aborted', stepDetails: [] }));
          return undefined;
        },
        context(),
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
