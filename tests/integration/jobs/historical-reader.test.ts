import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as epochObservation from '#src/store/epoch/observation.js';
import { attemptExclusiveFileLockSync } from '#src/infra/fs-lock.js';
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

import {
  readOrCreateEpochKey,
  encodeResolvedStoreEpoch,
  protectStoreEpoch,
  protectedStoreEpochRoot,
} from '../../../src/store/epoch/index.js';

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
import type { SqliteValue } from '#src/infra/port-types.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';

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
  writeFileSync(
    join(epochDir, '.coral-lineage.v1.json'),
    JSON.stringify({ version: 'v1', lineageId: '00000000-0000-4000-8000-000000000007' }),
  );
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

    expect(refreshHistoricalEpoch(index, epochKey, ['job-1'])).toMatchObject({ kind: 'read' });
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
    expect(result).toMatchObject({
      kind: 'unrecoverable-retained',
      reason: 'Source retired and retained copy unusable',
    });
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
        '00000000-0000-4000-8000-000000000007:7',
        fingerprint,
        join(root, 'results'),
        storage,
      );
      expect(result.kind).toBe('uncertified');
      expect(index.read('finished')?.disposition).toBe('terminal');
      expect(index.read('running')?.disposition).toBe('unresolved');
      expect(readFileSync(join(root, 'results', 'finished', 'result.md'), 'utf8')).toBe('finished result\n');
      expect(index.certificate('00000000-0000-4000-8000-000000000007:7')).toBeNull();
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
    const epochKey = '00000000-0000-4000-8000-000000000007:7';
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
    expect(refreshHistoricalEpoch(index, epochKey, ['finished'])).toMatchObject({ kind: 'read' });
    expect(index.resultsReleased(epochKey)).toBe(true);
    writeFileSync(path, JSON.stringify({ ...location, detail: { futureFormat: true } }));

    expect(index.resultsReleased(epochKey)).toBe(false);
    expect(refreshHistoricalEpoch(index, epochKey, ['finished'])).toMatchObject({ kind: 'read' });
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
      undefined,
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
    );
    expect(addressing.detail('finished')).toMatchObject({ status: { phase: 'completed' } });
    const stream = addressing.waitStream({ jobIds: ['finished'], supportsWaitV3: true });
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
      '00000000-0000-4000-8000-000000000007:7',
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
    expect(index.unknownLocationHold('00000000-0000-4000-8000-000000000007:7')).toBe(
      'Source retired and retained copy unusable',
    );
    expect(index.certificate('00000000-0000-4000-8000-000000000007:7')).toBeNull();
  });

  it('settles a malformed protected address without inventing an outcome and recovers after address repair', () => {
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
      undefined,
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
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
        '00000000-0000-4000-8000-000000000007:7',
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
    index.register('known-live', '00000000-0000-4000-8000-000000000007:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    expect(
      seedHistoricalEpoch(
        runtime,
        index,
        { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
        '00000000-0000-4000-8000-000000000007:7',
        fingerprints[0],
        join(root, 'results'),
        storage,
      ).kind,
    ).toBe('unrecoverable-retained');
    expect(refreshHistoricalEpoch(index, '00000000-0000-4000-8000-000000000007:7', ['known-live'])).toMatchObject({
      kind: 'unreadable',
    });
    expect(index.unknownLocationHold('00000000-0000-4000-8000-000000000007:7')).not.toBeNull();
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
      '00000000-0000-4000-8000-000000000007:7',
      fingerprints[0],
      join(root, 'results'),
      storage,
    );
    expect(result).toMatchObject({ kind: 'uncertified' });
    expect(index.read('accepted-without-projection')?.disposition).toBe('unresolved');
    expect(index.certificate('00000000-0000-4000-8000-000000000007:7')).toBeNull();
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
      seedHistoricalEpoch(
        runtime,
        index,
        epoch,
        '00000000-0000-4000-8000-000000000007:7',
        fingerprints[0],
        join(root, 'results'),
        storage,
      ),
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
      undefined,
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
    );

    expect(addressing.detail('projection-lost')).toMatchObject({
      kind: 'outcome-unreadable',
      jobId: 'projection-lost',
      epochKey: '00000000-0000-4000-8000-000000000007:7',
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
        '00000000-0000-4000-8000-000000000007:7',
        fingerprints[0],
        join(root, 'results'),
        storage,
        [],
        true,
      ).kind,
    ).toBe('complete');
    expect(index.resultsReleased('00000000-0000-4000-8000-000000000007:7')).toBe(true);
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
      undefined,
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
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
    it('refuses an unrepresentable legacy terminal while hydration is pending', async () => {
      const f = await setup();
      try {
        await f.finish();
        const stream = f.addressing.waitStream({
          jobIds: ['old-live'],
          supportsWaitV2: true,
          timeoutSeconds: 2,
        } as never);
        await expect(stream.next()).rejects.toMatchObject({ code: 'wait_epoch_unsupported' });
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
    it('settles deterministic decode failures and answers unknown ids as discovery-unreadable', () => {
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
          undefined,
          () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
        );
        const snap = addressing.snapshot({ jobIds: ['typo-id'] } as never);
        expect(index.unknownLocationHolds()[0]).toMatchObject({ retryScheduled: false });
        expect(index.unknownLocationHolds()[0].reason).not.toContain('\"code\"');
        expect(snap.jobs[0]).toMatchObject({
          disposition: 'discovery-unreadable',
          message: expect.stringContaining('this coordinator will not re-read it before its next start'),
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
          undefined,
          () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
        );
        const admissions = addressing.admitWait({ jobIds: ['typo-not-a-job'], supportsWaitV3: true });
        const session = new WaitSession(['typo-not-a-job']);
        session.reconcile(admissions);
        expect(admissions[0].disposition).toBe('discovery-unreadable');
        expect(session.remaining()).toEqual([]);
        expect(index.unknownLocationHolds()[0].retryScheduled).toBe(false);
        expect(admissions[0].message).toContain('this coordinator will not re-read it before its next start');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
  it('bounds transient seed failures to three attempts before discovery-unreadable', () => {
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
        reason: expect.stringContaining('after 3 maintenance attempts'),
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
        undefined,
        () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
      );
      expect(addressing.snapshot({ jobIds: ['typo'] }).jobs[0].disposition).toBe('discovery-unreadable');
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
      for (let attempt = 0; attempt < 2; attempt++) retryUnknownHistoricalEpochs(index);
      expect(index.unknownLocationHolds()[0]).toMatchObject({ retryScheduled: false });
      expect(index.unknownLocationHolds()[0].reason).not.toContain('retained-store-root-missing');
      expect(readHistoricalSource(index, epochKey, ['typo'])).toMatchObject({
        kind: 'unreadable',
        disposition: 'settled-unreadable',
      });
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
    undefined,
    () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
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
  expect(refreshHistoricalEpoch(index, epochKey, ['bad', 'good'])).toMatchObject({ kind: 'unreadable' });
  expect(index.read('good')?.disposition).toBe('terminal');
  expect(index.certificate(epochKey)).toBeNull();
  failure.mockRestore();
  expect(refreshHistoricalEpoch(index, epochKey, ['bad', 'good'])).toMatchObject({ kind: 'read' });
  index.locationsFor(epochKey);
  const opens = vi.spyOn(storage, 'openSqliteDatabaseSync');
  const reads = vi.spyOn(storage, 'readFileSync');
  try {
    for (let sweep = 0; sweep < 20; sweep++) refreshHistoricalEpochs(index);
    expect(opens).not.toHaveBeenCalled();
    expect(reads.mock.calls.filter(([path]) => String(path).includes('/job-locations.v1/jobs/'))).toHaveLength(0);
    rmSync(epoch.path);
    refreshHistoricalEpochs(index);
    expect(readHistoricalSource(index, epochKey, ['good'])).toMatchObject({
      kind: 'unreadable',
      disposition: 'retired',
      retired: true,
    });
  } finally {
    vi.restoreAllMocks();
  }
});

// Round 3 retired-source and per-job decode probes, exercised through the real reader.
import { createTerminalExportFixture, TERMINAL_EXPORT_CUTOFF } from '#tests/helpers/terminal-export.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { historicalSourceReader } from '#src/jobs/historical-reader.js';

describe('historical read dispositions', () => {
  it('settles retired progress before sweep, after sweep, and after restart', async () => {
    const f = createTerminalExportFixture('provider', true);
    try {
      f.complete();
      seedHistoricalEpoch(
        f.runtime,
        f.index,
        f.epoch,
        f.epochKey,
        currentCoralStoreFormat().fingerprint,
        f.runtime.paths.coral.exports.jobsRoot,
        f.runtime.storage,
      );
      f.removeSource();
      for (const phase of ['before sweep', 'after sweep', 'restart']) {
        if (phase === 'after sweep') refreshHistoricalEpochs(f.index);
        const index = phase === 'restart' ? new JobLocationIndex(f.runtime, f.root) : f.index;
        const addressing = new JobAddressing(
          index.readOnlyView(),
          {
            epochKey: () => 'other',
            detail: () => null,
            abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
          },
          () => false,
          () => 'decided',
          historicalSourceReader(index),
          (id) => f.store.getResultExportOwner().observeResultAvailability(id),
        );
        const [admission] = addressing.admitWait({ jobIds: [f.jobId], supportsWaitV3: true });
        expect(admission.progressUnknown, phase).not.toBe(true);
        expect(admission.progressLost, phase).toBe(true);
        const first = addressing.snapshot({ jobIds: [f.jobId] });
        expect(first.jobs[0].terminal, phase).toBeDefined();
        expect(first.notices.join(' '), phase).toContain('no longer kept');
        expect(first.remainingJobIds, phase).toEqual([]);
        expect(first.exitCode, phase).toBe(0);
        const events = [];
        for await (const event of addressing.waitStream({
          jobIds: [f.jobId],
          supportsWaitV3: true,
          cursor: first.cursor,
          timeoutSeconds: 1,
        }))
          events.push(event);
        expect(events.at(-1), phase).toMatchObject({ exitCode: 0 });
        expect(
          events.some((event) => event.type === 'waiting'),
          phase,
        ).toBe(false);
      }
    } finally {
      f.close();
    }
  });

  it.each(['projection', 'terminal'] as const)(
    'settles a per-job %s decode failure as outcome-unreadable after decided closure',
    (failure) => {
      const f = createTerminalExportFixture('provider', true);
      try {
        seedHistoricalEpoch(
          f.runtime,
          f.index,
          f.epoch,
          f.epochKey,
          currentCoralStoreFormat().fingerprint,
          f.runtime.paths.coral.exports.jobsRoot,
          f.runtime.storage,
        );
        const seq = commitJobTerminal(f.store, f.jobId, 'session-1', {
          content: 'real outcome',
          outcome: { kind: 'completed' },
          durationMs: 1,
        });
        if (failure === 'projection') f.db.prepare('DELETE FROM projection_jobs WHERE job_id = ?').run(f.jobId);
        else {
          const raw = f.db.prepare('SELECT body FROM events WHERE seq = ?').get(seq) as { body: Uint8Array };
          const body = JSON.parse(Buffer.from(raw.body).toString('utf8'));
          body.terminal.outcome = { kind: 'future_kind' };
          f.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(Buffer.from(JSON.stringify(body)), seq);
        }
        const addressing = new JobAddressing(
          f.index.readOnlyView(),
          {
            epochKey: () => 'other',
            detail: () => null,
            abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
          },
          () => false,
          () => 'decided',
          historicalSourceReader(f.index),
          (id) => f.store.getResultExportOwner().observeResultAvailability(id),
        );
        expect(addressing.admitWait({ jobIds: [f.jobId], supportsWaitV3: true })[0].disposition).toBe(
          'outcome-unreadable',
        );
        expect(addressing.detail(f.jobId)).toMatchObject({ kind: 'outcome-unreadable' });
        expect(addressing.outcomeUnrecoverable([f.jobId])).toEqual([]);
        expect(addressing.snapshot({ jobIds: [f.jobId] })).toMatchObject({ remainingJobIds: [], exitCode: 1 });
      } finally {
        f.close();
      }
    },
  );
});

it('gates unchanged historical polls and unresolved sweeps on the journal frontier', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    for (let i = 0; i < 100; i++) f.store.appendProgress(f.jobId, 'session-1', `line ${i}`);
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    const reader = historicalSourceReader(f.index);
    const session = {};
    reader(f.epochKey, [f.jobId], session);
    refreshHistoricalEpochs(f.index);
    const originalOpen = f.runtime.storage.openSqliteDatabaseSync.bind(f.runtime.storage);
    const sql: string[] = [];
    vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync').mockImplementation((...args) => {
      const db = originalOpen(...args);
      const prepare = db.prepare.bind(db);
      db.prepare = (query) => {
        sql.push(query);
        return prepare(query);
      };
      return db;
    });
    const scan = vi.spyOn(f.index, 'locations');
    const certify = vi.spyOn(f.index, 'certify');
    for (let poll = 0; poll < 20; poll++) {
      reader(f.epochKey, [f.jobId], session);
      refreshHistoricalEpochs(f.index);
    }
    expect(sql.filter((query) => /projection_jobs|SELECT seq, ts, type, body/.test(query))).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
    expect(certify).not.toHaveBeenCalled();
    sql.length = 0;
    f.store.appendProgress(f.jobId, 'session-1', 'new line');
    const changed = reader(f.epochKey, [f.jobId], session);
    expect(changed.kind === 'read' && changed.locations.get(f.jobId)?.detail.kind).toBe('recorded');
    expect(sql.filter((query) => /SELECT seq, ts, type, body/.test(query))).toHaveLength(1);
    expect(sql.find((query) => /SELECT seq, ts, type, body/.test(query))).toContain('seq >');
    refreshHistoricalEpochs(f.index);
    expect(certify).toHaveBeenCalledTimes(1);
    expect(sql.some((query) => /SELECT \* FROM projection_jobs ORDER BY/.test(query))).toBe(false);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it.each([
  'unregistered present',
  'unregistered absent',
  'registered absent',
  'unsupported',
  'read failure',
  'identity mismatch',
  'identity unobservable',
  'guard unobservable',
  'explicit job absence',
])('classifies historical source observation: %s', (scenario) => {
  const f = createTerminalExportFixture('provider', true);
  try {
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      scenario === 'unsupported' ? 'future-format' : currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    const index = scenario.startsWith('unregistered') ? new JobLocationIndex(f.runtime, f.root) : f.index;
    if (scenario.endsWith(' absent')) rmSync(f.epoch.path);
    if (scenario === 'guard unobservable') rmSync(join(dirname(f.epoch.path), '.lock'));
    const identity = scenario.startsWith('identity')
      ? vi
          .spyOn(epochObservation, 'inspectResolvedStoreEpochKey')
          .mockReturnValue(scenario === 'identity mismatch' ? 'other epoch' : null)
      : undefined;
    const open =
      scenario === 'read failure'
        ? vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync').mockImplementation(() => {
            throw new Error('temporary I/O failure');
          })
        : undefined;
    try {
      const result = readHistoricalSource(index, f.epochKey, ['typo']);
      if (scenario.endsWith(' absent'))
        expect(result).toMatchObject({ kind: 'unreadable', disposition: 'retired', retired: true });
      else if (
        [
          'unsupported',
          'identity mismatch',
          'unregistered present',
          'read failure',
          'identity unobservable',
          'guard unobservable',
        ].includes(scenario)
      ) {
        expect(result.kind).toBe('unreadable');
        if (result.kind === 'unreadable') {
          expect(result.retired).not.toBe(true);
          expect(result.disposition).toBe(scenario === 'unsupported' ? 'settled-unreadable' : 'transient-unknown');
        }
      } else {
        expect(result.kind).toBe('read');
        if (result.kind === 'read') {
          expect(result.locations.has('typo')).toBe(true);
          expect(result.locations.get('typo')).toBeNull();
          expect(result.unreadableJobs?.has('typo')).toBe(false);
        }
      }
    } finally {
      open?.mockRestore();
      identity?.mockRestore();
    }
  } finally {
    f.close();
  }
});

it('holds the identity guard only during each historical read and releases it on failed reads', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    const path = join(dirname(f.epoch.path), '.lock');
    const open = f.runtime.storage.openSqliteDatabaseSync.bind(f.runtime.storage);
    const spy = vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync').mockImplementation((...args) => {
      const attempt = attemptExclusiveFileLockSync(path);
      if (attempt.kind === 'acquired') attempt.lease();
      expect(attempt.kind).toBe('contended');
      return open(...args);
    });
    const session = {};
    for (let poll = 0; poll < 20; poll++) {
      expect(readHistoricalSource(f.index, f.epochKey, [f.jobId], session).kind).toBe('read');
      const attempt = attemptExclusiveFileLockSync(path);
      expect(attempt.kind).toBe('acquired');
      if (attempt.kind === 'acquired') attempt.lease();
    }
    spy.mockImplementation(() => {
      throw new Error('temporary open failure');
    });
    expect(readHistoricalSource(f.index, f.epochKey, [f.jobId], {})).toMatchObject({
      kind: 'unreadable',
      disposition: 'transient-unknown',
    });
    spy.mockRestore();
    const attempt = attemptExclusiveFileLockSync(path);
    expect(attempt.kind).toBe('acquired');
    if (attempt.kind === 'acquired') attempt.lease();
  } finally {
    f.close();
  }
});

it('skips settled retired epochs without rewriting their recovery hold on later sweeps', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    rmSync(f.epoch.path);
    refreshHistoricalEpochs(f.index);
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync');
    for (let sweep = 0; sweep < 20; sweep++) refreshHistoricalEpochs(f.index);
    expect(write).not.toHaveBeenCalled();
    expect(f.index.unknownLocationHolds()).toContainEqual(expect.objectContaining({ retryScheduled: false }));
    expect(readHistoricalSource(f.index, f.epochKey, [f.jobId])).toMatchObject({
      kind: 'unreadable',
      disposition: 'retired',
      retired: true,
    });
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('hydrates advancing non-terminal sweeps from their stored frontier without copying history', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    for (let i = 0; i < 1000; i++) f.store.appendProgress(f.jobId, 'session-1', `body ${i}`);
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    const opened = f.runtime.storage.openSqliteDatabaseSync.bind(f.runtime.storage);
    const rowsRead: number[] = [];
    vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync').mockImplementation((...args) => {
      const db = opened(...args);
      const prepare = db.prepare.bind(db);
      db.prepare = (query) => {
        const statement = prepare(query);
        if (query.includes('SELECT seq, ts, type, body')) {
          const all = statement.all.bind(statement);
          statement.all = (...params) => {
            const rows = all(...params);
            rowsRead.push(rows.length);
            return rows;
          };
        }
        return statement;
      };
      return db;
    });
    const writes = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync');
    for (let sweep = 0; sweep < 3; sweep++) {
      f.store.appendProgress(f.jobId, 'session-1', `appended ${sweep}`);
      refreshHistoricalEpochs(f.index);
    }
    expect(rowsRead).toEqual([1, 1, 1]);
    expect(writes.mock.calls.filter(([path]) => path.includes('/jobs/'))).toHaveLength(3);
    expect(writes.mock.calls.filter(([path]) => path.endsWith('revision.v1.json'))).toHaveLength(0);
    expect(f.index.read(f.jobId)?.detail).toMatchObject({
      kind: 'recorded',
      value: {
        events: expect.arrayContaining([
          expect.objectContaining({ message: 'body 0' }),
          expect.objectContaining({ message: 'appended 2' }),
        ]),
      },
    });
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('does not retain history across historical reads without a session and leaves cached arrays unchanged on parse failure', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.store.appendProgress(f.jobId, 'session-1', 'first');
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    const open = vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync');
    for (let read = 0; read < 3; read++) expect(readHistoricalSource(f.index, f.epochKey, [f.jobId]).kind).toBe('read');
    expect(open).toHaveBeenCalledTimes(3);
    const session = {};
    const first = readHistoricalSource(f.index, f.epochKey, [f.jobId], session);
    for (let poll = 0; poll < 40; poll++) readHistoricalSource(f.index, f.epochKey, [f.jobId], session);
    expect(open).toHaveBeenCalledTimes(4);
    if (first.kind !== 'read') throw new Error('read failed');
    const firstLocation = first.locations.get(f.jobId)!;
    if (firstLocation.detail.kind !== 'recorded') throw new Error('detail missing');
    const originalEvents = [...firstLocation.detail.value.events];
    f.store.appendProgress(f.jobId, 'session-1', 'second');
    const malformed = f.store.appendProgress(f.jobId, 'session-1', 'third');
    const row = f.db.prepare('SELECT body FROM events WHERE seq = ?').get(malformed) as { body: Uint8Array };
    f.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(Buffer.from('{broken'), malformed);
    const failed = readHistoricalSource(f.index, f.epochKey, [f.jobId], session);
    expect(failed.kind === 'read' && failed.dispositions.get(f.jobId)).toBe('settled-unreadable');
    expect(firstLocation.detail.value.events).toEqual(originalEvents);
    f.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(row.body, malformed);
    const repaired = readHistoricalSource(f.index, f.epochKey, [f.jobId], session);
    if (repaired.kind !== 'read') throw new Error('read failed');
    const location = repaired.locations.get(f.jobId)!;
    expect(
      location.detail.kind === 'recorded' &&
        location.detail.value.events.filter((event) => event.type === 'progress').map((event) => event.message),
    ).toEqual(['first', 'second', 'third']);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it.each([false, true])(
  'settles a retryable discovery hold after its epoch is externally removed, restarted: %s',
  (restarted) => {
    const f = createTerminalExportFixture('provider', true);
    try {
      seedHistoricalEpoch(
        f.runtime,
        f.index,
        f.epoch,
        f.epochKey,
        currentCoralStoreFormat().fingerprint,
        f.runtime.paths.coral.exports.jobsRoot,
        f.runtime.storage,
      );
      f.index.holdUnknownLocations(f.epochKey, 'temporary source failure', true);
      f.removeSource();
      const index = restarted ? new JobLocationIndex(f.runtime, f.root) : f.index;
      retryUnknownHistoricalEpochs(index);
      expect(index.unknownLocationHolds()[0]).toMatchObject({ retryScheduled: restarted });
      expect(readHistoricalSource(index, f.epochKey, [f.jobId])).toMatchObject({ disposition: 'retired' });
    } finally {
      f.close();
    }
  },
);

it('delivers a historical sibling backlog and settles deterministic per-job decode failure', async () => {
  const realRuntime = createRealRuntime('prod', { baseDir: tmpdir() });
  const runtime = { ...realRuntime, time: { ...realRuntime.time, now: () => Date.parse('2026-09-25T00:00:20.000Z') } };
  const root = mkdtempSync(join(tmpdir(), 'nreview4-blocked-'));
  try {
    const epochDir = join(root, 'db', 'epoch-7');
    mkdirSync(epochDir, { recursive: true });
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
    for (const id of ['bad', 'good']) {
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
    }
    const timing = {
      origin: 'runtime',
      originAt: '2026-09-25T00:00:00.000Z',
      emittedAt: '2026-09-25T00:00:00.000Z',
      elapsedMs: 0,
    };
    ev('job.progress.emitted', 'good', { kind: 'message', message: 'good-line-1', timing });
    ev('job.progress.emitted', 'good', { kind: 'message', message: 'good-line-2', timing });
    const tseq = seq;
    ev('job.terminal.recorded', 'good', {
      terminal: { content: 'good result', outcome: { kind: 'completed' }, durationMs: 1 },
    });
    db.prepare("UPDATE projection_jobs SET phase = 'completed', last_seq = ? WHERE job_id = 'good'").run(tseq);
    db.prepare("UPDATE projection_jobs SET execution_owner = 'invalid json' WHERE job_id = 'bad'").run();
    db.close();
    const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
    const epochKey = readOrCreateEpochKey(runtime, epoch);
    const index = new JobLocationIndex(runtime, root);
    seedHistoricalEpoch(runtime, index, epoch, epochKey, fingerprints[0], join(root, 'results'), runtime.storage);
    const addressing = new JobAddressing(
      index.readOnlyView(),
      {
        epochKey: () => 'another-epoch',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'available', resultPath: '/x' }),
    );
    const admissions = addressing.admitWait({ jobIds: ['good', 'bad'], supportsWaitV3: true });
    const events: WaitStreamEvent[] = [];
    for await (const e of addressing.waitStream({ jobIds: ['good', 'bad'], supportsWaitV3: true, timeoutSeconds: 1 }))
      events.push(e);
    const goodProgress = events.filter((e) => e.type === 'progress' && e.jobId === 'good').length;
    const terminal = events.find((e) => e.type === 'terminal');
    expect(goodProgress).toBe(2);
    expect(terminal?.type === 'terminal' && terminal.remainingJobIds).toEqual([]);
    expect(admissions.find((job) => job.jobId === 'bad')).toMatchObject({
      disposition: 'outcome-unreadable',
      sourceRead: 'settled-unreadable',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('the JobStore export owner prepares an older fingerprint through the shared historical decoder', () => {
  const { root, epochDir, db } = fixture(fingerprints[0]);
  db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'old-terminal',
    JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
    'completed',
    JSON.stringify({ progressFaults: [] }),
    'session-1',
    'claude',
    root,
    'fixture',
    null,
    'provider',
    null,
    null,
    null,
    null,
    '2026-09-25T00:00:00.000Z',
    2,
  );
  db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
    1,
    '2026-09-25T00:00:00.000Z',
    'job.launch.requested',
    'job',
    'old-terminal',
    Buffer.from(JSON.stringify({ projectRoot: root, jobKind: 'provider', request: { cwd: root } })),
  );
  db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
    2,
    '2026-09-25T00:00:10.000Z',
    'job.terminal.recorded',
    'job',
    'old-terminal',
    Buffer.from(
      JSON.stringify({ terminal: { content: 'legacy result', outcome: { kind: 'completed' }, durationMs: 10 } }),
    ),
  );
  db.close();
  const active = createTerminalExportFixture('provider', true);
  try {
    const index = new JobLocationIndex(active.runtime, root);
    const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
    const epochKey = encodeResolvedStoreEpoch(active.runtime, epoch);
    index.register('old-terminal', epochKey, { projectRoot: root, workDir: root, jobKind: 'provider' });
    active.store.configureResultExports(index);
    active.store.getResultExportOwner().ensureResultMarkdownArtifact('old-terminal');
    expect(index.read('old-terminal')?.detail.kind).toBe('recorded');
    expect(readFileSync(index.resultPathFor('old-terminal'), 'utf8')).toBe('legacy result\n');
  } finally {
    active.close();
  }
});

it.each(['pending', 'decided'] as const)(
  'bounds newly unopenable historical sources to three sweeps (%s closure)',
  (closure) => {
    const f = createTerminalExportFixture('provider', true);
    try {
      seedHistoricalEpoch(
        f.runtime,
        f.index,
        f.epoch,
        f.epochKey,
        currentCoralStoreFormat().fingerprint,
        f.runtime.paths.coral.exports.jobsRoot,
        f.runtime.storage,
      );
      const addressing = new JobAddressing(
        f.index,
        {
          epochKey: () => 'active',
          detail: () => null,
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        },
        () => false,
        () => closure,
        undefined,
        () => ({ kind: 'repair-pending', ageUncertain: true }),
      );
      const open = vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync').mockImplementation(() => {
        throw Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' });
      });
      for (let i = 0; i < 2; i++) {
        refreshHistoricalEpochs(f.index);
        expect(f.index.unknownLocationHolds()[0].retryScheduled).toBe(true);
        expect(addressing.admitWait({ jobIds: [f.jobId], supportsWaitV3: true })[0].disposition).toBe('admitted');
      }
      refreshHistoricalEpochs(f.index);
      expect(f.index.unknownLocationHolds()[0].retryScheduled).toBe(false);
      expect(addressing.admitWait({ jobIds: [f.jobId], supportsWaitV3: true })[0].disposition).toBe(
        'outcome-unreadable',
      );
      expect(addressing.detail(f.jobId)).toMatchObject({ kind: 'outcome-unreadable' });
      expect(addressing.snapshot({ jobIds: [f.jobId] })).toMatchObject({ exitCode: 1, remainingJobIds: [] });
      open.mockRestore();
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  },
);

it('seeds one journal snapshot and catches a launch committed between inventory and frontier reads', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.db.exec('PRAGMA journal_mode=WAL');
    const other = new JobStore('fixture', f.runtime, createEventBodyCodec(), {
      db: f.db,
      providers: permissiveProviderLookupPort,
    });
    const open = f.runtime.storage.openSqliteDatabaseSync;
    let committed = false;
    const concurrent = {
      ...f.runtime.storage,
      openSqliteDatabaseSync: (...args: Parameters<typeof open>) => {
        const db = open(...args);
        return new Proxy(db, {
          get(target, key) {
            if (key !== 'prepare') {
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.includes('SELECT * FROM projection_jobs')) return statement;
              return new Proxy(statement, {
                get(stmt, property) {
                  const value = Reflect.get(stmt, property);
                  if (property !== 'all') return typeof value === 'function' ? value.bind(stmt) : value;
                  return (...bindings: SqliteValue[]) => {
                    const rows = stmt.all(...bindings);
                    if (!committed) {
                      committed = true;
                      initTestJob(other, {
                        jobId: 'late-launch',
                        sessionId: 'late-session',
                        provider: 'claude',
                        projectRoot: f.root,
                        backendNamespace: 'fixture',
                      });
                    }
                    return rows;
                  };
                },
              });
            };
          },
        });
      },
    };
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      concurrent,
    );
    expect(committed).toBe(true);
    expect(f.index.read('late-launch')).toBeNull();
    refreshHistoricalEpochs(f.index);
    expect(f.index.read('late-launch')).toMatchObject({ epochKey: f.epochKey, disposition: 'unresolved' });
  } finally {
    f.close();
  }
});

it('past-boundary retirement sweeps use captured ages without opening a source per job', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1 });
    expect(
      f.index.certify(
        f.epochKey,
        (f.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq,
      ),
    ).not.toBeNull();
    const opened = vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync');
    for (let poll = 0; poll < 20; poll++) expect(f.index.resultsReleased(f.epochKey)).toBe(true);
    expect(opened).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

import { JobStore } from '#src/jobs/store.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { initTestJob } from '#tests/helpers/session.js';

it('historical maintenance never rewrites an unregistered active-epoch hold', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.index.holdUnknownLocations(f.epochKey, 'active recovery remains scheduled', true);
    const before = f.index.unknownLocationHolds();
    for (let pass = 0; pass < 50; pass++) retryUnknownHistoricalEpochs(f.index);
    expect(f.index.unknownLocationHolds()).toEqual(before);
    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        epochKey: () => f.epochKey,
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'repair-pending', ageUncertain: false }),
    );
    expect(addressing.unknownJobDisposition()).toBe('not-found');
  } finally {
    f.close();
  }
});
