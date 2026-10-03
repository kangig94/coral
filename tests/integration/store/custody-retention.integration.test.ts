import * as transfers from '#src/coordinator/services/durable-cli-transfer.js';
import { processIncarnationSchema } from '#src/infra/node-process.js';
import { recoverJobLocations } from '#src/jobs/location-recovery.js';
import { writeDurableCliProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import { bindCustodyIdentity, readCustodyLedger, recordCustodyIntent } from '#src/store/custody-ledger.js';
import { readOrCreateEpochKey } from '#src/store/epoch/key.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { initTestJob } from '#tests/helpers/session.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { createCustodyRetentionFixture } from '#tests/helpers/custody-retention.js';
const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});
function fixture() {
  const f = createRetentionFixture();
  fixtures.push(f);
  return createCustodyRetentionFixture(f);
}
it('discharges a durable carrier only with an exact terminal result and discharged transfer roots', async () => {
  const f = fixture();
  const jobId = f.runtime.ids.uuid();
  const epochDb = openSettledTestStoreDb(f.runtime);
  const lineageKey = readOrCreateEpochKey(f.runtime, {
    storeRoot: f.runtime.paths.coral.store.dbDir,
    epoch: '1',
    path: join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db'),
  });
  const epochPath = join(f.runtime.paths.coral.store.dbDir, 'epoch-1');
  const epochKey = JSON.stringify({
    storeRoot: f.runtime.paths.coral.store.dbDir,
    epoch: '1',
    path: join(epochPath, 'store.db'),
    lineageKey,
  });
  initTestJob(f.store, {
    jobId: jobId,
    sessionId: 'session',
    provider: 'codex',
    projectRoot: '/workspace',
    backendNamespace: 'test',
  });
  const intent = recordCustodyIntent(f.runtime, f.runDir, {
    effect: 'process-spawn',
    owner: 'durable-cli',
    epoch: epochPath,
    epochKey: lineageKey,
    operationId: jobId,
    capsule: null,
    nowMs: 100,
    bindWithinMs: 1000,
  });
  bindCustodyIdentity(f.runtime, f.runDir, intent, {
    process: { pid: 4321, incarnation: processIncarnationSchema.parse('linux:boot:123'), processGroupId: 4321 },
    capsule: null,
    observedAtMs: 200,
  });
  writeDurableCliProcessRuntimeMeta(epochDb, {
    jobId: jobId,
    pid: 4321,
    incarnation: processIncarnationSchema.parse('linux:boot:123'),
    processGroupId: 4321,
    childRoot: { pid: 4323, incarnation: processIncarnationSchema.parse('linux:boot:124') },
  });
  epochDb.close();
  recoverJobLocations(f.index, epochKey, f.store);
  await f.reconcile();
  expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'bound' }]);
  commitJobTerminal(f.store, jobId, 'session', {
    content: 'result',
    outcome: { kind: 'completed' },
    durationMs: 1,
  });
  recoverJobLocations(f.index, epochKey, f.store);
  const location = f.index.read(jobId)!;
  const readLocation = vi.spyOn(f.index, 'read').mockReturnValue({
    ...location,
    epochKey: JSON.stringify({ ...JSON.parse(epochKey), lineageKey: `${f.runtime.ids.uuid()}:1` }),
  });
  await f.reconcile();
  expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'bound' }]);
  readLocation.mockRestore();
  const incarnation = processIncarnationSchema.parse('linux:boot:123');
  const receipt: transfers.DurableCliControllerReceipt = {
    version: 'v1',
    jobId: jobId,
    epochKey,
    lineageEpochKey: lineageKey,
    attemptId: f.runtime.ids.uuid(),
    controllerInstanceId: 'controller',
    controllerBuildSetId: 'build',
    controlGeneration: 1,
    runtimeRecordGeneration: 2,
    custodyIntentId: intent.id,
    acknowledgedAtMs: 300,
    runtimeMeta: {
      jobId: f.runtime.ids.uuid(),
      pid: 4321,
      incarnation,
      processGroupId: 4321,
      childRoot: { pid: 4322, incarnation },
    },
  };
  const readReceipts = vi.spyOn(transfers, 'readDurableCliControllerReceipts');
  readReceipts.mockReturnValue({ receipts: [], unreadable: [] });
  for (const state of ['alive', 'unknown'] as const) {
    f.runtime.process.observeLiveness = (pid) => (pid === 4323 ? state : 'absent');
    f.runtime.process.readProcessIncarnation = (pid) =>
      pid === 4323 && state === 'alive' ? processIncarnationSchema.parse('linux:boot:124') : null;
    await f.reconcile();
    expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'bound' }]);
  }
  f.runtime.process.observeLiveness = () => 'absent';
  f.runtime.process.readProcessIncarnation = () => null;
  const resultPath = location.resultPath!;
  const result = readFileSync(resultPath);
  rmSync(resultPath);
  await f.reconcile();
  expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'bound' }]);
  expect(f.outcomes).toContainEqual(
    expect.objectContaining({
      kind: 'kept',
      reason: expect.stringContaining('daily reconciliation retries after retained result durability'),
    }),
  );
  writeFileSync(resultPath, '');
  await f.reconcile();
  expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'bound' }]);
  writeFileSync(resultPath, result);
  const sync = vi.spyOn(f.runtime.storage, 'fdatasyncSync').mockImplementation(() => {
    throw new Error('result sync unavailable');
  });
  await f.reconcile();
  expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'bound' }]);
  sync.mockRestore();
  // An unrelated unresolved job must not gate this job's durable artifact proof.
  f.index.register('unrelated', epochKey, { projectRoot: '/workspace', workDir: null, jobKind: 'provider' });
  expect(f.index.resultsReleased(epochKey)).toBe(false);

  for (const invalid of ['unreadable', 'intent', 'epoch', 'incarnation'] as const) {
    readReceipts.mockReturnValue({
      unreadable: invalid === 'unreadable' ? ['damaged receipt'] : [],
      receipts: [
        {
          ...receipt,
          ...(invalid === 'intent' ? { custodyIntentId: f.runtime.ids.uuid() } : {}),
          ...(invalid === 'epoch' ? { lineageEpochKey: `${f.runtime.ids.uuid()}:1` } : {}),
          ...(invalid === 'incarnation'
            ? { runtimeMeta: { ...receipt.runtimeMeta, incarnation: processIncarnationSchema.parse('linux:boot:456') } }
            : {}),
        },
      ],
    });
    await f.reconcile();
    expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'bound' }]);
  }
  readReceipts.mockReturnValue({ receipts: [receipt], unreadable: [] });
  f.runtime.process.observeLiveness = (pid) => (pid === 4322 ? 'alive' : 'absent');
  f.runtime.process.readProcessIncarnation = (pid) => (pid === 4322 ? incarnation : null);
  await f.reconcile();
  expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'bound' }]);
  f.runtime.process.observeLiveness = () => 'absent';
  f.runtime.process.readProcessIncarnation = () => null;
  await f.reconcile();
  expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'absent' }]);
  expect(f.runtime.process.kill).not.toHaveBeenCalled();
});
