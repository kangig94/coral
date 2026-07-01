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
import { detectRescanInfo } from '#src/kb/corpus/rescan/drift.js';
import { buildCorpusScanView } from '#src/kb/corpus/rescan/scan.js';
import { noteEntryId } from '#src/kb/entry-types.js';
import type { PendingRepair } from '#src/kb/curate/state/model.js';
import { createGitSyncController } from '#src/kb/curate/git-sync.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { curateDb } from '../../../../../src/kb/curate/db-access.js';

const tempRoots: string[] = [];
const openDatabases: Array<{ close(): void }> = [];
const writableDbByRuntime = new WeakMap<KbRuntime, ReturnType<typeof createKbTestDb>>();

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

  const db = createKbTestDb(root);
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

describe('rebuild pipeline wires typed detectors into the retry queue', () => {
  it('persists a frontmatter-shape/yaml-parse-error incident enqueued by the typed pipeline', async () => {
    const { kb, root } = createSeededKbRuntime();
    writeFileSync(
      join(root, 'notes', 'malformed-frontmatter.md'),
      ['---', 'tags: [test', 'principles: []', '---', '# Broken', '', 'body', ''].join('\n'),
      'utf-8',
    );

    await reindex(kb);

    const queue = readCurateRetryQueue(curateDb(kb));
    const queued = queue.find((entry) => entry.entryId === 'note:malformed-frontmatter');
    expect(queued).toBeDefined();
    expect(queued?.canonicalIncident).toBe(REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR);
    expect(queued?.locus).toBe('frontmatter-shape');
  });

  it('persists a file-syntax/conflict-markers incident enqueued by the typed pipeline', async () => {
    const { kb, root } = createSeededKbRuntime();
    writeFileSync(
      join(root, 'notes', 'conflict.md'),
      [
        '---',
        'tags: [test]',
        'principles: []',
        'source:',
        '  - kangig94/coral',
        'createdAt: 2026-04-01T00:00:00.000Z',
        'updatedAt: 2026-04-01T00:00:00.000Z',
        'entrySeq: 41',
        '---',
        '# Conflict',
        '',
        '<<<<<<< HEAD',
        'left side',
        '=======',
        'right side',
        '>>>>>>> incoming',
        '',
      ].join('\n'),
      'utf-8',
    );

    await reindex(kb);

    const queue = readCurateRetryQueue(curateDb(kb));
    const queued = queue.find((entry) => entry.entryId === 'note:conflict');
    expect(queued).toBeDefined();
    expect(queued?.canonicalIncident).toBe(REPAIR_INCIDENT_ID.FILE_SYNTAX.CONFLICT_MARKERS);
    expect(queued?.locus).toBe('file-syntax');
  });

  it('persists an identity-sequence/entryseq-collision incident enqueued by the typed pipeline', async () => {
    const { kb, root } = createSeededKbRuntime();
    const sharedFrontmatter = (entrySeq: number, title: string): string =>
      [
        '---',
        'tags: [test]',
        'principles: []',
        'source:',
        '  - kangig94/coral',
        'createdAt: 2026-04-01T00:00:00.000Z',
        'updatedAt: 2026-04-01T00:00:00.000Z',
        `entrySeq: ${entrySeq}`,
        '---',
        `# ${title}`,
        '',
        'body',
        '',
      ].join('\n');
    writeFileSync(join(root, 'notes', 'colliding-alpha.md'), sharedFrontmatter(51, 'Alpha'), 'utf-8');
    writeFileSync(join(root, 'notes', 'colliding-beta.md'), sharedFrontmatter(51, 'Beta'), 'utf-8');

    await reindex(kb);

    const queue = readCurateRetryQueue(curateDb(kb));
    const collisions = queue.filter(
      (entry) => entry.canonicalIncident === REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_COLLISION,
    );
    expect(collisions.map((entry) => entry.entryId).sort()).toEqual(['note:colliding-alpha', 'note:colliding-beta']);
  });

  it('persists a reference-integrity/orphan-principle-refs incident enqueued by the typed pipeline', async () => {
    const { kb, root } = createSeededKbRuntime();
    writeFileSync(
      join(root, 'notes', 'orphan-principle-ref.md'),
      [
        '---',
        'tags: [test]',
        'principles: [missing-principle]',
        'source:',
        '  - kangig94/coral',
        'createdAt: 2026-04-01T00:00:00.000Z',
        'updatedAt: 2026-04-01T00:00:00.000Z',
        'entrySeq: 61',
        '---',
        '# Orphan Principle',
        '',
        'references a principle that does not exist',
        '',
      ].join('\n'),
      'utf-8',
    );

    await reindex(kb);

    const queue = readCurateRetryQueue(curateDb(kb));
    const queued = queue.find((entry) => entry.entryId === 'note:orphan-principle-ref');
    expect(queued).toBeDefined();
    expect(queued?.canonicalIncident).toBe(REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_PRINCIPLE_REFS);
    expect(queued?.locus).toBe('reference-integrity');
  });
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

    // timing-sensitive: 500ms accommodates slow CI; deadlock is detected as 'timeout' return.
    const completed = await Promise.race([
      kb.withMutationLock(async (mutation) => {
        const gitSync = createGitSyncController({
          kb,
          curateAssistant: { complete: async () => '' },
          processPort: realRuntime.process,
          storagePort: realRuntime.storage,
          envPort: realRuntime.env,
        });
        await applyDetectedIncidentFixesLocked(kb, mutation, gitSync, [incident]);
        return 'done' as const;
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);

    expect(completed).toBe('done');
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

    // First rescan succeeds — establishes the prior on-disk state we will compare against.
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

    // Add a malformed note that would normally enqueue an incident on the second rescan.
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
    // Synthetic prior row still present; no new row from the malformed entry was added.
    const queueAfter = readCurateRetryQueue(curateDb(kb));
    expect(queueAfter).toEqual(queueBefore);
    expect(queueAfter.find((entry) => entry.entryId === 'note:rescan-malformed')).toBeUndefined();
  });
});

describe('detectRescanInfo unified MutationLane emitter', () => {
  // Parity claim: a markdown frontmatter-only edit and an entity-graph-only edit both
  // emit MutationLane='metadata'. Each scenario lives in its own seeded runtime so the
  // assertion isolates one drift source so earlier scenarios cannot bleed in via the retry queue.
  it('emits "metadata" for a markdown frontmatter-only edit', async () => {
    const { kb, root } = createSeededKbRuntime();
    const noteFrontmatter = (tags: string): string =>
      [
        '---',
        `tags: [${tags}]`,
        'principles: []',
        'source:',
        '  - kangig94/coral',
        'createdAt: 2026-04-01T00:00:00.000Z',
        'updatedAt: 2026-04-01T00:00:00.000Z',
        'entrySeq: 91',
        '---',
        '# Parity Note',
        '',
        'body',
        '',
      ].join('\n');
    writeFileSync(join(root, 'notes', 'parity-note.md'), noteFrontmatter('alpha'), 'utf-8');
    await reindex(kb);

    writeFileSync(join(root, 'notes', 'parity-note.md'), noteFrontmatter('beta'), 'utf-8');
    await expect(detectRescanInfo(kb, buildCorpusScanView(kb)).then((info) => info.externalMutation)).resolves.toBe(
      'metadata',
    );
  });

  it('emits "metadata" for an entity-graph-only edit', async () => {
    const { kb } = createSeededKbRuntime();
    writeFileSync(
      kb.entityGraphPath(),
      `${JSON.stringify(
        {
          entityMeta: { coral: { type: 'technology', description: 'baseline' } },
          relationships: [],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    await reindex(kb);

    writeFileSync(
      kb.entityGraphPath(),
      `${JSON.stringify(
        {
          entityMeta: { coral: { type: 'technology', description: 'edited' } },
          relationships: [],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    await expect(detectRescanInfo(kb, buildCorpusScanView(kb)).then((info) => info.externalMutation)).resolves.toBe(
      'metadata',
    );
  });
});
