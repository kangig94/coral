import { loadReleasedWait } from '#tests/helpers/released-wait.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JobLocationIndex } from '#src/jobs/location-index.js';
import type { JobDetailResponse } from '#src/jobs/records.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { canonicalWorkDirWireSchema } from '#src/runtime/canonical-work-dir.js';

const runtime = createRealRuntime('prod', { baseDir: tmpdir() });
const directories: string[] = [];

function fixture(): { root: string; index: JobLocationIndex } {
  const root = mkdtempSync(join(tmpdir(), 'coral-red-job-location-'));
  directories.push(root);
  return { root, index: new JobLocationIndex(runtime, root) };
}

function terminalDetail(jobId: string): JobDetailResponse {
  const result = { content: 'done', outcome: { kind: 'completed' as const }, durationMs: 1 };
  return {
    status: {
      jobId,
      owner: { kind: 'provider-session', id: 'session-1' },
      sessionId: 'session-1',
      provider: 'claude',
      projectRoot: '/workspace/project',
      workDir: canonicalWorkDirWireSchema.parse('/workspace/project'),
      backendNamespace: 'test',
      jobKind: 'provider',
      phase: 'completed',
      updatedAt: '2026-09-25T00:00:00.000Z',
      result,
    },
    events: [
      {
        type: 'terminal',
        jobId,
        sessionId: 'session-1',
        seq: 2,
        ts: '2026-09-25T00:00:00.000Z',
        result,
        usage: { inputTokens: 1 },
      },
    ],
    readiness: 'ready',
    exit: {
      ...result,
      diagnostics: {
        progressFaults: [{ kind: 'missing_launch_record' }],
        usage: { outputTokens: 2 },
        processExit: { exitCode: 0, signal: null },
        byteCounts: { stdout: 1, stderr: 0 },
      },
      endTime: '2026-09-25T00:00:00.000Z',
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('job location additive records', () => {
  it('preserves unknown detail fields through an additive merge', () => {
    const { root, index } = fixture();
    const jobId = 'job-1';
    index.register(jobId, 'lineage-1:1', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`);
    const detail = terminalDetail(jobId);
    writeFileSync(
      path,
      `${JSON.stringify({
        ...JSON.parse(readFileSync(path, 'utf-8')),
        detail: {
          ...detail,
          futureRoot: 'keep',
          status: {
            ...detail.status,
            futureStatus: 'keep',
            owner: { ...detail.status.owner, futureOwner: 'keep' },
            result: {
              ...detail.status.result,
              futureResult: 'keep',
              outcome: { kind: 'completed', futureOutcome: 'keep' },
            },
          },
          events: [
            {
              ...detail.events[0],
              futureEvent: 'keep',
              result: {
                ...detail.status.result,
                futureEventResult: 'keep',
                outcome: { kind: 'completed', futureEventOutcome: 'keep' },
              },
              usage: { inputTokens: 1, futureUsage: 'keep' },
            },
          ],
          exit: {
            ...detail.exit,
            futureExit: 'keep',
            outcome: { kind: 'completed', futureExitOutcome: 'keep' },
            diagnostics: {
              ...detail.exit!.diagnostics,
              futureDiagnostics: 'keep',
              usage: { outputTokens: 2, futureDiagnosticUsage: 'keep' },
              processExit: { exitCode: 0, signal: null, futureProcessExit: 'keep' },
              byteCounts: { stdout: 1, stderr: 0, futureByteCounts: 'keep' },
              progressFaults: [{ kind: 'missing_launch_record', futureFault: 'keep' }],
            },
          },
        },
      })}\n`,
    );

    index.recordTerminal(jobId, detail, join(root, 'result.md'), 2);

    expect(JSON.parse(readFileSync(path, 'utf-8')).detail).toMatchObject({
      futureRoot: 'keep',
      status: { futureStatus: 'keep', result: { futureResult: 'keep' } },
      events: [{ futureEvent: 'keep', result: { futureEventResult: 'keep' } }],
      exit: { futureExit: 'keep', diagnostics: { futureDiagnostics: 'keep' } },
    });
    expect(index.read(jobId)?.detail).toMatchObject({
      kind: 'recorded',
      value: {
        futureRoot: 'keep',
        status: {
          futureStatus: 'keep',
          owner: { futureOwner: 'keep' },
          result: { futureResult: 'keep', outcome: { futureOutcome: 'keep' } },
        },
        events: [
          {
            futureEvent: 'keep',
            result: { futureEventResult: 'keep', outcome: { futureEventOutcome: 'keep' } },
            usage: { futureUsage: 'keep' },
          },
        ],
        exit: {
          futureExit: 'keep',
          outcome: { futureExitOutcome: 'keep' },
          diagnostics: {
            futureDiagnostics: 'keep',
            usage: { futureDiagnosticUsage: 'keep' },
            processExit: { futureProcessExit: 'keep' },
            byteCounts: { futureByteCounts: 'keep' },
            progressFaults: [{ futureFault: 'keep' }],
          },
        },
      },
    });
  });
  it('does not release a certified result whose existing artifact cannot be synced', () => {
    const { root, index } = fixture();
    const epochKey = 'lineage-1:1';
    const jobId = 'job-1';
    const resultPath = join(root, 'result.md');
    writeFileSync(resultPath, 'done\n');
    index.register(jobId, epochKey, {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.recordTerminal(jobId, terminalDetail(jobId), resultPath, 2);
    expect(index.certify(epochKey, 2)).not.toBeNull();
    vi.spyOn(runtime.storage, 'fdatasyncSync').mockImplementation(() => {
      throw new Error('sync failed');
    });

    expect(index.resultsReleased(epochKey)).toBe(false);
  });
  it('requires readable terminal detail both to certify and to release results', () => {
    const { root, index } = fixture();
    const epochKey = 'lineage-1:1';
    const jobId = 'job-1';
    const resultPath = join(root, 'result.md');
    writeFileSync(resultPath, 'done\n');
    index.register(jobId, epochKey, {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.recordTerminal(jobId, terminalDetail(jobId), resultPath, 2);
    expect(index.certify(epochKey, 2)).not.toBeNull();
    expect(index.resultsReleased(epochKey)).toBe(true);

    const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`);
    const record = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...record, detail: { futureFormat: true } })}\n`);

    expect(index.read(jobId)?.detail.kind).toBe('unreadable');
    expect(index.certify(epochKey, 2)).toBeNull();
    expect(index.resultsReleased(epochKey)).toBe(false);

    writeFileSync(path, `${JSON.stringify({ ...record, detail: { ...terminalDetail(jobId), exit: null } })}\n`);
    expect(index.read(jobId)?.detail.kind).toBe('unreadable');
    expect(index.certify(epochKey, 2)).toBeNull();
    expect(index.resultsReleased(epochKey)).toBe(false);
  });
});

it.each(['revision', 'terminalHighWaterSeq'])('rejects an unsafe job-location certificate %s', (field) => {
  const { root, index } = fixture();
  const epochKey = 'lineage-1:1';
  expect(index.certify(epochKey, 0)).toMatchObject({ revision: 0, terminalHighWaterSeq: 0 });
  const path = join(root, 'job-locations.v1', 'epochs', runtime.ids.sha256(epochKey), 'certificate.v1.json');
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), [field]: Number.MAX_SAFE_INTEGER + 1 }),
  );
  expect(() => index.certificate(epochKey)).toThrow();
});

it('refuses job-location revision exhaustion before persistence', () => {
  const { root, index } = fixture();
  const epochKey = 'lineage-1:1';
  index.invalidateTerminalCertificate(epochKey);
  const path = join(root, 'job-locations.v1', 'epochs', runtime.ids.sha256(epochKey), 'revision.v1.json');
  const raw = JSON.stringify({ version: 'v1', revision: Number.MAX_SAFE_INTEGER, futureField: true });
  writeFileSync(path, raw);
  expect(() => index.invalidateTerminalCertificate(epochKey)).toThrow(/exhausted/u);
  expect(readFileSync(path, 'utf8')).toBe(raw);
});

it('bounds terminal events and leaves an unchanged terminal and certificate unwritten', () => {
  const { root, index } = fixture();
  const jobId = 'bounded';
  index.register(jobId, 'epoch', {
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    jobKind: 'provider',
  });
  const detail = terminalDetail(jobId);
  detail.events.unshift({
    type: 'progress',
    jobId,
    sessionId: 'session-1',
    seq: 1,
    ts: detail.status.updatedAt,
    message: 'progress',
    timing: {
      origin: 'launch' as const,
      originAt: '2026-09-25T00:00:00.000Z',
      emittedAt: '2026-09-25T00:00:00.000Z',
      elapsedMs: 1,
    },
  });
  index.recordTerminal(jobId, detail, join(root, 'result.md'), 2);
  expect(index.read(jobId)?.detail).toMatchObject({ kind: 'recorded', value: { events: [detail.events[1]] } });
  index.certify('epoch', 2);
  const write = vi.spyOn(runtime.storage, 'writeAtomicDurableSync');
  index.recordTerminal(jobId, detail, join(root, 'result.md'), 2);
  index.certify('epoch', 2);
  expect(write).not.toHaveBeenCalled();
});

it('compacts historical records in bounded resumable turns and preserves unresolved progress', async () => {
  const { root, index } = fixture();
  const progress = {
    type: 'progress' as const,
    jobId: 'a',
    sessionId: 'session-1',
    seq: 1,
    ts: '2026-09-25T00:00:00.000Z',
    message: 'progress',
    timing: {
      origin: 'launch' as const,
      originAt: '2026-09-25T00:00:00.000Z',
      emittedAt: '2026-09-25T00:00:00.000Z',
      elapsedMs: 1,
    },
  };
  const paths: string[] = [];
  for (const id of ['a', 'b', 'c']) {
    index.register(id, 'epoch', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    if (id !== 'c') index.recordTerminal(id, terminalDetail(id), join(root, id), 2);
    const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from(id).toString('base64url')}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    const detail = terminalDetail(id);
    record.detail = { ...detail, futureField: 'retained', events: [{ ...progress, jobId: id }, ...detail.events] };
    if (id === 'c') {
      record.detail.status.phase = 'running';
      record.detail.exit = null;
      record.detail.events.pop();
    }
    writeFileSync(path, JSON.stringify(record));
    paths.push(path);
  }
  let operations = 0;
  const checkpoints: string[] = [];
  const next = await index.compactTerminalRecords(
    '',
    { canContinue: () => ++operations <= 1, record: () => {} },
    (operation) => operation(),
    (id) => checkpoints.push(id),
  );
  expect(next).not.toBe('');
  expect(checkpoints).toEqual([next]);
  expect(JSON.parse(readFileSync(paths[0], 'utf8')).detail).toMatchObject({
    futureField: 'retained',
    events: [{ type: 'terminal' }],
  });
  expect(JSON.parse(readFileSync(paths[1], 'utf8')).detail.events).toHaveLength(2);
  expect(
    await index.compactTerminalRecords(next, { canContinue: () => true, record: () => {} }, (operation) => operation()),
  ).toBe('');
  expect(JSON.parse(readFileSync(paths[1], 'utf8')).detail.events).toHaveLength(1);
  expect(JSON.parse(readFileSync(paths[2], 'utf8')).detail.events).toEqual([{ ...progress, jobId: 'c' }]);
  const write = vi.spyOn(runtime.storage, 'writeAtomicDurableSync');
  await index.compactTerminalRecords('', { canContinue: () => true, record: () => {} }, (operation) => operation());
  expect(write).not.toHaveBeenCalled();
});

it('durably refuses a damaged identity, advances past it, and retries it after readable evidence returns', async () => {
  const { root, index } = fixture();
  const paths: string[] = [];
  for (const jobId of ['a', 'b', 'c']) {
    index.register(jobId, 'epoch', { projectRoot: '/workspace', workDir: null, jobKind: 'provider' });
    index.recordTerminal(jobId, terminalDetail(jobId), join(root, jobId), 2);
    const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.detail.events.unshift({
      type: 'progress',
      jobId,
      sessionId: 'session-1',
      seq: 1,
      ts: '2026-09-25T00:00:00.000Z',
      message: 'earlier',
      timing: {
        elapsedMs: 0,
        origin: 'launch',
        originAt: '2026-09-25T00:00:00.000Z',
        emittedAt: '2026-09-25T00:00:00.000Z',
      },
    });
    writeFileSync(path, JSON.stringify(record));
    paths.push(path);
  }
  const original = readFileSync(paths[1], 'utf8');
  writeFileSync(paths[1], '{damaged');
  const outcomes: unknown[] = [];
  const budget = { canContinue: () => true, record: (outcome: unknown) => outcomes.push(outcome) };
  expect(await index.compactTerminalRecords('', budget, (operation) => operation())).toBe('');
  for (const path of [paths[0], paths[2]]) expect(JSON.parse(readFileSync(path, 'utf8')).detail.events).toHaveLength(1);
  expect(readFileSync(paths[1], 'utf8')).toBe('{damaged');
  const refusal = join(root, 'job-locations.v1', 'compaction-refusals.v1', 'Yg.json');
  expect(JSON.parse(readFileSync(refusal, 'utf8'))).toMatchObject({
    version: 'v1',
    reason: expect.stringContaining('daily retry'),
  });
  expect(outcomes).toContainEqual(expect.objectContaining({ subject: 'Yg.json', kind: 'kept' }));
  const write = vi.spyOn(runtime.storage, 'writeAtomicDurableSync');
  await index.compactTerminalRecords('', budget, (operation) => operation());
  expect(write).not.toHaveBeenCalled();
  writeFileSync(paths[1], original);
  await index.compactTerminalRecords('', budget, (operation) => operation());
  expect(JSON.parse(readFileSync(paths[1], 'utf8')).detail.events).toHaveLength(1);
  expect(runtime.storage.existsSync(refusal)).toBe(false);
});

it.each(['{', '{"version":"v99","reason":"future"}'])('isolates an undecodable unknown-location hold: %s', (bytes) => {
  const { root, index } = fixture();
  index.holdUnknownLocations('epoch', 'known hold', true);
  writeFileSync(
    join(root, 'job-locations.v1', 'epochs', runtime.ids.sha256('epoch'), 'unknown-locations.v1.json'),
    bytes,
  );
  expect(index.unknownLocationHolds()).toEqual([
    expect.objectContaining({ retryScheduled: false, reason: expect.stringContaining('cannot be decoded') }),
  ]);
  expect(index.unknownLocationHold('epoch')).toContain('cannot be decoded');
});

it('observes another index writer even when the jobs directory mtime is restored', () => {
  const { root, index } = fixture();
  index.register('a', 'epoch', { projectRoot: '/workspace', workDir: '/workspace', jobKind: 'provider' });
  expect(index.locationsFor('epoch').map((item) => item.jobId)).toEqual(['a']);
  const directory = join(root, 'job-locations.v1', 'jobs');
  const lstat = runtime.storage.lstatSync.bind(runtime.storage);
  const mtimeNs = lstat(directory, { bigint: true }).mtimeNs;
  vi.spyOn(runtime.storage, 'lstatSync').mockImplementation((path, options) => {
    const stat = lstat(path, options);
    return path === directory
      ? { ...stat, mtimeNs, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile() }
      : stat;
  });
  const writer = new JobLocationIndex(runtime, root);
  writer.register('b', 'epoch', { projectRoot: '/workspace', workDir: '/workspace', jobKind: 'kb' });
  expect(
    index
      .locationsFor('epoch')
      .map((item) => item.jobId)
      .sort(),
  ).toEqual(['a', 'b']);
});

it('reuses an unchanged decided certificate and invalidates it on another owner revision', () => {
  const { root, index } = fixture();
  index.register('a', 'epoch', { projectRoot: '/workspace', workDir: null, jobKind: 'provider' });
  index.recordTerminal('a', terminalDetail('a'), join(root, 'a'), 2);
  expect(index.certify('epoch', 2)?.jobIds).toEqual(['a']);
  expect(index.certificate('epoch')?.jobIds).toEqual(['a']);
  const read = vi.spyOn(runtime.storage, 'readFileSync');
  for (let poll = 0; poll < 20; poll++) expect(index.certificate('epoch')?.jobIds).toEqual(['a']);
  expect(read.mock.calls.filter(([path]) => String(path).endsWith('certificate.v1.json'))).toHaveLength(0);
  const writer = new JobLocationIndex(runtime, root);
  writer.register('b', 'epoch', { projectRoot: '/workspace', workDir: null, jobKind: 'provider' });
  expect(index.certificate('epoch')).toBeNull();
  writer.recordTerminal('b', terminalDetail('b'), join(root, 'b'), 2);
  writer.certify('epoch', 2);
  expect(index.certificate('epoch')?.jobIds).toEqual(['a', 'b']);
});

it('preserves released progress meaning without changing its revision', () => {
  const { index } = fixture();
  const jobId = 'running';
  index.register(jobId, 'epoch', {
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    jobKind: 'provider',
  });
  const detail = terminalDetail(jobId);
  detail.status.phase = 'running';
  delete detail.status.result;
  detail.exit = null;
  detail.events = [];
  const writes = vi.spyOn(runtime.storage, 'writeAtomicDurableSync');
  for (let seq = 1; seq <= 100; seq++) {
    detail.status.lastSeq = seq;
    detail.events.push({
      type: 'progress',
      jobId,
      sessionId: 'session-1',
      seq,
      ts: detail.status.updatedAt,
      message: 'progress body'.repeat(100),
      timing: { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: seq },
    });
    index.recordObserved(jobId, detail);
  }
  expect(writes).toHaveBeenCalledTimes(100);
  expect(writes.mock.calls.some(([path]) => path.endsWith('revision.v1.json'))).toBe(false);
  expect(index.read(jobId)?.detail).toMatchObject({ kind: 'recorded', value: { events: detail.events } });
});

it('does not rewrite a released terminal detail merely to add its derivable epochKey', () => {
  const { root, index } = fixture();
  const jobId = 'finished';
  index.register(jobId, 'epoch', {
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    jobKind: 'provider',
  });
  const detail = terminalDetail(jobId);
  index.recordTerminal(jobId, detail, '/result', 2);
  const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`);
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  delete stored.detail.epochKey;
  writeFileSync(path, JSON.stringify(stored));
  const writes = vi.spyOn(runtime.storage, 'writeAtomicDurableSync');
  index.recordTerminal(jobId, detail, '/result', 2);
  expect(writes).not.toHaveBeenCalled();
});

it('invalidates a reused inode stamp when file birth time changes', () => {
  const { root, index } = fixture();
  const jobId = 'stamp-job';
  index.register(jobId, 'lineage-1:1', {
    projectRoot: '/workspace/first',
    workDir: '/workspace/first',
    jobKind: 'provider',
  });
  const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`);
  const originalStat = runtime.storage.lstatSync(path, { bigint: true });
  let birthtimeNs = 1n;
  const lstat = runtime.storage.lstatSync.bind(runtime.storage);
  vi.spyOn(runtime.storage, 'lstatSync').mockImplementation((file, options) =>
    file === path ? { ...originalStat, birthtimeNs } : lstat(file, options),
  );
  expect(index.read(jobId)?.subject.projectRoot).toBe('/workspace/first');
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll('/workspace/first', '/workspace/other'));
  birthtimeNs = 2n;
  expect(index.read(jobId)?.subject.projectRoot).toBe('/workspace/other');
});

it('retains incremental nonterminal progress for the real rolled-back v0.10.17 reader', async () => {
  const { root, index } = fixture();
  const released = await loadReleasedWait('v0.10.17', directories);
  index.register('live', 'epoch', {
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    jobKind: 'provider',
  });
  const value = terminalDetail('live');
  value.exit = null;
  value.status.phase = 'running';
  delete value.status.result;
  const timing = {
    origin: 'runtime',
    originAt: value.status.updatedAt,
    emittedAt: value.status.updatedAt,
    elapsedMs: 1,
  } as const;
  const progress = (seq: number, message: string) => ({
    type: 'progress' as const,
    jobId: 'live',
    sessionId: 'session-1',
    seq,
    ts: value.status.updatedAt,
    message,
    timing,
  });
  index.recordObserved('live', { ...value, events: [progress(1, 'first')] });
  index.recordObserved('live', { ...value, events: [progress(2, 'second')] });
  const rolledBack = new released.JobLocationIndex!(runtime, root);
  expect(rolledBack.read('live')?.detail).toMatchObject({
    kind: 'recorded',
    value: { events: [expect.objectContaining({ message: 'first' }), expect.objectContaining({ message: 'second' })] },
  });
});

import { createTerminalExportFixture as cacheFixture } from '#tests/helpers/terminal-export.js';
const cacheFixtures: ReturnType<typeof cacheFixture>[] = [];
afterEach(() => {
  for (const f of cacheFixtures.splice(0)) f.close();
});
describe('bounded location cache', () => {
  it('a full maintenance-style scan retains at most 32 terminal records', () => {
    const f = cacheFixture();
    cacheFixtures.push(f);
    f.complete({ terminal: { content: 'x'.repeat(100_000), outcome: { kind: 'completed' }, durationMs: 1 } });
    const template = readFileSync(f.locationPath, 'utf8');
    const dir = dirname(f.locationPath);
    const N = 300;
    for (let i = 0; i < N; i++) {
      const id = `bulk-${i}`;
      writeFileSync(
        join(dir, `${Buffer.from(id).toString('base64url')}.json`),
        template.replaceAll('"job-1"', JSON.stringify(id)),
      );
    }
    const index = new JobLocationIndex(f.runtime, f.root);
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    let terminal = 0;
    for (const id of index.jobIds()) if (index.read(id)?.disposition === 'terminal') terminal++;
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    const cached = (index as unknown as { storedLocations: Map<string, unknown> }).storedLocations.size;
    console.log(
      JSON.stringify({
        records: N + 1,
        terminal,
        cached,
        heapDeltaMB: Math.round((after - before) / 1e6),
        recordKB: Math.round(template.length / 1000),
      }),
    );
    expect(cached).toBeLessThanOrEqual(32);
  });
});

it('observes replacement bytes even when inode and all coarse timestamps collide', () => {
  const { root, index } = fixture();
  const jobId = 'coarse-stamp';
  index.register(jobId, 'lineage-1:1', {
    projectRoot: '/workspace/first',
    workDir: '/workspace/first',
    jobKind: 'provider',
  });
  const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`);
  const stamp = runtime.storage.lstatSync(path, { bigint: true });
  const lstat = runtime.storage.lstatSync.bind(runtime.storage);
  vi.spyOn(runtime.storage, 'lstatSync').mockImplementation((file, options) =>
    file === path ? stamp : lstat(file, options),
  );
  expect(index.read(jobId)?.subject.projectRoot).toBe('/workspace/first');
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll('/workspace/first', '/workspace/other'));
  expect(index.read(jobId)?.subject.projectRoot).toBe('/workspace/other');
});

it('imports terminal readability only from its owner', async () => {
  expect(await import('#src/jobs/location-index.js')).not.toHaveProperty('hasReadableTerminalDetail');
});

it('discharges a released directory-only hold after complete absent inventory', () => {
  const { root, index } = fixture();
  index.holdUnknownLocations('retired', 'legacy hold', true);
  const path = join(root, 'job-locations.v1', 'epochs', runtime.ids.sha256('retired'), 'unknown-locations.v1.json');
  writeFileSync(path, JSON.stringify({ version: 'v1', reason: 'legacy hold' }));
  index.reconcileUnknownLocationHolds([]);
  expect(index.unknownLocationHolds()).toEqual([]);
});

it('resolves the hold and revision through the identity shared by lineage encodings', () => {
  const { root, index } = fixture();
  const full = JSON.stringify({ storeRoot: '/real/store', epoch: '7', lineageKey: 'lineage:7' });
  const alias = JSON.stringify({ storeRoot: '/alias/store', epoch: '7', lineageKey: 'lineage:7' });
  index.holdUnknownLocations(full, 'owner settled', false);
  index.register('job', full, { projectRoot: '/project', workDir: '/project', jobKind: 'provider' });
  const restarted = new JobLocationIndex(runtime, root);
  expect(restarted.unknownLocationHold(alias)).toBe('owner settled');
  expect(restarted.revision(alias)).toBe(index.revision(full));
  expect(restarted.locationsFor(alias).map((job) => job.jobId)).toEqual(['job']);
  restarted.clearUnknownLocations(alias);
  expect(index.unknownLocationHold(full)).toBeNull();
});
