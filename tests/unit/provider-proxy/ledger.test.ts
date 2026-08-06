import { describe, expect, it } from 'vitest';

import {
  LedgerError,
  MAX_PROVIDER_REPLAY_EVENTS,
  PROXY_PENDING_ACTIVATION_LEASE_MS,
  createOperationLedger,
  type OperationLedger,
  type ProviderOperationKey,
} from '#src/provider-proxy/ledger.js';

const KEY: ProviderOperationKey = { jobId: 'job-1', operationId: 'op-1' };

function reserved(ledger: OperationLedger, key = KEY, nowMs = 0): void {
  const result = ledger.prepare({ key, reservationId: 'res-1', activationNonce: 'nonce-1', nowMs });
  if (result.kind !== 'reserved') throw new Error('expected a reservation');
}

describe('provider-proxy operation ledger', () => {
  it('walks the only permitted terminal path', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    ledger.activate(KEY, 'res-1', 'nonce-1', 0);
    ledger.transition(KEY, 'terminal-awaiting-journal-ack');
    ledger.transition(KEY, 'released');

    expect(ledger.get(KEY)).toBeNull();
    expect(ledger.size()).toBe(0);
  });

  it('refuses a transition the state machine does not name', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    ledger.activate(KEY, 'res-1', 'nonce-1', 0);

    // executing never reaches pending-recovery: only an unactivated reservation can.
    expect(() => ledger.transition(KEY, 'pending-recovery')).toThrow(LedgerError);
  });

  it('turns an expired reservation into pending-recovery that stays queryable', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    expect(() => ledger.activate(KEY, 'res-1', 'nonce-1', PROXY_PENDING_ACTIVATION_LEASE_MS)).toThrow(/lease expired/u);

    // Execution is forbidden, but the exact reservation is still there to be cancelled.
    expect(ledger.get(KEY)?.state).toBe('pending-recovery');
    ledger.transition(KEY, 'released');
    expect(ledger.get(KEY)).toBeNull();
  });

  it('renews only while still pending activation and only for the same reservation', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    expect(ledger.renew(KEY, 'res-1', 10_000).leaseExpiresAtMs).toBe(10_000 + PROXY_PENDING_ACTIVATION_LEASE_MS);
    expect(() => ledger.renew(KEY, 'other', 10_000)).toThrow(/different reservation/u);

    ledger.activate(KEY, 'res-1', 'nonce-1', 10_000);
    expect(() => ledger.renew(KEY, 'res-1', 10_000)).toThrow(/Cannot renew from executing/u);
  });

  it('refuses activation that presents a different nonce', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    expect(() => ledger.activate(KEY, 'res-1', 'forged', 0)).toThrow(/different reservation/u);
  });

  it('reports capacity as a retryable refusal that reserves nothing', () => {
    const ledger = createOperationLedger();
    for (let index = 0; index < 128; index += 1) {
      reserved(ledger, { jobId: 'job-1', operationId: `op-${index}` });
    }

    const refused = ledger.prepare({
      key: { jobId: 'job-1', operationId: 'op-128' },
      reservationId: 'res-x',
      activationNonce: 'nonce-x',
      nowMs: 0,
    });

    expect(refused).toEqual({ kind: 'capacity', retryable: true, reason: 'operation-ledgers' });
    expect(ledger.size()).toBe(128);
  });

  it('requires provider sequences to increase', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    ledger.recordEvent(KEY, { providerSeq: 1, byteLength: 10 });

    expect(() => ledger.recordEvent(KEY, { providerSeq: 1, byteLength: 10 })).toThrow(/monotonically/u);
  });

  it('pauses at the per-operation event ceiling and resumes on the acknowledgement that frees it', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    let paused = false;
    for (let seq = 1; seq <= MAX_PROVIDER_REPLAY_EVENTS; seq += 1) {
      paused = ledger.recordEvent(KEY, { providerSeq: seq, byteLength: 1 }).paused;
    }

    expect(paused).toBe(true);
    expect(ledger.acknowledge(KEY, MAX_PROVIDER_REPLAY_EVENTS).resumed).toBe(true);
    expect(ledger.get(KEY)?.bufferedBytes).toBe(0);
  });

  it('replays only what the consumer has not acknowledged', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    ledger.recordEvent(KEY, { providerSeq: 1, byteLength: 5 });
    ledger.recordEvent(KEY, { providerSeq: 2, byteLength: 5 });
    ledger.recordEvent(KEY, { providerSeq: 3, byteLength: 5 });

    ledger.acknowledge(KEY, 1);

    expect(ledger.replayFrom(KEY, 1).map((event) => event.providerSeq)).toEqual([2, 3]);
    expect(ledger.get(KEY)?.committedThroughProviderSeq).toBe(1);
  });

  it('refuses an acknowledgement that moves backwards', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    ledger.recordEvent(KEY, { providerSeq: 1, byteLength: 5 });
    ledger.acknowledge(KEY, 1);

    expect(() => ledger.acknowledge(KEY, 0)).toThrow(/backwards/u);
  });

  it('returns released capacity to the proxy-wide budget', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    ledger.recordEvent(KEY, { providerSeq: 1, byteLength: 1_024 });

    ledger.transition(KEY, 'released');

    // A second operation of the same size proves the released bytes were returned, not leaked.
    reserved(ledger, { jobId: 'job-1', operationId: 'op-2' });
    expect(ledger.recordEvent({ jobId: 'job-1', operationId: 'op-2' }, { providerSeq: 1, byteLength: 1_024 })).toEqual({
      paused: false,
    });
  });

  it('refuses a duplicate reservation for one operation', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    expect(() => reserved(ledger)).toThrow(LedgerError);
  });
});
