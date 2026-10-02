import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import { reindex } from '#src/kb/ops/reindex.js';
import { readCurateRetryQueue, syncCurateRetryQueue } from '#src/kb/curate/retry.js';
import {
  REPAIR_INCIDENT_ID,
  repairIncidentLocus,
  type DetectedIncident,
} from '#src/kb/corpus/rescan/incidents/catalog.js';
import { applyDetectedIncidentFixesLocked } from '#src/kb/corpus/rescan/auto-fix.js';
import { noteEntryId } from '#src/kb/entry-types.js';
import type { PendingRepair } from '#src/kb/curate/state/model.js';
import { createGitSyncController } from '#src/kb/curate/git-sync.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { curateDb } from '../../../../../src/kb/curate/db-access.js';

const tempRoots: string[] = [];
const openDatabases: Array<{ close(): void }> = [];
const writableDbByRuntime = new WeakMap<KbRuntime, ReturnType<typeof openKbTestStoreDb>>();

function allocateRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createSeededKbRuntime(): { kb: KbRuntime; root: string } {
  const root = allocateRoot('coral-kb-rebuild-pipeline-');
  mkdirSync(join(root, 'notes'), { recursive: true });
  mkdirSync(join(root, 'sources'), { recursive: true });
  mkdirSync(join(root, 'communities'), { recursive: true });

  const db = openKbTestStoreDb(':memory:');
  const { kb } = createKbTestRuntime({
    markdownRoot: root,
    runtimeDir: root,
    db,
  });
  writableDbByRuntime.set(kb, db);
  openDatabases.push(db);
  return { kb, root };
}

afterEach(() => {
  for (const db of openDatabases.splice(0).reverse()) {
    try {
      db.close();
    } catch {
      // ignore cleanup races
    }
  }

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('applyDetectedIncidentFixesLocked lock-reentry safety', () => {
  it('completes without deadlock when invoked from inside withMutationLock', async () => {
    const { kb, root } = createSeededKbRuntime();
    writeFileSync(
      join(root, 'notes', 'reentry-target.md'),
      [
        '---',
        'tags: [reentry]',
        'principles: []',
        'source:',
        '  - kangig94/coral',
        'createdAt: 2026-04-01T00:00:00.000Z',
        'updatedAt: 2026-04-01T00:00:00.000Z',
        'entrySeq: 71',
        '---',
        '# Reentry Target',
        '',
        '<<<<<<< HEAD',
        '=======',
        '>>>>>>> incoming',
        '',
      ].join('\n'),
      'utf-8',
    );

    const realRuntime = createRealRuntime('prod');
    const incident: DetectedIncident = {
      locus: 'file-syntax',
      canonical: REPAIR_INCIDENT_ID.FILE_SYNTAX.CONFLICT_MARKERS,
      entryId: 'note:reentry-target',
      signals: { matches: [{ line: 13, marker: '<<<<<<<', text: '<<<<<<< HEAD' }] },
    };

    await kb.withMutationLock(async (mutation) => {
      const nestedLock = vi.spyOn(kb, 'withMutationLock').mockImplementation(async () => {
        throw new Error('nested mutation lock acquisition');
      });
      try {
        const gitSync = createGitSyncController({
          kb,
          curateAssistant: { complete: async () => '' },
          processPort: realRuntime.process,
          storagePort: realRuntime.storage,
          envPort: realRuntime.env,
        });
        await applyDetectedIncidentFixesLocked(kb, mutation, gitSync, [incident]);
      } finally {
        nestedLock.mockRestore();
      }
    });

    const queue = readCurateRetryQueue(curateDb(kb));
    expect(queue.find((entry) => entry.entryId === 'note:reentry-target')).toBeDefined();
  });
});

describe('performRescan failure semantics', () => {
  it('does not leave partial KbIndex or partial retry-queue rows when rescan throws mid-flight', async () => {
    const { kb, root } = createSeededKbRuntime();
    writeFileSync(
      join(root, 'notes', 'rescan-baseline.md'),
      [
        '---',
        'tags: [baseline]',
        'principles: []',
        'source:',
        '  - kangig94/coral',
        'createdAt: 2026-04-01T00:00:00.000Z',
        'updatedAt: 2026-04-01T00:00:00.000Z',
        'entrySeq: 81',
        '---',
        '# Baseline',
        '',
        'baseline body',
        '',
      ].join('\n'),
      'utf-8',
    );

    await reindex(kb);
    const indexBefore = kb.readIndex();
    expect(indexBefore?.entries['note:rescan-baseline']).toBeDefined();

    // Seed a synthetic stale retry-queue row so queueBefore is non-empty: a queueBefore
    // of [] would also satisfy the post-failure assertion if the queue logic was never
    // reached. With a real row in place, we additionally prove the failed rescan does
    // not delete or overwrite pre-existing rows.
    const syntheticPriorRow: PendingRepair = {
      entryId: noteEntryId('synthetic-prior'),
      entrySeq: null,
      detectedAt: '2026-04-01T00:00:00.000Z',
      observedContentHash: 'a'.repeat(64),
      reason: REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR,
      locus: repairIncidentLocus(REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR),
      canonicalIncident: REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR,
      signalsJson: '{}',
      retryNotBefore: '2026-04-01T00:00:00.000Z',
      retryCount: 0,
    };
    syncCurateRetryQueue(writableDbByRuntime.get(kb)!, [syntheticPriorRow]);
    const queueBefore = readCurateRetryQueue(curateDb(kb));
    expect(queueBefore).toHaveLength(1);
    expect(queueBefore[0].entryId).toBe('note:synthetic-prior');

    writeFileSync(
      join(root, 'notes', 'rescan-malformed.md'),
      ['---', 'tags: [test', 'principles: []', '---', '# Broken', '', 'body', ''].join('\n'),
      'utf-8',
    );

    // Force staging to throw before commit and before the typed-incident
    // side-effect pipeline, so all subsequent rescan side effects must skip.
    const stageSpy = vi.spyOn(kb, 'stageCorpusProjectionArtifacts').mockImplementation(() => {
      throw new Error('forced staging failure');
    });

    await expect(reindex(kb)).rejects.toThrow('forced staging failure');
    stageSpy.mockRestore();

    expect(kb.readIndex()).toEqual(indexBefore);
    const queueAfter = readCurateRetryQueue(curateDb(kb));
    expect(queueAfter).toEqual(queueBefore);
    expect(queueAfter.find((entry) => entry.entryId === 'note:rescan-malformed')).toBeUndefined();
  });
});
