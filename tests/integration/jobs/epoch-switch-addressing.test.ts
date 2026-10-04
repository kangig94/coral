import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { JobAddressing } from '../../../src/jobs/addressing.js';
import { seedHistoricalEpoch } from '../../../src/jobs/historical-reader.js';
import { JobLocationIndex } from '../../../src/jobs/location-index.js';
import { createRealRuntime } from '../../../src/runtime/real.js';

const fingerprint = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';
const oldEpochKey = '00000000-0000-4000-8000-000000000007:7';
const newEpochKey = '00000000-0000-4000-8000-000000000008:8';
const roots: string[] = [];
const runtime = createRealRuntime('prod', { baseDir: tmpdir() });
const storage = runtime.storage;

const writer = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA journal_mode=WAL');
db.exec(\`CREATE TABLE projection_jobs (
  job_id TEXT, execution_owner TEXT, phase TEXT, diagnostics TEXT, session_id TEXT,
  provider TEXT, project_root TEXT, backend_namespace TEXT, bundle_hash TEXT,
  job_kind TEXT, parent_workflow_job_id TEXT, workflow_slot TEXT,
  workflow_slot_generation INTEGER, replaces_workflow_job_id TEXT,
  created_at TEXT, last_seq INTEGER
); CREATE TABLE events (seq INTEGER, ts TEXT, type TEXT, stream_kind TEXT, stream_id TEXT, body BLOB);\`);
db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
  'old-live', JSON.stringify({ kind: 'provider-session', id: 'session-1' }), 'running',
  JSON.stringify({ progressFaults: [] }), 'session-1', 'claude', '/workspace/project',
  'old-namespace', null, 'provider', null, null, null, null, '2026-09-25T00:00:00.000Z', 1,
);
db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
  1, '2026-09-25T00:00:00.000Z', 'job.launch.requested', 'job', 'old-live',
  Buffer.from(JSON.stringify({ projectRoot: '/workspace/project', jobKind: 'provider', request: { cwd: '/workspace/project' } })),
);
console.log('ready');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (input) => {
  if (input.includes('progress')) {
    db.prepare('UPDATE projection_jobs SET last_seq = ? WHERE job_id = ?').run(2, 'old-live');
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      2, '2026-09-25T00:00:05.000Z', 'job.progress.emitted', 'job', 'old-live',
      Buffer.from(JSON.stringify({ kind: 'message', message: 'old progress', timing: {
        origin: 'runtime', originAt: '2026-09-25T00:00:00.000Z',
        emittedAt: '2026-09-25T00:00:05.000Z', elapsedMs: 5000,
      } })),
    );
    console.log('progressed');
  }
  if (input.includes('finish')) {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO events SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE seq = 2)').run(
      2, '2026-09-25T00:00:05.000Z', 'fixture.preceding', 'workflow', 'unrelated', Buffer.from('{}'),
    );
    db.prepare('UPDATE projection_jobs SET phase = ?, last_seq = ? WHERE job_id = ?').run('completed', 3, 'old-live');
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      3, '2026-09-25T00:00:10.000Z', 'job.terminal.recorded', 'job', 'old-live',
      Buffer.from(JSON.stringify({ terminal: { content: 'old result', outcome: { kind: 'completed' }, durationMs: 10000 } })),
    );
    db.exec('COMMIT');
    console.log('finished');
  }
  if (input.includes('close')) { db.close(); process.exit(0); }
});
`;

async function liveOlderEpoch(): Promise<{
  root: string;
  epochDir: string;
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
}> {
  const root = mkdtempSync(join(tmpdir(), 'coral-epoch-switch-'));
  roots.push(root);
  const epochDir = join(root, 'db', 'epoch-7');
  mkdirSync(epochDir, { recursive: true });
  const lock = new DatabaseSync(join(epochDir, '.lock'));
  lock.exec('CREATE TABLE IF NOT EXISTS lock_marker (id INTEGER PRIMARY KEY)');
  lock.close();
  writeFileSync(
    join(epochDir, '.coral-lineage.v1.json'),
    JSON.stringify({ version: 'v1', lineageId: oldEpochKey.split(':')[0] }),
  );
  const child = spawn(process.execPath, ['--input-type=module', '-e', writer, join(epochDir, 'store.db')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  expect((await once(lines, 'line'))[0]).toBe('ready');
  return { root, epochDir, child, lines };
}

async function finish(child: ChildProcessWithoutNullStreams, lines: Interface): Promise<void> {
  child.stdin.write('finish\n');
  expect((await once(lines, 'line'))[0]).toBe('finished');
}

async function progress(child: ChildProcessWithoutNullStreams, lines: Interface): Promise<void> {
  child.stdin.write('progress\n');
  expect((await once(lines, 'line'))[0]).toBe('progressed');
}

async function close(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.stdin.write('close\n');
  await exited;
}

function createNewFormatEpoch(root: string): void {
  const epochDir = join(root, 'db', 'epoch-8');
  mkdirSync(epochDir);
  const db = new DatabaseSync(join(epochDir, 'store.db'));
  db.exec('CREATE TABLE new_format_marker (id INTEGER PRIMARY KEY)');
  db.close();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('job addressing across a process-owned epoch switch', () => {
  it('keeps a completed old-format result addressable after switching the active epoch', async () => {
    const { root, epochDir, child, lines } = await liveOlderEpoch();
    try {
      await finish(child, lines);
      const index = new JobLocationIndex(runtime, root);
      const seeded = seedHistoricalEpoch(
        runtime,
        index,
        { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
        oldEpochKey,
        fingerprint,
        join(root, 'results'),
        storage,
      );
      expect(seeded.kind).toBe('uncertified');
      expect(index.certificate(oldEpochKey)).toBeNull();
      let activeEpochKey = oldEpochKey;
      const addressing = new JobAddressing(
        index,
        {
          epochKey: () => activeEpochKey,
          detail: () => null,
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
          waitStream: async function* () {},
        },
        () => false,
        () => 'pending',
      );
      createNewFormatEpoch(root);
      activeEpochKey = newEpochKey;
      expect(addressing.detail('old-live')).toMatchObject({ exit: { content: 'old result' } });
      const stream = addressing.waitStream({ jobIds: ['old-live'], supportsWaitV2: true });
      expect((await stream.next()).value).toMatchObject({
        type: 'terminal',
        jobId: 'old-live',
        epochKey: oldEpochKey,
        cursor: { positions: { [oldEpochKey]: 3 } },
      });
      await stream.return(undefined);
      expect(readFileSync(join(root, 'results', 'old-live', 'result.md'), 'utf8')).toBe('old result\n');
    } finally {
      await close(child);
    }
  });

  it('reads a live WAL writer and resumes mixed waits with independent epoch positions', async () => {
    const { root, epochDir, child, lines } = await liveOlderEpoch();
    try {
      const index = new JobLocationIndex(runtime, root);
      const seeded = seedHistoricalEpoch(
        runtime,
        index,
        { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
        oldEpochKey,
        fingerprint,
        join(root, 'results'),
        storage,
      );
      expect(seeded.kind).toBe('uncertified');
      expect(index.certificate(oldEpochKey)).toBeNull();
      expect(existsSync(join(epochDir, 'store.db-wal'))).toBe(true);
      index.register('new-live', newEpochKey, {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
      createNewFormatEpoch(root);
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
      );
      expect(addressing.detail('old-live')).toMatchObject({
        status: { jobId: 'old-live', phase: 'running' },
      });
      const jobIds = ['new-live', 'old-live'];
      expect(addressing.validateWait({ jobIds, cursor: { afterSeq: 1 } })?.code).toBe('wait_cursor_epoch_required');
      const pending = addressing.waitStream({ jobIds, supportsWaitV2: true, timeoutSeconds: 5 });
      const nextProgress = pending.next();
      await progress(child, lines);
      expect((await nextProgress).value).toMatchObject({
        type: 'progress',
        jobId: 'old-live',
        epochKey: oldEpochKey,
        cursor: { positions: { [newEpochKey]: 0, [oldEpochKey]: 2 } },
      });
      const next = pending.next();
      await finish(child, lines);
      const terminal = (await next).value;
      if (terminal === undefined || terminal.type !== 'terminal') throw new Error('Expected an old-epoch terminal');
      expect(terminal).toMatchObject({
        type: 'terminal',
        jobId: 'old-live',
        epochKey: oldEpochKey,
        cursor: { positions: { [newEpochKey]: 0, [oldEpochKey]: 3 } },
      });
      await pending.return(undefined);
      expect(addressing.detail('old-live')).toMatchObject({ exit: { content: 'old result' } });
      if (terminal.cursor === undefined) throw new Error('Expected a vector cursor');
      expect(addressing.validateWait({ jobIds, cursor: terminal.cursor })).toBeNull();
      expect(addressing.validateWait({ jobIds: ['old-live'], cursor: terminal.cursor })?.code).toBe(
        'wait_cursor_mismatch',
      );
      const resumed = addressing.waitStream({
        jobIds,
        cursor: terminal.cursor,
        supportsWaitV2: true,
        timeoutSeconds: 0.01,
      });
      expect((await resumed.next()).value).toMatchObject({
        type: 'waiting',
        cursor: { positions: { [newEpochKey]: 0, [oldEpochKey]: 3 } },
      });
      await resumed.return(undefined);
    } finally {
      await close(child);
    }
  });
});
