import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { parseFrontmatter, parseSourceFrontmatter } from '#src/kb/corpus/frontmatter.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { runPendingKbMigrations } from '#src/kb/migrations/index.js';
import { noteEntryId, sourceEntryId } from '#src/kb/entry-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

const CURRENT_TEST_MIGRATION_VERSION = 1;

function markerPath(runtimeDir: string): string {
  return join(runtimeDir, 'migrations', 'kb-version.json');
}

function writeMarker(runtimeDir: string, version: number): void {
  const path = markerPath(runtimeDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version })}\n`, 'utf-8');
}

function renderNote({
  title,
  body,
  tags = ['coral', 'peer-classified'],
  principles = ['Trust Existing Classification'],
  inputFingerprint,
}: {
  title: string;
  body: string;
  tags?: string[];
  principles?: string[];
  inputFingerprint?: string;
}): string {
  return [
    '---',
    `tags: [${tags.join(', ')}]`,
    `principles: [${principles.join(', ')}]`,
    'source:',
    '  - kangig94/coral',
    'createdAt: 2026-06-15T00:00:00.000Z',
    'updatedAt: 2026-06-15T00:00:00.000Z',
    ...(inputFingerprint === undefined ? [] : [`inputFingerprint: ${inputFingerprint}`]),
    'entrySeq: 1',
    '---',
    `# ${title}`,
    '',
    body,
  ].join('\n');
}

function renderSource({
  title,
  body,
  tags = ['reference', 'peer-classified-source'],
  inputFingerprint,
}: {
  title: string;
  body: string;
  tags?: string[];
  inputFingerprint?: string;
}): string {
  return [
    '---',
    `title: ${title}`,
    'type: spec',
    `tags: [${tags.join(', ')}]`,
    'importedAt: 2026-06-15T00:00:00.000Z',
    ...(inputFingerprint === undefined ? [] : [`inputFingerprint: ${inputFingerprint}`]),
    'entrySeq: 2',
    '---',
    `# ${title}`,
    '',
    body,
  ].join('\n');
}

describe('KB migrations', () => {
  let root: string;
  let markdownRoot: string;
  let runtimeDir: string;
  let kb: KbRuntime;
  let db: ReturnType<typeof createKbTestDb>;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'coral-kb-migrations-'));
    markdownRoot = join(root, 'vault');
    runtimeDir = join(root, 'data', 'kb');
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config');

    const runtime = createRealRuntime('prod');
    mkdirSync(runtimeDir, { recursive: true });
    db = createKbTestDb(runtimeDir);
    kb = createTestKbRuntime({
      markdownRoot,
      runtimeDir,
      db,
      runtime,
      curateAssistant: { complete: async () => '' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(root, { recursive: true, force: true });
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
  });

  it('runs from a stale marker, backfills normalized fingerprints, skips unclassified notes, and stamps the version', async () => {
    mkdirSync(kb.notesDir(), { recursive: true });
    mkdirSync(kb.sourcesDir(), { recursive: true });
    writeMarker(runtimeDir, 0);

    const noteBody = 'Line one.\r\nLine two.   \r\n';
    const sourceBody = 'Source line.\r\nSource two.\t  \r\n';
    const expectedNoteFingerprint = computeBodySurfaceHash(noteBody);
    const expectedSourceFingerprint = computeBodySurfaceHash(sourceBody);
    expect(computeBodySurfaceHash('Line one.   \nLine two.\t  \n\n')).toBe(expectedNoteFingerprint);
    expect(computeBodySurfaceHash('Source line.  \nSource two.   \n')).toBe(expectedSourceFingerprint);

    const notePath = join(kb.notesDir(), 'coral-backfilled.md');
    const unclassifiedNotePath = join(kb.notesDir(), 'coral-unclassified.md');
    const sourcePath = join(kb.sourcesDir(), 'backfilled-source.md');
    writeFileSync(notePath, renderNote({ title: 'Backfilled', body: noteBody }), 'utf-8');
    writeFileSync(
      unclassifiedNotePath,
      renderNote({
        title: 'Unclassified',
        body: 'Seed-only body.',
        tags: ['coral'],
        principles: [],
      }),
      'utf-8',
    );
    writeFileSync(sourcePath, renderSource({ title: 'Backfilled Source', body: sourceBody }), 'utf-8');

    await runPendingKbMigrations(kb);

    expect(parseFrontmatter(readFileSync(notePath, 'utf-8')).inputFingerprint).toBe(expectedNoteFingerprint);
    expect(parseFrontmatter(readFileSync(unclassifiedNotePath, 'utf-8')).inputFingerprint).toBeUndefined();
    expect(parseSourceFrontmatter(readFileSync(sourcePath, 'utf-8')).inputFingerprint).toBe(expectedSourceFingerprint);
    expect(JSON.parse(readFileSync(markerPath(runtimeDir), 'utf-8'))).toEqual({
      version: CURRENT_TEST_MIGRATION_VERSION,
    });

    const index = await kb.ensureCorpusFreshness({ wait: true });
    expect(index.entries[noteEntryId('coral-backfilled')]).toMatchObject({
      bodyHash: expectedNoteFingerprint,
      inputFingerprint: expectedNoteFingerprint,
    });
    expect(index.entries[sourceEntryId('backfilled-source')]).toMatchObject({
      bodyHash: expectedSourceFingerprint,
      inputFingerprint: expectedSourceFingerprint,
    });
  });

  it('does nothing when the per-machine marker is already current', async () => {
    mkdirSync(kb.notesDir(), { recursive: true });
    writeMarker(runtimeDir, CURRENT_TEST_MIGRATION_VERSION);
    const notePath = join(kb.notesDir(), 'coral-current.md');
    writeFileSync(notePath, renderNote({ title: 'Current', body: 'Body.' }), 'utf-8');

    await runPendingKbMigrations(kb);

    expect(parseFrontmatter(readFileSync(notePath, 'utf-8')).inputFingerprint).toBeUndefined();
    expect(JSON.parse(readFileSync(markerPath(runtimeDir), 'utf-8'))).toEqual({
      version: CURRENT_TEST_MIGRATION_VERSION,
    });
  });

  it('fails open and leaves KB access usable when migration backfill throws', async () => {
    mkdirSync(kb.notesDir(), { recursive: true });
    const notePath = join(kb.notesDir(), 'coral-fail-open.md');
    writeFileSync(notePath, renderNote({ title: 'Fail Open', body: 'Body.' }), 'utf-8');
    const logSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    const lockSpy = vi.spyOn(kb, 'withMutationLock').mockRejectedValue(new Error('migration failed'));

    await expect(runPendingKbMigrations(kb)).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith('kb_migration: migration failed; continuing KB access', expect.any(Error));
    expect(existsSync(markerPath(runtimeDir))).toBe(false);
    expect(parseFrontmatter(readFileSync(notePath, 'utf-8')).inputFingerprint).toBeUndefined();
    lockSpy.mockRestore();
    await expect(kb.ensureCorpusFreshness({ wait: true })).resolves.toMatchObject({
      entries: {
        [noteEntryId('coral-fail-open')]: {
          bodyHash: computeBodySurfaceHash('Body.'),
        },
      },
    });
  });
});
