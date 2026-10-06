import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { readOrCreateEpochKey } from '#src/store/epoch/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';

const FP = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';

function build(progressCount: number) {
  const realRuntime = createRealRuntime('prod', { baseDir: tmpdir() });
  const runtime = { ...realRuntime, time: { ...realRuntime.time, now: () => Date.parse('2026-09-25T00:00:20.000Z') } };
  const root = mkdtempSync(join(tmpdir(), 'nreview10-hist-'));
  const epochDir = join(root, 'db', 'epoch-7');
  mkdirSync(epochDir, { recursive: true });
  writeFileSync(
    join(epochDir, '.coral-lineage.v1.json'),
    JSON.stringify({ version: 'v1', lineageId: '00000000-0000-4000-8000-000000000007' }),
  );
  const lock = newRawDatabase(join(epochDir, '.lock'));
  lock.exec('CREATE TABLE IF NOT EXISTS lock_marker (id INTEGER PRIMARY KEY)');
  lock.close();
  const db = newRawDatabase(join(epochDir, 'store.db'));
  db.exec(
    `CREATE TABLE projection_jobs (job_id TEXT, execution_owner TEXT, phase TEXT, diagnostics TEXT, session_id TEXT, provider TEXT, project_root TEXT, backend_namespace TEXT, bundle_hash TEXT, job_kind TEXT, parent_workflow_job_id TEXT, workflow_slot TEXT, workflow_slot_generation INTEGER, replaces_workflow_job_id TEXT, created_at TEXT, last_seq INTEGER);`,
  );
  db.exec(`CREATE TABLE events (seq INTEGER, ts TEXT, type TEXT, stream_kind TEXT, stream_id TEXT, body BLOB);`);
  let seq = 1;
  const ev = (type: string, id: string, body: unknown) =>
    db
      .prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)')
      .run(seq++, '2026-09-25T00:00:00.000Z', type, 'job', id, Buffer.from(JSON.stringify(body)));
  const id = 'U';
  db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
    'running',
    JSON.stringify({ progressFaults: [] }),
    'session-1',
    'claude',
    '/workspace/project',
    'ns',
    null,
    'provider',
    null,
    null,
    null,
    null,
    '2026-09-25T00:00:00.000Z',
    0,
  );
  ev('job.launch.requested', id, {
    projectRoot: '/workspace/project',
    jobKind: 'provider',
    request: { cwd: '/workspace/project' },
  });
  const timing = {
    origin: 'runtime',
    originAt: '2026-09-25T00:00:00.000Z',
    emittedAt: '2026-09-25T00:00:00.000Z',
    elapsedMs: 0,
  };
  for (let i = 1; i <= progressCount; i++)
    ev('job.progress.emitted', id, { kind: 'message', message: `line-${i}`, timing });
  const tseq = seq;
  ev('job.terminal.recorded', id, { terminal: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 } });
  db.prepare("UPDATE projection_jobs SET phase = 'completed', last_seq = ? WHERE job_id = ?").run(tseq, id);
  db.close();
  const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
  const epochKey = readOrCreateEpochKey(runtime, epoch);
  const index = new JobLocationIndex(runtime, root);
  seedHistoricalEpoch(runtime, index, epoch, epochKey, FP, join(root, 'results'), runtime.storage);
  const addressing = new JobAddressing(
    index.readOnlyView(),
    {
      visitProgress: progressVisitFromDetails(() => null),
      epochKey: () => 'another-epoch',
      detail: () => null,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'decided',
    undefined,
    () => ({ kind: 'available', resultPath: '/x' }),
  );
  return { root, epochKey, addressing };
}

it('historical windowed read: bounded wait with a cursor whose epoch watermark is below launch', async () => {
  const f = build(1000);
  try {
    const cursor = {
      jobs: [{ hash: waitJobHash('U'), epoch: waitEpochToken(f.epochKey), seq: 0, lineOffset: 0, flags: 0 }],
    };
    const events: WaitStreamEvent[] = [];
    for await (const e of f.addressing.waitStream({ jobIds: ['U'], timeoutSeconds: 2, cursor })) events.push(e);
    const progress = events.filter((e) => e.type === 'progress');
    expect(progress).toHaveLength(500);
    expect(progress.at(-1)).toMatchObject({ message: 'line-500' });
    const terminal = events.find((e) => e.type === 'terminal');

    // Expectation per AC7: lines 1..1000 are eventually deliverable; U stays in the continuation while unread progress remains.
    expect(terminal?.type === 'terminal' && terminal.remainingJobIds).toEqual(['U']);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it('historical windowed read: snapshot with a cursor whose epoch watermark is below launch', () => {
  const f = build(1000);
  try {
    const cursor = {
      jobs: [{ hash: waitJobHash('U'), epoch: waitEpochToken(f.epochKey), seq: 0, lineOffset: 0, flags: 0 }],
    };
    const snap = f.addressing.snapshot({ jobIds: ['U'], cursor });
    // A snapshot is one poll: a 499-row page and its lookahead row spend its 500-row allowance.
    expect(snap.jobs[0].progress).toHaveLength(499);

    expect(snap.remainingJobIds).toEqual(['U']);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
