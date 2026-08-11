import { describe, expect, it } from 'vitest';

import {
  LedgerError,
  MAX_PROVIDER_REPLAY_BYTES,
  MAX_PROVIDER_REPLAY_EVENTS,
  MAX_PROXY_SHARED_REPLAY_BYTES,
  PROXY_PENDING_ACTIVATION_LEASE_MS,
  createOperationLedger,
  type OperationLedger,
  type ProviderOperationKey,
} from '#src/provider-proxy/ledger.js';
import { ReplayAdmissionError } from '#src/provider-proxy/replay-budget.js';
import { providerProxyEmergencyEvent } from '#src/providers/proxy-failure.js';
import {
  PROVIDER_EVENT_METHOD,
  encodeProxyControlFrame,
  providerEventRequestSchema,
} from '#src/provider-proxy/protocol.js';
import { asJointContainmentReceipt, asReservation } from '#tests/helpers/provider-proxy-correlation.js';

const KEY: ProviderOperationKey = { jobId: 'job-1', operationId: 'op-1' };
const WIRE_KEY: ProviderOperationKey = {
  jobId: '11111111-1111-4111-8111-111111111111',
  operationId: '22222222-2222-4222-8222-222222222222',
};

function wireLedger(): OperationLedger {
  return createOperationLedger({
    encodeProxyEmergencyCompletion: ({ key, providerSeq, frameId, event }) => {
      const request = providerEventRequestSchema.parse({
        operation: {
          ...key,
          proxyInstanceId: '33333333-3333-4333-8333-333333333333',
          buildSetId: '44444444-4444-4444-8444-444444444444',
        },
        providerSeq,
        event,
      });
      return {
        providerSeq,
        frame: encodeProxyControlFrame({
          jsonrpc: '2.0',
          id: frameId,
          method: PROVIDER_EVENT_METHOD,
          params: request,
        }),
      };
    },
  });
}

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
  ledger.recordEvent(key, event, { kind: 'ordinary' });
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

  it('admits the next event after an acknowledgement frees the per-operation event ceiling', async () => {
    const ledger = createOperationLedger();
    executing(ledger);
    for (let seq = 1; seq <= MAX_PROVIDER_REPLAY_EVENTS; seq += 1) {
      await recordEvent(ledger, { providerSeq: seq, frame: 'x' });
    }

    expect(() =>
      ledger.recordEvent(KEY, { providerSeq: MAX_PROVIDER_REPLAY_EVENTS + 1, frame: 'x' }, { kind: 'ordinary' }),
    ).toThrow(expect.objectContaining({ code: 'replay_admission_refused', scope: 'operation-events' }));
    ledger.acknowledge(KEY, MAX_PROVIDER_REPLAY_EVENTS);
    ledger.recordEvent(KEY, { providerSeq: MAX_PROVIDER_REPLAY_EVENTS + 1, frame: 'x' }, { kind: 'ordinary' });
    expect(ledger.get(KEY)?.bufferedBytes).toBe(1);
  });

  it('does not let an ineligible operation head-block an eligible operation below shared capacity', async () => {
    const ledger = createOperationLedger();
    const blockedKey = { jobId: 'job-1', operationId: 'blocked' };
    const eligibleKey = { jobId: 'job-1', operationId: 'eligible' };
    executing(ledger, blockedKey);
    executing(ledger, eligibleKey);
    for (let seq = 1; seq <= MAX_PROVIDER_REPLAY_EVENTS; seq += 1) {
      await recordEvent(ledger, { providerSeq: seq, frame: 'x' }, blockedKey);
    }

    try {
      void ledger.recordEvent(
        blockedKey,
        { providerSeq: MAX_PROVIDER_REPLAY_EVENTS + 1, frame: 'blocked' },
        { kind: 'ordinary' },
      );
    } catch {
      // Synchronous refusal is the expected final behavior.
    }
    void ledger.recordEvent(eligibleKey, { providerSeq: 1, frame: 'eligible' }, { kind: 'ordinary' });
    await Promise.resolve();

    expect(ledger.get(eligibleKey)?.bufferedEvents).toHaveLength(1);
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
    const sharedChunks = [
      MAX_PROVIDER_REPLAY_BYTES,
      MAX_PROVIDER_REPLAY_BYTES,
      MAX_PROVIDER_REPLAY_BYTES,
      MAX_PROXY_SHARED_REPLAY_BYTES - 3 * MAX_PROVIDER_REPLAY_BYTES,
    ];
    for (const [index, bytes] of sharedChunks.entries()) {
      const key = keys[index];
      if (key === undefined) throw new Error('Expected a shared replay operation.');
      ledger.recordEvent(key, { providerSeq: 1, frame: 'x'.repeat(bytes) }, { kind: 'ordinary' });
    }
    const refusedKey = keys[4];
    if (refusedKey === undefined) throw new Error('Expected a fifth operation.');
    expect(() => ledger.recordEvent(refusedKey, { providerSeq: 1, frame: 'x' }, { kind: 'ordinary' })).toThrow(
      expect.objectContaining({ code: 'replay_admission_refused', scope: 'proxy-shared-bytes' }),
    );

    const releasedKey = keys[0];
    if (releasedKey === undefined) throw new Error('Expected a reserved operation.');
    ledger.transition(releasedKey, 'terminal-awaiting-settlement');
    ledger.beginRelease(releasedKey);
    ledger.transition(releasedKey, 'released');

    ledger.recordEvent(refusedKey, { providerSeq: 1, frame: 'x' }, { kind: 'ordinary' });
    expect(ledger.get(refusedKey)?.bufferedEvents).toHaveLength(1);
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
    expect(() => ledger.recordEvent(KEY, { providerSeq: seq + 1, frame: 'x' }, { kind: 'ordinary' })).toThrow(
      expect.objectContaining({ code: 'replay_admission_refused', scope: 'operation-bytes' }),
    );
  });

  it('refuses a new operation while production reservations exhaust the proxy-wide byte budget', async () => {
    const ledger = createOperationLedger();
    const operations = Math.ceil(MAX_PROXY_SHARED_REPLAY_BYTES / MAX_PROVIDER_REPLAY_BYTES);
    const keys: ProviderOperationKey[] = [];
    for (let index = 0; index < operations; index += 1) {
      const key = { jobId: 'job-1', operationId: `op-${index}` };
      executing(ledger, key);
      keys.push(key);
    }
    let remaining = MAX_PROXY_SHARED_REPLAY_BYTES;
    for (const key of keys) {
      const bytes = Math.min(remaining, MAX_PROVIDER_REPLAY_BYTES);
      ledger.recordEvent(key, { providerSeq: 1, frame: 'x'.repeat(bytes) }, { kind: 'ordinary' });
      remaining -= bytes;
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

    expect(caught).toBeInstanceOf(ReplayAdmissionError);
    expect(caught).toMatchObject({ code: 'replay_admission_refused', scope: 'operation-bytes' });
    // Refused, not partially buffered: nothing was recorded, so the sequence floor did not move.
    expect(ledger.get(KEY)?.bufferedEvents).toEqual([]);
    expect(ledger.nextProviderSeq(KEY)).toBe(1);
  });

  it('records only a runtime-validated closed event through the proxy-emergency entry point', () => {
    const ledger = wireLedger();
    executing(ledger, WIRE_KEY);
    const event = providerProxyEmergencyEvent({ reason: 'provider_replay_operation_events_exhausted' });

    ledger.recordProxyEmergencyCompletion(WIRE_KEY, event, Number.MAX_SAFE_INTEGER);

    const entry = ledger.get(WIRE_KEY);
    expect(entry?.bufferedEvents).toHaveLength(1);
    expect(Buffer.byteLength(entry?.bufferedEvents[0]?.frame ?? '', 'utf8')).toBeLessThanOrEqual(641);
  });

  it('rejects an open emergency shape before its frame encoder can reach the reserved lane', () => {
    const ledger = wireLedger();
    executing(ledger, WIRE_KEY);
    const event = providerProxyEmergencyEvent({ reason: 'provider_replay_operation_events_exhausted' });

    expect(() =>
      ledger.recordProxyEmergencyCompletion(
        WIRE_KEY,
        { ...event, diagnostics: { warnings: [] } },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow();
    expect(ledger.get(WIRE_KEY)?.bufferedEvents).toEqual([]);
  });

  it('does not let generic recordEvent select emergency-completion admission', () => {
    const ledger = createOperationLedger();
    executing(ledger);

    expect(() =>
      ledger.recordEvent(KEY, { providerSeq: 1, frame: 'not closed' }, { kind: 'emergency-completion' } as never),
    ).toThrow(/Unsupported replay admission kind/u);
    expect(ledger.get(KEY)?.bufferedEvents).toEqual([]);
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
