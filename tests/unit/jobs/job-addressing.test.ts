import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { afterEach, describe, expect, it } from 'vitest';

import { JobAddressing } from '../../../src/jobs/addressing.js';
import { createRealRuntime } from '../../../src/runtime/real.js';
import { JobLocationIndex } from '../../../src/jobs/location-index.js';

import type { WaitCursor } from '../../../src/jobs/wait/contract.js';
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

function historicalAddressing(index: JobLocationIndex): JobAddressing {
  return new JobAddressing(
    index,
    {
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
    const cursor: WaitCursor = {
      version: 'jobs.wait.v2',
      locations: { old: 'lineage-old:7' },
      positions: { 'lineage-old:7': 0 },
    };
    expect(addressing.detail('old')).toMatchObject({ epochKey: 'lineage-old:7' });
    expect(addressing.validateWait({ jobIds: ['old'], cursor, supportsWaitV2: true })).toBeNull();
    const stream = addressing.waitStream({ jobIds: ['old'], cursor, supportsWaitV2: true });
    expect((await stream.next()).value).toMatchObject({
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
  const iterator = historicalAddressing(index).waitStream({ jobIds: ['old'], timeoutSeconds: 1, supportsWaitV2: true });
  const result = iterator.next();
  await flushMicrotasks();
  offset = step;
  for (let tick = 0; tick < 5; tick++) {
    time.tick(250);
    await flushMicrotasks(10);
  }
  await expect(result).resolves.toMatchObject({ done: false, value: { type: 'waiting' } });
  await iterator.return(undefined);
});

it.each([false, true])('refuses a partially missing legacy batch at admission, v2=%s', async (supportsWaitV2) => {
  const { index } = fixture();
  index.register('known', 'lineage-new:8', {
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    jobKind: 'provider',
  });
  const seen: string[][] = [];
  const addressing = new JobAddressing(
    index,
    {
      epochKey: () => 'lineage-new:8',
      detail: (id) => (id === 'known' ? detail(id, 'running') : null),
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'pending',
    undefined,
    () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
  );
  const request = { jobIds: ['known', 'ghost'], supportsWaitV2, timeoutSeconds: 0 };
  expect(addressing.validateWait(request)).toMatchObject({
    code: 'jobs_not_found',
    message: expect.stringContaining('ghost'),
  });
  await expect(addressing.waitStream(request).next()).rejects.toMatchObject({ code: 'jobs_not_found' });
  expect(seen).toEqual([]);
});

it('rejects an unsupported generation before reading structural cursor fields', () => {
  const { index } = fixture();
  expect(
    historicalAddressing(index).validateWait({
      jobIds: ['ghost'],
      cursor: { version: 'unknown', afterSeq: 0 } as never,
    }),
  ).toMatchObject({ code: 'wait_cursor_unsupported' });
});

it('keeps retryable unknown IDs in a direct continuation and re-admits them after write-owned recovery', async () => {
  const { index } = fixture();
  index.holdUnknownLocations('recovering', 'recovery pending', true);
  const addressing = historicalAddressing(index);
  const waiting = addressing.waitStream({ jobIds: ['unknown'], supportsWaitV3: true, timeoutSeconds: 0 });
  expect((await waiting.next()).value).toMatchObject({
    type: 'disposition',
    jobId: 'unknown',
    disposition: 'discovery-unknown',
  });
  expect((await waiting.next()).value).toMatchObject({ type: 'waiting', waitingJobIds: ['unknown'] });
  await waiting.return(undefined);
  index.register('unknown', 'lineage-old:7', {
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    jobKind: 'provider',
  });
  index.recordTerminal('unknown', detail('unknown', 'completed'), index.resultPathFor('unknown'), 12);
  index.clearUnknownLocations('recovering');
  const admitted = addressing.waitStream({ jobIds: ['unknown'], supportsWaitV2: true });
  expect((await admitted.next()).value).toMatchObject({ type: 'terminal', jobId: 'unknown' });
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
    index.readOnlyView(),
    {
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
  expect(first.notices.join('\n')).toContain('progress held');
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
        epochKey: () => epoch,
        detail: () => detail('known', 'running'),
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'available', resultPath: '/result' }),
    );
    const request = { jobIds: ['known'], supportsWaitV3: true };
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
      index.readOnlyView(),
      {
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
    );
    const admissions = addressing.admitWait({ jobIds: ['A', 'U'], supportsWaitV3: true });
    expect(admissions[1].sourceRead).toBe(sourceRead);
    const snapshot = addressing.snapshot({ jobIds: ['A', 'U'] });
    expect(snapshot.remainingJobIds).toEqual(sourceRead === 'transient-unknown' ? ['A', 'U'] : []);
    expect(snapshot.jobs[0].progress).toEqual(sourceRead === 'transient-unknown' ? [] : ['sibling backlog']);
    if (sourceRead === 'transient-unknown') expect(snapshot.notices.join(' ')).toContain('A: progress held');
    if (sourceRead === 'settled-unreadable') {
      expect(snapshot.notices.join(' ')).toContain('cannot be read by this build');
      expect(snapshot.notices.join(' ')).not.toContain('no longer kept');
    }
    if (sourceRead === 'retired') expect(snapshot.notices.join(' ')).toContain('no longer kept');
  },
);
