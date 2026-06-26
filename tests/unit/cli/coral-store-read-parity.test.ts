import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MainMod from '#src/cli/program.js';

import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { openStoreDatabase, openWritableStoreDbNoReset } from '#src/store/db.js';

const REPO_ROOT = process.cwd();
// Keep this fixed clock aligned with the snapshot's relative-time offsets vs. seeded `created_at` values.
const FIXED_NOW = new Date('2026-03-22T00:00:00.000Z');

type MainModule = typeof MainMod;

function toText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

async function loadMainModule(): Promise<MainModule> {
  vi.resetModules();
  return import('#src/cli/program.js');
}

async function seedKbSearchSnapshot(): Promise<void> {
  const [{ reindex }, { closeNeedleBackend }, kbPaths, { applyBoundCorpusConsumerForTest, createKbTestRuntime }] =
    await Promise.all([
      import('#src/kb/ops/reindex.js'),
      import('#src/engines/needle/backend.js'),
      import('#src/kb/paths.js'),
      import('#tests/helpers/kb-test-runtime.js'),
    ]);
  const realRuntime = createRealRuntime('prod');
  // Mirror the backend store db wiring so the seeded retry queue is visible to
  // the read-only query runtime that opens the same store via defaultRegistry.
  const db = openWritableStoreDbNoReset(realRuntime);
  const { kb } = createKbTestRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: kbPaths.kbRuntimeDir('prod', realRuntime.paths.configSlot),
    db,
    runtime: realRuntime,
  });

  const { bindOramaFtsForTest } = await import('#tests/unit/kb/expansion-test-helpers.js');
  bindOramaFtsForTest(kb);

  try {
    await reindex(kb);
    await applyBoundCorpusConsumerForTest(kb, db);
  } finally {
    await closeNeedleBackend(kb);
    db.close();
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
  const runtime = createRealRuntime('prod');
  const db = openStoreDatabase({
    path: runtime.paths.coral.store.dbFile,
    storage: runtime.storage,
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
    const [{ kbRuntimeDir }, { createRealRuntime }] = await Promise.all([
      import('#src/kb/paths.js'),
      import('#src/runtime/real.js'),
    ]);
    rmSync(kbRuntimeDir('prod', createRealRuntime('prod').paths.configSlot), { recursive: true, force: true });

    const { searchKnowledgeBase } = await import('#src/kb/queries.js');
    const { createKbQueryHost } = await import('#src/read-model/kb-query-runtime.js');
    const result = await searchKnowledgeBase({ query: 'authoritative' }, createKbQueryHost({ pluginRoot: REPO_ROOT }));

    expect(result).toEqual({
      results: [],
      mode: 'text',
      retrievalDiagnostics: [],
      warnings: ['kb_search_degraded_until_coordinator_rebuild'],
    });
  });

  it('resolves direct-read kb read root from plugin flavor when CORAL_KB_PATH is unset', async () => {
    const devPluginRoot = join(tempHome, 'dev-plugin');
    const devKbRoot = join(tempHome, '.coral', 'kb-dev');
    const prodKbRoot = join(tempHome, '.coral', 'kb');

    mkdirSync(join(devPluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(devPluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'dev-test', flavor: 'dev' }),
      'utf8',
    );

    writeKbFixtures(devKbRoot);
    mkdirSync(join(prodKbRoot, 'notes'), { recursive: true });
    writeFileSync(
      join(prodKbRoot, 'notes', 'coral-kb-mode.md'),
      `---
tags: [prod]
principles: []
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-21T00:00:00.000Z
entrySeq: 99
---
# Production Root

This note must not be read from a dev plugin.
`,
      'utf8',
    );

    delete process.env.CORAL_KB_PATH;

    const { readKnowledgeBaseEntry } = await import('#src/kb/queries.js');
    const { createKbQueryHost } = await import('#src/read-model/kb-query-runtime.js');
    const result = readKnowledgeBaseEntry(
      { note: 'coral-kb-mode' },
      createKbQueryHost({ projectRoot, pluginRoot: devPluginRoot }),
    );

    expect(result.title).toBe('KB Mode');
    expect(result.content).toContain('Keep the JSON index authoritative.');
  });
});
