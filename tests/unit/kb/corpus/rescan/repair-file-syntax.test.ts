import { describe, expect, it } from 'vitest';

import { loadKbNote } from '#src/kb/read.js';
import { REPAIR_INCIDENT_ID } from '#src/kb/corpus/rescan/incidents/catalog.js';
import { expectedDetectedIncident, runRepairFixtureCase } from '#tests/unit/kb/corpus/rescan/helpers.js';

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
});
