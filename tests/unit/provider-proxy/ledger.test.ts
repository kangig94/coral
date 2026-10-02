import type * as MockedReplayBudgetModule from '#src/provider-proxy/replay-budget.js';
vi.mock('#src/provider-proxy/replay-budget.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MockedReplayBudgetModule>();
  return {
    ...actual,
    ReplayBudget: class extends actual.ReplayBudget {
      constructor() {
        super(16, 2048);
      }
    },
  };
});

import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';

import { createOperationLedger, type OperationLedger, type ProviderOperationKey } from '#src/provider-proxy/ledger.js';
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
  ledger.recordPreparation(key, { pid: 1, incarnation: testIncarnation(1) }, asJointContainmentReceipt('contained'));
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
  it('requires provider sequences to increase', async () => {
    const ledger = createOperationLedger();
    executing(ledger);
    await recordEvent(ledger, { providerSeq: 1, frame: 'x'.repeat(10) });

    await expect(recordEvent(ledger, { providerSeq: 1, frame: 'x'.repeat(10) })).rejects.toThrow(/monotonically/u);
  });

  it('releases replay capacity on cumulative ACK before admitting the next event', () => {
    const ledger = createOperationLedger();
    executing(ledger);
    ledger.recordEvent(KEY, { providerSeq: 1, frame: 'old' }, { kind: 'ordinary' });
    ledger.acknowledge(KEY, 1);
    expect(ledger.get(KEY)?.bufferedBytes).toBe(0);
    ledger.recordEvent(KEY, { providerSeq: 2, frame: 'x'.repeat(16) }, { kind: 'ordinary' });
    expect(ledger.get(KEY)?.bufferedBytes).toBe(16);
  });

  it('returns released capacity to the proxy-wide budget', () => {
    const ledger = createOperationLedger();
    executing(ledger);
    const next = { jobId: 'job-1', operationId: 'op-2' };
    executing(ledger, next);
    ledger.recordEvent(KEY, { providerSeq: 1, frame: 'x'.repeat(16) }, { kind: 'ordinary' });
    expect(() => ledger.recordEvent(next, { providerSeq: 1, frame: 'next' }, { kind: 'ordinary' })).toThrow(
      /exhausted/u,
    );
    ledger.transition(KEY, 'terminal-awaiting-settlement');
    ledger.beginRelease(KEY);
    ledger.transition(KEY, 'released');
    ledger.recordEvent(next, { providerSeq: 1, frame: 'next' }, { kind: 'ordinary' });
    expect(ledger.get(next)?.bufferedBytes).toBe(4);
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
});
