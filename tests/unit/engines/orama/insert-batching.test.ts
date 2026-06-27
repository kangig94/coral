import { search as oramaSearch } from '@orama/orama';
import { describe, expect, it } from 'vitest';

import { insertOramaDocumentsCooperatively } from '#src/engines/orama/backend.js';
import {
  createOramaDb,
  normalizeOramaTerm,
  toOramaDocument,
  type KbOramaDocument,
} from '#src/engines/orama/document-builder.js';

function note(slug: string, body: string): KbOramaDocument {
  return toOramaDocument({
    note: slug,
    path: `notes/${slug}.md`,
    domain: slug.split('-')[0] ?? slug,
    title: slug,
    body,
    tags: ['batching'],
    principles: [],
    source: ['kangig94/coral'],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    entrySeq: 1,
  });
}

describe('cooperative Orama document insertion', () => {
  it('yields to the event loop between full-install insert batches', async () => {
    const { db } = await createOramaDb();
    const documents = [
      note('batch-one', 'cooperative insertion alpha'),
      note('batch-two', 'cooperative insertion beta'),
    ];
    let immediateObserved = false;
    const immediate = new Promise<void>((resolve) => {
      setImmediate(() => {
        immediateObserved = true;
        resolve();
      });
    });

    await insertOramaDocumentsCooperatively(db, documents, { batchSize: 1 });

    expect(immediateObserved).toBe(true);
    await immediate;

    const result = await oramaSearch(db, {
      term: normalizeOramaTerm('cooperative insertion'),
      properties: ['body'],
      limit: 10,
    });
    expect(result.hits.map((hit) => (hit.document as KbOramaDocument).entryId).sort()).toEqual([
      'note:batch-one',
      'note:batch-two',
    ]);
  });
});
