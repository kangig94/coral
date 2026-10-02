import { describe, expect, it } from 'vitest';

import { loadKbNote } from '#src/kb/read.js';
import { REPAIR_INCIDENT_ID } from '#src/kb/corpus/rescan/incidents/catalog.js';
import { expectedDetectedIncident, runRepairFixtureCase } from '#tests/unit/kb/corpus/rescan/helpers.js';

describe('repair fixtures: identity sequence', () => {
  it(`covers ${REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_FORMAT} end to end`, async () => {
    await runRepairFixtureCase({
      fixture: 'identity-sequence-entryseq-format',
      classification: 'auto-fixable',
      assertFailure(harness) {
        expect(() => loadKbNote(harness.storage, harness.path('notes/entryseq-format-note.md'))).toThrow(
          'entrySeq must be a positive integer',
        );
      },
      assertResolved(harness) {
        const raw = harness.readText('notes/entryseq-format-note.md');
        expect(raw).toContain('entrySeq: 31');
        expect(raw).not.toContain('entrySeq: "31"');
        expect(loadKbNote(harness.storage, harness.path('notes/entryseq-format-note.md')).frontmatter.entrySeq).toBe(
          31,
        );
      },
      expectedIncidents: [
        expectedDetectedIncident({
          canonical: REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_FORMAT,
          entryId: 'note:entryseq-format-note',
          assertSignals(signals) {
            expect(signals).toEqual({
              reasons: ['quoted-decimal'],
              quotedDecimal: 'entrySeq: "31"',
              parsedType: 'string',
              normalizedValue: 31,
            });
          },
        }),
      ],
    });
  });
});
