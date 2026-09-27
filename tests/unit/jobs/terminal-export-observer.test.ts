import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AppendedEvent } from '#src/store/append.js';
import {
  ensureResultMarkdownArtifact,
  observeTerminalResultExports,
  writeResultArtifact,
} from '#src/jobs/terminal/export.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { PROJECTION_JOB_COLUMNS } from '#src/jobs/projection-row.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

function appended(overrides: Partial<AppendedEvent> & Pick<AppendedEvent, 'type' | 'stream'>): AppendedEvent {
  return {
    seq: 1,
    ts: '2026-09-23T00:00:00.000Z',
    namespace: 'namespace',
    project: '/project',
    body: {},
    ...overrides,
  } as AppendedEvent;
}

describe('observeTerminalResultExports', () => {
  it('durably writes an artifact before returning its location', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-result-durable-'));
    try {
      const storage = createRealRuntime('prod', { baseDir: root }).storage;
      const write = vi.spyOn(storage, 'writeAtomicDurableSync');
      const sync = vi.spyOn(storage, 'syncDirectoryDurableSync');
      const jobsRoot = join(root, 'jobs');
      const path = writeResultArtifact(storage, jobsRoot, 'job-1', 'result\n');
      expect(write).toHaveBeenCalledWith(path, 'result\n', { encoding: 'utf-8' });
      expect(sync).toHaveBeenCalledWith(jobsRoot);
      expect(readFileSync(path, 'utf8')).toBe('result\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to publish an artifact path when directory durability fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-result-sync-failure-'));
    try {
      const storage = createRealRuntime('prod', { baseDir: root }).storage;
      vi.spyOn(storage, 'syncDirectoryDurableSync').mockReturnValue(false);
      expect(() => writeResultArtifact(storage, join(root, 'jobs'), 'job-1', 'result\n')).toThrow(
        'Failed to write result artifact for job-1',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('syncs a reused artifact before treating its path as available', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-result-reused-'));
    const db = newRawDatabase(':memory:');
    try {
      db.exec(
        `CREATE TABLE projection_jobs (${PROJECTION_JOB_COLUMNS.split(', ')
          .map((name) => `${name} TEXT`)
          .join(', ')})`,
      );
      const storage = createRealRuntime('prod', { baseDir: root }).storage;
      const jobsRoot = join(root, 'jobs');
      const directory = join(jobsRoot, 'job-1');
      mkdirSync(directory, { recursive: true });
      const path = join(directory, 'result.md');
      writeFileSync(path, 'older result\n');
      const syncFile = vi.spyOn(storage, 'fdatasyncSync');
      const syncDirectory = vi.spyOn(storage, 'syncDirectoryDurableSync');

      expect(ensureResultMarkdownArtifact(db, 'job-1', jobsRoot, storage, {} as never)).toBe(path);
      expect(syncFile).toHaveBeenCalledOnce();
      expect(syncDirectory).toHaveBeenCalledWith(directory);
      expect(syncDirectory).toHaveBeenCalledWith(jobsRoot);
      expect(readFileSync(path, 'utf8')).toBe('older result\n');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('renders one export per committed job terminal', () => {
    const rendered: string[] = [];
    observeTerminalResultExports((jobId) => {
      rendered.push(jobId);
      return `/exports/${jobId}/result.md`;
    })([
      appended({ type: 'job.launch.requested', stream: { kind: 'job', id: 'job-a' } }),
      appended({ type: 'job.terminal.recorded', stream: { kind: 'job', id: 'job-a' } }),
      appended({ type: 'job.progress.emitted', stream: { kind: 'job', id: 'job-b' } }),
      appended({ type: 'job.terminal.recorded', stream: { kind: 'job', id: 'job-b' } }),
    ]);

    expect(rendered).toEqual(['job-a', 'job-b']);
  });

  it('ignores a terminal recorded on another stream kind', () => {
    const ensure = vi.fn(() => '/unused');
    observeTerminalResultExports(ensure)([
      appended({ type: 'job.terminal.recorded', stream: { kind: 'session', id: 'session-a' } }),
    ]);

    expect(ensure).not.toHaveBeenCalled();
  });

  it('keeps rendering the batch after one job fails to write', () => {
    const rendered: string[] = [];
    observeTerminalResultExports((jobId) => {
      if (jobId === 'job-a') throw new Error('disk full');
      rendered.push(jobId);
      return `/exports/${jobId}/result.md`;
    })([
      appended({ type: 'job.terminal.recorded', stream: { kind: 'job', id: 'job-a' } }),
      appended({ type: 'job.terminal.recorded', stream: { kind: 'job', id: 'job-b' } }),
    ]);

    expect(rendered).toEqual(['job-b']);
  });
});
