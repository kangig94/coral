import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { POST_COMPACT_HOOK, cleanupFixtures, createFixture, runHook } from '#tests/unit/hooks/_helpers.js';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { projectPathKey } from '../../../clients/hooks/lib/plugin-paths.mjs';

afterEach(cleanupFixtures);

describe('post-compact.mjs', () => {
  it('uses collision- and traversal-resistant keys for Coral-owned project paths', () => {
    expect(projectPathKey('/a-b/c')).not.toBe(projectPathKey('/a/b-c'));
    expect(projectPathKey('..\\..\\escape')).toMatch(/^[a-f0-9]{64}$/);
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
  });
});
