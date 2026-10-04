import { formatJobDetail } from '#src/cli/format/jobs.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobAddressing } from '#src/jobs/addressing.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { historicalSourceReader, refreshHistoricalEpochs, seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { canonicalWorkDirWireSchema } from '#src/runtime/canonical-work-dir.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';
import type { StoragePort } from '#src/infra/port-types.js';

const fixtures: ReturnType<typeof createTerminalExportFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const f of fixtures.splice(0)) f.close();
});

function fixture(historical = false) {
  const f = createTerminalExportFixture('provider', true);
  fixtures.push(f);
  f.db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  if (historical) {
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
  }
  const detail = (id: string) => {
    const d = f.store.loadJobProjectionDetail(id);
    return d.status
      ? { status: d.status, events: f.store.readJobEvents(id), readiness: deriveLaunchReadiness(d), exit: d.exit }
      : null;
  };
  const owner = f.store.getResultExportOwner();
  const wait = new WaitCoordinator({
    sessionManager: { get: () => null } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    eventBus: f.store.getEventBus(),
    time: f.runtime.time,
    loadJobProjectionDetail: (id) => f.store.loadJobProjectionDetail(id),
    readJobEvents: (id) => f.store.readJobEvents(id),
    aggregateWorkflowUsage: () => undefined,
    subscribeJobEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    getCurrentJournalSeq: () =>
      f.db.prepare<[], { seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()?.seq ?? 0,
    resultJobsRoot: f.runtime.paths.coral.exports.jobsRoot,
    observeResultAvailability: (id) => owner.observeResultAvailability(id),
    hintResultRepair: (id) => owner.hintRepair(id),
    ...{ ensureResultArtifact: (id: string) => f.store.ensureResultArtifact(id) },
  });
  const closure = vi.fn((): 'pending' | 'decided' => 'decided');
  const reader = vi.fn(historicalSourceReader(f.index));
  const addressing = new JobAddressing(
    f.index,
    {
      epochKey: () => (historical ? 'selected-other-epoch' : f.epochKey),
      detail: historical ? () => null : detail,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      readWaitAdmission: (id, epochKey) => wait.readWaitAdmission(id, epochKey),
    },
    () => false,
    closure,
    reader,
    (id) => owner.observeResultAvailability(id),
    (id) => owner.hintRepair(id),
    (id) => owner.progressRetentionExpired(id),
  );
  return { ...f, addressing, closure, reader, detail, owner };
}

type Snapshot = Map<string, { directory: boolean; inode: string; size: string; mtime: string; hash?: string }>;
function snapshot(root: string): Snapshot {
  const result: Snapshot = new Map();
  const visit = (path: string): void => {
    const stat = lstatSync(path, { bigint: true });
    result.set(path, {
      directory: stat.isDirectory(),
      inode: String(stat.ino),
      size: String(stat.size),
      mtime: String(stat.mtimeNs),
      ...(stat.isFile() ? { hash: createHash('sha256').update(readFileSync(path)).digest('hex') } : {}),
    });
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root);
  return result;
}

function coralSnapshot(tree: Snapshot, opened: ReadonlySet<string>): unknown[] {
  return [...tree]
    .filter(([path]) => ![...opened].some((db) => path === `${db}-wal` || path === `${db}-shm`))
    .map(([path, entry]) => {
      if (entry.directory && [...opened].some((db) => dirname(db) === path))
        return [path, { directory: true, inode: entry.inode }];
      return [path, entry];
    });
}

function measure(f: ReturnType<typeof fixture>) {
  const mutations: string[] = [];
  const storage = f.runtime.storage;
  const mutatingStorage: Array<keyof StoragePort> = [
    'writeFileSync',
    'writeSync',
    'writeAtomicSync',
    'writeAtomicDurableSync',
    'tryExclusiveWriteSync',
    'appendFileSync',
    'appendFileDurableSync',
    'appendFileWithCanonicalCheckSync',
    'mkdirSync',
    'renameSync',
    'unlink',
    'unlinkSync',
    'rm',
    'rmSync',
    'rmdirSync',
    'linkSync',
    'fdatasyncSync',
    'syncDirectoryDurable',
    'syncDirectoryDurableSync',
    'chmodSync',
  ];
  for (const name of mutatingStorage) {
    if (typeof storage[name] !== 'function') continue;
    const original = storage[name] as (...args: unknown[]) => unknown;
    vi.spyOn(storage as unknown as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(((
      ...args: unknown[]
    ) => {
      mutations.push(`storage:${name}`);
      return original.apply(storage, args);
    }) as never);
  }
  for (const name of [
    'register',
    'recordObserved',
    'recordTerminal',
    'markUnresolved',
    'certify',
    'holdUnknownLocations',
    'clearUnknownLocations',
    'invalidateTerminalCertificate',
  ] as const) {
    const original = f.index[name] as (...args: never[]) => unknown;
    vi.spyOn(f.index, name).mockImplementation(((...args: never[]) => {
      mutations.push(`index:${name}`);
      return original.apply(f.index, args);
    }) as never);
  }
  const fsync = fs.fsyncSync;
  const fdatasync = fs.fdatasyncSync;
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    mutations.push('node:fsyncSync');
    fsync(fd);
  });
  vi.spyOn(fs, 'fdatasyncSync').mockImplementation((fd) => {
    mutations.push('node:fdatasyncSync');
    fdatasync(fd);
  });
  syncBuiltinESMExports();
  const openFile = storage.openSync.bind(storage);
  vi.spyOn(storage, 'openSync').mockImplementation((path, flags, mode) => {
    if (flags !== 'r') mutations.push(`storage:openSync:${flags}`);
    return openFile(path, flags, mode);
  });
  const opened = new Set<string>();
  const open = storage.openSqliteDatabaseSync.bind(storage);
  vi.spyOn(storage, 'openSqliteDatabaseSync').mockImplementation((path, options) => {
    opened.add(path);
    expect(options?.readOnly).toBe(true);
    return open(path, options);
  });
  const before = snapshot(f.root);
  return () => {
    const after = snapshot(f.root);
    expect(mutations, 'read path called a mutating owner or storage operation').toEqual([]);
    expect(coralSnapshot(after, opened), 'read path changed Coral paths, metadata or bytes').toEqual(
      coralSnapshot(before, opened),
    );
  };
}

async function terminal(stream: AsyncGenerator<WaitStreamEvent>): Promise<WaitStreamEvent | undefined> {
  try {
    for await (const event of stream) if (event.type === 'terminal') return event;
  } finally {
    await stream.return(undefined);
  }
}

describe('Phase D wait read purity (Revision S3)', () => {
  it.each(['scopeCheck', 'detail', 'validateWait', 'waitStream', 'snapshot', 'detailFull'] as const)(
    'admits an unindexed active terminal through %s without registration',
    async (entry) => {
      const f = fixture();
      f.complete();
      rmSync(f.locationPath);
      const check = measure(f);
      if (entry === 'scopeCheck')
        expect(f.addressing.scopeCheck([f.jobId], canonicalWorkDirWireSchema.parse(f.root), 'contains')).toMatchObject({
          valid: [f.jobId],
          missing: [],
        });
      if (entry === 'detailFull') {
        const detail = f.addressing.detail(f.jobId);
        if (detail && 'status' in detail)
          expect(formatJobDetail(detail, undefined, [], true)).toContain('canonical result');
      }
      if (entry === 'snapshot')
        expect(
          f.addressing.snapshot({ jobIds: [f.jobId], supportsWaitV3: true }).jobs[0].terminal?.contentPreview,
        ).toContain('canonical result');
      if (entry === 'detail')
        expect(f.addressing.detail(f.jobId)).toMatchObject({ exit: { content: 'canonical result' } });
      if (entry === 'validateWait')
        expect(f.addressing.validateWait({ jobIds: [f.jobId], supportsWaitV3: true })).toBeNull();
      if (entry === 'waitStream')
        expect(await terminal(f.addressing.waitStream({ jobIds: [f.jobId], supportsWaitV3: true }))).toMatchObject({
          type: 'terminal',
          result: { content: 'canonical result' },
        });
      check();
      expect(f.index.read(f.jobId)).toBeNull();
    },
  );

  it('observes a missing inside-window active artifact and delivers the outcome with repair paused', async () => {
    const f = fixture();
    f.complete();
    expect(existsSync(f.resultPath)).toBe(false);
    const observation = vi.spyOn(f.owner, 'observeResultAvailability');
    const hint = vi.spyOn(f.owner, 'hintRepair');
    const check = measure(f);
    expect(await terminal(f.addressing.waitStream({ jobIds: [f.jobId], supportsWaitV3: true }))).toMatchObject({
      type: 'terminal',
      result: { content: 'canonical result' },
    });
    check();
    expect(observation).toHaveReturnedWith({ kind: 'repair-pending', ageUncertain: false });
    expect(hint).toHaveBeenCalledWith(f.jobId);
    expect(existsSync(f.resultPath)).toBe(false);
  });

  it.each(['scopeCheck', 'detail', 'validateWait', 'waitStream', 'snapshot', 'detailFull'] as const)(
    'reads a historical terminal committed only in WAL through %s without hydration',
    async (entry) => {
      const f = fixture(true);
      f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const mainBefore = readFileSync(f.epoch.path);
      f.store.appendProgress(f.jobId, 'session-1', 'historical WAL progress');
      commitJobTerminal(f.store, f.jobId, 'session-1', {
        content: 'terminal only in WAL',
        outcome: { kind: 'completed' },
        durationMs: 9,
      });
      expect(readFileSync(f.epoch.path)).toEqual(mainBefore);
      expect(readFileSync(`${f.epoch.path}-wal`).length).toBeGreaterThan(0);
      const check = measure(f);
      if (entry === 'scopeCheck')
        expect(
          f.addressing.scopeCheck([f.jobId], canonicalWorkDirWireSchema.parse(f.root), 'contains').missing,
        ).toEqual([]);
      if (entry === 'detailFull') {
        const detail = f.addressing.detail(f.jobId);
        if (detail && 'status' in detail)
          expect(formatJobDetail(detail, undefined, [], true)).toContain('terminal only in WAL');
      }
      if (entry === 'snapshot')
        expect(
          f.addressing.snapshot({ jobIds: [f.jobId], supportsWaitV3: true }).jobs[0].terminal?.contentPreview,
        ).toContain('terminal only in WAL');
      if (entry === 'detail')
        expect(f.addressing.detail(f.jobId)).toMatchObject({
          exit: { content: 'terminal only in WAL' },
          events: [
            expect.objectContaining({ type: 'progress', message: 'historical WAL progress' }),
            expect.objectContaining({ type: 'terminal' }),
          ],
        });
      if (entry === 'validateWait')
        expect(f.addressing.validateWait({ jobIds: [f.jobId], supportsWaitV3: true })).toBeNull();
      if (entry === 'waitStream')
        expect(await terminal(f.addressing.waitStream({ jobIds: [f.jobId], supportsWaitV3: true }))).toMatchObject({
          type: 'terminal',
          result: { content: 'terminal only in WAL', durationMs: 9 },
        });
      check();
      expect(f.index.read(f.jobId)?.disposition).toBe('unresolved');
      expect(existsSync(f.resultPath)).toBe(false);
      if (f.reader.mock.calls.length > 0)
        expect(f.closure.mock.invocationCallOrder[0]).toBeLessThan(f.reader.mock.invocationCallOrder[0]);
    },
  );

  it.each(['missing', 'malformed'] as const)(
    'keeps a decided historical outcome unresolved with a %s guard',
    (guard) => {
      const f = fixture(true);
      const lock = join(f.epochDir, '.lock');
      if (guard === 'missing') rmSync(lock);
      else writeFileSync(lock, 'malformed lock bytes');
      const check = measure(f);
      const detail = f.addressing.detail(f.jobId);
      const unrecoverable = f.addressing.outcomeUnrecoverable([f.jobId]);
      check();
      expect(detail).toMatchObject({ kind: 'unresolved' });
      expect(unrecoverable).toEqual([]);
    },
  );

  it('proves absence only after decided closure and a successful journal read', () => {
    const f = fixture(true);
    const check = measure(f);
    expect(f.addressing.outcomeUnrecoverable([f.jobId])).toEqual([f.jobId]);
    expect(f.addressing.detail(f.jobId)).toMatchObject({ kind: 'outcome-unrecoverable' });
    check();
  });

  it('hydrates and certifies historical terminals only from maintenance', () => {
    const f = fixture(true);
    commitJobTerminal(f.store, f.jobId, 'session-1', {
      content: 'write-owned copy',
      outcome: { kind: 'completed' },
      durationMs: 1,
    });
    expect(f.index.read(f.jobId)?.disposition).toBe('unresolved');
    refreshHistoricalEpochs(f.index);
    expect(f.index.read(f.jobId)?.disposition).toBe('terminal');
    expect(f.index.certificate(f.epochKey)?.jobIds).toContain(f.jobId);
  });

  it('delivers a validated retained outcome after failed publication, expiry, hydration, retirement and restart', async () => {
    const f = fixture(true);
    commitJobTerminal(f.store, f.jobId, 'session-1', {
      content: 'never exported',
      outcome: { kind: 'completed' },
      durationMs: 1,
    });
    const write = f.runtime.storage.writeAtomicDurableSync.bind(f.runtime.storage);
    vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, content, options) => {
      if (path === f.resultPath) throw new Error('publication always fails');
      return write(path, content, options);
    });
    refreshHistoricalEpochs(f.index);
    expect(f.index.read(f.jobId)?.disposition).toBe('terminal');
    expect(existsSync(f.resultPath)).toBe(false);
    f.advance(15 * 86_400_000);
    refreshHistoricalEpochs(f.index);
    expect(f.index.resultsReleased(f.epochKey)).toBe(true);
    f.removeSource();
    const restarted = new JobLocationIndex(f.runtime, f.root);
    const addressing = new JobAddressing(
      restarted.readOnlyView(),
      {
        epochKey: () => 'next-epoch',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      undefined,
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
    );
    const check = measure(f);
    expect(addressing.detail(f.jobId)).toMatchObject({ exit: { content: 'never exported' } });
    expect(await terminal(addressing.waitStream({ jobIds: [f.jobId], supportsWaitV3: true }))).toMatchObject({
      type: 'terminal',
      result: { content: 'never exported' },
    });
    expect(f.owner.observeResultAvailability(f.jobId)).toMatchObject({ kind: 'retained-away' });
    check();
    const raw = JSON.parse(readFileSync(f.locationPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(f.locationPath, JSON.stringify({ ...raw, detail: undefined }));
    expect(addressing.detail(f.jobId)).toMatchObject({ kind: 'unresolved' });
    expect(restarted.resultsReleased(f.epochKey)).toBe(false);
  });

  it.each([false, true])('observes unknown-location holds without inline retry, scheduled=%s', (retryScheduled) => {
    const f = fixture(true);
    f.index.holdUnknownLocations(
      f.epochKey,
      retryScheduled ? 'recovery retry pending' : 'retained-store-root-missing',
      retryScheduled,
    );
    const check = measure(f);
    expect(f.addressing.scopeCheck(['typo'], canonicalWorkDirWireSchema.parse(f.root), 'contains').missing).toEqual([
      'typo',
    ]);
    expect(f.addressing.detail('typo')).toBeNull();
    expect(f.addressing.validateWait({ jobIds: ['typo'], supportsWaitV3: true })).toBeNull();
    const disposition = f.addressing.unknownJobDisposition();
    const caveat = f.addressing.unknownJobCaveat();
    check();
    expect(disposition).toBe(retryScheduled ? 'discovery-unknown' : 'not-found');
    expect(caveat).toContain(f.epochKey);
  });

  it('keeps pending closure and source identity uncertainty unresolved', () => {
    const f = fixture(true);
    f.closure.mockReturnValue('pending');
    const check = measure(f);
    expect(f.addressing.outcomeUnrecoverable([f.jobId])).toEqual([]);
    check();
    f.closure.mockReturnValue('decided');
    const marker = join(f.epochDir, '.coral-lineage.v1.json');
    writeFileSync(marker, JSON.stringify({ version: 'v1', lineageId: '00000000-0000-4000-8000-000000000000' }));
    const identityCheck = measure(f);
    expect(f.addressing.detail(f.jobId)).toMatchObject({ kind: 'unresolved' });
    identityCheck();
  });

  it('admits an active KB job on an epoch-less store without writing a location', () => {
    const f = fixture();
    const detail = f.detail(f.jobId);
    if (!detail) throw new Error('Fixture job detail missing');
    const kb = { ...detail, status: { ...detail.status, jobKind: 'kb' as const, workDir: null } };
    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        epochKey: () => null,
        detail: () => kb,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
    );
    rmSync(f.locationPath);
    const check = measure(f);
    expect(addressing.scopeCheck([f.jobId], canonicalWorkDirWireSchema.parse(f.root), 'contains').missing).toEqual([]);
    expect(addressing.detail(f.jobId)).toMatchObject({ status: { jobKind: 'kb' } });
    expect(addressing.validateWait({ jobIds: [f.jobId], supportsWaitV3: true })).toBeNull();
    check();
  });

  it('passes only a read-only location surface to addressing', () => {
    const f = fixture();
    expect(Object.keys(f.index.readOnlyView()).sort()).toEqual([
      'historicalSourceState',
      'read',
      'readHistorical',
      'resultPathFor',
      'time',
      'unknownLocationHolds',
    ]);
  });
});
