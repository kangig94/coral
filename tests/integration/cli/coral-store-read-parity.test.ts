import { currentCoralStoreFormat } from '#src/store-format.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Command } from 'commander';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MainMod from '#src/cli/program.js';

import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { openStoreDatabase } from '#src/store/db.js';

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
    storeFormat: currentCoralStoreFormat(),
    path: runtime.paths.coral.store.dbFile,
    storage: runtime.storage,
  });

  try {
    db.prepare(
      `INSERT INTO projection_jobs (
         job_id,
         execution_owner,
         phase,
         terminal,
         diagnostics,
         session_id,
         provider,
         project_root,
         work_dir,
         backend_namespace,
         bundle_hash,
         job_kind,
         parent_workflow_job_id,
         workflow_slot,
         created_at,
         last_seq
       ) VALUES (?, ?, ?, NULL, '{"progressFaults":[]}', ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
    ).run(
      'job-store-read-1',
      JSON.stringify({ kind: 'provider-session', id: 'session-store-read-1' }),
      'running',
      'session-store-read-1',
      'codex',
      projectRoot,
      projectRoot,
      pluginRootNamespace(join(REPO_ROOT, 'clients')),
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
  // `loadMainModule()` resets the module registry per case because these cases swap module doubles, but a
  // registry reset does not clear vitest's transform cache. Warm it once here so the first case does not
  // absorb ~1.4s of cold command-graph transform inside its 5s budget, which flaked under CI contention.
  beforeAll(async () => {
    await import('#src/cli/program.js');
  });

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
    process.env.CLAUDE_PLUGIN_ROOT = join(REPO_ROOT, 'clients');
    process.chdir(projectRoot);

    writeKbFixtures(process.env.CORAL_KB_PATH);
    seedStore(projectRoot);
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
