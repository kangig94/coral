import { normalizePrincipleReference } from '../../frontmatter.js';
import { parseKbEntryId } from '../../../entry-types.js';
import { REPAIR_INCIDENT_ID, type DetectedIncident, type Detector } from './catalog.js';

const ORPHAN_ENTITY_GRAPH_REFS_CANONICAL = REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_ENTITY_GRAPH_REFS;
const ORPHAN_PRINCIPLE_REFS_CANONICAL = REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_PRINCIPLE_REFS;

type OrphanEntityGraphReference = {
  relationshipIndex: number;
  evidenceIndex: number;
  reference: string;
  normalizedEntryId?: string;
};

export const referenceIntegrityDetector: Detector = {
  detect(corpus) {
    const incidents: DetectedIncident[] = [];

    const entityGraphIncident = detectOrphanEntityGraphRefs(corpus);
    if (entityGraphIncident !== null) {
      incidents.push(entityGraphIncident);
    }

    for (const entry of corpus.markdownFiles) {
      if (entry.kind !== 'note' || entry.frontmatter.status !== 'parsed' || entry.frontmatter.record === null) {
        continue;
      }

      const orphanPrinciples = collectOrphanPrinciples(entry.frontmatter.record.principles, corpus.principleSlugs);
      if (orphanPrinciples.length === 0) {
        continue;
      }

      incidents.push({
        locus: 'reference-integrity',
        canonical: ORPHAN_PRINCIPLE_REFS_CANONICAL,
        entryId: entry.entryId,
        signals: {
          orphanPrinciples,
        },
      });
    }

    return incidents;
  },
};

function detectOrphanEntityGraphRefs(corpus: Parameters<Detector['detect']>[0]): DetectedIncident | null {
  if (corpus.entityGraph === null || corpus.entityGraph.graph === null) {
    return null;
  }

  const orphans: OrphanEntityGraphReference[] = [];
  for (
    let relationshipIndex = 0;
    relationshipIndex < corpus.entityGraph.graph.relationships.length;
    relationshipIndex += 1
  ) {
    const relationship = corpus.entityGraph.graph.relationships[relationshipIndex];
    if (relationship === undefined) {
      continue;
    }

    for (let evidenceIndex = 0; evidenceIndex < relationship.evidence.length; evidenceIndex += 1) {
      const reference = relationship.evidence[evidenceIndex];
      if (reference === undefined) {
        continue;
      }

      const normalized = parseKbEntryId(reference);
      if (normalized !== null && corpus.activeEntryIds.has(normalized)) {
        continue;
      }

      orphans.push({
        relationshipIndex,
        evidenceIndex,
        reference,
        ...(normalized === null ? {} : { normalizedEntryId: normalized }),
      });
    }
  }

  if (orphans.length === 0) {
    return null;
  }

  return {
    locus: 'reference-integrity',
    canonical: ORPHAN_ENTITY_GRAPH_REFS_CANONICAL,
    entryId: corpus.entityGraph.entryId,
    signals: {
      orphans,
    },
  };
}

function collectOrphanPrinciples(value: unknown, principleSlugs: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const missing = new Set<string>();

  for (const principle of value) {
    if (typeof principle !== 'string') {
      continue;
    }

    try {
      const normalized = normalizePrincipleReference(principle);
      if (!principleSlugs.has(normalized)) {
        missing.add(normalized);
      }
    } catch {
      continue;
    }
  }

  return [...missing].sort((left, right) => left.localeCompare(right));
}
