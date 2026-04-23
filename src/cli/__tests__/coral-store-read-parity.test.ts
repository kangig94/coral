import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MainMod from '../main.js';

import { pluginRootNamespace } from '../../infra/paths.js';
import { createRealRuntime } from '../../runtime/real.js';
import { openStoreDatabase } from '../../store/db.js';
import { ensureStoreMigrationsDir } from '../../store/migrations.js';
import { storePaths } from '../../store/paths.js';

const REPO_ROOT = process.cwd();
// Keep this fixed clock aligned with the snapshot's relative-time offsets vs. seeded `created_at` values.
const FIXED_NOW = new Date('2026-03-22T00:00:00.000Z');

type MainModule = typeof MainMod;

function toText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

async function loadMainModule(): Promise<MainModule> {
  vi.resetModules();
  return import('../main.js');
}

async function seedKbSearchSnapshot(): Promise<void> {
  const [{ reindex }, { closeNeedleBackend }, runtime, kbPaths] = await Promise.all([
    import('../../kb/ops/reindex.js'),
    import('../../kb/search/needle-backend.js'),
    import('../../kb/runtime.js'),
    import('../../kb/paths.js'),
  ]);
  const kb = runtime.createKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: kbPaths.kbRuntimeDir(),
  });

  try {
    await reindex(kb);
  } finally {
    await closeNeedleBackend(kb);
  }
}

function writeKbFixtures(kbRoot: string): void {
  const notesDir = join(kbRoot, 'notes');
  const principlesDir = join(kbRoot, 'principles');
  mkdirSync(notesDir, { recursive: true });
  mkdirSync(principlesDir, { recursive: true });

  writeFileSync(
    join(notesDir, 'coral-kb-mode.md'),
    `---
tags: [coral, kb]
principles: [contract-first-design]
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-21T00:00:00.000Z
entrySeq: 11
---
# KB Mode

## Rule
Keep the JSON index authoritative.
`,
    'utf8',
  );

  writeFileSync(
    join(principlesDir, 'contract-first-design.md'),
    `---
createdAt: 2026-03-20
updatedAt: 2026-03-20
---
Make the contract explicit first.
`,
    'utf8',
  );
}

function seedStore(projectRoot: string): void {
  const runtime = createRealRuntime();
  const db = openStoreDatabase({
    path: storePaths('prod').dbFile,
    storage: runtime.storage,
    migrationsDir: ensureStoreMigrationsDir(runtime.storage),
  });

  try {
    db.prepare(
      `INSERT INTO projection_jobs (
         job_id,
         phase,
         terminal,
         diagnostics,
         session_id,
         provider,
         project_root,
         backend_namespace,
         bundle_hash,
         job_kind,
         parent_workflow_job_id,
         workflow_slot,
         created_at,
         last_seq
       ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
    ).run(
      'job-store-read-1',
      'running',
      'session-store-read-1',
      'codex',
      projectRoot,
      pluginRootNamespace(REPO_ROOT),
      'provider',
      '2026-03-21T00:00:00.000Z',
      0,
    );
  } finally {
    db.close();
  }
}

async function runCli(program: Command, args: string[]): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const originalArgv = [...process.argv];

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += toText(chunk);
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += toText(chunk);
    return true;
  }) as typeof process.stderr.write);

  try {
    process.argv = ['node', 'coral-cli', ...args];
    await program.parseAsync(process.argv);
  } finally {
    process.argv = originalArgv;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  return { stdout, stderr };
}

describe('cli coral-store read parity', () => {
  let tempHome: string;
  let projectRoot: string;
  let originalHome: string | undefined;
  let originalKbPath: string | undefined;
  let originalPluginRoot: string | undefined;
  let originalCwd: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    originalHome = process.env.HOME;
    originalKbPath = process.env.CORAL_KB_PATH;
    originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    originalCwd = process.cwd();

    tempHome = mkdtempSync(join(tmpdir(), 'coral-store-read-parity-'));
    projectRoot = join(tempHome, 'project');

    mkdirSync(projectRoot, { recursive: true });
    process.env.HOME = tempHome;
    process.env.CORAL_KB_PATH = join(tempHome, 'vault');
    process.env.CLAUDE_PLUGIN_ROOT = REPO_ROOT;
    process.chdir(projectRoot);

    writeKbFixtures(process.env.CORAL_KB_PATH);
    seedStore(projectRoot);
    await seedKbSearchSnapshot();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    process.chdir(originalCwd);

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalKbPath === undefined) {
      delete process.env.CORAL_KB_PATH;
    } else {
      process.env.CORAL_KB_PATH = originalKbPath;
    }

    if (originalPluginRoot === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    }

    rmSync(tempHome, { recursive: true, force: true });
  });

  it.each([
    ['jobs', ['jobs']],
    ['kb search', ['kb', 'search', 'authoritative']],
    ['kb principles', ['kb', 'principles']],
    ['kb read', ['kb', 'read', 'coral-kb-mode']],
  ])('preserves %s output via CoralStore reads', async (_name, args) => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const { stdout, stderr } = await runCli(program, args);
    const normalizedStdout = stdout.replaceAll(projectRoot, '<project-root>');

    expect(stderr).toBe('');
    expect(normalizedStdout).toMatchSnapshot();
  });

  it('degrades direct-read kb search when the Orama snapshot is absent', async () => {
    const [{ kbRuntimeDir }] = await Promise.all([import('../../kb/paths.js')]);
    rmSync(kbRuntimeDir(), { recursive: true, force: true });

    const { searchKnowledgeBase } = await import('../../kb/queries.js');
    const result = await searchKnowledgeBase({ query: 'authoritative', mode: 'vector' });

    expect(result).toEqual({
      results: [],
      mode: 'text',
      warnings: ['kb_search_degraded_until_coordinator_rebuild'],
    });
  });
});
