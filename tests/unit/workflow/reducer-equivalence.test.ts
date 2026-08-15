import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import { parseExpression } from '#src/workflow/parser.js';
import {
  workflowCompletedEvent,
  workflowDrainEnteredEvent,
  workflowPlanDeclaredEvent,
  workflowRegistry,
} from '#src/workflow/events.js';
import { buildWorkflowPlan, compileWorkflowPlan } from '#src/workflow/plan.js';
import { readWorkflowView } from '#src/workflow/read-queries.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_CODEX_BINDING, TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import type { JobLaunchRequestBody } from '#src/jobs/launch.js';
import type { CauseRef } from '#src/causality/cause-ref.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const NOW = new Date('2026-04-19T00:00:00.000Z');

function workflowRootLaunch(workflowId: string): CoralEventInput<JobLaunchRequestBody> {
  return {
    type: 'job.launch.requested',
    stream: { kind: 'job', id: workflowId },
    refs: { jobId: workflowId, workflowId },
    body: {
      owner: { kind: 'workflow', id: workflowId },
      projectRoot: fixtureCanonicalWorkDir('/workspace/coral'),
      backendNamespace: 'tests',
      jobKind: 'workflow',
      pool: 'default',
      enqueueSequence: 0,
      request: {
        prompt: 'test workflow',
        cwd: fixtureCanonicalWorkDir('/workspace/coral'),
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: NOW.toISOString(),
    },
  };
}

function failedWorkflowRootTerminal(workflowId: string, causeRef: CauseRef): CoralEventInput {
  return {
    type: 'job.terminal.recorded',
    stream: { kind: 'job', id: workflowId },
    refs: { jobId: workflowId, workflowId },
    body: {
      terminal: { outcome: { kind: 'failed', causeRef }, durationMs: 1, content: '' },
    },
  };
}

function providerSessionInputs(sessionId: string, jobId: string): CoralEventInput[] {
  const opened: ProviderSession = {
    sessionId,
    binding: TEST_CODEX_BINDING,
    name: sessionId,
    state: 'pending',
    retention: 'retain',
    artifactHandles: [],
    retentionDiscard: { attempts: [] },
    providerContinuity: null,
    cwd: '/workspace/coral',
    projectRoot: '/workspace/coral',
    backendNamespace: 'tests',
    createdAt: NOW.toISOString(),
    lastUsedAt: NOW.toISOString(),
    version: 1,
  };
  const claimed: ProviderSession = { ...opened, activeJobId: jobId, version: 2 };
  return [
    {
      type: 'session.opened',
      stream: { kind: 'session', id: sessionId },
      refs: { sessionId },
      body: { entry: opened, controller: 'default', scope_key: `${sessionId}-scope` },
    },
    {
      type: 'session.claimed',
      stream: { kind: 'session', id: sessionId },
      refs: { sessionId, jobId },
      body: { entry: claimed, jobId },
    },
  ];
}

describe('workflow reducer equivalence', () => {
  it('rebuilds projection_workflows.plan rows byte-identically from workflow domain events', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(jobsRegistry, workflowRegistry);
      const bodyCodec = createEventBodyCodec();

      const declaredPlan = buildWorkflowPlan('workflow-1', parseExpression('architect -> resolver'), {
        defaultProvider: 'codex',
      });

      const appended = commitInputs(
        db,
        [
          workflowPlanDeclaredEvent('workflow-1', declaredPlan, TEST_PROVIDER_SCOPE),
          workflowRootLaunch('workflow-1'),
          // drain.entered is projection-only state: replay must preserve the drain window
          // without reviving the deleted workflow checkpoint persistence layer.
          workflowDrainEnteredEvent('workflow-1', {
            firstFailureSlotId: declaredPlan.slots[1].slotId,
            drainDeadline: Date.parse('2026-04-19T00:00:15.000Z'),
          }),
          workflowCompletedEvent('workflow-1', {
            outcome: 'failed',
            causeRef: { stream: { kind: 'workflow', id: 'workflow-1' }, seq: 3 },
            stepDetails: [],
          }),
          failedWorkflowRootTerminal('workflow-1', {
            stream: { kind: 'workflow', id: 'workflow-1' },
            seq: 4,
          }),
        ],
        { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
      );

      const before = db
        .prepare(
          `SELECT workflow_id, plan, last_seq
           FROM projection_workflows
          WHERE workflow_id = ?
          LIMIT 1`,
        )
        .get('workflow-1');

      expect(before).toEqual({
        workflow_id: 'workflow-1',
        plan: JSON.stringify(declaredPlan),
        last_seq: appended.find((event) => event.type === 'workflow.completed')?.seq,
      });

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        bodyCodec,
      });

      const after = db
        .prepare(
          `SELECT workflow_id, plan, last_seq
           FROM projection_workflows
          WHERE workflow_id = ?
          LIMIT 1`,
        )
        .get('workflow-1');

      expect(after).toStrictEqual(before);
    } finally {
      db.close();
    }
  });

  it('builds WorkflowView slot outcomes from child job projections', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry);
      const bodyCodec = createEventBodyCodec();
      const plan = buildWorkflowPlan('workflow-1', parseExpression('architect -> resolver'), {
        defaultProvider: 'codex',
      });
      const plannedSlots = compileWorkflowPlan(plan, {
        jobIds: new Map([
          [plan.slots[0].slotId, 'job-1'],
          [plan.slots[1].slotId, 'job-2'],
        ]),
      });
      const causeRef = { stream: { kind: 'workflow' as const, id: 'workflow-1' }, seq: 1 };
      commitInputs(
        db,
        [
          workflowPlanDeclaredEvent('workflow-1', plan, TEST_PROVIDER_SCOPE),
          workflowRootLaunch('workflow-1'),
          ...plannedSlots.flatMap((slot) => [
            ...providerSessionInputs(`session-${slot.jobId}`, slot.jobId),
            {
              type: 'job.launch.requested' as const,
              stream: { kind: 'job' as const, id: slot.jobId },
              refs: {
                sessionId: `session-${slot.jobId}`,
                parentJobId: 'workflow-1',
                workflowId: 'workflow-1',
                workflowSlotId: slot.slotId,
              },
              body: {
                owner: { kind: 'workflow' as const, id: 'workflow-1' },
                sessionId: `session-${slot.jobId}`,
                provider: slot.provider,
                providerAction: 'exec' as const,
                projectRoot: '/workspace/coral',
                backendNamespace: 'tests',
                jobKind: 'provider' as const,
                workflowSlotGeneration: 0,
                pool: 'default',
                enqueueSequence: slot.stepIndex + 1,
                request: {
                  prompt: slot.instruction,
                  cwd: '/workspace/coral',
                  bypassPermissions: false,
                  coralEnv: {},
                },
                createdAt: '2026-04-19T00:00:00.000Z',
              },
            },
          ]),
        ],
        { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
      );

      commitInputs(
        db,
        [
          {
            type: 'job.terminal.recorded',
            stream: { kind: 'job' as const, id: 'job-1' },
            refs: { sessionId: 'session-job-1', parentJobId: 'workflow-1', workflowSlotId: plan.slots[0].slotId },
            body: {
              terminal: {
                outcome: { kind: 'completed' as const },
                durationMs: 1,
                content: 'done',
              },
            },
          },
          {
            type: 'job.terminal.recorded',
            stream: { kind: 'job' as const, id: 'job-2' },
            refs: { sessionId: 'session-job-2', parentJobId: 'workflow-1', workflowSlotId: plan.slots[1].slotId },
            body: {
              terminal: {
                outcome: { kind: 'failed' as const, causeRef },
                durationMs: 2,
                content: '',
              },
            },
          },
          workflowCompletedEvent('workflow-1', { outcome: 'failed', causeRef, stepDetails: [] }),
          failedWorkflowRootTerminal('workflow-1', causeRef),
        ],
        { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
      );

      expect(
        readWorkflowView(db, 'workflow-1', {
          schemas: reducers.schemas,
          streamKinds: reducers.streamKinds,
          bodyCodec,
        }),
      ).toMatchObject({
        workflowId: 'workflow-1',
        outcome: 'failed',
        causeRef,
        slotOutcomes: {
          [plan.slots[0].slotId]: { jobId: 'job-1', phase: 'completed', causeRef: null },
          [plan.slots[1].slotId]: { jobId: 'job-2', phase: 'error', causeRef },
        },
      });
    } finally {
      db.close();
    }
  });
});
