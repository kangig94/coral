import * as locks from '#src/infra/fs-lock.js';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindCustodyProcessTicket, parseCustodyProcessTicket } from '../../../src/infra/custody-process-ticket.js';
import { processIncarnationSchema } from '../../../src/infra/node-process.js';
import { createRealRuntime } from '../../../src/runtime/real.js';

import {
  bindCustodyChild,
  bindCustodyIdentity,
  custodyLedgerDir,
  readCustodyLedger,
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
