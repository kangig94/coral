import { describe, expect, it, vi } from 'vitest';

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

async function recordEvent(
  ledger: OperationLedger,
  event: Readonly<{ providerSeq: number; frame: string }>,
  key = KEY,
): Promise<void> {
  await ledger.recordEvent(key, event, { kind: 'ordinary' });
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

  it('requires provider sequences to increase', async () => {
    const ledger = createOperationLedger();
    executing(ledger);
    await recordEvent(ledger, { providerSeq: 1, frame: 'x'.repeat(10) });

    await expect(recordEvent(ledger, { providerSeq: 1, frame: 'x'.repeat(10) })).rejects.toThrow(/monotonically/u);
  });

  it('admits the next event when an acknowledgement frees the per-operation event ceiling', async () => {
    const ledger = createOperationLedger();
    executing(ledger);
    for (let seq = 1; seq <= MAX_PROVIDER_REPLAY_EVENTS; seq += 1) {
      await recordEvent(ledger, { providerSeq: seq, frame: 'x' });
    }

    let wasAdmitted = false;
    const admitted = ledger
      .recordEvent(KEY, { providerSeq: MAX_PROVIDER_REPLAY_EVENTS + 1, frame: 'x' }, { kind: 'ordinary' })
      .then(() => {
        wasAdmitted = true;
      });
    await Promise.resolve();
    expect(wasAdmitted).toBe(false);
    ledger.acknowledge(KEY, MAX_PROVIDER_REPLAY_EVENTS);
    await admitted;
    expect(wasAdmitted).toBe(true);
    expect(ledger.get(KEY)?.bufferedBytes).toBe(1);
  });

  it('refuses an acknowledgement that moves backwards', async () => {
    const ledger = createOperationLedger();
    executing(ledger);
    await recordEvent(ledger, { providerSeq: 1, frame: 'x'.repeat(5) });
    ledger.acknowledge(KEY, 1);

    expect(() => ledger.acknowledge(KEY, 0)).toThrow(/backwards/u);
  });

  it('returns released capacity to the proxy-wide budget', async () => {
    const ledger = createOperationLedger();
    const keys = Array.from({ length: 5 }, (_, index) => ({ jobId: 'job-1', operationId: `op-${index}` }));
    for (const key of keys) executing(ledger, key);
    await Promise.all(
      keys
        .slice(0, 4)
        .map((key) =>
          ledger.recordEvent(
            key,
            { providerSeq: 1, frame: 'x'.repeat(MAX_PROVIDER_REPLAY_BYTES) },
            { kind: 'ordinary' },
          ),
        ),
    );
    const waitingKey = keys[4];
    if (waitingKey === undefined) throw new Error('Expected a fifth operation.');
    let wasAdmitted = false;
    const waiting = ledger.recordEvent(waitingKey, { providerSeq: 1, frame: 'x' }, { kind: 'ordinary' }).then(() => {
      wasAdmitted = true;
    });
    await Promise.resolve();
    expect(wasAdmitted).toBe(false);

    const releasedKey = keys[0];
    if (releasedKey === undefined) throw new Error('Expected a reserved operation.');
    ledger.transition(releasedKey, 'terminal-awaiting-settlement');
    ledger.beginRelease(releasedKey);
    ledger.transition(releasedKey, 'released');

    await vi.waitFor(() => expect(wasAdmitted).toBe(true));
    await waiting;
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

  it('holds production at the per-operation byte ceiling with far fewer than the event ceiling', async () => {
    const ledger = createOperationLedger();
    executing(ledger);
    const chunk = 'x'.repeat(1024 * 1024);

    let seq = 0;
    while ((ledger.get(KEY)?.bufferedBytes ?? 0) < MAX_PROVIDER_REPLAY_BYTES) {
      seq += 1;
      await recordEvent(ledger, { providerSeq: seq, frame: chunk });
    }

    // Byte pressure must bite on its own; the count ceiling is nowhere near reached here.
    expect(seq).toBeLessThan(MAX_PROVIDER_REPLAY_EVENTS);
    expect(ledger.get(KEY)?.bufferedBytes).toBeGreaterThanOrEqual(MAX_PROVIDER_REPLAY_BYTES);
    const controller = new AbortController();
    let wasAdmitted = false;
    const waiting = ledger
      .recordEvent(KEY, { providerSeq: seq + 1, frame: 'x' }, { kind: 'ordinary', signal: controller.signal })
      .then(() => {
        wasAdmitted = true;
      });
    await Promise.resolve();
    expect(wasAdmitted).toBe(false);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses a new operation while production reservations exhaust the proxy-wide byte budget', async () => {
    const ledger = createOperationLedger();
    const operations = MAX_PROXY_REPLAY_BYTES / MAX_PROVIDER_REPLAY_BYTES;
    const keys: ProviderOperationKey[] = [];
    for (let index = 0; index < operations; index += 1) {
      const key = { jobId: 'job-1', operationId: `op-${index}` };
      executing(ledger, key);
      keys.push(key);
    }
    await Promise.all(
      keys.map((key) =>
        ledger.recordEvent(key, { providerSeq: 1, frame: 'x'.repeat(MAX_PROVIDER_REPLAY_BYTES) }, { kind: 'ordinary' }),
      ),
    );

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

  it('computes the next providerSeq from the newest buffered event, or the acknowledged floor once empty', async () => {
    const ledger = createOperationLedger();
    executing(ledger);

    expect(ledger.nextProviderSeq(KEY)).toBe(1);

    await recordEvent(ledger, { providerSeq: 1, frame: 'first' });
    await recordEvent(ledger, { providerSeq: 2, frame: 'second' });
    expect(ledger.nextProviderSeq(KEY)).toBe(3);

    ledger.acknowledge(KEY, 2);
    expect(ledger.nextProviderSeq(KEY)).toBe(3);
  });

  it('refuses to buffer a single event that alone exceeds the per-operation byte budget', async () => {
    const ledger = createOperationLedger();
    executing(ledger);

    let caught: unknown;
    try {
      await recordEvent(ledger, { providerSeq: 1, frame: 'x'.repeat(MAX_PROVIDER_REPLAY_BYTES + 1) });
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
