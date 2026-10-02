import { describe, expect, it } from 'vitest';

import { loadKbNote } from '#src/kb/read.js';
import { REPAIR_INCIDENT_ID } from '#src/kb/corpus/rescan/incidents/catalog.js';
import { expectedDetectedIncident, runRepairFixtureCase } from '#tests/unit/kb/corpus/rescan/helpers.js';

describe('repair fixtures: frontmatter shape', () => {
  it(`covers ${REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR} end to end`, async () => {
    await runRepairFixtureCase({
      fixture: 'frontmatter-shape-yaml-parse-error',
      classification: 'needs-manual',
      assertFailure(harness) {
        expect(() => loadKbNote(harness.storage, harness.path('notes/yaml-parse-error-note.md'))).toThrow(/yaml/i);
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
});
