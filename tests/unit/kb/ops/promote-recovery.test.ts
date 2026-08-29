import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';
import { noteEntryId, wikiEntryId } from '#src/kb/entry-types.js';
import {
  PROMOTE_MARKER_VERSION,
  promoteRecoveryBackupDir,
  promoteRecoveryDir,
  promoteRecoveryMarkerPath,
  promoteRecoveryStagingDir,
  type PromoteRecoveryMarker,
  type PromoteRecoveryPhase,
} from '#src/kb/ops/promote-marker.js';
import { runPromoteRecovery } from '#src/kb/ops/promote-recovery.js';
import { createKbTestDb } from '#tests/helpers/kb/runtime-test-helpers.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

const mockState = vi.hoisted(() => ({ tmpHome: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, homedir: () => mockState.tmpHome };
});

async function loadKbModules() {
  vi.resetModules();
  const [runtime, paths] = await Promise.all([import('#src/kb/runtime.js'), import('#src/kb/paths.js')]);
  return { createKbRuntime: runtime.createKbRuntime, paths };
}

function createRuntime(_paths: Awaited<ReturnType<typeof loadKbModules>>['paths']) {
  return createTestKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: kbRuntimePaths('prod').root,
    db: createKbTestDb(':memory:'),
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

const NOTE_RAW = `---
tags: [coral]
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-23T00:00:00.000Z
updatedAt: 2026-03-23T00:00:00.000Z
entrySeq: 1
---
# Recovery Note

## Rule
Recovery body.
`;

const WIKI_OLD_RAW = `---
tags: [kb]
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-20T00:00:00.000Z
---
# Living Knowledge

## Understanding

Original understanding.

## Knowledge

- [[notes/existing-note]]
  - 2026-03-20 seed
`;

const WIKI_NEW_RAW = `---
tags: [kb]
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-23T00:00:00.000Z
---
# Living Knowledge

## Understanding

Original understanding.

## Knowledge

- [[notes/coral-recovery]]
- [[notes/existing-note]]
  - 2026-03-20 seed
`;

interface MarkerSpec {
  phase: PromoteRecoveryPhase;
  noteOnDisk?: string | null; // null/undefined = absent; string = present with that content
  wikiOnDisk?: string | null;
  memoOnDisk?: string | null;
  stageNote?: string;
  backupWiki?: string;
}

function setupPromoteFixture(
  paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
  spec: MarkerSpec,
): {
  promoteId: string;
  marker: PromoteRecoveryMarker;
  markerPath: string;
  notePath: string;
  wikiPath: string;
  memoPath: string;
} {
  const projectRoot = join(mockState.tmpHome, 'project');
  const memoDir = paths.memoDir(projectRoot);
  mkdirSync(memoDir, { recursive: true });
  mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
  mkdirSync(paths.wikiDir(process.env.CORAL_KB_PATH!), { recursive: true });
  const memoPath = join(memoDir, '2026-03-23-recovery.md');
  if (spec.memoOnDisk !== null) {
    writeFileSync(memoPath, spec.memoOnDisk ?? `---\nsource: kangig94/coral\n---\nmemo body\n`, 'utf-8');
  }
  const noteSlug = 'coral-recovery';
  const wikiSlug = 'living-knowledge';
  const notePath = paths.notePathFromName(noteSlug, process.env.CORAL_KB_PATH!);
  const wikiPath = paths.wikiPathFromName(wikiSlug, process.env.CORAL_KB_PATH!);
  if (typeof spec.noteOnDisk === 'string') {
    writeFileSync(notePath, spec.noteOnDisk, 'utf-8');
  }
  if (typeof spec.wikiOnDisk === 'string') {
    writeFileSync(wikiPath, spec.wikiOnDisk, 'utf-8');
  }

  const runtimeDir = kbRuntimePaths('prod').root;
  const promoteId = 'promote-test-1';
  const stagingDir = promoteRecoveryStagingDir(runtimeDir, promoteId);
  const backupDir = promoteRecoveryBackupDir(runtimeDir, promoteId);
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  const stagedNotePath = join(stagingDir, 'note.md');
  const stagedWikiPath = join(stagingDir, 'wiki.md');
  const backupWikiPath = join(backupDir, 'wiki.md');
  writeFileSync(stagedNotePath, spec.stageNote ?? NOTE_RAW, 'utf-8');
  writeFileSync(stagedWikiPath, WIKI_NEW_RAW, 'utf-8');
  writeFileSync(backupWikiPath, spec.backupWiki ?? WIKI_OLD_RAW, 'utf-8');

  const marker: PromoteRecoveryMarker = {
    version: PROMOTE_MARKER_VERSION,
    promoteId,
    phase: spec.phase,
    memoPath,
    noteSlug,
    noteEntryId: noteEntryId(noteSlug),
    notePath,
    wikiSlug,
    wikiEntryId: wikiEntryId(wikiSlug),
    wikiPath,
    stagedNotePath,
    stagedWikiPath,
    backupWikiPath,
    oldWikiHash: sha256(spec.backupWiki ?? WIKI_OLD_RAW),
    newNoteHash: sha256(spec.stageNote ?? NOTE_RAW),
    newWikiHash: sha256(WIKI_NEW_RAW),
    noteSource: ['kangig94/coral'],
    noteCreatedAt: '2026-03-23T00:00:00.000Z',
    noteUpdatedAt: '2026-03-23T00:00:00.000Z',
    noteEntrySeq: 1,
    noteTags: ['coral'],
    createdAt: '2026-03-23T00:00:00.000Z',
    updatedAt: '2026-03-23T00:00:00.000Z',
  };
  const markerPath = promoteRecoveryMarkerPath(runtimeDir, promoteId);
  mkdirSync(promoteRecoveryDir(runtimeDir), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');

  return { promoteId, marker, markerPath, notePath, wikiPath, memoPath };
}

describe('runPromoteRecovery', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-recovery-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    mkdirSync(process.env.CORAL_KB_PATH, { recursive: true });
  });

  afterEach(() => {
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('cleans up staged artifacts at marker-created phase without touching the memo', async () => {
    const { paths } = await loadKbModules();
    const kb = createRuntime(paths);
    const { markerPath, memoPath, notePath, wikiPath, promoteId } = setupPromoteFixture(paths, {
      phase: 'marker-created',
    });

    await runPromoteRecovery(kb);

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(promoteRecoveryStagingDir(kbRuntimePaths('prod').root, promoteId))).toBe(false);
    expect(existsSync(promoteRecoveryBackupDir(kbRuntimePaths('prod').root, promoteId))).toBe(false);
    expect(existsSync(memoPath)).toBe(true);
    expect(existsSync(notePath)).toBe(false);
    expect(existsSync(wikiPath)).toBe(false);
  });

  it('cleans up staged artifacts at payloads-staged phase without touching the memo', async () => {
    const { paths } = await loadKbModules();
    const kb = createRuntime(paths);
    const { markerPath, memoPath, notePath } = setupPromoteFixture(paths, {
      phase: 'payloads-staged',
    });

    await runPromoteRecovery(kb);

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(memoPath)).toBe(true);
    expect(existsSync(notePath)).toBe(false);
  });

  it('rolls back the matching note file and cleans up at note-written phase', async () => {
    const { paths } = await loadKbModules();
    const kb = createRuntime(paths);
    const { markerPath, memoPath, notePath } = setupPromoteFixture(paths, {
      phase: 'note-written',
      noteOnDisk: NOTE_RAW,
    });

    await runPromoteRecovery(kb);

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(notePath)).toBe(false);
    expect(existsSync(memoPath)).toBe(true);
  });

  it('leaves a non-matching note file alone at note-written phase but still cleans up the marker', async () => {
    const { paths } = await loadKbModules();
    const kb = createRuntime(paths);
    const foreignContent = '# Foreign File\n';
    const { markerPath, notePath } = setupPromoteFixture(paths, {
      phase: 'note-written',
      noteOnDisk: foreignContent,
    });

    await runPromoteRecovery(kb);

    expect(existsSync(markerPath)).toBe(false);
    expect(readFileSync(notePath, 'utf-8')).toBe(foreignContent);
  });

  it('rolls forward when wiki-written hashes match the marker', async () => {
    const { paths } = await loadKbModules();
    const kb = createRuntime(paths);
    const { markerPath, memoPath, notePath, wikiPath, promoteId } = setupPromoteFixture(paths, {
      phase: 'wiki-written',
      noteOnDisk: NOTE_RAW,
      wikiOnDisk: WIKI_NEW_RAW,
    });

    await runPromoteRecovery(kb);

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(promoteRecoveryStagingDir(kbRuntimePaths('prod').root, promoteId))).toBe(false);
    expect(existsSync(memoPath)).toBe(false);
    expect(readFileSync(notePath, 'utf-8')).toBe(NOTE_RAW);
    expect(readFileSync(wikiPath, 'utf-8')).toBe(WIKI_NEW_RAW);
    expect(kb.readIndex()?.entries[noteEntryId('coral-recovery')]).toMatchObject({
      kind: 'note',
      slug: 'coral-recovery',
    });
    expect(kb.readIndex()?.entries[wikiEntryId('living-knowledge')]).toMatchObject({
      kind: 'wiki',
      slug: 'living-knowledge',
      knowledge: [noteEntryId('coral-recovery'), noteEntryId('existing-note')],
    });
  });

  it('restores the wiki backup, removes the note, and cleans up when wiki-written hashes mismatch', async () => {
    const { paths } = await loadKbModules();
    const kb = createRuntime(paths);
    const corruptedWiki = `${WIKI_NEW_RAW}\nCorrupted tail.\n`;
    const { markerPath, memoPath, notePath, wikiPath } = setupPromoteFixture(paths, {
      phase: 'wiki-written',
      noteOnDisk: NOTE_RAW,
      wikiOnDisk: corruptedWiki,
    });

    await runPromoteRecovery(kb);

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(notePath)).toBe(false);
    expect(readFileSync(wikiPath, 'utf-8')).toBe(WIKI_OLD_RAW);
    expect(existsSync(memoPath)).toBe(true);
  });

  it('removes the memo and cleans up at state-committed phase', async () => {
    const { paths } = await loadKbModules();
    const kb = createRuntime(paths);
    const { markerPath, memoPath, notePath, wikiPath } = setupPromoteFixture(paths, {
      phase: 'state-committed',
      noteOnDisk: NOTE_RAW,
      wikiOnDisk: WIKI_NEW_RAW,
    });

    await runPromoteRecovery(kb);

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(memoPath)).toBe(false);
    expect(existsSync(notePath)).toBe(true);
    expect(existsSync(wikiPath)).toBe(true);
  });

  it('cleans up at memo-removed phase even when the memo was already gone', async () => {
    const { paths } = await loadKbModules();
    const kb = createRuntime(paths);
    const { markerPath, notePath, wikiPath } = setupPromoteFixture(paths, {
      phase: 'memo-removed',
      noteOnDisk: NOTE_RAW,
      wikiOnDisk: WIKI_NEW_RAW,
      memoOnDisk: null,
    });

    await runPromoteRecovery(kb);

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(notePath)).toBe(true);
    expect(existsSync(wikiPath)).toBe(true);
  });

  it('cleans up at cleanup-complete phase as a no-op terminal', async () => {
    const { paths } = await loadKbModules();
    const kb = createRuntime(paths);
    const { markerPath, notePath, wikiPath, promoteId } = setupPromoteFixture(paths, {
      phase: 'cleanup-complete',
      noteOnDisk: NOTE_RAW,
      wikiOnDisk: WIKI_NEW_RAW,
    });

    await runPromoteRecovery(kb);

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(promoteRecoveryStagingDir(kbRuntimePaths('prod').root, promoteId))).toBe(false);
    expect(existsSync(notePath)).toBe(true);
    expect(existsSync(wikiPath)).toBe(true);
  });

  it('removes a malformed marker but leaves staged payloads for operator inspection', async () => {
    const { paths } = await loadKbModules();
    const kb = createRuntime(paths);
    const runtimeDir = kbRuntimePaths('prod').root;
    mkdirSync(promoteRecoveryDir(runtimeDir), { recursive: true });
    const malformedPath = promoteRecoveryMarkerPath(runtimeDir, 'malformed');
    writeFileSync(malformedPath, '{ not valid json', 'utf-8');
    const stagedDir = promoteRecoveryStagingDir(runtimeDir, 'malformed');
    mkdirSync(stagedDir, { recursive: true });
    const stagedNote = join(stagedDir, 'note.md');
    writeFileSync(stagedNote, 'staged content', 'utf-8');

    await runPromoteRecovery(kb);

    expect(existsSync(malformedPath)).toBe(false);
    expect(existsSync(stagedNote)).toBe(true);
  });
});
