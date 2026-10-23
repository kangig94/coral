import { currentCoralStoreFormat } from '#src/store-format.js';
import { afterEach, expect, it, vi } from 'vitest';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { recoverJobLocations } from '#src/jobs/location-recovery.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { testConversationFacet, initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});

it('recovers execution evidence and writes nothing on an unchanged second boot', () => {
  const f = createRetentionFixture();
  fixtures.push(f);
  const index = new JobLocationIndex(
    f.runtime,
    f.runtime.paths.coral.generation.dataRoot,
    undefined,
    currentCoralStoreFormat().fingerprint,
  );
  for (const id of ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002']) {
    initTestJob(f.store, {
      jobId: id,
      conversation: testConversationFacet('codex'),
      projectRoot: '/workspace',
      backendNamespace: 'test',
    });
    f.store.appendProgress(id, 'progress');
  }
  commitJobTerminal(f.store, '10000000-0000-4000-8000-000000000001', 1, {
    content: 'done',
    outcome: { kind: 'completed' },
    durationMs: 1,
  });
  const locationReads = vi.spyOn(f.runtime.storage, 'readFileSync');
  const locations = vi.spyOn(index, 'locationsFor');
  const capture = vi.spyOn(index, 'recordExecutionDetails');
  const record = vi.fn();
  recoverJobLocations(index, 'epoch', f.store, { record });
  const actualLocationReads = locationReads.mock.calls.filter(
    ([path], i) => String(path).includes('/job-locations.v1/jobs/') && locationReads.mock.results[i].type === 'return',
  ).length;
  const reportedLocationReads = record.mock.calls.reduce(
    (total, [source, counts]) => total + (source === 'job-locations' ? (counts.reads ?? 0) : 0),
    0,
  );
  expect(actualLocationReads).toBeGreaterThan(0);
  expect(reportedLocationReads).toBe(actualLocationReads);
  expect(locations).toHaveBeenCalledWith('epoch', { record });
  expect(record).toHaveBeenCalledWith('job-locations', { reads: 1 });
  expect(capture).toHaveBeenCalledTimes(2);
  expect(index.read('10000000-0000-4000-8000-000000000001')?.detail).toMatchObject({
    kind: 'recorded',
    value: { events: [{ type: 'terminal' }] },
  });
  expect(index.read('10000000-0000-4000-8000-000000000002')?.detail).toMatchObject({
    kind: 'recorded',
    value: { events: [{ type: 'progress', message: 'progress' }] },
  });
  expect(
    f.store.readJobEvents('10000000-0000-4000-8000-000000000002').filter((event) => event.type === 'progress'),
  ).toHaveLength(1);
  const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync');
  recoverJobLocations(index, 'epoch', f.store);
  expect(write).not.toHaveBeenCalled();
  f.store.appendProgress('10000000-0000-4000-8000-000000000002', 'later');
  recoverJobLocations(index, 'epoch', f.store);
  expect(write).toHaveBeenCalled();
  expect(
    f.store.readJobEvents('10000000-0000-4000-8000-000000000002').filter((event) => event.type === 'progress'),
  ).toHaveLength(2);
  expect(index.read('10000000-0000-4000-8000-000000000002')?.detail).toMatchObject({
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
  const index = new JobLocationIndex(
    f.runtime,
    f.runtime.paths.coral.generation.dataRoot,
    undefined,
    currentCoralStoreFormat().fingerprint,
  );
  for (const id of ['10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004']) {
    initTestJob(f.store, {
      jobId: id,
      conversation: testConversationFacet('codex'),
      projectRoot: '/workspace',
      backendNamespace: 'test',
    });
    commitJobTerminal(f.store, id, 1, { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 });
  }
  const record = index.recordExecutionDetails.bind(index);
  vi.spyOn(index, 'recordExecutionDetails').mockImplementation((...args) => {
    if (args[0] === '10000000-0000-4000-8000-000000000003') throw new Error('record failed');
    return record(...args);
  });
  expect(() => recoverJobLocations(index, 'epoch', f.store)).toThrow('record failed');
  expect(index.read('10000000-0000-4000-8000-000000000004')?.detail.kind).toBe('recorded');
  expect(index.read('10000000-0000-4000-8000-000000000004')?.terminalSeq).toBeDefined();
  expect(index.unknownLocationHolds()).toContainEqual({
    epochKey: 'epoch',
    reason: 'record failed',
    retryScheduled: true,
  });
});

it('retains diagnostics from stored progress rows that replay filters out', () => {
  const f = createRetentionFixture();
  fixtures.push(f);
  const index = new JobLocationIndex(
    f.runtime,
    f.runtime.paths.coral.generation.dataRoot,
    undefined,
    currentCoralStoreFormat().fingerprint,
  );
  initTestJob(f.store, {
    jobId: '10000000-0000-4000-8000-000000000005',
    conversation: testConversationFacet('codex'),
    projectRoot: '/workspace',
    backendNamespace: 'test',
  });
  f.store.commit((c) => {
    c.append({
      type: 'job.execution.progress',
      stream: { kind: 'job', id: '10000000-0000-4000-8000-000000000005' },
      namespace: 'test',
      project: '/workspace',
      refs: { jobId: '10000000-0000-4000-8000-000000000005' },
      body: { execution: 1, kind: 'missing_launch_record' },
    });
    return undefined;
  });
  const record = vi.fn();
  recoverJobLocations(index, 'epoch', f.store, { record });
  expect(f.store.readJobEvents('10000000-0000-4000-8000-000000000005')).toHaveLength(0);
  expect(index.read('10000000-0000-4000-8000-000000000005')?.detail).toMatchObject({
    kind: 'recorded',
    value: { events: [] },
  });
});
