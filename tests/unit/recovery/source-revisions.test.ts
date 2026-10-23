import { providerArtifactIdentityKey } from '#src/providers/artifact-identity.js';
import { describe, expect, it } from 'vitest';

import { RecoveryContainment, type RecoverySource } from '#src/recovery/containment.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { createRetentionWorkRetryPlan } from '#src/jobs/conversation/lifecycle-reactor.js';
import { appendJobExecutionOutcomeAccepted, appendJobExecutionEnded } from '#src/jobs/terminal/recording.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { staleJobCleanupSource } from '#src/jobs/stale-job-cleanup-recovery-source.js';
import { coordinatorJobRecoverySource } from '#src/coordinator/services/recovery/coordinator-job-source.js';
import {
  executionHarness,
  executionInput,
  EXECUTION_JOB_ID,
  OTHER_EXECUTION_JOB_ID,
  EXECUTION_NOW,
  openedJob,
  requestedExecution,
} from '#tests/helpers/job-executions.js';
import { conversationRetentionHarness } from '#tests/helpers/conversation-retention.js';

const REVISION_TIME = { now: () => Date.parse(EXECUTION_NOW) };

function createCoordinatorRevisionHarness() {
  const h = executionHarness();
  h.append(openedJob(), requestedExecution());
  return h;
}

async function quarantineRawSource<Raw>(
  source: RecoverySource<Raw>,
  quarantine: RecoveryQuarantineStore,
  onSettle: () => void,
) {
  return RecoveryContainment.each(source, {
    signal: new AbortController().signal,
    quarantine,
    processLocalCleanup: { kind: 'not-required' },
    hydrate: (raw) => raw,
    requiredObligations: () => [],
    settle: () => {
      onSettle();
      return { kind: 'quarantine', detail: 'retain current source revision' };
    },
    onFault: ({ error }) => ({ kind: 'fatal', error }),
  });
}

describe('coordinator job recovery source revisions', () => {
  it('treats a raw row with no stable job subject as a source-wide fatal fault', async () => {
    const h = createCoordinatorRevisionHarness();
    try {
      h.db.prepare('UPDATE projection_jobs SET job_id = ? WHERE job_id = ?').run('', EXECUTION_JOB_ID);
      await expect(
        quarantineRawSource(
          coordinatorJobRecoverySource(h.db),
          new RecoveryQuarantineStore(h.db, REVISION_TIME),
          () => {},
        ),
      ).rejects.toThrow('Recovery revision key must be a non-empty string');
    } finally {
      h.db.close();
    }
  });
});

describe('job conversation recovery source revisions', () => {
  it('keeps a workflow terminal out of provider retention work', async () => {
    const h = conversationRetentionHarness({ autoObserve: false });
    try {
      h.reactor.admitRetention();
      h.start();
      h.accept();
      await h.request();
      const request = h.events().find((event) => event.type === 'job.retention.discard.requested');
      if (request === undefined) throw new Error('Expected retention request.');
      h.append(
        executionInput(
          'job.opened',
          {
            jobKind: 'workflow',
            owner: { kind: 'workflow', id: OTHER_EXECUTION_JOB_ID },
            projectRoot: '/workspace',
            cwd: fixtureCanonicalWorkDir('/workspace'),
            bypassPermissions: false,
            createdAt: EXECUTION_NOW,
          },
          OTHER_EXECUTION_JOB_ID,
        ),
        {
          ...requestedExecution(),
          stream: { kind: 'job', id: OTHER_EXECUTION_JOB_ID },
        },
      );
      h.commit((c) => {
        const accepted = appendJobExecutionOutcomeAccepted(c, {
          jobId: OTHER_EXECUTION_JOB_ID,
          execution: 1,
          terminal: { content: 'workflow completed', durationMs: 0, outcome: { kind: 'completed' } },
        });
        appendJobExecutionEnded(c, { jobId: OTHER_EXECUTION_JOB_ID, execution: 1, causeRef: accepted });
        return undefined;
      });
      const quarantine = new RecoveryQuarantineStore(h.db, REVISION_TIME);
      const scanned: number[] = [];
      const plan = createRetentionWorkRetryPlan(
        h.db,
        {
          key: `${EXECUTION_JOB_ID}:1:1`,
          revision: { kind: 'until-cleared' },
        },
        h.lifetime.signal,
      );

      await RecoveryContainment.each(plan.source, {
        signal: h.lifetime.signal,
        quarantine,
        processLocalCleanup: { kind: 'not-required' },
        hydrate: (row) => row,
        requiredObligations: () => [],
        settle: (row) => {
          scanned.push(row.seq);
          return { kind: 'advanced', outcome: 'settled', facts: [], detail: 'observed retention request' };
        },
        onFault: ({ error }) => ({ kind: 'fatal', error }),
      });

      expect(scanned).toEqual([request.seq]);
      expect(quarantine.list()).toEqual([]);
      expect(h.providerEffects).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('re-attempts a composite after its persisted conversation evidence changes', async () => {
    const h = createCoordinatorRevisionHarness();
    try {
      const quarantine = new RecoveryQuarantineStore(h.db, REVISION_TIME);
      let settlements = 0;
      const run = () => quarantineRawSource(coordinatorJobRecoverySource(h.db), quarantine, () => (settlements += 1));

      await run();
      expect(settlements).toBe(1);
      expect((await run()).skipped).toBe(1);
      h.append(
        executionInput('job.artifact.recorded', {
          execution: 1,
          provider: 'codex',
          handle: '/tmp/revision-artifact.jsonl',
          identity: { kind: 'fixture', handle: '/tmp/revision-artifact.jsonl' },
          identityKey: providerArtifactIdentityKey('codex', {
            kind: 'fixture',
            handle: '/tmp/revision-artifact.jsonl',
          }),
        }),
      );
      await run();
      expect(settlements).toBe(2);
      expect((await run()).skipped).toBe(1);
      expect(settlements).toBe(2);
    } finally {
      h.db.close();
    }
  });
});

describe('lifecycle recovery source revisions', () => {
  it('re-attempts stale artifact cleanup when its terminal phase changes', async () => {
    const h = createCoordinatorRevisionHarness();
    try {
      h.complete();
      const quarantine = new RecoveryQuarantineStore(h.db, REVISION_TIME);
      let settlements = 0;
      const run = () => quarantineRawSource(staleJobCleanupSource(h.db), quarantine, () => (settlements += 1));
      await run();
      expect(settlements).toBe(1);
      expect((await run()).skipped).toBe(1);
      h.db.prepare('UPDATE projection_jobs SET phase = ? WHERE job_id = ?').run('aborted', EXECUTION_JOB_ID);
      await run();
      expect(settlements).toBe(2);
      expect((await run()).skipped).toBe(1);
      expect(settlements).toBe(2);
    } finally {
      h.db.close();
    }
  });
});
