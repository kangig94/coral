import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { retryUnknownHistoricalEpochs } from '#src/jobs/historical-reader.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { afterEach, describe, expect, it } from 'vitest';

import { JobAddressing } from '../../../src/jobs/addressing.js';
import { createRealRuntime } from '../../../src/runtime/real.js';
import { JobLocationIndex } from '../../../src/jobs/location-index.js';

import type { WaitCursor, WaitStreamEvent } from '../../../src/jobs/wait/contract.js';
import { savedCursor } from '#tests/helpers/wait-session.js';
import { nextDelivered, nextFinal } from '#tests/helpers/wait-stream.js';
import { canonicalWorkDirWireSchema } from '../../../src/runtime/canonical-work-dir.js';
import type { JobDetailResponse } from '../../../src/jobs/records.js';
import { StoreCodecError } from '#src/store/body-codec.js';

const directories: string[] = [];
const runtime = createRealRuntime('prod', { baseDir: tmpdir() });

function fixture(): { root: string; index: JobLocationIndex } {
  const root = mkdtempSync(join(tmpdir(), 'coral-job-addressing-'));
  directories.push(root);
  return { root, index: new JobLocationIndex(runtime, root) };
}

function detail(jobId: string, phase: 'running' | 'completed', seq = 12): JobDetailResponse {
  const result = { content: `${jobId} result`, outcome: { kind: 'completed' as const }, durationMs: 10 };
  const status = {
    jobId,
    owner: { kind: 'provider-session' as const, id: 'session-1' },
    sessionId: 'session-1',
    provider: 'claude',
    projectRoot: '/workspace/project',
    workDir: canonicalWorkDirWireSchema.parse('/workspace/project'),
    backendNamespace: 'test-namespace',
    jobKind: 'provider' as const,
    phase,
    updatedAt: '2026-09-25T00:00:00.000Z',
    lastSeq: seq,
    ...(phase === 'completed' ? { result } : {}),
  };
  return {
    status,
    events:
      phase === 'completed'
        ? [
            {
              type: 'terminal',
              jobId,
              sessionId: 'session-1',
              seq,
              ts: '2026-09-25T00:00:00.000Z',
              result,
            },
          ]
        : [],
    readiness: 'ready',
    exit:
      phase === 'completed'
        ? {
            ...result,
            diagnostics: { progressFaults: [] },
            endTime: '2026-09-25T00:00:00.000Z',
          }
        : null,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('describes unreadable addresses without exposing storage paths or raw errors', () => {
  const { index } = fixture();
  const failure = new Error('EACCES: /secret/job-locations.v1/jobs/record.json');
  index.read = () => {
    throw failure;
  };
  const job = historicalAddressing(index).admitWait({ jobIds: ['job'] })[0];
  expect(job.disposition).toBe('unknown');
  expect(job.message).toContain('250 ms, 1 s and 5 s');
  expect(job.message).not.toContain('/secret');
  expect(job.message).not.toContain('EACCES');
});

it('uses a short epoch label for a settled historical source', () => {
  const { index } = fixture();
  const key = JSON.stringify({
    storeRoot: '/secret/db',
    epoch: '7',
    path: '/secret/db/epoch-7/store.db',
    lineageKey: 'old:7',
  });
  index.register('job', key, { projectRoot: '/workspace/project', workDir: '/workspace/project', jobKind: 'provider' });
  const addressing = new JobAddressing(
    index.readOnlyView(),
    {
      visitProgress: progressVisitFromDetails(() => null),
      epochKey: () => 'new:8',
      detail: () => null,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'pending',
    () => ({ kind: 'unreadable', disposition: 'settled-unreadable' }),
    () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
  );
  const job = addressing.admitWait({ jobIds: ['job'] })[0];
  expect(job.message).toMatch(/^Epoch [0-9a-f]{8}:/);
  expect(job.message).toContain('next coordinator start');
  expect(job.message).not.toContain('/secret');
});

it.each([false, true])('gives persisted machine hold reasons an owner and retry bound, retry=%s', (retry) => {
  const { index } = fixture();
  index.holdUnknownLocations('old:7', 'retained-store-root-missing', retry);
  const text = historicalAddressing(index).unknownJobCaveat();
  expect(text).toMatch(/epoch [0-9a-f]{8}:/);
  expect(text).toContain('Epoch maintenance');
  expect(text).toContain(retry ? '3 consecutive failures' : 'next coordinator start');
  expect(text).not.toContain('retained-store-root-missing');
});

it.each([
  'retained-store-root-missing',
  'Error: EACCES reading /secret/epoch-7/store.db',
  '{"storeRoot":"/secret/db","epoch":"7"}',
  'EACCES: identity unreadable',
])('normalizes persisted historical reasons for known jobs: %s', (reason) => {
  const { index } = fixture();
  index.register('known', 'old:7', { projectRoot: '/workspace', workDir: '/workspace', jobKind: 'provider' });
  for (const disposition of ['transient-unknown', 'settled-unreadable'] as const) {
    const addressing = new JobAddressing(
      index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      () => ({ kind: 'unreadable', disposition, reason }),
      () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
    );
    const job = addressing.admitWait({ jobIds: ['known'] })[0];
    expect(job.message).toContain('Epoch maintenance');
    expect(job.message).toContain(
      disposition === 'transient-unknown' ? '3 consecutive failures' : 'next coordinator start',
    );
    expect(job.message).not.toContain(reason);
    expect(job.message).not.toContain('/secret');
    expect(job.message).not.toContain('EACCES');
  }
});

function historicalAddressing(index: JobLocationIndex): JobAddressing {
  return new JobAddressing(
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
    (jobId) => ({ kind: 'available', resultPath: index.resultPathFor(jobId) }),
  );
}

describe('job addressing', () => {
  it('keeps a historical terminal cursor readable after rebind', async () => {
    const { root, index } = fixture();
    const resultPath = join(root, 'old.md');
    writeFileSync(resultPath, 'old result\n');
    index.register('old', 'lineage-old:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.recordTerminal('old', detail('old', 'completed'), resultPath, 12);
    const addressing = historicalAddressing(index);
    const cursor: WaitCursor = savedCursor({ old: 0 });
    expect(addressing.detail('old')).toMatchObject({ epochKey: 'lineage-old:7' });
    const stream = addressing.waitStream({ jobIds: ['old'], cursor });
    expect((await nextFinal(stream)).value).toMatchObject({
      type: 'terminal',
      jobId: 'old',
      epochKey: 'lineage-old:7',
      seq: 12,
    });
    await stream.return(undefined);
  });

  it('should not overwrite a terminal another process records while an unresolved mark waits for the lock', () => {
    const { root, index } = fixture();
    const other = new JobLocationIndex(runtime, root);
    index.register('racing', 'lineage-old:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const locked = index as unknown as { withRevisionLock: (key: string, action: () => unknown) => unknown };
    const acquire = locked.withRevisionLock.bind(index);
    locked.withRevisionLock = (key, action) => {
      other.recordTerminal('racing', detail('racing', 'completed'), join(root, 'racing.md'), 12);
      return acquire(key, action);
    };

    index.markUnresolved('racing');

    expect(other.read('racing')).toMatchObject({ disposition: 'terminal', terminalSeq: 12 });
  });
});

it.each([0, -3_600_000, 3_600_000])('bounds historical waiting across a %s ms wall step', async (step) => {
  const root = mkdtempSync(join(tmpdir(), 'coral-addressing-clock-'));
  directories.push(root);
  const time = new VirtualTime();
  const wall = time.now.bind(time);
  let offset = 0;
  Object.assign(time, { now: () => wall() + offset });
  const index = new JobLocationIndex({ ...runtime, time }, root);
  index.register('old', 'lineage-old:7', {
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    jobKind: 'provider',
  });
  index.holdUnknownLocations('lineage-old:7', 'temporary source read failure', true);
  const iterator = historicalAddressing(index).waitStream({ jobIds: ['old'], timeoutSeconds: 1 });
  const result = nextFinal(iterator);
  await flushMicrotasks();
  offset = step;
  for (let tick = 0; tick < 5; tick++) {
    time.tick(250);
    await flushMicrotasks(10);
  }
  await expect(result).resolves.toMatchObject({ done: false, value: { type: 'waiting' } });
  await iterator.return(undefined);
});

it('keeps retryable unknown IDs in a direct continuation and re-admits them after write-owned recovery', async () => {
  const { index } = fixture();
  index.holdUnknownLocations('recovering', 'recovery pending', true);
  const addressing = historicalAddressing(index);
  const waiting = addressing.waitStream({ jobIds: ['unknown'], timeoutSeconds: 0 });
  expect((await nextDelivered(waiting)).value).toMatchObject({
    type: 'disposition',
    jobId: 'unknown',
    disposition: 'unknown',
  });
  expect((await nextFinal(waiting)).value).toMatchObject({ type: 'waiting', waitingJobIds: ['unknown'] });
  await waiting.return(undefined);
  index.register('unknown', 'lineage-old:7', {
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    jobKind: 'provider',
  });
  index.recordTerminal('unknown', detail('unknown', 'completed'), index.resultPathFor('unknown'), 12);
  index.clearUnknownLocations('recovering');
  const admitted = addressing.waitStream({ jobIds: ['unknown'] });
  expect((await nextFinal(admitted)).value).toMatchObject({ type: 'terminal', jobId: 'unknown' });
  await admitted.return(undefined);
});

it('holds an unaccepted active launch until write-owned recovery observes its explicit absence', () => {
  const { index } = fixture();
  index.register('never-accepted', 'active', {
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    jobKind: 'provider',
  });
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
    () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
  );
  const snapshot = addressing.snapshot({ jobIds: ['never-accepted'] });
  expect(snapshot.jobs[0].disposition).toBe('unknown');
  expect(snapshot.remainingJobIds).toEqual(['never-accepted']);
  expect(snapshot.exitCode).toBe(75);
  index.retireNeverAccepted('never-accepted', 'active');
  expect(addressing.snapshot({ jobIds: ['never-accepted'] })).toMatchObject({ remainingJobIds: [], exitCode: 1 });
});

it.each([false, true])(
  'pins the admitted active epoch when its accessor becomes temporarily unobservable mid-wait, indexed: %s',
  (indexed) => {
    const { index } = fixture();
    if (indexed)
      index.register('known', 'active', {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
    let epoch: string | null = 'active';
    const addressing = new JobAddressing(
      index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => detail('known', 'running')),
        epochKey: () => epoch,
        detail: () => detail('known', 'running'),
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'available', resultPath: '/result' }),
    );
    const request = { jobIds: ['known'] };
    expect(addressing.admitWait(request)[0]).toMatchObject({ disposition: 'admitted', epochKey: 'active' });
    epoch = null;
    expect(addressing.admitWait(request)[0]).toMatchObject({
      disposition: 'admitted',
      epochKey: 'active',
      detail: { status: { phase: 'running' } },
    });
  },
);

it('reclassifies the previous active epoch after a proven selection change within one wait', () => {
  const { index } = fixture();
  index.register('known', 'previous', {
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    jobKind: 'provider',
  });
  let epoch = 'previous';
  const historicalReads: string[] = [];
  const addressing = new JobAddressing(
    index.readOnlyView(),
    {
      visitProgress: progressVisitFromDetails(() => detail('known', 'running')),
      epochKey: () => epoch,
      detail: () => detail('known', 'running'),
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'pending',
    (epochKey) => {
      historicalReads.push(epochKey);
      return { kind: 'unreadable', disposition: 'settled-unreadable', reason: 'Source owner settled the read' };
    },
    () => ({ kind: 'available', resultPath: '/result' }),
  );
  const request = { jobIds: ['known'] };
  expect(addressing.admitWait(request)[0]).toMatchObject({ disposition: 'admitted', epochKey: 'previous' });
  expect(historicalReads).toEqual([]);
  epoch = 'successor';
  expect(addressing.admitWait(request)[0]).toMatchObject({ disposition: 'unreadable' });
  expect(historicalReads).toEqual(['previous']);
});

it('historical maintenance never settles an active recovery hold', () => {
  const { index } = fixture();
  const key = 'active';
  index.holdUnknownLocations(key, 'database is locked', true);
  const before = index.unknownLocationHolds();
  const addressing = new JobAddressing(
    index.readOnlyView(),
    {
      visitProgress: progressVisitFromDetails(() => null),
      epochKey: () => key,
      detail: () => null,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'pending',
    undefined,
    () => ({ kind: 'pending' }),
  );
  for (let i = 0; i < 50; i++) retryUnknownHistoricalEpochs(index);
  expect(index.unknownLocationHolds()).toEqual(before);
  expect(addressing.unknownJobDisposition()).toBe('not-found');
  expect(addressing.unknownJobCaveat()).toBe('');
});

it.each(['pending', 'decided'] as const)(
  'settled source with %s closure agrees across wait, detail and abort',
  (closure) => {
    const { index } = fixture();
    index.register('U', 'old', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
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
      () => closure,
      () => ({ kind: 'unreadable', disposition: 'settled-unreadable', reason: 'bounded attempts exhausted' }),
      () => ({ kind: 'pending' }),
    );
    expect(addressing.admitWait({ jobIds: ['U'] })).toMatchObject([{ disposition: 'unreadable' }]);
    expect(addressing.detail('U')).toMatchObject({ kind: 'outcome-unreadable' });
    const snapshot = addressing.snapshot({ jobIds: ['U'] });
    expect(snapshot.exitCode).toBe(1);
    expect(snapshot.remainingJobIds).toEqual([]);
    expect(addressing.abort(['U'])).toMatchObject({ kind: 'answered', result: { refused: [{ jobId: 'U' }] } });
  },
);

it('isolates a schema-incompatible location from readable siblings', () => {
  const { root, index } = fixture();
  index.register('bad', 'old', {
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    jobKind: 'provider',
  });
  const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from('bad').toString('base64url')}.json`);
  const raw = JSON.parse(runtime.storage.readFileSync(path, 'utf-8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...raw, version: 'future' }));
  const addressing = new JobAddressing(
    index,
    {
      visitProgress: progressVisitFromDetails((id) => (id === 'good' ? detail('good', 'completed') : null)),
      epochKey: () => 'active',
      detail: (id) => (id === 'good' ? detail('good', 'completed') : null),
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'pending',
    undefined,
    () => ({ kind: 'available', resultPath: '/r.md' }),
  );
  const admissions = addressing.admitWait({ jobIds: ['good', 'bad'] });
  expect(admissions).toMatchObject([{ disposition: 'admitted' }, { disposition: 'unreadable' }]);
  expect(addressing.snapshot({ jobIds: ['good', 'bad'] })).toMatchObject({ exitCode: 1, remainingJobIds: [] });
});

it.each([true, false])('abort shares unknown discovery classification when retryScheduled=%s', (retryScheduled) => {
  const { index } = fixture();
  index.holdUnknownLocations('historical', 'source cannot be observed', retryScheduled);
  const addressing = historicalAddressing(index);
  expect(addressing.unknownJobCaveat()).toMatch(retryScheduled ? /^Retry scheduled for epoch/ : /^Unreadable epoch/);
  expect(addressing.abort(['typo'])).toMatchObject({
    kind: 'answered',
    result: { notFound: [], [retryScheduled ? 'held' : 'refused']: [{ jobId: 'typo' }] },
  });
});

import { admitted } from '#tests/helpers/wait-session.js';
import { waitJobHash } from '#src/jobs/wait/cursor.js';

it.each([false, true])('first poll observes every member without false holds, terminal=%s', async (terminal) => {
  const { index } = fixture();
  const ids = Array.from({ length: terminal ? 79 : 100 }, (_, i) => `job-${i}`);
  const jobs = new Map(
    ids.map((id, j) => [
      id,
      admitted(
        id,
        Array.from({ length: 30 }, (_, k) => [k * 1000 + j + 1, `line-${k}`]),
        terminal,
      ),
    ]),
  );
  const addressing = new JobAddressing(
    index.readOnlyView(),
    {
      visitProgress: progressVisitFromDetails((id) => jobs.get(id)?.detail ?? null),
      epochKey: () => 'epoch-E',
      detail: (id) => jobs.get(id)?.detail ?? null,
      readWaitAdmissions: (members) => members.map((id) => jobs.get(id)!),
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'decided',
    undefined,
    () => ({ kind: 'available', resultPath: '/r/x' }),
  );
  const jobIds = terminal ? [...ids.slice(0, 50), 'typo', ...ids.slice(50)] : ids;
  const cursor: WaitCursor | undefined = terminal
    ? {
        jobs: ids.map((id) => ({ hash: waitJobHash(id), seq: 100_000 })),
      }
    : undefined;
  const request = { jobIds, timeoutSeconds: 0, cursor };
  const admissions = addressing.admitWait(request);
  const events: WaitStreamEvent[] = [];
  for await (const event of addressing.waitStream({ ...request, admissions })) events.push(event);
  expect(events.filter((e) => e.type === 'disposition' && e.disposition === 'unknown')).toEqual([]);
  expect(events.filter((e) => e.type === 'notice' && e.message.includes('held'))).toEqual([]);
  if (terminal)
    expect(events.at(-1)).toMatchObject({ type: 'terminal', remainingJobIds: [], exitCode: 1, cursor: { jobs: [] } });
  else {
    const progress = events.filter((e) => e.type === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((e) => Number(e.message.slice(5)) >= 25)).toBe(true);
  }
});

it('resolves unknown IDs through one session read per held epoch, never an uncached scan per ID', () => {
  const { index } = fixture();
  for (const epoch of ['held-1', 'held-2', 'held-3']) index.holdUnknownLocations(epoch, 'recovery pending', true);
  const reads: Array<{ epochKey: string; session: object | undefined }> = [];
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
    (epochKey, _jobIds, session) => {
      reads.push({ epochKey, session });
      return { kind: 'read', locations: new Map(), dispositions: new Map() };
    },
    () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
  );
  addressing.admitWait({ jobIds: ['u1', 'u2', 'u3', 'u4'] });
  expect(reads.map((read) => read.epochKey).sort()).toEqual(['held-1', 'held-2', 'held-3']);
  expect(reads.every((read) => read.session !== undefined)).toBe(true);
});

it('keeps an active job whose detail read fails from failing its siblings, and propagates a code defect', () => {
  const { index } = fixture();
  for (const jobId of ['busy', 'undecodable', 'healthy', 'defect'])
    index.register(jobId, 'active:1', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
  const addressing = new JobAddressing(
    index.readOnlyView(),
    {
      visitProgress: progressVisitFromDetails(() => null),
      epochKey: () => 'active:1',
      detail: (jobId) => {
        if (jobId === 'busy') throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        if (jobId === 'undecodable') throw new StoreCodecError('Current codec rejected stored event', {});
        if (jobId === 'defect') throw new TypeError('defect');
        return detail(jobId, 'running');
      },
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'pending',
    undefined,
    () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
  );
  expect(addressing.admitWait({ jobIds: ['busy', 'undecodable', 'healthy'] })).toMatchObject([
    { jobId: 'busy', disposition: 'unknown' },
    { jobId: 'undecodable', disposition: 'unreadable' },
    { jobId: 'healthy', disposition: 'admitted' },
  ]);
  expect(() => addressing.admitWait({ jobIds: ['defect', 'healthy'] })).toThrow(TypeError);
});

it('propagates a code defect from a location read instead of reporting discovery uncertainty', () => {
  const { index } = fixture();
  index.read = () => {
    throw new TypeError('defect');
  };
  expect(() => historicalAddressing(index).admitWait({ jobIds: ['job'] })).toThrow(TypeError);
});
