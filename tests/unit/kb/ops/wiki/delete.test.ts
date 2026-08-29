import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';
import { wikiEntryId } from '#src/kb/entry-types.js';
import { createKbTestDb } from '#tests/helpers/kb/runtime-test-helpers.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

const mockState = vi.hoisted(() => ({ tmpHome: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, homedir: () => mockState.tmpHome };
});

async function loadModules() {
  vi.resetModules();
  const [{ deleteWiki }, { createWiki }, paths] = await Promise.all([
    import('#src/kb/ops/wiki/delete.js'),
    import('#src/kb/ops/wiki/create.js'),
    import('#src/kb/paths.js'),
  ]);
  return { deleteWiki, createWiki, paths };
}

function createRuntime(_paths: Awaited<ReturnType<typeof loadModules>>['paths']) {
  return createTestKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: kbRuntimePaths('prod').root,
    db: createKbTestDb(kbRuntimePaths('prod').root),
  });
}

describe('deleteWiki', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-wiki-delete-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    mkdirSync(process.env.CORAL_KB_PATH, { recursive: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T05:06:07.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('atomically removes the wiki file and its index entry', async () => {
    const { deleteWiki, createWiki, paths } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge' });
    const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
    expect(existsSync(wikiPath)).toBe(true);

    const result = await deleteWiki(kb, { slug: 'living-knowledge' });

    expect(result).toEqual({ deleted: wikiPath });
    expect(existsSync(wikiPath)).toBe(false);
    expect(kb.readIndex()?.entries[wikiEntryId('living-knowledge')]).toBeUndefined();
  });

  it('rejects deleting a missing wiki without modifying the index', async () => {
    const { deleteWiki, createWiki, paths } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'keep-me' });
    const indexBefore = kb.readIndex();

    await expect(deleteWiki(kb, { slug: 'no-such-wiki' })).rejects.toThrow('KB wiki not found');
    expect(kb.readIndex()).toEqual(indexBefore);
  });

  it('rejects malformed wiki slugs before any storage call', async () => {
    const { deleteWiki, paths } = await loadModules();
    const kb = createRuntime(paths);

    await expect(deleteWiki(kb, { slug: 'Bad Slug' })).rejects.toThrow();
  });

  it('clears the manifest authority delta for a deleted wiki', async () => {
    const { deleteWiki, createWiki, paths } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge' });
    const beforeState = kb.readIndexState();

    await deleteWiki(kb, { slug: 'living-knowledge' });

    // Both content and metadata lanes bump on delete.
    const afterState = kb.readIndexState();
    expect(afterState.contentSeq).toBeGreaterThan(beforeState.contentSeq);
    expect(afterState.metadataSeq).toBeGreaterThan(beforeState.metadataSeq);
  });
});
