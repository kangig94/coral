import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { parseExpression } from '#src/workflow/parser.js';
import { workflowCompletedEvent, workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { buildWorkflowPlan, compileWorkflowPlan } from '#src/workflow/plan.js';
import { readWorkflowView } from '#src/workflow/read-queries.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_CODEX_BINDING, TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const NOW = new Date('2026-04-19T00:00:00.000Z');

describe('workflow reducer equivalence', () => {
  it('builds WorkflowView slot outcomes from child job projections', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(jobsRegistry, workflowRegistry);
      const bodyCodec = createEventBodyCodec();
      const plan = buildWorkflowPlan('workflow-1', parseExpression('architect -> resolver'), {
        defaultProvider: 'codex',
      });
      const plannedSlots = compileWorkflowPlan(plan, {
        jobIds: new Map([
          [plan.slots[0].slotId, '30000000-0000-4000-8000-000000000003'],
          [plan.slots[1].slotId, '30000000-0000-4000-8000-000000000004'],
        ]),
      });
      const causeRef = { stream: { kind: 'workflow' as const, id: 'workflow-1' }, seq: 1 };
      commitInputs(
        db,
        [
          workflowPlanDeclaredEvent('workflow-1', plan, TEST_PROVIDER_SCOPE),
          ...plannedSlots.flatMap((slot) => {
            const metadata = {
              stream: { kind: 'job' as const, id: slot.jobId },
              refs: {
                jobId: slot.jobId,
                parentJobId: 'workflow-1',
                workflowId: 'workflow-1',
                workflowSlotId: slot.slotId,
              },
            };
            return [
              {
                ...metadata,
                type: 'job.opened',
                body: {
                  owner: { kind: 'workflow' as const, id: 'workflow-1' },
                  projectRoot: '/workspace/coral',
                  jobKind: 'provider' as const,
                  workflowSlotId: slot.slotId,
                  conversation: {
                    provider: slot.provider,
                    binding: TEST_CODEX_BINDING,
                    name: slot.jobId,
                    cwd: fixtureCanonicalWorkDir('/workspace/coral'),
                    bypassPermissions: false,
                    retention: 'retain' as const,
                  },
                  createdAt: NOW.toISOString(),
                },
              },
              {
                ...metadata,
                type: 'job.execution.requested',
                body: {
                  execution: 1,
                  input: slot.instruction,
                  action: 'exec',
                  pool: 'default',
                  enqueueSequence: slot.stepIndex + 1,
                  coralEnv: {},
                  backendNamespace: 'tests',
                  createdAt: NOW.toISOString(),
                },
              },
            ];
          }),
        ],
        { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
      );

      for (const [index, slot] of plannedSlots.entries()) {
        const accepted = commitInputs(
          db,
          [
            {
              type: 'job.execution.outcome.accepted',
              stream: { kind: 'job', id: slot.jobId },
              refs: { jobId: slot.jobId, parentJobId: 'workflow-1', workflowSlotId: slot.slotId },
              body: {
                execution: 1,
                terminal: {
                  outcome: index === 0 ? { kind: 'completed' } : { kind: 'failed', causeRef },
                  durationMs: index + 1,
                  content: index === 0 ? 'done' : '',
                },
              },
            },
          ],
          { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
        )[0];
        commitInputs(
          db,
          [
            {
              type: 'job.execution.ended',
              stream: { kind: 'job', id: slot.jobId },
              refs: { jobId: slot.jobId },
              body: { execution: 1, causeRef: { stream: { kind: 'job', id: slot.jobId }, seq: accepted.seq } },
            },
          ],
          { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
        );
      }
      commitInputs(db, [workflowCompletedEvent('workflow-1', { outcome: 'failed', causeRef, stepDetails: [] })], {
        now: () => NOW,
        reducers,
        bodyCodec,
        providers: permissiveProviderLookupPort,
      });

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
          [plan.slots[0].slotId]: { jobId: '30000000-0000-4000-8000-000000000003', phase: 'completed', causeRef: null },
          [plan.slots[1].slotId]: { jobId: '30000000-0000-4000-8000-000000000004', phase: 'error', causeRef },
        },
      });
    } finally {
      db.close();
    }
  });
});
