import { reconcileFinishedCustody } from '#src/coordinator/services/recovery/custody-reconciliation.js';
import {
  custodyLedgerDir,
  dischargeCustodyEntry,
  pruneCustodyLedger,
  readCustodyLedger,
  readCustodyLedgerId,
  reconcileCustodyLedger,
} from '#src/store/custody-ledger.js';
import { createCustodyRetentionFixture } from '#tests/helpers/custody-retention.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

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

it('discharges exactly observed finished owners and retires them only after the proof age gate', async () => {
  const f = fixture();
  const bound = f.bound();
  const ledgerId = readCustodyLedgerId(f.runtime, f.runDir);
  const marker = readFileSync(join(custodyLedgerDir(f.runDir), 'root.v1.json'), 'utf8');
  await f.reconcile();
  expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'absent' }]);
  expect(existsSync(join(custodyLedgerDir(f.runDir), bound.intent.id, 'binding.v1.json'))).toBe(true);
  await f.prune(f.runtime.time.now() - 14 * 86_400_000);
  expect(readCustodyLedger(f.runtime, f.runDir)).toHaveLength(1);
  const now = f.runtime.time.now();
  f.setNow(now + 14 * 86_400_000 + 1);
  await f.prune(f.runtime.time.now() - 14 * 86_400_000);
  expect(readCustodyLedger(f.runtime, f.runDir)).toEqual([]);
  expect(f.outcomes).toContainEqual({ kind: 'deleted', subject: bound.intent.id, count: 1 });
  expect(readCustodyLedgerId(f.runtime, f.runDir)).toBe(ledgerId);
  expect(readFileSync(join(custodyLedgerDir(f.runDir), 'root.v1.json'), 'utf8')).toBe(marker);
  expect(f.runtime.process.kill).not.toHaveBeenCalled();
});

it.each(['live', 'unknown', 'group-live', 'missing-result', 'unknown-owner'] as const)(
  'retains bound custody when discharge evidence is %s',
  async (state) => {
    const f = fixture();
    const entry = f.bound(
      state === 'missing-result' ? 'durable-cli' : state === 'unknown-owner' ? 'future-owner' : 'provider-host',
    );
    if (state === 'live') {
      f.runtime.process.observeLiveness = () => 'alive';
      f.runtime.process.readProcessIncarnation = () => entry.binding.process!.incarnation;
    }
    if (state === 'unknown') f.runtime.process.observeLiveness = () => 'unknown';
    if (state === 'group-live') f.runtime.process.observeLiveness = (pid) => (pid < 0 ? 'alive' : 'absent');
    await f.reconcile();
    await f.prune(f.runtime.time.now() + 30 * 86_400_000);
    expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'bound' }]);
    expect(f.runtime.process.kill).not.toHaveBeenCalled();
  },
);

it('does not discharge a binding from age, an ordinary absence observation, or mismatched exact evidence', async () => {
  const f = fixture();
  const bound = f.bound();
  reconcileCustodyLedger(f.runtime, f.runDir, f.runtime.time.now(), 0, () => ({
    kind: 'absent',
    processToken: bound.intent.processToken,
    evidence: 'token absent',
  }));
  const path = join(custodyLedgerDir(f.runDir), bound.intent.id, 'absence.v1.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 'v1',
      intentId: bound.intent.id,
      processToken: bound.intent.processToken,
      provenAtMs: 100,
      evidence: 'plain absence',
      dischargedBinding: { ...bound.binding, observedAtMs: 999 },
    }),
  );
  await f.prune(f.runtime.time.now());
  expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'bound' }]);
  expect(
    dischargeCustodyEntry(
      f.runtime,
      f.runDir,
      { ...bound, binding: { ...bound.binding, observedAtMs: 999 } },
      1000,
      'wrong binding',
      (operation) => operation(),
    ),
  ).toBe(false);
});

it('resumes a bounded custody scan beyond unknown-owner holds', async () => {
  const f = fixture();
  f.bound('future-owner');
  f.bound('future-owner');
  let observations = 0;
  const next = await reconcileFinishedCustody({
    runtime: f.runtime,
    runDir: f.runDir,
    index: f.index,
    afterId: '',
    budget: { canContinue: () => ++observations <= 1, record: f.budget.record },
    signal: new AbortController().signal,
    mutate: (operation) => operation(),
  });
  expect(next).not.toBe('');
  expect(
    await reconcileFinishedCustody({
      runtime: f.runtime,
      runDir: f.runDir,
      index: f.index,
      afterId: next,
      budget: f.budget,
      signal: new AbortController().signal,
      mutate: (operation) => operation(),
    }),
  ).toBe('');
  expect(f.outcomes.filter((outcome) => outcome.kind === 'kept')).toHaveLength(2);
  expect(readCustodyLedger(f.runtime, f.runDir).every((entry) => entry.kind === 'bound')).toBe(true);
});

it.each(['after-rename', 'during-cleanup'] as const)(
  'resumes retirement after a crash %s without partially visible entries',
  async (crash) => {
    const f = fixture();
    const entry = f.bound();
    dischargeCustodyEntry(f.runtime, f.runDir, entry, 1000, 'exact discharge', (operation) => operation());
    const root = custodyLedgerDir(f.runDir);
    const rename = f.runtime.storage.renameSync;
    const unlink = f.runtime.storage.unlinkSync;
    let interrupted = false;
    if (crash === 'after-rename')
      f.runtime.storage.renameSync = (from, to) => {
        rename(from, to);
        if (from === join(root, entry.intent.id)) {
          interrupted = true;
          throw new Error('crash after rename');
        }
      };
    else
      f.runtime.storage.unlinkSync = (path) => {
        if (String(path).includes('.stage.retention.') && String(path).endsWith('intent.v1.json')) {
          expect(existsSync(join(root, entry.intent.id))).toBe(false);
          expect(readCustodyLedger(f.runtime, f.runDir)).toEqual([]);
          unlink(path);
          interrupted = true;
          throw new Error('crash during stage cleanup');
        }
        unlink(path);
      };
    await f.prune(1001);
    expect(interrupted).toBe(true);
    expect(readCustodyLedger(f.runtime, f.runDir)).toEqual([]);
    expect(readdirSync(root).some((name) => name.startsWith('.stage.retention.'))).toBe(true);
    f.runtime.storage.renameSync = rename;
    f.runtime.storage.unlinkSync = unlink;
    await f.prune(1001);
    expect(readdirSync(root)).toEqual(['root.v1.json']);
  },
);

it('does not delete an unproven retirement stage', async () => {
  const f = fixture();
  const entry = f.bound();
  const root = custodyLedgerDir(f.runDir);
  const stage = join(root, `.stage.retention.${entry.intent.id}.${f.runtime.ids.uuid()}`);
  mkdirSync(stage);
  writeFileSync(join(stage, 'keep'), 'unknown');
  await f.prune(f.runtime.time.now());
  expect(existsSync(join(stage, 'keep'))).toBe(true);
});

it('reaches the writer fence for an eligible absence and preserves the visible entry and proof', async () => {
  const f = fixture();
  const entry = f.bound();
  dischargeCustodyEntry(f.runtime, f.runDir, entry, 1000, 'exact discharge', (operation) => operation());
  const root = custodyLedgerDir(f.runDir);
  const proofPath = join(root, entry.intent.id, 'absence.v1.json');
  const proof = readFileSync(proofPath, 'utf8');
  const names = readdirSync(root);
  const mutate = vi.fn(() => {
    throw new Error('writer parked');
  });
  await pruneCustodyLedger({
    runtime: f.runtime,
    runDir: f.runDir,
    cutoff: 1001,
    afterId: '',
    budget: f.budget,
    mutate,
  });
  expect(mutate).toHaveBeenCalled();
  expect(readdirSync(root)).toEqual(names);
  expect(readFileSync(proofPath, 'utf8')).toBe(proof);
  expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'absent' }]);
});

it('bounds custody cleanup and resumes its owned stage after the budget expires', async () => {
  const f = fixture();
  const entry = f.bound();
  dischargeCustodyEntry(f.runtime, f.runDir, entry, 1000, 'exact discharge', (operation) => operation());
  let operations = 0;
  const next = await pruneCustodyLedger({
    runtime: f.runtime,
    runDir: f.runDir,
    cutoff: 1001,
    afterId: '',
    budget: { canContinue: () => ++operations <= 2, record: f.budget.record },
    mutate: (operation) => operation(),
  });
  expect(readCustodyLedger(f.runtime, f.runDir)).toEqual([]);
  await pruneCustodyLedger({
    runtime: f.runtime,
    runDir: f.runDir,
    cutoff: 1001,
    afterId: next,
    budget: f.budget,
    mutate: (operation) => operation(),
  });
  expect(readdirSync(custodyLedgerDir(f.runDir))).toEqual(['root.v1.json']);
});
