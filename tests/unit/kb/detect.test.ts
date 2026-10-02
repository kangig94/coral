import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
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

  it('resolves configured-root markdown paths while keeping runtime artifacts machine-local', async () => {
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    vi.resetModules();
    const paths = await import('#src/kb/paths.js');
    const { kb } = createKbTestRuntime({
      markdownRoot: process.env.CORAL_KB_PATH,
      runtimeDir: kbRuntimePaths('dev').root,
      db: openKbTestStoreDb(':memory:'),
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
