import { describe, expect, it } from 'vitest';

import {
  LedgerError,
  MAX_PROVIDER_REPLAY_BYTES,
  MAX_PROVIDER_REPLAY_EVENTS,
  MAX_PROXY_REPLAY_BYTES,
  PROXY_PENDING_ACTIVATION_LEASE_MS,
  createOperationLedger,
  type OperationLedger,
  type ProviderOperationKey,
} from '#src/provider-proxy/ledger.js';
import { asReservation } from '#tests/helpers/provider-proxy-correlation.js';

const KEY: ProviderOperationKey = { jobId: 'job-1', operationId: 'op-1' };

function reserved(ledger: OperationLedger, key = KEY, nowMs = 0): void {
  const result = ledger.prepare({ key, reservation: asReservation('res-1'), prepared: {}, nowMs });
  if (result.kind !== 'reserved') throw new Error('expected a reservation');
}

describe('provider-proxy operation ledger', () => {
  it('walks the only permitted terminal path', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    ledger.activate(KEY, asReservation('res-1'), 0);
    ledger.transition(KEY, 'terminal-awaiting-journal-ack');
    ledger.transition(KEY, 'released');

    expect(ledger.get(KEY)).toBeNull();
  });

  it('refuses a transition the state machine does not name', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    ledger.activate(KEY, asReservation('res-1'), 0);

    // executing never reaches pending-recovery: only an unactivated reservation can.
    expect(() => ledger.transition(KEY, 'pending-recovery')).toThrow(LedgerError);
  });

  it('turns an expired reservation into pending-recovery that stays queryable', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    expect(() => ledger.activate(KEY, asReservation('res-1'), PROXY_PENDING_ACTIVATION_LEASE_MS)).toThrow(
      /lease expired/u,
    );

    // Execution is forbidden, but the exact reservation is still there to be cancelled.
    expect(ledger.get(KEY)?.state).toBe('pending-recovery');
    ledger.transition(KEY, 'released');
    expect(ledger.get(KEY)).toBeNull();
  });

  it('renews only while still pending activation and only for the same reservation', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    expect(ledger.renew(KEY, asReservation('res-1'), 10_000).leaseExpiresAtMs).toBe(
      10_000 + PROXY_PENDING_ACTIVATION_LEASE_MS,
    );
    expect(() => ledger.renew(KEY, asReservation('other'), 10_000)).toThrow(/different reservation/u);

    ledger.activate(KEY, asReservation('res-1'), 10_000);
    expect(() => ledger.renew(KEY, asReservation('res-1'), 10_000)).toThrow(/Cannot renew from executing/u);
  });

  it('refuses a renew after the lease has expired and moves the entry to pending-recovery', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    let caught: unknown;
    try {
      ledger.renew(KEY, asReservation('res-1'), PROXY_PENDING_ACTIVATION_LEASE_MS);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LedgerError);
    expect((caught as InstanceType<typeof LedgerError>).code).toBe('reservation_expired');
    // Forbidding execution is the point, but the reservation itself must stay queryable so control can
    // still cancel exactly it rather than losing track of what it authorized.
    expect(ledger.get(KEY)?.state).toBe('pending-recovery');
  });

  it('refuses activation that presents a different reservation', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    // Formerly two assertions — a wrong id and a wrong nonce — because the entry carried two values and
    // `activate` compared both while `renew` compared only the first. One value cannot half-match, so the
    // asymmetry that made that possible is gone along with the second field.
    expect(() => ledger.activate(KEY, asReservation('other-reservation'), 0)).toThrow(/different reservation/u);
  });

  it('reports capacity as a retryable refusal that reserves nothing', () => {
    const ledger = createOperationLedger();
    for (let index = 0; index < 128; index += 1) {
      reserved(ledger, { jobId: 'job-1', operationId: `op-${index}` });
    }

    const refused = ledger.prepare({
      key: { jobId: 'job-1', operationId: 'op-128' },
      reservation: asReservation('res-x'),
      prepared: {},
      nowMs: 0,
    });

    expect(refused).toEqual({ kind: 'capacity', retryable: true, reason: 'operation-ledgers' });
    expect(ledger.get({ jobId: 'job-1', operationId: 'op-128' })).toBeNull();
  });

  it('requires provider sequences to increase', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    ledger.recordEvent(KEY, { providerSeq: 1, frame: 'x'.repeat(10) });

    expect(() => ledger.recordEvent(KEY, { providerSeq: 1, frame: 'x'.repeat(10) })).toThrow(/monotonically/u);
  });

  it('pauses at the per-operation event ceiling and resumes on the acknowledgement that frees it', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    let paused = false;
    for (let seq = 1; seq <= MAX_PROVIDER_REPLAY_EVENTS; seq += 1) {
      paused = ledger.recordEvent(KEY, { providerSeq: seq, frame: 'x' }).paused;
    }

    expect(paused).toBe(true);
    expect(ledger.acknowledge(KEY, MAX_PROVIDER_REPLAY_EVENTS).resumed).toBe(true);
    expect(ledger.get(KEY)?.bufferedBytes).toBe(0);
  });

  it('refuses an acknowledgement that moves backwards', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    ledger.recordEvent(KEY, { providerSeq: 1, frame: 'x'.repeat(5) });
    ledger.acknowledge(KEY, 1);

    expect(() => ledger.acknowledge(KEY, 0)).toThrow(/backwards/u);
  });

  it('returns released capacity to the proxy-wide budget', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    ledger.recordEvent(KEY, { providerSeq: 1, frame: 'x'.repeat(1_024) });

    ledger.transition(KEY, 'released');

    // A second operation of the same size proves the released bytes were returned, not leaked.
    reserved(ledger, { jobId: 'job-1', operationId: 'op-2' });
    expect(
      ledger.recordEvent({ jobId: 'job-1', operationId: 'op-2' }, { providerSeq: 1, frame: 'x'.repeat(1_024) }),
    ).toEqual({
      paused: false,
    });
  });

  it('returns the existing reservation for a repeated prepare and refuses a conflicting one', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    // A retry of the same request must not be a conflict; only a different payload for one identity is.
    reserved(ledger);

    expect(() => ledger.prepare({ key: KEY, reservation: asReservation('other'), prepared: {}, nowMs: 0 })).toThrow(
      LedgerError,
    );
  });

  it('pauses on the per-operation byte ceiling with far fewer than the event ceiling', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    const chunk = 'x'.repeat(1024 * 1024);

    let paused = false;
    let seq = 0;
    while (!paused) {
      seq += 1;
      paused = ledger.recordEvent(KEY, { providerSeq: seq, frame: chunk }).paused;
    }

    // Byte pressure must bite on its own; the count ceiling is nowhere near reached here.
    expect(seq).toBeLessThan(MAX_PROVIDER_REPLAY_EVENTS);
    expect(ledger.get(KEY)?.bufferedBytes).toBeGreaterThanOrEqual(MAX_PROVIDER_REPLAY_BYTES);
  });

  it('refuses a new reservation once the proxy-wide byte budget is spent', () => {
    const ledger = createOperationLedger();
    const chunk = 'x'.repeat(1024 * 1024);
    let seq = 0;

    // Each operation stops at its own ceiling, so several together are what reach the proxy-wide budget.
    const perOperation = MAX_PROVIDER_REPLAY_BYTES / chunk.length;
    const operations = MAX_PROXY_REPLAY_BYTES / MAX_PROVIDER_REPLAY_BYTES;
    for (let index = 0; index < operations; index += 1) {
      const key = { jobId: 'job-1', operationId: `op-${index}` };
      reserved(ledger, key);
      for (let event = 0; event < perOperation; event += 1) {
        seq += 1;
        ledger.recordEvent(key, { providerSeq: seq, frame: chunk });
      }
    }

    const refused = ledger.prepare({
      key: { jobId: 'job-1', operationId: 'late' },
      reservation: asReservation('res-late'),
      prepared: {},
      nowMs: 0,
    });

    expect(refused).toEqual({ kind: 'capacity', retryable: true, reason: 'replay-bytes' });
  });

  it('reaches released only through the suspend arm once suspended', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    ledger.activate(KEY, asReservation('res-1'), 0);

    ledger.transition(KEY, 'suspended-awaiting-durable-decision');

    // A suspended operation awaits a durable decision; it cannot slip back into executing or terminal.
    expect(() => ledger.transition(KEY, 'executing')).toThrow(LedgerError);
    expect(() => ledger.transition(KEY, 'terminal-awaiting-journal-ack')).toThrow(LedgerError);
    ledger.transition(KEY, 'released');
    expect(ledger.get(KEY)).toBeNull();
  });

  it('treats a repeated activation of a running operation as the same request', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    ledger.activate(KEY, asReservation('res-1'), 0);

    // Arriving after the lease would otherwise demote a live kernel to pending-recovery.
    ledger.activate(KEY, asReservation('res-1'), PROXY_PENDING_ACTIVATION_LEASE_MS * 2);

    expect(ledger.get(KEY)?.state).toBe('executing');
  });

  it('computes the next providerSeq from the newest buffered event, or the acknowledged floor once empty', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    expect(ledger.nextProviderSeq(KEY)).toBe(1);

    ledger.recordEvent(KEY, { providerSeq: 1, frame: 'first' });
    ledger.recordEvent(KEY, { providerSeq: 2, frame: 'second' });
    expect(ledger.nextProviderSeq(KEY)).toBe(3);

    ledger.acknowledge(KEY, 2);
    expect(ledger.nextProviderSeq(KEY)).toBe(3);
  });

  it('refuses to buffer a single event that alone exceeds the per-operation byte budget', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    let caught: unknown;
    try {
      ledger.recordEvent(KEY, { providerSeq: 1, frame: 'x'.repeat(MAX_PROVIDER_REPLAY_BYTES + 1) });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LedgerError);
    expect((caught as InstanceType<typeof LedgerError>).code).toBe('replay_capacity_exhausted');
    // Refused, not partially buffered: nothing was recorded, so the sequence floor did not move.
    expect(ledger.get(KEY)?.bufferedEvents).toEqual([]);
    expect(ledger.nextProviderSeq(KEY)).toBe(1);
  });

  it('lists every held operation for resuming a drain after a control tenancy reattaches', () => {
    const ledger = createOperationLedger();
    expect(ledger.keys()).toEqual([]);

    reserved(ledger, { jobId: 'job-1', operationId: 'op-1' });
    reserved(ledger, { jobId: 'job-1', operationId: 'op-2' });

    expect(ledger.keys()).toEqual(
      expect.arrayContaining([
        { jobId: 'job-1', operationId: 'op-1' },
        { jobId: 'job-1', operationId: 'op-2' },
      ]),
    );
    expect(ledger.keys()).toHaveLength(2);

    ledger.transition({ jobId: 'job-1', operationId: 'op-1' }, 'released');
    expect(ledger.keys()).toEqual([{ jobId: 'job-1', operationId: 'op-2' }]);
  });
});
