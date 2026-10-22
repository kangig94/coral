import { describe, expect, it } from 'vitest';

import { hashToken } from '#src/infra/hash.js';
import { readProjectionJobRow } from '#src/jobs/projection-row.js';
import {
  listProjectionConversationEntries,
  readProjectionJobConversation,
} from '#src/jobs/conversation/read-queries.js';
import {
  executionHarness,
  executionInput,
  EXECUTION_JOB_ID,
  openedJob,
  requestedExecution,
} from '#tests/helpers/job-executions.js';
import {
  TEST_CLAUDE_BINDING,
  withTestBindingLocation,
  TEST_CODEX_BINDING,
} from '#tests/helpers/provider-credentials.js';

const SECOND_JOB_ID = '10000000-0000-4000-8000-000000000002';
const THIRD_JOB_ID = '10000000-0000-4000-8000-000000000003';
const snapshot = { conversationRef: 'thread-c', resumable: true, providerContinuity: { checkpoint: 'saved' } };

function openExecution(h: ReturnType<typeof executionHarness>) {
  h.append(openedJob(), requestedExecution());
}

function acceptExecution(h: ReturnType<typeof executionHarness>, execution = 1): number {
  const appended = h.append(
    executionInput('job.execution.outcome.accepted', {
      execution,
      terminal: { content: 'done', durationMs: 0, outcome: { kind: 'completed' } },
    }),
  );
  const accepted = appended[0];
  if (accepted === undefined) throw new Error('Expected accepted outcome.');
  return accepted.seq;
}

function endExecution(h: ReturnType<typeof executionHarness>, execution: number, accepted: number) {
  h.append(
    executionInput('job.execution.ended', {
      execution,
      causeRef: { stream: { kind: 'job', id: EXECUTION_JOB_ID }, seq: accepted },
    }),
  );
}

describe('job conversation projections', () => {
  it('rejects unknown controller profile fields instead of normalizing persisted data', () => {
    const h = executionHarness();
    try {
      const opened = openedJob();
      if (opened.body.jobKind !== 'provider') throw new Error('Expected provider fixture.');
      const body = opened.body;
      expect(() =>
        h.append({
          ...opened,
          body: {
            ...body,
            conversation: {
              ...body.conversation,
              controllerProfile: { owner: 'team-a', claudeTransport: 'print' },
            },
          },
        }),
      ).toThrow();
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)).toBeNull();
    } finally {
      h.db.close();
    }
  });

  it('rejects a replay event that changes the persisted provider binding', () => {
    const h = executionHarness();
    try {
      openExecution(h);
      expect(() =>
        h.append(
          executionInput('job.continuity.checkpointed', {
            execution: 1,
            snapshot,
            binding: withTestBindingLocation(TEST_CODEX_BINDING, '/accounts/codex-b'),
          }),
        ),
      ).toThrow();
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)?.binding).toEqual({
        provider: 'codex',
        kind: 'profile',
        binding: {},
      });
    } finally {
      h.db.close();
    }
  });

  it('preserves conversation columns while executions open and close on the same job', () => {
    const h = executionHarness();
    try {
      openExecution(h);
      h.append(executionInput('job.continuity.checkpointed', { execution: 1, snapshot }));
      const before = readProjectionJobRow(h.db, EXECUTION_JOB_ID);
      h.complete();
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)).toMatchObject({
        jobId: EXECUTION_JOB_ID,
        execution: 1,
        open: false,
        conversationRef: 'thread-c',
      });
      h.append(requestedExecution(2));
      const after = readProjectionJobRow(h.db, EXECUTION_JOB_ID);
      expect(after).toMatchObject({
        execution: 2,
        resumable: 1,
        conversation_ref: 'thread-c',
        scope_key: before?.scope_key,
        facet: before?.facet,
        controller: before?.controller,
      });
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)?.open).toBe(true);
    } finally {
      h.db.close();
    }
  });

  it('tracks retention attempts by execution and replaces each request with its outcome', () => {
    const h = executionHarness();
    try {
      const base = openedJob();
      if (base.body.jobKind !== 'provider') throw new Error('Expected provider fixture.');
      h.append(
        openedJob({ conversation: { ...base.body.conversation, retention: 'discard_provider_artifacts_on_terminal' } }),
        requestedExecution(),
      );
      const accepted = acceptExecution(h);
      const action = { execution: 1, attempt: 1, handles: ['/tmp/handle.jsonl'] };
      h.append(executionInput('job.retention.discard.requested', action));
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)?.retentionDiscard.attempts).toEqual([
        { ...action, status: 'requested' },
      ]);
      h.append(executionInput('job.retention.discard.completed', { ...action, outcome: 'discarded' }));
      endExecution(h, 1, accepted);
      h.append(requestedExecution(2));
      const secondAccepted = acceptExecution(h, 2);
      const secondAction = { ...action, execution: 2 };
      h.append(executionInput('job.retention.discard.requested', secondAction));
      h.append(executionInput('job.retention.discard.failed', { ...secondAction, reason: 'provider unreachable' }));
      endExecution(h, 2, secondAccepted);
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)?.retentionDiscard.attempts).toEqual([
        { ...action, status: 'completed', outcome: 'discarded' },
        { ...secondAction, status: 'failed', reason: 'provider unreachable' },
      ]);
    } finally {
      h.db.close();
    }
  });

  it('rejects conversation and retention events before job.opened', () => {
    const h = executionHarness();
    try {
      for (const input of [
        executionInput('job.continuity.checkpointed', { execution: 1, snapshot }),
        executionInput('job.provider_failed', {
          execution: 1,
          provider: 'codex',
          reason: 'request_failed',
          message: 'reset',
        }),
        executionInput('job.retention.discard.requested', { execution: 1, attempt: 1, handles: [] }),
      ])
        expect(() => h.append(input)).toThrowError(expect.objectContaining({ code: 'job_execution_order_violation' }));
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)).toBeNull();
    } finally {
      h.db.close();
    }
  });

  it('rejects a conversation owner that does not match its job stream', () => {
    const h = executionHarness();
    try {
      expect(() => h.append(openedJob({ owner: { kind: 'provider-session', id: SECOND_JOB_ID } }))).toThrowError(
        expect.objectContaining({ code: 'job_execution_order_violation' }),
      );
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)).toBeNull();
    } finally {
      h.db.close();
    }
  });

  it('keeps the derived provider bound to the conversation binding across fault events', () => {
    const h = executionHarness();
    try {
      openExecution(h);
      h.append(
        executionInput('job.provider_failed', {
          execution: 1,
          provider: 'codex-alt',
          reason: 'session_unavailable',
          message: 'gone',
        }),
      );
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)).toMatchObject({
        provider: 'codex',
        binding: { provider: 'codex' },
      });
      h.append(
        executionInput('job.adapter_unparseable', {
          execution: 1,
          provider: 'codex-raw',
          exitCode: null,
          stdout: '',
          stderr: '',
          parseError: 'unexpected EOF',
        }),
      );
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)?.provider).toBe('codex');
    } finally {
      h.db.close();
    }
  });

  it('keeps checkpointed continuity when the execution is interrupted', () => {
    const h = executionHarness();
    try {
      openExecution(h);
      h.append(executionInput('job.continuity.checkpointed', { execution: 1, snapshot }));
      h.append(
        executionInput('job.interrupted', { execution: 1, trigger: 'handoff', continuity: 'pre_checkpoint_preserved' }),
      );
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)).toMatchObject({
        conversationRef: 'thread-c',
        providerContinuity: { checkpoint: 'saved' },
        execution: 1,
      });
    } finally {
      h.db.close();
    }
  });

  it('rejects corrupt or contradictory stored conversation facets', () => {
    const h = executionHarness();
    try {
      h.append(openedJob());
      const row = readProjectionJobRow(h.db, EXECUTION_JOB_ID);
      if (row?.facet === null || row === null) throw new Error('Expected conversation facet.');
      for (const facet of [
        'not json',
        '{}',
        JSON.stringify({ ...JSON.parse(row.facet), provider: 'other-provider' }),
      ]) {
        h.db.prepare('UPDATE projection_jobs SET facet = ? WHERE job_id = ?').run(facet, EXECUTION_JOB_ID);
        expect(() => readProjectionJobConversation(h.db, EXECUTION_JOB_ID)).toThrow();
      }
    } finally {
      h.db.close();
    }
  });

  it('lists conversations ordered by job id and filtered by provider and project scope', () => {
    const h = executionHarness();
    try {
      const base = openedJob();
      if (base.body.jobKind !== 'provider') throw new Error('Expected provider fixture.');
      h.append(
        base,
        executionInput(
          'job.opened',
          {
            ...base.body,
            owner: { kind: 'provider-session', id: SECOND_JOB_ID },
            conversation: { ...base.body.conversation, provider: 'claude', binding: TEST_CLAUDE_BINDING },
          },
          SECOND_JOB_ID,
        ),
        executionInput(
          'job.opened',
          { ...base.body, projectRoot: '/other-project', owner: { kind: 'provider-session', id: THIRD_JOB_ID } },
          THIRD_JOB_ID,
        ),
      );
      expect(listProjectionConversationEntries(h.db).map((entry) => entry.jobId)).toEqual([
        EXECUTION_JOB_ID,
        SECOND_JOB_ID,
        THIRD_JOB_ID,
      ]);
      expect(listProjectionConversationEntries(h.db, 'codex').map((entry) => entry.jobId)).toEqual([
        EXECUTION_JOB_ID,
        THIRD_JOB_ID,
      ]);
      expect(
        listProjectionConversationEntries(h.db, undefined, hashToken('/workspace', 12)).map((entry) => entry.jobId),
      ).toEqual([EXECUTION_JOB_ID, SECOND_JOB_ID]);
      expect(
        listProjectionConversationEntries(h.db, 'codex', hashToken('/other-project', 12)).map((entry) => entry.jobId),
      ).toEqual([THIRD_JOB_ID]);
      expect(listProjectionConversationEntries(h.db, 'gemini')).toEqual([]);
    } finally {
      h.db.close();
    }
  });
});
