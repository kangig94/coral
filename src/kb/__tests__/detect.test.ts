import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const [runtime, paths, clientPaths] = await Promise.all([
    import('../runtime.js'),
    import('../paths.js'),
    import('../../client/paths.js'),
  ]);
  return {
    createKbRuntime: runtime.createKbRuntime,
    paths,
    clientPaths,
  };
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
    const { createKbRuntime, paths, clientPaths } = await loadKbModules();

    const kb = createKbRuntime({
      markdownRoot: clientPaths.kbRoot(),
      runtimeDir: paths.kbRuntimeDir(),
    });

    expect(kb.markdownRoot).toBe(join(mockState.tmpHome, 'configured-kb'));
  });

  it('falls back to basic mode when lancedb is not installed in the runtime dir', async () => {
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    const { createKbRuntime, paths } = await loadKbModules();
    const kb = createKbRuntime({
      markdownRoot: process.env.CORAL_KB_PATH!,
      runtimeDir: paths.kbRuntimeDir(),
    });
    const pluginRoot = join(mockState.tmpHome, 'plugin');
    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(join(pluginRoot, 'bridge', 'coral-backend.cjs'), '', 'utf-8');

    await kb.initAdapter(pluginRoot);

    expect(kb.adapter).toBeNull();
  });

  it('keeps memo and note path resolution confined to their roots', async () => {
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    const { createKbRuntime, paths } = await loadKbModules();
    const kb = createKbRuntime({
      markdownRoot: process.env.CORAL_KB_PATH!,
      runtimeDir: paths.kbRuntimeDir(),
    });
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });

    expect(kb.notePath('coral-kb-runtime-root')).toBe(
      join(mockState.tmpHome, 'vault', 'notes', 'coral-kb-runtime-root.md'),
    );
    expect(paths.notePathFromParts('coral', 'kb-runtime-root')).toBe(
      join(mockState.tmpHome, 'vault', 'notes', 'coral-kb-runtime-root.md'),
    );
    expect(paths.memoPathFromContext(projectRoot, 'memo.md')).toBe(
      join(mockState.tmpHome, '.coral', 'projects', 'local-project', 'memo', 'memo.md'),
    );
    expect(() => kb.notePath('../escape')).toThrow();
    expect(() => paths.notePathFromName('../escape')).toThrow();
    expect(() => paths.memoPathFromContext(projectRoot, '../escape.md')).toThrow();
  });
});
