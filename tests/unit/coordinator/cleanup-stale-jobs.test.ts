import { describe, it, expect, vi } from 'vitest';
import { cleanupStaleJobs, resolveJobRetentionMs } from '#src/coordinator/lifecycle.js';
import type { JobStore } from '#src/jobs/store.js';
import type { JobStatus } from '#src/jobs/records.js';

const NOW = Date.UTC(2026, 5, 10);
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 14 * DAY_MS;
const CURRENT_BUNDLE = 'bundle-current';

function ago(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function status(over: Partial<JobStatus>): JobStatus {
  return { jobId: 'j', phase: 'completed', updatedAt: ago(0), ...over } as unknown as JobStatus;
}

function runCleanup(statuses: Record<string, JobStatus>): { pruned: string[]; purged: string[] } {
  const purged: string[] = [];
  const rmSync = vi.fn();
  const store = {
    listJobIds: () => Object.keys(statuses),
    readStatus: (id: string) => statuses[id] ?? null,
    jobDir: (id: string) => `/jobs/${id}`,
    purgeFromCache: (id: string) => purged.push(id),
  } as unknown as JobStore;

  cleanupStaleJobs(store, CURRENT_BUNDLE, () => {}, { rmSync }, NOW, RETENTION_MS);

  const pruned = rmSync.mock.calls.map((call) => String(call[0]).replace('/jobs/', ''));
  return { pruned, purged };
}

describe('cleanupStaleJobs', () => {
  it('prunes a terminal job older than the retention window', () => {
    const { pruned } = runCleanup({
      old: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(15) }),
    });
    expect(pruned).toEqual(['old']);
  });

  it('keeps a terminal job within the retention window', () => {
    const { pruned } = runCleanup({
      recent: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(1) }),
    });
    expect(pruned).toEqual([]);
  });

  it('prunes a terminal job from a previous bundle even when recent', () => {
    const { pruned } = runCleanup({
      stale: status({ phase: 'error', bundleHash: 'bundle-old', updatedAt: ago(1) }),
    });
    expect(pruned).toEqual(['stale']);
  });

  it('never prunes a live job, however old', () => {
    const { pruned } = runCleanup({
      running: status({ phase: 'running', bundleHash: 'bundle-old', updatedAt: ago(99) }),
    });
    expect(pruned).toEqual([]);
  });

  it('prunes an aged terminal job that carries no bundleHash', () => {
    const { pruned, purged } = runCleanup({
      legacy: status({ phase: 'aborted', updatedAt: ago(20) }),
    });
    expect(pruned).toEqual(['legacy']);
    expect(purged).toEqual(['legacy']);
  });

  it('keeps a recent terminal job that carries no bundleHash', () => {
    const { pruned } = runCleanup({
      fresh: status({ phase: 'completed', updatedAt: ago(2) }),
    });
    expect(pruned).toEqual([]);
  });

  it('prunes only the aged jobs in a mixed set', () => {
    const { pruned } = runCleanup({
      aged: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(30) }),
      recent: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(3) }),
      running: status({ phase: 'running', bundleHash: CURRENT_BUNDLE, updatedAt: ago(40) }),
    });
    expect(pruned.sort()).toEqual(['aged']);
  });
});

describe('resolveJobRetentionMs', () => {
  it('defaults to 14 days when unset', () => {
    expect(resolveJobRetentionMs(undefined)).toBe(14 * DAY_MS);
  });

  it('honors a positive day count', () => {
    expect(resolveJobRetentionMs('7')).toBe(7 * DAY_MS);
    expect(resolveJobRetentionMs('30')).toBe(30 * DAY_MS);
  });

  it('falls back to the default for invalid or non-positive values', () => {
    expect(resolveJobRetentionMs('0')).toBe(14 * DAY_MS);
    expect(resolveJobRetentionMs('-5')).toBe(14 * DAY_MS);
    expect(resolveJobRetentionMs('abc')).toBe(14 * DAY_MS);
    expect(resolveJobRetentionMs('')).toBe(14 * DAY_MS);
  });
});
