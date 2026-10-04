import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newRawDatabase } from '../../helpers/test-db.js';
import { JobLocationIndex } from '../../../src/jobs/location-index.js';
import { JobAddressing } from '../../../src/jobs/addressing.js';
import {
  refreshHistoricalEpochs,
  refreshHistoricalEpoch,
  retryUnknownHistoricalEpochs,
  seedHistoricalEpoch,
} from '../../../src/jobs/historical-reader.js';

import { readOrCreateEpochKey, protectStoreEpoch, protectedStoreEpochRoot } from '../../../src/store/epoch/index.js';

import { createRealRuntime } from '../../../src/runtime/real.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Interface } from 'node:readline';
import {
  hintHistoricalHydration,
  onHistoricalHydrationHint,
  readHistoricalSource,
} from '#src/jobs/historical-reader.js';

import { WaitSession } from '#src/jobs/wait/session.js';

const fingerprints = [
  'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52',
  'sha256:9fd970cdcb803f517d77b133bba86ae83ef1ff662f77da8656604f32c8e67980',
  'sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521',
];
const directories: string[] = [];
const realRuntime = createRealRuntime('prod', { baseDir: tmpdir() });
const runtime = { ...realRuntime, time: { ...realRuntime.time, now: () => Date.parse('2026-09-25T00:00:20.000Z') } };
const storage = runtime.storage;

function fixture(fingerprint: string) {
  const root = mkdtempSync(join(tmpdir(), 'coral-historical-reader-'));
  directories.push(root);
  const epochDir = join(root, 'db', 'epoch-7');
  mkdirSync(epochDir, { recursive: true });
  const lock = newRawDatabase(join(epochDir, '.lock'));
  lock.exec('CREATE TABLE IF NOT EXISTS lock_marker (id INTEGER PRIMARY KEY)');
  lock.close();
  const db = newRawDatabase(join(epochDir, 'store.db'));
  db.exec(`CREATE TABLE projection_jobs (
    job_id TEXT, execution_owner TEXT, phase TEXT, diagnostics TEXT, session_id TEXT,
    provider TEXT, project_root TEXT, backend_namespace TEXT, bundle_hash TEXT,
    job_kind TEXT, parent_workflow_job_id TEXT, workflow_slot TEXT,
    workflow_slot_generation INTEGER, replaces_workflow_job_id TEXT,
    created_at TEXT, last_seq INTEGER${fingerprint === fingerprints[2] ? ', work_dir TEXT' : ''}
  );`);
  db.exec(`CREATE TABLE events (
    seq INTEGER, ts TEXT, type TEXT, stream_kind TEXT, stream_id TEXT, body BLOB
  );`);
  const close = db.close.bind(db);
  db.close = () => {
    const max = db.prepare<[], { seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()?.seq ?? 0;
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)');
    for (let seq = 1; seq <= max; seq++) {
      if (db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq) !== undefined) continue;
      insert.run(seq, '2026-09-25T00:00:00.000Z', 'fixture.preceding', 'workflow', 'fixture', Buffer.from('{}'));
    }
    close();
  };
  return { root, epochDir, db };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('historical job readers', () => {
  it('resolves a protected lineage address before reading historical rows', () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    db.close();
    const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
    const epochKey = readOrCreateEpochKey(runtime, epoch);
    const address = protectStoreEpoch(runtime, epoch);
    const result = seedHistoricalEpoch(
      runtime,
      new JobLocationIndex(runtime, root),
      epoch,
      epochKey,
      fingerprints[0],
      join(root, 'results'),
      storage,
    );
    expect(result.kind).toBe('uncertified');
    expect(address.protectedPath).not.toBe(epochDir);
  });

  it('refreshes from the protected address when protection moves a seeded epoch later', () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    db.close();
    const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
    const epochKey = readOrCreateEpochKey(runtime, epoch);
    const index = new JobLocationIndex(runtime, root);
    expect(
      seedHistoricalEpoch(runtime, index, epoch, epochKey, fingerprints[0], join(root, 'results'), storage).kind,
    ).toBe('uncertified');

    protectStoreEpoch(runtime, epoch);

    expect(refreshHistoricalEpoch(index, epochKey, ['job-1'])).toBe('read');
  });

  it('never rebinds a deleted protected lineage to a new epoch with the same number', () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    db.close();
    const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
    const epochKey = readOrCreateEpochKey(runtime, epoch);
    const address = protectStoreEpoch(runtime, epoch);
    rmSync(address.protectedPath, { recursive: true });
    mkdirSync(epochDir);
    const replacement = newRawDatabase(join(epochDir, 'store.db'));
    replacement.exec('CREATE TABLE replacement (id INTEGER PRIMARY KEY)');
    replacement.close();
    const result = seedHistoricalEpoch(
      runtime,
      new JobLocationIndex(runtime, root),
      epoch,
      epochKey,
      fingerprints[0],
      join(root, 'results'),
      storage,
    );
    expect(result).toMatchObject({ kind: 'unrecoverable-retained', reason: 'retained-store-root-missing' });
  });

  for (const fingerprint of fingerprints.slice(0, 1)) {
    it(`seeds terminal and live identities for ${fingerprint.slice(0, 19)}`, () => {
      const { root, epochDir, db } = fixture(fingerprint);
      for (const [jobId, phase, lastSeq] of [
        ['finished', 'completed', 12],
        ['running', 'running', 9],
      ] as const) {
        db.prepare(
          `INSERT INTO projection_jobs VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${fingerprint === fingerprints[2] ? ', ?' : ''}
        )`,
        ).run(
          jobId,
          JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
          phase,
          JSON.stringify({ progressFaults: [] }),
          'session-1',
          'claude',
          '/workspace/project',
          'old-namespace',
          null,
          'provider',
          null,
          null,
          null,
          null,
          '2026-09-25T00:00:00.000Z',
          lastSeq,
          ...(fingerprint === fingerprints[2] ? ['/workspace/project'] : []),
        );
        db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
          lastSeq - 1,
          '2026-09-25T00:00:00.000Z',
          'job.launch.requested',
          'job',
          jobId,
          Buffer.from(
            JSON.stringify({
              projectRoot: '/workspace/project',
              jobKind: 'provider',
              request: { cwd: '/workspace/project' },
            }),
          ),
        );
      }
      db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
        12,
        '2026-09-25T00:00:10.000Z',
        'job.terminal.recorded',
        'job',
        'finished',
        Buffer.from(
          JSON.stringify({
            terminal: {
              content: 'finished result',
              outcome: { kind: 'completed' },
              durationMs: 10000,
            },
          }),
        ),
      );
      db.close();
      const index = new JobLocationIndex(runtime, root);
      const result = seedHistoricalEpoch(
        runtime,
        index,
        { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
        'lineage-old:7',
        fingerprint,
        join(root, 'results'),
        storage,
      );
      expect(result.kind).toBe('uncertified');
      expect(index.read('finished')?.disposition).toBe('terminal');
      expect(index.read('running')?.disposition).toBe('unresolved');
      expect(readFileSync(join(root, 'results', 'finished', 'result.md'), 'utf8')).toBe('finished result\n');
      expect(index.certificate('lineage-old:7')).toBeNull();
    });
  }

  it('repairs unreadable terminal detail from a retained epoch before releasing its result', async () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'finished',
      JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
      'completed',
      JSON.stringify({ progressFaults: [] }),
      'session-1',
      'claude',
      '/workspace/project',
      'old-namespace',
      null,
      'provider',
      null,
      null,
      null,
      null,
      '2026-09-25T00:00:00.000Z',
      12,
    );
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      11,
      '2026-09-25T00:00:00.000Z',
      'job.launch.requested',
      'job',
      'finished',
      Buffer.from(
        JSON.stringify({
          projectRoot: '/workspace/project',
          jobKind: 'provider',
          request: { cwd: '/workspace/project' },
        }),
      ),
    );
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      12,
      '2026-09-25T00:00:10.000Z',
      'job.terminal.recorded',
      'job',
      'finished',
      Buffer.from(
        JSON.stringify({ terminal: { content: 'finished result', outcome: { kind: 'completed' }, durationMs: 10000 } }),
      ),
    );
    db.close();
    const epochKey = 'lineage-old:7';
    const index = new JobLocationIndex(runtime, root);
    const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
    expect(
      seedHistoricalEpoch(runtime, index, epoch, epochKey, fingerprints[0], join(root, 'results'), storage, [], true)
        .kind,
    ).toBe('complete');
    const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from('finished').toString('base64url')}.json`);
    const location = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const detail = location.detail as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...location, detail: { ...detail, exit: null } }));
    expect(index.read('finished')?.detail.kind).toBe('unreadable');
    expect(index.resultsReleased(epochKey)).toBe(false);
    expect(refreshHistoricalEpoch(index, epochKey, ['finished'])).toBe('read');
    expect(index.resultsReleased(epochKey)).toBe(true);
    writeFileSync(path, JSON.stringify({ ...location, detail: { futureFormat: true } }));

    expect(index.resultsReleased(epochKey)).toBe(false);
    expect(refreshHistoricalEpoch(index, epochKey, ['finished'])).toBe('read');
    expect(index.read('finished')?.detail.kind).toBe('recorded');
    expect(index.resultsReleased(epochKey)).toBe(true);
    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => 'new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
    );
    expect(addressing.detail('finished')).toMatchObject({ status: { phase: 'completed' } });
    const stream = addressing.waitStream({ jobIds: ['finished'], supportsWaitV3: true });
    expect((await stream.next()).value).toMatchObject({
      type: 'notice',
      message: expect.stringContaining('could not be read'),
    });
    expect((await stream.next()).value).toMatchObject({ type: 'terminal', jobId: 'finished' });
    await stream.return(undefined);
  });

  it('keeps a known id unresolved when its retained root is missing', () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    db.close();
    rmSync(join(epochDir, 'store.db'));
    const index = new JobLocationIndex(runtime, root);
    const result = seedHistoricalEpoch(
      runtime,
      index,
      { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
      'lineage-old:7',
      fingerprints[0],
      join(root, 'results'),
      storage,
      [
        {
          jobId: 'known-live',
          subject: {
            projectRoot: '/workspace/project',
            workDir: '/workspace/project',
            jobKind: 'provider',
          },
        },
      ],
    );
    expect(result).toMatchObject({ kind: 'unrecoverable-retained', knownJobIds: ['known-live'] });
    expect(index.read('known-live')?.disposition).toBe('unresolved');
    expect(index.unknownLocationHold('lineage-old:7')).toBe('retained-store-root-missing');
    expect(index.certificate('lineage-old:7')).toBeNull();
  });

  it('does not finalize a known job when its protected address cannot be read', () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      5,
      '2026-09-25T00:00:00.000Z',
      'job.launch.requested',
      'job',
      'previously-unknown',
      Buffer.from(
        JSON.stringify({
          projectRoot: '/workspace/project',
          jobKind: 'provider',
          request: { cwd: '/workspace/project' },
        }),
      ),
    );
    db.close();
    const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
    const epochKey = readOrCreateEpochKey(runtime, epoch);
    protectStoreEpoch(runtime, epoch);
    const addressPath = join(
      protectedStoreEpochRoot(epoch.storeRoot),
      'addresses',
      `${Buffer.from(epochKey).toString('base64url')}.json`,
    );
    const protectedAddress = readFileSync(addressPath, 'utf8');
    writeFileSync(addressPath, '{invalid');
    const index = new JobLocationIndex(runtime, root);
    index.register('known-live', epochKey, {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    expect(
      seedHistoricalEpoch(runtime, index, epoch, epochKey, fingerprints[0], join(root, 'results'), storage),
    ).toMatchObject({ kind: 'unrecoverable-retained', reason: 'protected-epoch-address-unreadable' });
    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => 'new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
    );
    expect(addressing.outcomeUnrecoverable(['known-live'])).toEqual([]);
    expect(addressing.detail('known-live')).not.toMatchObject({ kind: 'outcome-unrecoverable' });
    expect(addressing.abort(['known-live'])).toMatchObject({
      kind: 'answered',
      result: { held: [{ jobId: 'known-live', reason: 'historical_owner_unresolved' }] },
    });
    writeFileSync(addressPath, protectedAddress);
    expect(addressing.outcomeUnrecoverable(['known-live'])).toEqual(['known-live']);
    expect(addressing.detail('known-live')).toMatchObject({ kind: 'outcome-unrecoverable' });
    expect(index.read('previously-unknown')).toBeNull();
    expect(index.unknownLocationHold(epochKey)).not.toBeNull();
    retryUnknownHistoricalEpochs(index);
    expect(index.read('previously-unknown')?.disposition).toBe('unresolved');
    expect(index.unknownLocationHold(epochKey)).toBeNull();
  });

  it('seeds a KB reindex launch alongside another job without a cwd', () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    for (const [jobId, jobKind, request] of [
      ['kb-reindex', 'kb', {}],
      ['provider-job', 'provider', { cwd: '/workspace/project' }],
    ] as const) {
      db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
        jobId === 'kb-reindex' ? 1 : 2,
        '2026-09-25T00:00:00.000Z',
        'job.launch.requested',
        'job',
        jobId,
        Buffer.from(JSON.stringify({ projectRoot: '/workspace/project', jobKind, request })),
      );
    }
    db.close();
    const index = new JobLocationIndex(runtime, root);
    expect(
      seedHistoricalEpoch(
        runtime,
        index,
        { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
        'lineage-old:7',
        fingerprints[0],
        join(root, 'results'),
        storage,
      ).kind,
    ).toBe('uncertified');
    expect(index.read('kb-reindex')).toMatchObject({ subject: { jobKind: 'kb', workDir: null } });
    expect(index.read('provider-job')).toMatchObject({
      subject: { jobKind: 'provider', workDir: '/workspace/project' },
    });
  });

  it('keeps an inventory hold when a requested-job refresh cannot scan every launch', () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      1,
      '2026-09-25T00:00:00.000Z',
      'job.launch.requested',
      'job',
      'unreadable-launch',
      Buffer.from(JSON.stringify({ projectRoot: '/workspace/project', jobKind: 'provider', request: {} })),
    );
    db.close();
    const index = new JobLocationIndex(runtime, root);
    index.register('known-live', 'lineage-old:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    expect(
      seedHistoricalEpoch(
        runtime,
        index,
        { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
        'lineage-old:7',
        fingerprints[0],
        join(root, 'results'),
        storage,
      ).kind,
    ).toBe('unrecoverable-retained');
    expect(refreshHistoricalEpoch(index, 'lineage-old:7', ['known-live'])).toBe('unreadable');
    expect(index.unknownLocationHold('lineage-old:7')).not.toBeNull();
  });

  it('keeps a launched id addressable when its projection row is missing', () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      5,
      '2026-09-25T00:00:00.000Z',
      'job.launch.requested',
      'job',
      'accepted-without-projection',
      Buffer.from(
        JSON.stringify({
          projectRoot: '/workspace/project',
          jobKind: 'provider',
          request: { cwd: '/workspace/project' },
        }),
      ),
    );
    db.close();
    const index = new JobLocationIndex(runtime, root);
    const result = seedHistoricalEpoch(
      runtime,
      index,
      { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
      'lineage-old:7',
      fingerprints[0],
      join(root, 'results'),
      storage,
    );
    expect(result).toMatchObject({ kind: 'uncertified' });
    expect(index.read('accepted-without-projection')?.disposition).toBe('unresolved');
    expect(index.certificate('lineage-old:7')).toBeNull();
  });

  it('keeps a launch-only job unresolved when its journal contains a terminal outside the projection inventory', () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      1,
      '2026-09-25T00:00:00.000Z',
      'job.launch.requested',
      'job',
      'projection-lost',
      Buffer.from(
        JSON.stringify({
          projectRoot: '/workspace/project',
          jobKind: 'provider',
          request: { cwd: '/workspace/project' },
        }),
      ),
    );
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      2,
      '2026-09-25T00:00:01.000Z',
      'job.terminal.recorded',
      'job',
      'projection-lost',
      Buffer.from(JSON.stringify({ terminal: { content: 'finished', outcome: { kind: 'completed' }, durationMs: 1 } })),
    );
    db.close();

    const index = new JobLocationIndex(runtime, root);
    const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
    expect(
      seedHistoricalEpoch(runtime, index, epoch, 'lineage-old:7', fingerprints[0], join(root, 'results'), storage),
    ).toMatchObject({ kind: 'uncertified' });

    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => 'lineage-new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
    );

    expect(addressing.detail('projection-lost')).toEqual({
      kind: 'unresolved',
      jobId: 'projection-lost',
      epochKey: 'lineage-old:7',
    });
  });

  it('serves a seeded older terminal after its eligible database root is removed', () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    db.prepare(
      `INSERT INTO projection_jobs VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`,
    ).run(
      'finished',
      JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
      'completed',
      JSON.stringify({ progressFaults: [] }),
      'session-1',
      'claude',
      '/workspace/project',
      'old-namespace',
      null,
      'provider',
      null,
      null,
      null,
      null,
      '2026-09-25T00:00:00.000Z',
      12,
    );
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      12,
      '2026-09-25T00:00:10.000Z',
      'job.terminal.recorded',
      'job',
      'finished',
      Buffer.from(
        JSON.stringify({
          terminal: {
            content: 'finished result',
            outcome: { kind: 'completed' },
            durationMs: 10000,
          },
        }),
      ),
    );
    db.close();
    const index = new JobLocationIndex(runtime, root);
    expect(
      seedHistoricalEpoch(
        runtime,
        index,
        { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
        'lineage-old:7',
        fingerprints[0],
        join(root, 'results'),
        storage,
        [],
        true,
      ).kind,
    ).toBe('complete');
    expect(index.resultsReleased('lineage-old:7')).toBe(true);
    rmSync(epochDir, { recursive: true });
    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => 'lineage-new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
    );
    expect(addressing.detail('finished')).toMatchObject({
      status: { jobId: 'finished', phase: 'completed' },
      exit: { content: 'finished result' },
    });
    expect(readFileSync(join(root, 'results', 'finished', 'result.md'), 'utf8')).toBe('finished result\n');
  });
});
{
  const fingerprint = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';
  const oldEpochKey = '00000000-0000-4000-8000-000000000007:7';
  const newEpochKey = '00000000-0000-4000-8000-000000000008:8';
  const real = createRealRuntime('prod', { baseDir: tmpdir() });
  const offset = 5 * 86400000;
  const runtime = { ...real, time: { ...real.time, now: () => Date.now() + offset } };
  const now = new Date(runtime.time.now() - 10000).toISOString();
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
}
{
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
}
{
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
}
{
  const fingerprint = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';
  const epochKey = '00000000-0000-4000-8000-000000000007:7';
  describe('a persistently unreadable historical epoch holds every unknown id as discovery-unknown', () => {
    it('settles a corrupt database hold without endless discovery', () => {
      const root = mkdtempSync(join(tmpdir(), 'coral-unbounded-discovery-'));
      try {
        const runtime = createRealRuntime('prod', { baseDir: root });
        const epochDir = join(root, 'db', 'epoch-7');
        mkdirSync(epochDir, { recursive: true });
        const lock = new DatabaseSync(join(epochDir, '.lock'));
        lock.exec('CREATE TABLE IF NOT EXISTS lock_marker (id INTEGER PRIMARY KEY)');
        lock.close();
        writeFileSync(
          join(epochDir, '.coral-lineage.v1.json'),
          JSON.stringify({ version: 'v1', lineageId: epochKey.split(':')[0] }),
        );
        writeFileSync(join(epochDir, 'store.db'), 'this is not a sqlite database at all, it is corrupt'.repeat(100));
        const index = new JobLocationIndex(runtime, root);
        seedHistoricalEpoch(
          runtime,
          index,
          { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
          epochKey,
          fingerprint,
          join(root, 'results'),
          runtime.storage,
        );
        for (let i = 0; i < 50; i++) retryUnknownHistoricalEpochs(index);
        const addressing = new JobAddressing(
          index,
          {
            epochKey: () => 'active',
            detail: () => null,
            abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
          },
          () => false,
          () => 'pending',
        );
        const admissions = addressing.admitWait({ jobIds: ['typo-not-a-job'], supportsWaitV3: true });
        const session = new WaitSession(['typo-not-a-job']);
        session.reconcile(admissions);
        expect(admissions[0].disposition).toBe('missing');
        expect(session.remaining()).toEqual([]);
        expect(index.unknownLocationHolds()[0].retryScheduled).toBe(false);
        expect(admissions[0].message).toContain('no reachable clearing event');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
  it('bounds transient seed failures to three attempts before resolving unknown ids to missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-seed-retry-'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    const epochDir = join(root, 'db', 'epoch-7');
    mkdirSync(epochDir, { recursive: true });
    const lock = new DatabaseSync(join(epochDir, '.lock'));
    lock.close();
    writeFileSync(
      join(epochDir, '.coral-lineage.v1.json'),
      JSON.stringify({ version: 'v1', lineageId: epochKey.split(':')[0] }),
    );
    writeFileSync(join(epochDir, 'store.db'), 'unused fixture bytes');
    const open = vi.spyOn(runtime.storage, 'openSqliteDatabaseSync').mockImplementation(() => {
      throw new Error('database is temporarily locked');
    });
    try {
      const index = new JobLocationIndex(runtime, root);
      seedHistoricalEpoch(
        runtime,
        index,
        { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
        epochKey,
        fingerprint,
        join(root, 'results'),
        runtime.storage,
      );
      expect(index.unknownLocationHolds()[0].retryScheduled).toBe(true);
      for (let i = 0; i < 50; i++) retryUnknownHistoricalEpochs(index);
      expect(open).toHaveBeenCalledTimes(3);
      expect(index.unknownLocationHolds()[0]).toMatchObject({
        retryScheduled: false,
        reason: expect.stringContaining('after 3 seed attempts'),
      });
      const addressing = new JobAddressing(
        index,
        {
          epochKey: () => 'active',
          detail: () => null,
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        },
        () => false,
        () => 'pending',
      );
      expect(addressing.snapshot({ jobIds: ['typo'] }).jobs[0].disposition).toBe('missing');
    } finally {
      open.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps an unobservable historical path pending instead of treating it as absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-seed-path-'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    const epochDir = join(root, 'db', 'epoch-7');
    mkdirSync(epochDir, { recursive: true });
    new DatabaseSync(join(epochDir, '.lock')).close();
    writeFileSync(
      join(epochDir, '.coral-lineage.v1.json'),
      JSON.stringify({ version: 'v1', lineageId: epochKey.split(':')[0] }),
    );
    const dbPath = join(epochDir, 'store.db');
    writeFileSync(dbPath, 'unused fixture bytes');
    const index = new JobLocationIndex(runtime, root);
    const lstat = runtime.storage.lstatSync;
    const storage = {
      ...runtime.storage,
      existsSync: (path: string) => (path === dbPath ? false : runtime.storage.existsSync(path)),
      lstatSync: ((path: string, options: never) => {
        if (path === dbPath) throw Object.assign(new Error('temporarily inaccessible'), { code: 'EACCES' });
        return lstat(path, options);
      }) as typeof lstat,
    };
    try {
      seedHistoricalEpoch(
        runtime,
        index,
        { storeRoot: join(root, 'db'), epoch: '7', path: dbPath },
        epochKey,
        fingerprint,
        join(root, 'results'),
        storage,
      );
      expect(index.unknownLocationHolds()[0]).toMatchObject({ retryScheduled: true });
      expect(index.unknownLocationHolds()[0].reason).not.toContain('retained-store-root-missing');
      expect(readHistoricalSource(index, epochKey, ['typo'])).toEqual({ kind: 'unreadable' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

it('isolates invalid job reads, continues hydration after a recording failure and skips certified epoch sweeps', () => {
  const { root, epochDir, db } = fixture(fingerprints[0]);
  for (const [i, jobId] of ['bad', 'good'].entries()) {
    db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      jobId,
      JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
      'running',
      JSON.stringify({ progressFaults: [] }),
      'session-1',
      'claude',
      '/workspace/project',
      'old-namespace',
      null,
      'provider',
      null,
      null,
      null,
      null,
      '2026-09-25T00:00:00.000Z',
      i + 1,
    );
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      i + 1,
      '2026-09-25T00:00:00.000Z',
      'job.launch.requested',
      'job',
      jobId,
      Buffer.from(
        JSON.stringify({
          projectRoot: '/workspace/project',
          jobKind: 'provider',
          request: { cwd: '/workspace/project' },
        }),
      ),
    );
  }
  db.close();
  const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
  const epochKey = readOrCreateEpochKey(runtime, epoch);
  const index = new JobLocationIndex(runtime, root);
  expect(
    seedHistoricalEpoch(runtime, index, epoch, epochKey, fingerprints[0], join(root, 'results'), storage).kind,
  ).toBe('uncertified');
  const writer = newRawDatabase(epoch.path);
  for (const [i, jobId] of ['bad', 'good'].entries()) {
    writer
      .prepare('UPDATE projection_jobs SET phase = ?, last_seq = ? WHERE job_id = ?')
      .run('completed', i + 3, jobId);
    writer
      .prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        i + 3,
        '2026-09-25T00:00:01.000Z',
        'job.terminal.recorded',
        'job',
        jobId,
        Buffer.from(
          JSON.stringify({ terminal: { content: `${jobId} result`, outcome: { kind: 'completed' }, durationMs: 1 } }),
        ),
      );
  }
  writer.prepare('UPDATE projection_jobs SET execution_owner = ? WHERE job_id = ?').run('invalid json', 'bad');
  const read = readHistoricalSource(index, epochKey, ['bad', 'good']);
  expect(read.kind).toBe('read');
  if (read.kind !== 'read') throw new Error('source unreadable');
  expect(read.unreadableJobs).toEqual(new Set(['bad']));
  expect(read.locations.get('good')?.disposition).toBe('terminal');
  const addressing = new JobAddressing(
    index.readOnlyView(),
    {
      epochKey: () => 'another-epoch',
      detail: () => null,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'pending',
  );
  expect(addressing.admitWait({ jobIds: ['good'], supportsWaitV3: true })[0].detail?.exit).not.toBeNull();
  expect(addressing.admitWait({ jobIds: ['good'], supportsWaitV3: true })[0].progressUnknown).toBe(false);
  const hydration = vi.fn();
  onHistoricalHydrationHint(index, hydration);
  index.holdUnknownLocations(epochKey, 'held without retry');
  for (let hint = 0; hint < 40; hint++) hintHistoricalHydration(index, 'good');
  expect(hydration).not.toHaveBeenCalled();
  index.clearUnknownLocations(epochKey);
  onHistoricalHydrationHint(index, null);

  writer
    .prepare('UPDATE projection_jobs SET execution_owner = ? WHERE job_id = ?')
    .run(JSON.stringify({ kind: 'provider-session', id: 'session-1' }), 'bad');
  writer.close();
  const record = index.recordTerminal.bind(index);
  const failure = vi.spyOn(index, 'recordTerminal').mockImplementation((jobId, ...args) => {
    if (jobId === 'bad') throw new Error('location write failed');
    return record(jobId, ...args);
  });
  expect(refreshHistoricalEpoch(index, epochKey, ['bad', 'good'])).toBe('unreadable');
  expect(index.read('good')?.disposition).toBe('terminal');
  expect(index.certificate(epochKey)).toBeNull();
  failure.mockRestore();
  expect(refreshHistoricalEpoch(index, epochKey, ['bad', 'good'])).toBe('read');
  index.locationsFor(epochKey);
  const opens = vi.spyOn(storage, 'openSqliteDatabaseSync');
  const reads = vi.spyOn(storage, 'readFileSync');
  try {
    for (let sweep = 0; sweep < 20; sweep++) refreshHistoricalEpochs(index);
    expect(opens).not.toHaveBeenCalled();
    expect(reads.mock.calls.filter(([path]) => String(path).includes('/job-locations.v1/jobs/'))).toHaveLength(0);
    rmSync(epoch.path);
    refreshHistoricalEpochs(index);
    expect(readHistoricalSource(index, epochKey, ['good'])).toEqual({ kind: 'unreadable' });
  } finally {
    vi.restoreAllMocks();
  }
});
