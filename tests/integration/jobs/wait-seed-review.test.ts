import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { JobAddressing } from '#src/jobs/addressing.js';
import { retryUnknownHistoricalEpochs, seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createRealRuntime } from '#src/runtime/real.js';

const fingerprint = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';
const oldEpochKey = '00000000-0000-4000-8000-000000000007:7';
const runtime = createRealRuntime('prod', { baseDir: tmpdir() });

describe('a deterministic seed failure', () => {
  it('settles deterministic decode failures and resolves unknown ids to missing with a caveat', () => {
    const root = mkdtempSync(join(tmpdir(), 'nreview-hold-'));
    try {
      const epochDir = join(root, 'db', 'epoch-7');
      mkdirSync(epochDir, { recursive: true });
      const lock = new DatabaseSync(join(epochDir, '.lock'));
      lock.exec('CREATE TABLE IF NOT EXISTS m (id INTEGER)');
      lock.close();
      writeFileSync(
        join(epochDir, '.coral-lineage.v1.json'),
        JSON.stringify({ version: 'v1', lineageId: oldEpochKey.split(':')[0] }),
      );
      const db = new DatabaseSync(join(epochDir, 'store.db'));
      db.exec(`CREATE TABLE projection_jobs (job_id TEXT, execution_owner TEXT, phase TEXT, diagnostics TEXT, session_id TEXT,
      provider TEXT, project_root TEXT, backend_namespace TEXT, bundle_hash TEXT, job_kind TEXT, parent_workflow_job_id TEXT,
      workflow_slot TEXT, workflow_slot_generation INTEGER, replaces_workflow_job_id TEXT, created_at TEXT, last_seq INTEGER);
      CREATE TABLE events (seq INTEGER, ts TEXT, type TEXT, stream_kind TEXT, stream_id TEXT, body BLOB);`);

      db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'odd-job',
        JSON.stringify({ kind: 'provider-session', id: 's' }),
        'running',
        JSON.stringify({ progressFaults: [] }),
        's',
        'claude',
        '/workspace/project',
        'ns',
        null,
        'some-future-kind',
        null,
        null,
        null,
        null,
        new Date().toISOString(),
        1,
      );
      db.close();
      const index = new JobLocationIndex(runtime, root);
      const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
      seedHistoricalEpoch(runtime, index, epoch, oldEpochKey, fingerprint, join(root, 'results'), runtime.storage);
      for (let i = 0; i < 3; i++) retryUnknownHistoricalEpochs(index);

      const addressing = new JobAddressing(
        index,
        {
          epochKey: () => 'active',
          detail: () => null,
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
          waitStream: async function* () {},
        },
        () => false,
        () => 'pending',
      );
      const snap = addressing.snapshot({ jobIds: ['typo-id'] } as never);
      expect(index.unknownLocationHolds()[0]).toMatchObject({ retryScheduled: false });
      expect(index.unknownLocationHolds()[0].reason).not.toContain('\"code\"');
      expect(snap.jobs[0]).toMatchObject({
        disposition: 'missing',
        message: expect.stringContaining('no reachable clearing event'),
      });
      expect(snap.remainingJobIds).toEqual([]);
      expect(snap.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
