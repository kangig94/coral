import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import { reindex } from '#src/kb/ops/reindex.js';
import { readCurateRetryQueue } from '#src/kb/curate/retry.js';
import { REPAIR_INCIDENT_ID, type DetectedIncident } from '#src/kb/corpus/rescan/incidents/catalog.js';
import { applyDetectedIncidentFixesLocked } from '#src/kb/corpus/rescan/auto-fix.js';
import { createGitSyncController } from '#src/kb/curate/git-sync.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

const tempRoots: string[] = [];
const openDatabases: Array<{ close(): void }> = [];

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

  const kb = createTestKbRuntime({
    markdownRoot: root,
    runtimeDir: root,
    db: createKbTestDb(root),
  });
  openDatabases.push(kb.db);
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

    const queue = readCurateRetryQueue(kb);
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

    const queue = readCurateRetryQueue(kb);
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

    const queue = readCurateRetryQueue(kb);
    const collisions = queue.filter((entry) => entry.canonicalIncident === REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_COLLISION);
    expect(collisions.map((entry) => entry.entryId).sort()).toEqual([
      'note:colliding-alpha',
      'note:colliding-beta',
    ]);
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

    const queue = readCurateRetryQueue(kb);
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

    const completed = await Promise.race([
      kb.withMutationLock(async (mutation) => {
        const gitSync = createGitSyncController({
          kb,
          spawnCli: async () => ({ stdout: '', stderr: '', code: 0, aborted: false }),
          processPort: realRuntime.process,
          storagePort: realRuntime.storage,
          envPort: realRuntime.env,
        });
        await applyDetectedIncidentFixesLocked(kb, mutation, gitSync, [incident]);
        return 'done' as const;
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);

    expect(completed).toBe('done');
    const queue = readCurateRetryQueue(kb);
    expect(queue.find((entry) => entry.entryId === 'note:reentry-target')).toBeDefined();
  });
});
