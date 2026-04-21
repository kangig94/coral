import { describe, expect, it } from 'vitest';

import { loadKbNote, loadKbSource } from '../../../read.js';
import { REPAIR_INCIDENT_ID } from '../incident-ids.js';
import { expectedDetectedIncident, runRepairFixtureCase } from './helpers.js';

describe('repair fixtures: frontmatter shape', () => {
  it(`covers ${REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.UNTERMINATED_YAML} end to end`, async () => {
    await runRepairFixtureCase({
      fixture: 'frontmatter-shape-unterminated-yaml',
      classification: 'needs-manual',
      assertFailure(harness) {
        expect(() => loadKbNote(harness.path('notes/unterminated-yaml-note.md'))).toThrow('Missing YAML frontmatter');
      },
      expectedIncidents: [
        expectedDetectedIncident({
          canonical: REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.UNTERMINATED_YAML,
          entryId: 'note:unterminated-yaml-note',
          assertSignals(signals) {
            expect(signals).toMatchObject({
              frontmatterOpenerAtByte: 0,
            });
            expect((signals as { bytesAfterOpener?: unknown }).bytesAfterOpener).toBeGreaterThan(0);
          },
        }),
      ],
    });
  });

  it(`covers ${REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR} end to end`, async () => {
    await runRepairFixtureCase({
      fixture: 'frontmatter-shape-yaml-parse-error',
      classification: 'needs-manual',
      assertFailure(harness) {
        expect(() => loadKbNote(harness.path('notes/yaml-parse-error-note.md'))).toThrow(/yaml/i);
      },
      expectedIncidents: [
        expectedDetectedIncident({
          canonical: REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR,
          entryId: 'note:yaml-parse-error-note',
          assertSignals(signals) {
            expect(signals).toEqual({
              message: expect.any(String),
            });
          },
        }),
      ],
    });
  });

  it(`covers ${REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.MISSING_REQUIRED_FIELDS} end to end`, async () => {
    await runRepairFixtureCase({
      fixture: 'frontmatter-shape-missing-required-fields',
      classification: 'needs-manual',
      assertFailure(harness) {
        expect(() => loadKbSource(harness.path('sources/missing-required-fields-source.md'))).toThrow(
          'title must be a string',
        );
      },
      expectedIncidents: [
        expectedDetectedIncident({
          canonical: REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.MISSING_REQUIRED_FIELDS,
          entryId: 'source:missing-required-fields-source',
          assertSignals(signals) {
            expect(signals).toEqual({
              missingFields: ['title'],
              slug: 'missing-required-fields-source',
              frontmatterStatus: 'parsed',
            });
          },
        }),
      ],
    });
  });
});
