import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('falls back to text-only startup when the vector store is unavailable', async () => {
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    const { createKbRuntime, paths } = await loadKbModules();
    const kb = createKbRuntime({
      markdownRoot: process.env.CORAL_KB_PATH,
      runtimeDir: paths.kbRuntimeDir(),
    });
    const pluginRoot = join(mockState.tmpHome, 'plugin');
    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(join(pluginRoot, 'bridge', 'coral-backend.cjs'), '', 'utf-8');

    await kb.initVectorStore(pluginRoot);

    expect(kb.vectorStore).toBeNull();
  });

  it('resolves configured-root markdown paths while keeping runtime artifacts machine-local', async () => {
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    const { createKbRuntime, paths } = await loadKbModules();
    const kb = createKbRuntime({
      markdownRoot: process.env.CORAL_KB_PATH,
      runtimeDir: paths.kbRuntimeDir(),
    });
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    const markdownRoot = join(mockState.tmpHome, 'vault');
    const machineLocalRuntimeDir = join(mockState.tmpHome, '.coral', 'data', 'kb');
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
