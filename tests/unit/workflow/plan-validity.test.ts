import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import type { JobLaunchRequestBody } from '#src/jobs/launch.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { ProviderLookupPort } from '#src/providers/catalog.js';
import { CoralAppendError } from '#src/store/append-error.js';
import { commit, type AppendContext } from '#src/store/append.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import type { PlanSlot, WorkflowPlan } from '#src/workflow/plan.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const NOW = new Date('2026-04-30T00:00:00.000Z');

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function providers(names: readonly string[]): ProviderLookupPort {
  const known = new Set(names);
  return {
    hasProvider: (name) => known.has(name),
    validatePersistedBinding: () => ({ ok: true }),
    validatePersistedScope: () => ({ ok: true }),
  };
}

function ctx(knownProviders: readonly string[] = ['codex']): AppendContext {
  return {
    now: () => NOW,
    reducers: composeReducers(jobsRegistry, workflowRegistry),
    bodyCodec: createEventBodyCodec(),
    providers: providers(knownProviders),
  };
}

function slot(workflowId: string, stepIndex: number, atomIndex: number, patch: Partial<PlanSlot> = {}): PlanSlot {
  const slotId = `${workflowId}:${stepIndex}:${atomIndex}`;
  return {
    slotId,
    dependencies: [],
    provider: 'codex',
    instruction: `step ${stepIndex}.${atomIndex}`,
    ...patch,
  };
}

function plan(slots: readonly PlanSlot[]): WorkflowPlan {
  return { slots: [...slots] };
}

function launchInput(workflowId: string, slotId: string) {
  const jobId = `${slotId}:job`;
  const sessionId = `${jobId}:session`;
  const body: JobLaunchRequestBody = {
    owner: { kind: 'workflow', id: workflowId },
    sessionId,
    provider: 'codex',
    providerAction: 'exec',
    projectRoot: fixtureCanonicalWorkDir('/workspace/coral'),
    backendNamespace: 'tests',
    jobKind: 'provider',
    workflowSlotGeneration: 0,
    pool: 'default',
    enqueueSequence: 1,
    request: {
      prompt: 'run slot',
      cwd: fixtureCanonicalWorkDir('/workspace/coral'),
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: NOW.toISOString(),
  };

  return {
    type: 'job.launch.requested' as const,
    stream: { kind: 'job' as const, id: jobId },
    refs: { jobId, sessionId, parentJobId: workflowId, workflowId, workflowSlotId: slotId },
    body,
  };
}

function expectWorkflowPlanInvalid(run: () => unknown, reason: string): CoralAppendError {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CoralAppendError);
    const appendError = error as CoralAppendError;
    expect(appendError.code).toBe('workflow_plan_invalid');
    expect(appendError.detail).toMatchObject({ reason });
    return appendError;
  }

  throw new Error(`Expected workflow_plan_invalid ${reason}`);
}

function eventCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
}

describe('workflow plan validity append validator', () => {
  it('rejects duplicate slot ids without writing an event', () => {
    const db = createDb();
    try {
      const duplicate = slot('wf-duplicate', 0, 0);

      const error = expectWorkflowPlanInvalid(
        () =>
          commit(
            db,
            (c) => {
              c.append(
                workflowPlanDeclaredEvent('wf-duplicate', plan([duplicate, { ...duplicate }]), TEST_PROVIDER_SCOPE),
              );
              return undefined;
            },
            ctx(),
          ),
        'duplicate_slot',
      );

      expect(error.detail).toMatchObject({ workflowId: 'wf-duplicate', slotId: 'wf-duplicate:0:0' });
      expect(eventCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects dependency cycles without writing an event', () => {
    const db = createDb();
    try {
      const first = slot('wf-cycle', 0, 0, { dependencies: ['wf-cycle:1:0'] });
      const second = slot('wf-cycle', 1, 0, { dependencies: ['wf-cycle:0:0'] });

      const error = expectWorkflowPlanInvalid(
        () =>
          commit(
            db,
            (c) => {
              c.append(workflowPlanDeclaredEvent('wf-cycle', plan([first, second]), TEST_PROVIDER_SCOPE));
              return undefined;
            },
            ctx(),
          ),
        'cycle',
      );

      expect(error.detail.cycle).toEqual(['wf-cycle:0:0', 'wf-cycle:1:0', 'wf-cycle:0:0']);
      expect(eventCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects empty plans without writing an event', () => {
    const db = createDb();
    try {
      expectWorkflowPlanInvalid(
        () =>
          commit(
            db,
            (c) => {
              c.append(workflowPlanDeclaredEvent('wf-empty', { slots: [] }, TEST_PROVIDER_SCOPE));
              return undefined;
            },
            ctx(),
          ),
        'empty_plan',
      );

      expect(eventCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects slot ids whose workflow prefix is not bound to the stream id', () => {
    const db = createDb();
    try {
      expectWorkflowPlanInvalid(
        () =>
          commit(
            db,
            (c) => {
              c.append(
                workflowPlanDeclaredEvent('wf-bound', plan([slot('other-workflow', 0, 0)]), TEST_PROVIDER_SCOPE),
              );
              return undefined;
            },
            ctx(),
          ),
        'slot_id_format',
      );

      expect(eventCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects workflowSlotId refs that are absent from the declared plan', () => {
    const db = createDb();
    try {
      commit(
        db,
        (c) => {
          c.append(workflowPlanDeclaredEvent('wf-ref', plan([slot('wf-ref', 0, 0)]), TEST_PROVIDER_SCOPE));
          return undefined;
        },
        ctx(),
      );
      seedTestSessionProjection(db, {
        sessionId: 'wf-ref:0:1:job:session',
        provider: 'codex',
        projectRoot: '/workspace/coral',
        activeJobId: 'wf-ref:0:1:job',
      });

      expectWorkflowPlanInvalid(
        () =>
          commit(
            db,
            (c) => {
              c.append(launchInput('wf-ref', 'wf-ref:0:1'));
              return undefined;
            },
            ctx(),
          ),
        'unknown_slot',
      );

      expect(eventCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rejects unknown providers without writing an event', () => {
    const db = createDb();
    try {
      expectWorkflowPlanInvalid(
        () =>
          commit(
            db,
            (c) => {
              c.append(
                workflowPlanDeclaredEvent(
                  'wf-provider',
                  plan([slot('wf-provider', 0, 0, { provider: 'missing-provider' })]),
                  TEST_PROVIDER_SCOPE,
                ),
              );
              return undefined;
            },
            ctx(['codex']),
          ),
        'unknown_provider',
      );

      expect(eventCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects a persisted provider scope that is not exactly complete for the plan', () => {
    const db = createDb();
    try {
      const appendContext = ctx();
      expectWorkflowPlanInvalid(
        () =>
          commit(
            db,
            (c) => {
              c.append(workflowPlanDeclaredEvent('wf-scope', plan([slot('wf-scope', 0, 0)]), TEST_PROVIDER_SCOPE));
              return undefined;
            },
            {
              ...appendContext,
              providers: {
                ...appendContext.providers,
                validatePersistedScope: () => ({ ok: false, message: 'scope contains an undeclared profile' }),
              },
            },
          ),
        'provider_mismatch',
      );
      expect(eventCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('accepts a valid plan and later child launch referencing a declared slot', () => {
    const db = createDb();
    try {
      const workflowId = 'wf:happy';
      const slotId = `${workflowId}:0:0`;

      commit(
        db,
        (c) => {
          c.append(workflowPlanDeclaredEvent(workflowId, plan([slot(workflowId, 0, 0)]), TEST_PROVIDER_SCOPE));
          return undefined;
        },
        ctx(),
      );
      seedTestSessionProjection(db, {
        sessionId: `${slotId}:job:session`,
        provider: 'codex',
        projectRoot: '/workspace/coral',
        activeJobId: `${slotId}:job`,
      });

      const appended = commit(
        db,
        (c) => {
          c.append(launchInput(workflowId, slotId));
          return undefined;
        },
        ctx(),
      );

      expect(appended).toHaveLength(1);
      expect(eventCount(db)).toBe(2);
    } finally {
      db.close();
    }
  });
});
