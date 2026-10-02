import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';

import { createRealRuntime } from '#src/runtime/real.js';

const realRuntime = createRealRuntime('prod');
const memoStorage = realRuntime.storage;

const mockState = vi.hoisted(() => ({
  tmpHome: '',
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
  };
});

async function loadMemoModules() {
  vi.resetModules();
  const [memo, paths] = await Promise.all([import('#src/kb/ops/memo.js'), import('#src/kb/paths.js')]);
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

  it('rejects memo topics that would escape the memo directory', async () => {
    const { writeMemo } = await loadMemoModules();
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });

    expect(() =>
      writeMemo(
        { storagePort: memoStorage, ids: realRuntime.ids },
        projectRoot,
        'local/project',
        {
          topic: '../../../../evil',
          content: 'escaped',
          owner: 'owner-a',
        },
        realRuntime.time,
      ),
    ).toThrow(/memo topic/i);
    expect(existsSync(join(mockState.tmpHome, 'evil.md'))).toBe(false);
  });

  it('rejects NUL and control-like memo topics before reaching the filesystem', async () => {
    const { writeMemo } = await loadMemoModules();
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });

    expect(() =>
      writeMemo(
        { storagePort: memoStorage, ids: realRuntime.ids },
        projectRoot,
        'local/project',
        {
          topic: `bad${String.fromCharCode(0)}topic`,
          content: 'bad',
          owner: 'owner-a',
        },
        realRuntime.time,
      ),
    ).toThrow(/memo topic/i);
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

    expect(deleteMemos(memoStorage, projectRoot, { pattern: 'a.b*' })).toEqual({
      deleted: ['a.b.md'],
      count: 1,
    });
    expect(existsSync(join(dir, 'axb.md'))).toBe(true);

    expect(deleteMemos(memoStorage, projectRoot, { pattern: '*' })).toEqual({
      deleted: ['a.md', 'axb.md', 'b.md'],
      count: 3,
    });
    expect(existsSync(join(dir, 'ignore.txt'))).toBe(true);
  });
});
