// Spec §6.1 line 813 + §13.1 worked example: workflow children carry
// `refs.workflowId` on their `job.launch.requested` envelope. The producer is
// `src/jobs/store.ts:appendLaunchRequested`. This test exercises the
// producer with synthetic launches and asserts the field appears whenever the
// launch belongs to a workflow.

import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { StoragePort } from '#src/runtime/ports.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { JobStore } from '#src/jobs/store.js';
import type { JobLaunch } from '#src/jobs/records.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

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

const openDbs = new Set<InstanceType<typeof Database>>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  openDbs.add(db);
  return db;
}

function readPersistedLaunches(db: InstanceType<typeof Database>): PersistedEvent[] {
  const rows = db
    .prepare("SELECT type, refs FROM events WHERE type = 'job.launch.requested' ORDER BY seq ASC")
    .all() as Array<{ type: string; refs: string | null }>;
  return rows.map((row) => ({
    type: row.type,
    refs: row.refs ? (JSON.parse(row.refs) as PersistedRefs) : undefined,
  }));
}

function makeProviderLaunch(overrides: Partial<JobLaunch> & Pick<JobLaunch, 'jobId' | 'sessionId'>): JobLaunch {
  return {
    jobId: overrides.jobId,
    sessionId: overrides.sessionId,
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
    ...overrides,
  };
}

describe('refs.workflowId producer invariant', () => {
  it('emits refs.workflowId on every launch.requested event whose lifetime belongs to a workflow', () => {
    const db = createDb();
    const runtime = new SimulationRuntime();
    const store = new JobStore('test-ns', runtime, createDefaultUpcasterRegistry(), { db });

    // The workflow's own job: workflowId === jobId.
    store.appendLaunchRequested(
      'wf-1',
      makeProviderLaunch({ jobId: 'wf-1', sessionId: 'session-wf-1', jobKind: 'workflow' }),
    );

    // A workflow child: parentJobId === workflowId === parent workflow id.
    store.appendLaunchRequested(
      'a-1',
      makeProviderLaunch({
        jobId: 'a-1',
        sessionId: 'session-a-1',
        parentWorkflowJobId: 'wf-1',
        workflowSlotId: 'wf-1:0:0',
      }),
    );

    // A plain job (no workflow involvement): no workflowId.
    store.appendLaunchRequested(
      'p-1',
      makeProviderLaunch({ jobId: 'p-1', sessionId: 'session-p-1' }),
    );

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

    // Structural invariant: every launch with workflowSlotId carries workflowId.
    for (const event of events) {
      if (event.refs?.workflowSlotId !== undefined) {
        expect(event.refs.workflowId).toBeDefined();
      }
    }
  });
});
