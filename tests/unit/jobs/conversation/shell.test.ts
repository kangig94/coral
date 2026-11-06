import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationManager } from '#src/jobs/conversation/shell.js';
import * as conversationReads from '#src/jobs/conversation/read-queries.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { readProjectionJobConversation } from '#src/jobs/conversation/read-queries.js';
import {
  EXECUTION_JOB_ID as jobId,
  executionHarness,
  openedJob,
  requestedExecution,
} from '#tests/helpers/job-executions.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

afterEach(() => vi.restoreAllMocks());

describe('job conversation continuity', () => {
  it.each(['/workspace', '/workspace/child', '/sibling', '/tmp/work'])(
    'reads and checkpoints owned work at %s without broadening caller visibility',
    async (cwd) => {
      const h = executionHarness();
      const manager = new ConversationManager('/workspace', new SimulationRuntime(), h.commit, h.db);
      const owner = manager.forExecutionOwner();
      const opened = openedJob();
      if (opened.body.jobKind !== 'provider') throw new Error('Expected provider fixture');
      try {
        h.append(
          openedJob({ conversation: { ...opened.body.conversation, cwd: fixtureCanonicalWorkDir(cwd) } }),
          requestedExecution(),
        );
        expect(owner.get('codex', jobId)).toMatchObject({ projectRoot: '/workspace', cwd });
        expect(manager.get('codex', jobId) !== null).toBe(cwd.startsWith('/workspace'));
        expect(
          await owner.checkpointJobContinuityAtomic(jobId, {
            execution: 1,
            snapshot: { conversationRef: 'native', resumable: true, providerContinuity: null },
          }),
        ).toEqual({ ok: true, execution: 1 });
        expect(
          await owner.recordArtifactHandleAtomic(jobId, {
            execution: 1,
            handle: '/native',
            identity: { kind: 'conversation', conversationRef: 'native' },
          }),
        ).toEqual({ ok: true, execution: 1 });
        expect(owner.readById(jobId)).toMatchObject({
          conversationRef: 'native',
          artifactHandles: [{ handle: '/native' }],
        });
      } finally {
        h.db.close();
      }
    },
  );

  it('distinguishes absent, wrong owner, wrong provider, malformed and unreadable evidence', () => {
    const h = executionHarness();
    const manager = new ConversationManager('/workspace', new SimulationRuntime(), h.commit, h.db);
    const owner = manager.forExecutionOwner();
    try {
      expect(owner.readById(jobId)).toBeNull();
      h.append(openedJob(), requestedExecution());
      expect(() =>
        new ConversationManager('/other', new SimulationRuntime(), h.commit, h.db).forExecutionOwner().readById(jobId),
      ).toThrowError(expect.objectContaining({ reason: 'owner_mismatch' }));
      expect(() => owner.get('claude', jobId)).toThrowError(expect.objectContaining({ reason: 'provider_mismatch' }));
      h.db.prepare('UPDATE projection_jobs SET facet = ? WHERE job_id = ?').run('{', jobId);
      expect(() => owner.readById(jobId)).toThrowError(expect.objectContaining({ reason: 'malformed' }));
      vi.spyOn(conversationReads, 'readProjectionJobConversation').mockImplementation(() => {
        throw new Error('storage unavailable');
      });
      expect(() => owner.readById(jobId)).toThrowError(expect.objectContaining({ reason: 'unreadable' }));
    } finally {
      h.db.close();
    }
  });

  it.each(['{', '{}'])('does not classify corrupt diagnostics %s as malformed conversation evidence', (diagnostics) => {
    const h = executionHarness();
    const owner = new ConversationManager('/workspace', new SimulationRuntime(), h.commit, h.db).forExecutionOwner();
    try {
      h.append(openedJob(), requestedExecution());
      const before = h.db.prepare('SELECT facet FROM projection_jobs WHERE job_id = ?').get(jobId);
      h.db.prepare('UPDATE projection_jobs SET diagnostics = ? WHERE job_id = ?').run(diagnostics, jobId);
      expect(() => owner.get('codex', jobId)).toThrowError(
        expect.objectContaining({
          reason: 'unreadable',
          cause: expect.objectContaining({
            name: 'ProjectionJobDecodeError',
            cause:
              diagnostics === '{'
                ? expect.objectContaining({ message: expect.stringContaining('diagnostics') })
                : expect.objectContaining({
                    issues: expect.arrayContaining([expect.objectContaining({ path: ['progressFaults'] })]),
                  }),
          }),
        }),
      );
      expect(h.db.prepare('SELECT facet FROM projection_jobs WHERE job_id = ?').get(jobId)).toEqual(before);
    } finally {
      h.db.close();
    }
  });

  it('preserves a transient database read failure independently of projection decoding', () => {
    const h = executionHarness();
    const owner = new ConversationManager('/workspace', new SimulationRuntime(), h.commit, h.db).forExecutionOwner();
    try {
      h.append(openedJob(), requestedExecution());
      const failure = Object.assign(new Error('database is busy'), { code: 'SQLITE_BUSY' });
      vi.spyOn(h.db, 'prepare').mockImplementationOnce(() => {
        throw failure;
      });
      expect(() => owner.get('codex', jobId)).toThrowError(
        expect.objectContaining({ reason: 'unreadable', cause: failure }),
      );
    } finally {
      h.db.close();
    }
  });

  it.each([
    ['job.continuity.checkpointed', '{', 'malformed'],
    ['job.continuity.checkpointed', '{}', 'malformed'],
    ['job.artifact.recorded', '{}', 'unreadable'],
    ['job.retention.discard.requested', '{}', 'unreadable'],
  ] as const)('classifies corrupt %s evidence %s at its own decode boundary', async (type, body, reason) => {
    const h = executionHarness();
    const owner = new ConversationManager('/workspace', new SimulationRuntime(), h.commit, h.db).forExecutionOwner();
    try {
      h.append(openedJob(), requestedExecution());
      expect(
        await owner.checkpointJobContinuityAtomic(jobId, {
          execution: 1,
          snapshot: { conversationRef: 'native', resumable: true, providerContinuity: null },
        }),
      ).toEqual({ ok: true, execution: 1 });
      h.db
        .prepare("UPDATE events SET type = ?, body = ? WHERE stream_id = ? AND type = 'job.continuity.checkpointed'")
        .run(type, Buffer.from(body), jobId);
      expect(() => owner.get('codex', jobId)).toThrowError(
        expect.objectContaining({ reason, cause: expect.any(Error) }),
      );
    } finally {
      h.db.close();
    }
  });

  it('keeps continuity and artifact handles on the job and refuses stale execution writes', async () => {
    const h = executionHarness();
    const manager = new ConversationManager('/workspace', new SimulationRuntime(), h.commit, h.db);
    try {
      h.append(openedJob(), requestedExecution());
      expect(
        await manager.checkpointJobContinuityAtomic(jobId, {
          execution: 1,
          snapshot: { conversationRef: 'native-conversation', resumable: true, providerContinuity: null },
        }),
      ).toEqual({ ok: true, execution: 1 });
      const identity = { kind: 'conversation', conversationRef: 'native-conversation' };
      expect(
        await manager.recordArtifactHandleAtomic(jobId, {
          execution: 1,
          handle: '/native',
          identity,
        }),
      ).toEqual({ ok: true, execution: 1 });
      h.complete(1);
      h.append(requestedExecution(2));
      expect(
        await manager.checkpointJobContinuityAtomic(jobId, {
          execution: 1,
          snapshot: { conversationRef: 'stale', resumable: false, providerContinuity: null },
        }),
      ).toEqual({ ok: false });
      expect(
        await manager.recordArtifactHandleAtomic(jobId, {
          execution: 1,
          handle: '/late',
          identity,
        }),
      ).toEqual({ ok: false });
      expect(readProjectionJobConversation(h.db, jobId)).toMatchObject({
        jobId,
        execution: 2,
        open: true,
        conversationRef: 'native-conversation',
        artifactHandles: [{ execution: 1, handle: '/native', sourceJobId: jobId }],
      });
      expect(h.db.prepare('SELECT DISTINCT stream_kind FROM events').all()).toEqual([{ stream_kind: 'job' }]);
    } finally {
      h.db.close();
    }
  });
});
