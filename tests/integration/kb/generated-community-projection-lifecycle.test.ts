import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import { captureIndexStateSnapshot } from '#src/kb/corpus/lanes.js';
import { detectRescanInfo } from '#src/kb/corpus/rescan/drift.js';
import { performRescan } from '#src/kb/corpus/rescan/index.js';
import { createCorpusScanView } from '#src/kb/corpus/rescan/scan.js';
import type { Database } from '#src/store/db.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';

const tempRoots: string[] = [];
const openDatabases: Database[] = [];

function createHarness(): { root: string; runtimeDir: string; db: Database; kb: KbRuntime } {
  const root = mkdtempSync(join(tmpdir(), 'coral-generated-community-lifecycle-'));
  const markdownRoot = join(root, 'vault');
  const runtimeDir = join(root, 'runtime');
  const db = openKbTestStoreDb(join(runtimeDir, 'store.db'));
  tempRoots.push(root);
  openDatabases.push(db);
  return { root: markdownRoot, runtimeDir, db, kb: createTestKbRuntime({ markdownRoot, runtimeDir, db }) };
}

function reopenHarness(input: { root: string; runtimeDir: string; db: Database }): { db: Database; kb: KbRuntime } {
  input.db.close();
  const index = openDatabases.indexOf(input.db);
  if (index >= 0) openDatabases.splice(index, 1);
  const db = openKbTestStoreDb(join(input.runtimeDir, 'store.db'));
  openDatabases.push(db);
  return { db, kb: createTestKbRuntime({ markdownRoot: input.root, runtimeDir: input.runtimeDir, db }) };
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

async function adoptGeneratedCommunity(kb: KbRuntime, content = generatedCommunityRaw()) {
  const staged = kb.generatedCommunityProjectionStore.stageGeneration({
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
  const result = kb.generatedCommunityProjectionStore.adoptStagedGeneration(staged, kb.captureCorpusSnapshot());
  expect(result.status).toBe('adopted');
  if (result.status !== 'adopted') throw new Error('unreachable');
  return result;
}

afterEach(() => {
  for (const db of openDatabases.splice(0).reverse()) db.close();
  for (const root of tempRoots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('generated community projection lifecycle', () => {
  it('detects generated-doc drift after restart and rebuilds from durable PULL state', async () => {
    const harness = createHarness();
    await adoptGeneratedCommunity(harness.kb);
    await expect(
      performRescan(harness.kb, captureIndexStateSnapshot(harness.kb.readIndexState())),
    ).resolves.toMatchObject({ status: 'committed' });

    const second = await adoptGeneratedCommunity(harness.kb, generatedCommunityRaw('Restart-fresh summary.'));
    const reopened = reopenHarness(harness);
    harness.db = reopened.db;
    harness.kb = reopened.kb;

    await expect(
      detectRescanInfo(harness.kb, createCorpusScanView({ markdownFiles: [], entityGraph: null })),
    ).resolves.toMatchObject({ needsRebuild: true, externalMutation: 'metadata' });
    await expect(
      performRescan(harness.kb, captureIndexStateSnapshot(harness.kb.readIndexState())),
    ).resolves.toMatchObject({ status: 'committed' });
    expect(harness.kb.readIndex()).toMatchObject({
      generatedCommunityGeneration: second.generation,
      generatedCommunityDocsHash: second.generatedCommunityDocsHash,
    });
  });
});
