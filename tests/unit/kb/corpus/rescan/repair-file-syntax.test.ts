import { describe, expect, it } from 'vitest';
import { applyDetectedIncidentFixesLocked } from '#src/kb/corpus/rescan/auto-fix.js';
import { curateDb } from '#src/kb/curate/db-access.js';
import { readCurateRetryQueue } from '#src/kb/curate/retry.js';
import { createRepairFixtureHarness } from '#tests/unit/kb/corpus/rescan/helpers.js';

describe('repair fixtures: file syntax', () => {
  it('re-records an unchanged malformed-markdown incident as already-queued without churning the queue', async () => {
    const harness = createRepairFixtureHarness('file-syntax-malformed-markdown');
    try {
      const incidents = harness.detect();
      expect(incidents.length).toBeGreaterThan(0);

      const gitSync = { scheduleDeferredCommit: () => {} };
      const first = await harness.kb.withMutationLock((mutation) =>
        applyDetectedIncidentFixesLocked(harness.kb, mutation, gitSync, incidents),
      );
      expect(first.map((result) => result.action)).toEqual(incidents.map(() => 'enqueued'));
      const queueAfterFirst = readCurateRetryQueue(curateDb(harness.kb));
      expect(queueAfterFirst).toHaveLength(incidents.length);

      // A later rescan re-detects the same incident over identical content: it must
      // report 'already-queued' (so it is not re-logged) and leave the queue unchanged.
      const second = await harness.kb.withMutationLock((mutation) =>
        applyDetectedIncidentFixesLocked(harness.kb, mutation, gitSync, harness.detect()),
      );
      expect(second.map((result) => result.action)).toEqual(incidents.map(() => 'already-queued'));
      expect(readCurateRetryQueue(curateDb(harness.kb))).toEqual(queueAfterFirst);
    } finally {
      harness.cleanup();
    }
  });
});
