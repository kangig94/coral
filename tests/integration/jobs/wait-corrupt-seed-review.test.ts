import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import {
  seedHistoricalEpoch,
  retryUnknownHistoricalEpochs,
  readHistoricalSource,
} from '#src/jobs/historical-reader.js';
import { WaitSession } from '#src/jobs/wait/session.js';

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
          waitStream: async function* () {},
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
        waitStream: async function* () {},
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
