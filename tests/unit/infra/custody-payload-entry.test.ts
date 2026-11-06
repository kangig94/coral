import { recordedHostFailureDomain } from '#src/coordinator/services/recovery/host-failure-domain.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import type { CustodyEntry, CustodyBinding, CustodyIntent } from '#src/store/custody-ledger.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  bindCustodyProcessTicket,
  custodyPayloadEntered,
  observeCustodyPayloadEntry,
  recordChildRoleCustodyIntent,
  recordCustodyPayloadEntry,
} from '#src/infra/custody-process-ticket.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function boundHost() {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-payload-entry-'));
  directories.push(runDir);
  const ticket = recordChildRoleCustodyIntent({
    runDir,
    epoch: 'epoch',
    owner: 'provider-host',
    operationId: 'operation',
    capsule: null,
    nowMs: 1,
    bindWithinMs: 1000,
    processGroupId: null,
  });
  const identity = { pid: 4123, incarnation: testIncarnation(3), processGroupId: 4123 };
  bindCustodyProcessTicket(ticket, identity, 2);
  return { ticket, identity, read: (path: string) => readFileSync(path, 'utf8') };
}

it('requires separately recorded exact binding entry rather than binding alone', () => {
  const { ticket, identity, read } = boundHost();
  const binding = read(join(ticket.runDir, 'custody.v1', ticket.intentId, 'binding.v1.json'));
  expect(custodyPayloadEntered(ticket, identity, read)).toBe(false);
  recordCustodyPayloadEntry(ticket, identity);
  expect(custodyPayloadEntered(ticket, identity, read)).toBe(true);
  expect(custodyPayloadEntered(ticket, { ...identity, incarnation: testIncarnation(4) }, read)).toBe(false);
  expect(read(join(ticket.runDir, 'custody.v1', ticket.intentId, 'binding.v1.json'))).toBe(binding);
});

it('cannot record entry for a foreign process binding', () => {
  const { ticket, identity, read } = boundHost();
  expect(() => recordCustodyPayloadEntry(ticket, { ...identity, pid: 9999 })).toThrow(/matching binding/);
  expect(observeCustodyPayloadEntry(ticket, read)).toEqual({ kind: 'unproven' });
});

it('retains unreadable entry evidence rather than treating it as unproven', () => {
  const { ticket, read } = boundHost();
  writeFileSync(join(ticket.runDir, 'custody.v1', ticket.intentId, 'payload-entry.v1.json'), '{');
  expect(observeCustodyPayloadEntry(ticket, read)).toEqual({ kind: 'unobservable' });
});

it('carries exact entry evidence into a recovered host capability', () => {
  const { ticket, identity, read } = boundHost();
  const runtime = new SimulationRuntime();
  Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/fixture' } });
  runtime.process.failureDomainContainment = () => ({
    observe: () => ({ kind: 'absent' }),
    kill: () => ({ kind: 'entered' }),
  });
  runtime.storage.readFileSync = (path) => read(String(path));
  const directory = join(ticket.runDir, 'custody.v1', ticket.intentId);
  const host: Extract<CustodyEntry, { kind: 'bound' }> = {
    kind: 'bound',
    intent: JSON.parse(read(join(directory, 'intent.v1.json'))) as CustodyIntent,
    binding: JSON.parse(read(join(directory, 'binding.v1.json'))) as CustodyBinding,
  };
  const domain = recordedHostFailureDomain(runtime, ticket.runDir, host, [host]);
  expect(domain?.observe()).toEqual({ kind: 'absent' });
  expect(domain?.hasEntered?.()).toBe(false);
  recordCustodyPayloadEntry(ticket, identity);
  expect(domain?.hasEntered?.()).toBe(true);
});
