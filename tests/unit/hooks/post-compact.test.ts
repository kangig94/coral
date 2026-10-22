import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  POST_COMPACT_HOOK,
  cleanupFixtures,
  createFixture,
  runHook,
  type HookOutput,
} from '#tests/unit/hooks/_helpers.js';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { projectPathKey } from '../../../clients/hooks/lib/plugin-paths.mjs';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { buildFlavor } from '../../../clients/hooks/lib/hook-utils.mjs';

afterEach(cleanupFixtures);

describe('post-compact.mjs', () => {
  it('recovers live jobs and readable terminal results with jobs wait commands', () => {
    const fixture = createFixture();
    const hooksDir = join(fixture.snapshotDir, 'hooks');
    const resultDir = join(
      fixture.root,
      '.coral',
      buildFlavor() === 'dev' ? 'exports-dev' : 'exports',
      'jobs',
      'job-done',
      'executions',
      '2',
    );
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(resultDir, 'result.md'), 'Recovered result', 'utf8');
    writeFileSync(
      join(hooksDir, `active-jobs-${Date.now()}-fixture.json`),
      JSON.stringify({
        version: 1,
        projectDir: fixture.projectRoot,
        capturedAtMs: Date.now(),
        jobs: [
          { jobId: 'job-live', phase: 'running', hasResult: false, resultPath: null },
          { jobId: 'job-queued', phase: 'queued', hasResult: false, resultPath: null },
          {
            jobId: 'job-done',
            execution: 2,
            phase: 'completed',
            hasResult: true,
            resultPath: join(resultDir, 'result.md'),
          },
        ],
      }),
      'utf8',
    );

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      { HOME: fixture.root, CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot },
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as HookOutput;
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const lines = output.hookSpecificOutput.additionalContext.split('\n');
    expect(lines).toContain('Run: coral-cli jobs wait job-live job-queued');
    expect(lines).toContain(`- job-done: ${join(resultDir, 'result.md')}`);
    expect(lines).toContain('- coral-cli jobs wait <job-id> --embed');
  });

  it('recovers older live snapshots that omit resultPath', () => {
    const fixture = createFixture();
    const hooksDir = join(fixture.snapshotDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, `active-jobs-${Date.now()}-fixture.json`),
      JSON.stringify({
        version: 1,
        projectDir: fixture.projectRoot,
        capturedAtMs: Date.now(),
        jobs: [{ jobId: 'job-live', phase: 'queued', hasResult: false }],
      }),
    );
    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        HOME: fixture.root,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('coral-cli jobs wait job-live');
  });

  it.each(['outside', 'traversal', 'wrong-suffix', 'prefix-sibling'])(
    'rejects a snapshot result path with %s',
    (kind) => {
      const fixture = createFixture();
      const hooksDir = join(fixture.snapshotDir, 'hooks');
      const jobsRoot = join(fixture.root, '.coral', buildFlavor() === 'dev' ? 'exports-dev' : 'exports', 'jobs');
      const paths = {
        outside: join(fixture.root, 'result.md'),
        traversal: `${jobsRoot}/../../result.md`,
        'wrong-suffix': `${jobsRoot}/job-1/native.jsonl`,
        'prefix-sibling': `${jobsRoot}-other/result.md`,
      };
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(
        join(hooksDir, `active-jobs-${Date.now()}-fixture.json`),
        JSON.stringify({
          version: 1,
          projectDir: fixture.projectRoot,
          capturedAtMs: Date.now(),
          jobs: [
            {
              jobId: 'job-live',
              execution: 1,
              phase: 'running',
              hasResult: false,
              resultPath: paths[kind as keyof typeof paths],
            },
          ],
        }),
      );
      const result = runHook(
        POST_COMPACT_HOOK,
        { cwd: fixture.projectRoot },
        {
          HOME: fixture.root,
          CLAUDE_PROJECT_DIR: fixture.projectRoot,
          TMPDIR: fixture.tmpRoot,
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('rejected invalid compact snapshot');
    },
  );

  it.each([
    ['another job', 'job-other', 2, 2],
    ['another execution', 'job-done', 3, 2],
    ['missing execution', 'job-done', 2, undefined],
    ['null execution', 'job-done', 2, null],
    ['zero execution', 'job-done', 2, 0],
    ['negative execution', 'job-done', 2, -1],
    ['fractional execution', 'job-done', 2, 1.5],
    ['string execution', 'job-done', 2, '2'],
    ['unsafe execution', 'job-done', 2, Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a terminal snapshot pointing to %s', (_name, artifactJob, artifactExecution, execution) => {
    const fixture = createFixture();
    const hooksDir = join(fixture.snapshotDir, 'hooks');
    const resultDir = join(
      fixture.root,
      '.coral',
      buildFlavor() === 'dev' ? 'exports-dev' : 'exports',
      'jobs',
      String(artifactJob),
      'executions',
      String(artifactExecution),
    );
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(resultDir, 'result.md'), 'A readable result');
    writeFileSync(
      join(hooksDir, `active-jobs-${Date.now()}-fixture.json`),
      JSON.stringify({
        version: 1,
        projectDir: fixture.projectRoot,
        capturedAtMs: Date.now(),
        jobs: [
          {
            jobId: 'job-done',
            execution,
            phase: 'completed',
            hasResult: true,
            resultPath: join(resultDir, 'result.md'),
          },
        ],
      }),
    );
    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      { HOME: fixture.root, CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('rejected invalid compact snapshot');
  });

  it('rejects a terminal row without an execution even when no artifact path is supplied', () => {
    const fixture = createFixture();
    const hooksDir = join(fixture.snapshotDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, `active-jobs-${Date.now()}-fixture.json`),
      JSON.stringify({
        version: 1,
        projectDir: fixture.projectRoot,
        capturedAtMs: Date.now(),
        jobs: [
          { jobId: 'job-live', execution: 1, phase: 'running', hasResult: false, resultPath: null },
          { jobId: 'job-done', phase: 'completed', hasResult: false, resultPath: null },
        ],
      }),
    );
    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      { HOME: fixture.root, CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('rejected invalid compact snapshot');
  });

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
        jobs: [{ jobId: 'job-safe', phase: 'running', hasResult: false, resultPath: null }],
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
