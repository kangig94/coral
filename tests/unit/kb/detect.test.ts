import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import { createKbTestDb } from '#tests/helpers/kb/runtime-test-helpers.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { KB_FTS_CAPABILITY } from '#src/kb/capability/constants.js';
import type { Backed, FtsRetrieval } from '#src/kb/contract.js';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';

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

async function loadKbModules() {
  vi.resetModules();
  const [runtime, paths, oramaPaths] = await Promise.all([
    import('#src/kb/runtime.js'),
    import('#src/kb/paths.js'),
    import('#src/engines/orama/paths.js'),
  ]);
  return {
    createKbRuntime: runtime.createKbRuntime,
    paths,
    oramaPaths,
    infraPaths: paths,
  };
}

function collectDirectoryPaths(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const next = join(root, entry.name);
    paths.push(next, ...collectDirectoryPaths(next));
  }

  return paths;
}

describe('kb detection and paths', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-home-'));
    delete process.env.CORAL_KB_PATH;
  });

  afterEach(() => {
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('honors a caller-provided custom root when creating a runtime', async () => {
    const customRoot = join(mockState.tmpHome, 'configured-kb');
    const { infraPaths } = await loadKbModules();

    const { kb } = createKbTestRuntime({
      markdownRoot: infraPaths.kbRoot('prod', customRoot),
      runtimeDir: kbRuntimePaths('prod').root,
      db: createKbTestDb(kbRuntimePaths('prod').root),
    });

    expect(kb.markdownRoot).toBe(customRoot);
  });

  it('derives flavor-specific KB roots and runtime dirs', async () => {
    const { infraPaths, oramaPaths } = await loadKbModules();

    expect(infraPaths.kbRoot('prod')).toBe(join(mockState.tmpHome, '.coral', 'kb'));
    const prodRuntimeDir = kbRuntimePaths('prod').root;
    expect(prodRuntimeDir).toBe(join(mockState.tmpHome, '.coral', 'gen2', 'data', 'kb'));
    expect(oramaPaths.oramaSnapshotDir(prodRuntimeDir)).toBe(
      join(mockState.tmpHome, '.coral', 'gen2', 'data', 'kb', 'orama'),
    );

    expect(infraPaths.kbRoot('dev')).toBe(join(mockState.tmpHome, '.coral', 'kb-dev'));
    const devRuntimeDir = kbRuntimePaths('dev').root;
    expect(devRuntimeDir).toBe(join(mockState.tmpHome, '.coral', 'gen2', 'data-dev', 'kb'));
    expect(oramaPaths.oramaSnapshotDir(devRuntimeDir)).toBe(
      join(mockState.tmpHome, '.coral', 'gen2', 'data-dev', 'kb', 'orama'),
    );
  });

  it('creates the runtime without requiring optional vector equipment at startup', async () => {
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    await loadKbModules();
    const db = createKbTestDb(kbRuntimePaths('prod').root);
    const { kb } = createKbTestRuntime({
      markdownRoot: process.env.CORAL_KB_PATH,
      runtimeDir: kbRuntimePaths('prod').root,
      db,
    });
    const pluginRoot = join(mockState.tmpHome, 'plugin');
    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(join(pluginRoot, 'bridge', 'coral-backend.cjs'), '', 'utf-8');
    void pluginRoot;

    expect(kb.runtimeDir).toBe(kbRuntimePaths('prod').root);
  });

  it('uses Orama as the base retrieval backend and never creates vec/ anywhere under the machine-local runtime tree', async () => {
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    const { oramaPaths } = await loadKbModules();
    const db = createKbTestDb(kbRuntimePaths('prod').root);
    const { kb } = createKbTestRuntime({
      markdownRoot: process.env.CORAL_KB_PATH,
      runtimeDir: kbRuntimePaths('prod').root,
      db,
    });
    const { bindOramaFtsForTest } = await import('#tests/unit/kb/expansion-test-helpers.js');
    bindOramaFtsForTest(kb);

    try {
      const fts = kb.capabilityRegistry.runtimeView().read<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY).read();

      expect(fts.warnings()).toContain('fts_index_uninitialized');
      expect(existsSync(oramaPaths.oramaSnapshotDir(kb.runtimeDir))).toBe(false);
      expect(collectDirectoryPaths(join(mockState.tmpHome, '.coral')).some((path) => path.endsWith('/vec'))).toBe(
        false,
      );
    } finally {
      db.close();
    }
  });

  it('resolves configured-root markdown paths while keeping runtime artifacts machine-local', async () => {
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    const { paths } = await loadKbModules();
    const { kb } = createKbTestRuntime({
      markdownRoot: process.env.CORAL_KB_PATH,
      runtimeDir: kbRuntimePaths('dev').root,
      db: createKbTestDb(kbRuntimePaths('dev').root),
    });
    const markdownRoot = join(mockState.tmpHome, 'vault');
    const machineLocalRuntimeDir = join(mockState.tmpHome, '.coral', 'gen2', 'data-dev', 'kb');
    const notePath = join(markdownRoot, 'notes', 'coral-kb-runtime-root.md');
    const principlePath = join(markdownRoot, 'principles', 'contract-first-design.md');

    expect(paths.notesDir(markdownRoot)).toBe(join(markdownRoot, 'notes'));
    expect(paths.principlesDir(markdownRoot)).toBe(join(markdownRoot, 'principles'));
    expect(paths.notePathFromName('coral-kb-runtime-root', markdownRoot)).toBe(notePath);
    expect(paths.principlePathFromName('contract-first-design', markdownRoot)).toBe(principlePath);
    expect(kb.notesDir()).toBe(join(markdownRoot, 'notes'));
    expect(kb.principlesDir()).toBe(join(markdownRoot, 'principles'));
    expect(kb.notePath('coral-kb-runtime-root')).toBe(notePath);
    expect(kb.principlePath('contract-first-design')).toBe(principlePath);
    expect(kbRuntimePaths('dev').root).toBe(machineLocalRuntimeDir);
    expect(kb.runtimeDir).toBe(machineLocalRuntimeDir);
    const projectDataDir = join(mockState.tmpHome, '.coral', 'projects', 'local-project');
    expect(paths.memoPathFromContext(projectDataDir, 'memo.md')).toBe(join(projectDataDir, 'memo', 'memo.md'));
    expect(() => kb.notePath('../escape')).toThrow();
    expect(() => kb.principlePath('../escape')).toThrow();
    expect(() => paths.notePathFromName('../escape', markdownRoot)).toThrow();
    expect(() => paths.principlePathFromName('../escape', markdownRoot)).toThrow();
    expect(() => paths.memoPathFromContext(projectDataDir, '../escape.md')).toThrow();
  });
});
