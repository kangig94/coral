import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { JobAddressing } from '#src/jobs/addressing.js';
import {
  seedHistoricalEpoch,
  hintHistoricalHydration,
  onHistoricalHydrationHint,
} from '#src/jobs/historical-reader.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createRealRuntime } from '#src/runtime/real.js';

const fingerprint = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';
const oldEpochKey = '00000000-0000-4000-8000-000000000007:7';
const newEpochKey = '00000000-0000-4000-8000-000000000008:8';
const runtime = createRealRuntime('prod', { baseDir: tmpdir() });
const now = new Date().toISOString();
const writer = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA journal_mode=WAL');
db.exec(\`CREATE TABLE projection_jobs (job_id TEXT, execution_owner TEXT, phase TEXT, diagnostics TEXT, session_id TEXT,
  provider TEXT, project_root TEXT, backend_namespace TEXT, bundle_hash TEXT, job_kind TEXT, parent_workflow_job_id TEXT,
  workflow_slot TEXT, workflow_slot_generation INTEGER, replaces_workflow_job_id TEXT, created_at TEXT, last_seq INTEGER);
  CREATE TABLE events (seq INTEGER, ts TEXT, type TEXT, stream_kind TEXT, stream_id TEXT, body BLOB);\`);
db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
  'old-live', JSON.stringify({ kind: 'provider-session', id: 'session-1' }), 'running', JSON.stringify({ progressFaults: [] }),
  'session-1', 'claude', '/workspace/project', 'ns', null, 'provider', null, null, null, null, '${now}', 1);
db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(1, '${now}', 'job.launch.requested', 'job', 'old-live',
  Buffer.from(JSON.stringify({ projectRoot: '/workspace/project', jobKind: 'provider', request: { cwd: '/workspace/project' } })));
console.log('ready');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (input) => {
  if (input.includes('finish')) {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE projection_jobs SET phase = ?, last_seq = ? WHERE job_id = ?').run('completed', 2, 'old-live');
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(2, '${now}', 'job.terminal.recorded', 'job', 'old-live',
      Buffer.from(JSON.stringify({ terminal: { content: 'old result', outcome: { kind: 'completed' }, durationMs: 10 } })));
    db.exec('COMMIT');
    console.log('finished');
  }
  if (input.includes('close')) { db.close(); process.exit(0); }
});`;

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'nreview-gap-'));
  const epochDir = join(root, 'db', 'epoch-7');
  mkdirSync(epochDir, { recursive: true });
  const lock = new DatabaseSync(join(epochDir, '.lock'));
  lock.exec('CREATE TABLE IF NOT EXISTS lock_marker (id INTEGER PRIMARY KEY)');
  lock.close();
  writeFileSync(
    join(epochDir, '.coral-lineage.v1.json'),
    JSON.stringify({ version: 'v1', lineageId: oldEpochKey.split(':')[0] }),
  );
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--input-type=module', '-e', writer, join(epochDir, 'store.db')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const lines: Interface = createInterface({ input: child.stdout });
  expect((await once(lines, 'line'))[0]).toBe('ready');
  const index = new JobLocationIndex(runtime, root);
  const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
  expect(
    seedHistoricalEpoch(runtime, index, epoch, oldEpochKey, fingerprint, join(root, 'results'), runtime.storage).kind,
  ).toBe('uncertified');
  mkdirSync(join(root, 'db', 'epoch-8'));
  const source = new DatabaseSync(join(epochDir, 'store.db'), { readOnly: true });
  const exporter = index.resultExportOwnerForSource(source as never, oldEpochKey, join(root, 'results'));
  let hints = 0;
  onHistoricalHydrationHint(index, () => {
    hints++;
  });
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
    (jobId) => hintHistoricalHydration(index, jobId),
  );
  const finish = async () => {
    child.stdin.write('finish\n');
    expect((await once(lines, 'line'))[0]).toBe('finished');
  };
  const hydrate = () =>
    seedHistoricalEpoch(runtime, index, epoch, oldEpochKey, fingerprint, join(root, 'results'), runtime.storage);
  const close = async () => {
    source.close();
    const e = once(child, 'exit');
    child.stdin.write('close\n');
    await e;
    rmSync(root, { recursive: true, force: true });
  };
  return { root, addressing, finish, hydrate, close, exporter, hints: () => hints };
}

describe('historical terminal observed before write-owned hydration', () => {
  it('preserves terminal delivery and the artifact continuation until hydration', async () => {
    const f = await setup();
    try {
      await f.finish(); // terminal committed in source; maintenance (5 s sweep) has not hydrated yet
      const snap = f.addressing.snapshot({ jobIds: ['old-live'] } as never);
      expect(snap.jobs[0].availability).toMatchObject({ kind: 'repair-pending' });
      expect(snap.remainingJobIds).toEqual(['old-live']);
      expect(snap.exitCode).toBe(75);
      expect(f.hints()).toBeGreaterThan(0);
      expect(existsSync(join(f.root, 'results', 'old-live', 'result.md'))).toBe(false);

      const stream = f.addressing.waitStream({
        jobIds: ['old-live'],
        supportsWaitV3: true,
        timeoutSeconds: 2,
      } as never);
      const ev = (await stream.next()).value as Record<string, unknown>;

      expect(ev).toMatchObject({
        type: 'terminal',
        availability: { kind: 'repair-pending' },
        remainingJobIds: ['old-live'],
        exitCode: 75,
      });
      await stream.return(undefined);
      f.hydrate();
      expect(f.exporter.observeResultAvailability('old-live').kind).toBe('available');
    } finally {
      await f.close();
    }
  });
  it('lets a released reader wait for transient hydration', async () => {
    const f = await setup();
    try {
      await f.finish();
      const stream = f.addressing.waitStream({
        jobIds: ['old-live'],
        supportsWaitV2: true,
        timeoutSeconds: 2,
      } as never);
      expect((await stream.next()).value).toMatchObject({ type: 'waiting', waitingJobIds: ['old-live'] });
      await stream.return(undefined);
    } finally {
      await f.close();
    }
  });
});
