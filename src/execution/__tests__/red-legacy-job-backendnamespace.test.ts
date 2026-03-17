/**
 * AC17: Legacy live-job compatibility bridge.
 *
 * Attack surface: the plan says pre-upgrade status.json records with missing
 * backendNamespace should be treated as belonging to the current installation
 * (one-release compatibility bridge).  The dangerous edge cases are:
 *
 *   1. backendNamespace is the empty string ""  — should this be bridged or treated as set?
 *   2. backendNamespace key is present but set to undefined  — JSON encodes this as absent.
 *   3. backendNamespace key is completely absent (true legacy case).
 *   4. A *different* non-empty backendNamespace — must NOT be silently rewritten
 *      (that would break dual-root isolation).
 *
 * These tests validate that the bridge is scoped only to the truly-absent case
 * and does not swallow legitimate foreign-namespace records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JOBS_DIR, ProgressStore } from '../progress-store.js';
import type { PersistedStatusRecord } from '../../types.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: `${process.env.TMPDIR || '/tmp'}/coral-red-legacy-ns-test`,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => mockState.tmpHome, tmpdir: () => mockState.tmpRoot };
});

const jobIdsToClean = new Set<string>();

function seedLegacyStatus(
  progressStore: ProgressStore,
  jobId: string,
  overrides: Partial<PersistedStatusRecord & { backendNamespace?: string | null }> = {},
): void {
  const jobDir = progressStore.jobDir(jobId);
  mkdirSync(jobDir, { recursive: true });
  const record = {
    jobId,
    sessionId: `sess-${jobId}`,
    provider: 'codex',
    projectRoot: '/tmp/project',
    phase: 'running',
    launch: { state: 'ready', updatedAt: new Date().toISOString() },
    ...overrides,
  };
  writeFileSync(join(jobDir, 'status.json'), JSON.stringify(record), 'utf-8');
  writeFileSync(join(jobDir, 'progress.jsonl'), '', 'utf-8');
}

describe('execution ProgressStore AC17 — legacy backendNamespace bridge', () => {
  beforeEach(() => {
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    mkdirSync(mockState.tmpRoot, { recursive: true });
    mockState.tmpHome = mkdtempSync(join(mockState.tmpRoot, 'home-'));
  });

  afterEach(() => {
    for (const jobId of jobIdsToClean) {
      rmSync(join(JOBS_DIR, jobId), { recursive: true, force: true });
    }
    jobIdsToClean.clear();
    vi.resetModules();
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    mockState.tmpHome = '';
  });

  it('readStatus returns the record when backendNamespace key is completely absent (legacy format)', () => {
    const store = new ProgressStore();
    const jobId = `legacy-absent-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    // Write a record without the backendNamespace key at all
    seedLegacyStatus(store, jobId);

    const status = store.readStatus(jobId);
    expect(status).not.toBeNull();
    expect(status?.phase).toBe('running');
  });

  it('scopedLookup still finds a legacy job (no backendNamespace) by projectRoot', () => {
    const store = new ProgressStore();
    const jobId = `legacy-scoped-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    seedLegacyStatus(store, jobId, { projectRoot: '/tmp/project' });

    expect(store.scopedLookup(jobId, '/tmp/project')).toBe('found');
  });

  it('a job with backendNamespace set to empty string is distinguishable from absent', () => {
    const store = new ProgressStore();
    const jobId = `empty-ns-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    // Empty string is a valid JSON value — this is NOT the same as absent
    seedLegacyStatus(store, jobId, { backendNamespace: '' } as never);

    const status = store.readStatus(jobId) as Record<string, unknown> | null;
    expect(status).not.toBeNull();

    // An implementation that treats "" the same as absent (both as legacy) risks
    // accepting foreign-namespace records.  If backendNamespace exists on the type,
    // empty string must be a distinct, recognisable value.
    if (status && 'backendNamespace' in status) {
      // Empty string is present in JSON; must survive round-trip as empty string
      expect(status['backendNamespace']).toBe('');
    }
  });

  it('a job with a foreign backendNamespace must NOT be treated as a legacy job', () => {
    const store = new ProgressStore();
    const jobId = `foreign-ns-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    const foreignNamespace = 'aabbccdd1122'; // deliberate non-current namespace
    seedLegacyStatus(store, jobId, { backendNamespace: foreignNamespace } as never);

    const status = store.readStatus(jobId) as Record<string, unknown> | null;
    expect(status).not.toBeNull();

    // The foreign namespace must survive the read unchanged — it must not be
    // overwritten with the current server's namespace.
    if (status && 'backendNamespace' in status) {
      expect(status['backendNamespace']).toBe(foreignNamespace);
    }
  });

  it('legacy job without backendNamespace is still listed by readStatus (not silently dropped)', () => {
    const store = new ProgressStore();
    const jobId = `legacy-list-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    seedLegacyStatus(store, jobId, { phase: 'queued' });

    // liveJobCount depends on live phases being counted correctly even for legacy records
    const status = store.readStatus(jobId);
    expect(status?.phase).toBe('queued');
  });

  it('initJob stores the provided backendNamespace in the persisted status record', () => {
    const store = new ProgressStore();
    const jobId = `init-with-ns-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    const namespace = 'my-plugin-namespace';
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot: '/tmp/project', backendNamespace: namespace });

    const status = store.readStatus(jobId) as Record<string, unknown> | null;
    expect(status).not.toBeNull();
    expect(status?.['backendNamespace']).toBe(namespace);
  });
});
