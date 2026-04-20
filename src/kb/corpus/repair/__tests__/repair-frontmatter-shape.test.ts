import { describe, expect, it } from 'vitest';

import { loadKbNote, loadKbSource } from '../../../read.js';
import { runRepairFixtureCase } from './helpers.js';

describe('repair fixtures: frontmatter shape', () => {
  it('covers frontmatter-shape/unterminated-yaml end to end', async () => {
    await runRepairFixtureCase({
      fixture: 'frontmatter-shape-unterminated-yaml',
      classification: 'needs-manual',
      assertFailure(harness) {
        expect(() => loadKbNote(harness.path('notes/unterminated-yaml-note.md'))).toThrow('Missing YAML frontmatter');
      },
      expectedIncidents: [
        {
          locus: 'frontmatter-shape',
          canonical: 'frontmatter-shape/unterminated-yaml',
          entryId: 'note:unterminated-yaml-note',
          assertSignals(signals) {
            expect(signals).toMatchObject({
              frontmatterOpenerAtByte: 0,
            });
            expect((signals as { bytesAfterOpener?: unknown }).bytesAfterOpener).toBeGreaterThan(0);
          },
        },
      ],
    });
  });

  it('covers frontmatter-shape/yaml-parse-error end to end', async () => {
    await runRepairFixtureCase({
      fixture: 'frontmatter-shape-yaml-parse-error',
      classification: 'needs-manual',
      assertFailure(harness) {
        expect(() => loadKbNote(harness.path('notes/yaml-parse-error-note.md'))).toThrow(/yaml/i);
      },
      expectedIncidents: [
        {
          locus: 'frontmatter-shape',
          canonical: 'frontmatter-shape/yaml-parse-error',
          entryId: 'note:yaml-parse-error-note',
          assertSignals(signals) {
            expect(signals).toEqual({
              message: expect.any(String),
            });
          },
        },
      ],
    });
  });

  it('covers frontmatter-shape/missing-required-fields end to end', async () => {
    await runRepairFixtureCase({
      fixture: 'frontmatter-shape-missing-required-fields',
      classification: 'needs-manual',
      assertFailure(harness) {
        expect(() => loadKbSource(harness.path('sources/missing-required-fields-source.md'))).toThrow(
          'title must be a string',
        );
      },
      expectedIncidents: [
        {
          locus: 'frontmatter-shape',
          canonical: 'frontmatter-shape/missing-required-fields',
          entryId: 'source:missing-required-fields-source',
          assertSignals(signals) {
            expect(signals).toEqual({
              missingFields: ['title'],
              slug: 'missing-required-fields-source',
              frontmatterStatus: 'parsed',
            });
          },
        },
      ],
    });
  });
});
