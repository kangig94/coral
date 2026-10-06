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
  expect(job.disposition).toBe('discovery-unknown');
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
    () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
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
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
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
    const cursor: WaitCursor = savedCursor({ old: 0 }, 'lineage-old:7');
    expect(addressing.detail('old')).toMatchObject({ epochKey: 'lineage-old:7' });
    expect(addressing.validateWait({ jobIds: ['old'], cursor })).toBeNull();
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
    disposition: 'discovery-unknown',
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
    () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
  );
  const snapshot = addressing.snapshot({ jobIds: ['never-accepted'] });
  expect(snapshot.jobs[0].disposition).toBe('admitted');
  expect(snapshot.remainingJobIds).toEqual(['never-accepted']);
  expect(snapshot.exitCode).toBe(75);
  index.retireNeverAccepted('never-accepted', 'active');
  expect(addressing.snapshot({ jobIds: ['never-accepted'] })).toMatchObject({ remainingJobIds: [], exitCode: 1 });
});

it('keeps an unreadable historical progress backlog pending and recovers it on the continuation', () => {
  const { index } = fixture();
  const jobId = 'historical';
  const epochKey = 'old';
  index.register(jobId, epochKey, {
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    jobKind: 'provider',
  });
  const retained = detail(jobId, 'completed');
  index.recordTerminal(jobId, retained, '/result', 12);
  let readable = false;
  const addressing = new JobAddressing(
    {
      ...index.readOnlyView(),
      visitProgress: progressVisitFromDetails(() => ({
        ...retained,
        events: [
          {
            type: 'progress',
            jobId,
            sessionId: null,
            seq: 3,
            ts: '',
            message: 'unread backlog',
            timing: { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 },
          },
        ],
      })),
    },
    {
      visitProgress: progressVisitFromDetails(() => null),
      epochKey: () => 'active',
      detail: () => null,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'decided',
    () => {
      if (!readable) return { kind: 'unreadable', disposition: 'transient-unknown' };
      const location = index.read(jobId);
      if (!location) throw new Error('missing fixture location');
      const progress = {
        type: 'progress' as const,
        jobId,
        sessionId: 'session-1',
        seq: 3,
        ts: retained.status.updatedAt,
        message: 'unread backlog',
        timing: {
          origin: 'runtime' as const,
          originAt: retained.status.updatedAt,
          emittedAt: retained.status.updatedAt,
          elapsedMs: 0,
        },
      };
      return {
        kind: 'read',
        dispositions: new Map([[jobId, 'readable']]),
        locations: new Map([
          [
            jobId,
            {
              ...location,
              detail: { kind: 'recorded', value: { ...retained, epochKey, events: [progress, ...retained.events] } },
            },
          ],
        ]),
      };
    },
    () => ({ kind: 'available', resultPath: '/result' }),
  );
  const first = addressing.snapshot({ jobIds: [jobId] });
  expect(first.remainingJobIds).toEqual([jobId]);
  expect(first.notices.join('\n')).toContain('Earlier progress for historical is held');
  readable = true;
  const second = addressing.snapshot({ jobIds: [jobId], cursor: first.cursor });
  expect(second.jobs[0].progress).toEqual(['unread backlog']);
  expect(second.jobs[0].terminal).toBeUndefined();
  expect(second.remainingJobIds).toEqual([]);
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
    expect(addressing.validateWait(request)).toBeNull();
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
  expect(addressing.admitWait(request)[0]).toMatchObject({
    disposition: 'outcome-unreadable',
    epochKey: 'previous',
    sourceRead: 'settled-unreadable',
  });
  expect(historicalReads).toEqual(['previous']);
});

it.each(['readable', 'transient-unknown', 'settled-unreadable', 'retired'] as const)(
  'carries %s through historical admission, remaining work and snapshot with an epoch sibling',
  (sourceRead) => {
    const { root, index } = fixture();
    for (const id of ['A', 'U']) {
      index.register(id, 'historical', {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
      const retained = detail(id, 'completed');
      index.recordTerminal(id, retained, join(root, `${id}.md`), 12);
    }
    const a = index.read('A');
    const u = index.read('U');
    if (!a || !u) throw new Error('missing fixture');
    const observedA =
      a.detail.kind === 'recorded'
        ? {
            ...a,
            detail: {
              kind: 'recorded' as const,
              value: {
                ...a.detail.value,
                events: [
                  {
                    type: 'progress' as const,
                    jobId: 'A',
                    sessionId: null,
                    seq: 10,
                    ts: '',
                    message: 'sibling backlog',
                    timing: { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 },
                  },
                  ...a.detail.value.events,
                ],
              },
            },
          }
        : a;
    const addressing = new JobAddressing(
      {
        ...index.readOnlyView(),
        visitProgress: progressVisitFromDetails((id) => {
          const location = id === 'A' ? observedA : u;
          return location.detail.kind === 'recorded' ? location.detail.value : null;
        }),
      },
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'current',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      () => ({
        kind: 'read',
        locations: new Map([
          ['A', observedA],
          ['U', u],
        ]),
        dispositions: new Map([
          ['A', 'readable'],
          ['U', sourceRead],
        ]),
      }),
      (id) => ({ kind: 'available', resultPath: join(root, `${id}.md`) }),
      undefined,
      () => sourceRead === 'retired',
    );
    const admissions = addressing.admitWait({ jobIds: ['A', 'U'] });
    expect(admissions[1].sourceRead).toBe(sourceRead);
    const snapshot = addressing.snapshot({ jobIds: ['A', 'U'] });
    expect(snapshot.remainingJobIds).toEqual(sourceRead === 'transient-unknown' ? ['U'] : []);
    expect(snapshot.jobs[0].progress).toEqual(['sibling backlog']);
    if (sourceRead === 'transient-unknown') {
      expect(snapshot.notices.join(' ')).toContain('Earlier progress for U is held');
      expect(snapshot.notices.join(' ')).toContain('Snapshots return immediately with a continuation');
    }
    if (sourceRead === 'settled-unreadable') {
      expect(snapshot.notices.join(' ')).toContain('cannot be read by this build');
      expect(snapshot.notices.join(' ')).not.toContain('no longer kept');
    }
    if (sourceRead === 'retired') expect(snapshot.notices.join(' ')).toContain('no longer kept');
  },
);

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
    () => ({ kind: 'repair-pending', ageUncertain: true }),
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
      () => ({ kind: 'repair-pending', ageUncertain: true }),
    );
    expect(addressing.admitWait({ jobIds: ['U'] })).toMatchObject([{ disposition: 'outcome-unreadable' }]);
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
  expect(admissions).toMatchObject([{ disposition: 'admitted' }, { disposition: 'discovery-unreadable' }]);
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
import { ACKNOWLEDGED_FLAG, waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';

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
        jobs: ids.map((id) => ({
          hash: waitJobHash(id),
          epoch: waitEpochToken('epoch-E'),
          seq: 100_000,
          lineOffset: 0,
          flags: ACKNOWLEDGED_FLAG,
        })),
      }
    : undefined;
  const request = { jobIds, timeoutSeconds: 0, cursor };
  const admissions = addressing.admitWait(request);
  const events: WaitStreamEvent[] = [];
  for await (const event of addressing.waitStream({ ...request, admissions })) events.push(event);
  expect(events.filter((e) => e.type === 'disposition' && e.disposition === 'discovery-unknown')).toEqual([]);
  expect(events.filter((e) => e.type === 'notice' && e.message.includes('held'))).toEqual([]);
  if (terminal) expect(events.at(-1)).toMatchObject({ type: 'waiting', exitCode: 1, cursor: { jobs: [] } });
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
    () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
  );
  addressing.admitWait({ jobIds: ['u1', 'u2', 'u3', 'u4'] });
  expect(reads.map((read) => read.epochKey).sort()).toEqual(['held-1', 'held-2', 'held-3']);
  expect(reads.every((read) => read.session !== undefined)).toBe(true);
});
