import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  POST_COMPACT_HOOK,
  cleanupFixtures,
  createFixture,
  expectHookOutput,
  runHook,
} from './_helpers.js';
import type { JobStatus, SnapshotRecord } from './_helpers.js';

afterEach(cleanupFixtures);

function writeStatus(jobsDir: string, status: JobStatus): void {
  const jobDir = join(jobsDir, status.jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'status.json'), JSON.stringify(status), 'utf-8');
}

function writeResultArtifact(jobsDir: string, jobId: string, content = '# result'): void {
  const jobDir = join(jobsDir, jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'result.md'), content, 'utf-8');
}

function writeSnapshot(snapshotDir: string, snapshot: SnapshotRecord, suffix = 'fixture'): string {
  mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = join(snapshotDir, `active-jobs-${snapshot.capturedAtMs}-${suffix}.json`);
  writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf-8');
  return snapshotPath;
}

describe('post-compact.mjs', () => {
  it('outputs pending jobs with wait() action', () => {
    const fixture = createFixture();
    const snapshot: SnapshotRecord = {
      capturedAtMs: Date.now(),
      projectRoot: fixture.projectRoot,
      sourceSessionId: 'sess-1',
      jobs: [
        { jobId: 'test-job-pending-a', phase: 'running', provider: 'codex', sessionId: 'sess-a' },
        { jobId: 'test-job-pending-b', phase: 'queued', provider: 'codex', sessionId: 'sess-b' },
      ],
    };
    writeSnapshot(fixture.snapshotDir, snapshot, 'pending');
    writeStatus(fixture.jobsDir, {
      jobId: 'test-job-pending-a',
      phase: 'running',
      projectRoot: fixture.projectRoot,
      provider: 'codex',
      sessionId: 'sess-a',
    });
    writeStatus(fixture.jobsDir, {
      jobId: 'test-job-pending-b',
      phase: 'queued',
      projectRoot: fixture.projectRoot,
      provider: 'codex',
      sessionId: 'sess-b',
    });

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext).toContain('Pending:');
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'Run coral-cli wait --jobs test-job-pending-a,test-job-pending-b --output-format json to resume monitoring.',
    );
    expect(output.hookSpecificOutput.additionalContext).toContain('test-job-pending-a');
    expect(output.hookSpecificOutput.additionalContext).toContain('test-job-pending-b');
  });

  it('outputs terminal guidance for completed provider job with no artifact', () => {
    const fixture = createFixture();
    writeSnapshot(
      fixture.snapshotDir,
      {
        capturedAtMs: Date.now(),
        projectRoot: fixture.projectRoot,
        sourceSessionId: 'sess-1',
        jobs: [{ jobId: 'test-job-complete-no-artifact', phase: 'running', provider: 'codex', sessionId: 'sess-1' }],
      },
      'provider-terminal',
    );
    writeStatus(fixture.jobsDir, {
      jobId: 'test-job-complete-no-artifact',
      phase: 'completed',
      projectRoot: fixture.projectRoot,
      provider: 'codex',
      sessionId: 'sess-1',
    });

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('Completed during compaction:');
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'Use coral-cli wait --jobs "test-job-complete-no-artifact" --output-format json --embed to attempt replay.',
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'Read event.result.content from the terminal JSON line if present; otherwise Read(event.result.path) for the full artifact.',
    );
  });

  it('outputs Read path for completed job with result.md', () => {
    const fixture = createFixture();
    writeSnapshot(
      fixture.snapshotDir,
      {
        capturedAtMs: Date.now(),
        projectRoot: fixture.projectRoot,
        sourceSessionId: 'sess-1',
        jobs: [{ jobId: 'test-job-with-result', phase: 'running', provider: 'codex', sessionId: 'sess-1' }],
      },
      'artifact',
    );
    writeStatus(fixture.jobsDir, {
      jobId: 'test-job-with-result',
      phase: 'completed',
      projectRoot: fixture.projectRoot,
      provider: 'codex',
      sessionId: 'sess-1',
    });
    writeResultArtifact(fixture.jobsDir, 'test-job-with-result');

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('Read ');
    expect(output.hookSpecificOutput.additionalContext).toContain('result.md');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('inline: true');
  });

  it('outputs missing bucket for ENOENT job', () => {
    const fixture = createFixture();
    writeSnapshot(
      fixture.snapshotDir,
      {
        capturedAtMs: Date.now(),
        projectRoot: fixture.projectRoot,
        sourceSessionId: 'sess-1',
        jobs: [{ jobId: 'test-job-missing', phase: 'running', provider: 'codex', sessionId: 'sess-1' }],
      },
      'missing',
    );

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('Status unavailable:');
    expect(output.hookSpecificOutput.additionalContext).toContain('missing');
  });

  it('deletes stale snapshots (>10min old)', () => {
    const fixture = createFixture();
    const staleSnapshotPath = writeSnapshot(
      fixture.snapshotDir,
      {
        capturedAtMs: Date.now() - 15 * 60_000,
        projectRoot: fixture.projectRoot,
        sourceSessionId: 'sess-1',
        jobs: [{ jobId: 'test-job-stale', phase: 'running', provider: 'codex', sessionId: 'sess-1' }],
      },
      'stale',
    );

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(existsSync(staleSnapshotPath)).toBe(false);
  });

  it('exits silently when no snapshots', () => {
    const fixture = createFixture();

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});
