import { afterEach, expect, it, vi } from 'vitest';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { recoverJobLocations } from '#src/jobs/location-recovery.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});

it('recovers terminals without loading progress and writes nothing on an unchanged second boot', () => {
  const f = createRetentionFixture();
  fixtures.push(f);
  const index = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
  for (const id of ['terminal', 'live']) {
    initTestJob(f.store, {
      jobId: id,
      sessionId: id,
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'test',
    });
    f.store.appendProgress(id, id, 'progress');
  }
  commitJobTerminal(f.store, 'terminal', 'terminal', {
    content: 'done',
    outcome: { kind: 'completed' },
    durationMs: 1,
  });
  const read = vi.spyOn(f.store, 'readJobEvents');
  const record = vi.fn();
  recoverJobLocations(index, 'epoch', f.store, { record });
  expect(record).toHaveBeenCalledWith('job-launches', { subjects: 2, reads: 2 });
  expect(read).toHaveBeenCalledWith('terminal', true, 0, { record });
  expect(read).toHaveBeenCalledWith('live', false, 0, { record });
  expect(index.read('terminal')?.detail).toMatchObject({ kind: 'recorded', value: { events: [{ type: 'terminal' }] } });
  expect(index.read('live')?.detail).toMatchObject({
    kind: 'recorded',
    value: { events: [{ type: 'progress', message: 'progress' }] },
  });
  expect(f.store.readJobEvents('live').filter((event) => event.type === 'progress')).toHaveLength(1);
  const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync');
  recoverJobLocations(index, 'epoch', f.store);
  expect(write).not.toHaveBeenCalled();
  f.store.appendProgress('live', 'live', 'later');
  recoverJobLocations(index, 'epoch', f.store);
  expect(write).toHaveBeenCalled();
  expect(f.store.readJobEvents('live').filter((event) => event.type === 'progress')).toHaveLength(2);
  expect(index.read('live')?.detail).toMatchObject({
    kind: 'recorded',
    value: {
      events: [
        { type: 'progress', message: 'progress' },
        { type: 'progress', message: 'later' },
      ],
    },
  });
});

it('isolates a failing terminal record while recovering its siblings', () => {
  const f = createRetentionFixture();
  fixtures.push(f);
  const index = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
  for (const id of ['bad', 'good']) {
    initTestJob(f.store, {
      jobId: id,
      sessionId: id,
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'test',
    });
    commitJobTerminal(f.store, id, id, { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 });
  }
  const record = index.recordTerminal.bind(index);
  vi.spyOn(index, 'recordTerminal').mockImplementation((...args) => {
    if (args[0] === 'bad') throw new Error('record failed');
    return record(...args);
  });
  expect(() => recoverJobLocations(index, 'epoch', f.store)).toThrow('record failed');
  expect(index.read('good')?.detail.kind).toBe('recorded');
  expect(index.read('good')?.terminalSeq).toBeDefined();
  expect(index.unknownLocationHolds()).toContainEqual({
    epochKey: 'epoch',
    reason: 'record failed',
    retryScheduled: true,
  });
});

it('counts stored progress rows that replay filters out', () => {
  const f = createRetentionFixture();
  fixtures.push(f);
  const index = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
  initTestJob(f.store, {
    jobId: 'filtered-progress',
    sessionId: 'filtered-session',
    provider: 'codex',
    projectRoot: '/workspace',
    backendNamespace: 'test',
  });
  f.store.commit((c) => {
    c.append({
      type: 'job.progress.emitted',
      stream: { kind: 'job', id: 'filtered-progress' },
      namespace: 'test',
      project: '/workspace',
      refs: { jobId: 'filtered-progress' },
      body: { kind: 'missing_launch_record' },
    });
    return undefined;
  });
  const record = vi.fn();
  recoverJobLocations(index, 'epoch', f.store, { record });
  expect(f.store.readJobEvents('filtered-progress')).toHaveLength(0);
  expect(record).toHaveBeenCalledWith('job-events', { reads: 1 });
});
