import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { newRawDatabase } from '#tests/helpers/test-db.js';
import { PRE_COMPACT_HOOK, cleanupFixtures, createFixture, runHook } from '#tests/unit/hooks/_helpers.js';

afterEach(cleanupFixtures);

function seedStore(homeDir: string, projectRoot: string, fingerprint: string, jobId = 'job-live'): void {
  const storeDir = join(homeDir, '.coral', 'gen2', 'data', 'store');
  mkdirSync(storeDir, { recursive: true });
  const db = newRawDatabase(join(storeDir, 'store.db'));
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE projection_jobs (
        job_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        project_root TEXT NOT NULL,
        work_dir TEXT,
        job_kind TEXT NOT NULL,
        last_seq INTEGER NOT NULL,
        CONSTRAINT projection_jobs_work_dir_authority CHECK ((job_kind = 'kb') = (work_dir IS NULL))
      );
    `);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('store_format_fingerprint', fingerprint);
    db.prepare(
      "INSERT INTO projection_jobs (job_id, phase, project_root, work_dir, job_kind, last_seq) VALUES (?, ?, ?, ?, 'provider', ?)",
    ).run(jobId, 'running', projectRoot, projectRoot, 1);
  } finally {
    db.close();
  }
  writeFileSync(join(storeDir, 'store.db.format'), `${fingerprint}\n`, 'utf8');
}

function seedPluginManifest(pluginRoot: string, fingerprint: string): string {
  cpSync(join(process.cwd(), 'clients', 'hooks'), join(pluginRoot, 'hooks'), { recursive: true });
  const bridgeDir = join(pluginRoot, 'bridge');
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(
    join(bridgeDir, 'manifest.json'),
    JSON.stringify({ bundleHash: 'hook-test', flavor: 'prod', storeFormatFingerprint: fingerprint }),
    'utf8',
  );
  return join(pluginRoot, 'hooks', 'pre-compact.mjs');
}

describe('pre-compact.mjs', () => {
  it('exits 0, emits a no-op log line, and does not write snapshots', () => {
    const fixture = createFixture();
    const result = runHook(
      PRE_COMPACT_HOOK,
      { session_id: 'sess-1', cwd: fixture.projectRoot },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot, HOME: fixture.root },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(fixture.snapshotDir)).toBe(false);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      hook: 'pre-compact',
      message: 'no relevant jobs to snapshot',
    });
  });

  it('remains fail-open with no jobs directory', () => {
    const fixture = createFixture();
    const result = runHook(
      PRE_COMPACT_HOOK,
      { session_id: 'sess-3', cwd: fixture.projectRoot },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot, HOME: fixture.root },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(fixture.snapshotDir)).toBe(false);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      hook: 'pre-compact',
      message: 'no relevant jobs to snapshot',
    });
  });

  it('does not read a projection from a mismatched store format', () => {
    const fixture = createFixture();
    const hook = seedPluginManifest(
      fixture.pluginRoot,
      'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    );
    seedStore(
      fixture.root,
      fixture.projectRoot,
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    );

    const result = runHook(
      hook,
      { session_id: 'sess-mismatch', cwd: fixture.projectRoot },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.snapshotDir, 'hooks'))).toBe(false);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      hook: 'pre-compact',
      message: 'compact snapshot skipped',
      reason: 'store format sidecar does not match the installed plugin',
    });
  });

  it('validates the executing hook manifest before opening or touching SQLite siblings', () => {
    const fixture = createFixture();
    const hooksRoot = join(fixture.pluginRoot, 'hooks');
    cpSync(join(process.cwd(), 'clients', 'hooks'), hooksRoot, { recursive: true });
    const fingerprint = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';
    seedStore(fixture.root, fixture.projectRoot, fingerprint);
    const shmPath = join(fixture.root, '.coral', 'gen2', 'data', 'store', 'store.db-shm');
    writeFileSync(shmPath, 'untouched-shm', 'utf8');
    const before = { bytes: readFileSync(shmPath), mtimeMs: statSync(shmPath).mtimeMs };

    const result = runHook(
      join(hooksRoot, 'pre-compact.mjs'),
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      message: 'compact snapshot skipped',
      reason: 'installed plugin manifest has no valid store format fingerprint',
    });
    expect(readFileSync(shmPath)).toEqual(before.bytes);
    expect(statSync(shmPath).mtimeMs).toBe(before.mtimeMs);
  });

  it('uses the executing hook manifest rather than ambient CLAUDE_PLUGIN_ROOT', () => {
    const fixture = createFixture();
    const fingerprint = 'sha256:4444444444444444444444444444444444444444444444444444444444444444';
    const hook = seedPluginManifest(fixture.pluginRoot, fingerprint);
    seedStore(fixture.root, fixture.projectRoot, fingerprint);
    const ambientRoot = join(fixture.root, 'ambient-plugin');
    seedPluginManifest(ambientRoot, 'sha256:5555555555555555555555555555555555555555555555555555555555555555');

    const result = runHook(
      hook,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PLUGIN_ROOT: ambientRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({ message: 'captured job snapshot', count: 1 });
  });

  it('reads projections only when the installed bridge manifest matches the store format', () => {
    const fixture = createFixture();
    const fingerprint = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
    const hook = seedPluginManifest(fixture.pluginRoot, fingerprint);
    seedStore(fixture.root, fixture.projectRoot, fingerprint);

    const result = runHook(
      hook,
      { session_id: 'sess-current', cwd: fixture.projectRoot },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    const snapshotDir = join(fixture.snapshotDir, 'hooks');
    expect(readdirSync(snapshotDir)).toHaveLength(1);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      hook: 'pre-compact',
      message: 'captured job snapshot',
      count: 1,
    });
  });

  it('does not prescribe a destructive store reset for one unsafe projected job ID', () => {
    const fixture = createFixture();
    const fingerprint = 'sha256:6666666666666666666666666666666666666666666666666666666666666666';
    const hook = seedPluginManifest(fixture.pluginRoot, fingerprint);
    seedStore(fixture.root, fixture.projectRoot, fingerprint, '../unsafe-job');

    const result = runHook(
      hook,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );
    const output = result.stderr
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.message === 'compact snapshot skipped');

    expect(output).toMatchObject({
      hook: 'pre-compact',
      message: 'compact snapshot skipped',
      reason: 'projection_jobs contains an unsafe job identifier',
    });
    expect(output.remediation).toContain('report this projection integrity failure');
    expect(output.remediation).not.toContain('store-reset discard');
  });
});
