import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

async function loadMemoModules() {
  vi.resetModules();
  const [memo, paths] = await Promise.all([import('../memo.js'), import('../paths.js')]);
  return { ...memo, paths };
}

describe('kb memo operations', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-memo-'));
  });

  afterEach(() => {
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    vi.resetModules();
  });

  it('lists memos with timestamp prefixes and legacy mtime fallback', async () => {
    const { listMemos, paths } = await loadMemoModules();
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });

    const dir = paths.memoDir(projectRoot);
    mkdirSync(dir, { recursive: true });

    const timestampedMemo = join(dir, '20260323-010203-alpha.md');
    const legacyMemo = join(dir, 'legacy.md');

    writeFileSync(
      timestampedMemo,
      `---
source: local/project
---

First summary line
Second line
`,
      'utf-8',
    );
    writeFileSync(legacyMemo, '\nLegacy summary\nSecond line\n', 'utf-8');

    const timestampedTime = new Date('2026-03-23T01:02:03.000Z');
    const legacyTime = new Date('2026-03-24T05:06:07.000Z');
    utimesSync(timestampedMemo, timestampedTime, timestampedTime);
    utimesSync(legacyMemo, legacyTime, legacyTime);

    expect(listMemos(projectRoot)).toEqual({
      memos: [
        {
          filename: 'legacy.md',
          summary: 'Legacy summary',
          createdAt: '2026-03-24T05:06:07.000Z',
        },
        {
          filename: '20260323-010203-alpha.md',
          summary: 'First summary line',
          createdAt: '20260323-010203',
        },
      ],
    });
  });

  it('returns an empty memo list when the memo directory does not exist', async () => {
    const { listMemos } = await loadMemoModules();
    const projectRoot = join(mockState.tmpHome, 'fresh-project');
    mkdirSync(projectRoot, { recursive: true });

    expect(listMemos(projectRoot)).toEqual({ memos: [] });
  });

  it('returns an empty delete result when the memo directory does not exist', async () => {
    const { deleteMemos } = await loadMemoModules();
    const projectRoot = join(mockState.tmpHome, 'fresh-project');
    mkdirSync(projectRoot, { recursive: true });

    expect(deleteMemos(projectRoot, { pattern: '*' })).toEqual({
      deleted: [],
      count: 0,
    });
  });

  it('deletes matching memos in deterministic order and escapes regex metacharacters', async () => {
    const { deleteMemos, paths } = await loadMemoModules();
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });

    const dir = paths.memoDir(projectRoot);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, 'b.md'), 'b', 'utf-8');
    writeFileSync(join(dir, 'a.md'), 'a', 'utf-8');
    writeFileSync(join(dir, 'a.b.md'), 'dot', 'utf-8');
    writeFileSync(join(dir, 'axb.md'), 'wild', 'utf-8');
    writeFileSync(join(dir, 'ignore.txt'), 'ignore', 'utf-8');

    expect(deleteMemos(projectRoot, { pattern: 'a.b*' })).toEqual({
      deleted: ['a.b.md'],
      count: 1,
    });
    expect(existsSync(join(dir, 'axb.md'))).toBe(true);

    expect(deleteMemos(projectRoot, { pattern: '*' })).toEqual({
      deleted: ['a.md', 'axb.md', 'b.md'],
      count: 3,
    });
    expect(existsSync(join(dir, 'ignore.txt'))).toBe(true);
  });

  it('purges all markdown memos and keeps non-markdown files', async () => {
    const { purgeMemos, paths } = await loadMemoModules();
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });

    const dir = paths.memoDir(projectRoot);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, 'a.md'), 'a', 'utf-8');
    writeFileSync(join(dir, 'b.md'), 'b', 'utf-8');
    writeFileSync(join(dir, 'ignore.txt'), 'ignore', 'utf-8');

    expect(purgeMemos(projectRoot)).toEqual({ deleted: 2 });
    expect(existsSync(join(dir, 'a.md'))).toBe(false);
    expect(existsSync(join(dir, 'b.md'))).toBe(false);
    expect(existsSync(join(dir, 'ignore.txt'))).toBe(true);
  });

  it('returns zero when purging a missing memo directory', async () => {
    const { purgeMemos } = await loadMemoModules();
    const projectRoot = join(mockState.tmpHome, 'fresh-project');
    mkdirSync(projectRoot, { recursive: true });

    expect(purgeMemos(projectRoot)).toEqual({ deleted: 0 });
  });
});
