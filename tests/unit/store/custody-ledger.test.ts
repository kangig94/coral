import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindCustodyProcessTicket } from '../../../src/infra/custody-process-ticket.js';
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
  it('should ignore an intent directory abandoned before publication', () => {
    const run = runDir();
    const intent = recordCustodyIntent(runtimeFor(run), run, {
      effect: 'process-spawn',
      epoch: 'epoch-2',
      owner: 'durable-cli',
      operationId: 'job-0',
      capsule: null,
      bindWithinMs: 1_000,
      nowMs: 100,
    });
    mkdirSync(join(custodyLedgerDir(run), '.stage.interrupted'));

    expect(readCustodyLedger(runtimeFor(run), run)).toMatchObject([{ kind: 'holding', intent: { id: intent.id } }]);
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
