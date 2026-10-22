import { describe, expect, it } from 'vitest';

import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { readProjectionJobConversation } from '#src/jobs/conversation/read-queries.js';
import {
  EXECUTION_JOB_ID as jobId,
  executionHarness,
  openedJob,
  requestedExecution,
} from '#tests/helpers/job-executions.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

describe('job conversation continuity', () => {
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
