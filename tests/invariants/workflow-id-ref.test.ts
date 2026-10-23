import { testConversationFacet } from '#tests/helpers/session.js';

import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it } from 'vitest';

import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { JobStore } from '#src/jobs/store.js';
import type { JobLaunch, ProviderJobLaunch } from '#src/jobs/records.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import type { CoralEventInput } from '#src/store/envelope.js';
interface PersistedRefs {
  jobId?: string;
  parentJobId?: string;
  workflowId?: string;
  workflowSlotId?: string;
}

interface PersistedEvent {
  type: string;
  refs: PersistedRefs | undefined;
}

const openDbs = new Set<Database>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  openDbs.add(db);
  return db;
}

function readPersistedLaunches(db: Database): PersistedEvent[] {
  const rows = db
    .prepare("SELECT type, refs FROM events WHERE type = 'job.execution.requested' ORDER BY seq ASC")
    .all() as Array<{ type: string; refs: string | null }>;
  return rows.map((row) => ({
    type: row.type,
    refs: row.refs ? (JSON.parse(row.refs) as PersistedRefs) : undefined,
  }));
}

function makeProviderLaunch(overrides: Partial<Omit<ProviderJobLaunch, 'jobId'>> & { jobId: string }): JobLaunch {
  const { jobId, ...rest } = overrides;
  return {
    jobId,
    owner: { kind: 'provider-session', id: jobId },
    execution: 1,
    provider: 'codex',
    providerAction: 'exec',
    projectRoot: `/workspace/${overrides.jobId}`,
    backendNamespace: 'test-ns',
    bundleHash: 'bundle-hash',
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 1,
    request: {
      prompt: 'p',
      cwd: `/workspace/${overrides.jobId}`,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: '2026-04-29T00:00:00.000Z',
    ...rest,
  };
}

function makeWorkflowLaunch(jobId: string): JobLaunch {
  return {
    jobId,
    owner: { kind: 'workflow', id: jobId },
    execution: 1,
    provider: null,
    projectRoot: `/workspace/${jobId}`,
    backendNamespace: 'test-ns',
    bundleHash: 'bundle-hash',
    jobKind: 'workflow',
    pool: 'default',
    enqueueSequence: 1,
    request: {
      prompt: 'p',
      cwd: `/workspace/${jobId}`,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: '2026-04-29T00:00:00.000Z',
  };
}

function jobConversationInputs(
  name: string,
  jobId: string,
  projectRoot: string,
  workflowJobId?: string,
): CoralEventInput[] {
  return [
    {
      type: 'job.opened',
      stream: { kind: 'job', id: jobId },
      refs: { jobId },
      body: {
        jobKind: 'provider',
        projectRoot,
        createdAt: '2026-04-29T00:00:00.000Z',
        owner:
          workflowJobId === undefined
            ? { kind: 'provider-session', id: jobId }
            : { kind: 'workflow', id: workflowJobId },
        ...(workflowJobId === undefined ? {} : { workflowSlotId: `${workflowJobId}:0:0` }),
        conversation: { ...testConversationFacet('codex', projectRoot), name },
      },
    },
  ];
}

describe('refs.workflowId producer invariant', () => {
  it('emits refs.workflowId on every launch.requested event whose lifetime belongs to a workflow', () => {
    const db = createDb();
    const runtime = new SimulationRuntime();
    const reducers = composeReducers(jobsRegistry, workflowRegistry);
    const bodyCodec = createEventBodyCodec();
    const store = new JobStore('test-ns', runtime, bodyCodec, {
      db,
      reducers,
      providers: permissiveProviderLookupPort,
    });
    commitInputs(
      db,
      [
        ...jobConversationInputs(
          'session-91000000-0000-4000-8000-000000000002',
          '91000000-0000-4000-8000-000000000002',
          '/workspace/91000000-0000-4000-8000-000000000002',
          '91000000-0000-4000-8000-000000000001',
        ),
        ...jobConversationInputs(
          'session-91000000-0000-4000-8000-000000000003',
          '91000000-0000-4000-8000-000000000003',
          '/workspace/91000000-0000-4000-8000-000000000003',
        ),
      ],
      {
        now: () => new Date('2026-04-29T00:00:00.000Z'),
        reducers,
        bodyCodec,
        providers: permissiveProviderLookupPort,
      },
    );

    // The workflow's own job: workflowId === jobId.
    store.commit((c) => {
      c.append(
        workflowPlanDeclaredEvent(
          '91000000-0000-4000-8000-000000000001',
          {
            slots: [
              {
                slotId: '91000000-0000-4000-8000-000000000001:0:0',
                dependencies: [],
                provider: 'codex',
                instruction: 'run',
              },
            ],
          },
          TEST_PROVIDER_SCOPE,
        ),
      );
      return undefined;
    });
    store.appendLaunchRequested(
      '91000000-0000-4000-8000-000000000001',
      makeWorkflowLaunch('91000000-0000-4000-8000-000000000001'),
    );

    // A workflow child: parentJobId === workflowId === parent workflow id.
    store.appendLaunchRequested(
      '91000000-0000-4000-8000-000000000002',
      makeProviderLaunch({
        jobId: '91000000-0000-4000-8000-000000000002',
        owner: { kind: 'workflow', id: '91000000-0000-4000-8000-000000000001' },
        parentWorkflowJobId: '91000000-0000-4000-8000-000000000001',
        workflowSlotId: '91000000-0000-4000-8000-000000000001:0:0',
      }),
    );

    // A plain job (no workflow involvement): no workflowId.
    store.appendLaunchRequested(
      '91000000-0000-4000-8000-000000000003',
      makeProviderLaunch({ jobId: '91000000-0000-4000-8000-000000000003' }),
    );

    const events = readPersistedLaunches(db);
    expect(events).toHaveLength(3);

    const wfEvent = events.find((event) => event.refs?.jobId === '91000000-0000-4000-8000-000000000001');
    expect(wfEvent?.refs?.workflowId).toBe('91000000-0000-4000-8000-000000000001');

    const childEvent = events.find((event) => event.refs?.jobId === '91000000-0000-4000-8000-000000000002');
    expect(childEvent?.refs?.workflowId).toBe('91000000-0000-4000-8000-000000000001');
    expect(childEvent?.refs?.parentJobId).toBe('91000000-0000-4000-8000-000000000001');
    expect(childEvent?.refs?.workflowSlotId).toBe('91000000-0000-4000-8000-000000000001:0:0');

    const plainEvent = events.find((event) => event.refs?.jobId === '91000000-0000-4000-8000-000000000003');
    expect(plainEvent?.refs?.workflowId).toBeUndefined();
    expect(plainEvent?.refs?.parentJobId).toBeUndefined();

    for (const event of events) {
      if (event.refs?.workflowSlotId !== undefined) {
        expect(event.refs.workflowId).toBeDefined();
      }
    }
  });

  it('rejects a workflow child whose durable owner is not its workflow aggregate', () => {
    const db = createDb();
    const runtime = new SimulationRuntime();
    const reducers = composeReducers(jobsRegistry, workflowRegistry);
    const bodyCodec = createEventBodyCodec();
    const store = new JobStore('test-ns', runtime, bodyCodec, {
      db,
      reducers,
      providers: permissiveProviderLookupPort,
    });
    commitInputs(
      db,
      jobConversationInputs('session-wrong-owner', '91000000-0000-4000-8000-000000000005', '/workspace/wrong-owner'),
      {
        now: () => new Date('2026-04-29T00:00:00.000Z'),
        reducers,
        bodyCodec,
        providers: permissiveProviderLookupPort,
      },
    );
    store.commit((c) => {
      c.append(
        workflowPlanDeclaredEvent(
          '91000000-0000-4000-8000-000000000004',
          {
            slots: [
              {
                slotId: '91000000-0000-4000-8000-000000000004:0:0',
                dependencies: [],
                provider: 'codex',
                instruction: 'run',
              },
            ],
          },
          TEST_PROVIDER_SCOPE,
        ),
      );
      return undefined;
    });

    expect(() =>
      store.appendLaunchRequested(
        '91000000-0000-4000-8000-000000000005',
        makeProviderLaunch({
          jobId: '91000000-0000-4000-8000-000000000005',
          parentWorkflowJobId: '91000000-0000-4000-8000-000000000004',
          workflowSlotId: '91000000-0000-4000-8000-000000000004:0:0',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'job_execution_order_violation' }));
  });
});
