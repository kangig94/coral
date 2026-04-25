import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MainMod from '#src/cli/program.js';

import { createRealRuntime } from '#src/runtime/real.js';
import { openStoreDatabase } from '#src/store/db.js';
import { ensureStoreSchemasDir } from '#src/store/schema-loader.js';
import { storePaths } from '#src/infra/store-paths.js';

const REPO_ROOT = process.cwd();

type MainModule = typeof MainMod;

function toText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

async function loadMainModule(): Promise<MainModule> {
  vi.resetModules();
  return import('#src/cli/program.js');
}

function seedRetryQueue(entries: Array<{
  entryId: string;
  reason: string;
  observedAt: string;
  locus: string;
  canonicalIncident: string;
  signalsJson: string;
  repairHint: string;
  retryNotBefore: string;
  retryCount: number;
}>): void {
  const runtime = createRealRuntime('prod');
  const db = openStoreDatabase({
    path: storePaths('prod').dbFile,
    storage: runtime.storage,
    schemasDir: ensureStoreSchemasDir(runtime.storage),
  });

  try {
    const statement = db.prepare(
      `INSERT INTO kb_curate_retry_queue (
         entry_id,
         entry_seq,
         reason,
         observed_at,
         locus,
         canonical_incident,
         signals_json,
         repair_hint,
         retry_not_before,
         retry_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const entry of entries) {
      statement.run(
        entry.entryId,
        null,
        entry.reason,
        entry.observedAt,
        entry.locus,
        entry.canonicalIncident,
        entry.signalsJson,
        entry.repairHint,
        entry.retryNotBefore,
        entry.retryCount,
      );
    }
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
    process.exitCode = undefined;
    process.argv = ['node', 'coral-cli', ...args];
    await program.parseAsync(process.argv);
  } finally {
    process.argv = originalArgv;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  return { stdout, stderr };
}

describe('kb diagnose integration', () => {
  let tempHome: string;
  let projectRoot: string;
  let originalHome: string | undefined;
  let originalPluginRoot: string | undefined;
  let originalKbPath: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    originalKbPath = process.env.CORAL_KB_PATH;
    originalCwd = process.cwd();

    tempHome = mkdtempSync(join(tmpdir(), 'coral-kb-diagnose-'));
    projectRoot = join(tempHome, 'project');

    mkdirSync(projectRoot, { recursive: true });
    process.env.HOME = tempHome;
    process.env.CLAUDE_PLUGIN_ROOT = REPO_ROOT;
    process.env.CORAL_KB_PATH = join(tempHome, 'vault');
    process.chdir(projectRoot);
  });

  afterEach(() => {
    try {
      vi.resetModules();
      process.chdir(originalCwd);
    } finally {
      process.exitCode = undefined;

      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      if (originalPluginRoot === undefined) {
        delete process.env.CLAUDE_PLUGIN_ROOT;
      } else {
        process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
      }

      if (originalKbPath === undefined) {
        delete process.env.CORAL_KB_PATH;
      } else {
        process.env.CORAL_KB_PATH = originalKbPath;
      }

      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('prints queued manual-repair incidents with pretty-printed signals', async () => {
    seedRetryQueue([
      {
        entryId: 'note:broken-frontmatter',
        reason: 'frontmatter-shape/missing-required-fields',
        observedAt: '2026-04-21T00:00:00.000Z',
        locus: 'frontmatter-shape',
        canonicalIncident: 'frontmatter-shape/missing-required-fields',
        signalsJson: JSON.stringify({ missingFields: ['createdAt', 'updatedAt'] }),
        repairHint: 'Restore createdAt and updatedAt in note frontmatter.',
        retryNotBefore: '2026-04-21T00:05:00.000Z',
        retryCount: 2,
      },
      {
        entryId: 'source:merge-conflict',
        reason: 'file-syntax/conflict-markers',
        observedAt: '2026-04-21T01:00:00.000Z',
        locus: 'file-syntax',
        canonicalIncident: 'file-syntax/conflict-markers',
        signalsJson: JSON.stringify({ markers: ['<<<<<<<', '=======', '>>>>>>>'] }),
        repairHint: 'Resolve the conflict markers and keep one authoritative body.',
        retryNotBefore: '2026-04-21T01:15:00.000Z',
        retryCount: 0,
      },
    ]);

    const { buildProgram } = await loadMainModule();
    const { stdout, stderr } = await runCli(buildProgram(), ['kb', 'diagnose']);

    expect(stderr).toBe('');
    expect(stdout).toBe(
      'entry_id: note:broken-frontmatter\n'
        + 'locus: frontmatter-shape\n'
        + 'canonical_incident: frontmatter-shape/missing-required-fields\n'
        + 'repair_hint: Restore createdAt and updatedAt in note frontmatter.\n'
        + 'signals:\n'
        + '{\n'
        + '  "missingFields": [\n'
        + '    "createdAt",\n'
        + '    "updatedAt"\n'
        + '  ]\n'
        + '}\n'
        + 'retry_count: 2\n'
        + 'retry_not_before: 2026-04-21T00:05:00.000Z\n'
        + '\n'
        + 'entry_id: source:merge-conflict\n'
        + 'locus: file-syntax\n'
        + 'canonical_incident: file-syntax/conflict-markers\n'
        + 'repair_hint: Resolve the conflict markers and keep one authoritative body.\n'
        + 'signals:\n'
        + '{\n'
        + '  "markers": [\n'
        + '    "<<<<<<<",\n'
        + '    "=======",\n'
        + '    ">>>>>>>"\n'
        + '  ]\n'
        + '}\n'
        + 'retry_count: 0\n'
        + 'retry_not_before: 2026-04-21T01:15:00.000Z\n',
    );
  });

  it('supports the shared output-format flag for machine-readable diagnose output', async () => {
    seedRetryQueue([
      {
        entryId: 'note:broken-frontmatter',
        reason: 'frontmatter-shape/missing-required-fields',
        observedAt: '2026-04-21T00:00:00.000Z',
        locus: 'frontmatter-shape',
        canonicalIncident: 'frontmatter-shape/missing-required-fields',
        signalsJson: JSON.stringify({ missingFields: ['createdAt'] }),
        repairHint: 'Restore createdAt in note frontmatter.',
        retryNotBefore: '2026-04-21T00:05:00.000Z',
        retryCount: 1,
      },
    ]);

    const { buildProgram } = await loadMainModule();
    const { stdout, stderr } = await runCli(buildProgram(), ['kb', 'diagnose', '--output-format', 'json']);

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      incidents: [
        {
          entry_id: 'note:broken-frontmatter',
          locus: 'frontmatter-shape',
          canonical_incident: 'frontmatter-shape/missing-required-fields',
          repair_hint: 'Restore createdAt in note frontmatter.',
          signals: {
            missingFields: ['createdAt'],
          },
          retry_count: 1,
          retry_not_before: '2026-04-21T00:05:00.000Z',
        },
      ],
    });
  });

  it('prints the empty-queue message when no incidents need manual repair', async () => {
    seedRetryQueue([]);

    const { buildProgram } = await loadMainModule();
    const { stdout, stderr } = await runCli(buildProgram(), ['kb', 'diagnose']);

    expect(stderr).toBe('');
    expect(stdout).toBe('No incidents need manual repair\n');
  });
});
