import { describe, expect, it } from 'vitest';
import { REPAIR_INCIDENT_ID } from '#src/kb/corpus/rescan/incidents/catalog.js';
import { expectedDetectedIncident, runRepairFixtureCase } from '#tests/unit/kb/corpus/rescan/helpers.js';

describe('repair fixtures: reference integrity', () => {
  it(`covers ${REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_ENTITY_GRAPH_REFS} end to end`, async () => {
    await runRepairFixtureCase({
      fixture: 'reference-integrity-orphan-entity-graph-refs',
      classification: 'auto-fixable',
      assertFailure(harness) {
        const graph = harness.kb.readEntityGraph();
        expect(graph).not.toBeNull();
        expect(graph?.relationships).toHaveLength(2);
        expect(graph?.relationships[0]?.evidence).toContain('note:missing-note');
        expect(graph?.relationships[1]?.evidence).toContain('source:missing-source');
      },
      assertResolved(harness) {
        const graph = harness.kb.readEntityGraph();
        expect(graph).not.toBeNull();
        expect(graph?.relationships).toEqual([
          {
            source: 'anchor',
            target: 'anchor',
            type: 'implements',
            description: 'anchor evidence',
            evidence: ['note:graph-anchor'],
          },
        ]);
      },
      expectedIncidents: [
        expectedDetectedIncident({
          canonical: REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_ENTITY_GRAPH_REFS,
          entryId: 'entity-graph:.entity-graph.json',
          assertSignals(signals) {
            expect(signals).toEqual({
              orphans: [
                {
                  relationshipIndex: 0,
                  evidenceIndex: 1,
                  reference: 'note:missing-note',
                  normalizedEntryId: 'note:missing-note',
                },
                {
                  relationshipIndex: 1,
                  evidenceIndex: 0,
                  reference: 'source:missing-source',
                  normalizedEntryId: 'source:missing-source',
                },
              ],
            });
          },
        }),
      ],
    });
  });
});
