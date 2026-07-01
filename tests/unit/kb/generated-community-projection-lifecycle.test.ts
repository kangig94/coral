import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '#src/store/db.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { applyCommunitySummary, listStaleCommunities, readCommunitySummaryInput } from '#src/kb/curate/community/summary-surface.js';
import { captureIndexStateSnapshot } from '#src/kb/corpus/lanes.js';
import { corpusStructuralCacheKey } from '#src/kb/corpus/structural-key.js';
import { detectRescanInfo } from '#src/kb/corpus/rescan/drift.js';
import { performRescan } from '#src/kb/corpus/rescan/index.js';
import { createCorpusScanView } from '#src/kb/corpus/rescan/scan.js';
import { communityEntryId, type EntityGraph } from '#src/kb/entry-types.js';
import { readEntryByKind } from '#src/kb/read.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

const tempRoots: string[] = [];
const openDatabases: Database[] = [];

function createHarness(): { root: string; runtimeDir: string; db: Database; kb: KbRuntime } {
  const root = mkdtempSync(join(tmpdir(), 'coral-generated-community-lifecycle-'));
  const markdownRoot = join(root, 'vault');
  const runtimeDir = join(root, 'runtime');
  const db = createKbTestDb(runtimeDir);
  tempRoots.push(root);
  openDatabases.push(db);
  return {
    root: markdownRoot,
    runtimeDir,
    db,
    kb: createTestKbRuntime({ markdownRoot, runtimeDir, db }),
  };
}

function reopenHarness(input: { root: string; runtimeDir: string; db: Database }): { db: Database; kb: KbRuntime } {
  input.db.close();
  const index = openDatabases.indexOf(input.db);
  if (index >= 0) {
    openDatabases.splice(index, 1);
  }
  const db = createKbTestDb(input.runtimeDir);
  openDatabases.push(db);
  return {
    db,
    kb: createTestKbRuntime({ markdownRoot: input.root, runtimeDir: input.runtimeDir, db }),
  };
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

function generatedCommunityRaw(summary?: string): string {
  return [
    '---',
    'coralGeneratedCommunity: true',
    'createdAt: 2026-06-01',
    'updatedAt: 2026-06-01',
    'level: 1',
    ...(summary === undefined ? [] : ['summaryInputFingerprint: seeded-fingerprint']),
    '---',
    '# Generated Fresh Community',
    '',
    ...(summary === undefined ? [] : ['## Summary', '', summary, '']),
    '## Members',
    '- #fresh',
    '',
  ].join('\n');
}

function stageGeneratedCommunity(kb: KbRuntime, content = generatedCommunityRaw()) {
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
        content,
      },
    ],
  });
}

async function adoptGeneratedCommunity(kb: KbRuntime, content = generatedCommunityRaw()): Promise<{
  readonly generation: number;
  readonly generatedCommunityDocsHash: string;
}> {
  const staged = stageGeneratedCommunity(kb, content);
  const result = kb.generatedCommunityProjectionStore.adoptStagedGeneration(staged, kb.captureCorpusSnapshot());
  expect(result.status).toBe('adopted');
  if (result.status !== 'adopted') {
    throw new Error('unreachable');
  }
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of openDatabases.splice(0).reverse()) {
    db.close();
  }
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('generated community projection lifecycle', () => {
  it('keeps generated docs out of corpus authority while feeding index, reads, Orama input, structural key, and summaries', async () => {
    const { kb } = createHarness();
    writeNote(kb);
    writeEntityGraph(kb);
    const firstGenerated = await adoptGeneratedCommunity(kb);

    await expect(performRescan(kb, captureIndexStateSnapshot(kb.readIndexState()))).resolves.toMatchObject({
      status: 'committed',
    });

    const slug = 'generated-fresh';
    expect(existsSync(kb.communityPath(slug))).toBe(false);
    const index = kb.readIndex();
    expect(index?.generatedCommunityGeneration).toBe(firstGenerated.generation);
    expect(index?.generatedCommunityDocsHash).toBe(firstGenerated.generatedCommunityDocsHash);
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

    const projectionInput = await kb.corpusProjectionReader.prepareCurrentProjectionInput({ ensureFreshness: false });
    expect(projectionInput.generatedCommunityGeneration).toBe(firstGenerated.generation);
    expect(projectionInput.generatedCommunityDocsHash).toBe(firstGenerated.generatedCommunityDocsHash);
    expect(projectionInput.records.some((record) => record.kind === 'community' && record.entry.slug === slug)).toBe(true);

    const structuralKey = kb.readCorpusStructuralKey(index!);
    expect(index?.structuralKey?.communityDocsHash).toBe(structuralKey?.communityDocsHash);

    const secondGenerated = await adoptGeneratedCommunity(kb);

    expect(listStaleCommunities(kb)).toContainEqual({ slug, level: 1 });
    expect(readCommunitySummaryInput(kb, slug)).toMatchObject({ slug, level: 1 });

    const beforeSeq = captureIndexStateSnapshot(kb.readIndexState());
    const publishSpy = vi.spyOn(kb, 'publishGeneratedCommunityProjection');
    await expect(applyCommunitySummary(kb, slug, 'Generated summary.')).resolves.toEqual({ written: true });
    const afterSeq = captureIndexStateSnapshot(kb.readIndexState());
    expect(afterSeq).toEqual(beforeSeq);
    expect(existsSync(kb.communityPath(slug))).toBe(false);
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        generatedCommunityGeneration: secondGenerated.generation + 1,
      }),
    );
  });

  it('preserves ambiguous authored community markdown and ignores generated slugs in inbound sync', async () => {
    const { kb } = createHarness();
    await adoptGeneratedCommunity(kb);

    const ambiguousRaw = [
      '---',
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
    const existing = kb.generatedCommunityProjectionStore.loadExistingCommunityState({
      communityFiles: [{ slug: 'generated-fresh', content: ambiguousRaw }],
      detectedCommunities: [{ slug: 'generated-fresh' }],
    });
    expect(existing.reservedSlugs.has('generated-fresh')).toBe(true);
    expect(existing.authoredDocuments).toEqual([{ slug: 'generated-fresh', content: ambiguousRaw }]);
    expect(existing.migratedGeneratedSlugs.has('generated-fresh')).toBe(false);
    expect(existing.generated).toEqual([]);

    const before = kb.captureCorpusSnapshot();
    mkdirSync(kb.communitiesDir(), { recursive: true });
    await kb.runInboundSync(
      async () => {
        writeFileSync(kb.communityPath('generated-fresh'), ambiguousRaw, 'utf-8');
        return {
          kind: 'paths' as const,
          changes: [{ status: 'modified' as const, path: 'communities/generated-fresh.md' }],
        };
      },
      { structuredDiff: true },
    );
    const after = kb.captureCorpusSnapshot();

    expect(captureIndexStateSnapshot(kb.readIndexState())).toEqual({ contentSeq: 0, metadataSeq: 0 });
    expect(after).toEqual(before);
  });

  it('keeps structural-key computations consistent after generated-only changes and point mutations', async () => {
    const { kb } = createHarness();
    writeNote(kb);
    const graph = writeEntityGraph(kb);
    await adoptGeneratedCommunity(kb);
    await expect(performRescan(kb, captureIndexStateSnapshot(kb.readIndexState()))).resolves.toMatchObject({
      status: 'committed',
    });
    const beforeIndex = kb.readIndex();
    const beforeKey = beforeIndex?.structuralKey;
    expect(beforeKey).toBeDefined();

    await adoptGeneratedCommunity(kb, generatedCommunityRaw('Generated-only pre-summary.'));
    await applyCommunitySummary(kb, 'generated-fresh', 'Generated-only summary.');
    await kb.writeEntityGraph(graph);

    const afterIndex = kb.readIndex();
    const afterKey = afterIndex?.structuralKey;
    expect(afterKey).toBeDefined();
    expect(afterKey?.entityGraphHash).toBe(beforeKey?.entityGraphHash);
    expect(afterKey?.communityDocsHash).not.toBe(beforeKey?.communityDocsHash);
    expect(afterKey).toEqual(kb.readCorpusStructuralKey(afterIndex!));
    expect(corpusStructuralCacheKey(afterKey!)).not.toBe(corpusStructuralCacheKey(beforeKey!));
  });

  it('detects generated-doc drift after restart and rebuilds from durable PULL state', async () => {
    const harness = createHarness();
    await adoptGeneratedCommunity(harness.kb);
    await expect(performRescan(harness.kb, captureIndexStateSnapshot(harness.kb.readIndexState()))).resolves.toMatchObject({
      status: 'committed',
    });

    const second = await adoptGeneratedCommunity(harness.kb, generatedCommunityRaw('Restart-fresh summary.'));
    const reopened = reopenHarness(harness);
    harness.db = reopened.db;
    harness.kb = reopened.kb;

    const drift = await detectRescanInfo(harness.kb, createCorpusScanView({ markdownFiles: [], entityGraph: null }));
    expect(drift).toMatchObject({
      needsRebuild: true,
      externalMutation: 'metadata',
    });

    await expect(performRescan(harness.kb, captureIndexStateSnapshot(harness.kb.readIndexState()))).resolves.toMatchObject({
      status: 'committed',
    });
    expect(harness.kb.readIndex()).toMatchObject({
      generatedCommunityGeneration: second.generation,
      generatedCommunityDocsHash: second.generatedCommunityDocsHash,
    });
  });
});
