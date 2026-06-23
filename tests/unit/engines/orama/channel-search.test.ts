import { insertMultiple } from '@orama/orama';
import { describe, expect, it } from 'vitest';

import { OramaSearchPort } from '#src/engines/orama/backend.js';
import { createOramaDb, toOramaDocument, type KbOramaDocument } from '#src/engines/orama/document-builder.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import type { KbProjectionArtifactFilePort } from '#src/kb/contract.js';

const FILES: Pick<KbProjectionArtifactFilePort, 'existsSync' | 'readFileSync' | 'rmSync' | 'writeJsonAtomic'> = {
  existsSync: () => false,
  readFileSync: () => {
    throw new Error('unexpected fixture artifact read');
  },
  rmSync: () => {},
  writeJsonAtomic: () => {},
};

function note(slug: string, title: string, body: string, tags: readonly string[] = []): KbOramaDocument {
  return toOramaDocument({
    note: slug,
    path: `notes/${slug}.md`,
    domain: slug.split('-')[0] ?? slug,
    title,
    body,
    tags: [...tags],
    principles: [],
    source: ['kangig94/coral'],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    entrySeq: 1,
  });
}

async function createSearchPort(documents: readonly KbOramaDocument[]): Promise<OramaSearchPort> {
  const created = await createOramaDb();
  await insertMultiple(created.db, [...documents]);
  const snapshotStore = new OramaSnapshotStore({ files: FILES }, '/tmp/coral-orama-channel-search');
  snapshotStore.install({ ...created, fallback: true });
  return new OramaSearchPort(snapshotStore);
}

describe('Orama channel search', () => {
  it('expands camel-case compound queries and prefers metadata identity over body-only matches', async () => {
    const port = await createSearchPort([
      note('graph-rag', 'Graph RAG', 'A short note about retrieval.'),
      note('body-only', 'Body Only', 'Graph RAG Graph RAG Graph RAG appears only in content.'),
    ]);

    const result = await port.search('GraphRAG', 5, 'all');

    expect(result.hits.map((hit) => hit.documentId)).toContain('note:graph-rag');
    expect(result.hits[0]?.documentId).toBe('note:graph-rag');
  });

  it('matches compact Korean queries against spaced Korean titles through ngram fields', async () => {
    const port = await createSearchPort([
      note('policy-learning', '정책 학습', '검색 품질을 평가한다.'),
      note('policy-review', '정책 검토', '학습 결과를 별도로 정리한다.'),
    ]);

    const result = await port.search('정책학습', 5, 'all');

    expect(result.hits.map((hit) => hit.documentId)).toContain('note:policy-learning');
    expect(result.hits[0]?.documentId).toBe('note:policy-learning');
  });

  it('uses a narrow fuzzy fallback for long Latin typos when strict channels miss', async () => {
    const port = await createSearchPort([note('retrieval-pipeline', 'Retrieval Pipeline', 'Lexical search path.')]);

    const result = await port.search('retrievel', 5, 'all');

    expect(result.hits[0]?.documentId).toBe('note:retrieval-pipeline');
  });

  it('does not fuzzy-match only the Latin part of a mixed-script query', async () => {
    const port = await createSearchPort([note('retrieval-pipeline', 'Retrieval Pipeline', 'Lexical search path.')]);

    const result = await port.search('retrievel 정책', 5, 'all');

    expect(result.hits).toEqual([]);
  });
});
