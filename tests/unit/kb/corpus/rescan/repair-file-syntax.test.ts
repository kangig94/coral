import { describe, expect, it } from 'vitest';

import { loadKbNote } from '#src/kb/read.js';
import { applyDetectedIncidentFixesLocked } from '#src/kb/corpus/rescan/auto-fix.js';
import { REPAIR_INCIDENT_ID } from '#src/kb/corpus/rescan/incidents/catalog.js';
import { curateDb } from '#src/kb/curate/db-access.js';
import { readCurateRetryQueue } from '#src/kb/curate/retry.js';
import {
  createRepairFixtureHarness,
  expectedDetectedIncident,
  runRepairFixtureCase,
} from '#tests/unit/kb/corpus/rescan/helpers.js';

describe('repair fixtures: file syntax', () => {
  it(`covers ${REPAIR_INCIDENT_ID.FILE_SYNTAX.CONFLICT_MARKERS} end to end`, async () => {
    await runRepairFixtureCase({
      fixture: 'file-syntax-conflict-markers',
      classification: 'needs-manual',
      assertFailure(harness) {
        const loaded = loadKbNote(harness.storage, harness.path('notes/conflict-markers-note.md'));
        expect(loaded.body).toContain('<<<<<<< ours');
        expect(loaded.body).toContain('>>>>>>> theirs');
      },
      expectedIncidents: [
        expectedDetectedIncident({
          canonical: REPAIR_INCIDENT_ID.FILE_SYNTAX.CONFLICT_MARKERS,
          entryId: 'note:conflict-markers-note',
          assertSignals(signals) {
            expect(signals).toEqual({
              matches: [
                { line: 13, marker: '<<<<<<<', text: '<<<<<<< ours' },
                { line: 15, marker: '=======', text: '=======' },
                { line: 17, marker: '>>>>>>>', text: '>>>>>>> theirs' },
              ],
            });
          },
        }),
      ],
    });
  });

  it(`covers ${REPAIR_INCIDENT_ID.FILE_SYNTAX.MALFORMED_MARKDOWN} end to end`, async () => {
    await runRepairFixtureCase({
      fixture: 'file-syntax-malformed-markdown',
      classification: 'needs-manual',
      assertFailure(harness) {
        const loaded = loadKbNote(harness.storage, harness.path('notes/malformed-markdown-note.md'));
        expect(loaded.body).toContain('```ts');
        expect(loaded.body).not.toContain('\n```\n');
      },
      expectedIncidents: [
        expectedDetectedIncident({
          canonical: REPAIR_INCIDENT_ID.FILE_SYNTAX.MALFORMED_MARKDOWN,
          entryId: 'note:malformed-markdown-note',
          assertSignals(signals) {
            expect(signals).toMatchObject({
              unmatchedFence: {
                line: 13,
                marker: '```',
                text: '```ts',
              },
            });
            expect(signals).not.toHaveProperty('atxHeaders');
            expect(signals).not.toHaveProperty('setextUnderlines');
          },
        }),
      ],
    });
  });

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
