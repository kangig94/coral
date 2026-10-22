import { currentCoralStoreFormat } from '#src/store-format.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allocateTestSession,
  testConversationOpenedInput,
  validatedTestContinuitySnapshot,
} from '../../helpers/session.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRealRuntime } from '#src/runtime/real.js';
import { commit, type AppendedEvent, type CommitEventsFn } from '#src/store/append.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { appendJobExecutionEnded, appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { requestedExecution } from '#tests/helpers/job-executions.js';

let tmpHome = '';
let runtime: ReturnType<typeof createRealRuntime>;
const openDbs: Array<ReturnType<typeof openTestStoreDatabase>> = [];

function openSessionDb(path = ':memory:'): ReturnType<typeof openTestStoreDatabase> {
  const db = openTestStoreDatabase({ storeFormat: currentCoralStoreFormat(), path, storage: runtime.storage });
  openDbs.push(db);
  return db;
}

describe('job conversation shell store', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-execution-home-'));
    runtime = createRealRuntime('prod', { baseDir: tmpHome });
  });

  afterEach(() => {
    for (const db of openDbs.splice(0).reverse()) db.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function setupWithJournal(projectName: string) {
    const workDir = join(tmpHome, projectName);
    mkdirSync(workDir, { recursive: true });
    const db = openSessionDb();
    const reducers = composeReducers(jobsRegistry, discussRegistry, workflowRegistry);
    const bodyCodec = createEventBodyCodec();
    const appendedBatches: AppendedEvent[][] = [];
    const coordinatorCommit: CommitEventsFn = (cb) => {
      const appended = commit(db, cb, {
        now: () => new Date('2026-04-19T00:00:00.000Z'),
        reducers,
        bodyCodec,
        providers: permissiveProviderLookupPort,
      });
      appendedBatches.push(appended);
      return appended;
    };
    const mgr = new ConversationManager(workDir, runtime, coordinatorCommit, db);
    const entry = allocateTestSession(mgr, 'codex', 'alpha', 'gpt-5', workDir);
    coordinatorCommit((c) => {
      c.append(testConversationOpenedInput(entry));
      return undefined;
    });
    return { mgr, entry, workDir, coordinatorCommit, appendedBatches };
  }

  it('allows only one concurrent execution request on a conversation job', async () => {
    const { mgr, entry, coordinatorCommit } = setupWithJournal('request-atomic');
    const request = () =>
      coordinatorCommit((c) => {
        c.append({ ...requestedExecution(), stream: { kind: 'job', id: entry.jobId } });
        return undefined;
      });
    const results = await Promise.allSettled([Promise.resolve().then(request), Promise.resolve().then(request)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'job_execution_order_violation' });
    expect(mgr.get('codex', entry.jobId)).toMatchObject({ jobId: entry.jobId, execution: 1, open: true });
  });

  it('checkpoints continuity before acceptance and retains ownership until the execution ends', async () => {
    const { appendedBatches, mgr, entry, coordinatorCommit } = setupWithJournal('checkpoint-before-acceptance');
    coordinatorCommit((c) => {
      c.append({ ...requestedExecution(), stream: { kind: 'job', id: entry.jobId } });
      return undefined;
    });
    appendedBatches.length = 0;
    await expect(
      mgr.checkpointJobContinuityAtomic(entry.jobId, {
        execution: 1,
        snapshot: validatedTestContinuitySnapshot({
          conversationRef: 'thread-1',
          resumable: true,
          providerContinuity: null,
        }),
      }),
    ).resolves.toEqual({ ok: true, execution: 1 });
    expect(appendedBatches).toHaveLength(1);
    expect(appendedBatches[0].map((event) => event.type)).toEqual(['job.continuity.checkpointed']);

    const acceptedEvents = coordinatorCommit((c) => {
      appendJobExecutionOutcomeAccepted(c, {
        jobId: entry.jobId,
        execution: 1,
        terminal: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
      });
      return undefined;
    });
    const accepted = acceptedEvents?.[0];
    if (accepted === undefined) throw new Error('Expected accepted outcome.');
    expect(mgr.get('codex', entry.jobId)).toMatchObject({ open: true, finishing: true, conversationRef: 'thread-1' });
    await expect(
      mgr.checkpointJobContinuityAtomic(entry.jobId, {
        execution: 1,
        snapshot: validatedTestContinuitySnapshot({
          conversationRef: 'late-thread',
          resumable: true,
          providerContinuity: null,
        }),
      }),
    ).resolves.toEqual({ ok: false });
    expect(() =>
      coordinatorCommit((c) => {
        c.append({ ...requestedExecution(2), stream: { kind: 'job', id: entry.jobId } });
        return undefined;
      }),
    ).toThrowError(expect.objectContaining({ code: 'job_execution_order_violation' }));
    coordinatorCommit((c) => {
      appendJobExecutionEnded(c, {
        jobId: entry.jobId,
        execution: 1,
        causeRef: { stream: accepted.stream, seq: accepted.seq },
      });
      return undefined;
    });
    expect(mgr.get('codex', entry.jobId)).toMatchObject({ open: false, finishing: false, conversationRef: 'thread-1' });
  });

  it('checks the execution ordinal after acquiring the database write transaction', async () => {
    const workDir = join(tmpHome, 'checkpoint-cross-connection');
    mkdirSync(workDir, { recursive: true });
    const dbPath = join(tmpHome, 'checkpoint-cross-connection.db');
    const dbA = openSessionDb(dbPath);
    const dbB = openSessionDb(dbPath);
    const reducers = composeReducers(jobsRegistry, discussRegistry, workflowRegistry);
    const bodyCodec = createEventBodyCodec();
    const commitWith = (db: typeof dbA, cb: Parameters<CommitEventsFn>[0]) =>
      commit(db, cb, {
        now: () => new Date('2026-04-19T00:00:00.000Z'),
        reducers,
        bodyCodec,
        providers: permissiveProviderLookupPort,
      });
    let beforeNextACommit: (() => void) | undefined;
    const commitA: CommitEventsFn = (cb) => {
      const before = beforeNextACommit;
      beforeNextACommit = undefined;
      before?.();
      return commitWith(dbA, cb);
    };
    const commitB: CommitEventsFn = (cb) => commitWith(dbB, cb);
    const managerA = new ConversationManager(workDir, runtime, commitA, dbA);
    const managerB = new ConversationManager(workDir, runtime, commitB, dbB);
    const entry = allocateTestSession(managerA, 'codex', 'alpha', 'gpt-5', workDir);
    commitA((c) => {
      c.append(testConversationOpenedInput(entry));
      c.append({ ...requestedExecution(), stream: { kind: 'job', id: entry.jobId } });
      return undefined;
    });
    await managerA.checkpointJobContinuityAtomic(entry.jobId, {
      execution: 1,
      snapshot: validatedTestContinuitySnapshot({
        conversationRef: 'thread-1',
        resumable: true,
        providerContinuity: null,
      }),
    });
    expect(managerB.readById(entry.jobId)?.execution).toBe(1);
    beforeNextACommit = () => {
      commitB((c) => {
        const accepted = appendJobExecutionOutcomeAccepted(c, {
          jobId: entry.jobId,
          execution: 1,
          terminal: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
        });
        appendJobExecutionEnded(c, { jobId: entry.jobId, execution: 1, causeRef: accepted });
        c.append({ ...requestedExecution(2), stream: { kind: 'job', id: entry.jobId } });
        return undefined;
      });
    };
    await expect(
      managerA.checkpointJobContinuityAtomic(entry.jobId, {
        execution: 1,
        snapshot: validatedTestContinuitySnapshot({
          conversationRef: 'thread-racy',
          resumable: true,
          providerContinuity: { threadId: 'thread-racy' },
        }),
      }),
    ).resolves.toEqual({ ok: false });
    expect(managerA.readById(entry.jobId)).toMatchObject({
      execution: 2,
      open: true,
      conversationRef: 'thread-1',
    });
  });
});
