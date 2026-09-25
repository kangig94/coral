import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

    const addressing = new JobAddressing(index, {
      epochKey: () => 'lineage-new:8',
      detail: () => null,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      waitStream: async function* () {},
    });
    expect(addressing.scopeCheck(['old'], canonicalWorkDirWireSchema.parse('/workspace'), 'contains').missing).toEqual(
      [],
    );
    expect(addressing.detail('old')).toEqual(detail('old', 'completed'));
    expect(addressing.abort(['old'])).toMatchObject({
      kind: 'answered',
      result: { notFound: [], refused: [{ jobId: 'old', reason: 'already_terminal' }] },
    });
    const stream = addressing.waitStream({ jobIds: ['old'], supportsWaitV2: true });
    expect((await stream.next()).value).toMatchObject({ type: 'terminal', jobId: 'old', epochKey: 'lineage-old:7' });
    await stream.return(undefined);
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
    const addressing = new JobAddressing(index, {
      epochKey: () => 'lineage-new:8',
      detail: (jobId) => (jobId === 'live' ? detail(jobId, 'running') : null),
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      waitStream: async function* () {},
    });
    const jobIds = ['live', 'older-b', 'older-a'];
    expect(addressing.validateWait({ jobIds, cursor: { afterSeq: 2 } })?.code).toBe('wait_cursor_epoch_required');
    const cursor: WaitCursor = {
      version: 'jobs.wait.v2',
      locations: { live: 'lineage-new:8', 'older-b': 'lineage-old:7', 'older-a': 'lineage-old:7' },
      positions: { 'lineage-new:8': 5, 'lineage-old:7': 0 },
    };
    expect(addressing.validateWait({ jobIds, cursor })).toBeNull();
    expect(addressing.validateWait({ jobIds: ['older-b'], cursor })?.code).toBe('wait_cursor_mismatch');
    const stream = addressing.waitStream({ jobIds, cursor, supportsWaitV2: true });
    const first = await stream.next();
    expect(first.value).toMatchObject({
      type: 'terminal',
      jobId: 'older-b',
      epochKey: 'lineage-old:7',
      cursor: { positions: { 'lineage-new:8': 5, 'lineage-old:7': 12 } },
    });
    await stream.return(undefined);
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
    const addressing = new JobAddressing(index, {
      epochKey: () => 'lineage-new:8',
      detail: (jobId) => (jobId === 'new-live' ? detail(jobId, 'running') : null),
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      waitStream: async function* () {},
    });
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
    const addressing = new JobAddressing(index, {
      epochKey: () => 'lineage-new:8',
      detail: () => null,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      waitStream: async function* () {},
    });
    const stream = addressing.waitStream({ jobIds: ['later', 'earlier'], supportsWaitV2: true });
    expect((await stream.next()).value).toMatchObject({ type: 'progress', jobId: 'earlier', seq: 3 });
    expect((await stream.next()).value).toMatchObject({ type: 'progress', jobId: 'later', seq: 4 });
    await stream.return(undefined);
  });
});
