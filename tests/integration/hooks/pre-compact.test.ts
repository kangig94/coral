import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';

import { newRawDatabase } from '#tests/helpers/test-db.js';
import { PRE_COMPACT_HOOK, cleanupFixtures, createFixture, runHook, runHookAsync } from '#tests/unit/hooks/_helpers.js';

afterEach(cleanupFixtures);

function seedStore(
  homeDir: string,
  projectRoot: string,
  fingerprint: string,
  jobId = 'job-live',
  epoch: number | 'flat' = 1,
): void {
  const storeDir = join(homeDir, '.coral', 'gen2', 'data', 'store');
  const epochDir = epoch === 'flat' ? storeDir : join(storeDir, `epoch-${epoch}`);
  mkdirSync(epochDir, { recursive: true });
  const db = newRawDatabase(join(epochDir, 'store.db'));
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
  writeFileSync(join(epochDir, 'store.db.format'), `${fingerprint}\n`, 'utf8');
  if (epoch !== 'flat') {
    writeFileSync(join(epochDir, '.lock'), '', 'utf8');
    writeFileSync(
      join(epochDir, 'epoch.json'),
      JSON.stringify({
        supersedes: epoch === 1 ? null : epoch - 1,
        classification: { kind: 'unavailable' },
        build: {
          version: '0.10.9',
          buildSetId: 'hook-test',
          bundleHash: 'hook-test',
          flavor: 'prod',
          storeFormatFingerprint: fingerprint,
        },
        publishedAt: '2026-09-15T00:00:00.000Z',
      }),
      'utf8',
    );
  }
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

  it('does not call a vanished symlinked store root an empty store', () => {
    const fixture = createFixture();
    const hook = seedPluginManifest(
      fixture.pluginRoot,
      'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    );
    const storeRoot = join(fixture.root, '.coral', 'gen2', 'data', 'store');
    const targetRoot = join(fixture.root, 'vanished-store-target');
    mkdirSync(targetRoot, { recursive: true });
    mkdirSync(join(storeRoot, '..'), { recursive: true });
    symlinkSync(targetRoot, storeRoot, 'dir');
    rmSync(targetRoot, { recursive: true });

    const result = runHook(
      hook,
      { session_id: 'sess-vanished', cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      hook: 'pre-compact',
      message: 'fail-open',
    });
    expect(result.stderr).not.toContain('no relevant jobs to snapshot');
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
    const shmPath = join(fixture.root, '.coral', 'gen2', 'data', 'store', 'epoch-1', 'store.db-shm');
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

  it('shares one bounded SQLite wait budget across the epoch lock and store reads', async () => {
    const fixture = createFixture();
    const fingerprint = 'sha256:9999999999999999999999999999999999999999999999999999999999999999';
    const hook = seedPluginManifest(fixture.pluginRoot, fingerprint);
    seedStore(fixture.root, fixture.projectRoot, fingerprint);
    const epochDir = join(fixture.root, '.coral', 'gen2', 'data', 'store', 'epoch-1');
    const epochLock = newRawDatabase(join(epochDir, '.lock'));
    const storeLock = newRawDatabase(join(epochDir, 'store.db'));
    epochLock.exec('BEGIN EXCLUSIVE');
    storeLock.exec('BEGIN EXCLUSIVE');
    let epochLockHeld = true;

    const startedAt = performance.now();
    const hookRun = runHookAsync(
      hook,
      { session_id: 'sess-contended', cwd: fixture.projectRoot },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    ).then((result) => ({ result, elapsedMs: performance.now() - startedAt }));

    try {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      epochLock.exec('ROLLBACK');
      epochLockHeld = false;
      const { result, elapsedMs } = await hookRun;

      expect(elapsedMs).toBeGreaterThanOrEqual(1_100);
      expect(elapsedMs).toBeLessThan(2_500);
      expect(result.status).toBe(0);
      expect(existsSync(join(fixture.snapshotDir, 'hooks'))).toBe(false);
      expect(JSON.parse(result.stderr.trim())).toMatchObject({
        hook: 'pre-compact',
        message: 'fail-open',
        error: 'SQLite wait budget exhausted before the compact snapshot could be captured.',
      });
    } finally {
      if (epochLockHeld) epochLock.exec('ROLLBACK');
      storeLock.exec('ROLLBACK');
      epochLock.close();
      storeLock.close();
    }
  });

  it('reads the highest validated epoch after publication', () => {
    const fixture = createFixture();
    const fingerprint = 'sha256:7777777777777777777777777777777777777777777777777777777777777777';
    const hook = seedPluginManifest(fixture.pluginRoot, fingerprint);
    seedStore(fixture.root, fixture.projectRoot, fingerprint, 'flat-job', 'flat');
    seedStore(fixture.root, fixture.projectRoot, fingerprint, 'published-job', 1);

    const result = runHook(
      hook,
      { session_id: 'sess-published', cwd: fixture.projectRoot },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    const snapshotDir = join(fixture.snapshotDir, 'hooks');
    const snapshots = readdirSync(snapshotDir);
    expect(snapshots).toHaveLength(1);
    expect(readFileSync(join(snapshotDir, snapshots[0]), 'utf8')).toContain('published-job');
    expect(readFileSync(join(snapshotDir, snapshots[0]), 'utf8')).not.toContain('flat-job');
  });

  it('captures a snapshot through a symlinked store root', () => {
    const fixture = createFixture();
    const fingerprint = 'sha256:8888888888888888888888888888888888888888888888888888888888888888';
    const hook = seedPluginManifest(fixture.pluginRoot, fingerprint);
    const targetHome = join(fixture.root, 'store-target-home');
    seedStore(targetHome, fixture.projectRoot, fingerprint, 'symlinked-root-job');
    const configuredStore = join(fixture.root, '.coral', 'gen2', 'data', 'store');
    mkdirSync(join(configuredStore, '..'), { recursive: true });
    symlinkSync(join(targetHome, '.coral', 'gen2', 'data', 'store'), configuredStore, 'dir');

    const result = runHook(
      hook,
      { session_id: 'sess-symlinked-root', cwd: fixture.projectRoot },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    const snapshotDir = join(fixture.snapshotDir, 'hooks');
    const snapshots = existsSync(snapshotDir) ? readdirSync(snapshotDir) : [];
    console.log(
      `pre-compact-symlinked-root-cell status=${result.status} snapshots=${snapshots.length} captured=${result.stderr.includes('captured job snapshot')}`,
    );
    expect(result.status).toBe(0);
    expect(snapshots).toHaveLength(1);
    expect(readFileSync(join(snapshotDir, snapshots[0]), 'utf8')).toContain('symlinked-root-job');
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
