import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '#src/store/db.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { captureIndexStateSnapshot } from '#src/kb/corpus/lanes.js';
import { noteEntryId } from '#src/kb/entry-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';

const tempRoots: string[] = [];
const openDatabases: Database[] = [];

async function loadLifecycleModule() {
  return import('#src/kb/corpus/rescan/index.js');
}

type ProjectionHarness = {
  root: string;
  runtimeDir: string;
  db: Database;
  kb: KbRuntime;
  runtime: Runtime;
};

function createHarness(): ProjectionHarness {
  const root = mkdtempSync(join(tmpdir(), 'coral-kb-projection-lifecycle-'));
  const runtime = createRealRuntime('prod', { baseDir: root });
  const runtimeDir = runtime.paths.coral.kbRuntime.root;
  const markdownRoot = join(root, 'vault');
  mkdirSync(join(markdownRoot, 'notes'), { recursive: true });
  tempRoots.push(root);
  const db = openKbTestStoreDb(join(runtimeDir, 'store.db'));
  openDatabases.push(db);
  const { kb } = createKbTestRuntime({ markdownRoot, runtimeDir, db, runtime });
  return { root: markdownRoot, runtimeDir, db, kb, runtime };
}

function closeHarnessDatabase(input: ProjectionHarness): void {
  input.db.close();
  const index = openDatabases.indexOf(input.db);
  if (index >= 0) {
    openDatabases.splice(index, 1);
  }
}

function openHarness(input: ProjectionHarness): { db: Database; kb: KbRuntime } {
  const db = openKbTestStoreDb(join(input.runtimeDir, 'store.db'));
  openDatabases.push(db);
  const { kb } = createKbTestRuntime({
    markdownRoot: input.root,
    runtimeDir: input.runtimeDir,
    db,
    runtime: input.runtime,
  });
  return { db, kb };
}

function reopenHarness(input: ProjectionHarness): { db: Database; kb: KbRuntime } {
  closeHarnessDatabase(input);
  return openHarness(input);
}

function writeNote(root: string, slug: string, body: string): void {
  writeFileSync(
    join(root, 'notes', `${slug}.md`),
    [
      '---',
      'tags: [projection]',
      'principles: []',
      'source:',
      '  - kangig94/coral',
      'createdAt: 2026-06-01T00:00:00.000Z',
      'updatedAt: 2026-06-01T00:00:00.000Z',
      'entrySeq: 1',
      '---',
      '# Projection Note',
      '',
      body,
      '',
    ].join('\n'),
    'utf-8',
  );
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

describe('corpus projection lifecycle', () => {
  it('restores the previous index after a crash between index rename and index_adopted record write', async () => {
    const { performRescan, deriveCorpusProjection, stageCorpusProjectionArtifacts, commitCorpusProjection } =
      await loadLifecycleModule();
    const harness = createHarness();
    writeNote(harness.root, 'projection-note', 'Old index body.');
    await expect(
      performRescan(harness.kb, captureIndexStateSnapshot(harness.kb.readIndexState())),
    ).resolves.toMatchObject({ status: 'committed' });
    const previousEntry = harness.kb.readIndex()?.entries[noteEntryId('projection-note')];
    expect(previousEntry).toBeDefined();
    const previousBaselineGenerationId = harness.kb.corpusAuthorityBaseline.readActiveGenerationId();

    writeNote(harness.root, 'projection-note', 'New index body that must not survive rollback.');
    harness.kb.invalidateTextSnapshot('external edit pending projection');
    const previousSeq = captureIndexStateSnapshot(harness.kb.readIndexState());
    const previousTextStaleReason = harness.kb.readIndexState().textStaleReason;
    const candidate = await deriveCorpusProjection(harness.kb, captureIndexStateSnapshot(harness.kb.readIndexState()));
    const staged = stageCorpusProjectionArtifacts(harness.kb, candidate);
    expect(staged.candidate.index.entries[noteEntryId('projection-note')]).not.toEqual(previousEntry);

    await expect(
      commitCorpusProjection(harness.kb, staged, {
        faultInjection: { failAfterPhase: 'index_renamed' },
      }),
    ).rejects.toThrow(/Injected corpus projection commit fault/);

    const reopened = reopenHarness(harness);
    harness.db = reopened.db;
    harness.kb = reopened.kb;

    expect(harness.kb.readIndex()?.entries[noteEntryId('projection-note')]).toEqual(previousEntry);
    expect(harness.kb.corpusAuthorityBaseline.readActiveGenerationId()).toBe(previousBaselineGenerationId);
    expect(captureIndexStateSnapshot(harness.kb.readIndexState())).toEqual(previousSeq);
    expect(harness.kb.readIndexState().textStaleReason).toBe(previousTextStaleReason);
    expect(existsSync(join(harness.runtimeDir, 'corpus-projection', 'commits', staged.commitId))).toBe(false);
  });
});
