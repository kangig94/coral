import * as locks from '#src/infra/fs-lock.js';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { clearImmediate, setImmediate } from 'node:timers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindCustodyProcessTicket, parseCustodyProcessTicket } from '../../../src/infra/custody-process-ticket.js';
import { processIncarnationSchema } from '../../../src/infra/node-process.js';
import { createRealRuntime } from '../../../src/runtime/real.js';
import { createBackgroundPhaseObserver, startRecoveryPhase } from '#src/recovery/phase-observation.js';
import type { RetentionOutcome } from '#src/store/retention-outcome.js';

import {
  bindCustodyChild,
  bindCustodyIdentity,
  custodyLedgerDir,
  pruneCustodyLedger,
  readCustodyLedger,
  readCustodyLedgerAsync,
  reconcileCustodyLedger,
  recordCustodyIntent,
} from '../../../src/store/custody-ledger.js';

const roots: string[] = [];

function runDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-custody-'));
  roots.push(root);
  return join(root, 'run');
}

function runtimeFor(run: string) {
  return createRealRuntime('prod', { baseDir: dirname(run) });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('custody ledger', () => {
  it('keeps stable retention inventories silent and reports an actual retirement', async () => {
    const run = runDir();
    const runtime = runtimeFor(run);
    const retained = recordCustodyIntent(runtime, run, {
      effect: 'provider-operation-publication',
      epoch: 'epoch-2',
      owner: 'provider-operation',
      operationId: 'retained-operation',
      capsule: null,
      bindWithinMs: 1_000,
      nowMs: 100,
    });
    bindCustodyIdentity(runtime, run, retained, { process: null, capsule: null, observedAtMs: 200 });
    const log = vi.fn();
    const startPhase = createBackgroundPhaseObserver({
      time: { ...runtime.time, monotonicNow: () => 0n },
      log,
      bootId: 'retention-test',
      phase: 'custody-retention',
    });
    const outcomes: RetentionOutcome[] = [];
    const pass = async () => {
      const phase = startPhase();
      const counts = { reads: 0, subjects: 0 };
      await expect(
        pruneCustodyLedger({
          runtime,
          runDir: run,
          cutoff: 2_000,
          afterId: '',
          budget: {
            canContinue: () => true,
            record: (outcome) => outcomes.push(outcome),
            observation: {
              record: (source, observed) => {
                counts.reads += observed.reads ?? 0;
                counts.subjects += observed.subjects ?? 0;
                phase.record(source, observed);
              },
            },
          },
          mutate: (operation) => operation(),
        }),
      ).resolves.toBe('');
      phase.finish();
      expect(counts.reads).toBeGreaterThan(0);
      return counts.subjects;
    };
    for (let attempt = 0; attempt < 3; attempt++) expect(await pass()).toBe(0);
    expect(log).not.toHaveBeenCalled();
    const retired = recordCustodyIntent(runtime, run, {
      effect: 'process-spawn',
      epoch: 'epoch-2',
      owner: 'durable-cli',
      operationId: 'retired-operation',
      capsule: null,
      bindWithinMs: 1_000,
      nowMs: 100,
    });
    reconcileCustodyLedger(runtime, run, 1_200, 100, (intent) => ({
      kind: 'absent',
      processToken: intent.processToken,
      evidence: 'exact process token absent',
    }));
    expect(await pass()).toBeGreaterThan(0);
    expect(outcomes).toContainEqual({ kind: 'deleted', subject: retired.id, count: 1 });
    expect(existsSync(join(custodyLedgerDir(run), retired.id))).toBe(false);
    expect(readCustodyLedger(runtime, run)).toMatchObject([{ kind: 'bound', intent: { id: retained.id } }]);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('event=finish outcome=complete'));
    log.mockClear();
    expect(await pass()).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('stops reading an interrupted multi-batch discovery without returning a partial ledger', async () => {
    const run = runDir();
    const runtime = runtimeFor(run);
    vi.spyOn(runtime.storage, 'fdatasyncSync').mockImplementation(() => undefined);
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockReturnValue(true);
    const intentPaths = Array.from({ length: 600 }, (_, entry) => {
      const intent = recordCustodyIntent(runtime, run, {
        effect: 'process-spawn',
        epoch: 'epoch-2',
        owner: 'durable-cli',
        operationId: `job-${entry}`,
        capsule: null,
        bindWithinMs: 1_000,
        nowMs: 100,
      });
      return join(custodyLedgerDir(run), intent.id, 'intent.v1.json');
    });
    const readPaths: string[] = [];
    const fileReads: string[] = [];
    let interruptedReads: { intents: string[]; files: string[] } | undefined;
    let interrupt: NodeJS.Immediate | undefined;
    const failure = new Error('discovery-aborted');
    const readFile = runtime.storage.readFileSync.bind(runtime.storage);
    const reads = vi.spyOn(runtime.storage, 'readFileSync').mockImplementation((path, encoding) => {
      fileReads.push(String(path));
      const content = readFile(path, encoding);
      if (typeof path === 'string' && path.endsWith('/intent.v1.json')) {
        readPaths.push(path);
        if (readPaths.length === 300) {
          interrupt = setImmediate(() => {
            interruptedReads = { intents: [...readPaths], files: [...fileReads] };
          });
        }
      }
      return content;
    });
    try {
      await expect(
        readCustodyLedgerAsync(runtime, run, undefined, () => {
          if (interruptedReads !== undefined) throw failure;
        }),
      ).rejects.toBe(failure);
      expect(interruptedReads).toBeDefined();
      expect(interruptedReads!.intents.length).toBeGreaterThanOrEqual(300);
      expect(interruptedReads!.intents.length).toBeLessThan(intentPaths.length);
      expect(readPaths).toEqual(interruptedReads!.intents);
      expect(fileReads).toEqual(interruptedReads!.files);
      expect(intentPaths.some((path) => !readPaths.includes(path))).toBe(true);
    } finally {
      clearImmediate(interrupt);
      reads.mockRestore();
    }
  });

  it('should read the same ledger while yielding as it reads without yielding', async () => {
    const run = runDir();
    const runtime = runtimeFor(run);
    vi.spyOn(runtime.storage, 'fdatasyncSync').mockImplementation(() => undefined);
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockReturnValue(true);
    for (let entry = 0; entry < 300; entry++) {
      recordCustodyIntent(runtime, run, {
        effect: 'process-spawn',
        epoch: 'epoch-2',
        owner: 'durable-cli',
        operationId: `job-${entry}`,
        capsule: null,
        bindWithinMs: 1_000,
        nowMs: 100,
      });
    }

    const read = await readCustodyLedgerAsync(runtime, run);
    expect(read).toHaveLength(300);
    expect(read).toEqual(readCustodyLedger(runtime, run));
  });

  it('keeps unchanged held custody silent and reports its transition to proven absence once', () => {
    const run = runDir();
    const runtime = runtimeFor(run);
    const intent = recordCustodyIntent(runtime, run, {
      effect: 'process-spawn',
      epoch: 'epoch-2',
      owner: 'durable-cli',
      operationId: 'job-1',
      capsule: null,
      bindWithinMs: 1_000,
      nowMs: 100,
    });
    const logs: string[] = [];
    const pass = (absent: boolean) => {
      const phase = startRecoveryPhase({
        kind: 'background',
        phase: 'custody-reconciliation',
        bootId: 'custody-test',
        time: { ...runtime.time, monotonicNow: () => 0n },
        log: (line) => logs.push(line),
      });
      const result = reconcileCustodyLedger(
        runtime,
        run,
        1_200,
        100,
        () =>
          absent
            ? { kind: 'absent', processToken: intent.processToken, evidence: 'exact token absent' }
            : { kind: 'unknown' },
        phase,
      );
      phase.finish();
      return result;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(pass(false)).toMatchObject([{ kind: 'holding', intent: { id: intent.id } }]);
    }
    expect(logs).toEqual([]);
    expect(pass(true)).toMatchObject([{ kind: 'absent', intent: { id: intent.id } }]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/event=finish outcome=complete.*subjects=1 reads=[1-9]\d*/);
    expect(pass(true)).toMatchObject([{ kind: 'absent', intent: { id: intent.id } }]);
    expect(logs).toHaveLength(1);
  });

  it('should hold a crash after intent until deadline, grace, and absence evidence', () => {
    const run = runDir();
    const intent = recordCustodyIntent(runtimeFor(run), run, {
      effect: 'process-spawn',
      epoch: 'epoch-2',
      owner: 'durable-cli',
      operationId: 'job-1',
      capsule: null,
      bindWithinMs: 1_000,
      nowMs: 100,
    });

    expect(readCustodyLedger(runtimeFor(run), run)).toMatchObject([{ kind: 'holding' }]);
    expect(
      reconcileCustodyLedger(runtimeFor(run), run, 1_099, 100, () => ({
        kind: 'absent',
        processToken: intent.processToken,
        evidence: 'no process',
      })),
    ).toMatchObject([{ kind: 'holding' }]);
    expect(reconcileCustodyLedger(runtimeFor(run), run, 1_200, 100, () => ({ kind: 'unknown' }))).toMatchObject([
      { kind: 'holding' },
    ]);
    expect(reconcileCustodyLedger(runtimeFor(run), run, 1_200, 100, () => ({ kind: 'alive' }))).toMatchObject([
      { kind: 'holding' },
    ]);
    expect(
      reconcileCustodyLedger(runtimeFor(run), run, 1_200, 100, () => ({
        kind: 'absent',
        processToken: 'wrong',
        evidence: 'other process',
      })),
    ).toMatchObject([{ kind: 'holding' }]);
    expect(
      reconcileCustodyLedger(runtimeFor(run), run, 1_200, 100, () => ({
        kind: 'absent',
        processToken: intent.processToken,
        evidence: 'capsule intact; token absent',
      })),
    ).toMatchObject([{ kind: 'absent', intent: { id: intent.id } }]);
    expect(readCustodyLedger(runtimeFor(run), run)).toMatchObject([{ kind: 'absent' }]);
  });

  it('should recover a child binding when the parent crashes before observing the spawned process', () => {
    const run = runDir();
    const intent = recordCustodyIntent(runtimeFor(run), run, {
      effect: 'process-spawn',
      epoch: 'epoch-3',
      owner: 'provider-proxy-set',
      operationId: 'set-1',
      capsule: '/capsule',
      bindWithinMs: 1_000,
      nowMs: 100,
    });
    bindCustodyChild(
      runtimeFor(run),
      { runDir: run, intentId: intent.id, processToken: intent.processToken },
      { pid: 4123, incarnation: processIncarnationSchema.parse('linux:boot:2'), processGroupId: 4123 },
      300,
    );

    expect(readCustodyLedger(runtimeFor(run), run)).toMatchObject([
      {
        kind: 'bound',
        intent: { processToken: intent.processToken },
        binding: { process: { pid: 4123 } },
      },
    ]);
    const bindingPath = join(custodyLedgerDir(run), intent.id, 'binding.v1.json');
    writeFileSync(bindingPath, JSON.stringify({ ...JSON.parse(readFileSync(bindingPath, 'utf8')), futureField: true }));
    expect(readCustodyLedger(runtimeFor(run), run)).toMatchObject([{ kind: 'bound' }]);
    expect(
      reconcileCustodyLedger(runtimeFor(run), run, 10_000, 100, () => ({
        kind: 'absent',
        processToken: intent.processToken,
        evidence: 'stale',
      })),
    ).toMatchObject([{ kind: 'bound' }]);
    expect(JSON.parse(readFileSync(bindingPath, 'utf8'))).toMatchObject({ futureField: true });
  });

  it('should self-fence a late child even when its parent bound the observed pid', () => {
    const run = runDir();
    const intent = recordCustodyIntent(runtimeFor(run), run, {
      effect: 'process-spawn',
      epoch: 'epoch-3',
      owner: 'durable-cli',
      operationId: 'job-3',
      capsule: null,
      bindWithinMs: 1_000,
      nowMs: 100,
    });
    const ticket = {
      runDir: run,
      epoch: intent.epoch,
      intentId: intent.id,
      processToken: intent.processToken,
      processGroupId: null,
    };
    bindCustodyIdentity(runtimeFor(run), run, intent, {
      process: { pid: 4123, incarnation: processIncarnationSchema.parse('linux:boot:3'), processGroupId: 4123 },
      capsule: null,
      observedAtMs: 200,
    });
    expect(() => bindCustodyProcessTicket(ticket, { pid: 4123, incarnation: 'linux:boot:3' }, 1_101)).toThrow(
      'expired',
    );
    expect(readCustodyLedger(runtimeFor(run), run)).toMatchObject([{ kind: 'bound' }]);
  });

  it('should let the child and parent bind the same observed process in either order', () => {
    const run = runDir();
    const intent = recordCustodyIntent(runtimeFor(run), run, {
      effect: 'process-spawn',
      epoch: 'epoch-3',
      owner: 'provider-proxy-set',
      operationId: 'set-3',
      capsule: '/capsule',
      bindWithinMs: 1_000,
      nowMs: 100,
    });
    const ticket = {
      runDir: run,
      epoch: intent.epoch,
      intentId: intent.id,
      processToken: intent.processToken,
      processGroupId: null,
    };
    bindCustodyProcessTicket(ticket, { pid: 4123, incarnation: 'linux:boot:3' }, 200);
    expect(
      bindCustodyIdentity(runtimeFor(run), run, intent, {
        process: { pid: 4123, incarnation: processIncarnationSchema.parse('linux:boot:3'), processGroupId: 4123 },
        capsule: '/capsule',
        observedAtMs: 400,
      }).observedAtMs,
    ).toBe(200);
    expect(readCustodyLedger(runtimeFor(run), run)).toMatchObject([
      { kind: 'bound', binding: { process: { pid: 4123 } } },
    ]);
  });

  it('should keep unknown keys readable and malformed binding evidence on hold', () => {
    const run = runDir();
    const intent = recordCustodyIntent(runtimeFor(run), run, {
      effect: 'process-spawn',
      epoch: 'epoch-4',
      owner: 'durable-cli',
      operationId: 'job-2',
      capsule: null,
      bindWithinMs: 1_000,
      nowMs: 100,
    });
    const path = join(custodyLedgerDir(run), intent.id, 'intent.v1.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), futureField: true }));
    expect(readCustodyLedger(runtimeFor(run), run)).toMatchObject([{ kind: 'holding' }]);
    expect(() =>
      bindCustodyIdentity(runtimeFor(run), run, intent, {
        process: { pid: 1, incarnation: processIncarnationSchema.parse('linux:boot:2'), processGroupId: 1 },
        capsule: null,
        observedAtMs: 1_101,
      }),
    ).toThrow('deadline');
    expect(readCustodyLedger(runtimeFor(run), run)).toMatchObject([{ kind: 'holding' }]);
  });

  it('should settle an incomplete identity binding only after process absence is proven', () => {
    const run = runDir();
    const intent = recordCustodyIntent(runtimeFor(run), run, {
      effect: 'process-spawn',
      epoch: 'epoch-4',
      owner: 'durable-cli',
      operationId: 'job-4',
      capsule: null,
      bindWithinMs: 1_000,
      nowMs: 100,
    });
    writeFileSync(join(custodyLedgerDir(run), intent.id, 'binding.v1.json'), '{"pid":');
    expect(readCustodyLedger(runtimeFor(run), run)).toMatchObject([
      { kind: 'holding', reason: 'identity binding is incomplete or mismatched' },
    ]);
    expect(
      reconcileCustodyLedger(runtimeFor(run), run, 1_199, 100, () => ({
        kind: 'absent',
        processToken: intent.processToken,
        evidence: 'token absent',
      })),
    ).toMatchObject([{ kind: 'holding' }]);
    expect(
      reconcileCustodyLedger(runtimeFor(run), run, 1_200, 100, () => ({
        kind: 'absent',
        processToken: intent.processToken,
        evidence: 'token absent',
      })),
    ).toMatchObject([{ kind: 'absent' }]);
    expect(readCustodyLedger(runtimeFor(run), run)).toMatchObject([{ kind: 'absent' }]);
  });

  it.each(['{', JSON.stringify({ version: 'v1', intentId: 'wrong' })])(
    'recovers damaged absence evidence (%s) without discarding the intent',
    (damage) => {
      const run = runDir();
      const runtime = runtimeFor(run);
      const intent = recordCustodyIntent(runtime, run, {
        effect: 'process-spawn',
        epoch: 'epoch-4',
        owner: 'durable-cli',
        operationId: 'job-damaged',
        capsule: null,
        bindWithinMs: 1_000,
        nowMs: 100,
      });
      const directory = join(custodyLedgerDir(run), intent.id);
      const receipt = join(directory, 'absence.v1.json');
      writeFileSync(receipt, damage);
      expect(readCustodyLedger(runtime, run)).toMatchObject([{ kind: 'holding', intent }]);
      expect(readFileSync(receipt, 'utf8')).toBe(damage);
      expect(reconcileCustodyLedger(runtime, run, 1_200, 100, () => ({ kind: 'unknown' }))).toMatchObject([
        { kind: 'holding', intent },
      ]);
      expect(existsSync(receipt)).toBe(false);
      const quarantined = readdirSync(directory).find((name) => name.startsWith('absence.v1.json.damaged.'));
      expect(quarantined).toBeDefined();
      expect(readFileSync(join(directory, quarantined!), 'utf8')).toBe(damage);
      expect(
        reconcileCustodyLedger(runtime, run, 1_200, 100, () => ({
          kind: 'absent',
          processToken: runtime.ids.uuid(),
          evidence: 'wrong token',
        })),
      ).toMatchObject([{ kind: 'holding' }]);
      expect(existsSync(receipt)).toBe(false);
      expect(
        reconcileCustodyLedger(runtime, run, 1_200, 100, () => ({
          kind: 'absent',
          processToken: intent.processToken,
          evidence: 'matching token absent',
        })),
      ).toMatchObject([{ kind: 'absent' }]);
      expect(readCustodyLedger(runtime, run)).toMatchObject([{ kind: 'absent' }]);
    },
  );

  it('should bind a published operation without inventing a process', () => {
    const run = runDir();
    const intent = recordCustodyIntent(runtimeFor(run), run, {
      effect: 'provider-operation-publication',
      epoch: 'epoch-5',
      owner: 'provider-operation',
      operationId: 'operation-1',
      capsule: null,
      bindWithinMs: 1_000,
      nowMs: 100,
    });
    expect(() =>
      bindCustodyIdentity(runtimeFor(run), run, intent, {
        process: { pid: 1, incarnation: processIncarnationSchema.parse('linux:boot:2'), processGroupId: 1 },
        capsule: null,
        observedAtMs: 200,
      }),
    ).toThrow('intended effect');
    bindCustodyIdentity(runtimeFor(run), run, intent, { process: null, capsule: null, observedAtMs: 200 });
    expect(readCustodyLedger(runtimeFor(run), run)).toMatchObject([{ kind: 'bound', binding: { process: null } }]);
  });
});

it.each([
  { createdAtMs: Number.MAX_SAFE_INTEGER + 1 },
  { bindDeadlineMs: Number.MAX_SAFE_INTEGER + 1 },
  { bindDeadlineMs: 99 },
])('retains semantically invalid custody intent as unreadable: %j', (damage) => {
  const run = runDir();
  const runtime = runtimeFor(run);
  const intent = recordCustodyIntent(runtime, run, {
    effect: 'process-spawn',
    epoch: 'epoch-1',
    owner: 'provider-host',
    operationId: 'operation',
    capsule: null,
    bindWithinMs: 1_000,
    nowMs: 100,
  });
  const path = join(custodyLedgerDir(run), intent.id, 'intent.v1.json');
  writeFileSync(path, JSON.stringify({ ...intent, ...damage, futureField: 'preserved' }));
  expect(readCustodyLedger(runtime, run)).toMatchObject([{ kind: 'unreadable' }]);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ futureField: 'preserved' });
});

it('holds an unsafe process identity rather than proving absence', () => {
  const run = runDir();
  const runtime = runtimeFor(run);
  const intent = recordCustodyIntent(runtime, run, {
    effect: 'process-spawn',
    epoch: 'epoch-1',
    owner: 'provider-host',
    operationId: 'operation',
    capsule: null,
    bindWithinMs: 1_000,
    nowMs: 100,
  });
  bindCustodyIdentity(runtime, run, intent, {
    process: { pid: 100, incarnation: processIncarnationSchema.parse('linux:boot:2'), processGroupId: 100 },
    capsule: null,
    observedAtMs: 200,
  });
  const path = join(custodyLedgerDir(run), intent.id, 'binding.v1.json');
  const binding = JSON.parse(readFileSync(path, 'utf8'));
  binding.process.pid = Number.MAX_SAFE_INTEGER + 1;
  writeFileSync(path, JSON.stringify(binding));
  expect(readCustodyLedger(runtime, run)).toMatchObject([
    { kind: 'holding', reason: 'identity binding is incomplete or mismatched' },
  ]);
});

it.each([' ', 'lineage:1', '00000000-0000-4000-8000-000000000001:01'])(
  'refuses a malformed child custody lineage: %s',
  (epochKey) => {
    expect(() =>
      parseCustodyProcessTicket(
        JSON.stringify({
          runDir: '/run',
          epoch: '/epoch-1',
          intentId: '00000000-0000-4000-8000-000000000001',
          processToken: '00000000-0000-4000-8000-000000000002',
          processGroupId: null,
          epochKey,
        }),
      ),
    ).toThrow();
  },
);

it('gives a custody write a bounded lock wait without repairing the guard', () => {
  const run = runDir();
  const runtime = runtimeFor(run);
  const epoch = join(dirname(run), 'db', 'epoch-1');
  mkdirSync(epoch, { recursive: true });
  writeFileSync(
    join(epoch, '.coral-lineage.v1.json'),
    JSON.stringify({ version: 'v1', lineageId: '00000000-0000-4000-8000-000000000001' }),
  );
  writeFileSync(join(epoch, '.coral-custody-coverage.v1.json'), '{}');
  const lock = vi.spyOn(locks, 'acquireSharedFileLockNoRepairSync').mockImplementation((_path, budget = 0) => {
    if (!budget) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    return () => {};
  });
  try {
    const intent = recordCustodyIntent(runtime, run, {
      effect: 'process-spawn',
      epoch,
      owner: 'durable-cli',
      operationId: 'one',
      capsule: null,
      bindWithinMs: 100,
      nowMs: 0,
    });
    expect(intent.epochKey).toBe('00000000-0000-4000-8000-000000000001:1');
    expect(lock).toHaveBeenCalledWith(join(epoch, '.lock'), 5000);
  } finally {
    lock.mockRestore();
  }
});
