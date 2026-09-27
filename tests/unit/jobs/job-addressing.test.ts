import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newRawDatabase } from '../../helpers/test-db.js';

import { JobAddressing } from '../../../src/jobs/addressing.js';
import { createRealRuntime } from '../../../src/runtime/real.js';
import { JobLocationIndex } from '../../../src/jobs/location-index.js';
import { recoverJobLocations } from '../../../src/jobs/location-recovery.js';
import type { JobProgressStore } from '../../../src/jobs/contracts/job-store.js';
import { advanceWaitRenderCursor } from '../../../src/jobs/wait-stream-event.js';
import {
  parseSerializedWaitCursor,
  serializeWaitCursor,
  waitCursorForJobs,
  type WaitCursor,
  type WaitStreamEvent,
} from '../../../src/jobs/wait.js';
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

describe('job addressing', () => {
  it('fills a missing terminal record and artifact after the journal commit', () => {
    const { root, index } = fixture();
    const db = newRawDatabase(':memory:');
    db.exec('CREATE TABLE events (seq INTEGER, stream_kind TEXT, stream_id TEXT, type TEXT, project TEXT, body BLOB)');
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      1,
      'job',
      'committed',
      'job.launch.requested',
      '/workspace/project',
      Buffer.from(
        JSON.stringify({
          owner: { kind: 'provider-session', id: 'session-1' },
          sessionId: 'session-1',
          provider: 'claude',
          providerAction: 'exec',
          projectRoot: '/workspace/project',
          backendNamespace: 'test-namespace',
          jobKind: 'provider',
          pool: 'default',
          enqueueSequence: 1,
          createdAt: '2026-09-25T00:00:00.000Z',
          request: {
            prompt: 'run',
            cwd: '/workspace/project',
            bypassPermissions: false,
            coralEnv: {},
          },
        }),
      ),
    );
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(
      12,
      'job',
      'committed',
      'job.terminal.recorded',
      '/workspace/project',
      Buffer.from('{}'),
    );
    const completed = detail('committed', 'completed');
    const resultPath = join(root, 'committed.md');
    const store = {
      getDb: () => db,
      loadJobProjectionDetail: () => ({ status: completed.status, launch: null, runtime: null, exit: completed.exit }),
      readJobEvents: () => completed.events,
      ensureResultArtifact: () => {
        writeFileSync(resultPath, 'committed result\n');
        return resultPath;
      },
    } as unknown as JobProgressStore;
    index.register('committed', 'lineage-old:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.invalidateTerminalCertificate('lineage-old:7');
    expect(index.read('committed')?.disposition).toBe('active-owner');
    recoverJobLocations(index, 'lineage-old:7', store);
    expect(index.read('committed')?.disposition).toBe('terminal');
    expect(index.certificate('lineage-old:7')?.terminalHighWaterSeq).toBe(12);
    expect(index.resultsReleased('lineage-old:7')).toBe(true);
    db.close();
  });

  it('keeps a terminal addressable after a dirty terminal commit and a different active epoch', async () => {
    const { root, index } = fixture();
    const resultPath = join(root, 'results', 'old.md');
    mkdirSync(join(root, 'results'));
    writeFileSync(resultPath, 'old result\n');
    index.register('old', 'lineage-old:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.invalidateTerminalCertificate('lineage-old:7');
    expect(index.certificate('lineage-old:7')).toBeNull();
    index.recordTerminal('old', detail('old', 'completed'), resultPath, 12);
    expect(index.certify('lineage-old:7', 12)?.jobIds).toEqual(['old']);
    expect(index.resultsReleased('lineage-old:7')).toBe(true);
    rmSync(resultPath);
    expect(index.resultsReleased('lineage-old:7')).toBe(false);
    writeFileSync(resultPath, 'old result\n');

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
    expect(addressing.scopeCheck(['old'], canonicalWorkDirWireSchema.parse('/workspace'), 'contains').missing).toEqual(
      [],
    );
    expect(addressing.detail('old')).toEqual(detail('old', 'completed'));
    expect(addressing.abort(['old'])).toEqual({
      kind: 'answered',
      result: { aborted: [], notFound: ['old'] },
    });
    const stream = addressing.waitStream({ jobIds: ['old'], supportsWaitV2: true });
    expect((await stream.next()).value).toMatchObject({ type: 'terminal', jobId: 'old', epochKey: 'lineage-old:7' });
    await stream.return(undefined);
  });

  it('answers an id unknown to every epoch as pre-epoch history only while a pre-epoch store exists', () => {
    const { index } = fixture();
    const access = {
      epochKey: () => 'lineage-new:8',
      detail: () => null,
      abort: () => ({ kind: 'answered' as const, result: { aborted: [], notFound: [] } }),
      waitStream: async function* () {},
    };

    expect(
      new JobAddressing(
        index,
        access,
        () => true,
        () => 'pending',
      ).detail('flat-store-job'),
    ).toEqual({
      kind: 'pre-epoch-history',
      jobId: 'flat-store-job',
    });
    expect(
      new JobAddressing(
        index,
        access,
        () => false,
        () => 'pending',
      ).detail('flat-store-job'),
    ).toBeNull();
  });

  it('invalidates a completeness certificate before accepting queued work', () => {
    const { index } = fixture();
    expect(index.certify('lineage-old:7', 0)).not.toBeNull();
    index.register('queued-without-effect', 'lineage-old:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    expect(index.certificate('lineage-old:7')).toBeNull();
    expect(index.read('queued-without-effect')?.disposition).toBe('active-owner');
  });

  it('validates epoch-bound cursors and chooses the first historical terminal in request order', async () => {
    const { root, index } = fixture();
    const resultPath = join(root, 'old.md');
    writeFileSync(resultPath, 'result\n');
    for (const [jobId, seq] of [
      ['older-b', 12],
      ['older-a', 11],
    ] as const) {
      index.register(jobId, 'lineage-old:7', {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
      index.recordTerminal(jobId, detail(jobId, 'completed', seq), resultPath, seq);
    }
    index.register('live', 'lineage-new:8', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => 'lineage-new:8',
        detail: (jobId) => (jobId === 'live' ? detail(jobId, 'running') : null),
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        waitStream: async function* () {},
      },
      () => false,
      () => 'pending',
    );
    const jobIds = ['live', 'older-b', 'older-a'];
    expect(addressing.validateWait({ jobIds, cursor: { afterSeq: 2 } })?.code).toBe('wait_cursor_epoch_required');
    const cursor: WaitCursor = {
      version: 'jobs.wait.v2',
      locations: { live: 'lineage-new:8', 'older-b': 'lineage-old:7', 'older-a': 'lineage-old:7' },
      positions: { 'lineage-new:8': 5, 'lineage-old:7': 0 },
    };
    expect(addressing.validateWait({ jobIds, cursor })).toBeNull();
    expect(addressing.validateWait({ jobIds: ['older-b'], cursor })).toMatchObject({
      code: 'wait_cursor_mismatch',
      message: expect.stringContaining('start a fresh wait without the cursor') as unknown,
    });
    const stream = addressing.waitStream({ jobIds, cursor, supportsWaitV2: true });
    const first = await stream.next();
    expect(first.value).toMatchObject({
      type: 'terminal',
      jobId: 'older-b',
      epochKey: 'lineage-old:7',
      remainingJobIds: ['live', 'older-a'],
      cursor: { positions: { 'lineage-new:8': 5, 'lineage-old:7': 12 } },
    });
    await stream.return(undefined);
    const waitingStream = addressing.waitStream({
      jobIds,
      cursor: (first.value as { cursor: WaitCursor }).cursor,
      supportsWaitV2: true,
      timeoutSeconds: 0,
    });
    expect((await waitingStream.next()).value).toMatchObject({
      type: 'waiting',
      waitingJobIds: ['live', 'older-a'],
    });
    await waitingStream.return(undefined);
    const resumedStream = addressing.waitStream({
      jobIds,
      cursor: (first.value as { cursor: WaitCursor }).cursor,
      supportsWaitV2: true,
      timeoutSeconds: 1,
    });
    const resumed = await resumedStream.next();
    expect(resumed.value).toMatchObject({
      type: 'terminal',
      jobId: 'older-a',
      epochKey: 'lineage-old:7',
      remainingJobIds: ['live'],
      cursor: {
        positions: { 'lineage-new:8': 5, 'lineage-old:7': 12 },
        deliveredJobIds: ['older-b', 'older-a'],
      },
    });
    await resumedStream.return(undefined);
    const pruned = waitCursorForJobs((first.value as { cursor: WaitCursor }).cursor, ['older-a']);
    expect(addressing.validateWait({ jobIds: ['older-a'], cursor: pruned })).toBeNull();
    const finalStream = addressing.waitStream({ jobIds: ['older-a'], cursor: pruned, supportsWaitV2: true });
    expect((await finalStream.next()).value).toMatchObject({ type: 'terminal', jobId: 'older-a' });
    await finalStream.return(undefined);
  });

  it('excludes delivered historical jobs from an active v2 terminal remaining list', async () => {
    const { root, index } = fixture();
    const resultPath = join(root, 'old.md');
    writeFileSync(resultPath, 'result\n');
    index.register('old', 'lineage-old:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.recordTerminal('old', detail('old', 'completed'), resultPath, 12);
    index.register('active', 'lineage-new:8', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => 'lineage-new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        waitStream: async function* () {
          yield {
            type: 'terminal',
            jobId: 'active',
            seq: 13,
            remainingJobIds: ['old'],
            resultPath: '/results/active.json',
            result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
          } satisfies WaitStreamEvent;
        },
      },
      () => false,
      () => 'pending',
    );
    const stream = addressing.waitStream({
      jobIds: ['old', 'active'],
      supportsWaitV2: true,
      cursor: {
        version: 'jobs.wait.v2',
        locations: { old: 'lineage-old:7', active: 'lineage-new:8' },
        positions: { 'lineage-old:7': 12, 'lineage-new:8': 0 },
        deliveredJobIds: ['old'],
      },
    });
    expect((await stream.next()).value).toMatchObject({
      type: 'terminal',
      jobId: 'active',
      remainingJobIds: [],
    });
    await stream.return(undefined);
  });

  it('advances only the event epoch while serializing all positions', () => {
    const cursor: WaitCursor = {
      version: 'jobs.wait.v2',
      locations: { old: 'lineage-old:7', live: 'lineage-new:8' },
      positions: { 'lineage-old:7': 4, 'lineage-new:8': 9 },
    };
    const event: Extract<WaitStreamEvent, { type: 'progress' }> = {
      type: 'progress' as const,
      jobId: 'old',
      seq: 5,
      message: 'working',
      timing: {
        origin: 'runtime' as const,
        originAt: '2026-09-25T00:00:00.000Z',
        emittedAt: '2026-09-25T00:00:01.000Z',
        elapsedMs: 1000,
      },
      epochKey: 'lineage-old:7',
      cursor: { ...cursor, positions: { ...cursor.positions, 'lineage-old:7': 5 } },
    };
    const advanced = advanceWaitRenderCursor(cursor, event);
    expect(advanced.shouldRender).toBe(true);
    expect(advanced.cursor).toMatchObject({ positions: { 'lineage-old:7': 5, 'lineage-new:8': 9 } });
    expect(advanceWaitRenderCursor(advanced.cursor, event).shouldRender).toBe(false);
    expect(parseSerializedWaitCursor(serializeWaitCursor(advanced.cursor))).toEqual(advanced.cursor);
  });

  // A coordinator without `supportsWaitV2` is sent no cursor, so it replays from its start in its own seq space; the
  // vector cursor can neither dedupe that replay nor advance on it.
  it('dedupes a legacy replay after the vector cursor was dropped, keeping delivered terminals delivered', () => {
    const timing = {
      origin: 'runtime' as const,
      originAt: '2026-09-25T00:00:00.000Z',
      emittedAt: '2026-09-25T00:00:01.000Z',
      elapsedMs: 1000,
    };
    const dropped: WaitCursor = {
      version: 'jobs.wait.v2',
      locations: { done: 'lineage-new:8', live: 'lineage-new:8' },
      positions: { 'lineage-new:8': 40 },
      deliveredJobIds: ['done'],
    };
    const progress: WaitStreamEvent = { type: 'progress', jobId: 'live', seq: 3, message: 'working', timing };
    const terminal = (jobId: string, seq: number): WaitStreamEvent => ({
      type: 'terminal',
      jobId,
      seq,
      remainingJobIds: [],
      resultPath: `/results/${jobId}.json`,
      result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
    });

    const first = advanceWaitRenderCursor(dropped, progress);
    expect(first.shouldRender).toBe(true);
    const replayed = advanceWaitRenderCursor(first.cursor, progress);
    expect(replayed.shouldRender).toBe(false);
    expect(advanceWaitRenderCursor(replayed.cursor, terminal('done', 4)).shouldRender).toBe(false);
    expect(advanceWaitRenderCursor(replayed.cursor, terminal('live', 5)).shouldRender).toBe(true);
  });

  it('keeps a terminal delivered before a dropped vector cursor delivered when a legacy cursor reconnects', async () => {
    const { index } = fixture();
    index.register('done', 'lineage-new:8', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => 'lineage-new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        waitStream: async function* () {
          yield {
            type: 'terminal',
            jobId: 'done',
            seq: 4,
            remainingJobIds: [],
            resultPath: '/results/done.json',
            result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
          } satisfies WaitStreamEvent;
        },
      },
      () => false,
      () => 'pending',
    );

    const stream = addressing.waitStream({
      jobIds: ['done'],
      cursor: { afterSeq: 0, deliveredJobIds: ['done'] },
      supportsWaitV2: true,
      timeoutSeconds: 1,
    });

    expect((await stream.next()).value).toMatchObject({ type: 'waiting' });
    await stream.return(undefined);
  });

  it('catches up progress from a live retained epoch with its own cursor position', async () => {
    const { index } = fixture();
    index.register('old-live', 'lineage-old:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.register('new-live', 'lineage-new:8', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const oldDetail = detail('old-live', 'running');
    oldDetail.events.push({
      type: 'progress',
      jobId: 'old-live',
      sessionId: 'session-1',
      seq: 4,
      ts: '2026-09-25T00:00:00.000Z',
      message: 'retained work',
      timing: {
        origin: 'runtime',
        originAt: '2026-09-25T00:00:00.000Z',
        emittedAt: '2026-09-25T00:00:01.000Z',
        elapsedMs: 1000,
      },
    });
    index.recordObserved('old-live', oldDetail);
    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => 'lineage-new:8',
        detail: (jobId) => (jobId === 'new-live' ? detail(jobId, 'running') : null),
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        waitStream: async function* () {},
      },
      () => false,
      () => 'pending',
    );
    const stream = addressing.waitStream({
      jobIds: ['old-live', 'new-live'],
      supportsWaitV2: true,
      cursor: {
        version: 'jobs.wait.v2',
        locations: { 'old-live': 'lineage-old:7', 'new-live': 'lineage-new:8' },
        positions: { 'lineage-old:7': 3, 'lineage-new:8': 9 },
      },
    });
    expect((await stream.next()).value).toMatchObject({
      type: 'progress',
      jobId: 'old-live',
      epochKey: 'lineage-old:7',
      seq: 4,
      cursor: { positions: { 'lineage-old:7': 4, 'lineage-new:8': 9 } },
    });
    await stream.return(undefined);
  });

  it('replays historical progress in journal sequence within an epoch', async () => {
    const { index } = fixture();
    for (const [jobId, seq] of [
      ['later', 4],
      ['earlier', 3],
    ] as const) {
      index.register(jobId, 'lineage-old:7', {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
      const observed = detail(jobId, 'running');
      observed.events.push({
        type: 'progress',
        jobId,
        sessionId: 'session-1',
        seq,
        ts: '2026-09-25T00:00:00.000Z',
        message: jobId,
        timing: {
          origin: 'runtime',
          originAt: '2026-09-25T00:00:00.000Z',
          emittedAt: '2026-09-25T00:00:01.000Z',
          elapsedMs: 1000,
        },
      });
      index.recordObserved(jobId, observed);
    }
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
    const stream = addressing.waitStream({ jobIds: ['later', 'earlier'], supportsWaitV2: true });
    expect((await stream.next()).value).toMatchObject({ type: 'progress', jobId: 'earlier', seq: 3 });
    expect((await stream.next()).value).toMatchObject({ type: 'progress', jobId: 'later', seq: 4 });
    await stream.return(undefined);
  });

  it('should keep interrupted events decodable by a caller that did not declare wait v2', async () => {
    // The v0.10.13 CLI decodes `interrupted` with this exact strict shape; an added `cursor` key fails its parse.
    const shippedInterruptedSchema = z
      .object({
        type: z.literal('interrupted'),
        jobId: z.string().min(1),
        storedPhase: z.string(),
        observedMaxJournalSeq: z.number().int().nonnegative(),
        remainingJobIds: z.array(z.string().min(1)),
        observation: z.object({ kind: z.literal('carrier_interrupted'), reason: z.literal('carrier_absent') }).strict(),
        continuity: z.literal('unavailable'),
        outcome: z.literal('unknown'),
      })
      .strict();
    const { index } = fixture();
    index.register('old-live', 'lineage-old:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.recordObserved('old-live', detail('old-live', 'running'));
    index.register('new-live', 'lineage-new:8', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const interrupted: WaitStreamEvent = {
      type: 'interrupted',
      jobId: 'new-live',
      storedPhase: 'running',
      observedMaxJournalSeq: 5,
      remainingJobIds: ['old-live', 'new-live'],
      observation: { kind: 'carrier_interrupted', reason: 'carrier_absent' },
      continuity: 'unavailable',
      outcome: 'unknown',
    };
    const addressing = (supportsWaitV2: boolean, jobIds: string[]) =>
      new JobAddressing(
        index,
        {
          epochKey: () => 'lineage-new:8',
          detail: () => null,
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
          waitStream: async function* () {
            yield interrupted;
          },
        },
        () => false,
        () => 'pending',
      ).waitStream({ jobIds, supportsWaitV2 });

    // A caller without wait v2 is refused any historical id, so only the active epoch can answer it.
    const shipped = addressing(false, ['new-live']);
    const legacyEvent = (await shipped.next()).value;
    await shipped.return(undefined);
    expect(shippedInterruptedSchema.safeParse(legacyEvent).success).toBe(true);

    const current = addressing(true, ['old-live', 'new-live']);
    expect((await current.next()).value).toMatchObject({ type: 'interrupted', cursor: { version: 'jobs.wait.v2' } });
    await current.return(undefined);
  });

  it('should report a recorded detail it cannot decode as unreadable and keep it through a rewrite', () => {
    const { root, index } = fixture();
    index.register('newer', 'lineage-old:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const jobPath = join(root, 'job-locations.v1', 'jobs', `${Buffer.from('newer').toString('base64url')}.json`);
    const stored = JSON.parse(readFileSync(jobPath, 'utf-8')) as Record<string, unknown>;
    const laterDetail = { status: { phase: 'a-later-phase' }, events: 'a-later-shape' };
    writeFileSync(jobPath, `${JSON.stringify({ ...stored, detail: laterDetail, laterField: 1 })}\n`);

    expect(index.read('newer')?.detail).toEqual({ kind: 'unreadable' });
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
    expect(addressing.detail('newer')).toEqual({
      kind: 'detail-unreadable',
      jobId: 'newer',
      epochKey: 'lineage-old:7',
    });

    index.markUnresolved('newer');
    expect(JSON.parse(readFileSync(jobPath, 'utf-8'))).toMatchObject({
      disposition: 'unresolved',
      detail: laterDetail,
      laterField: 1,
    });
  });

  describe('a historical job without a recorded terminal', () => {
    function historicalFixture(closure: 'pending' | 'decided') {
      const { index } = fixture();
      index.register('stranded', 'lineage-old:7', {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
      index.recordObserved('stranded', detail('stranded', 'running'));
      index.markUnresolved('stranded');
      const addressing = new JobAddressing(
        index,
        {
          epochKey: () => 'lineage-new:8',
          detail: () => null,
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
          waitStream: async function* () {},
        },
        () => false,
        (epochKey) => (epochKey === 'lineage-old:7' ? closure : 'pending'),
      );
      return addressing;
    }

    it('should answer detail and abort with a final disposition once its epoch closure is decided', () => {
      const addressing = historicalFixture('decided');

      expect(addressing.detail('stranded')).toEqual({
        kind: 'outcome-unrecoverable',
        jobId: 'stranded',
        epochKey: 'lineage-old:7',
      });
      expect(addressing.outcomeUnrecoverable(['stranded', 'unknown'])).toEqual(['stranded']);
      const abort = addressing.abort(['stranded']);
      expect(abort).toMatchObject({
        kind: 'answered',
        result: { refused: [{ jobId: 'stranded', reason: 'historical_outcome_unrecoverable' }] },
      });
      expect(abort.kind === 'answered' ? abort.result.held : undefined).toBeUndefined();
    });

    it('should keep holding while its epoch closure is still pending, naming that closure as the exit', () => {
      const addressing = historicalFixture('pending');

      expect(addressing.detail('stranded')).toMatchObject({ status: { jobId: 'stranded', phase: 'running' } });
      expect(addressing.outcomeUnrecoverable(['stranded'])).toEqual([]);
      expect(addressing.abort(['stranded'])).toMatchObject({
        kind: 'answered',
        result: { held: [{ jobId: 'stranded', reason: 'historical_owner_unresolved' }] },
      });
    });
  });

  it('should answer an id no epoch knows by whether a pre-epoch store exists', () => {
    const { index } = fixture();
    const access = {
      epochKey: () => 'lineage-new:8',
      detail: () => null,
      abort: () => ({ kind: 'answered' as const, result: { aborted: [], notFound: [] } }),
      waitStream: async function* () {},
    };

    expect(
      new JobAddressing(
        index,
        access,
        () => true,
        () => 'pending',
      ).unknownJobDisposition(),
    ).toBe('pre-epoch-history');
    expect(
      new JobAddressing(
        index,
        access,
        () => false,
        () => 'pending',
      ).unknownJobDisposition(),
    ).toBe('not-found');
  });

  it('should abort a known job and refuse a possible pre-epoch job without calling it not found', () => {
    const { index } = fixture();
    index.register('known', 'lineage-new:8', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => 'lineage-new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: ['known'], notFound: [] } }),
        waitStream: async function* () {},
      },
      () => true,
      () => 'pending',
    );

    expect(addressing.abort(['known', 'possible-flat'])).toMatchObject({
      kind: 'answered',
      result: {
        aborted: ['known'],
        notFound: [],
        refused: [{ jobId: 'possible-flat', reason: 'job_pre_epoch_history' }],
      },
    });
  });

  it('should keep the carrier-unconfirmed list when it multiplexes a wait', async () => {
    const { index } = fixture();
    index.register('new-live', 'lineage-new:8', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => 'lineage-new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        waitStream: async function* () {
          yield { type: 'waiting', waitingJobIds: ['new-live'], carrierUnknownJobIds: ['new-live'] };
        },
      },
      () => false,
      () => 'pending',
    );

    const stream = addressing.waitStream({ jobIds: ['new-live'], supportsWaitV2: true, timeoutSeconds: 1 });
    expect((await stream.next()).value).toMatchObject({
      type: 'waiting',
      waitingJobIds: ['new-live'],
      carrierUnknownJobIds: ['new-live'],
    });
    await stream.return(undefined);
  });

  it('should refuse a historical wait to a caller whose cursor can only name the active epoch', async () => {
    const { index } = fixture();
    index.register('old', 'lineage-old:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
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

    expect(addressing.validateWait({ jobIds: ['old'] })?.code).toBe('wait_epoch_unsupported');
    await expect(addressing.waitStream({ jobIds: ['old'] }).next()).rejects.toThrow('wait_epoch_unsupported');
    expect(addressing.validateWait({ jobIds: ['old'], supportsWaitV2: true })).toBeNull();
  });

  it('should retire a location whose launch never committed so the epoch can still be certified', () => {
    const { index } = fixture();
    const db = newRawDatabase(':memory:');
    db.exec('CREATE TABLE events (seq INTEGER, stream_kind TEXT, stream_id TEXT, type TEXT, project TEXT, body BLOB)');
    const store = {
      getDb: () => db,
      loadJobProjectionDetail: () => ({ status: null, launch: null, runtime: null, exit: null }),
      readJobEvents: () => [],
      ensureResultArtifact: () => '',
    } as unknown as JobProgressStore;
    index.register('rolled-back', 'lineage-new:8', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });

    recoverJobLocations(index, 'lineage-new:8', store);

    expect(index.read('rolled-back')).toBeNull();
    expect(index.certificate('lineage-new:8')?.jobIds).toEqual([]);
    db.close();
  });

  it('should skip a location record a newer build wrote and keep only its own epoch uncertified', () => {
    const { root, index } = fixture();
    index.register('known', 'lineage-new:8', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.recordTerminal('known', detail('known', 'completed'), join(root, 'known.md'), 12);
    index.register('newer', 'lineage-old:7', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const newerPath = join(root, 'job-locations.v1', 'jobs', `${Buffer.from('newer').toString('base64url')}.json`);
    const stored = JSON.parse(readFileSync(newerPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(newerPath, `${JSON.stringify({ ...stored, disposition: 'a-later-disposition' })}\n`);

    expect(index.locations().map((location) => location.jobId)).toEqual(['known']);
    expect(index.certify('lineage-new:8', 12)?.jobIds).toEqual(['known']);
    expect(index.certify('lineage-old:7', 0)).toBeNull();
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
