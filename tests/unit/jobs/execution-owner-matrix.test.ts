import { describe, expect, it } from 'vitest';

import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { JobLaunch } from '#src/jobs/records.js';
import { jobLaunchRequestedEvent, JobStore } from '#src/jobs/store.js';
import type { ExecutionOwner } from '#src/runtime/execution-owner.js';
import { SessionManager } from '#src/sessions/shell.js';
import { sessionsRegistry } from '#src/sessions/events.js';
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
  applyBundledStoreSchema(db);
  const runtime = new SimulationRuntime();
  const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
  const store = new JobStore('tests', runtime, createEventBodyCodec(), {
    db,
    reducers,
    providers: permissiveProviderLookupPort,
  });
  const sessions = new SessionManager(PROJECT_ROOT, runtime, (cb) => store.commit(cb), undefined, db);
  return { db, store, sessions };
}

function workflowLaunch(jobId: string, owner: ExecutionOwner): JobLaunch {
  return {
    jobId,
    owner,
    sessionId: null,
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

function kbLaunch(jobId: string, owner: ExecutionOwner): JobLaunch {
  return {
    jobId,
    owner,
    sessionId: null,
    provider: null,
    projectRoot: PROJECT_ROOT,
    backendNamespace: 'tests',
    jobKind: 'kb',
    pool: 'curate',
    enqueueSequence: 1,
    operation: 'kb.reindex',
    request: {},
    createdAt: '2026-07-22T00:00:00.000Z',
  };
}

describe('ExecutionOwner and job-kind negative matrix', () => {
  it.each([
    ['provider-session', { kind: 'provider-session', id: 'session-1' }],
    ['discussion', { kind: 'discussion', id: 'discussion-1' }],
    ['system-task', { kind: 'system-task', id: 'system-1' }],
  ] as const)('rejects a workflow job owned by %s', (_label, owner) => {
    const { db, store } = createHarness();
    try {
      expect(() => store.appendLaunchRequested('workflow-1', workflowLaunch('workflow-1', owner))).toThrowError(
        expect.objectContaining({ code: 'job_owner_mismatch' }),
      );
      expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('rejects a workflow job whose workflow owner id differs from its job id', () => {
    const { db, store } = createHarness();
    try {
      expect(() =>
        store.appendLaunchRequested(
          'workflow-1',
          workflowLaunch('workflow-1', { kind: 'workflow', id: 'workflow-other' }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'job_owner_mismatch' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it.each([
    ['provider-session', { kind: 'provider-session', id: 'session-1' }],
    ['workflow', { kind: 'workflow', id: 'workflow-1' }],
    ['discussion', { kind: 'discussion', id: 'discussion-1' }],
  ] as const)('rejects a KB job owned by %s', (_label, owner) => {
    const { db, store } = createHarness();
    try {
      expect(() => store.appendLaunchRequested('kb-1', kbLaunch('kb-1', owner))).toThrowError(
        expect.objectContaining({ code: 'job_owner_mismatch' }),
      );
      expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('rejects a provider job owned by a system task and rolls back its same-batch provider session', () => {
    const { db, store, sessions } = createHarness();
    try {
      const prepared = sessions.prepare({
        binding: TEST_CODEX_BINDING,
        name: 'provider-job-session',
        cwd: PROJECT_ROOT,
        projectRoot: PROJECT_ROOT,
        backendNamespace: 'tests',
        retention: 'retain',
      });
      const launch: JobLaunch = {
        jobId: 'provider-job',
        owner: { kind: 'system-task', id: 'system-1' },
        sessionId: prepared.sessionId,
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
          sessions.appendPreparedClaim(c, prepared, launch.jobId);
          c.append(jobLaunchRequestedEvent(launch.jobId, launch));
          return undefined;
        }),
      ).toThrowError(expect.objectContaining({ code: 'job_binding_owner_mismatch' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
      expect(sessions.readById(prepared.sessionId, { forceFresh: true })).toBeNull();
    } finally {
      db.close();
    }
  });
});
