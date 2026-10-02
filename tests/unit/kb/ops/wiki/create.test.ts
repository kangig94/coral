import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

const mockState = vi.hoisted(() => ({ tmpHome: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, homedir: () => mockState.tmpHome };
});

async function loadModules() {
  vi.resetModules();
  const [{ createWiki }, paths, frontmatter] = await Promise.all([
    import('#src/kb/ops/wiki/create.js'),
    import('#src/kb/paths.js'),
    import('#src/kb/corpus/frontmatter.js'),
  ]);
  return { createWiki, paths, frontmatter };
}

function createRuntime(_paths: Awaited<ReturnType<typeof loadModules>>['paths']) {
  return createTestKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: kbRuntimePaths('prod').root,
    db: openKbTestStoreDb(':memory:'),
  });
}

describe('createWiki', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-wiki-create-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    mkdirSync(process.env.CORAL_KB_PATH, { recursive: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T01:02:03.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('rejects an already-existing wiki slug', async () => {
    const { createWiki, paths } = await loadModules();
    const kb = createRuntime(paths);
    mkdirSync(paths.wikiDir(process.env.CORAL_KB_PATH!), { recursive: true });
    const existing = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
    writeFileSync(existing, '# already here\n', 'utf-8');

    await expect(createWiki(kb, { slug: 'living-knowledge' })).rejects.toThrow('KB wiki already exists');
    expect(existsSync(existing)).toBe(true);
    expect(readFileSync(existing, 'utf-8')).toBe('# already here\n');
  });
});
