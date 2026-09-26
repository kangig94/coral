import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newRawDatabase } from '../../helpers/test-db.js';

import { JobLocationIndex } from '../../../src/jobs/location-index.js';
import { JobAddressing } from '../../../src/jobs/addressing.js';
import { refreshHistoricalEpoch, seedHistoricalEpoch } from '../../../src/jobs/historical-reader.js';
import { readOrCreateEpochKey } from '../../../src/store/epoch-key.js';
import { protectStoreEpoch } from '../../../src/store/epoch-protection.js';
import { createRealRuntime } from '../../../src/runtime/real.js';

const fingerprints = [
  'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52',
  'sha256:9fd970cdcb803f517d77b133bba86ae83ef1ff662f77da8656604f32c8e67980',
  'sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521',
];
const directories: string[] = [];
const runtime = createRealRuntime('prod', { baseDir: tmpdir() });
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
  return { root, epochDir, db };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('historical job readers', () => {
  it('reads a retained epoch with a WAL sidecar under its shared lock', () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
    db.exec(
      "PRAGMA journal_mode=WAL; INSERT INTO events VALUES (1, '2026-09-25T00:00:00.000Z', 'test', 'job', 'job-1', '{}')",
    );
    expect(existsSync(join(epochDir, 'store.db-wal'))).toBe(true);
    const result = seedHistoricalEpoch(
      runtime,
      new JobLocationIndex(runtime, root),
      { storeRoot: join(root, 'db'), epoch: '7', path: join(epochDir, 'store.db') },
      'lineage:7',
      fingerprints[0],
      join(root, 'results'),
      storage,
    );
    expect(result.kind).toBe('uncertified');
    db.close();
  });

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

  for (const fingerprint of fingerprints) {
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

  it('keeps a retired epoch certified when a later refresh cannot read its store', () => {
    const { root, epochDir, db } = fixture(fingerprints[0]);
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
      [],
      true,
    );
    expect(result.kind).toBe('complete');
    writeFileSync(join(epochDir, 'store.db'), 'not a sqlite database');

    refreshHistoricalEpoch(index, 'lineage-old:7', ['any-job']);

    expect(index.certificate('lineage-old:7')).not.toBeNull();
    expect(index.resultsReleased('lineage-old:7')).toBe(true);
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
        waitStream: async function* () {},
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
