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
  recoverJobLocations(index, 'epoch', f.store);
  expect(read).toHaveBeenCalledWith('terminal', true);
  expect(read).toHaveBeenCalledWith('live');
  expect(index.read('terminal')?.detail).toMatchObject({ kind: 'recorded', value: { events: [{ type: 'terminal' }] } });
  expect(index.read('live')?.detail).toMatchObject({ kind: 'recorded', value: { events: [{ type: 'progress' }] } });
  const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync');
  recoverJobLocations(index, 'epoch', f.store);
  expect(write).not.toHaveBeenCalled();
  f.store.appendProgress('live', 'live', 'later');
  recoverJobLocations(index, 'epoch', f.store);
  expect(write).toHaveBeenCalled();
  expect(index.read('live')?.detail).toMatchObject({
    kind: 'recorded',
    value: { events: [{ type: 'progress' }, { type: 'progress' }] },
  });
});
