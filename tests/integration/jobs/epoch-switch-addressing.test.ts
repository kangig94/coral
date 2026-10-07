import { nextFinal, nextOfType } from '#tests/helpers/wait-stream.js';
import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { admitted, savedCursor } from '#tests/helpers/wait-session.js';
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

const origin = Date.now() - 20_000;
const launchAt = new Date(origin).toISOString();
const progressAt = new Date(origin + 5000).toISOString();
const terminalAt = new Date(origin + 10_000).toISOString();

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
  'old-namespace', null, 'provider', null, null, null, null, '${launchAt}', 1,
);
db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
  1, '${launchAt}', 'job.launch.requested', 'job', 'old-live',
  Buffer.from(JSON.stringify({ projectRoot: '/workspace/project', jobKind: 'provider', request: { cwd: '/workspace/project' } })),
);
console.log('ready');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (input) => {
  if (input.includes('progress')) {
    db.prepare('UPDATE projection_jobs SET last_seq = ? WHERE job_id = ?').run(2, 'old-live');
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      2, '${progressAt}', 'job.progress.emitted', 'job', 'old-live',
      Buffer.from(JSON.stringify({ kind: 'message', message: 'old progress', timing: {
        origin: 'runtime', originAt: '${launchAt}',
        emittedAt: '${progressAt}', elapsedMs: 5000,
      } })),
    );
    console.log('progressed');
  }
  if (input.includes('finish')) {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO events SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE seq = 2)').run(
      2, '${progressAt}', 'fixture.preceding', 'workflow', 'unrelated', Buffer.from('{}'),
    );
    db.prepare('UPDATE projection_jobs SET phase = ?, last_seq = ? WHERE job_id = ?').run('completed', 3, 'old-live');
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      3, '${terminalAt}', 'job.terminal.recorded', 'job', 'old-live',
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
    let source: DatabaseSync | undefined;
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
      source = new DatabaseSync(join(epochDir, 'store.db'), { readOnly: true });
      const exporter = index.resultExportOwnerForSource(source as never, oldEpochKey, join(root, 'results'));
      let activeEpochKey = oldEpochKey;
      const addressing = new JobAddressing(
        index,
        {
          visitProgress: progressVisitFromDetails(() => null),
          epochKey: () => activeEpochKey,
          detail: () => null,
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        },
        () => false,
        () => 'pending',
        undefined,
        (jobId) => exporter.observeResultAvailability(jobId),
      );
      createNewFormatEpoch(root);
      activeEpochKey = newEpochKey;
      expect(addressing.detail('old-live')).toMatchObject({ exit: { content: 'old result' } });
      const stream = addressing.waitStream({ jobIds: ['old-live'] });
      expect((await nextFinal(stream)).value).toMatchObject({
        type: 'terminal',
        jobId: 'old-live',
        epochKey: oldEpochKey,
        cursor: null,
        remainingJobIds: [],
      });
      await stream.return(undefined);
      expect(readFileSync(join(root, 'results', 'old-live', 'result.md'), 'utf8')).toBe('old result\n');
    } finally {
      source?.close();
      await close(child);
    }
  });

  it("delivers a live WAL writer's terminal without its progress and resumes mixed waits", async () => {
    const { root, epochDir, child, lines } = await liveOlderEpoch();
    let source: DatabaseSync | undefined;
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
      source = new DatabaseSync(join(epochDir, 'store.db'), { readOnly: true });
      const exporter = index.resultExportOwnerForSource(source as never, oldEpochKey, join(root, 'results'));
      const addressing = new JobAddressing(
        index,
        {
          visitProgress: progressVisitFromDetails((jobId) =>
            jobId === 'new-live' ? (admitted(jobId, [], false, newEpochKey).detail ?? null) : null,
          ),
          epochKey: () => newEpochKey,
          detail: (jobId) => (jobId === 'new-live' ? (admitted(jobId, [], false, newEpochKey).detail ?? null) : null),
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        },
        () => false,
        () => 'pending',
        undefined,
        (jobId) => exporter.observeResultAvailability(jobId),
      );
      expect(addressing.detail('old-live')).toMatchObject({
        status: { jobId: 'old-live', phase: 'running' },
      });
      const jobIds = ['new-live', 'old-live'];
      const pending = addressing.waitStream({ jobIds, timeoutSeconds: 5 });
      const nextNotice = nextOfType(pending, 'notice');
      await progress(child, lines);
      expect(await nextNotice).toMatchObject({
        message: 'Progress from a previous store epoch is not shown for old-live.',
      });
      const next = nextFinal(pending);
      await finish(child, lines);
      seedHistoricalEpoch(
        runtime,
        index,
        { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
        oldEpochKey,
        fingerprint,
        join(root, 'results'),
        storage,
      );
      const terminal = (await next).value;
      if (terminal === undefined || terminal.type !== 'terminal') throw new Error('Expected an old-epoch terminal');
      expect(terminal).toMatchObject({
        type: 'terminal',
        jobId: 'old-live',
        epochKey: oldEpochKey,
        cursor: savedCursor(0),
      });
      await pending.return(undefined);
      expect(addressing.detail('old-live')).toMatchObject({ exit: { content: 'old result' } });
      expect(terminal.remainingJobIds).toEqual(['new-live']);
      const resumed = addressing.waitStream({
        jobIds: terminal.remainingJobIds,
        cursor: terminal.cursor ?? undefined,
        timeoutSeconds: 0.01,
      });
      expect((await nextFinal(resumed)).value).toMatchObject({
        type: 'waiting',
        cursor: savedCursor(0),
      });
      await resumed.return(undefined);
    } finally {
      source?.close();
      await close(child);
    }
  });
});
