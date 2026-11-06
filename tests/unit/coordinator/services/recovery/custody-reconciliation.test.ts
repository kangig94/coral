import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { currentCoralStoreFormat } from '../../../../../src/store-format.js';
import {
  reconcileFinishedCustody,
  reconcileStartupCustody,
} from '../../../../../src/coordinator/services/recovery/custody-reconciliation.js';
import { applyBundledStoreSchema } from '../../../../../src/store/db.js';
import { insertProviderOperation } from '../../../../../src/store/provider-operation-journal.js';
import {
  custodyLedgerDir,
  recordCustodyIntent,
  readCustodyLedger,
  readCustodyLedgerAsync,
} from '../../../../../src/store/custody-ledger.js';
import { newRawDatabase } from '../../../../helpers/test-db.js';
import { providerOperationRecord } from '../../../store/provider-operation-fixtures.js';
import { createRealRuntime } from '../../../../../src/runtime/real.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { startRecoveryPhase } from '#src/recovery/phase-observation.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { createCustodyRetentionFixture } from '#tests/helpers/custody-retention.js';

describe('startup custody reconciliation', () => {
  it.each(['binding.v1.json'])('recovers publication after a crash with a damaged %s sidecar', (sidecar) => {
    const root = '/coral-custody-publication';
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const runDir = join(root, 'run');
    const time = new VirtualTime();
    const runtime = { ...createRealRuntime('prod', { baseDir: root }), time, storage: new InMemoryStorage(time) };
    const record = providerOperationRecord('prepare-pending');
    try {
      const intent = recordCustodyIntent(runtime, runDir, {
        effect: 'provider-operation-publication',
        epoch: 'epoch-a',
        owner: 'provider-operation',
        operationId: record.operation.operationId,
        capsule: null,
        nowMs: 100,
        bindWithinMs: 1_000,
      });
      insertProviderOperation(db, record);
      runtime.storage.writeFileSync(join(custodyLedgerDir(runDir), intent.id, sidecar), '{"pid":');
      const logs: string[] = [];
      for (let pass = 0; pass < 3; pass++) {
        const phase = startRecoveryPhase({
          kind: 'background',
          phase: 'custody-reconciliation',
          bootId: 'custody-test',
          time,
          log: (line) => logs.push(line),
        });
        expect(reconcileStartupCustody(runtime, runDir, 3_200, db, 'epoch-a', undefined, phase)).toMatchObject([
          { kind: 'bound', binding: { process: null } },
        ]);
        phase.finish();
      }
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/event=finish outcome=complete.*subjects=1 reads=[1-9]\d*/);
    } finally {
      db.close();
    }
  });

  it('does not prove an old epoch publication absent from the current epoch database', () => {
    const root = '/coral-custody-epoch';
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const runDir = join(root, 'run');
    const time = new VirtualTime();
    const runtime = { ...createRealRuntime('prod', { baseDir: root }), time, storage: new InMemoryStorage(time) };
    try {
      recordCustodyIntent(runtime, runDir, {
        effect: 'provider-operation-publication',
        epoch: 'epoch-old',
        owner: 'provider-operation',
        operationId: 'operation-old',
        capsule: null,
        nowMs: 100,
        bindWithinMs: 1_000,
      });
      expect(reconcileStartupCustody(runtime, runDir, 3_200, db, 'epoch-new')).toMatchObject([{ kind: 'holding' }]);
      expect(reconcileStartupCustody(runtime, runDir, 3_200, db, 'epoch-old')).toMatchObject([{ kind: 'absent' }]);
    } finally {
      db.close();
    }
  });
});

type CustodyState = { entry: string; disposition: string; reason: string | null };

function summary(line: string): { counts: Record<string, number>; changed: CustodyState[] } {
  if (line.startsWith('custody-damage ')) {
    const evidence = JSON.parse(line.slice('custody-damage '.length)) as {
      entries: { entry: string; observed: Omit<CustodyState, 'entry'> }[];
    };
    const changed = evidence.entries.map(({ entry, observed }) => ({ entry, ...observed }));
    const counts: Record<string, number> = {};
    for (const hold of changed) counts[hold.disposition] = (counts[hold.disposition] ?? 0) + 1;
    return { counts, changed };
  }
  expect(line).toContain('event=finish');
  const detail = JSON.parse(line.slice(line.indexOf('detail=') + 'detail='.length)) as {
    changes: { kind: string; identity: string; reason: string[] }[];
  };
  const holds: CustodyState[] = detail.changes
    .filter((change) => change.kind !== 'cleared')
    .flatMap((change) => change.reason.map((reason) => ({ entry: change.identity, ...JSON.parse(reason) })));
  const counts: Record<string, number> = {};
  for (const hold of holds) counts[hold.disposition] = (counts[hold.disposition] ?? 0) + 1;
  return { counts, changed: holds };
}

it('reports startup holds, changed reasons and successful clearance once', () => {
  const f = createCustodyRetentionFixture(createRetentionFixture());
  const logs: string[] = [];
  const pass = () =>
    reconcileStartupCustody(f.runtime, f.runDir, 500, f.db, 'epoch-1', undefined, undefined, (line) => logs.push(line));
  try {
    pass();
    expect(logs).toEqual([]);
    const intent = recordCustodyIntent(f.runtime, f.runDir, {
      effect: 'provider-operation-publication',
      epoch: 'epoch-1',
      owner: 'provider-operation',
      operationId: 'held-operation',
      capsule: null,
      nowMs: 100,
      bindWithinMs: 1_000,
    });
    const path = join(custodyLedgerDir(f.runDir), intent.id, 'intent.v1.json');
    const intact = f.runtime.storage.readFileSync(path, 'utf-8');
    pass();
    pass();
    expect(logs).toHaveLength(1);
    expect(summary(logs[0]).counts).toEqual({ holding: 1 });
    f.runtime.storage.writeFileSync(path, '{');
    pass();
    pass();
    expect(logs).toHaveLength(2);
    expect(summary(logs[1]).counts).toEqual({ unreadable: 1 });
    const reason = summary(logs[1]).changed[0].reason;
    f.runtime.storage.writeFileSync(path, 'broken');
    pass();
    expect(logs).toHaveLength(3);
    expect(summary(logs[2]).changed[0].reason).not.toBe(reason);
    f.runtime.storage.writeFileSync(path, intact);
    pass();
    pass();
    expect(logs).toHaveLength(4);
    expect(summary(logs[3]).counts).toEqual({ holding: 1 });
    f.runtime.storage.rmSync(join(custodyLedgerDir(f.runDir), intent.id), { recursive: true });
    pass();
    pass();
    expect(logs).toHaveLength(5);
    expect(logs[4]).toContain('state=cleared');
  } finally {
    f.close();
  }
});

it('reports initial damage and its repair in the same startup pass', () => {
  const f = createCustodyRetentionFixture(createRetentionFixture());
  const logs: string[] = [];
  const pass = () =>
    reconcileStartupCustody(f.runtime, f.runDir, 500, f.db, 'epoch-1', undefined, undefined, (line) => logs.push(line));
  try {
    const record = providerOperationRecord('prepare-pending');
    const intent = recordCustodyIntent(f.runtime, f.runDir, {
      effect: 'provider-operation-publication',
      epoch: 'epoch-1',
      owner: 'provider-operation',
      operationId: record.operation.operationId,
      capsule: null,
      nowMs: 100,
      bindWithinMs: 1_000,
    });
    insertProviderOperation(f.db, record);
    const path = join(custodyLedgerDir(f.runDir), intent.id);
    f.runtime.storage.writeFileSync(join(path, 'binding.v1.json'), '{');
    expect(pass()).toMatchObject([{ kind: 'bound' }]);
    expect(logs).toHaveLength(1);
    expect(summary(logs[0]).changed).toContainEqual({
      entry: path,
      disposition: 'holding',
      reason: 'identity binding is incomplete or mismatched',
    });
    pass();
    pass();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0].slice('custody-damage '.length))).toMatchObject({
      counts: { reported: 1, cleared: 1 },
      entries: [{ cleared: true, final: { disposition: 'bound' } }],
    });
  } finally {
    f.close();
  }
});

it('keeps startup and finished hold observations independent', async () => {
  const f = createCustodyRetentionFixture(createRetentionFixture());
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const startup = () => reconcileStartupCustody(f.runtime, f.runDir, 500, f.db, 'epoch-1', undefined, undefined, log);
  const finished = () =>
    reconcileFinishedCustody({
      runtime: f.runtime,
      runDir: f.runDir,
      index: f.index,
      afterId: '',
      budget: f.budget,
      signal: new AbortController().signal,
      mutate: (operation) => operation(),
      log,
    });
  try {
    const entry = f.bound('future-owner');
    startup();
    await finished();
    startup();
    await finished();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('custody-reconciliation.finished');
    f.runtime.storage.rmSync(join(custodyLedgerDir(f.runDir), entry.intent.id), { recursive: true });
    startup();
    await finished();
    startup();
    await finished();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('state=cleared');
    expect(f.runtime.process.kill).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('does not clear finished custody holds on cancellation, but clears after successful observation', async () => {
  const f = createCustodyRetentionFixture(createRetentionFixture());
  const logs: string[] = [];
  const pass = (signal = new AbortController().signal) =>
    reconcileFinishedCustody({
      runtime: f.runtime,
      runDir: f.runDir,
      index: f.index,
      afterId: '',
      budget: f.budget,
      signal,
      mutate: (operation) => operation(),
      log: (line) => logs.push(line),
    });
  try {
    const entry = f.bound('future-owner');
    await pass();
    await pass();
    expect(logs).toHaveLength(1);
    f.runtime.storage.writeFileSync(join(custodyLedgerDir(f.runDir), entry.intent.id, 'binding.v1.json'), '{');
    await pass();
    await pass();
    expect(logs).toHaveLength(2);
    f.runtime.storage.rmSync(join(custodyLedgerDir(f.runDir), entry.intent.id), { recursive: true });
    const cancelled = new AbortController();
    cancelled.abort();
    await pass(cancelled.signal);
    expect(logs).toHaveLength(2);
    await pass();
    await pass();
    expect(logs).toHaveLength(3);
    expect(logs[2]).toContain('state=cleared');
  } finally {
    f.close();
  }
});

it('reports only completed finite-budget sweeps and stays silent across unchanged resumptions', async () => {
  const f = createCustodyRetentionFixture(createRetentionFixture());
  const logs: string[] = [];
  let cursor = '';
  const pass = async () => {
    let remaining = 1;
    cursor = await reconcileFinishedCustody({
      runtime: f.runtime,
      runDir: f.runDir,
      index: f.index,
      afterId: cursor,
      budget: { canContinue: () => remaining-- > 0, record: (outcome) => f.outcomes.push(outcome) },
      signal: new AbortController().signal,
      mutate: (operation) => operation(),
      log: (line) => logs.push(line),
    });
    return cursor;
  };
  try {
    const ids = Array.from({ length: 3 }, () => f.bound('future-owner').intent.id).sort();
    expect(await pass()).toBe(ids[0]);
    expect(logs).toEqual([]);
    expect(await pass()).toBe(ids[1]);
    expect(logs).toEqual([]);
    expect(await pass()).toBe('');
    expect(logs).toHaveLength(1);
    expect(summary(logs[0]).counts).toEqual({ holding: 3 });
    expect(summary(logs[0]).changed.every((entry) => entry.disposition === 'holding')).toBe(true);

    expect(await pass()).toBe(ids[0]);
    expect(await pass()).toBe(ids[1]);
    expect(await pass()).toBe('');
    expect(logs).toHaveLength(1);

    expect(await pass()).toBe(ids[0]);
    const changedPath = join(custodyLedgerDir(f.runDir), ids[2]);
    f.runtime.storage.writeFileSync(join(changedPath, 'binding.v1.json'), '{');
    expect(logs).toHaveLength(1);
    expect(await pass()).toBe(ids[1]);
    expect(logs).toHaveLength(1);
    expect(await pass()).toBe('');
    expect(logs).toHaveLength(2);
    expect(summary(logs[1]).counts).toEqual({ holding: 1 });
    expect(summary(logs[1]).changed).toContainEqual({
      entry: changedPath,
      disposition: 'holding',
      reason: 'identity binding is incomplete or mismatched',
    });

    expect(await pass()).toBe(ids[0]);
    expect(await pass()).toBe(ids[1]);
    expect(await pass()).toBe('');
    expect(logs).toHaveLength(2);
    expect(f.runtime.process.kill).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('reports first unreadable evidence with the final outcome at the end of a repaired sweep', async () => {
  const f = createCustodyRetentionFixture(createRetentionFixture());
  const logs: string[] = [];
  let cursor = '';
  const pass = async (allowance = 1) => {
    let remaining = allowance;
    cursor = await reconcileFinishedCustody({
      runtime: f.runtime,
      runDir: f.runDir,
      index: f.index,
      afterId: cursor,
      budget: { canContinue: () => remaining-- > 0, record: (outcome) => f.outcomes.push(outcome) },
      signal: new AbortController().signal,
      mutate: (operation) => operation(),
      log: (line) => logs.push(line),
    });
    return cursor;
  };
  try {
    const ids = Array.from({ length: 3 }, () => f.bound('future-owner').intent.id).sort();
    expect(await pass()).toBe(ids[0]);
    expect(await pass()).toBe(ids[1]);
    expect(await pass()).toBe('');
    expect(logs).toHaveLength(1);
    expect(summary(logs[0]).counts).toEqual({ holding: 3 });

    const damagedPath = join(custodyLedgerDir(f.runDir), ids[1]);
    const intentPath = join(damagedPath, 'intent.v1.json');
    const intact = f.runtime.storage.readFileSync(intentPath, 'utf-8');
    f.runtime.storage.writeFileSync(intentPath, '{');
    const unreadable = readCustodyLedger(f.runtime, f.runDir).find(
      (entry) => entry.kind === 'unreadable' && entry.path === damagedPath,
    );
    if (unreadable?.kind !== 'unreadable') throw new Error('Fixture intent must be unreadable');
    expect(await pass()).toBe(ids[0]);
    expect(logs).toHaveLength(1);
    f.runtime.storage.writeFileSync(intentPath, 'broken');
    expect(await pass(0)).toBe(ids[0]);
    expect(logs).toHaveLength(1);
    f.runtime.storage.writeFileSync(intentPath, intact);
    expect(await pass()).toBe(ids[1]);
    expect(logs).toHaveLength(1);
    expect(await pass()).toBe('');
    expect(logs).toHaveLength(2);
    expect(summary(logs[1]).counts).toEqual({ unreadable: 1 });
    expect(summary(logs[1]).changed).toContainEqual({
      entry: damagedPath,
      disposition: 'unreadable',
      reason: unreadable.reason,
    });

    expect(await pass()).toBe(ids[0]);
    expect(logs).toHaveLength(2);
    expect(await pass()).toBe(ids[1]);
    expect(logs).toHaveLength(2);
    expect(await pass()).toBe('');
    expect(logs).toHaveLength(2);
    expect(await pass()).toBe(ids[0]);
    expect(await pass()).toBe(ids[1]);
    expect(await pass()).toBe('');
    expect(logs).toHaveLength(2);
    expect(f.runtime.process.kill).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('retains damage when a zero-allowance sweep resumes at its unchanged empty cursor', async () => {
  const f = createCustodyRetentionFixture(createRetentionFixture());
  const logs: string[] = [];
  const pass = (canContinue: () => boolean) =>
    reconcileFinishedCustody({
      runtime: f.runtime,
      runDir: f.runDir,
      index: f.index,
      afterId: '',
      budget: { canContinue, record: (outcome) => f.outcomes.push(outcome) },
      signal: new AbortController().signal,
      mutate: (operation) => operation(),
      log: (line) => logs.push(line),
    });
  try {
    const ids = Array.from({ length: 2 }, () => f.bound('future-owner').intent.id).sort();
    expect(await pass(() => true)).toBe('');
    expect(logs).toHaveLength(1);
    const damagedPath = join(custodyLedgerDir(f.runDir), ids[0]);
    const intentPath = join(damagedPath, 'intent.v1.json');
    const intact = f.runtime.storage.readFileSync(intentPath, 'utf-8');
    f.runtime.storage.writeFileSync(intentPath, '{');
    expect(await pass(() => false)).toBe('');
    expect(logs).toHaveLength(1);
    f.runtime.storage.writeFileSync(intentPath, intact);
    expect(await pass(() => true)).toBe('');
    expect(logs).toHaveLength(2);
    expect(summary(logs[1]).counts).toEqual({ unreadable: 1 });
    expect(summary(logs[1]).changed).toContainEqual({
      entry: damagedPath,
      disposition: 'unreadable',
      reason: expect.any(String),
    });
    expect(await pass(() => true)).toBe('');
    expect(logs).toHaveLength(2);
    expect(await pass(() => true)).toBe('');
    expect(logs).toHaveLength(2);
  } finally {
    f.close();
  }
});

it('does not publish an incomplete scope after zero allowance or an unknown cursor resume', async () => {
  const f = createCustodyRetentionFixture(createRetentionFixture());
  const logs: string[] = [];
  const pass = (afterId: string, canContinue: () => boolean) =>
    reconcileFinishedCustody({
      runtime: f.runtime,
      runDir: f.runDir,
      index: f.index,
      afterId,
      budget: { canContinue, record: (outcome) => f.outcomes.push(outcome) },
      signal: new AbortController().signal,
      mutate: (operation) => operation(),
      log: (line) => logs.push(line),
    });
  try {
    const ids = Array.from({ length: 3 }, () => f.bound('future-owner').intent.id).sort();
    expect(await pass('', () => false)).toBe('');
    expect(logs).toEqual([]);
    expect(await pass(ids[0], () => true)).toBe('');
    expect(logs).toEqual([]);
    expect(await pass('', () => true)).toBe('');
    expect(logs).toHaveLength(1);
    expect(summary(logs[0]).counts).toEqual({ holding: 3 });
  } finally {
    f.close();
  }
});

it('does not spend valid-entry budget or add reads when reporting unreadable entries', async () => {
  const f = createCustodyRetentionFixture(createRetentionFixture());
  const readFile = vi.spyOn(f.runtime.storage, 'readFileSync');
  const readDirectory = vi.spyOn(f.runtime.storage, 'readdirSync');
  try {
    const valid = Array.from({ length: 3 }, () => f.bound('future-owner').intent.id).sort();
    for (let i = 0; i < 3; i++) f.runtime.storage.mkdirSync(join(custodyLedgerDir(f.runDir), `!unreadable-${i}`));
    const entries = await readCustodyLedgerAsync(f.runtime, f.runDir);
    const pass = async (log?: (line: string) => void) => {
      let remaining = 2;
      let allowanceCalls = 0;
      const outcomes: typeof f.outcomes = [];
      readFile.mockClear();
      readDirectory.mockClear();
      const cursor = await reconcileFinishedCustody({
        runtime: f.runtime,
        runDir: f.runDir,
        index: f.index,
        afterId: '',
        entries,
        budget: {
          canContinue: () => {
            allowanceCalls++;
            return remaining-- > 0;
          },
          record: (outcome) => outcomes.push(outcome),
        },
        signal: new AbortController().signal,
        mutate: (operation) => operation(),
        log,
      });
      return {
        cursor,
        allowanceCalls,
        outcomes,
        files: readFile.mock.calls.map(([path]) => path),
        directories: readDirectory.mock.calls.map(([path]) => path),
      };
    };
    const control = await pass();
    const logged = await pass(() => {});
    expect(control.cursor).toBe(valid[1]);
    expect(control.allowanceCalls).toBe(3);
    expect(control.outcomes.map((outcome) => outcome.subject)).toEqual(valid.slice(0, 2));
    expect(logged).toEqual(control);
  } finally {
    readFile.mockRestore();
    readDirectory.mockRestore();
    f.close();
  }
});

it('does not turn a diagnostic failure into a failed custody discharge', async () => {
  const f = createCustodyRetentionFixture(createRetentionFixture());
  try {
    f.bound();
    await reconcileFinishedCustody({
      runtime: f.runtime,
      runDir: f.runDir,
      index: f.index,
      afterId: '',
      budget: f.budget,
      signal: new AbortController().signal,
      mutate: (operation) => operation(),
      log: () => {
        throw new Error('diagnostics unavailable');
      },
    });
    expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'absent' }]);
    expect(f.outcomes).toEqual([]);
    expect(f.runtime.process.kill).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it.each([false, true])(
  'retains observed damage when the final root listing fails (previous hold: %s)',
  (previousHold) => {
    const f = createCustodyRetentionFixture(createRetentionFixture());
    const logs: string[] = [];
    const pass = () =>
      reconcileStartupCustody(f.runtime, f.runDir, 500, f.db, 'epoch-1', undefined, undefined, (line) =>
        logs.push(line),
      );
    const record = providerOperationRecord('prepare-pending');
    const intent = recordCustodyIntent(f.runtime, f.runDir, {
      effect: 'provider-operation-publication',
      epoch: 'epoch-1',
      owner: 'provider-operation',
      operationId: record.operation.operationId,
      capsule: null,
      nowMs: 100,
      bindWithinMs: 1_000,
    });
    const directory = custodyLedgerDir(f.runDir);
    const entry = join(directory, intent.id);
    f.runtime.storage.writeFileSync(join(entry, 'binding.v1.json'), '{');
    const readDirectory = f.runtime.storage.readdirSync.bind(f.runtime.storage);
    let listings = 0;
    let unreadable: { mockRestore(): void } | undefined;
    try {
      if (previousHold) {
        expect(pass()).toMatchObject([{ kind: 'holding' }]);
        logs.length = 0;
      }
      insertProviderOperation(f.db, record);
      unreadable = vi.spyOn(f.runtime.storage, 'readdirSync').mockImplementation((path, options) => {
        if (path === directory && ++listings === 2)
          throw Object.assign(new Error('ledger unreadable'), { code: 'EACCES' });
        return readDirectory(path, options);
      });
      expect(pass()).toMatchObject([{ kind: 'unreadable', path: directory }]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('state=held');
      expect(logs.some((line) => line.startsWith('custody-damage '))).toBe(false);
      const detail = JSON.parse(logs[0].slice(logs[0].indexOf('detail=') + 'detail='.length));
      expect(detail.counts.cleared).toBe(0);
      expect(detail.changes).not.toContainEqual(expect.objectContaining({ kind: 'cleared', identity: entry }));
      if (!previousHold) {
        expect(detail.changes).toContainEqual(
          expect.objectContaining({
            kind: 'added',
            identity: entry,
            reason: [
              JSON.stringify({ disposition: 'holding', reason: 'identity binding is incomplete or mismatched' }),
            ],
          }),
        );
      }
      unreadable.mockRestore();
      expect(pass()).toMatchObject([{ kind: 'bound' }]);
      expect(logs).toHaveLength(2);
      expect(logs[1]).toContain('state=cleared');
      pass();
      expect(logs).toHaveLength(2);
    } finally {
      unreadable?.mockRestore();
      f.close();
    }
  },
);

it('reports initial unreadable-root evidence and successful listing recovery in the same pass', () => {
  const f = createCustodyRetentionFixture(createRetentionFixture());
  const entry = f.bound('future-owner');
  const directory = custodyLedgerDir(f.runDir);
  const readDirectory = f.runtime.storage.readdirSync.bind(f.runtime.storage);
  let listings = 0;
  const unreadable = vi.spyOn(f.runtime.storage, 'readdirSync').mockImplementation((path, options) => {
    if (path === directory && ++listings === 1)
      throw Object.assign(new Error('initial root unreadable'), { code: 'EACCES' });
    return readDirectory(path, options);
  });
  const logs: string[] = [];
  const pass = () =>
    reconcileStartupCustody(f.runtime, f.runDir, 500, f.db, 'epoch-1', undefined, undefined, (line) => logs.push(line));
  try {
    expect(pass()).toMatchObject([{ kind: 'bound', intent: { id: entry.intent.id } }]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^custody-damage /);
    expect(JSON.parse(logs[0].slice('custody-damage '.length))).toMatchObject({
      counts: { reported: 1, cleared: 1 },
      entries: [
        {
          entry: directory,
          observed: { disposition: 'unreadable', reason: expect.stringContaining('initial root unreadable') },
          final: { scope: 'ledger-listing', readable: true },
          cleared: true,
        },
      ],
    });
    pass();
    expect(logs).toHaveLength(1);
  } finally {
    unreadable.mockRestore();
    f.close();
  }
});
