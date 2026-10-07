import { nextFinal } from '#tests/helpers/wait-stream.js';
import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { symlinkSync, unlinkSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createLifecycleRecoveryDependencies } from '#src/coordinator/composition/lifecycle-recovery-dependencies.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as epochObservation from '#src/store/epoch/observation.js';
import { attemptExclusiveFileLockSync } from '#src/infra/fs-lock.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newRawDatabase } from '../../helpers/test-db.js';
import { JobLocationIndex } from '../../../src/jobs/location-index.js';
import { JobAddressing } from '../../../src/jobs/addressing.js';
import {
  registerPresentHistoricalEpochs,
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
import { DatabaseSync } from 'node:sqlite';
import { readHistoricalSource } from '#src/jobs/historical-reader.js';

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

  it('defers a contended epoch to the next sweep at once, without counting a failed refresh', async () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    db.close();
    const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
    const epochKey = readOrCreateEpochKey(runtime, epoch);
    const index = new JobLocationIndex(runtime, root);
    expect(
      seedHistoricalEpoch(runtime, index, epoch, epochKey, fingerprints[0], join(root, 'results'), storage).kind,
    ).toBe('uncertified');
    const attempt = attemptExclusiveFileLockSync(join(epochDir, '.lock'));
    if (attempt.kind !== 'acquired') throw new Error(`Expected to hold the epoch guard, got ${attempt.kind}`);
    try {
      const started = performance.now();
      expect(refreshHistoricalEpoch(index, epochKey, ['job-1'])).toEqual({ kind: 'contended' });
      expect(performance.now() - started).toBeLessThan(1_000);
      const holds = index.unknownLocationHolds();
      for (let sweep = 0; sweep < 3; sweep++) await refreshHistoricalEpochs(index);
      expect(index.unknownLocationHolds()).toEqual(holds);
    } finally {
      attempt.lease();
    }
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
      reason: 'Source retired; no further source read is possible',
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
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      undefined,
      () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
    );
    expect(addressing.detail('finished')).toMatchObject({ status: { phase: 'completed' } });
    const stream = addressing.waitStream({ jobIds: ['finished'] });
    expect((await nextFinal(stream)).value).toMatchObject({ type: 'terminal', jobId: 'finished' });
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
    expect(index.unknownLocationHold('00000000-0000-4000-8000-000000000007:7')).toBeNull();
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
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      undefined,
      () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
    );
    expect(addressing.detail('known-live')).not.toMatchObject({ kind: 'outcome-unrecoverable' });
    expect(addressing.abort(['known-live'])).toMatchObject({
      kind: 'answered',
      result: { held: [{ jobId: 'known-live', reason: 'historical_owner_unresolved' }] },
    });
    writeFileSync(addressPath, protectedAddress);
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

  it('settles a launch-only job outcome-unreadable when its journal contains a terminal outside the projection inventory', () => {
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
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'lineage-new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      undefined,
      () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
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
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'lineage-new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
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
  const epochKey = '00000000-0000-4000-8000-000000000007:7';
  it('bounds transient seed failures to three attempts before unreadable', () => {
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
          visitProgress: progressVisitFromDetails(() => null),
          epochKey: () => 'active',
          detail: () => null,
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        },
        () => false,
        () => 'pending',
        undefined,
        () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
      );
      expect(addressing.snapshot({ jobIds: ['typo'] }).jobs[0].disposition).toBe('unreadable');
    } finally {
      open.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

import { createTerminalExportFixture, TERMINAL_EXPORT_CUTOFF } from '#tests/helpers/terminal-export.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { historicalSourceReader } from '#src/jobs/historical-reader.js';

describe('historical read dispositions', () => {
  it('settles a per-job terminal decode failure as outcome-unreadable after decided closure', () => {
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
      const raw = f.db.prepare('SELECT body FROM events WHERE seq = ?').get(seq) as { body: Uint8Array };
      const body = JSON.parse(Buffer.from(raw.body).toString('utf8'));
      body.terminal.outcome = { kind: 'future_kind' };
      f.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(Buffer.from(JSON.stringify(body)), seq);
      const addressing = new JobAddressing(
        f.index.readOnlyView(),
        {
          visitProgress: progressVisitFromDetails(() => null),
          epochKey: () => 'other',
          detail: () => null,
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        },
        () => false,
        () => 'decided',
        historicalSourceReader(f.index),
        (id) => f.store.getResultExportOwner().observeResultAvailability(id),
      );
      expect(addressing.admitWait({ jobIds: [f.jobId] })[0].disposition).toBe('unreadable');
      expect(addressing.detail(f.jobId)).toMatchObject({ kind: 'outcome-unreadable' });
      expect(addressing.snapshot({ jobIds: [f.jobId] })).toMatchObject({ remainingJobIds: [], exitCode: 1 });
    } finally {
      f.close();
    }
  });
});

it.each([
  'unregistered present',
  'unregistered absent',
  'registered absent',
  'unsupported',
  'read failure',
  'identity mismatch',
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
    const identity =
      scenario === 'identity mismatch'
        ? vi.spyOn(epochObservation, 'inspectResolvedStoreEpochKey').mockReturnValue('other epoch')
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
      else if (['unsupported', 'identity mismatch', 'unregistered present', 'read failure'].includes(scenario)) {
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

it('delivers a historical sibling terminal without its progress and settles deterministic per-job decode failure', async () => {
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
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'another-epoch',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'available', resultPath: '/x' }),
    );
    const admissions = addressing.admitWait({ jobIds: ['good', 'bad'] });
    const events: WaitStreamEvent[] = [];
    for await (const e of addressing.waitStream({ jobIds: ['good', 'bad'], timeoutSeconds: 1 })) events.push(e);
    const goodProgress = events.filter((e) => e.type === 'progress' && e.jobId === 'good').length;
    const terminal = events.find((e) => e.type === 'terminal');
    expect(goodProgress).toBe(0);
    expect(terminal?.type === 'terminal' && terminal.remainingJobIds).toEqual([]);
    expect(admissions.find((job) => job.jobId === 'bad')).toMatchObject({ disposition: 'unreadable' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('bounds a newly unopenable historical source to three sweeps', () => {
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
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'active',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      undefined,
      () => ({ kind: 'pending' }),
    );
    const open = vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync').mockImplementation(() => {
      throw Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' });
    });
    for (let i = 0; i < 2; i++) {
      refreshHistoricalEpochs(f.index);
      expect(f.index.unknownLocationHolds()[0].retryScheduled).toBe(true);
      expect(addressing.admitWait({ jobIds: [f.jobId] })[0].disposition).toBe('unknown');
    }
    refreshHistoricalEpochs(f.index);
    expect(f.index.unknownLocationHolds()[0].retryScheduled).toBe(false);
    expect(addressing.admitWait({ jobIds: [f.jobId] })[0].disposition).toBe('unreadable');
    expect(addressing.detail(f.jobId)).toMatchObject({ kind: 'outcome-unreadable' });
    expect(addressing.snapshot({ jobIds: [f.jobId] })).toMatchObject({ exitCode: 1, remainingJobIds: [] });
    open.mockRestore();
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

import { initTestJob } from '#tests/helpers/session.js';
it('budgets seed writes, yields between epochs and resumes every hydration slice', async () => {
  const f = fixture(fingerprints[0]);
  for (let i = 0; i < 40; i++)
    f.db
      .prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        i + 1,
        '2026-09-25T00:00:00.000Z',
        'job.launch.requested',
        'job',
        `bulk-${i}`,
        Buffer.from(JSON.stringify({ projectRoot: f.root, jobKind: 'provider', request: { cwd: f.root } })),
      );
  f.db.close();
  const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
  const key = encodeResolvedStoreEpoch(runtime, epoch);
  const index = new JobLocationIndex(runtime, f.root);
  const register = vi.spyOn(index, 'register');
  const budget = { remaining: 16 };
  seedHistoricalEpoch(runtime, index, epoch, key, fingerprints[0], join(f.root, 'results'), storage, [], false, budget);
  expect(register).toHaveBeenCalledTimes(16);
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  await retryUnknownHistoricalEpochs(index, { remaining: 0 });
  expect(yielded).toBe(true);
  expect(register).toHaveBeenCalledTimes(32);
  await retryUnknownHistoricalEpochs(index, { remaining: 0 });
  expect(register).toHaveBeenCalledTimes(40);
  for (let i = 0; i < 3; i++) await retryUnknownHistoricalEpochs(index, { remaining: 0 });
  expect(index.unknownLocationHolds()).toEqual([]);
});

describe('released hold reconciliation uses its path', () => {
  it('reconciles a released hold without epochKey in its original directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'nreview7-legacy-'));
    const runtime = createRealRuntime('prod', { baseDir: base });
    const dbDir = runtime.paths.coral.store.dbDir;
    const epochDir = join(dbDir, 'epoch-1');
    mkdirSync(epochDir, { recursive: true });
    const lock = newRawDatabase(join(epochDir, '.lock'));
    lock.exec('CREATE TABLE IF NOT EXISTS m (id INTEGER)');
    lock.close();
    writeFileSync(join(epochDir, 'store.db'), '');
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    // a hold exactly as v0.10.16/17 write it: { version, reason } at epochs/sha256(epochKey)/
    const historicalKey = JSON.stringify({
      storeRoot: dbDir,
      epoch: '0',
      path: join(dbDir, 'epoch-0', 'store.db'),
      lineageKey: '00000000-0000-4000-8000-000000000000:0',
    });
    const legacyDir = join(
      runtime.paths.coral.generation.dataRoot,
      'job-locations.v1',
      'epochs',
      createHash('sha256').update(historicalKey).digest('hex'),
    );
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'unknown-locations.v1.json'),
      JSON.stringify({ version: 'v1', reason: 'Store fingerprint sha256:old cannot be read by this build' }) + '\n',
    );
    const deps = createLifecycleRecoveryDependencies({
      runtime,
      identity: { buildSetId: 'probe', instanceId: 'probe-instance', pluginRoot: join(base, 'none') } as never,
      jobLocationIndex: index,
      providerHostTransfer: {} as never,
      getProgressStore: () => ({}) as never,
      readSuccessionJobs: () => [],
      world: {} as never,
      onOpenedStore: () => {},
    });
    deps.onStoreOpened!({ storeRoot: dbDir, epoch: '1', path: join(epochDir, 'store.db') });
    const afterOpen = index.unknownLocationHolds();
    index.clearUnknownLocations(historicalKey); // the epoch's owner later reads it successfully
    const afterOwnerClear = index.unknownLocationHolds();
    const addressing = new JobAddressing(
      index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'active',
        detail: () => null,
        abort: () => ({}) as never,
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({}) as never,
    );
    expect(afterOpen).toHaveLength(1);
    expect(afterOwnerClear).toEqual([]);
    expect(addressing.admitWait({ jobIds: ['typo-id'] })[0].disposition).toBe('missing');
    rmSync(base, { recursive: true, force: true });
  });
});

describe('historical maintenance budgets and retirement', () => {
  const FP0 = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'coral-historical-budget-'));
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
    created_at TEXT, last_seq INTEGER);`);
    db.exec(`CREATE TABLE events (seq INTEGER, ts TEXT, type TEXT, stream_kind TEXT, stream_id TEXT, body BLOB);`);
    db.exec('CREATE INDEX ev ON events(stream_kind, stream_id, seq)');
    let seq = 0;
    const addJob = (jobId: string, opts: { terminal?: boolean; progress?: number; contentBytes?: number } = {}) => {
      const launchSeq = ++seq;
      db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
        launchSeq,
        '2026-09-25T00:00:00.000Z',
        'job.launch.requested',
        'job',
        jobId,
        Buffer.from(
          JSON.stringify({ projectRoot: root, jobKind: 'provider', request: { cwd: root, prompt: 'x'.repeat(2000) } }),
        ),
      );
      for (let i = 0; i < (opts.progress ?? 0); i++)
        db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
          ++seq,
          '2026-09-25T00:00:01.000Z',
          'job.progress.emitted',
          'job',
          jobId,
          Buffer.from(
            JSON.stringify({
              kind: 'message',
              message: `line ${i}`,
              timing: {
                origin: 'runtime',
                originAt: '2026-09-25T00:00:00.000Z',
                emittedAt: '2026-09-25T00:00:01.000Z',
                elapsedMs: i,
              },
            }),
          ),
        );
      let last = seq;
      if (opts.terminal !== false) {
        last = ++seq;
        db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
          last,
          '2026-09-25T00:00:10.000Z',
          'job.terminal.recorded',
          'job',
          jobId,
          Buffer.from(
            JSON.stringify({
              terminal: {
                content: 'r'.repeat(opts.contentBytes ?? 100),
                outcome: { kind: 'completed' },
                durationMs: 10000,
              },
            }),
          ),
        );
      }
      db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        jobId,
        JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
        opts.terminal === false ? 'running' : 'completed',
        JSON.stringify({ progressFaults: [] }),
        'session-1',
        'claude',
        root,
        'old-namespace',
        null,
        'provider',
        null,
        null,
        null,
        null,
        '2026-09-25T00:00:00.000Z',
        last,
      );
    };
    return { root, epochDir, db, addJob };
  }

  it('isolates unobservable epoch entries during registration', () => {
    const index = new JobLocationIndex(runtime, join(fixture().root, 'state'));
    const inaccessible = { storeRoot: '/inaccessible', epoch: '1', path: '/inaccessible/store.db' };
    const brokenRuntime = {
      ...runtime,
      storage: {
        ...storage,
        lstatSync: () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      },
    };
    expect(() =>
      registerPresentHistoricalEpochs(
        brokenRuntime,
        index,
        [
          { resolved: null, epoch: '99', epochKey: null, epochJson: { kind: 'absent' } },
          { resolved: inaccessible, epochKey: 'inaccessible', epochJson: { kind: 'absent' } },
        ] as never,
        'active',
        { remaining: 0 },
      ),
    ).not.toThrow();
  });

  it('retiring a certified terminal source keeps unknown IDs missing across restart', async () => {
    const f = fixture();
    f.addJob('done-1');
    f.db.close();
    const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
    const key = encodeResolvedStoreEpoch(runtime, epoch);
    const state = join(f.root, 'state');
    const index = new JobLocationIndex(runtime, state);
    expect(seedHistoricalEpoch(runtime, index, epoch, key, FP0, join(f.root, 'results'), storage, [], true).kind).toBe(
      'complete',
    );
    await refreshHistoricalEpochs(index);
    rmSync(f.epochDir, { recursive: true, force: true });
    await retryUnknownHistoricalEpochs(index, { remaining: 0 });
    await refreshHistoricalEpochs(index, { remaining: 0 });
    expect(index.unknownLocationHolds()).toEqual([]);
    const restarted = new JobLocationIndex(runtime, state);
    restarted.reconcileUnknownLocationHolds([]);
    const addressing = new JobAddressing(
      restarted.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'active-key',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      undefined,
      () => ({ kind: 'available', resultPath: '/x' }),
    );
    expect(addressing.admitWait({ jobIds: ['done-1', 'typo-id'] }).map((job) => job.disposition)).toEqual([
      'admitted',
      'missing',
    ]);
  });
});

it('a protection rename between address checks is transient and can be read on the next poll', () => {
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
    const lstat = f.runtime.storage.lstatSync.bind(f.runtime.storage);
    let renamed = false;
    const spy = vi.spyOn(f.runtime.storage, 'lstatSync').mockImplementation(((
      path: string,
      options?: { bigint: true },
    ) => {
      if (path === f.epoch.path && !renamed) {
        renamed = true;
        protectStoreEpoch(f.runtime, f.epoch);
        throw Object.assign(new Error('renamed'), { code: 'ENOENT' });
      }
      return options ? lstat(path, options) : lstat(path);
    }) as typeof f.runtime.storage.lstatSync);
    const racing = readHistoricalSource(f.index, f.epochKey, [f.jobId]);
    spy.mockRestore();
    expect(renamed).toBe(true);
    expect(racing).toMatchObject({ kind: 'unreadable', disposition: 'transient-unknown' });
    expect(readHistoricalSource(f.index, f.epochKey, [f.jobId]).kind).toBe('read');
    expect(f.index.unknownLocationHolds()).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it.each(['malformed guard', 'symlink guard', 'malformed metadata'])(
  'registers a previously unseen epoch with %s and gives it a maintenance exit',
  async (fault) => {
    const f = createTerminalExportFixture('provider', true);
    try {
      const guard = join(f.epochDir, '.lock');
      if (fault === 'malformed guard') writeFileSync(guard, 'malformed');
      if (fault === 'symlink guard') {
        const target = join(f.root, 'outside.lock');
        newRawDatabase(target).close();
        unlinkSync(guard);
        symlinkSync(target, guard);
      }
      const metadata = join(f.epochDir, 'epoch.json');
      if (fault === 'malformed metadata') writeFileSync(metadata, 'malformed');
      const index = new JobLocationIndex(f.runtime, join(f.root, 'unregistered'));
      // The inventory rejects these epochs, so registration must still discover their present source and lineage.
      const entry = {
        resolved: null,
        epoch: '1',
        epochKey: null,
        epochJson: fault.includes('metadata')
          ? { kind: 'malformed' as const }
          : {
              kind: 'valid' as const,
              value: { build: { storeFormatFingerprint: currentCoralStoreFormat().fingerprint } },
            },
      };
      const maintenanceRuntime = {
        ...f.runtime,
        paths: {
          ...f.runtime.paths,
          coral: { ...f.runtime.paths.coral, store: { ...f.runtime.paths.coral.store, dbDir: f.epoch.storeRoot } },
        },
      };
      registerPresentHistoricalEpochs(maintenanceRuntime, index, [entry as never], 'new-active', { remaining: 0 });
      for (let attempt = 0; attempt < 3; attempt++) await retryUnknownHistoricalEpochs(index);
      const read = readHistoricalSource(index, f.epochKey, [f.jobId]);
      if (fault === 'malformed guard') expect(read.kind).toBe('read');
      else expect(read).toMatchObject({ kind: 'unreadable', disposition: 'settled-unreadable' });
    } finally {
      f.close();
    }
  },
);

it('healthy source observations reset the consecutive failure allowance', async () => {
  const { root, epochDir, db } = fixture(fingerprints[0]);
  db.close();
  const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
  const key = encodeResolvedStoreEpoch(runtime, epoch);
  const index = new JobLocationIndex(runtime, join(root, 'state'));
  expect(
    seedHistoricalEpoch(runtime, index, epoch, key, fingerprints[0], join(root, 'results'), storage, [], true).kind,
  ).toBe('complete');
  for (let round = 0; round < 3; round++) {
    const observe = vi.spyOn(storage, 'lstatSync').mockImplementation(() => {
      throw new Error('temporary observation failure');
    });
    await retryUnknownHistoricalEpochs(index);
    observe.mockRestore();
    await retryUnknownHistoricalEpochs(index);
    await refreshHistoricalEpochs(index);
    expect(index.unknownLocationHolds().some((hold) => !hold.retryScheduled)).toBe(false);
  }
});

it('discharges an expired result from its proven closed reaping source', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1000, precedingAt: TERMINAL_EXPORT_CUTOFF - 2000 });
    f.index.certify(f.epochKey, f.index.read(f.jobId)!.terminalSeq!);
    rmSync(dirname(f.resultPath), { recursive: true, force: true });
    const reaping = join(f.epoch.storeRoot, '.reaping-closed-1');
    renameSync(dirname(f.epoch.path), reaping);
    const source = { ...f.epoch, path: join(reaping, 'store.db') };
    expect(f.index.certificate(f.epochKey)).not.toBeNull();
    expect(f.index.resultsReleased(f.epochKey, source)).toBe(true);
    writeFileSync(
      join(reaping, '.coral-lineage.v1.json'),
      JSON.stringify({ version: 'v1', lineageId: '00000000-0000-4000-8000-000000000099' }),
    );
    expect(f.index.resultsReleased(f.epochKey, source)).toBe(false);
  } finally {
    f.close();
  }
});

it('an undecodable launch row cannot stop hydration of the subjects after it in the same slice', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete();
    f.index.markUncertified(f.jobId);
    f.db
      .prepare(
        "INSERT INTO events(seq, ts, type, stream_kind, stream_id, body) VALUES (0, ?, 'job.launch.requested', 'job', 'job-0', ?)",
      )
      .run(new Date(TERMINAL_EXPORT_CUTOFF).toISOString(), Buffer.from('not json'));
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    expect(f.index.read(f.jobId)?.disposition).toBe('terminal');
    expect(f.index.unknownLocationHold(f.epochKey)).not.toBeNull();
  } finally {
    f.close();
  }
});

describe('per-job failures stay per-job (F4)', () => {
  const seedFixture = (f: ReturnType<typeof createTerminalExportFixture>, storagePort = f.runtime.storage) =>
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      storagePort,
    );
  const locationOf = (f: ReturnType<typeof createTerminalExportFixture>, jobId: string) =>
    join(f.root, 'job-locations.v1', 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`);

  it('seeds a healthy sibling readable past a malformed retained location and holds no epoch for it', () => {
    const f = createTerminalExportFixture('provider', true);
    try {
      initTestJob(f.store, {
        jobId: 'sibling',
        sessionId: 'sibling-session',
        provider: 'claude',
        projectRoot: f.root,
        backendNamespace: 'fixture',
      });
      rmSync(locationOf(f, 'sibling'));
      writeFileSync(f.locationPath, '{bad json');
      expect(seedFixture(f).kind).not.toBe('unrecoverable-retained');
      expect(f.index.read('sibling')).toMatchObject({ jobId: 'sibling' });
      expect(f.index.unknownLocationHolds()).toEqual([]);
      const read = readHistoricalSource(f.index, f.epochKey, ['sibling'], {});
      expect(read.kind === 'read' && read.dispositions.get('sibling')).toBe('readable');
    } finally {
      f.close();
    }
  });
});
