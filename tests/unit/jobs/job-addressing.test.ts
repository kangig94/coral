import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { afterEach, describe, expect, it } from 'vitest';

import { JobAddressing } from '../../../src/jobs/addressing.js';
import { createRealRuntime } from '../../../src/runtime/real.js';
import { JobLocationIndex } from '../../../src/jobs/location-index.js';

import type { WaitCursor } from '../../../src/jobs/wait.js';
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
      waitStream: async function* () {},
    },
    () => false,
    () => 'pending',
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
    expect(addressing.validateWait({ jobIds: ['old'], cursor })).toBeNull();
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

it.each([false, true])('excludes a proven missing sibling from direct continuations, v2=%s', async (supportsWaitV2) => {
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
      waitStream: async function* (request) {
        seen.push(request.jobIds);
        yield { type: 'waiting', waitingJobIds: request.jobIds };
      },
    },
    () => false,
    () => 'pending',
  );
  const stream = addressing.waitStream({ jobIds: ['known', 'ghost'], supportsWaitV2, timeoutSeconds: 0 });
  const next = await stream.next();
  expect(next.value).toMatchObject({ waitingJobIds: ['known'] });
  if (!supportsWaitV2) expect(seen).toEqual([['known']]);
  else
    expect(next.value).toMatchObject({
      cursor: { locations: { known: 'lineage-new:8' }, positions: { 'lineage-new:8': 0 } },
    });
  await stream.return(undefined);
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
