import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createCorpusEntityGraphScan,
  createCorpusMarkdownFileScan,
  createCorpusScanView,
} from '#src/kb/corpus/rescan/scan.js';
import { detectEntityGraphDrift, detectIncidentRetryDrift } from '#src/kb/corpus/rescan/drift.js';
import {
  REPAIR_INCIDENT_ID,
  repairIncidentLocus,
  type DetectedIncident,
} from '#src/kb/corpus/rescan/incidents/catalog.js';
import type { PendingRepair } from '#src/kb/curate/state/model.js';
import { type EntityGraph, noteEntryId } from '#src/kb/entry-types.js';

const CANONICAL = REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function noteScan(slug: string, content: string) {
  return createCorpusScanView({
    markdownFiles: [
      createCorpusMarkdownFileScan({
        kind: 'note',
        path: `/virtual/notes/${slug}.md`,
        slug,
        content,
      }),
    ],
    entityGraph: null,
  });
}

// canonical incident ID is not an input to drift detection — drift compares
// entryId set membership and observed content hash, not incident type.
// YAML_PARSE_ERROR is used as a fixed sentinel.
function pendingRepair(slug: string, content: string): PendingRepair {
  return {
    entryId: noteEntryId(slug),
    entrySeq: null,
    detectedAt: '2026-04-27T00:00:00.000Z',
    observedContentHash: sha256(content),
    reason: CANONICAL,
    locus: repairIncidentLocus(CANONICAL),
    canonicalIncident: CANONICAL,
    signalsJson: '{}',
    repairHint: 'fix it',
    retryNotBefore: '2026-04-27T00:00:00.000Z',
    retryCount: 0,
  };
}

function detectedIncident(slug: string): DetectedIncident {
  return {
    canonical: CANONICAL,
    locus: repairIncidentLocus(CANONICAL),
    entryId: noteEntryId(slug),
    signals: {},
  } as DetectedIncident;
}

describe('detectIncidentRetryDrift', () => {
  it('returns "both" when matched entry has a content-hash drift', () => {
    const slug = 'edited-but-still-broken';
    const queuedContent = 'first broken version';
    const currentContent = 'second broken version';
    const scan = noteScan(slug, currentContent);
    expect(detectIncidentRetryDrift([pendingRepair(slug, queuedContent)], [detectedIncident(slug)], scan)).toBe('both');
  });
});

describe('detectEntityGraphDrift', () => {
  const indexedGraph: EntityGraph = {
    entityMeta: {
      coral: { type: 'technology', description: 'The Coral KB runtime.' },
    },
    relationships: [
      {
        source: 'coral',
        target: 'kb',
        type: 'enables',
        description: 'Coral enables KB workflows.',
        evidence: ['note:coral-note'],
      },
    ],
  };

  function entityGraphScan(graph: EntityGraph) {
    return createCorpusEntityGraphScan({
      content: `${JSON.stringify(graph, null, 2)}\n`,
      path: '/virtual/.entity-graph.json',
    });
  }

  it('returns "metadata" when entityMeta differs', () => {
    const editedGraph: EntityGraph = {
      ...indexedGraph,
      entityMeta: {
        coral: { type: 'technology', description: 'Updated description.' },
      },
    };
    expect(detectEntityGraphDrift(entityGraphScan(editedGraph), indexedGraph)).toBe('metadata');
  });
});
