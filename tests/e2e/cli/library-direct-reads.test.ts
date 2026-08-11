import { currentCoralStoreFormat } from '#src/store-format.js';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { memoDir } from '#src/kb/paths.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { CoralStore } from '#src/read-model/coral-store.js';
import { openStoreDatabase } from '#src/store/db.js';
import { storePaths } from '#src/infra/path/store.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { formatJobsList, renderJobsList } from '#src/cli/format/jobs.js';
import { formatKbMemoList, formatKbPrinciples, formatKbRead, formatKbSourceList } from '#src/cli/format/kb.js';

const REPO_ROOT = process.cwd();
const SOURCE_BUNDLE_DIR = process.env.CORAL_E2E_BUNDLE_DIR ?? join(REPO_ROOT, 'clients', 'build');
const SOURCE_CLI_BUNDLE = join(SOURCE_BUNDLE_DIR, 'coral-cli.cjs');
const SOURCE_MANIFEST = join(SOURCE_BUNDLE_DIR, 'manifest.json');
const SOURCE_SQLITE3_DIR = join(REPO_ROOT, 'node_modules', 'better-sqlite3');
const FIXED_NOW = new Date('2026-03-22T00:00:00.000Z');

const tempRoots: string[] = [];

type Fixture = {
  root: string;
  home: string;
  projectRoot: string;
  kbRoot: string;
  flavor: 'prod' | 'dev';
  probeScriptPath: string;
  probeLogPath: string;
};

type ReadCommandCase = {
  readonly name: string;
  readonly args: string[];
};

const READ_COMMANDS: ReadonlyArray<ReadCommandCase> = [
  { name: 'jobs', args: ['jobs'] },
  { name: 'kb principles', args: ['kb', 'principles'] },
  { name: 'kb read', args: ['kb', 'read', 'coral-kb-mode'] },
  { name: 'kb source list', args: ['kb', 'source', 'list'] },
  { name: 'kb memo list', args: ['kb', 'memo', 'list'] },
];

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'coral-library-direct-plugin-'));
  const home = mkdtempSync(join(tmpdir(), 'coral-library-direct-home-'));
  const projectRoot = join(root, 'project');
  const kbRoot = join(home, 'vault');
  const probeScriptPath = join(root, 'probe.cjs');
  const probeLogPath = join(root, 'probe.log');

  tempRoots.push(root, home);

  mkdirSync(join(root, 'bridge'), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  copyFileSync(SOURCE_CLI_BUNDLE, join(root, 'bridge', 'coral-cli.cjs'));
  copyFileSync(SOURCE_MANIFEST, join(root, 'bridge', 'manifest.json'));

  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(SOURCE_SQLITE3_DIR, join(root, 'node_modules', 'better-sqlite3'), 'dir');

  writeFileSync(
    probeScriptPath,
    `const fs = require('node:fs');
const net = require('node:net');
const marker = process.env.CORAL_SOCKET_PROBE_FILE;
const fixedNow = Number(process.env.CORAL_FIXED_NOW_MS || '0');
if (Number.isFinite(fixedNow) && fixedNow > 0) {
  Date.now = () => fixedNow;
}
function fail(kind, args) {
  if (marker) {
    fs.appendFileSync(marker, JSON.stringify({ kind, args }) + '\\n');
  }
  throw new Error('Unexpected network connect during direct-read command');
}
net.connect = (...args) => fail('net.connect', args);
net.createConnection = (...args) => fail('net.createConnection', args);
net.Socket.prototype.connect = function (...args) {
  fail('socket.connect', args);
};
`,
    'utf-8',
  );

  return {
    root,
    home,
    projectRoot,
    kbRoot,
    flavor: 'prod',
    probeScriptPath,
    probeLogPath,
  };
}

function writeKbFixtures(kbRoot: string): void {
  const notesDir = join(kbRoot, 'notes');
  const principlesDir = join(kbRoot, 'principles');
  const sourcesDir = join(kbRoot, 'sources');

  mkdirSync(notesDir, { recursive: true });
  mkdirSync(principlesDir, { recursive: true });
  mkdirSync(sourcesDir, { recursive: true });

  writeFileSync(
    join(notesDir, 'coral-kb-mode.md'),
    `---
tags: [coral, kb]
principles: [contract-first-design]
source:
  - sqlite/overview
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

  writeFileSync(
    join(sourcesDir, 'sqlite-overview.md'),
    `---
title: SQLite Overview
type: reference
source: sqlite/overview
importedAt: 2026-03-20T00:00:00.000Z
tags: [sqlite, storage]
entrySeq: 7
---
# SQLite Overview

SQLite notes backing KB reads.
`,
    'utf8',
  );
}

function writeMemoFixture(fixture: Fixture): void {
  // Resolve the per-project data dir under the fixture home — the same path the
  // CLI subprocess (HOME=fixture.home) computes via `runtime.paths.projectData`.
  const projectData = createRealRuntime(fixture.flavor, { baseDir: fixture.home }).paths.projectData(
    fixture.projectRoot,
  );
  const dir = memoDir(projectData);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '20260321-010203-kb.md'),
    `---
source: local/project
---

Memo summary line
Second line
`,
    'utf-8',
  );
}

function seedStore(fixture: Fixture): void {
  const runtime = createRealRuntime('prod');
  const db = openStoreDatabase({
    storeFormat: currentCoralStoreFormat(),
    path: storePaths(fixture.flavor, { baseDir: join(fixture.home, '.coral') }).dbFile,
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
         backend_namespace,
         bundle_hash,
         job_kind,
         parent_workflow_job_id,
         workflow_slot,
         created_at,
         last_seq
       ) VALUES (?, ?, ?, NULL, '{"progressFaults":[]}', ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
    ).run(
      'job-library-read-1',
      JSON.stringify({ kind: 'provider-session', id: 'session-library-read-1' }),
      'running',
      'session-library-read-1',
      'codex',
      fixture.projectRoot,
      pluginRootNamespace(fixture.root),
      'provider',
      '2026-03-21T00:00:00.000Z',
      0,
    );
  } finally {
    db.close();
  }
}

function readProbeAttempts(fixture: Fixture): Array<{ kind: string; args: unknown[] }> {
  if (!existsSync(fixture.probeLogPath)) {
    return [];
  }

  return readFileSync(fixture.probeLogPath, 'utf-8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { kind: string; args: unknown[] });
}

function coordinatorArtifacts(fixture: Fixture): { infoFile: string; socketPath: string } {
  const paths = coordinatorPaths(
    fixture.flavor,
    { HOME: fixture.home, TMPDIR: fixture.home },
    {
      baseDir: join(fixture.home, '.coral'),
    },
  );
  return {
    infoFile: paths.infoFile,
    socketPath: paths.socketPath,
  };
}

function runCliSubprocess(
  fixture: Fixture,
  args: string[],
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync('node', [join(fixture.root, 'bridge', 'coral-cli.cjs'), ...args], {
    cwd: fixture.projectRoot,
    env: {
      ...process.env,
      HOME: fixture.home,
      TMPDIR: fixture.home,
      // Keep plugin discovery inside the fixture instead of inheriting the
      // runner's Claude installation.
      CLAUDE_CONFIG_DIR: join(fixture.home, '.claude'),
      CORAL_KB_PATH: fixture.kbRoot,
      CLAUDE_PLUGIN_ROOT: fixture.root,
      NODE_OPTIONS: `--require ${fixture.probeScriptPath}`,
      CORAL_SOCKET_PROBE_FILE: fixture.probeLogPath,
      CORAL_FIXED_NOW_MS: String(FIXED_NOW.getTime()),
    },
    encoding: 'utf-8',
    timeout: 60_000,
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}

async function expectedOutput(fixture: Fixture, testCase: ReadCommandCase): Promise<string> {
  const runtime = createRealRuntime('prod');
  const db = openStoreDatabase({
    storeFormat: currentCoralStoreFormat(),
    path: storePaths(fixture.flavor, { baseDir: join(fixture.home, '.coral') }).dbFile,
    storage: runtime.storage,
    readonly: true,
  });

  try {
    const store = new CoralStore(db, createDefaultStoreReadContext(), {
      runtime,
      projectRoot: fixture.projectRoot,
      pluginRoot: fixture.root,
    });

    switch (testCase.name) {
      case 'jobs':
        return `${renderJobsList(formatJobsList({ jobs: store.jobs.list({}) }, FIXED_NOW.getTime()), { cwd: fixture.projectRoot })}\n`;
      case 'kb principles':
        return `${formatKbPrinciples(await store.kb.listPrinciples({}))}\n`;
      case 'kb read':
        return `${formatKbRead(store.kb.read({ note: 'coral-kb-mode' }))}\n`;
      case 'kb source list':
        return `${formatKbSourceList(await store.kb.listSources())}\n`;
      case 'kb memo list':
        return `${formatKbMemoList(store.kb.listMemos({}))}\n`;
      default:
        throw new Error(`Unhandled direct-read command: ${testCase.name}`);
    }
  } finally {
    db.close();
  }
}

async function withFixtureEnvironment<T>(fixture: Fixture, run: () => Promise<T> | T): Promise<T> {
  const originalHome = process.env.HOME;
  const originalTmpdir = process.env.TMPDIR;
  const originalKbPath = process.env.CORAL_KB_PATH;
  const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const originalCwd = process.cwd();

  process.env.HOME = fixture.home;
  process.env.TMPDIR = fixture.home;
  process.env.CORAL_KB_PATH = fixture.kbRoot;
  process.env.CLAUDE_PLUGIN_ROOT = fixture.root;
  process.chdir(fixture.projectRoot);

  try {
    return await run();
  } finally {
    process.chdir(originalCwd);

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdir;
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
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('cli library-direct reads', () => {
  it.each(READ_COMMANDS)('runs %s without a coordinator and never opens IPC', async (testCase) => {
    if (!existsSync(SOURCE_CLI_BUNDLE) || !existsSync(SOURCE_MANIFEST)) {
      throw new Error(`Expected coral-cli.cjs and manifest.json in ${SOURCE_BUNDLE_DIR}.`);
    }

    const fixture = createFixture();
    writeKbFixtures(fixture.kbRoot);
    writeMemoFixture(fixture);
    seedStore(fixture);

    const expected = await withFixtureEnvironment(fixture, () => expectedOutput(fixture, testCase));
    const artifacts = coordinatorArtifacts(fixture);

    expect(existsSync(artifacts.infoFile)).toBe(false);
    expect(existsSync(artifacts.socketPath)).toBe(false);

    const result = runCliSubprocess(fixture, testCase.args);
    if (result.error) {
      throw result.error;
    }

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(expected);
    expect(readProbeAttempts(fixture)).toEqual([]);
    expect(existsSync(artifacts.infoFile)).toBe(false);
    expect(existsSync(artifacts.socketPath)).toBe(false);
  });

  it('prints an informational note when the CoralStore database does not exist yet', () => {
    if (!existsSync(SOURCE_CLI_BUNDLE) || !existsSync(SOURCE_MANIFEST)) {
      throw new Error(`Expected coral-cli.cjs and manifest.json in ${SOURCE_BUNDLE_DIR}.`);
    }

    const fixture = createFixture();
    const artifacts = coordinatorArtifacts(fixture);
    const expectedStorePath = storePaths(fixture.flavor, { baseDir: join(fixture.home, '.coral') }).dbFile;

    const result = runCliSubprocess(fixture, ['jobs']);
    if (result.error) {
      throw result.error;
    }

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      `No jobs match live phases\n(no store at ${expectedStorePath} — showing empty results)\n`,
    );
    expect(readProbeAttempts(fixture)).toEqual([]);
    expect(existsSync(artifacts.infoFile)).toBe(false);
    expect(existsSync(artifacts.socketPath)).toBe(false);
  });
});
