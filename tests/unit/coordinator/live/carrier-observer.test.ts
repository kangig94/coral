import { describe, expect, it, vi } from 'vitest';

import {
  CARRIER_STATUS_MAX_CONCURRENT_CALLS,
  CARRIER_STATUS_MAX_ENDPOINT_REQUESTS,
  carrierStatusOperationKey,
  observeCarrierStatuses,
  scheduleCarrierStatusBatches,
  type CarrierStatusBatchResult,
  type CarrierStatusConnector,
  type CarrierStatusRecord,
} from '#src/coordinator/live/carrier-observer.js';
import { ControlClientError } from '#src/provider-proxy/control-client.js';
import {
  PROXY_OPERATION_STATUS_MAX_OPERATIONS,
  operationIdentitySchema,
  proxyOperationStatusNonceSchema,
  proxyOperationStatusParamsSchema,
  proxyOperationStatusResultSchema,
  type OperationIdentity,
  type ProxyOperationStatusNonce,
} from '#src/provider-proxy/protocol.js';
import { createDeferred } from '#tools/testing/deferred.js';

type TestRow = { key: string };

function rows(count: number, prefix = 'row'): TestRow[] {
  return Array.from({ length: count }, (_, index) => ({ key: `${prefix}-${index}` }));
}

function held(rows: readonly TestRow[]): CarrierStatusBatchResult<string> {
  return {
    kind: 'supported',
    outcomes: new Map(rows.map((row) => [row.key, 'held'])),
  };
}

function endpointLane<TEndpoint, TRow>(endpoint: TEndpoint, laneRows: readonly TRow[]) {
  return {
    batches: Array.from({ length: Math.ceil(laneRows.length / PROXY_OPERATION_STATUS_MAX_OPERATIONS) }, (_, index) => ({
      endpoint,
      rows: laneRows.slice(
        index * PROXY_OPERATION_STATUS_MAX_OPERATIONS,
        (index + 1) * PROXY_OPERATION_STATUS_MAX_OPERATIONS,
      ),
    })),
  };
}

const NONCE = proxyOperationStatusNonceSchema.parse('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
const FOREIGN_NONCE = proxyOperationStatusNonceSchema.parse('ffffffff-ffff-ffff-ffff-ffffffffffff');
const FOREIGN_PROXY_INSTANCE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FOREIGN_BUILD_SET_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const FOREIGN_JOB_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const FOREIGN_OPERATION_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const OPERATION_A = operationIdentitySchema.parse({
  jobId: '11111111-1111-1111-1111-111111111111',
  operationId: '22222222-2222-2222-2222-222222222222',
  proxyInstanceId: '33333333-3333-3333-3333-333333333333',
  buildSetId: '44444444-4444-4444-4444-444444444444',
});
const OPERATION_B = operationIdentitySchema.parse({
  ...OPERATION_A,
  jobId: '55555555-5555-5555-5555-555555555555',
  operationId: '66666666-6666-6666-6666-666666666666',
});
const PROXY_LOCATOR = {
  instanceId: OPERATION_A.proxyInstanceId,
  pid: 4_242,
  processStartedAtSeconds: 1_700_000_000,
  controlEndpoint: '/tmp/coral-carrier-status.sock',
} as const;

type StatusParams = ReturnType<typeof proxyOperationStatusParamsSchema.parse>;
type StatusResult = ReturnType<typeof proxyOperationStatusResultSchema.parse>;

const observerTimer = {
  setTimeout: () => ({}),
  clearTimeout: () => {},
};

function recordFor(
  operation: OperationIdentity,
  proxy: CarrierStatusRecord['locator']['proxy'] = PROXY_LOCATOR,
): CarrierStatusRecord {
  return { operation, locator: { proxy } };
}

function validStatusResult(request: StatusParams): StatusResult {
  const first = request.operations[0];
  if (first === undefined) throw new Error('status request fixture must contain an operation');
  return proxyOperationStatusResultSchema.parse({
    proxy: { proxyInstanceId: first.proxyInstanceId, buildSetId: first.buildSetId },
    nonce: request.nonce,
    operations: request.operations.map((operation, index) => ({
      operation,
      state: index === 0 ? 'held' : 'absent',
    })),
  });
}

function respondingConnector(reply: (request: StatusParams) => unknown = validStatusResult): Readonly<{
  connect: CarrierStatusConnector;
  requests: StatusParams[];
  close: ReturnType<typeof vi.fn>;
}> {
  const requests: StatusParams[] = [];
  const close = vi.fn();
  return {
    requests,
    close,
    connect: vi.fn<CarrierStatusConnector>(async () => ({
      call: async (_method, params) => {
        const request = proxyOperationStatusParamsSchema.parse(params);
        requests.push(request);
        return reply(request);
      },
      close,
    })),
  };
}

function observerOptions(connect: CarrierStatusConnector, mintNonce = (): ProxyOperationStatusNonce => NONCE) {
  return { timer: observerTimer, mintNonce, log: vi.fn(), connect };
}

function jsonRpcControlError(jsonRpcCode: number, protocolCode: 'method_not_found' | null): ControlClientError {
  return new ControlClientError('control_call_failed', 'remote control failure', 'remote-response', {
    kind: 'json-rpc-error',
    jsonRpcCode,
    protocolCode,
    admissionReason: null,
  });
}

function sameBuildOperations(count: number): OperationIdentity[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(12, '0');
    return operationIdentitySchema.parse({
      ...OPERATION_A,
      jobId: `a1000000-0000-4000-8000-${suffix}`,
      operationId: `b2000000-0000-4000-8000-${suffix}`,
    });
  });
}

const transportFailureModes: ReadonlyArray<
  Readonly<{
    name: string;
    createTransport: () => Pick<ReturnType<typeof respondingConnector>, 'connect' | 'close'>;
  }>
> = [
  {
    name: 'connect failure',
    createTransport: () => ({
      connect: vi.fn(async () => {
        throw new Error('connect failure');
      }),
      close: vi.fn(),
    }),
  },
  {
    name: 'call timeout',
    createTransport: () =>
      respondingConnector(() => {
        throw new Error('call timeout');
      }),
  },
  {
    name: 'socket close',
    createTransport: () =>
      respondingConnector(() => {
        throw new Error('socket closed');
      }),
  },
  {
    name: 'malformed frame',
    createTransport: () =>
      respondingConnector(() => {
        throw new Error('malformed frame');
      }),
  },
  {
    name: 'schema-rejected reply',
    createTransport: () => respondingConnector(() => ({ malformed: true })),
  },
  {
    name: 'partial batch',
    createTransport: () =>
      respondingConnector((request) => {
        const result = validStatusResult(request);
        return { ...result, operations: result.operations.slice(0, 1) };
      }),
  },
  {
    name: 'unmatched nonce',
    createTransport: () =>
      respondingConnector((request) => ({
        ...validStatusResult(request),
        nonce: FOREIGN_NONCE,
      })),
  },
  {
    name: 'tuple-bijection failure',
    createTransport: () =>
      respondingConnector((request) => {
        const result = validStatusResult(request);
        return { ...result, operations: [result.operations[0], result.operations[0]] };
      }),
  },
];

describe('carrier status bounded scheduler', () => {
  it('owns the coordinator pass limits independently of the wire batch size', () => {
    expect(CARRIER_STATUS_MAX_ENDPOINT_REQUESTS).toBe(32);
    expect(CARRIER_STATUS_MAX_CONCURRENT_CALLS).toBe(8);
  });

  it("runs one endpoint locator's status batches serially", async () => {
    const laneRows = rows(PROXY_OPERATION_STATUS_MAX_OPERATIONS + 1);
    const firstCall = createDeferred<void>();
    const batchSizes: number[] = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const scheduled = scheduleCarrierStatusBatches([endpointLane('endpoint-a', laneRows)], {
      keyFor: (row) => row.key,
      callBatch: async (_endpoint, batch) => {
        batchSizes.push(batch.length);
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        if (batchSizes.length === 1) {
          await firstCall.promise;
        }
        activeCalls -= 1;
        return held(batch);
      },
      log: vi.fn(),
    });

    await vi.waitFor(() => expect(batchSizes).toEqual([PROXY_OPERATION_STATUS_MAX_OPERATIONS]));
    firstCall.resolve();
    await expect(scheduled).resolves.toEqual(new Map(laneRows.map((row) => [row.key, 'held'])));
    expect(batchSizes).toEqual([PROXY_OPERATION_STATUS_MAX_OPERATIONS, 1]);
    expect(maxActiveCalls).toBe(1);
  });

  it('stops an endpoint lane after its first unsupported result', async () => {
    const laneRows = rows(PROXY_OPERATION_STATUS_MAX_OPERATIONS + 1);
    const callBatch = vi.fn(async (): Promise<CarrierStatusBatchResult<string>> => ({ kind: 'unsupported' }));

    const outcomes = await scheduleCarrierStatusBatches([endpointLane('older-endpoint', laneRows)], {
      keyFor: (row) => row.key,
      callBatch,
      log: vi.fn(),
    });

    expect(callBatch).toHaveBeenCalledOnce();
    expect([...outcomes.values()]).toEqual(laneRows.map(() => 'unknown'));
  });

  it('globally caps endpoint requests and reports every cap-dropped row once', async () => {
    const aggregateRowCap = CARRIER_STATUS_MAX_ENDPOINT_REQUESTS * PROXY_OPERATION_STATUS_MAX_OPERATIONS;
    const laneRows = rows(aggregateRowCap + PROXY_OPERATION_STATUS_MAX_OPERATIONS + 7);
    const log = vi.fn();
    const callBatch = vi.fn(async (_endpoint: string, batch: readonly TestRow[]) => held(batch));

    const outcomes = await scheduleCarrierStatusBatches([endpointLane('supported-endpoint', laneRows)], {
      keyFor: (row) => row.key,
      callBatch,
      log,
    });

    expect(callBatch).toHaveBeenCalledTimes(CARRIER_STATUS_MAX_ENDPOINT_REQUESTS);
    expect(callBatch.mock.calls.every(([, batch]) => batch.length <= PROXY_OPERATION_STATUS_MAX_OPERATIONS)).toBe(true);
    for (const row of laneRows.slice(0, aggregateRowCap)) {
      expect(outcomes.get(row.key), `issued row ${row.key}`).toBe('held');
    }
    for (const row of laneRows.slice(aggregateRowCap)) {
      expect(outcomes.get(row.key), `cap-dropped row ${row.key}`).toBe('unknown');
    }
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith({
      event: 'carrier-status-pass-cap-dropped',
      droppedEndpointRequests: 2,
      droppedRows: PROXY_OPERATION_STATUS_MAX_OPERATIONS + 7,
    });
  });

  it('shares one request budget across all endpoint lanes', async () => {
    const laneCount = CARRIER_STATUS_MAX_ENDPOINT_REQUESTS + 1;
    const log = vi.fn();
    const callBatch = vi.fn(async (_endpoint: string, batch: readonly TestRow[]) => held(batch));

    const outcomes = await scheduleCarrierStatusBatches(
      Array.from({ length: laneCount }, (_, index) => endpointLane(`endpoint-${index}`, rows(1, `endpoint-${index}`))),
      { keyFor: (row) => row.key, callBatch, log },
    );

    expect(callBatch).toHaveBeenCalledTimes(CARRIER_STATUS_MAX_ENDPOINT_REQUESTS);
    expect([...outcomes.values()].filter((outcome) => outcome === 'held')).toHaveLength(
      CARRIER_STATUS_MAX_ENDPOINT_REQUESTS,
    );
    expect([...outcomes.values()].filter((outcome) => outcome === 'unknown')).toHaveLength(1);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith({
      event: 'carrier-status-pass-cap-dropped',
      droppedEndpointRequests: 1,
      droppedRows: 1,
    });
  });

  it('permits no more than eight active endpoint lanes', async () => {
    const laneCount = CARRIER_STATUS_MAX_CONCURRENT_CALLS + 1;
    const pendingCalls: Array<ReturnType<typeof createDeferred<void>>> = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const scheduled = scheduleCarrierStatusBatches(
      Array.from({ length: laneCount }, (_, index) => endpointLane(`endpoint-${index}`, rows(1, `endpoint-${index}`))),
      {
        keyFor: (row) => row.key,
        callBatch: async (_endpoint, batch) => {
          const pending = createDeferred<void>();
          pendingCalls.push(pending);
          activeCalls += 1;
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
          await pending.promise;
          activeCalls -= 1;
          return held(batch);
        },
        log: vi.fn(),
      },
    );

    await vi.waitFor(() => expect(pendingCalls).toHaveLength(CARRIER_STATUS_MAX_CONCURRENT_CALLS));
    expect(activeCalls).toBe(CARRIER_STATUS_MAX_CONCURRENT_CALLS);
    expect(maxActiveCalls).toBe(CARRIER_STATUS_MAX_CONCURRENT_CALLS);

    pendingCalls[0]?.resolve();
    await vi.waitFor(() => expect(pendingCalls).toHaveLength(laneCount));
    expect(activeCalls).toBe(CARRIER_STATUS_MAX_CONCURRENT_CALLS);
    expect(maxActiveCalls).toBe(CARRIER_STATUS_MAX_CONCURRENT_CALLS);

    for (const pending of pendingCalls) {
      pending.resolve();
    }
    await expect(scheduled).resolves.toHaveLength(laneCount);
  });
});

describe('carrier status identity handshake', () => {
  it('accepts only the exact nonce, proxy/build identity, and full operation tuple set', async () => {
    const transport = respondingConnector();

    const outcomes = await observeCarrierStatuses(
      [recordFor(OPERATION_A), recordFor(OPERATION_B)],
      observerOptions(transport.connect),
    );

    expect(transport.requests).toEqual([
      {
        operations: [OPERATION_A, OPERATION_B],
        nonce: NONCE,
      },
    ]);
    expect(outcomes).toEqual(
      new Map([
        [carrierStatusOperationKey(OPERATION_A), 'held'],
        [carrierStatusOperationKey(OPERATION_B), 'absent'],
      ]),
    );
    expect(transport.close).toHaveBeenCalledOnce();
  });

  const replyMutations: ReadonlyArray<Readonly<{ name: string; mutate: (result: StatusResult) => unknown }>> = [
    {
      name: 'top-level proxyInstanceId',
      mutate: (result) => ({
        ...result,
        proxy: { ...result.proxy, proxyInstanceId: FOREIGN_PROXY_INSTANCE_ID },
      }),
    },
    {
      name: 'top-level buildSetId',
      mutate: (result) => ({
        ...result,
        proxy: { ...result.proxy, buildSetId: FOREIGN_BUILD_SET_ID },
      }),
    },
    {
      name: 'row jobId',
      mutate: (result) => ({
        ...result,
        operations: result.operations.map((row, index) =>
          index === 0 ? { ...row, operation: { ...row.operation, jobId: FOREIGN_JOB_ID } } : row,
        ),
      }),
    },
    {
      name: 'row operationId',
      mutate: (result) => ({
        ...result,
        operations: result.operations.map((row, index) =>
          index === 0 ? { ...row, operation: { ...row.operation, operationId: FOREIGN_OPERATION_ID } } : row,
        ),
      }),
    },
    {
      name: 'row proxyInstanceId',
      mutate: (result) => ({
        ...result,
        operations: result.operations.map((row, index) =>
          index === 0 ? { ...row, operation: { ...row.operation, proxyInstanceId: FOREIGN_PROXY_INSTANCE_ID } } : row,
        ),
      }),
    },
    {
      name: 'row buildSetId',
      mutate: (result) => ({
        ...result,
        operations: result.operations.map((row, index) =>
          index === 0 ? { ...row, operation: { ...row.operation, buildSetId: FOREIGN_BUILD_SET_ID } } : row,
        ),
      }),
    },
    {
      name: 'a duplicated row with another omitted',
      mutate: (result) => ({ ...result, operations: [result.operations[0], result.operations[0]] }),
    },
    {
      name: 'all requested rows plus one duplicate',
      mutate: (result) => ({ ...result, operations: [...result.operations, result.operations[0]] }),
    },
    {
      name: 'an extra row',
      mutate: (result) => ({
        ...result,
        operations: [
          ...result.operations,
          {
            operation: {
              ...OPERATION_A,
              jobId: FOREIGN_JOB_ID,
              operationId: FOREIGN_OPERATION_ID,
            },
            state: 'absent',
          },
        ],
      }),
    },
    {
      name: 'a removed row',
      mutate: (result) => ({ ...result, operations: result.operations.slice(0, 1) }),
    },
  ];

  it.each(replyMutations)('rejects $name as all unknown and never partially absent', async ({ mutate }) => {
    const transport = respondingConnector((request) => mutate(validStatusResult(request)));

    const outcomes = await observeCarrierStatuses(
      [recordFor(OPERATION_A), recordFor(OPERATION_B)],
      observerOptions(transport.connect),
    );

    expect([...outcomes.values()]).toEqual(['unknown', 'unknown']);
    expect([...outcomes.values()]).not.toContain('absent');
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it('rejects a duplicate request group before connecting instead of silently de-duplicating it', async () => {
    const transport = respondingConnector();

    const outcomes = await observeCarrierStatuses(
      [recordFor(OPERATION_A), recordFor(OPERATION_A), recordFor(OPERATION_B)],
      observerOptions(transport.connect),
    );

    expect(transport.connect).not.toHaveBeenCalled();
    expect(outcomes).toEqual(
      new Map([
        [carrierStatusOperationKey(OPERATION_A), 'unknown'],
        [carrierStatusOperationKey(OPERATION_B), 'unknown'],
      ]),
    );
    expect([...outcomes.values()]).not.toContain('absent');
  });

  it('groups by every exact locator field and partitions each locator by proxy/build identity', async () => {
    const transport = respondingConnector();
    const otherBuildOperation = operationIdentitySchema.parse({
      ...OPERATION_B,
      buildSetId: '77777777-7777-7777-7777-777777777777',
    });
    const locatorVariants = [
      { ...PROXY_LOCATOR, instanceId: FOREIGN_PROXY_INSTANCE_ID },
      { ...PROXY_LOCATOR, pid: PROXY_LOCATOR.pid + 1 },
      { ...PROXY_LOCATOR, processStartedAtSeconds: PROXY_LOCATOR.processStartedAtSeconds + 1 },
      { ...PROXY_LOCATOR, controlEndpoint: '/tmp/coral-carrier-status-other.sock' },
    ];
    const locatorOperations = locatorVariants.map((locator, index) =>
      operationIdentitySchema.parse({
        ...OPERATION_B,
        jobId: `88888888-8888-8888-8888-${String(index + 1).padStart(12, '0')}`,
        operationId: `99999999-9999-9999-9999-${String(index + 1).padStart(12, '0')}`,
        proxyInstanceId: locator.instanceId,
      }),
    );

    await observeCarrierStatuses(
      [
        recordFor(OPERATION_A),
        recordFor(otherBuildOperation),
        ...locatorOperations.map((operation, index) => recordFor(operation, locatorVariants[index])),
      ],
      observerOptions(transport.connect),
    );

    expect(transport.connect).toHaveBeenCalledTimes(5);
    expect(transport.requests).toHaveLength(6);
    for (const request of transport.requests) {
      expect(new Set(request.operations.map((operation) => operation.proxyInstanceId))).toHaveLength(1);
      expect(new Set(request.operations.map((operation) => operation.buildSetId))).toHaveLength(1);
    }
    expect(transport.close).toHaveBeenCalledTimes(5);
  });

  it('rejects a malformed minted nonce before opening a connection', async () => {
    const transport = respondingConnector();

    const outcomes = await observeCarrierStatuses(
      [recordFor(OPERATION_A), recordFor(OPERATION_B)],
      observerOptions(transport.connect, () => 'malformed-nonce' as ProxyOperationStatusNonce),
    );

    expect(transport.connect).not.toHaveBeenCalled();
    expect([...outcomes.values()]).toEqual(['unknown', 'unknown']);
    expect([...outcomes.values()]).not.toContain('absent');
  });
});

describe('carrier status transport outcomes', () => {
  it.each(transportFailureModes)(
    'maps $name to unknown for the entire batch and never absent',
    async ({ createTransport }) => {
      const transport = createTransport();

      const outcomes = await observeCarrierStatuses(
        [recordFor(OPERATION_A), recordFor(OPERATION_B)],
        observerOptions(transport.connect),
      );

      expect([...outcomes.values()]).toEqual(['unknown', 'unknown']);
      expect([...outcomes.values()]).not.toContain('absent');
    },
  );
});

describe('carrier status older-set compatibility', () => {
  const methodNotFoundRepresentations: ReadonlyArray<
    Readonly<{ name: string; createError: () => ControlClientError }>
  > = [
    {
      name: 'ControlClientError protocolCode',
      createError: () => {
        const error = jsonRpcControlError(-32_000, null);
        Object.defineProperty(error, 'protocolCode', { value: 'method_not_found' });
        return error;
      },
    },
    {
      name: 'remoteFailure protocolCode',
      createError: () => {
        const error = jsonRpcControlError(-32_000, 'method_not_found');
        Object.defineProperty(error, 'protocolCode', { value: undefined });
        return error;
      },
    },
    {
      name: 'remoteFailure JSON-RPC -32601',
      createError: () => jsonRpcControlError(-32601, null),
    },
  ];

  it.each(methodNotFoundRepresentations)(
    'maps $name method-not-found to unknown rather than absent',
    async ({ createError }) => {
      const transport = respondingConnector(() => {
        throw createError();
      });

      const outcomes = await observeCarrierStatuses([recordFor(OPERATION_A)], observerOptions(transport.connect));

      expect(transport.requests).toHaveLength(1);
      expect(outcomes.get(carrierStatusOperationKey(OPERATION_A))).toBe('unknown');
      expect([...outcomes.values()]).not.toContain('absent');
    },
  );

  it('latches method-not-found for the rest of one endpoint pass', async () => {
    const operations = sameBuildOperations(PROXY_OPERATION_STATUS_MAX_OPERATIONS + 1);
    let statusRequestCount = 0;
    const transport = respondingConnector((request) => {
      statusRequestCount += 1;
      if (statusRequestCount === 1) throw jsonRpcControlError(-32601, null);
      return validStatusResult(request);
    });

    const outcomes = await observeCarrierStatuses(
      operations.map((operation) => recordFor(operation)),
      observerOptions(transport.connect),
    );

    expect(transport.requests).toHaveLength(1);
    expect([...outcomes.values()]).toEqual(operations.map(() => 'unknown'));
    expect(outcomes.get(carrierStatusOperationKey(operations[operations.length - 1]))).toBe('unknown');
  });

  it('serializes build partitions and latches method-not-found for their exact locator', async () => {
    const otherBuildOperation = operationIdentitySchema.parse({
      ...OPERATION_B,
      buildSetId: FOREIGN_BUILD_SET_ID,
    });
    const firstCall = createDeferred<void>();
    let activeCalls = 0;
    let maxActiveCalls = 0;
    let statusRequestCount = 0;
    const transport = respondingConnector(async (request) => {
      statusRequestCount += 1;
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      if (statusRequestCount === 1) {
        await firstCall.promise;
        activeCalls -= 1;
        throw jsonRpcControlError(-32601, null);
      }
      activeCalls -= 1;
      return validStatusResult(request);
    });

    const observing = observeCarrierStatuses(
      [recordFor(OPERATION_A), recordFor(otherBuildOperation)],
      observerOptions(transport.connect),
    );

    await vi.waitFor(() => expect(transport.requests.length).toBeGreaterThanOrEqual(1));
    const activeBeforeFirstReply = activeCalls;
    firstCall.resolve();
    const outcomes = await observing;

    expect(activeBeforeFirstReply).toBe(1);
    expect(maxActiveCalls).toBe(1);
    expect(transport.requests).toHaveLength(1);
    expect(outcomes).toEqual(
      new Map([
        [carrierStatusOperationKey(OPERATION_A), 'unknown'],
        [carrierStatusOperationKey(otherBuildOperation), 'unknown'],
      ]),
    );
  });

  it('does not latch other remote errors as unsupported', async () => {
    const operations = sameBuildOperations(PROXY_OPERATION_STATUS_MAX_OPERATIONS + 1);
    let statusRequestCount = 0;
    const transport = respondingConnector((request) => {
      statusRequestCount += 1;
      if (statusRequestCount === 1) throw jsonRpcControlError(-32_000, null);
      return validStatusResult(request);
    });

    const outcomes = await observeCarrierStatuses(
      operations.map((operation) => recordFor(operation)),
      observerOptions(transport.connect),
    );

    expect(transport.requests).toHaveLength(2);
    expect(outcomes.get(carrierStatusOperationKey(operations[0]))).toBe('unknown');
    expect(outcomes.get(carrierStatusOperationKey(operations[operations.length - 1]))).toBe('held');
  });
});
