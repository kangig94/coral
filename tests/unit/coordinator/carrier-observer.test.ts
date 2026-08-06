import { describe, expect, it } from 'vitest';

import {
  MAX_CONCURRENT_OBSERVATIONS,
  MAX_OBSERVED_ENDPOINTS_PER_READ,
  MAX_OBSERVED_ROWS_PER_READ,
  MAX_OPERATIONS_PER_STATUS_REQUEST,
  OBSERVATION_REQUEST_TIMEOUT_MS,
  createCarrierObserver,
  type CarrierProbeTarget,
  type CarrierProbeTransport,
} from '#src/coordinator/live/carrier-observer.js';
import { MAX_PROXY_OPERATION_LEDGERS } from '#src/provider-proxy/ledger.js';
import { ControlClientError } from '#src/provider-proxy/control-client.js';
import type { OperationIdentity } from '#src/provider-proxy/protocol.js';

const BUILD_SET = '44444444-4444-4444-8444-444444444444';
const PROXY = '33333333-3333-4333-8333-333333333333';

function uuid(seed: number): string {
  return `${seed.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
}

function operation(seed: number): OperationIdentity {
  return { jobId: uuid(seed), operationId: uuid(seed + 100_000), proxyInstanceId: PROXY, buildSetId: BUILD_SET };
}

function target(seed: number, overrides: Partial<CarrierProbeTarget> = {}): CarrierProbeTarget {
  return { endpoint: '/tmp/proxy.sock', operation: operation(seed), expectedInstanceGone: false, ...overrides };
}

type Call = { endpoint: string; method: string; params: unknown; timeoutMs: number };

function recordingTransport(
  reply: (call: Call) => unknown | Promise<unknown>,
): CarrierProbeTransport & { calls: Call[]; inFlight: number; peakInFlight: number } {
  const state = {
    calls: [] as Call[],
    inFlight: 0,
    peakInFlight: 0,
    async call(endpoint: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
      state.calls.push({ endpoint, method, params, timeoutMs });
      state.inFlight += 1;
      state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
      try {
        return await reply({ endpoint, method, params, timeoutMs });
      } finally {
        state.inFlight -= 1;
      }
    },
  };
  return state;
}

function heldReply(operations: readonly OperationIdentity[], held = true): unknown {
  return {
    proxyInstanceId: PROXY,
    operations: operations.map((op) =>
      held
        ? { operation: op, held: true, state: 'executing', committedThroughProviderSeq: 3 }
        : { operation: op, held: false },
    ),
  };
}

describe('createCarrierObserver', () => {
  it('bounds a status request by exactly what the proxy will accept', () => {
    // The observer restates this cap instead of importing it, so that a coordinator read module does not
    // sit on the proxy's internal ledger seam. The equality is what makes the restatement safe: raise one
    // without the other and requests start being refused whole.
    expect(MAX_OPERATIONS_PER_STATUS_REQUEST).toBe(MAX_PROXY_OPERATION_LEDGERS);
  });

  it('reports a held operation as live with the state the proxy reported', async () => {
    const transport = recordingTransport(({ params }) =>
      heldReply((params as { operations: OperationIdentity[] }).operations),
    );
    const observer = createCarrierObserver({ transport });

    const read = await observer.observe([target(1)]);

    expect(read.overflowed).toBe(false);
    expect(read.results).toEqual([
      { operation: operation(1), liveness: 'live', state: 'executing', committedThroughProviderSeq: 3 },
    ]);
    expect(transport.calls[0].method).toBe('operation.status.v1');
    expect(transport.calls[0].timeoutMs).toBe(OBSERVATION_REQUEST_TIMEOUT_MS);
  });

  it('reports absence only from a proxy that answered and denied holding it', async () => {
    const transport = recordingTransport(({ params }) =>
      heldReply((params as { operations: OperationIdentity[] }).operations, false),
    );

    const read = await createCarrierObserver({ transport }).observe([target(1)]);

    expect(read.results[0].liveness).toBe('absent');
  });

  it('treats an operation missing from an otherwise valid reply as unknown', async () => {
    // The reply did not cover it, which is not the same as denying it. Reading silence as absence would
    // let a partial answer end a live job.
    const transport = recordingTransport(() => ({ proxyInstanceId: PROXY, operations: [] }));

    const read = await createCarrierObserver({ transport }).observe([target(1)]);

    expect(read.results[0].liveness).toBe('unknown');
  });

  it('treats a reply that does not match the contract as unknown', async () => {
    const transport = recordingTransport(() => ({ proxyInstanceId: PROXY, operations: [{ nonsense: true }] }));

    const read = await createCarrierObserver({ transport }).observe([target(1)]);

    expect(read.results[0].liveness).toBe('unknown');
  });

  describe('transport failure', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    it('is unknown without local proof that the expected instance is gone', async () => {
      // A socket can be missing because the process died, because it never finished binding, or because the
      // path was cleaned up under a proxy that is still running. Only the caller can tell those apart.
      const transport = recordingTransport(() => Promise.reject(refused));

      const read = await createCarrierObserver({ transport }).observe([target(1)]);

      expect(read.results[0].liveness).toBe('unknown');
    });

    it('is absent when the caller proved the recorded instance is gone', async () => {
      const transport = recordingTransport(() => Promise.reject(refused));

      const read = await createCarrierObserver({ transport }).observe([target(1, { expectedInstanceGone: true })]);

      expect(read.results[0].liveness).toBe('absent');
    });

    it.each([
      ['a timeout', new ControlClientError('control_call_failed', 'timed out')],
      ['a protocol error', new ControlClientError('control_call_failed', 'identity mismatch', 'identity_mismatch')],
      ['an unclassified failure', new Error('something else')],
    ])('is unknown for %s even with that proof', async (_label, error) => {
      const transport = recordingTransport(() => Promise.reject(error));

      const read = await createCarrierObserver({ transport }).observe([target(1, { expectedInstanceGone: true })]);

      expect(read.results[0].liveness).toBe('unknown');
    });
  });

  describe('bounds', () => {
    it('asks at most the endpoint cap and reports the rest as unknown overflow', async () => {
      const transport = recordingTransport(({ params }) =>
        heldReply((params as { operations: OperationIdentity[] }).operations),
      );
      const targets = Array.from({ length: MAX_OBSERVED_ENDPOINTS_PER_READ + 3 }, (_unused, index) =>
        target(index, { endpoint: `/tmp/proxy-${String(index).padStart(3, '0')}.sock` }),
      );

      const read = await createCarrierObserver({ transport }).observe(targets);

      expect(transport.calls).toHaveLength(MAX_OBSERVED_ENDPOINTS_PER_READ);
      expect(read.overflowed).toBe(true);
      expect(read.results.filter((result) => result.liveness === 'unknown')).toHaveLength(3);
    });

    it('drops the same endpoints every time, because the order is by bytes and not by insertion', async () => {
      const transport = recordingTransport(({ params }) =>
        heldReply((params as { operations: OperationIdentity[] }).operations),
      );
      const endpoints = Array.from(
        { length: MAX_OBSERVED_ENDPOINTS_PER_READ + 2 },
        (_unused, index) => `/tmp/proxy-${String(index).padStart(3, '0')}.sock`,
      );
      const forward = endpoints.map((endpoint, index) => target(index, { endpoint }));

      const first = await createCarrierObserver({ transport }).observe(forward);
      const firstAsked = transport.calls.map((call) => call.endpoint);
      transport.calls.length = 0;
      const second = await createCarrierObserver({ transport }).observe([...forward].reverse());

      expect(transport.calls.map((call) => call.endpoint)).toEqual(firstAsked);
      expect(firstAsked).toEqual([...firstAsked].sort());
      expect(second.overflowed).toBe(first.overflowed);
    });

    it('chunks one endpoint to the proxy request cap rather than truncating it', async () => {
      const transport = recordingTransport(({ params }) =>
        heldReply((params as { operations: OperationIdentity[] }).operations),
      );
      const targets = Array.from({ length: MAX_OPERATIONS_PER_STATUS_REQUEST + 5 }, (_unused, index) => target(index));

      const read = await createCarrierObserver({ transport }).observe(targets);

      expect(transport.calls).toHaveLength(2);
      expect((transport.calls[0].params as { operations: unknown[] }).operations).toHaveLength(
        MAX_OPERATIONS_PER_STATUS_REQUEST,
      );
      expect((transport.calls[1].params as { operations: unknown[] }).operations).toHaveLength(5);
      expect(read.results.every((result) => result.liveness === 'live')).toBe(true);
      expect(read.overflowed).toBe(false);
    });

    it('never exceeds the concurrency bound', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transport = recordingTransport(async ({ params }) => {
        await gate;
        return heldReply((params as { operations: OperationIdentity[] }).operations);
      });
      const targets = Array.from({ length: MAX_OBSERVED_ENDPOINTS_PER_READ }, (_unused, index) =>
        target(index, { endpoint: `/tmp/proxy-${String(index).padStart(3, '0')}.sock` }),
      );

      const pending = createCarrierObserver({ transport }).observe(targets);
      await Promise.resolve();
      release();
      await pending;

      expect(transport.peakInFlight).toBeLessThanOrEqual(MAX_CONCURRENT_OBSERVATIONS);
    });

    it('refuses a read larger than the row cap without asking anything', async () => {
      const transport = recordingTransport(() => {
        throw new Error('a refused read must contact nobody');
      });
      const targets = Array.from({ length: MAX_OBSERVED_ROWS_PER_READ + 1 }, (_unused, index) => target(index));

      const read = await createCarrierObserver({ transport }).observe(targets);

      expect(transport.calls).toHaveLength(0);
      expect(read.overflowed).toBe(true);
      expect(read.results.every((result) => result.liveness === 'unknown')).toBe(true);
    });
  });

  it('holds nothing across reads', async () => {
    let held = true;
    const transport = recordingTransport(({ params }) =>
      heldReply((params as { operations: OperationIdentity[] }).operations, held),
    );
    const observer = createCarrierObserver({ transport });

    expect((await observer.observe([target(1)])).results[0].liveness).toBe('live');
    held = false;
    // A cache would answer the second read from the first, which is the one thing an observation must not
    // do: it would report a carrier that has since gone as still present.
    expect((await observer.observe([target(1)])).results[0].liveness).toBe('absent');
    expect(transport.calls).toHaveLength(2);
  });
});
