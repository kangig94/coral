import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createCorpusMarkdownFileScan,
  createCorpusScanView,
  type DetectedIncident,
} from '#src/kb/corpus/repair/corpus-scan.js';
import { detectIncidentRetryDrift } from '#src/kb/curate/text-artifacts/drift.js';
import { REPAIR_INCIDENT_ID, repairIncidentLocus } from '#src/kb/corpus/repair/incident-ids.js';
import type { PendingRepair } from '#src/kb/curate/state/model.js';
import { noteEntryId } from '#src/kb/entry-types.js';

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
