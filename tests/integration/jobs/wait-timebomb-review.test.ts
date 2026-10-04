import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { JobAddressing } from '#src/jobs/addressing.js';
import { seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createRealRuntime } from '#src/runtime/real.js';

const fingerprint = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';
const oldEpochKey = '00000000-0000-4000-8000-000000000007:7';
const newEpochKey = '00000000-0000-4000-8000-000000000008:8';
const real = createRealRuntime('prod', { baseDir: tmpdir() });
const offset = 5 * 86_400_000;
const runtime = { ...real, time: { ...real.time, now: () => Date.now() + offset } };
const now = new Date(runtime.time.now() - 10_000).toISOString();
const writer = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA journal_mode=WAL');
db.exec(\`CREATE TABLE projection_jobs (job_id TEXT, execution_owner TEXT, phase TEXT, diagnostics TEXT, session_id TEXT,
  provider TEXT, project_root TEXT, backend_namespace TEXT, bundle_hash TEXT, job_kind TEXT, parent_workflow_job_id TEXT,
  workflow_slot TEXT, workflow_slot_generation INTEGER, replaces_workflow_job_id TEXT, created_at TEXT, last_seq INTEGER);
  CREATE TABLE events (seq INTEGER, ts TEXT, type TEXT, stream_kind TEXT, stream_id TEXT, body BLOB);\`);
db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
  'old-live', JSON.stringify({ kind: 'provider-session', id: 'session-1' }), 'completed', JSON.stringify({ progressFaults: [] }),
  'session-1', 'claude', '/workspace/project', 'ns', null, 'provider', null, null, null, null, '${now}', 2);
db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(1, '${now}', 'job.launch.requested', 'job', 'old-live',
  Buffer.from(JSON.stringify({ projectRoot: '/workspace/project', jobKind: 'provider', request: { cwd: '/workspace/project' } })));
db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(2, '${now}', 'job.terminal.recorded', 'job', 'old-live',
  Buffer.from(JSON.stringify({ terminal: { content: 'old result', outcome: { kind: 'completed' }, durationMs: 10 } })));
db.close();
console.log('ready');`;

describe('a forward wall-clock step (measured every ~35 s on this WSL2 host)', () => {
  it('keeps fresh historical fixtures inside retention when the host date advances (timebomb probe)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nreview-step-'));
    const epochDir = join(root, 'db', 'epoch-7');
    mkdirSync(epochDir, { recursive: true });
    const lock = new DatabaseSync(join(epochDir, '.lock'));
    lock.exec('CREATE TABLE IF NOT EXISTS m (id INTEGER)');
    lock.close();
    writeFileSync(
      join(epochDir, '.coral-lineage.v1.json'),
      JSON.stringify({ version: 'v1', lineageId: oldEpochKey.split(':')[0] }),
    );
    const child = spawn(process.execPath, ['--input-type=module', '-e', writer, join(epochDir, 'store.db')]);
    expect((await once(createInterface({ input: child.stdout }), 'line'))[0]).toBe('ready');
    const index = new JobLocationIndex(runtime as never, root);
    index.read('warm');
    (await import('#src/jobs/retention-clock.js')).trustedJobRetentionCutoff(runtime as never);
    seedHistoricalEpoch(
      runtime as never,
      index,
      { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
      oldEpochKey,
      fingerprint,
      join(root, 'results'),
      real.storage,
    );
    const source = new DatabaseSync(join(epochDir, 'store.db'), { readOnly: true });
    const exporter = index.resultExportOwnerForSource(source as never, oldEpochKey, join(root, 'results'));
    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => newEpochKey,
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        waitStream: async function* () {},
      },
      () => false,
      () => 'pending',
      undefined,
      (jobId) => exporter.observeResultAvailability(jobId),
    );
    expect(existsSync(join(root, 'results', 'old-live', 'result.md'))).toBe(true);
    const v2 = addressing.waitStream({ jobIds: ['old-live'], supportsWaitV2: true } as never);
    expect((await v2.next()).value).toMatchObject({
      type: 'terminal',
      resultPath: join(root, 'results', 'old-live', 'result.md'),
    });
    await v2.return(undefined);
    const v3 = addressing.waitStream({ jobIds: ['old-live'], supportsWaitV3: true, timeoutSeconds: 1 } as never);
    const ev = (await v3.next()).value as Record<string, unknown>;
    expect(ev).toMatchObject({
      type: 'terminal',
      availability: { kind: 'available' },
      remainingJobIds: [],
      exitCode: 0,
    });
    await v3.return(undefined);
    source.close();
    rmSync(root, { recursive: true, force: true });
  });
});
