import { describe, expect, it } from 'vitest';

import { loadKbNote, loadKbSource } from '../../../read.js';
import { runRepairFixtureCase } from './helpers.js';

describe('repair fixtures: identity sequence', () => {
  it('covers identity-sequence/entryseq-collision end to end', async () => {
    await runRepairFixtureCase({
      fixture: 'identity-sequence-entryseq-collision',
      classification: 'needs-manual',
      assertFailure(harness) {
        expect(loadKbNote(harness.path('notes/collision-alpha.md')).frontmatter.entrySeq).toBe(21);
        expect(loadKbSource(harness.path('sources/collision-beta.md')).frontmatter.entrySeq).toBe(21);
      },
      expectedIncidents: [
        {
          locus: 'identity-sequence',
          canonical: 'identity-sequence/entryseq-collision',
          entryId: 'note:collision-alpha',
          assertSignals(signals) {
            expect(signals).toEqual({
              entrySeq: 21,
              colliders: ['note:collision-alpha', 'source:collision-beta'],
            });
          },
        },
        {
          locus: 'identity-sequence',
          canonical: 'identity-sequence/entryseq-collision',
          entryId: 'source:collision-beta',
          assertSignals(signals) {
            expect(signals).toEqual({
              entrySeq: 21,
              colliders: ['note:collision-alpha', 'source:collision-beta'],
            });
          },
        },
      ],
    });
  });

  it('covers identity-sequence/entryseq-format end to end', async () => {
    await runRepairFixtureCase({
      fixture: 'identity-sequence-entryseq-format',
      classification: 'auto-fixable',
      assertFailure(harness) {
        expect(() => loadKbNote(harness.path('notes/entryseq-format-note.md'))).toThrow(
          'entrySeq must be a positive integer',
        );
      },
      assertResolved(harness) {
        const raw = harness.readText('notes/entryseq-format-note.md');
        expect(raw).toContain('entrySeq: 31');
        expect(raw).not.toContain('entrySeq: "31"');
        expect(loadKbNote(harness.path('notes/entryseq-format-note.md')).frontmatter.entrySeq).toBe(31);
      },
      expectedIncidents: [
        {
          locus: 'identity-sequence',
          canonical: 'identity-sequence/entryseq-format',
          entryId: 'note:entryseq-format-note',
          assertSignals(signals) {
            expect(signals).toEqual({
              reasons: ['quoted-decimal'],
              quotedDecimal: 'entrySeq: "31"',
              parsedType: 'string',
              normalizedValue: 31,
            });
          },
        },
      ],
    });
  });
});
