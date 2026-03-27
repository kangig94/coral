import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
  };
});

async function loadKbModules() {
  vi.resetModules();
  const [{ promote }, { update }, { deleteFn }, { readEntry }, runtime, paths, frontmatter] = await Promise.all([
    import('../promote.js'),
    import('../update.js'),
    import('../delete.js'),
    import('../read.js'),
    import('../runtime.js'),
    import('../paths.js'),
    import('../frontmatter.js'),
  ]);
  return {
    promote,
    update,
    deleteFn,
    readEntry,
    createKbRuntime: runtime.createKbRuntime,
    paths,
    frontmatter,
  };
}

function createRuntime(
  createKbRuntime: Awaited<ReturnType<typeof loadKbModules>>['createKbRuntime'],
  paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
) {
  return createKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: paths.kbRuntimeDir(),
  });
}

describe('kb mutations', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-mutate-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    mkdirSync(join(mockState.tmpHome, 'vault', 'principles'), { recursive: true });
    writeFileSync(
      join(mockState.tmpHome, 'vault', 'principles', 'lenient-read-strict-write.md'),
      '---\ncreatedAt: 2026-03-23\nupdatedAt: 2026-03-23\n---\nRule.\n',
      'utf-8',
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T01:02:03.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('promotes a memo with canonical frontmatter, index update, and atomic temp-file cleanup', async () => {
    const { promote, createKbRuntime, paths, frontmatter } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(paths.memoDir(projectRoot), { recursive: true });

    const memoPath = join(paths.memoDir(projectRoot), '2026-03-23-kb.md');
    writeFileSync(memoPath, `---
source: kangig94/coral
---
memo body
`, 'utf-8');

    const result = await promote(kb, projectRoot, {
      memo: '2026-03-23-kb.md',
      title: 'KB Promotion',
      content: '## Rule\nPromote through the tool.',
      domain: 'coral',
      topic: 'kb-promotion',
    });

    const notePath = join(paths.notesDir(), 'coral-kb-promotion.md');
    expect(result).toEqual({ path: notePath });
    expect(existsSync(memoPath)).toBe(false);
    expect(existsSync(`${notePath}.tmp`)).toBe(false);

    const note = readFileSync(notePath, 'utf-8');
    expect(frontmatter.parseFrontmatter(note)).toEqual({
      tags: ['coral'],
      principles: [],
      source: ['kangig94/coral'],
      createdAt: '2026-03-23T01:02:03.000Z',
      updatedAt: '2026-03-23T01:02:03.000Z',
      mutationSeqAtPromote: 1,
    });
    expect(frontmatter.extractTitle(note)).toBe('KB Promotion');
    expect(note).toContain('## Rule\nPromote through the tool.\n');

    expect(kb.readIndex()?.notes['coral-kb-promotion']).toEqual({
      title: 'KB Promotion',
      tags: ['coral'],
      principles: [],
      source: ['kangig94/coral'],
      createdAt: '2026-03-23T01:02:03.000Z',
      updatedAt: '2026-03-23T01:02:03.000Z',
      mutationSeqAtPromote: 1,
    });
  });

  it('rejects duplicate targets before writing or deleting the memo', async () => {
    const { promote, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(paths.memoDir(projectRoot), { recursive: true });
    mkdirSync(paths.notesDir(), { recursive: true });

    const memoPath = join(paths.memoDir(projectRoot), 'dup.md');
    writeFileSync(memoPath, `---
source: kangig94/coral
---
memo body
`, 'utf-8');

    const notePath = join(paths.notesDir(), 'coral-kb-promotion.md');
    writeFileSync(notePath, 'original note', 'utf-8');

    await expect(promote(kb, projectRoot, {
      memo: 'dup.md',
      title: 'KB Promotion',
      content: '## Rule\nPromote through the tool.',
      domain: 'coral',
      topic: 'kb-promotion',
    })).rejects.toThrow(`KB note already exists: ${notePath}`);

    expect(readFileSync(notePath, 'utf-8')).toBe('original note');
    expect(existsSync(memoPath)).toBe(true);
  });

  it('rejects memo paths outside the active project memo directory before touching files', async () => {
    const { promote, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });

    const outsideMemo = join(mockState.tmpHome, 'outside.md');
    writeFileSync(outsideMemo, `---
source: kangig94/coral
---
memo body
`, 'utf-8');

    await expect(promote(kb, projectRoot, {
      memo: '../outside.md',
      title: 'KB Promotion',
      content: '## Rule\nPromote through the tool.',
      domain: 'coral',
      topic: 'kb-promotion',
    })).rejects.toThrow();

    expect(existsSync(outsideMemo)).toBe(true);
  });

  it('updates an existing note atomically while preserving createdAt and source', async () => {
    const { update, createKbRuntime, paths, frontmatter } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    const notePath = join(paths.notesDir(), 'coral-kb-promotion.md');
    writeFileSync(notePath, `---
tags: [coral]
principles: [contract-first-design]
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-20T00:00:00.000Z
mutationSeqAtPromote: 7
---
# Original Title

Original body.
`, 'utf-8');

    kb.writeIndex({
      notes: {
        'coral-kb-promotion': {
          title: 'Original Title',
          tags: ['coral'],
          principles: ['contract-first-design'],
          source: ['kangig94/coral'],
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T00:00:00.000Z',
          mutationSeqAtPromote: 7,
        },
      },
      principles: {},
    });

    vi.setSystemTime(new Date('2026-03-24T05:06:07.000Z'));
    const result = await update(kb, {
      note: 'coral-kb-promotion',
      title: 'Updated Title',
      content: 'Updated body.',
    });

    expect(result).toEqual({ path: notePath });
    expect(existsSync(`${notePath}.tmp`)).toBe(false);

    const note = readFileSync(notePath, 'utf-8');
    expect(frontmatter.parseFrontmatter(note)).toEqual({
      tags: ['coral'],
      principles: ['contract-first-design'],
      source: ['kangig94/coral'],
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-24T05:06:07.000Z',
      mutationSeqAtPromote: 7,
    });
    expect(frontmatter.extractTitle(note)).toBe('Updated Title');
    expect(note).toContain('Updated body.\n');

    expect(kb.readIndex()?.notes['coral-kb-promotion']).toEqual({
      title: 'Updated Title',
      tags: ['coral'],
      principles: ['contract-first-design'],
      source: ['kangig94/coral'],
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-24T05:06:07.000Z',
      mutationSeqAtPromote: 7,
    });
  });

  it('deletes a note and removes its JSON index entry', async () => {
    const { deleteFn, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    const notePath = join(paths.notesDir(), 'coral-kb-promotion.md');
    writeFileSync(notePath, 'note body', 'utf-8');
    kb.writeIndex({
      notes: {
        'coral-kb-promotion': {
          title: 'Updated Title',
          tags: ['coral'],
          principles: ['lenient-read-strict-write'],
          source: ['kangig94/coral'],
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-24T05:06:07.000Z',
        },
      },
      principles: {},
    });

    const result = await deleteFn(kb, { note: 'coral-kb-promotion' });
    expect(result).toEqual({ deleted: notePath });
    expect(existsSync(notePath)).toBe(false);
    expect(kb.readIndex()?.notes['coral-kb-promotion']).toBeUndefined();
  });

  it('reads a note by slug and returns structured content without timestamps', async () => {
    const { readEntry, paths } = await loadKbModules();
    mkdirSync(paths.notesDir(), { recursive: true });
    writeFileSync(join(paths.notesDir(), 'coral-kb-read.md'), `---
tags: [coral, kb]
principles: [contract-first-design]
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-20T00:00:00.000Z
---
# Read Test

## Rule
Content here.
`, 'utf-8');

    const result = readEntry({ note: 'coral-kb-read' });
    expect(result).toEqual({
      note: 'coral-kb-read',
      title: 'Read Test',
      content: '## Rule\nContent here.',
      tags: ['coral', 'kb'],
      principles: ['contract-first-design'],
    });
  });

  it('throws when reading a non-existent note', async () => {
    const { readEntry } = await loadKbModules();
    expect(() => readEntry({ note: 'does-not-exist' })).toThrow();
  });
});
