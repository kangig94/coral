import { describe, expect, it } from 'vitest';

import type { ProviderLookupPort } from '#src/providers/catalog.js';
import {
  listProjectionConversationEntries,
  readProjectionJobConversation,
} from '#src/jobs/conversation/read-queries.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import {
  executionHarness,
  executionInput,
  EXECUTION_JOB_ID,
  openedJob,
  requestedExecution,
  OTHER_EXECUTION_JOB_ID,
} from '#tests/helpers/job-executions.js';
import { TEST_CLAUDE_BINDING } from '#tests/helpers/provider-credentials.js';

const snapshot = { conversationRef: null, resumable: false, providerContinuity: null };

function countEvents(h: ReturnType<typeof executionHarness>): number {
  return h.db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM events').get()?.count ?? 0;
}

describe('projection conversation provider authority', () => {
  it('rejects job.opened snapshots that already carry an execution claim', () => {
    const h = executionHarness();
    try {
      const opened = openedJob();
      expect(() => h.append({ ...opened, body: { ...opened.body, execution: 1 } })).toThrow();
      expect(countEvents(h)).toBe(0);
    } finally {
      h.db.close();
    }
  });

  it('rejects continuity checkpoints that inject or clear execution ownership', () => {
    const h = executionHarness();
    try {
      h.append(openedJob(), requestedExecution());
      for (const ownership of [{ execution: 2 }, { execution: null }]) {
        expect(() => h.append(executionInput('job.continuity.checkpointed', { ...ownership, snapshot }))).toThrow();
      }
      expect(countEvents(h)).toBe(2);
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)).toMatchObject({
        jobId: EXECUTION_JOB_ID,
        execution: 1,
        open: true,
      });
    } finally {
      h.db.close();
    }
  });

  it('rejects corrupt execution claims atomically', () => {
    const h = executionHarness();
    try {
      h.append(openedJob());
      expect(() => h.append(requestedExecution(2))).toThrowError(
        expect.objectContaining({ code: 'job_execution_order_violation' }),
      );
      expect(countEvents(h)).toBe(1);
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)?.execution).toBe(0);
    } finally {
      h.db.close();
    }
  });

  it('rejects corrupt execution releases atomically', () => {
    const h = executionHarness();
    try {
      h.append(openedJob(), requestedExecution());
      expect(() =>
        h.append(
          executionInput('job.execution.ended', {
            execution: 1,
            causeRef: { stream: { kind: 'job', id: EXECUTION_JOB_ID }, seq: 1 },
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'job_execution_order_violation' }));
      expect(countEvents(h)).toBe(2);
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)?.open).toBe(true);
    } finally {
      h.db.close();
    }
  });

  it('requires job.opened to name a registered provider whose codec accepts the binding', () => {
    const cases: ProviderLookupPort[] = [
      {
        hasProvider: () => false,
        validatePersistedBinding: () => ({ ok: false, message: 'unregistered' }),
        validatePersistedScope: () => ({ ok: false, message: 'unregistered' }),
      },
      {
        hasProvider: () => true,
        validatePersistedBinding: () => ({ ok: false, message: 'provider codec rejected fixture' }),
        validatePersistedScope: () => ({ ok: false, message: 'provider codec rejected fixture' }),
      },
    ];
    for (const providers of cases) {
      const h = executionHarness();
      try {
        expect(() => commitInputs(h.db, [openedJob()], { ...h.ctx, providers })).toThrowError(
          expect.objectContaining({ code: 'job_execution_order_violation' }),
        );
        expect(countEvents(h)).toBe(0);
        expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)).toBeNull();
      } finally {
        h.db.close();
      }
    }
  });

  it('accepts job.opened only after the provider binding codec boundary succeeds', () => {
    const h = executionHarness();
    try {
      h.append(openedJob());
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)?.provider).toBe('codex');
    } finally {
      h.db.close();
    }
  });

  it('derives provider reads and filtering solely from the persisted conversation binding', () => {
    const h = executionHarness();
    try {
      const opened = openedJob();
      if (opened.body.jobKind !== 'provider') throw new Error('Expected provider fixture.');
      h.append(
        opened,
        executionInput(
          'job.opened',
          {
            ...opened.body,
            owner: { kind: 'provider-session', id: OTHER_EXECUTION_JOB_ID },
            conversation: { ...opened.body.conversation, provider: 'claude', binding: TEST_CLAUDE_BINDING },
          },
          OTHER_EXECUTION_JOB_ID,
        ),
      );
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)?.provider).toBe('codex');
      expect(readProjectionJobConversation(h.db, OTHER_EXECUTION_JOB_ID)?.provider).toBe('claude');
      expect(listProjectionConversationEntries(h.db, 'codex').map((entry) => entry.jobId)).toEqual([EXECUTION_JOB_ID]);
      expect(listProjectionConversationEntries(h.db, 'claude').map((entry) => entry.jobId)).toEqual([
        OTHER_EXECUTION_JOB_ID,
      ]);
    } finally {
      h.db.close();
    }
  });
});
