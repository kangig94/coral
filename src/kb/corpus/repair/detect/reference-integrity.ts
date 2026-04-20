import { normalizePrincipleReference } from '../../frontmatter.js';
import { parseKbEntryId } from '../../../entry-types.js';
import type { DetectedIncident, Detector } from '../types.js';

const ORPHAN_ENTITY_GRAPH_REFS_CANONICAL = 'reference-integrity/orphan-entity-graph-refs';
const ORPHAN_PRINCIPLE_REFS_CANONICAL = 'reference-integrity/orphan-principle-refs';

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
  if (corpus.entityGraph === null || corpus.entityGraph.relationships === null) {
    return null;
  }

  const orphans = corpus.entityGraph.relationships.flatMap((relationship, relationshipIndex) =>
    relationship.evidence.flatMap((reference, evidenceIndex) => {
      const normalized = parseKbEntryId(reference);
      if (normalized !== null && corpus.activeEntryIds.has(normalized)) {
        return [];
      }

      return [
        {
          relationshipIndex,
          evidenceIndex,
          reference,
          ...(normalized === null ? {} : { normalizedEntryId: normalized }),
        },
      ];
    }),
  );

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
