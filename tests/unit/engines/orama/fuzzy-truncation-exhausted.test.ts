import { describe, expect, it } from 'vitest';

import {
  ORAMA_FUZZY_DOCUMENT_SCAN_LIMIT,
  collectFuzzyOramaSearchCandidates,
} from '#src/engines/orama/ranking.js';
import type { KbOramaDb } from '#src/engines/orama/schema.js';
import type { OramaSearchQueryAnalysis } from '#src/engines/orama/search-channels.js';

// Locks the FtsSearchResult.exhausted contract for the fuzzy fallback: a
// document scan that hits its hard cap (which `limit` cannot raise) must report
// exhausted:true. Returning exhausted:false here let the KB-tier widening loop
// double `topK` forever against an empty, re-truncated result (the C7 bug).
describe('Orama fuzzy fallback honors the exhausted contract on truncation', () => {
  function fakeDbWithDocuments(count: number): KbOramaDb {
    const docs: Record<string, unknown> = {};
    for (let i = 0; i < count; i += 1) {
      docs[`k${i}`] = { entryId: `note:${i}`, kind: 'note', title: `t${i}`, body: `b${i}` };
    }
    return {
      documentsStore: { getAll: () => docs },
      data: { docs: {} },
    } as unknown as KbOramaDb;
  }

  it('reports exhausted:true with no candidates when the scan truncates', () => {
    // One past the scan cap forces truncation; a non-empty fuzzy term skips the
    // empty-fuzzy early return so we exercise the truncation branch specifically.
    const db = fakeDbWithDocuments(ORAMA_FUZZY_DOCUMENT_SCAN_LIMIT + 1);
    const analysis = { fuzzy: ['needle'] } as unknown as OramaSearchQueryAnalysis;

    const result = collectFuzzyOramaSearchCandidates(db, analysis, 10);

    expect(result.exhausted).toBe(true);
    expect(result.candidates.size).toBe(0);
  });
});
