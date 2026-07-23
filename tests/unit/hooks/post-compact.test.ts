import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { POST_COMPACT_HOOK, cleanupFixtures, createFixture, runHook } from '#tests/unit/hooks/_helpers.js';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { projectPathKey } from '../../../clients/hooks/lib/plugin-paths.mjs';

afterEach(cleanupFixtures);

function writeSnapshot(snapshotDir: string, capturedAtMs: number): string {
  mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = join(snapshotDir, `active-jobs-${capturedAtMs}-fixture.json`);
  writeFileSync(
    snapshotPath,
    JSON.stringify({
      capturedAtMs,
      projectRoot: '/fixture/project',
      sourceSessionId: 'sess-1',
      jobs: [{ jobId: 'job-1', phase: 'running', provider: 'codex', sessionId: 'sess-1' }],
    }),
    'utf-8',
  );
  return snapshotPath;
}

describe('post-compact.mjs', () => {
  it('uses collision- and traversal-resistant keys for Coral-owned project paths', () => {
    expect(projectPathKey('/a-b/c')).not.toBe(projectPathKey('/a/b-c'));
    expect(projectPathKey('..\\..\\escape')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('exits 0, emits a single no-op log line, and leaves snapshots untouched', () => {
    const fixture = createFixture();
    const snapshotPath = writeSnapshot(fixture.snapshotDir, Date.now() - 15 * 60_000);

    const result = runHook(
      POST_COMPACT_HOOK,
      { session_id: 'sess-1', cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(snapshotPath)).toBe(true);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      hook: 'post-compact',
      message: 'no compact snapshot found',
    });
  });

  it('exits 0 when no snapshots exist', () => {
    const fixture = createFixture();

    const result = runHook(
      POST_COMPACT_HOOK,
      { session_id: 'sess-1', cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      hook: 'post-compact',
      message: 'no compact snapshot found',
    });
  });

  it('rejects a snapshot whose embedded project does not match the current project', () => {
    const fixture = createFixture();
    const hooksDir = join(fixture.snapshotDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const snapshotPath = join(hooksDir, `active-jobs-${Date.now()}-fixture.json`);
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        version: 1,
        projectDir: '/different/project',
        capturedAtMs: Date.now(),
        jobs: [{ jobId: 'job-safe', phase: 'running', hasResult: false }],
      }),
      'utf8',
    );

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      hook: 'post-compact',
      message: 'rejected invalid compact snapshot',
      projectDir: fixture.projectRoot,
    });
  });
});
