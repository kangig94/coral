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
import { asJointContainmentReceipt, asReservation } from '#tests/helpers/provider-proxy-correlation.js';

const KEY: ProviderOperationKey = { jobId: 'job-1', operationId: 'op-1' };

function reserved(ledger: OperationLedger, key = KEY, nowMs = 0): void {
  const result = ledger.prepare({ key, reservation: asReservation('res-1'), prepared: {}, nowMs });
  if (result.kind !== 'reserved') throw new Error('expected a reservation');
  ledger.recordPreparation(key, { pid: 1, processStartedAtSeconds: 1 }, asJointContainmentReceipt('contained'));
}

function executing(ledger: OperationLedger, key = KEY, nowMs = 0): void {
  reserved(ledger, key, nowMs);
  activate(ledger, key, nowMs);
}

function activate(ledger: OperationLedger, key = KEY, nowMs = 0): void {
  const fingerprint = 'f'.repeat(64);
  ledger.beginActivation(key, asReservation('res-1'), nowMs, fingerprint);
  ledger.completeActivation(key, fingerprint, {
    state: 'executing',
    activationFingerprint: fingerprint,
    startedAt: new Date(0).toISOString(),
    hostRef: {
      provider: 'test',
      fingerprint: '0'.repeat(64),
      instanceId: `test:${key.operationId}`,
      leaseMode: 'job-exclusive',
      ownerJobId: key.jobId,
    },
    committedThroughProviderSeq: 0,
  });
}

describe('provider-proxy operation ledger', () => {
  it('walks the only permitted terminal path', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    activate(ledger);
    ledger.transition(KEY, 'terminal-awaiting-settlement');
    ledger.beginRelease(KEY);
    ledger.transition(KEY, 'released');

    expect(ledger.get(KEY)).toBeNull();
  });

  it('refuses a transition the state machine does not name', () => {
    const ledger = createOperationLedger();
    reserved(ledger);
    activate(ledger);

    expect(() => ledger.transition(KEY, 'prepared')).toThrow(LedgerError);
  });

  it('refuses an expired reservation without fabricating another phase', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    expect(() =>
      ledger.beginActivation(KEY, asReservation('res-1'), PROXY_PENDING_ACTIVATION_LEASE_MS, 'f'.repeat(64)),
    ).toThrow(/lease expired/u);

    expect(ledger.get(KEY)?.state).toBe('prepared');
    ledger.beginRelease(KEY);
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

    activate(ledger, KEY, 10_000);
    expect(() => ledger.renew(KEY, asReservation('res-1'), 10_000)).toThrow(/Cannot renew from executing/u);
  });

  it('refuses a renew after the lease has expired without lazily changing state', () => {
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
    expect(ledger.get(KEY)?.state).toBe('prepared');
  });

  it('refuses activation that presents a different reservation', () => {
    const ledger = createOperationLedger();
    executing(ledger);

    // Formerly two assertions — a wrong id and a wrong nonce — because the entry carried two values and
    // `activate` compared both while `renew` compared only the first. One value cannot half-match, so the
    // asymmetry that made that possible is gone along with the second field.
    expect(() => ledger.beginActivation(KEY, asReservation('other-reservation'), 0, 'f'.repeat(64))).toThrow(
      /different reservation/u,
    );
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
    executing(ledger);
    ledger.recordEvent(KEY, { providerSeq: 1, frame: 'x'.repeat(10) });

    expect(() => ledger.recordEvent(KEY, { providerSeq: 1, frame: 'x'.repeat(10) })).toThrow(/monotonically/u);
  });

  it('pauses at the per-operation event ceiling and resumes on the acknowledgement that frees it', () => {
    const ledger = createOperationLedger();
    executing(ledger);
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
    executing(ledger);
    ledger.recordEvent(KEY, { providerSeq: 1, frame: 'x'.repeat(5) });
    ledger.acknowledge(KEY, 1);

    expect(() => ledger.acknowledge(KEY, 0)).toThrow(/backwards/u);
  });

  it('returns released capacity to the proxy-wide budget', () => {
    const ledger = createOperationLedger();
    executing(ledger);
    ledger.recordEvent(KEY, { providerSeq: 1, frame: 'x'.repeat(1_024) });

    ledger.transition(KEY, 'terminal-awaiting-settlement');
    ledger.beginRelease(KEY);
    ledger.transition(KEY, 'released');

    // A second operation of the same size proves the released bytes were returned, not leaked.
    executing(ledger, { jobId: 'job-1', operationId: 'op-2' });
    expect(
      ledger.recordEvent({ jobId: 'job-1', operationId: 'op-2' }, { providerSeq: 1, frame: 'x'.repeat(1_024) }),
    ).toEqual({
      paused: false,
    });
  });

  it('returns the existing reservation for a repeated prepare and refuses a conflicting one', () => {
    const ledger = createOperationLedger();
    reserved(ledger);

    expect(ledger.prepare({ key: KEY, reservation: asReservation('res-1'), prepared: {}, nowMs: 0 })).toMatchObject({
      kind: 'reserved',
    });

    expect(() => ledger.prepare({ key: KEY, reservation: asReservation('other'), prepared: {}, nowMs: 0 })).toThrow(
      LedgerError,
    );
  });

  it('pauses on the per-operation byte ceiling with far fewer than the event ceiling', () => {
    const ledger = createOperationLedger();
    executing(ledger);
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
      executing(ledger, key);
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
    activate(ledger);

    ledger.transition(KEY, 'suspended-awaiting-durable-decision');

    // A suspended operation awaits a durable decision; it cannot slip back into executing or terminal.
    expect(() => ledger.transition(KEY, 'executing')).toThrow(LedgerError);
    expect(() => ledger.transition(KEY, 'terminal-awaiting-settlement')).toThrow(LedgerError);
    ledger.beginRelease(KEY);
    ledger.transition(KEY, 'released');
    expect(ledger.get(KEY)).toBeNull();
  });

  it('computes the next providerSeq from the newest buffered event, or the acknowledged floor once empty', () => {
    const ledger = createOperationLedger();
    executing(ledger);

    expect(ledger.nextProviderSeq(KEY)).toBe(1);

    ledger.recordEvent(KEY, { providerSeq: 1, frame: 'first' });
    ledger.recordEvent(KEY, { providerSeq: 2, frame: 'second' });
    expect(ledger.nextProviderSeq(KEY)).toBe(3);

    ledger.acknowledge(KEY, 2);
    expect(ledger.nextProviderSeq(KEY)).toBe(3);
  });

  it('refuses to buffer a single event that alone exceeds the per-operation byte budget', () => {
    const ledger = createOperationLedger();
    executing(ledger);

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

    ledger.beginRelease({ jobId: 'job-1', operationId: 'op-1' });
    ledger.transition({ jobId: 'job-1', operationId: 'op-1' }, 'released');
    expect(ledger.keys()).toEqual([{ jobId: 'job-1', operationId: 'op-2' }]);
  });
});
