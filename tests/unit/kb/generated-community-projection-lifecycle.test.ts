import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import type { Database } from '#src/store/db.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { captureIndexStateSnapshot } from '#src/kb/corpus/lanes.js';
import { performRescan } from '#src/kb/corpus/rescan/index.js';
import { communityEntryId, type EntityGraph } from '#src/kb/entry-types.js';
import { readEntryByKind } from '#src/kb/read.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';

const tempRoots: string[] = [];
const openDatabases: Database[] = [];

function createHarness(): { kb: KbRuntime } {
  const root = mkdtempSync(join(tmpdir(), 'coral-generated-community-lifecycle-'));
  const markdownRoot = join(root, 'vault');
  const runtimeDir = join(root, 'runtime');
  const db = openKbTestStoreDb(':memory:');
  tempRoots.push(root);
  openDatabases.push(db);
  return { kb: createTestKbRuntime({ markdownRoot, runtimeDir, db }) };
}

function writeNote(kb: KbRuntime): void {
  mkdirSync(kb.notesDir(), { recursive: true });
  writeFileSync(
    kb.notePath('generated-community-input'),
    [
      '---',
      'tags: [fresh]',
      'principles: []',
      'source:',
      '  - kangig94/coral',
      'createdAt: 2026-06-01T00:00:00.000Z',
      'updatedAt: 2026-06-01T00:00:00.000Z',
      'entrySeq: 1',
      '---',
      '# Generated Community Input',
      '',
      'Fresh generated community content.',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeEntityGraph(kb: KbRuntime, description = 'Generated community graph.'): EntityGraph {
  const graph: EntityGraph = {
    entityMeta: {
      fresh: { type: 'concept', description },
    },
    relationships: [],
  };
  mkdirSync(dirname(kb.entityGraphPath()), { recursive: true });
  writeFileSync(kb.entityGraphPath(), `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');
  return graph;
}

function generatedCommunityRaw(): string {
  return [
    '---',
    'coralGeneratedCommunity: true',
    'createdAt: 2026-06-01',
    'updatedAt: 2026-06-01',
    'level: 1',
    '---',
    '# Generated Fresh Community',
    '',
    '## Members',
    '- #fresh',
    '',
  ].join('\n');
}

function stageGeneratedCommunity(kb: KbRuntime) {
  return kb.generatedCommunityProjectionStore.stageGeneration({
    snapshot: kb.captureCorpusSnapshot(),
    topologyHash: 'topology-generated-fresh',
    documents: [
      {
        slug: 'generated-fresh',
        title: 'Generated Fresh Community',
        level: 1,
        members: ['fresh'],
        createdAt: '2026-06-01',
        updatedAt: '2026-06-01',
        content: generatedCommunityRaw(),
      },
    ],
  });
}

function adoptGeneratedCommunity(kb: KbRuntime): void {
  const staged = stageGeneratedCommunity(kb);
  const result = kb.generatedCommunityProjectionStore.adoptStagedGeneration(staged, kb.captureCorpusSnapshot());
  expect(result.status).toBe('adopted');
}

afterEach(() => {
  for (const db of openDatabases.splice(0).reverse()) {
    db.close();
  }
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('generated community projection lifecycle', () => {
  it('keeps adopted generated communities out of corpus authority and exposes them through index and direct reads', async () => {
    const { kb } = createHarness();
    writeNote(kb);
    writeEntityGraph(kb);
    adoptGeneratedCommunity(kb);

    await expect(performRescan(kb, captureIndexStateSnapshot(kb.readIndexState()))).resolves.toMatchObject({
      status: 'committed',
    });

    const slug = 'generated-fresh';
    expect(existsSync(kb.communityPath(slug))).toBe(false);
    const index = kb.readIndex();
    expect(index?.entries[communityEntryId(slug)]).toMatchObject({
      kind: 'community',
      slug,
      members: ['fresh'],
    });

    const directRead = readEntryByKind('community', slug, {
      storage: kb.storagePort,
      paths: {
        notePath: (name) => kb.notePath(name),
        wikiPath: (name) => kb.wikiPath(name),
        sourcePath: (name) => kb.sourcePath(name),
        communityPath: (name) => kb.communityPath(name),
        principlePath: (name) => kb.principlePath(name),
      },
      communityDocumentProvider: {
        readGeneratedCommunityDocument: (name) => kb.generatedCommunityProjectionStore.readCommunityDocument(name),
      },
    });
    expect(directRead).toMatchObject({
      kind: 'community',
      note: slug,
      members: ['fresh'],
    });
  });
});
