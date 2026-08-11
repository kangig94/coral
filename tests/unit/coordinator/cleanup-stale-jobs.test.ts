import { beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanupStaleJobs, resolveJobRetentionMs } from '#src/coordinator/lifecycle.js';
import { backendLog } from '#src/infra/backend-log.js';
import type { JobStore } from '#src/jobs/store.js';
import type { JobStatus } from '#src/jobs/records.js';
import { durableCliProcessRuntimeMetaKey } from '#src/jobs/runtime-meta.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

vi.mock('#src/infra/backend-log.js', () => ({
  backendLog: {
    warn: vi.fn(),
  },
}));

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

async function runCleanup(
  statuses: Record<string, JobStatus>,
  rmSync: ReturnType<typeof vi.fn> = vi.fn(),
  signal: AbortSignal = new AbortController().signal,
): Promise<{ pruned: string[]; purged: string[]; survivingIdentities: string[] }> {
  const runtime = new SimulationRuntime();
  const db = openTestStoreDb(runtime, ':memory:');
  const purged: string[] = [];
  const insertProjection = db.prepare(
    `INSERT INTO projection_jobs (
       job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
       project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
       workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (
       seq, ts, type, stream_kind, stream_id, namespace, project,
       correlation_id, causation_seq, refs, body
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let seq = 0;
  for (const [jobId, jobStatus] of Object.entries(statuses)) {
    const terminal = jobStatus.phase === 'completed' || jobStatus.phase === 'error' || jobStatus.phase === 'aborted';
    seq += 1;
    insertProjection.run(
      jobId,
      JSON.stringify({ kind: 'provider-session', id: `${jobId}-session` }),
      jobStatus.phase,
      terminal ? JSON.stringify({ content: '', outcome: { kind: 'completed' }, durationMs: 0 }) : null,
      '{"progressFaults":[]}',
      `${jobId}-session`,
      'codex',
      '/project',
      'namespace',
      jobStatus.bundleHash ?? null,
      'provider',
      null,
      null,
      null,
      null,
      jobStatus.updatedAt,
      seq,
    );
    if (terminal) {
      insertEvent.run(
        seq,
        jobStatus.updatedAt,
        'job.terminal.recorded',
        'job',
        jobId,
        'namespace',
        '/project',
        null,
        null,
        null,
        Buffer.from('{}'),
      );
    }
  }
  // Every job gets a recorded carrier identity, so the prune's deletion is observed by which rows survive it
  // rather than by which the test happened to seed.
  const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  for (const jobId of Object.keys(statuses)) {
    insertMeta.run(durableCliProcessRuntimeMetaKey(jobId), '{}');
  }
  const store = {
    getDb: () => db,
    jobDir: (id: string) => `/jobs/${id}`,
    purgeFromCache: (id: string) => purged.push(id),
  } as unknown as JobStore;

  let survivingIdentities: string[];
  try {
    await cleanupStaleJobs(
      store,
      CURRENT_BUNDLE,
      () => {},
      { rmSync } as unknown as Parameters<typeof cleanupStaleJobs>[3],
      NOW,
      RETENTION_MS,
      signal,
    );
  } finally {
    survivingIdentities = db
      .prepare<[string], { key: string }>('SELECT key FROM meta WHERE key LIKE ? ORDER BY key')
      .all('durable_cli_process.v1:%')
      .map((row) => row.key.replace('durable_cli_process.v1:', ''));
    db.close();
  }

  const pruned = rmSync.mock.calls.map((call) => String(call[0]).replace('/jobs/', ''));
  return { pruned, purged, survivingIdentities };
}

describe('cleanupStaleJobs', () => {
  beforeEach(() => {
    vi.mocked(backendLog.warn).mockReset();
  });

  it('prunes a terminal job older than the retention window', async () => {
    const { pruned } = await runCleanup({
      old: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(15) }),
    });
    expect(pruned).toEqual(['old']);
  });

  it('keeps a terminal job within the retention window', async () => {
    const { pruned } = await runCleanup({
      recent: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(1) }),
    });
    expect(pruned).toEqual([]);
  });

  it('prunes a terminal job from a previous bundle even when recent', async () => {
    const { pruned } = await runCleanup({
      stale: status({ phase: 'error', bundleHash: 'bundle-old', updatedAt: ago(1) }),
    });
    expect(pruned).toEqual(['stale']);
  });

  it('never prunes a live job, however old', async () => {
    const { pruned } = await runCleanup({
      running: status({ phase: 'running', bundleHash: 'bundle-old', updatedAt: ago(99) }),
    });
    expect(pruned).toEqual([]);
  });

  it('prunes an aged terminal job that carries no bundleHash', async () => {
    const { pruned, purged } = await runCleanup({
      retired: status({ phase: 'aborted', updatedAt: ago(20) }),
    });
    expect(pruned).toEqual(['retired']);
    expect(purged).toEqual(['retired']);
  });

  it('keeps a recent terminal job that carries no bundleHash', async () => {
    const { pruned } = await runCleanup({
      fresh: status({ phase: 'completed', updatedAt: ago(2) }),
    });
    expect(pruned).toEqual([]);
  });

  it('prunes only the aged jobs in a mixed set', async () => {
    const { pruned } = await runCleanup({
      aged: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(30) }),
      recent: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(3) }),
      running: status({ phase: 'running', bundleHash: CURRENT_BUNDLE, updatedAt: ago(40) }),
    });
    expect(pruned.sort()).toEqual(['aged']);
  });

  it('reclaims the pruned job’s recorded carrier identity and leaves every other one', async () => {
    // Nothing deletes this row when a job ends — a durable CLI's recorded pid and start second describe a
    // process, not a phase — so the retention prune is the only thing standing between it and unbounded
    // growth. It is reclaimed with the artifact because it is scoped to exactly the same job.
    const { survivingIdentities } = await runCleanup({
      aged: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(30) }),
      recent: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(3) }),
      running: status({ phase: 'running', bundleHash: CURRENT_BUNDLE, updatedAt: ago(40) }),
    });

    expect(survivingIdentities).toEqual(['recent', 'running']);
  });

  it('stops the prune walk when its startup signal aborts', async () => {
    const controller = new AbortController();
    const rmSync = vi.fn(() => controller.abort());

    await expect(
      runCleanup(
        {
          first: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(30) }),
          second: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(30) }),
        },
        rmSync,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(rmSync).toHaveBeenCalledTimes(1);
    expect(rmSync).toHaveBeenCalledWith('/jobs/first', { recursive: true, force: true });
  });

  it('warns when pruning a stale job artifact fails', async () => {
    const rmSync = vi.fn(() => {
      throw new Error('permission denied');
    });

    const { pruned, purged } = await runCleanup(
      {
        old: status({ phase: 'completed', bundleHash: CURRENT_BUNDLE, updatedAt: ago(15) }),
      },
      rmSync,
    );

    expect(pruned).toEqual(['old']);
    expect(purged).toEqual([]);
    expect(backendLog.warn).toHaveBeenCalledWith(expect.stringContaining('/jobs/old'));
    expect(backendLog.warn).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
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
