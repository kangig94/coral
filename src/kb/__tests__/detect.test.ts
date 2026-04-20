import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';

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
  const [runtime, paths, infraPaths] = await Promise.all([
    import('../runtime.js'),
    import('../paths.js'),
    import('../../infra/paths.js'),
  ]);
  return {
    createKbRuntime: runtime.createKbRuntime,
    paths,
    infraPaths,
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

  it('uses the process-level KB root when creating a runtime', async () => {
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'configured-kb');
    const { createKbRuntime, paths, infraPaths } = await loadKbModules();

    const kb = createKbRuntime({
      markdownRoot: infraPaths.kbRoot(),
      runtimeDir: paths.kbRuntimeDir(),
    });

    expect(kb.markdownRoot).toBe(join(mockState.tmpHome, 'configured-kb'));
  });

  it('derives default markdown and runtime KB roots from the settled build flavor', async () => {
    const { paths, infraPaths } = await loadKbModules();

    expect(infraPaths.currentBuildFlavor()).toBe('prod');
    expect(infraPaths.kbRoot()).toBe(join(mockState.tmpHome, '.coral', 'kb'));
    expect(paths.kbRuntimeDir()).toBe(join(mockState.tmpHome, '.coral', 'data', 'kb'));
    expect(paths.oramaSnapshotDir()).toBe(join(mockState.tmpHome, '.coral', 'data', 'kb', 'orama'));
    expect(paths.needleIndexDir()).toBe(join(mockState.tmpHome, '.coral', 'data', 'kb', 'needle'));
    expect(paths.needleStagingDir()).toBe(join(mockState.tmpHome, '.coral', 'data', 'kb', 'needle-staging'));

    infraPaths.setBuildFlavor('dev');

    expect(infraPaths.currentBuildFlavor()).toBe('dev');
    expect(infraPaths.kbRoot()).toBe(join(mockState.tmpHome, '.coral', 'kb-dev'));
    expect(paths.kbRuntimeDir()).toBe(join(mockState.tmpHome, '.coral', 'data', 'kb-dev'));
    expect(paths.oramaSnapshotDir()).toBe(join(mockState.tmpHome, '.coral', 'data', 'kb-dev', 'orama'));
    expect(paths.needleIndexDir()).toBe(join(mockState.tmpHome, '.coral', 'data', 'kb-dev', 'needle'));
    expect(paths.needleStagingDir()).toBe(join(mockState.tmpHome, '.coral', 'data', 'kb-dev', 'needle-staging'));
  });

  it('treats build flavor as single-assignment', async () => {
    const { infraPaths } = await loadKbModules();

    infraPaths.setBuildFlavor('dev');

    expect(() => infraPaths.setBuildFlavor('dev')).not.toThrow();
    expect(() => infraPaths.setBuildFlavor('prod')).toThrow('Build flavor already set to dev');
    expect(infraPaths.currentBuildFlavor()).toBe('dev');
  });

  it('creates the runtime without requiring needle equipment at startup', async () => {
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    const { createKbRuntime, paths } = await loadKbModules();
    const kb = createKbRuntime({
      markdownRoot: process.env.CORAL_KB_PATH,
      runtimeDir: paths.kbRuntimeDir(),
    });
    const pluginRoot = join(mockState.tmpHome, 'plugin');
    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(join(pluginRoot, 'bridge', 'coral-backend.cjs'), '', 'utf-8');
    void pluginRoot;

    expect(kb.runtimeDir).toBe(paths.kbRuntimeDir());
  });

  it('uses orama/ for a fresh cold-start and never creates vec/ anywhere under the machine-local runtime tree', async () => {
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    const { createKbRuntime, paths } = await loadKbModules();
    const kb = createKbRuntime({
      markdownRoot: process.env.CORAL_KB_PATH,
      runtimeDir: paths.kbRuntimeDir(),
    });

    try {
      const result = await kb.ensureOramaIndex();

      expect(result.warnings).toBeUndefined();
      expect(existsSync(paths.oramaSnapshotDir(kb.runtimeDir))).toBe(true);
      expect(existsSync(paths.needleIndexDir(kb.runtimeDir))).toBe(false);
      expect(existsSync(paths.needleStagingDir(kb.runtimeDir))).toBe(false);
      expect(
        collectDirectoryPaths(join(mockState.tmpHome, '.coral')).some((path) => path.endsWith('/vec')),
      ).toBe(false);
    } finally {
      kb.db.close();
    }
  });

  it('resolves configured-root markdown paths while keeping runtime artifacts machine-local', async () => {
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    const { createKbRuntime, paths, infraPaths } = await loadKbModules();
    infraPaths.setBuildFlavor('dev');
    const kb = createKbRuntime({
      markdownRoot: process.env.CORAL_KB_PATH,
      runtimeDir: paths.kbRuntimeDir(),
    });
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    const markdownRoot = join(mockState.tmpHome, 'vault');
    const machineLocalRuntimeDir = join(mockState.tmpHome, '.coral', 'data', 'kb-dev');
    const notePath = join(markdownRoot, 'notes', 'coral-kb-runtime-root.md');
    const principlePath = join(markdownRoot, 'principles', 'contract-first-design.md');

    expect(paths.notesDir()).toBe(join(markdownRoot, 'notes'));
    expect(paths.notesDir(markdownRoot)).toBe(join(markdownRoot, 'notes'));
    expect(paths.principlesDir()).toBe(join(markdownRoot, 'principles'));
    expect(paths.principlesDir(markdownRoot)).toBe(join(markdownRoot, 'principles'));
    expect(paths.notePathFromName('coral-kb-runtime-root')).toBe(notePath);
    expect(paths.notePathFromName('coral-kb-runtime-root', markdownRoot)).toBe(notePath);
    expect(paths.notePathFromParts('coral', 'kb-runtime-root')).toBe(notePath);
    expect(paths.notePathFromParts('coral', 'kb-runtime-root', markdownRoot)).toBe(notePath);
    expect(paths.principlePathFromName('contract-first-design')).toBe(principlePath);
    expect(paths.principlePathFromName('contract-first-design', markdownRoot)).toBe(principlePath);
    expect(kb.notesDir()).toBe(join(markdownRoot, 'notes'));
    expect(kb.principlesDir()).toBe(join(markdownRoot, 'principles'));
    expect(kb.notePath('coral-kb-runtime-root')).toBe(notePath);
    expect(kb.principlePath('contract-first-design')).toBe(principlePath);
    expect(paths.kbRuntimeDir()).toBe(machineLocalRuntimeDir);
    expect(kb.runtimeDir).toBe(machineLocalRuntimeDir);
    expect(paths.memoPathFromContext(projectRoot, 'memo.md')).toBe(
      join(mockState.tmpHome, '.coral', 'projects', 'local-project', 'memo', 'memo.md'),
    );
    expect(() => kb.notePath('../escape')).toThrow();
    expect(() => kb.principlePath('../escape')).toThrow();
    expect(() => paths.notePathFromName('../escape')).toThrow();
    expect(() => paths.principlePathFromName('../escape')).toThrow();
    expect(() => paths.memoPathFromContext(projectRoot, '../escape.md')).toThrow();
  });
});
