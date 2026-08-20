import { currentCoralStoreFormat } from '#src/store-format.js';
// Spec §6.1 line 813 + §13.1 worked example: workflow children carry
// `refs.workflowId` on their `job.launch.requested` envelope. The producer is
// `src/jobs/store.ts:appendLaunchRequested`. This test exercises the
// producer with synthetic launches and asserts the field appears whenever the
// launch belongs to a workflow.

import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it } from 'vitest';

import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { JobStore } from '#src/jobs/store.js';
import type { JobLaunch, ProviderJobLaunch } from '#src/jobs/records.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_CODEX_BINDING, TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import type { ProviderSession } from '#src/sessions/entry.js';
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
    .prepare("SELECT type, refs FROM events WHERE type = 'job.launch.requested' ORDER BY seq ASC")
    .all() as Array<{ type: string; refs: string | null }>;
  return rows.map((row) => ({
    type: row.type,
    refs: row.refs ? (JSON.parse(row.refs) as PersistedRefs) : undefined,
  }));
}

function makeProviderLaunch(
  overrides: Partial<Omit<ProviderJobLaunch, 'jobId' | 'sessionId'>> & { jobId: string; sessionId: string },
): JobLaunch {
  const { jobId, sessionId, ...rest } = overrides;
  return {
    jobId,
    owner: { kind: 'provider-session', id: sessionId },
    sessionId,
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
    ...(rest.workflowSlotId === undefined ? {} : { workflowSlotGeneration: rest.workflowSlotGeneration ?? 0 }),
  };
}

function makeWorkflowLaunch(jobId: string): JobLaunch {
  return {
    jobId,
    owner: { kind: 'workflow', id: jobId },
    sessionId: null,
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

function providerSessionInputs(sessionId: string, jobId: string, projectRoot: string): CoralEventInput[] {
  const opened: ProviderSession = {
    sessionId,
    binding: TEST_CODEX_BINDING,
    name: sessionId,
    state: 'pending',
    retention: 'retain',
    artifactHandles: [],
    retentionDiscard: { attempts: [] },
    providerContinuity: null,
    cwd: projectRoot,
    projectRoot,
    backendNamespace: 'test-ns',
    createdAt: '2026-04-29T00:00:00.000Z',
    lastUsedAt: '2026-04-29T00:00:00.000Z',
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

describe('refs.workflowId producer invariant', () => {
  it('emits refs.workflowId on every launch.requested event whose lifetime belongs to a workflow', () => {
    const db = createDb();
    const runtime = new SimulationRuntime();
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry);
    const bodyCodec = createEventBodyCodec();
    const store = new JobStore('test-ns', runtime, bodyCodec, {
      db,
      reducers,
      providers: permissiveProviderLookupPort,
    });
    commitInputs(
      db,
      [
        ...providerSessionInputs('session-a-1', 'a-1', '/workspace/a-1'),
        ...providerSessionInputs('session-p-1', 'p-1', '/workspace/p-1'),
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
          'wf-1',
          {
            slots: [
              {
                slotId: 'wf-1:0:0',
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
    store.appendLaunchRequested('wf-1', makeWorkflowLaunch('wf-1'));

    // A workflow child: parentJobId === workflowId === parent workflow id.
    store.appendLaunchRequested(
      'a-1',
      makeProviderLaunch({
        jobId: 'a-1',
        sessionId: 'session-a-1',
        owner: { kind: 'workflow', id: 'wf-1' },
        parentWorkflowJobId: 'wf-1',
        workflowSlotId: 'wf-1:0:0',
      }),
    );

    // A plain job (no workflow involvement): no workflowId.
    store.appendLaunchRequested('p-1', makeProviderLaunch({ jobId: 'p-1', sessionId: 'session-p-1' }));

    const events = readPersistedLaunches(db);
    expect(events).toHaveLength(3);

    const wfEvent = events.find((event) => event.refs?.jobId === 'wf-1');
    expect(wfEvent?.refs?.workflowId).toBe('wf-1');

    const childEvent = events.find((event) => event.refs?.jobId === 'a-1');
    expect(childEvent?.refs?.workflowId).toBe('wf-1');
    expect(childEvent?.refs?.parentJobId).toBe('wf-1');
    expect(childEvent?.refs?.workflowSlotId).toBe('wf-1:0:0');

    const plainEvent = events.find((event) => event.refs?.jobId === 'p-1');
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
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry);
    const bodyCodec = createEventBodyCodec();
    const store = new JobStore('test-ns', runtime, bodyCodec, {
      db,
      reducers,
      providers: permissiveProviderLookupPort,
    });
    commitInputs(db, providerSessionInputs('session-wrong-owner', 'wrong-owner-child', '/workspace/wrong-owner'), {
      now: () => new Date('2026-04-29T00:00:00.000Z'),
      reducers,
      bodyCodec,
      providers: permissiveProviderLookupPort,
    });
    store.commit((c) => {
      c.append(
        workflowPlanDeclaredEvent(
          'wf-owner',
          {
            slots: [
              {
                slotId: 'wf-owner:0:0',
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
        'wrong-owner-child',
        makeProviderLaunch({
          jobId: 'wrong-owner-child',
          sessionId: 'session-wrong-owner',
          parentWorkflowJobId: 'wf-owner',
          workflowSlotId: 'wf-owner:0:0',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'job_binding_owner_mismatch' }));
  });

  it('rejects empty launch refs before they reach the Journal', () => {
    const db = createDb();
    const runtime = new SimulationRuntime();
    const store = new JobStore('test-ns', runtime, createEventBodyCodec(), {
      db,
      providers: permissiveProviderLookupPort,
    });

    expect(() =>
      store.appendLaunchRequested('empty-session', makeProviderLaunch({ jobId: 'empty-session', sessionId: '' })),
    ).toThrow("Job ref 'sessionId' must be non-empty.");

    expect(() =>
      store.appendLaunchRequested(
        'empty-parent',
        makeProviderLaunch({
          jobId: 'empty-parent',
          sessionId: 'session-empty-parent',
          parentWorkflowJobId: '',
        }),
      ),
    ).toThrow("Job ref 'parentJobId' must be non-empty.");

    expect(() =>
      store.appendLaunchRequested(
        'empty-slot',
        makeProviderLaunch({
          jobId: 'empty-slot',
          sessionId: 'session-empty-slot',
          parentWorkflowJobId: 'wf-1',
          workflowSlotId: '',
        }),
      ),
    ).toThrow("Job ref 'workflowSlotId' must be non-empty.");
  });
});
