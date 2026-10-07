import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendLog } from '#src/infra/backend-log.js';

import { JobAddressing } from '../../../src/jobs/addressing.js';
import { createRealRuntime } from '../../../src/runtime/real.js';
import { JobLocationIndex } from '../../../src/jobs/location-index.js';

import type { WaitCursor } from '../../../src/jobs/wait/contract.js';
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
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('classifies a location read failure as retryable discovery uncertainty, never as missing', () => {
  const { index } = fixture();
  index.read = () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  };
  expect(historicalAddressing(index).admitWait({ jobIds: ['job'] })[0].disposition).toBe('unknown');
});

it('admits a job its location record cannot decode when the active journal answers for it', () => {
  const { index } = fixture();
  index.read = () => {
    throw new SyntaxError('Unexpected end of JSON input');
  };
  const done = detail('done', 'completed');
  const addressing = new JobAddressing(
    index,
    {
      visitProgress: progressVisitFromDetails(() => null),
      epochKey: () => 'lineage-new:8',
      detail: (jobId) => (jobId === 'done' ? done : null),
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'pending',
    undefined,
    (jobId) => ({ kind: 'available', resultPath: index.resultPathFor(jobId) }),
  );
  const [answered, unanswered] = addressing.admitWait({ jobIds: ['done', 'neither'] });
  expect(answered).toMatchObject({ disposition: 'admitted', epochKey: 'lineage-new:8' });
  expect(answered.detail?.exit).toMatchObject({ content: 'done result' });
  expect(unanswered.disposition).toBe('unreadable');
});

it('ignores a stray file under the epochs directory, so a typo stays missing rather than unreadable', () => {
  const { root, index } = fixture();
  mkdirSync(join(root, 'job-locations.v1', 'epochs'), { recursive: true });
  writeFileSync(join(root, 'job-locations.v1', 'epochs', 'stray-file'), 'x');
  const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
  const addressing = historicalAddressing(index);
  for (let read = 0; read < 2; read++)
    expect(addressing.admitWait({ jobIds: ['typo'] })[0].disposition).toBe('missing');
  index.reconcileUnknownLocationHolds([]);
  expect(index.unknownLocationHolds()).toEqual([]);
  expect(warn).toHaveBeenCalledOnce();
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
  it('delivers a historical terminal whatever the watermark, which only ever positions active-epoch jobs', async () => {
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
    const cursor: WaitCursor = savedCursor(100);
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

it('settled source agrees across wait, detail and abort', () => {
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
    () => 'decided',
    () => ({ kind: 'unreadable', disposition: 'settled-unreadable', reason: 'bounded attempts exhausted' }),
    () => ({ kind: 'pending' }),
  );
  expect(addressing.admitWait({ jobIds: ['U'] })).toMatchObject([{ disposition: 'unreadable' }]);
  expect(addressing.detail('U')).toMatchObject({ kind: 'outcome-unreadable' });
  const snapshot = addressing.snapshot({ jobIds: ['U'] });
  expect(snapshot.exitCode).toBe(1);
  expect(snapshot.remainingJobIds).toEqual([]);
  expect(addressing.abort(['U'])).toMatchObject({ kind: 'answered', result: { refused: [{ jobId: 'U' }] } });
});

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

it('propagates a code defect from a location read instead of reporting discovery uncertainty', () => {
  const { index } = fixture();
  index.read = () => {
    throw new TypeError('defect');
  };
  expect(() => historicalAddressing(index).admitWait({ jobIds: ['job'] })).toThrow(TypeError);
});
