import { describe, expect, it } from 'vitest';

import { jobArtifactRecordedBodySchema } from '#src/jobs/event-bodies.js';
import { readProjectionJobConversation } from '#src/jobs/conversation/read-queries.js';
import { providerArtifactIdentityKey } from '#src/providers/artifact-identity.js';
import {
  executionHarness,
  executionInput,
  EXECUTION_JOB_ID,
  openedJob,
  requestedExecution,
} from '#tests/helpers/job-executions.js';

describe('job conversation reducer equivalence', () => {
  it('requires artifact identity and execution ownership to match the conversation exactly', () => {
    const h = executionHarness();
    try {
      h.append(openedJob(), requestedExecution());
      const identity = { kind: 'codex-rollout', threadId: 'thread-artifact' };
      const identityKey = providerArtifactIdentityKey('codex', identity);
      const artifact = { execution: 1, provider: 'codex', handle: '/tmp/codex/rollout.jsonl', identity, identityKey };
      expect(() =>
        jobArtifactRecordedBodySchema.parse({ ...artifact, identityKey: 'not-derived-from-binding' }),
      ).toThrow();
      expect(() => h.append(executionInput('job.artifact.recorded', { ...artifact, execution: 2 }))).toThrow();
      const { execution: _execution, ...withoutExecution } = artifact;
      expect(() => jobArtifactRecordedBodySchema.parse(withoutExecution)).toThrow();
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)?.artifactHandles).toEqual([]);
      h.append(executionInput('job.artifact.recorded', artifact));
      expect(readProjectionJobConversation(h.db, EXECUTION_JOB_ID)?.artifactHandles).toEqual([
        expect.objectContaining({
          execution: 1,
          handle: artifact.handle,
          identity,
          identityKey,
          sourceJobId: EXECUTION_JOB_ID,
        }),
      ]);
    } finally {
      h.db.close();
    }
  });
});
