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
  });
}

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
  it('returns null when both queue and incidents are empty', () => {
    const scan = createCorpusScanView({ markdownFiles: [] });
    expect(detectIncidentRetryDrift([], [], scan)).toBeNull();
  });

  it('returns null when queue and incidents are identical and content unchanged', () => {
    const slug = 'broken';
    const content = 'frontmatter: [unterminated';
    const scan = noteScan(slug, content);
    expect(
      detectIncidentRetryDrift([pendingRepair(slug, content)], [detectedIncident(slug)], scan),
    ).toBeNull();
  });

  it('returns "both" when retry queue has an entry no longer matching any current incident', () => {
    const slug = 'fixed-externally';
    const queuedContent = 'old broken content';
    const scan = noteScan(slug, 'now valid');
    expect(detectIncidentRetryDrift([pendingRepair(slug, queuedContent)], [], scan)).toBe('both');
  });

  it('returns "both" when current incidents have an entry not in the retry queue', () => {
    const slug = 'newly-broken';
    const scan = noteScan(slug, 'broken');
    expect(detectIncidentRetryDrift([], [detectedIncident(slug)], scan)).toBe('both');
  });

  it('returns "both" when matched entry has a content-hash drift', () => {
    const slug = 'edited-but-still-broken';
    const queuedContent = 'first broken version';
    const currentContent = 'second broken version';
    const scan = noteScan(slug, currentContent);
    expect(
      detectIncidentRetryDrift([pendingRepair(slug, queuedContent)], [detectedIncident(slug)], scan),
    ).toBe('both');
  });

  it('returns "both" for a legacy queue row with no observed content hash', () => {
    const slug = 'legacy';
    const scan = noteScan(slug, 'broken');
    const row: PendingRepair = {
      entryId: noteEntryId(slug),
      entrySeq: null,
      detectedAt: '2026-04-27T00:00:00.000Z',
      reason: 'pending-repair',
    };
    expect(detectIncidentRetryDrift([row], [detectedIncident(slug)], scan)).toBe('both');
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

  it('returns null when scan and index agree', () => {
    expect(detectEntityGraphDrift(entityGraphScan(indexedGraph), indexedGraph)).toBeNull();
  });

  it('returns null when scan is missing AND index has no entity data', () => {
    expect(detectEntityGraphDrift(null, { entityMeta: {}, relationships: [] })).toBeNull();
  });

  it('returns "metadata" when entityMeta differs', () => {
    const editedGraph: EntityGraph = {
      ...indexedGraph,
      entityMeta: {
        coral: { type: 'technology', description: 'Updated description.' },
      },
    };
    expect(detectEntityGraphDrift(entityGraphScan(editedGraph), indexedGraph)).toBe('metadata');
  });

  it('returns "metadata" when relationships differ', () => {
    const editedGraph: EntityGraph = {
      entityMeta: indexedGraph.entityMeta,
      relationships: [
        {
          source: 'coral',
          target: 'kb',
          type: 'enables',
          description: 'New description.',
          evidence: ['note:coral-note'],
        },
      ],
    };
    expect(detectEntityGraphDrift(entityGraphScan(editedGraph), indexedGraph)).toBe('metadata');
  });

  it('returns "metadata" when relationship order changes (writes are order-significant)', () => {
    const indexedTwoRel: EntityGraph = {
      entityMeta: {},
      relationships: [
        { source: 'a', target: 'b', type: 'enables', description: 'one', evidence: ['note:x'] },
        { source: 'c', target: 'd', type: 'requires', description: 'two', evidence: ['note:y'] },
      ],
    };
    const reordered: EntityGraph = {
      entityMeta: {},
      relationships: [indexedTwoRel.relationships[1], indexedTwoRel.relationships[0]],
    };
    expect(detectEntityGraphDrift(entityGraphScan(reordered), indexedTwoRel)).toBe('metadata');
  });

  it('returns "metadata" when the entity-graph file is removed but the index still has data', () => {
    expect(detectEntityGraphDrift(null, indexedGraph)).toBe('metadata');
  });

  it('returns null when scan is malformed AND index has no entity data', () => {
    const malformed = createCorpusEntityGraphScan({
      content: '{not json}',
      path: '/virtual/.entity-graph.json',
    });
    expect(malformed.graph).toBeNull();
    expect(detectEntityGraphDrift(malformed, { entityMeta: {}, relationships: [] })).toBeNull();
  });

  it('emits the same MutationLane kind as a markdown-content edit (unified emitter)', () => {
    // Pre-Phase-9: a markdown-directory mtime change emitted "metadata" via one branch
    // and an entity-graph mtime change emitted "metadata" via a separate branch. Phase 9
    // folds both into one emitter — assert the lane kind matches what markdown drift produces.
    const markdownLane = 'metadata' as const;
    const entityGraphLane = detectEntityGraphDrift(
      entityGraphScan({
        entityMeta: { coral: { type: 'technology', description: 'Edited externally.' } },
        relationships: [],
      }),
      indexedGraph,
    );
    expect(entityGraphLane).toBe(markdownLane);
  });
});
