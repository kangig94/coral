import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testConversationOpenedInput } from '#tests/helpers/session.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { describe, expect, it } from 'vitest';

import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { JobLaunch } from '#src/jobs/records.js';
import { jobLaunchRequestedEvent, JobStore } from '#src/jobs/store.js';
import type { ExecutionOwner } from '#src/runtime/execution-owner.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const PROJECT_ROOT = '/tmp/coral-execution-owner-matrix';

function createHarness() {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const runtime = new SimulationRuntime();
  const reducers = composeReducers(jobsRegistry, discussRegistry, workflowRegistry);
  const store = new JobStore('tests', runtime, createEventBodyCodec(), {
    db,
    reducers,
    providers: permissiveProviderLookupPort,
  });
  const sessions = new ConversationManager(PROJECT_ROOT, runtime, (cb) => store.commit(cb), db);
  return { db, store, sessions };
}

function workflowLaunch(jobId: string, owner: ExecutionOwner): JobLaunch {
  return {
    jobId,
    owner,
    execution: 1,
    provider: null,
    projectRoot: PROJECT_ROOT,
    backendNamespace: 'tests',
    jobKind: 'workflow',
    pool: 'default',
    enqueueSequence: 1,
    request: { prompt: '', cwd: PROJECT_ROOT, bypassPermissions: false, coralEnv: {} },
    createdAt: '2026-07-22T00:00:00.000Z',
  };
}

describe('ExecutionOwner and job-kind negative matrix', () => {
  it('rejects a workflow job whose workflow owner id differs from its job id', () => {
    const { db, store } = createHarness();
    try {
      expect(() =>
        store.appendLaunchRequested(
          '10000000-0000-4000-8000-000000000001',
          workflowLaunch('10000000-0000-4000-8000-000000000001', { kind: 'workflow', id: 'workflow-other' }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'job_execution_order_violation' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('rejects a provider job owned by a system task and rolls back its same-batch provider session', () => {
    const { db, store, sessions } = createHarness();
    try {
      const prepared = sessions.prepare({
        jobId: '10000000-0000-4000-8000-000000000002',
        binding: TEST_CODEX_BINDING,
        name: 'provider-job-session',
        cwd: fixtureCanonicalWorkDir(PROJECT_ROOT),
        projectRoot: PROJECT_ROOT,
        backendNamespace: 'tests',
        retention: 'retain',
      });
      const launch: JobLaunch = {
        jobId: '10000000-0000-4000-8000-000000000002',
        owner: { kind: 'system-task', id: 'system-1' },
        execution: 1,
        provider: 'codex',
        projectRoot: PROJECT_ROOT,
        backendNamespace: 'tests',
        jobKind: 'provider',
        pool: 'default',
        enqueueSequence: 1,
        providerAction: 'exec',
        request: { prompt: '', cwd: PROJECT_ROOT, bypassPermissions: false, coralEnv: {} },
        createdAt: '2026-07-22T00:00:00.000Z',
      };

      expect(() =>
        store.commit((c) => {
          const opened = testConversationOpenedInput(prepared);
          opened.body.owner = launch.owner;
          c.append(opened);
          c.append(jobLaunchRequestedEvent(launch.jobId, launch));
          return undefined;
        }),
      ).toThrowError(expect.objectContaining({ code: 'job_execution_order_violation' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
      expect(sessions.readById(prepared.jobId)).toBeNull();
    } finally {
      db.close();
    }
  });
});
