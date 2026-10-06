import { nextFinal } from '#tests/helpers/wait-stream.js';
import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { linkSync, symlinkSync, unlinkSync, renameSync } from 'node:fs';
import { observeProtectedEpoch } from '#src/store/epoch/protection.js';
import { createStoreEpochSweepScheduler } from '#src/coordinator/composition/store-epoch-sweep-scheduler.js';
import { settleStoreEpoch, retirementMintDisposition } from '#src/store/epoch/index.js';
import { createHash } from 'node:crypto';
import { createLifecycleRecoveryDependencies } from '#src/coordinator/composition/lifecycle-recovery-dependencies.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as epochObservation from '#src/store/epoch/observation.js';
import { sweepStoreEpochsPostReady } from '#src/store/epoch/post-ready-sweep.js';
import { attemptExclusiveFileLockSync } from '#src/infra/fs-lock.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newRawDatabase } from '../../helpers/test-db.js';
import { JobLocationIndex } from '../../../src/jobs/location-index.js';
import { WaitSession } from '#src/jobs/wait/session.js';
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
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
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
        visitProgress: progressVisitFromDetails(() => null),
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
        visitProgress: progressVisitFromDetails(() => null),
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
          visitProgress: progressVisitFromDetails(() => null),
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
      const stream = addressing.waitStream({ jobIds: ['old-live'], timeoutSeconds: 1 });
      expect((await nextFinal(stream)).value).toMatchObject({
        type: 'terminal',
        resultPath: join(root, 'results', 'old-live', 'result.md'),
        availability: { kind: 'available' },
        remainingJobIds: [],
        exitCode: 0,
      });
      await stream.return(undefined);
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
        visitProgress: progressVisitFromDetails(() => null),
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
          timeoutSeconds: 0,
        } as never);
        const ev = (await nextFinal(stream)).value as Record<string, unknown>;
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
            visitProgress: progressVisitFromDetails(() => null),
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
            visitProgress: progressVisitFromDetails(() => null),
            epochKey: () => 'active',
            detail: () => null,
            abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
          },
          () => false,
          () => 'pending',
          undefined,
          () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
        );
        const admissions = addressing.admitWait({ jobIds: ['typo-not-a-job'] });
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
          visitProgress: progressVisitFromDetails(() => null),
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

it('isolates invalid job reads, continues hydration after a recording failure and probes certified epochs without hydration', () => {
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
      visitProgress: progressVisitFromDetails(() => null),
      epochKey: () => 'another-epoch',
      detail: () => null,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'pending',
    undefined,
    () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
  );
  expect(addressing.admitWait({ jobIds: ['good'] })[0].detail?.exit).not.toBeNull();
  expect(addressing.admitWait({ jobIds: ['good'] })[0].progressUnknown).toBe(false);
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
    expect(opens).toHaveBeenCalledTimes(20);
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
            visitProgress: progressVisitFromDetails(() => null),
            epochKey: () => 'other',
            detail: () => null,
            abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
          },
          () => false,
          () => 'decided',
          historicalSourceReader(index),
          (id) => f.store.getResultExportOwner().observeResultAvailability(id),
        );
        const [admission] = addressing.admitWait({ jobIds: [f.jobId] });
        expect(admission.progressUnknown, phase).not.toBe(true);
        expect(admission.progressLost, phase).toBe(false);
        const first = addressing.snapshot({ jobIds: [f.jobId] });
        expect(first.jobs[0].terminal, phase).toBeDefined();
        expect(first.notices.join(' '), phase).toContain('source retired');
        expect(first.remainingJobIds, phase).toEqual([]);
        expect(first.exitCode, phase).toBe(0);
        const events = [];
        for await (const event of addressing.waitStream({
          jobIds: [f.jobId],
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
        expect(addressing.admitWait({ jobIds: [f.jobId] })[0].disposition).toBe('outcome-unreadable');
        expect(addressing.detail(f.jobId)).toMatchObject({ kind: 'outcome-unreadable' });
        expect(addressing.outcomeUnrecoverable([f.jobId])).toEqual([]);
        expect(addressing.snapshot({ jobIds: [f.jobId] })).toMatchObject({ remainingJobIds: [], exitCode: 1 });
      } finally {
        f.close();
      }
    },
  );
});

it('caches historical terminal bodies per request despite unrelated journal appends', () => {
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
    const reader = historicalSourceReader(f.index);
    const session = {};
    const first = reader(f.epochKey, [f.jobId], session);
    if (first.kind !== 'read') throw new Error('Initial historical read failed');
    const terminal = first.locations.get(f.jobId);
    expect(terminal?.disposition).toBe('terminal');
    for (let poll = 0; poll < 30; poll++) {
      f.db
        .prepare(
          "INSERT INTO events(ts, type, stream_kind, stream_id, refs, body) VALUES (?, 'test.unrelated', 'project', 'unrelated', '{}', ?)",
        )
        .run(new Date(f.runtime.time.now()).toISOString(), Buffer.from('{}'));
      const observed = reader(f.epochKey, [f.jobId], session);
      expect(observed.kind === 'read' && observed.locations.get(f.jobId)).toBe(terminal);
    }
    expect(sql.filter((query) => /SELECT \* FROM projection_jobs WHERE/.test(query))).toHaveLength(1);
    expect(sql.filter((query) => /SELECT seq, ts, type, body/.test(query))).toHaveLength(1);
    const fresh = reader(f.epochKey, [f.jobId], {});
    expect(fresh.kind === 'read' && fresh.locations.get(f.jobId)).not.toBe(terminal);
    expect(sql.filter((query) => /SELECT \* FROM projection_jobs WHERE/.test(query))).toHaveLength(2);
    expect(sql.filter((query) => /SELECT seq, ts, type, body/.test(query))).toHaveLength(2);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
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
    expect(sql.find((query) => /SELECT seq, ts, type, body/.test(query))).toContain('MAX(seq)');
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
    expect(f.index.unknownLocationHolds()).toEqual([]);
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
    const first = readHistoricalSource(f.index, f.epochKey, [f.jobId], session, true);
    for (let poll = 0; poll < 40; poll++) readHistoricalSource(f.index, f.epochKey, [f.jobId], session, true);
    expect(open).toHaveBeenCalledTimes(44);
    if (first.kind !== 'read') throw new Error('read failed');
    const firstLocation = first.locations.get(f.jobId)!;
    if (firstLocation.detail.kind !== 'recorded') throw new Error('detail missing');
    const originalEvents = [...firstLocation.detail.value.events];
    f.store.appendProgress(f.jobId, 'session-1', 'second');
    const malformed = f.store.appendProgress(f.jobId, 'session-1', 'third');
    const row = f.db.prepare('SELECT body FROM events WHERE seq = ?').get(malformed) as { body: Uint8Array };
    f.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(Buffer.from('{broken'), malformed);
    const failed = readHistoricalSource(f.index, f.epochKey, [f.jobId], session, true);
    expect(failed.kind === 'read' && failed.dispositions.get(f.jobId)).toBe('settled-unreadable');
    expect(firstLocation.detail.value.events).toEqual(originalEvents);
    f.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(row.body, malformed);
    const repaired = readHistoricalSource(f.index, f.epochKey, [f.jobId], session, true);
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
          visitProgress: progressVisitFromDetails(() => null),
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
        expect(addressing.admitWait({ jobIds: [f.jobId] })[0].disposition).toBe('admitted');
      }
      refreshHistoricalEpochs(f.index);
      expect(f.index.unknownLocationHolds()[0].retryScheduled).toBe(false);
      expect(addressing.admitWait({ jobIds: [f.jobId] })[0].disposition).toBe('outcome-unreadable');
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
              if (!sql.includes('SELECT job_id FROM projection_jobs')) return statement;
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
        visitProgress: progressVisitFromDetails(() => null),
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

const FP = fingerprints[0];
describe('unpublished protected addresses', () => {
  it('read, seed and refresh observe an unpublished address until the post-ready owner publishes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nreview6-c2-'));
    directories.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const epochDir = join(root, 'db', 'epoch-7');
    mkdirSync(epochDir, { recursive: true });
    writeFileSync(
      join(epochDir, '.coral-lineage.v1.json'),
      JSON.stringify({ version: 'v1', lineageId: '00000000-0000-4000-8000-000000000007' }),
    );
    newRawDatabase(join(epochDir, '.lock')).close();
    const db = newRawDatabase(join(epochDir, 'store.db'));
    db.exec(`CREATE TABLE projection_jobs (job_id TEXT, execution_owner TEXT, phase TEXT, diagnostics TEXT, session_id TEXT,
      provider TEXT, project_root TEXT, backend_namespace TEXT, bundle_hash TEXT, job_kind TEXT, parent_workflow_job_id TEXT,
      workflow_slot TEXT, workflow_slot_generation INTEGER, replaces_workflow_job_id TEXT, created_at TEXT, last_seq INTEGER);
      CREATE TABLE events (seq INTEGER, ts TEXT, type TEXT, stream_kind TEXT, stream_id TEXT, body BLOB);`);
    db.close();
    const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
    const address = protectStoreEpoch(runtime, epoch);
    const resolved = {
      storeRoot: dirname(address.protectedPath),
      epoch: '7',
      path: join(address.protectedPath, 'store.db'),
      lineageKey: address.epochKey,
      canonicalStoreRoot: join(root, 'db'),
    };
    const epochKey = encodeResolvedStoreEpoch(runtime, resolved);
    const index = new JobLocationIndex(runtime, root);
    seedHistoricalEpoch(runtime, index, resolved, epochKey, FP, join(root, 'results'), runtime.storage);
    const addresses = join(protectedStoreEpochRoot(join(root, 'db')), 'addresses');
    // an address that is not (or no longer) published, e.g. a protection whose publication was skipped
    for (const name of readdirSync(addresses)) rmSync(join(addresses, name));
    expect(readdirSync(addresses)).toEqual([]);
    const result = readHistoricalSource(index, epochKey, ['job-1']);
    expect(result.kind).toBe('read');
    expect(readdirSync(addresses)).toEqual([]);
    seedHistoricalEpoch(runtime, index, resolved, epochKey, FP, join(root, 'results'), runtime.storage);
    await refreshHistoricalEpochs(index);
    expect(readdirSync(addresses)).toEqual([]);
    await sweepStoreEpochsPostReady(runtime, epoch, { resultsReleased: () => false });
    expect(readdirSync(addresses)).toHaveLength(1);
  });
});

it('registers the present inventory once, including preserved epochs and stale active holds', () => {
  const f = fixture(fingerprints[0]);
  f.db.close();
  const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
  const key = encodeResolvedStoreEpoch(runtime, epoch);
  const index = new JobLocationIndex(runtime, f.root);
  index.holdUnknownLocations(key, 'former active recovery pending', true);
  const entry = {
    resolved: epoch,
    epochKey: key,
    role: 'preserved',
    epochJson: { kind: 'valid', value: { build: { storeFormatFingerprint: fingerprints[0] } } },
  } as never;
  const open = vi.spyOn(storage, 'openSqliteDatabaseSync');
  registerPresentHistoricalEpochs(runtime, index, [entry], 'other');
  expect(readHistoricalSource(index, key, ['typo']).kind).toBe('read');
  expect(index.unknownLocationHolds()).toEqual([]);
  const count = open.mock.calls.length;
  registerPresentHistoricalEpochs(runtime, index, [entry], 'other');
  expect(open).toHaveBeenCalledTimes(count);
  open.mockRestore();
});

it('registers an epoch newly observable after the first inventory projection', () => {
  const f = fixture(fingerprints[0]);
  f.db.close();
  const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
  const key = encodeResolvedStoreEpoch(runtime, epoch);
  const index = new JobLocationIndex(runtime, f.root);
  const metadata = { kind: 'valid', value: { build: { storeFormatFingerprint: fingerprints[0] } } };
  registerPresentHistoricalEpochs(
    runtime,
    index,
    [{ resolved: null, epochKey: key, epochJson: metadata }] as never,
    'other',
  );
  expect(readHistoricalSource(index, key, ['typo'])).toMatchObject({ disposition: 'transient-unknown' });
  registerPresentHistoricalEpochs(
    runtime,
    index,
    [{ resolved: epoch, epochKey: key, epochJson: metadata }] as never,
    'other',
  );
  expect(readHistoricalSource(index, key, ['typo']).kind).toBe('read');
});

it('probes a certified source, repairs its guard and settles three failed opens', () => {
  const f = fixture(fingerprints[0]);
  f.db.close();
  const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
  const key = encodeResolvedStoreEpoch(runtime, epoch);
  const index = new JobLocationIndex(runtime, f.root);
  seedHistoricalEpoch(runtime, index, epoch, key, fingerprints[0], join(f.root, 'results'), storage, [], true);
  expect(index.certificate(key)).not.toBeNull();
  writeFileSync(join(f.epochDir, '.lock'), 'malformed');
  refreshHistoricalEpochs(index);
  expect(index.unknownLocationHolds()).toEqual([]);
  const guard = attemptExclusiveFileLockSync(join(f.epochDir, '.lock'));
  expect(guard.kind).toBe('acquired');
  if (guard.kind === 'acquired') guard.lease();
  const open = vi.spyOn(storage, 'openSqliteDatabaseSync').mockImplementation(() => {
    throw new Error('unable to open database file');
  });
  for (let i = 0; i < 3; i++) refreshHistoricalEpochs(index);
  expect(index.unknownLocationHolds()).toMatchObject([{ retryScheduled: false }]);
  expect(index.certificate(key)).toBeNull();
  open.mockRestore();
});

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

it('resumes refresh after its budget instead of rehydrating the same live prefix', async () => {
  const f = fixture(fingerprints[0]);
  for (let i = 0; i < 40; i++) {
    f.db
      .prepare('INSERT INTO projection_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        `live-${i}`,
        JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
        'running',
        JSON.stringify({ progressFaults: [] }),
        'session-1',
        'codex',
        f.root,
        'test',
        null,
        'provider',
        null,
        null,
        null,
        null,
        '2026-09-25T00:00:00.000Z',
        i + 1,
      );
    f.db
      .prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        i + 1,
        '2026-09-25T00:00:00.000Z',
        'job.launch.requested',
        'job',
        `live-${i}`,
        Buffer.from(JSON.stringify({ projectRoot: f.root, jobKind: 'provider', request: { cwd: f.root } })),
      );
  }
  f.db.close();
  const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
  const key = encodeResolvedStoreEpoch(runtime, epoch);
  const index = new JobLocationIndex(runtime, f.root);
  seedHistoricalEpoch(runtime, index, epoch, key, fingerprints[0], join(f.root, 'results'), storage);
  expect(index.unknownLocationHolds()).toEqual([]);
  for (let i = 0; i < 40; i++) index.markUncertified(`live-${i}`);
  const writer = newRawDatabase(epoch.path);
  for (let i = 0; i < 40; i++)
    writer.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      i + 41,
      '2026-09-25T00:00:01.000Z',
      'job.progress.emitted',
      'job',
      `live-${i}`,
      Buffer.from(
        JSON.stringify({
          message: 'advancing progress',
          timing: { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 },
        }),
      ),
    );
  writer.close();
  const observed = vi.spyOn(index, 'recordObserved');
  for (let i = 0; i < 3; i++) await refreshHistoricalEpochs(index, { remaining: 0 });
  expect(index.unknownLocationHolds()).toEqual([]);
  expect(observed).toHaveBeenCalledTimes(40);
  expect(new Set(observed.mock.calls.map(([id]) => id)).size).toBe(40);
});

it('refreshes jobs inserted before a partially seeded projection prefix', async () => {
  const f = fixture(fingerprints[0]);
  const addJob = (db: typeof f.db, jobId: string, seq: number): void => {
    db.prepare(
      `INSERT INTO projection_jobs VALUES (?, ?, 'running', ?, 'session-1', 'codex', ?,
      'test', NULL, 'provider', NULL, NULL, NULL, NULL, '2026-09-25T00:00:00.000Z', ?)`,
    ).run(
      jobId,
      JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
      JSON.stringify({ progressFaults: [] }),
      f.root,
      seq,
    );
    db.prepare("INSERT INTO events VALUES (?, '2026-09-25T00:00:00.000Z', 'job.launch.requested', 'job', ?, ?)").run(
      seq,
      jobId,
      Buffer.from(JSON.stringify({ projectRoot: f.root, jobKind: 'provider', request: { cwd: f.root } })),
    );
  };
  for (let i = 0; i < 40; i++) addJob(f.db, `live-${i}`, i + 1);
  f.db.close();
  const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
  const key = encodeResolvedStoreEpoch(runtime, epoch);
  const index = new JobLocationIndex(runtime, f.root);
  seedHistoricalEpoch(runtime, index, epoch, key, fingerprints[0], join(f.root, 'results'), storage, [], false, {
    remaining: 16,
  });
  await retryUnknownHistoricalEpochs(index, { remaining: 0 });
  await retryUnknownHistoricalEpochs(index, { remaining: 0 });
  const writer = newRawDatabase(epoch.path);
  addJob(writer, 'aaa-new', 41);
  writer.close();
  for (let i = 0; i < 4; i++) await retryUnknownHistoricalEpochs(index, { remaining: 0 });
  expect(index.unknownLocationHolds()).toEqual([]);
  await refreshHistoricalEpochs(index);
  expect(index.read('aaa-new')?.detail.kind).toBe('recorded');
});

it('scheduled source holds name the owner cadence and failure bound without an imperative', () => {
  const f = fixture(fingerprints[0]);
  f.db.close();
  const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
  const key = encodeResolvedStoreEpoch(runtime, epoch);
  const index = new JobLocationIndex(runtime, f.root);
  const open = vi.spyOn(storage, 'openSqliteDatabaseSync').mockImplementation(() => {
    throw new Error('source is busy');
  });
  try {
    seedHistoricalEpoch(runtime, index, epoch, key, fingerprints[0], join(f.root, 'results'), storage);
    const reason = index.unknownLocationHolds()[0].reason;
    expect(reason).toContain('probe 1 of 3 failed');
    expect(reason).toContain('epoch maintenance probes every 5 s');
    expect(reason).not.toMatch(/retry the continuation|repair|restore/i);
  } finally {
    open.mockRestore();
  }
});

describe('ordinary retirement keeps typos missing', () => {
  const fp = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';
  const dirs: string[] = [];
  const realRuntime = createRealRuntime('prod', { baseDir: tmpdir() });
  const runtime = { ...realRuntime, time: { ...realRuntime.time, now: () => Date.parse('2026-09-25T00:00:20.000Z') } };

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'nreview7-hold-'));
    dirs.push(root);
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
    db.exec(`CREATE TABLE projection_jobs (job_id TEXT, execution_owner TEXT, phase TEXT, diagnostics TEXT, session_id TEXT,
    provider TEXT, project_root TEXT, backend_namespace TEXT, bundle_hash TEXT, job_kind TEXT, parent_workflow_job_id TEXT,
    workflow_slot TEXT, workflow_slot_generation INTEGER, replaces_workflow_job_id TEXT, created_at TEXT, last_seq INTEGER);`);
    db.exec(`CREATE TABLE events (seq INTEGER, ts TEXT, type TEXT, stream_kind TEXT, stream_id TEXT, body BLOB);`);
    db.close();
    return { root, epochDir };
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  describe('probe: normal retirement of a hydrated historical epoch', () => {
    it('keeps an unknown id missing after the source retires', async () => {
      const { root, epochDir } = fixture();
      const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };

      readOrCreateEpochKey(runtime, epoch);
      const epochKey = encodeResolvedStoreEpoch(runtime, epoch);
      const index = new JobLocationIndex(runtime, root);
      expect(
        seedHistoricalEpoch(runtime, index, epoch, epochKey, fp, join(root, 'results'), runtime.storage).kind,
      ).toBe('uncertified');
      expect(index.unknownLocationHolds()).toEqual([]);
      const addressing = new JobAddressing(
        index.readOnlyView(),
        {
          visitProgress: progressVisitFromDetails(() => null),
          epochKey: () => 'new:8',
          detail: () => null,
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        },
        () => false,
        () => 'decided',
        undefined,
        () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
      );
      expect(addressing.admitWait({ jobIds: ['typo-id'] })[0].disposition).toBe('missing');

      rmSync(epochDir, { recursive: true, force: true }); // ordinary retirement removes the epoch directory
      await retryUnknownHistoricalEpochs(index);

      const after = addressing.admitWait({ jobIds: ['typo-id'] });

      expect(after[0].disposition).toBe('missing');
    });
  });
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

it('the sweep uses the production onOpen lineage without hydrating the active epoch', async () => {
  const base = mkdtempSync(join(tmpdir(), 'coral-active-sweep-'));
  directories.push(base);
  const runtime = createRealRuntime('prod', { baseDir: base });
  const storeFormat = currentCoralStoreFormat();
  const settled = settleStoreEpoch(runtime, {
    storeFormat,
    build: {
      version: storeFormat.productVersion,
      buildSetId: '123e4567-e89b-42d3-a456-426614174000',
      bundleHash: '0123456789abcdef',
      cliBundleHash: '0123456789abcdef',
      claudeAppserverBundleHash: '0123456789abcdef',
      durableWrapperBundleHash: '0123456789abcdef',
      flavor: runtime.flavor,
      storeFormatFingerprint: storeFormat.fingerprint,
    },
    authorizeMint: ({ incumbent, observedEpochCount }) =>
      incumbent === null && observedEpochCount === 0 ? retirementMintDisposition('initial', null) : null,
  });
  const key = encodeResolvedStoreEpoch(runtime, settled.store);
  let selected: string | null = null;
  const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
  const store = new JobStore('fixture', runtime, createEventBodyCodec(), {
    db: settled.db,
    providers: permissiveProviderLookupPort,
    beforeAppend: (input) => index.beforeAppend(input, key),
  });
  initTestJob(store, {
    jobId: 'live-job',
    sessionId: 'session-1',
    provider: 'claude',
    projectRoot: base,
    backendNamespace: 'fixture',
  });
  // The scheduler's timers run when the test says so: the first sweep starts on demand, and its 5 s reschedule
  // marks that the whole sweep has finished.
  const sweeps: Array<() => void> = [];
  let swept!: () => void;
  const firstSweep = new Promise<void>((resolve) => {
    swept = resolve;
  });
  const scheduler = createStoreEpochSweepScheduler({
    runtime: {
      ...runtime,
      time: {
        ...runtime.time,
        setTimeout: (callback, delay) => {
          sweeps.push(callback);
          if (delay === 5_000) swept();
          return { unref: () => undefined } as never;
        },
        clearTimeout: () => undefined,
      },
    },
    world: { log: vi.fn() },
    jobLocationIndex: index,
    selectedStoreEpochKey: () => selected,
    onOpen: (openStore) => {
      selected = openStore.path === ':memory:' ? null : readOrCreateEpochKey(runtime, openStore);
    },
    closeProxySetForEpochClosure: async () => true,
  });
  try {
    scheduler.schedule(settled.store);
    sweeps[0]();
    await firstSweep;
    await scheduler.stop();
    expect(selected).not.toBe(key);
    expect(index.read('live-job')?.disposition).toBe('active-owner');
    expect(index.unknownLocationHolds()).toEqual([]);
    const writes = vi.spyOn(runtime.storage, 'writeAtomicDurableSync');
    for (let tick = 0; tick < 4; tick++) {
      for (let i = 0; i < 200; i++) store.appendProgress('live-job', 'session-1', `progress ${tick}-${i}`);
      writes.mockClear();
      await refreshHistoricalEpochs(index, { remaining: 0 });
      expect(writes).not.toHaveBeenCalled();
    }
    writes.mockRestore();
    const nextDir = join(settled.store.storeRoot, 'epoch-2');
    mkdirSync(nextDir, { recursive: true });
    newRawDatabase(join(nextDir, '.lock')).close();
    newRawDatabase(join(nextDir, 'store.db')).close();
    const deps = createLifecycleRecoveryDependencies({
      runtime,
      identity: { buildSetId: 'fixture', instanceId: 'fixture-instance', pluginRoot: join(base, 'none') } as never,
      jobLocationIndex: index,
      providerHostTransfer: {} as never,
      getProgressStore: () => store,
      readSuccessionJobs: () => [],
      world: {} as never,
      onOpenedStore: () => {},
    });
    deps.onStoreOpened!({ storeRoot: settled.store.storeRoot, epoch: '2', path: join(nextDir, 'store.db') });
    expect(index.read('live-job')?.disposition).toBe('active-owner');
  } finally {
    await scheduler.stop();
    settled.db.close();
  }
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

  it('a failing row does not stall later budgeted seed rows', async () => {
    const f = fixture();
    for (let i = 0; i < 9; i++) f.addJob(`done-${i}`);
    f.db.close();
    const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
    const key = encodeResolvedStoreEpoch(runtime, epoch);
    const index = new JobLocationIndex(runtime, join(f.root, 'state'));
    const record = index.recordTerminal.bind(index);
    vi.spyOn(index, 'recordTerminal').mockImplementation((...args) => {
      if (args[0] === 'done-0') throw new Error('EIO');
      return record(...args);
    });
    for (let tick = 0; tick < 12; tick++)
      seedHistoricalEpoch(runtime, index, epoch, key, FP0, join(f.root, 'results'), storage, [], true, {
        remaining: 2,
      });
    expect(index.read('done-8')?.terminalSeq).toBeDefined();
  });

  it('restart preserves a certified present epoch under a seed budget', async () => {
    const f = fixture();
    for (let i = 0; i < 9; i++) f.addJob(`done-${i}`);
    f.db.close();
    const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
    const key = encodeResolvedStoreEpoch(runtime, epoch);
    const state = join(f.root, 'state');
    const first = new JobLocationIndex(runtime, state);
    seedHistoricalEpoch(runtime, first, epoch, key, FP0, join(f.root, 'results'), storage, [], true);
    expect(first.resultsReleased(key)).toBe(true);
    const restarted = new JobLocationIndex(runtime, state);
    const entry = {
      resolved: epoch,
      epochKey: key,
      epochJson: { kind: 'valid', value: { build: { storeFormatFingerprint: FP0 } } },
    } as never;
    registerPresentHistoricalEpochs(runtime, restarted, [entry], 'active', { remaining: 0 });
    await retryUnknownHistoricalEpochs(restarted, { remaining: 0 });
    await refreshHistoricalEpochs(restarted, { remaining: 0 });
    expect(restarted.resultsReleased(key)).toBe(true);
    expect(restarted.certificate(key)).toEqual(first.certificate(key));
    expect(restarted.unknownLocationHolds()).toEqual([]);
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

  it.each([true, false])('bounds terminal record re-reads and preserves eventual progress, terminal=%s', (terminal) => {
    const f = fixture();
    const ids = Array.from({ length: 40 }, (_, i) => `job-${i}`);
    for (const id of ids) f.addJob(id, { contentBytes: 1000, terminal, progress: 1 });
    f.db.close();
    const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
    const key = encodeResolvedStoreEpoch(runtime, epoch);
    const index = new JobLocationIndex(runtime, join(f.root, 'state'));
    seedHistoricalEpoch(runtime, index, epoch, key, FP0, join(f.root, 'results'), storage, [], true);
    const addressing = new JobAddressing(
      index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'active',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => (terminal ? 'decided' : 'pending'),
      undefined,
      () => ({ kind: 'available', resultPath: '/x' }),
    );
    const request = { jobIds: [...ids].reverse() };
    const read = vi.spyOn(storage, 'readFileSync');
    const observed = new Set<string>();
    const delivered = new Set<string>();
    let deliveredLines = 0;
    const session = new WaitSession(request.jobIds);
    try {
      for (let poll = 0; poll < 8; poll++) {
        read.mockClear();
        const admissions = addressing.admitWait(request);
        session.reconcile(admissions);
        const selection = session.withProgress(index.readOnlyView().visitProgress!, (sources) => {
          session.position(sources, 20, 500, 64 * 1024);
          return session.select(sources, 500, 64 * 1024);
        });
        for (const line of selection.lines) {
          delivered.add(line.jobId);
          deliveredLines++;
          session.consume(line);
        }
        session.advanceSilently(selection.advances);
        for (const job of admissions) if (job.disposition === 'admitted') observed.add(job.jobId);
        if (terminal)
          expect(
            read.mock.calls.filter(([path]) => String(path).includes('/jobs/') && String(path).endsWith('.json'))
              .length,
          ).toBeLessThanOrEqual(poll === 0 ? 40 : 32);
      }
      expect(observed.size).toBe(40);
      expect(delivered.size).toBe(40);
      expect(deliveredLines).toBe(40);
      expect(session.admissions.every((job) => job.disposition === 'admitted')).toBe(true);
      expect(session.admissions.every((job) => session.progressState(job.jobId) !== 'unknown')).toBe(true);
    } finally {
      read.mockRestore();
    }
  });

  it('does not restart a completed seed after a transient refresh failure', async () => {
    const f = fixture();
    f.addJob('one');
    f.db.close();
    const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
    const key = encodeResolvedStoreEpoch(runtime, epoch);
    const index = new JobLocationIndex(runtime, join(f.root, 'state'));
    seedHistoricalEpoch(runtime, index, epoch, key, FP0, join(f.root, 'results'), storage, [], true);
    const failure = vi.spyOn(storage, 'openSqliteDatabaseSync').mockImplementationOnce(() => {
      throw new Error('temporary open failure');
    });
    refreshHistoricalEpochs(index);
    failure.mockRestore();
    const register = vi.spyOn(index, 'register');
    await retryUnknownHistoricalEpochs(index, { remaining: 0 });
    expect(register).not.toHaveBeenCalled();
    register.mockRestore();
    refreshHistoricalEpochs(index);
    expect(index.certificate(key)).not.toBeNull();
  });

  it('retirement proofs share one source read for inside-window terminals', () => {
    const f = fixture();
    for (let i = 0; i < 24; i++) f.addJob(`fresh-${i}`);
    f.db.close();
    const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
    const key = encodeResolvedStoreEpoch(runtime, epoch);
    const index = new JobLocationIndex(runtime, join(f.root, 'state'));
    seedHistoricalEpoch(runtime, index, epoch, key, FP0, join(f.root, 'results'), storage, [], true);
    const open = vi.spyOn(storage, 'openSqliteDatabaseSync');
    try {
      expect(index.resultsReleased(key)).toBe(true);
      expect(open.mock.calls.filter(([path]) => path === epoch.path).length).toBeLessThanOrEqual(1);
    } finally {
      open.mockRestore();
    }
  });

  it('a seed slice fetches bodies only for its budgeted subjects', () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) f.addJob(`payload-${i}`);
    f.db.close();
    const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
    const key = encodeResolvedStoreEpoch(runtime, epoch);
    const index = new JobLocationIndex(runtime, join(f.root, 'state'));
    const payloadSubjects = new Set<string>();
    const count = (value: unknown): void => {
      if (value instanceof Uint8Array) return;
      else if (Array.isArray(value)) value.forEach(count);
      else if (value && typeof value === 'object') {
        const row = value as Record<string, unknown>;
        if (row.body !== undefined && (row.stream_id !== undefined || row.job_id !== undefined))
          payloadSubjects.add(String(row.stream_id ?? row.job_id));
        Object.values(value).forEach(count);
      }
    };
    const open = storage.openSqliteDatabaseSync;
    const measured = {
      ...storage,
      openSqliteDatabaseSync: (...args: Parameters<typeof open>) => {
        const db = open(...args);
        return new Proxy(db, {
          get(target, member) {
            if (member !== 'prepare') {
              const value = Reflect.get(target, member);
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return (sql: string) =>
              new Proxy(target.prepare(sql), {
                get(statement, method) {
                  const value = Reflect.get(statement, method);
                  if (method !== 'all' && method !== 'get')
                    return typeof value === 'function' ? value.bind(statement) : value;
                  return (...bindings: SqliteValue[]) => {
                    const result = value.apply(statement, bindings);
                    count(result);
                    return result;
                  };
                },
              });
          },
        });
      },
    };
    seedHistoricalEpoch(runtime, index, epoch, key, FP0, join(f.root, 'results'), measured, [], false, {
      remaining: 1,
    });
    expect(payloadSubjects).toEqual(new Set(['payload-0']));
    expect(index.read('payload-0')).not.toBeNull();
    expect(index.read('payload-1')).toBeNull();
  });

  it('charges one unit for each complete subject and defers startup seeding', () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) f.addJob(`job-${i}`);
    f.db.close();
    const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
    const key = encodeResolvedStoreEpoch(runtime, epoch);
    const index = new JobLocationIndex(runtime, join(f.root, 'state'));
    const register = vi.spyOn(index, 'register');
    seedHistoricalEpoch(runtime, index, epoch, key, FP0, join(f.root, 'results'), storage, [], false, { remaining: 0 });
    expect(register).not.toHaveBeenCalled();
    for (let tick = 0; tick < 3; tick++) {
      register.mockClear();
      const budget = { remaining: 1 };
      seedHistoricalEpoch(runtime, index, epoch, key, FP0, join(f.root, 'results'), storage, [], false, budget);
      expect(budget.remaining).toBe(0);
      expect(new Set(register.mock.calls.map(([id]) => id))).toEqual(new Set([`job-${tick}`]));
      expect(index.read(`job-${tick}`)?.disposition).toBe('terminal');
    }
  });
  it('answers non-members as absent after the first slice without trusting a changed source frontier', () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) f.addJob(`job-${i}`);
    f.db.close();
    const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
    const key = encodeResolvedStoreEpoch(runtime, epoch);
    const index = new JobLocationIndex(runtime, join(f.root, 'state'));
    const addressing = new JobAddressing(
      index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'active',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'available', resultPath: '/result.md' }),
    );
    const request = { jobIds: ['ghost', 'job-3'] };
    seedHistoricalEpoch(runtime, index, epoch, key, FP0, join(f.root, 'results'), storage, [], false, { remaining: 0 });
    expect(addressing.admitWait(request).map((job) => job.disposition)).toEqual(['missing', 'admitted']);
    seedHistoricalEpoch(runtime, index, epoch, key, FP0, join(f.root, 'results'), storage, [], false, { remaining: 1 });
    expect(addressing.admitWait(request).map((job) => job.disposition)).toEqual(['missing', 'admitted']);
    const changed = newRawDatabase(epoch.path);
    changed.exec(
      "INSERT INTO events (seq, ts, type, stream_kind, stream_id, body) SELECT (SELECT MAX(seq) + 1 FROM events), ts, type, stream_kind, 'ghost', body FROM events WHERE type = 'job.launch.requested' LIMIT 1",
    );
    changed.close();
    expect(addressing.admitWait(request)[0].disposition).toBe('discovery-unknown');
  });
  it('a restart does not re-seed settled members of an epoch that cannot certify', () => {
    const f = fixture();
    for (const job of ['done-0', 'done-1', 'done-2', 'live']) f.addJob(job);
    f.db.prepare("DELETE FROM events WHERE stream_id = 'live' AND type = 'job.terminal.recorded'").run();
    f.db.prepare("UPDATE projection_jobs SET phase = 'running' WHERE job_id = 'live'").run();
    f.db.close();
    const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
    const key = encodeResolvedStoreEpoch(runtime, epoch);
    const index = new JobLocationIndex(runtime, join(f.root, 'state'));
    seedHistoricalEpoch(runtime, index, epoch, key, FP0, join(f.root, 'results'), storage, [], true);
    expect(index.certificate(key)).toBeNull();
    const restarted = new JobLocationIndex(runtime, join(f.root, 'state'));
    const register = vi.spyOn(restarted, 'register');
    const budget = { remaining: 1 };
    for (let slice = 0; slice < 4; slice++) {
      budget.remaining = 1;
      seedHistoricalEpoch(runtime, restarted, epoch, key, FP0, join(f.root, 'results'), storage, [], true, budget);
      expect(budget.remaining).toBe(0);
    }
    expect(register.mock.calls.map(([id]) => id)).toEqual(['live']);
    expect(restarted.unknownLocationHold(key)).toBeNull();
    expect(budget.remaining).toBe(0);
  });
  it('routes hydration hints through lineage identity across address spellings', () => {
    const f = fixture();
    f.addJob('live');
    f.db.prepare("DELETE FROM events WHERE stream_id = 'live' AND type = 'job.terminal.recorded'").run();
    f.db.prepare("UPDATE projection_jobs SET phase = 'running' WHERE job_id = 'live'").run();
    f.db.close();
    const epoch = { storeRoot: join(f.root, 'db'), epoch: '7', path: join(f.epochDir, 'store.db') };
    const key = encodeResolvedStoreEpoch(runtime, epoch);
    const index = new JobLocationIndex(runtime, join(f.root, 'state'));
    seedHistoricalEpoch(runtime, index, epoch, key, FP0, join(f.root, 'results'), storage);
    const alias = JSON.stringify({ ...JSON.parse(key), storeRoot: join(f.root, 'alias') });
    vi.spyOn(index, 'read').mockReturnValue({ ...index.read('live')!, epochKey: alias });
    const hint = vi.fn();
    onHistoricalHydrationHint(index, hint);
    hintHistoricalHydration(index, 'live');
    expect(hint).toHaveBeenCalledExactlyOnceWith(alias);
    onHistoricalHydrationHint(index, null);
  });
});

it('protected-address observation never repairs a corrupt guard when its publication is missing', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    const address = protectStoreEpoch(f.runtime, f.epoch);
    if (!address) throw new Error('missing protected address');
    const lineage = JSON.parse(f.epochKey).lineageKey as string;
    const root = protectedStoreEpochRoot(f.epoch.storeRoot);
    unlinkSync(join(root, 'addresses', `${Buffer.from(lineage).toString('base64url')}.json`));
    const guard = join(address.protectedPath, '.lock');
    writeFileSync(guard, 'malformed');
    const before = readdirSync(address.protectedPath).sort();
    expect(() => observeProtectedEpoch(f.runtime, f.epoch.storeRoot, lineage)).toThrow();
    expect(readFileSync(guard, 'utf8')).toBe('malformed');
    expect(readdirSync(address.protectedPath).sort()).toEqual(before);
  } finally {
    f.close();
  }
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

it.each([
  'missing guard',
  'malformed guard',
  'symlink guard',
  'linked guard',
  'missing metadata',
  'malformed metadata',
])('registers a previously unseen epoch with %s and gives it a maintenance exit', async (fault) => {
  const f = createTerminalExportFixture('provider', true);
  try {
    const guard = join(f.epochDir, '.lock');
    if (fault === 'missing guard') unlinkSync(guard);
    if (fault === 'malformed guard') writeFileSync(guard, 'malformed');
    if (fault === 'symlink guard') {
      const target = join(f.root, 'outside.lock');
      newRawDatabase(target).close();
      unlinkSync(guard);
      symlinkSync(target, guard);
    }
    if (fault === 'linked guard') linkSync(guard, join(f.root, 'other.lock'));
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
    if (fault === 'missing guard' || fault === 'malformed guard') expect(read.kind).toBe('read');
    else expect(read).toMatchObject({ kind: 'unreadable', disposition: 'settled-unreadable' });
  } finally {
    f.close();
  }
});

it('hydration-owned export failures wake the scheduled repair owner', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete();
    const owner = f.store.getResultExportOwner();
    const hint = vi.fn();
    owner.onRepairHint(hint);
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockReturnValue(false);
    expect(() =>
      f.index
        .resultExportOwnerForSource(f.db, f.epochKey, f.runtime.paths.coral.exports.jobsRoot)
        .ensureResultMarkdownArtifact(f.jobId),
    ).toThrow();
    expect(hint).toHaveBeenCalledOnce();
    write.mockRestore();
    owner.onRepairHint(null);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('observes journal progress when file stamps collide in one timestamp tick', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.store.appendProgress(f.jobId, 'session-1', 'before');
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
    const lstat = f.runtime.storage.lstatSync.bind(f.runtime.storage);
    const stamps = new Map<string, ReturnType<typeof lstat>>();
    const spy = vi.spyOn(f.runtime.storage, 'lstatSync').mockImplementation(((
      path: string,
      options?: { bigint: true },
    ) => {
      if (!options) return lstat(path);
      let stat = stamps.get(path);
      if (!stat) {
        stat = lstat(path, options);
        stamps.set(path, stat);
      }
      return stat;
    }) as typeof f.runtime.storage.lstatSync);
    reader(f.epochKey, [f.jobId], session);
    f.store.appendProgress(f.jobId, 'session-1', 'after');
    const observed = reader(f.epochKey, [f.jobId], session, true);
    spy.mockRestore();
    expect(observed.kind).toBe('read');
    if (observed.kind !== 'read') throw new Error('source unreadable');
    const location = observed.locations.get(f.jobId);
    expect(
      location?.detail.kind === 'recorded' &&
        location.detail.value.events.some((event) => event.type === 'progress' && event.message === 'after'),
    ).toBe(true);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('settles registration identity failures after three consecutive observations', () => {
  const { root, epochDir, db } = fixture(fingerprints[0]);
  db.close();
  const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
  const key = encodeResolvedStoreEpoch(runtime, epoch);
  const index = new JobLocationIndex(runtime, join(root, 'state'));
  writeFileSync(join(epochDir, '.coral-lineage.v1.json'), '{bad');
  const entry = {
    resolved: epoch,
    epochKey: key,
    epochJson: { kind: 'valid', value: { build: { storeFormatFingerprint: fingerprints[0] } } },
  } as never;
  for (let tick = 0; tick < 3; tick++)
    registerPresentHistoricalEpochs(runtime, index, [entry], 'active', { remaining: 0 });
  expect(index.unknownLocationHolds()).toEqual([
    expect.objectContaining({ retryScheduled: false, reason: expect.stringContaining('next start') }),
  ]);
  expect(readHistoricalSource(index, key, ['unknown'])).toMatchObject({
    kind: 'unreadable',
    disposition: 'settled-unreadable',
  });
});

it('registration publishes its pending hold before the first maintenance slice', () => {
  const { root, epochDir, db } = fixture(fingerprints[0]);
  db.close();
  const epoch = { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') };
  const key = encodeResolvedStoreEpoch(runtime, epoch);
  const index = new JobLocationIndex(runtime, join(root, 'state'));
  registerPresentHistoricalEpochs(
    runtime,
    index,
    [
      {
        resolved: epoch,
        epochKey: key,
        epochJson: { kind: 'valid', value: { build: { storeFormatFingerprint: fingerprints[0] } } },
      },
    ] as never,
    'active',
    { remaining: 0 },
  );
  expect(index.unknownLocationHolds()).toEqual([expect.objectContaining({ retryScheduled: true })]);
});

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

it('discharges an unknown-age legacy result from its proven closed reaping source', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1000, precedingAt: TERMINAL_EXPORT_CUTOFF - 2000 });
    const jobPath = join(f.root, 'job-locations.v1', 'jobs', `${Buffer.from(f.jobId).toString('base64url')}.json`);
    const stored = JSON.parse(readFileSync(jobPath, 'utf8'));
    delete stored.terminalAge;
    writeFileSync(jobPath, JSON.stringify(stored));
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

it.each(['symlink', 'linked'] as const)(
  'refresh settles a certified source with a %s guard after three failures',
  async (fault) => {
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
      expect(f.index.unknownLocationHolds()).toEqual([]);
      const guard = join(f.epochDir, '.lock');
      const other = join(f.root, 'other.lock');
      if (fault === 'symlink') {
        renameSync(guard, other);
        symlinkSync(other, guard);
      } else linkSync(guard, other);
      for (let attempt = 0; attempt < 3; attempt++) await refreshHistoricalEpochs(f.index);
      expect(f.index.unknownLocationHolds()).toMatchObject([{ retryScheduled: false }]);
      expect(readHistoricalSource(f.index, f.epochKey, [f.jobId])).toMatchObject({
        kind: 'unreadable',
        disposition: 'settled-unreadable',
      });
    } finally {
      f.close();
    }
  },
);

it('budgeted refresh advances past absent projection rows to the live subject', () => {
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
    f.index.markUncertified(f.jobId);
    f.store.appendProgress(f.jobId, 'session-1', 'after absent rows');
    const observed = vi.spyOn(f.index, 'recordObserved');
    for (let slice = 0; slice < 3; slice++)
      refreshHistoricalEpoch(f.index, f.epochKey, ['missing-first', 'missing-second', f.jobId], { remaining: 1 });
    expect(observed.mock.calls.map(([jobId]) => jobId)).toEqual([f.jobId]);
    expect(f.index.read(f.jobId)?.detail).toMatchObject({
      kind: 'recorded',
      value: {
        events: expect.arrayContaining([expect.objectContaining({ type: 'progress', message: 'after absent rows' })]),
      },
    });
  } finally {
    f.close();
  }
});

it('requires two absent observations before retiring an unregistered source', () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-unregistered-rename-'));
  directories.push(root);
  const index = new JobLocationIndex(runtime, root);
  let observations = 0;
  const view = {
    ...index.readOnlyView(),
    historicalSourceState: () => (++observations === 1 ? ('absent' as const) : ('present' as const)),
  };
  expect(readHistoricalSource(view, 'unregistered', ['job'])).toMatchObject({
    kind: 'unreadable',
    disposition: 'transient-unknown',
  });
  expect(observations).toBeGreaterThanOrEqual(2);
  const absent = { ...index.readOnlyView(), historicalSourceState: () => 'absent' as const };
  expect(readHistoricalSource(absent, 'unregistered', ['job'])).toMatchObject({
    kind: 'unreadable',
    disposition: 'retired',
  });
});

it('a per-job transient read honours the source hold already settled by maintenance', () => {
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
    f.index.holdUnknownLocations(f.epochKey, 'Source maintenance settled; re-read at next start', false);
    const open = f.runtime.storage.openSqliteDatabaseSync.bind(f.runtime.storage);
    vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync').mockImplementation((path, options) => {
      const db = open(path, options);
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        if (sql === 'SELECT * FROM projection_jobs WHERE job_id = ?') throw new Error('database is locked');
        return prepare(sql);
      }) as typeof db.prepare;
      return db;
    });
    const read = readHistoricalSource(f.index, f.epochKey, [f.jobId]);
    expect(read.kind).toBe('read');
    if (read.kind !== 'read') throw new Error('Expected an isolated per-job refusal');
    expect(read.dispositions?.get(f.jobId)).toBe('settled-unreadable');
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('reads an unchanged held source once per wait session and again after it changes', () => {
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
    const open = vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync');
    const session = {};
    for (let poll = 0; poll < 10; poll++)
      expect(readHistoricalSource(f.index, f.epochKey, [f.jobId, 'typo'], session).kind).toBe('read');
    expect(open).toHaveBeenCalledTimes(1);
    f.store.appendProgress(f.jobId, 'session-1', 'changed');
    expect(readHistoricalSource(f.index, f.epochKey, [f.jobId, 'typo'], session).kind).toBe('read');
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    f.close();
  }
});

it('lets an error raised by a historical progress read escape its source and still releases the source', () => {
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
    expect(() =>
      f.index.readOnlyView().visitProgress!(f.epochKey, () => {
        throw new TypeError('defect in the reader');
      }),
    ).toThrow(TypeError);
    const attempt = attemptExclusiveFileLockSync(join(dirname(f.epoch.path), '.lock'));
    expect(attempt.kind).toBe('acquired');
    if (attempt.kind === 'acquired') attempt.lease();
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

  it('refreshes a healthy sibling past a malformed retained location', () => {
    const f = createTerminalExportFixture('provider', true);
    try {
      initTestJob(f.store, {
        jobId: 'sibling',
        sessionId: 'sibling-session',
        provider: 'claude',
        projectRoot: f.root,
        backendNamespace: 'fixture',
      });
      seedFixture(f);
      writeFileSync(f.locationPath, '{bad json');
      commitJobTerminal(f.store, 'sibling', 'sibling-session', {
        content: 'sibling done',
        outcome: { kind: 'completed' },
        durationMs: 1,
      });
      expect(refreshHistoricalEpoch(f.index, f.epochKey, [f.jobId, 'sibling'])).toEqual({ kind: 'read' });
      expect(f.index.read('sibling')?.disposition).toBe('terminal');
    } finally {
      f.close();
    }
  });

  it.each([
    ['a transient SQLITE_IOERR', 'readable'],
    ['a malformed terminal', 'settled-unreadable'],
  ] as const)('reads a job again after %s instead of answering from its earlier cache', (failure, settled) => {
    const f = createTerminalExportFixture('provider', true);
    try {
      let failNext = false;
      const storagePort = {
        ...f.runtime.storage,
        openSqliteDatabaseSync: (...args: Parameters<typeof f.runtime.storage.openSqliteDatabaseSync>) => {
          const db = f.runtime.storage.openSqliteDatabaseSync(...args);
          const bound = <T extends object>(target: T, key: string | symbol): unknown => {
            const value: unknown = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          };
          return new Proxy(db, {
            get: (target, key) =>
              key !== 'prepare'
                ? bound(target, key)
                : (sql: string) => {
                    const statement = target.prepare(sql);
                    if (sql !== 'SELECT * FROM projection_jobs WHERE job_id = ?' || !failNext) return statement;
                    failNext = false;
                    return new Proxy(statement, {
                      get: (inner, name) =>
                        name === 'get'
                          ? () => {
                              throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
                            }
                          : bound(inner, name),
                    });
                  },
          });
        },
      };
      seedFixture(f, storagePort);
      const session = {};
      const disposition = () => {
        const read = readHistoricalSource(f.index, f.epochKey, [f.jobId], session);
        return read.kind === 'read' ? read.dispositions.get(f.jobId) : read.disposition;
      };
      expect(disposition()).toBe('readable');
      if (failure === 'a transient SQLITE_IOERR') {
        commitJobTerminal(f.store, f.jobId, 'session-1', {
          content: 'valid result',
          outcome: { kind: 'completed' },
          durationMs: 1,
        });
        failNext = true;
        expect(disposition()).toBe('transient-unknown');
        const read = readHistoricalSource(f.index, f.epochKey, [f.jobId], session);
        expect(read.kind === 'read' && read.locations.get(f.jobId)?.disposition).toBe('terminal');
      } else {
        f.db
          .prepare('INSERT INTO events(ts, type, stream_kind, stream_id, refs, body) VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            new Date(TERMINAL_EXPORT_CUTOFF).toISOString(),
            'job.terminal.recorded',
            'job',
            f.jobId,
            '{}',
            Buffer.from(JSON.stringify({ terminal: { content: 'future', outcome: { kind: 'unrecognized' } } })),
          );
        f.db
          .prepare(
            "UPDATE projection_jobs SET phase = 'completed', last_seq = (SELECT MAX(seq) FROM events) WHERE job_id = ?",
          )
          .run(f.jobId);
        expect(disposition()).toBe('settled-unreadable');
      }
      expect(disposition()).toBe(settled);
    } finally {
      f.close();
    }
  });

  it('answers a session read from its cache only for jobs read at the frontier its stamp vouches for', () => {
    const f = createTerminalExportFixture('provider', true);
    try {
      initTestJob(f.store, {
        jobId: 'job-2',
        sessionId: 'session-2',
        provider: 'claude',
        projectRoot: f.root,
        backendNamespace: 'fixture',
      });
      f.store.appendProgress(f.jobId, 'session-1', 'running');
      seedFixture(f);
      const session = {};
      const disposition = (jobIds: string[], jobId: string) => {
        const read = readHistoricalSource(f.index, f.epochKey, jobIds, session);
        return read.kind === 'read' ? read.locations.get(jobId)?.disposition : read.kind;
      };
      expect(disposition([f.jobId], f.jobId)).toBe('unresolved');
      commitJobTerminal(f.store, f.jobId, 'session-1', {
        content: 'done',
        outcome: { kind: 'completed' },
        durationMs: 1,
      });
      // This read takes the newer stamp for job-2 alone; job-1's cached answer still belongs to the older frontier.
      expect(disposition(['job-2'], 'job-2')).toBe('unresolved');
      expect(disposition([f.jobId, 'job-2'], f.jobId)).toBe('terminal');
    } finally {
      f.close();
    }
  });

  it('propagates a code defect from a per-job historical read instead of holding the job', () => {
    const f = createTerminalExportFixture('provider', true);
    try {
      let defect = false;
      const storagePort = {
        ...f.runtime.storage,
        openSqliteDatabaseSync: (...args: Parameters<typeof f.runtime.storage.openSqliteDatabaseSync>) => {
          const db = f.runtime.storage.openSqliteDatabaseSync(...args);
          return new Proxy(db, {
            get: (target, key) => {
              const value: unknown = Reflect.get(target, key);
              if (key !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
              return (sql: string) => {
                if (defect && sql === 'SELECT * FROM projection_jobs WHERE job_id = ?') throw new TypeError('defect');
                return target.prepare(sql);
              };
            },
          });
        },
      };
      seedFixture(f, storagePort);
      defect = true;
      expect(() => readHistoricalSource(f.index, f.epochKey, [f.jobId], {})).toThrow(TypeError);
    } finally {
      f.close();
    }
  });

  it("decodes a running job's metadata again only after that job's own events, never after another job's", () => {
    const f = createTerminalExportFixture('provider', true);
    try {
      initTestJob(f.store, {
        jobId: 'job-2',
        sessionId: 'session-2',
        provider: 'claude',
        projectRoot: f.root,
        backendNamespace: 'fixture',
      });
      f.store.appendProgress(f.jobId, 'session-1', 'running');
      let metadataReads = 0;
      const storagePort = {
        ...f.runtime.storage,
        openSqliteDatabaseSync: (...args: Parameters<typeof f.runtime.storage.openSqliteDatabaseSync>) => {
          const db = f.runtime.storage.openSqliteDatabaseSync(...args);
          return new Proxy(db, {
            get: (target, key) => {
              const value: unknown = Reflect.get(target, key);
              if (key !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
              return (sql: string) => {
                if (sql.includes('GROUP BY type')) metadataReads += 1;
                return target.prepare(sql);
              };
            },
          });
        },
      };
      seedFixture(f, storagePort);
      const session = {};
      const disposition = () => {
        const read = readHistoricalSource(f.index, f.epochKey, [f.jobId], session);
        return read.kind === 'read' ? read.locations.get(f.jobId)?.disposition : read.kind;
      };
      expect(disposition()).toBe('unresolved');
      const decoded = metadataReads;
      for (let poll = 0; poll < 5; poll++) {
        f.store.appendProgress('job-2', 'session-2', `another job ${poll}`);
        expect(disposition()).toBe('unresolved');
      }
      expect(metadataReads).toBe(decoded);
      commitJobTerminal(f.store, f.jobId, 'session-1', {
        content: 'done',
        outcome: { kind: 'completed' },
        durationMs: 1,
      });
      expect(disposition()).toBe('terminal');
      expect(metadataReads).toBe(decoded + 1);
    } finally {
      f.close();
    }
  });
});

it('reads the seed inventory once per seed and the job high-water mark only at completion', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    for (let i = 0; i < 4; i++)
      initTestJob(f.store, {
        jobId: `inventory-${i}`,
        sessionId: `inventory-session-${i}`,
        provider: 'claude',
        projectRoot: f.root,
        backendNamespace: 'fixture',
      });
    for (let i = 0; i < 4; i++)
      rmSync(join(f.root, 'job-locations.v1', 'jobs', `${Buffer.from(`inventory-${i}`).toString('base64url')}.json`));
    const statements: string[] = [];
    const storagePort = {
      ...f.runtime.storage,
      openSqliteDatabaseSync: (...args: Parameters<typeof f.runtime.storage.openSqliteDatabaseSync>) => {
        const db = f.runtime.storage.openSqliteDatabaseSync(...args);
        return new Proxy(db, {
          get: (target, key) => {
            if (key === 'prepare')
              return (sql: string) => {
                statements.push(sql);
                return target.prepare(sql);
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    const results = [];
    for (let slice = 0; slice < 8; slice++) {
      const result = seedHistoricalEpoch(
        f.runtime,
        f.index,
        f.epoch,
        f.epochKey,
        currentCoralStoreFormat().fingerprint,
        f.runtime.paths.coral.exports.jobsRoot,
        storagePort,
        [],
        true,
        { remaining: 1 },
      );
      results.push(result.kind);
      if (result.kind !== 'uncertified' || f.index.unknownLocationHold(f.epochKey) === null) break;
    }
    expect(results.length).toBeGreaterThan(2);
    expect(statements.filter((sql) => sql.startsWith('SELECT job_id FROM projection_jobs ORDER BY'))).toHaveLength(1);
    expect(statements.filter((sql) => sql.includes("type = 'job.launch.requested' ORDER BY seq"))).toHaveLength(1);
    expect(
      statements.filter((sql) => sql === "SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE stream_kind = 'job'"),
    ).toHaveLength(1);
    for (let i = 0; i < 4; i++) expect(f.index.read(`inventory-${i}`)).toMatchObject({ jobId: `inventory-${i}` });
  } finally {
    f.close();
  }
});

it("hints a registered epoch's hydration without reading any other epoch's hold record", () => {
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
    for (let epoch = 0; epoch < 50; epoch++) {
      const key = JSON.stringify({ storeRoot: '/old', epoch: String(epoch), path: `/old/epoch-${epoch}/store.db` });
      const directory = join(f.root, 'job-locations.v1', 'epochs', createHash('sha256').update(key).digest('hex'));
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'unknown-locations.v1.json'),
        JSON.stringify({ version: 'v1', epochKey: key, reason: 'other', retryScheduled: true }),
      );
    }
    const hinted = vi.fn();
    onHistoricalHydrationHint(f.index, hinted);
    hintHistoricalHydration(f.index, f.jobId);
    const read = vi.spyOn(f.runtime.storage, 'readFileSync');
    for (let poll = 0; poll < 3; poll++) hintHistoricalHydration(f.index, f.jobId);
    expect(read).not.toHaveBeenCalled();
    expect(hinted).toHaveBeenCalledTimes(4);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});
