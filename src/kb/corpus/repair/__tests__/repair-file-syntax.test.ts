import { describe, expect, it } from 'vitest';

import { loadKbNote } from '../../../read.js';
import { runRepairFixtureCase } from './helpers.js';

describe('repair fixtures: file syntax', () => {
  it('covers file-syntax/conflict-markers end to end', async () => {
    await runRepairFixtureCase({
      fixture: 'file-syntax-conflict-markers',
      classification: 'needs-manual',
      assertFailure(harness) {
        const loaded = loadKbNote(harness.path('notes/conflict-markers-note.md'));
        expect(loaded.body).toContain('<<<<<<< ours');
        expect(loaded.body).toContain('>>>>>>> theirs');
      },
      expectedIncidents: [
        {
          locus: 'file-syntax',
          canonical: 'file-syntax/conflict-markers',
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
        },
      ],
    });
  });

  it('covers file-syntax/malformed-markdown end to end', async () => {
    await runRepairFixtureCase({
      fixture: 'file-syntax-malformed-markdown',
      classification: 'needs-manual',
      assertFailure(harness) {
        const loaded = loadKbNote(harness.path('notes/malformed-markdown-note.md'));
        expect(loaded.body).toContain('```ts');
        expect(loaded.body).not.toContain('\n```\n');
      },
      expectedIncidents: [
        {
          locus: 'file-syntax',
          canonical: 'file-syntax/malformed-markdown',
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
        },
      ],
    });
  });
});
