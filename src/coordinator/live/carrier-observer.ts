import {
  ControlClientError,
  connectControlClient,
  type ControlClient,
  type ControlClientTimer,
} from '../../provider-proxy/control-client.js';
import {
  PROXY_OPERATION_STATUS_MAX_OPERATIONS,
  PROXY_STATUS_RPC_TIMEOUT_MS,
  operationIdentitySchema,
  proxyOperationStatusParamsSchema,
  proxyOperationStatusResultSchema,
  type OperationIdentity,
  type ProxyOperationStatusNonce,
} from '../../provider-proxy/protocol.js';
import type { ProviderOperationRecord } from '../../store/provider-operation-record.js';

/**
 * The bounded network half of carrier observation: it asks proxy sets which operations they still hold.
 *
 * Coordinator-owned rather than protocol-owned, because these are budgets for one observation *pass* — how
 * much a coordinator is willing to spend asking — while the proxy's own request cap is a wire bound on a
 * single message. The two answer different questions and must be free to move apart.
 *
 * Everything here is derived reading, never authority: a row nothing could answer for stays `unknown`, which
 * every consumer treats as conservatively active. `tests/invariants/no-carrier-observation-in-action-paths.test.ts`
 * is what keeps that true by construction.
 */

/** Status requests one observation pass may issue in total, across every endpoint. */
export const CARRIER_STATUS_MAX_ENDPOINT_REQUESTS = 32;

/** Endpoint lanes that may be in flight at once. Chunks within a lane stay serial — see the scheduler. */
export const CARRIER_STATUS_MAX_CONCURRENT_CALLS = 8;

/**
 * What one pass learned about one operation. `unknown` is a real answer — "the question was not answered" —
 * and is never interchangeable with `absent`, which is positive evidence that the named carrier is gone.
 */
export type CarrierStatusOutcome = 'held' | 'absent' | 'unknown';

/** One build-homogeneous outbound batch within an exact-locator lane. */
export type CarrierStatusEndpointBatch<TEndpoint, TRow> = {
  endpoint: TEndpoint;
  rows: readonly TRow[];
};

/** One exact endpoint locator's serial work for a pass. An unsupported result abandons every later batch. */
export type CarrierStatusEndpointLane<TEndpoint, TRow> = {
  batches: readonly CarrierStatusEndpointBatch<TEndpoint, TRow>[];
};

/**
 * One chunk's reply. `unsupported` is separate from an empty `supported` because it is a fact about the
 * *endpoint* rather than about the rows: an exact locator that does not implement the method will not
 * implement it for the next batch either, so the scheduler abandons the whole lane instead of asking again.
 */
export type CarrierStatusBatchResult<TKey> =
  | { kind: 'supported'; outcomes: ReadonlyMap<TKey, CarrierStatusOutcome> }
  | { kind: 'unsupported' };

/** Emitted once per pass that hit the request cap. Silent truncation would read as "we asked about everything". */
export type CarrierStatusDropReport = {
  event: 'carrier-status-pass-cap-dropped';
  droppedEndpointRequests: number;
  droppedRows: number;
};

/**
 * `callBatch` is injected so the bounds are provable without a transport, and so the scheduler never learns
 * what a control socket is — the real sender is composed over it.
 */
export type CarrierStatusSchedulerOptions<TEndpoint, TRow, TKey> = {
  keyFor: (row: TRow) => TKey;
  callBatch: (endpoint: TEndpoint, rows: readonly TRow[]) => Promise<CarrierStatusBatchResult<TKey>>;
  log: (report: CarrierStatusDropReport) => void;
};

type CarrierStatusPassState<TKey> = {
  outcomes: Map<TKey, CarrierStatusOutcome>;
  issuedEndpointRequests: number;
  droppedEndpointRequests: number;
  droppedRows: number;
};

/** The durable identity and exact proxy locator needed for one external liveness observation. */
export type CarrierStatusRecord = Readonly<{
  operation: ProviderOperationRecord['operation'];
  locator: Readonly<{ proxy: ProviderOperationRecord['locator']['proxy'] }>;
}>;

type CarrierStatusClient = Pick<ControlClient, 'call' | 'close'>;

/** Test seam for transport outcomes; production omits it and uses `connectControlClient`. */
export type CarrierStatusConnector = (
  controlEndpoint: string,
  timer: ControlClientTimer,
  connectTimeoutMs: number,
) => Promise<CarrierStatusClient>;

export type CarrierStatusObserverOptions = Readonly<{
  timer: ControlClientTimer;
  mintNonce: () => ProxyOperationStatusNonce;
  log: (report: CarrierStatusDropReport) => void;
  connect?: CarrierStatusConnector;
}>;

type ProxyLocator = CarrierStatusRecord['locator']['proxy'];

type CanonicalCarrierStatusRow = Readonly<{
  operation: OperationIdentity;
  locator: ProxyLocator;
  locatorKey: string;
  tupleKey: string;
}>;

type CarrierStatusLocatorGroup = {
  locator: ProxyLocator;
  locatorKey: string;
  rows: CanonicalCarrierStatusRow[];
};

type CarrierStatusEndpoint = Readonly<{
  locator: ProxyLocator;
  locatorKey: string;
  proxyInstanceId: string;
  buildSetId: string;
}>;

function tupleKey(operation: OperationIdentity): string {
  return JSON.stringify([operation.jobId, operation.operationId, operation.proxyInstanceId, operation.buildSetId]);
}

/** Stable full-W2.3-tuple key used by the observer result and its consumers. */
export function carrierStatusOperationKey(operation: ProviderOperationRecord['operation']): string {
  return tupleKey(operationIdentitySchema.parse(operation));
}

function proxyLocatorKey(locator: ProxyLocator): string {
  return JSON.stringify([locator.instanceId, locator.pid, locator.incarnation, locator.controlEndpoint]);
}

function proxyBuildKey(operation: OperationIdentity): string {
  return JSON.stringify([operation.proxyInstanceId, operation.buildSetId]);
}

function canonicalRows(records: readonly CarrierStatusRecord[]): CanonicalCarrierStatusRow[] {
  return records.map((record) => {
    const operation = operationIdentitySchema.parse(record.operation);
    const locator = record.locator.proxy;
    return {
      operation,
      locator,
      locatorKey: proxyLocatorKey(locator),
      tupleKey: tupleKey(operation),
    };
  });
}

function groupRowsByLocator(rows: readonly CanonicalCarrierStatusRow[]): CarrierStatusLocatorGroup[] {
  const groups = new Map<string, CarrierStatusLocatorGroup>();
  for (const row of rows) {
    const group = groups.get(row.locatorKey);
    if (group === undefined) {
      groups.set(row.locatorKey, { locator: row.locator, locatorKey: row.locatorKey, rows: [row] });
    } else {
      group.rows.push(row);
    }
  }
  return [...groups.values()];
}

function duplicateLocatorKeys(groups: readonly CarrierStatusLocatorGroup[]): Set<string> {
  const firstLocatorByTuple = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const group of groups) {
    for (const row of group.rows) {
      const firstLocatorKey = firstLocatorByTuple.get(row.tupleKey);
      if (firstLocatorKey === undefined) {
        firstLocatorByTuple.set(row.tupleKey, row.locatorKey);
      } else {
        duplicates.add(firstLocatorKey);
        duplicates.add(row.locatorKey);
      }
    }
  }
  return duplicates;
}

function buildLocatorBatches(
  group: CarrierStatusLocatorGroup,
): CarrierStatusEndpointBatch<CarrierStatusEndpoint, OperationIdentity>[] {
  const partitions = new Map<string, { endpoint: CarrierStatusEndpoint; rows: OperationIdentity[] }>();
  for (const row of group.rows) {
    const partitionKey = proxyBuildKey(row.operation);
    const partition = partitions.get(partitionKey);
    if (partition !== undefined) {
      partition.rows.push(row.operation);
      continue;
    }

    partitions.set(partitionKey, {
      endpoint: {
        locator: group.locator,
        locatorKey: group.locatorKey,
        proxyInstanceId: row.operation.proxyInstanceId,
        buildSetId: row.operation.buildSetId,
      },
      rows: [row.operation],
    });
  }

  const batches: CarrierStatusEndpointBatch<CarrierStatusEndpoint, OperationIdentity>[] = [];
  for (const partition of partitions.values()) {
    for (let offset = 0; offset < partition.rows.length; offset += PROXY_OPERATION_STATUS_MAX_OPERATIONS) {
      batches.push({
        endpoint: partition.endpoint,
        rows: partition.rows.slice(offset, offset + PROXY_OPERATION_STATUS_MAX_OPERATIONS),
      });
    }
  }
  return batches;
}

function buildEndpointLanes(
  rows: readonly CanonicalCarrierStatusRow[],
): CarrierStatusEndpointLane<CarrierStatusEndpoint, OperationIdentity>[] {
  const groups = groupRowsByLocator(rows);
  const duplicates = duplicateLocatorKeys(groups);
  return groups
    .filter((group) => !duplicates.has(group.locatorKey))
    .map((group) => ({ batches: buildLocatorBatches(group) }));
}

function relationalOutcomes(
  request: Readonly<{ operations: readonly OperationIdentity[]; nonce: ProxyOperationStatusNonce }>,
  expected: CarrierStatusEndpoint,
  rawResult: unknown,
): ReadonlyMap<string, CarrierStatusOutcome> | null {
  const parsed = proxyOperationStatusResultSchema.safeParse(rawResult);
  if (!parsed.success) return null;
  const result = parsed.data;
  if (
    result.nonce !== request.nonce ||
    result.proxy.proxyInstanceId !== expected.proxyInstanceId ||
    result.proxy.buildSetId !== expected.buildSetId
  ) {
    return null;
  }

  const requestedKeys = new Set(request.operations.map(tupleKey));
  const replyKeys = new Set<string>();
  const outcomes = new Map<string, CarrierStatusOutcome>();
  for (const row of result.operations) {
    if (
      row.operation.proxyInstanceId !== expected.proxyInstanceId ||
      row.operation.buildSetId !== expected.buildSetId
    ) {
      return null;
    }
    const key = tupleKey(row.operation);
    if (replyKeys.has(key) || !requestedKeys.has(key)) return null;
    replyKeys.add(key);
    outcomes.set(key, row.state);
  }

  if (replyKeys.size !== requestedKeys.size) return null;
  return outcomes;
}

function unansweredBatch(): CarrierStatusBatchResult<string> {
  return { kind: 'supported', outcomes: new Map() };
}

function isUnsupportedStatusMethod(error: unknown): boolean {
  if (!(error instanceof ControlClientError)) return false;
  if (error.protocolCode === 'method_not_found') return true;
  const failure = error.remoteFailure;
  return (
    failure?.kind === 'json-rpc-error' &&
    (failure.protocolCode === 'method_not_found' || failure.jsonRpcCode === -32601)
  );
}

function createPassState<TEndpoint, TRow, TKey>(
  lanes: readonly CarrierStatusEndpointLane<TEndpoint, TRow>[],
  keyFor: (row: TRow) => TKey,
): CarrierStatusPassState<TKey> {
  const outcomes = new Map<TKey, CarrierStatusOutcome>();
  for (const lane of lanes) {
    for (const batch of lane.batches) {
      for (const row of batch.rows) outcomes.set(keyFor(row), 'unknown');
    }
  }
  return { outcomes, issuedEndpointRequests: 0, droppedEndpointRequests: 0, droppedRows: 0 };
}

async function runCarrierStatusLane<TEndpoint, TRow, TKey>(
  lane: CarrierStatusEndpointLane<TEndpoint, TRow>,
  options: CarrierStatusSchedulerOptions<TEndpoint, TRow, TKey>,
  state: CarrierStatusPassState<TKey>,
): Promise<void> {
  for (const [index, batch] of lane.batches.entries()) {
    if (state.issuedEndpointRequests >= CARRIER_STATUS_MAX_ENDPOINT_REQUESTS) {
      const remainingBatches = lane.batches.slice(index);
      state.droppedEndpointRequests += remainingBatches.length;
      state.droppedRows += remainingBatches.reduce((count, remaining) => count + remaining.rows.length, 0);
      return;
    }

    state.issuedEndpointRequests += 1;
    const result = await options.callBatch(batch.endpoint, batch.rows);
    if (result.kind === 'unsupported') return;

    for (const row of batch.rows) {
      const key = options.keyFor(row);
      const outcome = result.outcomes.get(key);
      if (outcome !== undefined) state.outcomes.set(key, outcome);
    }
  }
}

/**
 * Runs one bounded observation pass and returns a verdict for every row it was given.
 *
 * Every row is seeded `unknown` before any call, so the return value is total by construction: a dropped
 * chunk, an abandoned lane, and a row the reply omitted all land on the same conservative answer without a
 * separate "we did not ask" channel for callers to forget to check.
 */
export async function scheduleCarrierStatusBatches<TEndpoint, TRow, TKey>(
  lanes: readonly CarrierStatusEndpointLane<TEndpoint, TRow>[],
  options: CarrierStatusSchedulerOptions<TEndpoint, TRow, TKey>,
): Promise<Map<TKey, CarrierStatusOutcome>> {
  const state = createPassState(lanes, options.keyFor);
  let nextLaneIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (nextLaneIndex < lanes.length) {
      const lane = lanes[nextLaneIndex];
      nextLaneIndex += 1;
      if (lane !== undefined) await runCarrierStatusLane(lane, options, state);
    }
  };

  const workerCount = Math.min(CARRIER_STATUS_MAX_CONCURRENT_CALLS, lanes.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));

  if (state.droppedEndpointRequests > 0) {
    options.log({
      event: 'carrier-status-pass-cap-dropped',
      droppedEndpointRequests: state.droppedEndpointRequests,
      droppedRows: state.droppedRows,
    });
  }

  return state.outcomes;
}

function createCarrierStatusClientPool(options: CarrierStatusObserverOptions) {
  const connect = options.connect ?? connectControlClient;
  const connectingClients = new Map<string, Promise<CarrierStatusClient>>();
  const openedClients = new Set<CarrierStatusClient>();

  return {
    clientFor(endpoint: CarrierStatusEndpoint): Promise<CarrierStatusClient> {
      const existing = connectingClients.get(endpoint.locatorKey);
      if (existing !== undefined) return existing;
      const connecting = connect(endpoint.locator.controlEndpoint, options.timer, PROXY_STATUS_RPC_TIMEOUT_MS).then(
        (client) => {
          openedClients.add(client);
          return client;
        },
      );
      connectingClients.set(endpoint.locatorKey, connecting);
      return connecting;
    },
    close(): void {
      for (const client of openedClients) client.close();
    },
  };
}

async function callCarrierStatusBatch(
  endpoint: CarrierStatusEndpoint,
  operations: readonly OperationIdentity[],
  options: CarrierStatusObserverOptions,
  clientFor: (endpoint: CarrierStatusEndpoint) => Promise<CarrierStatusClient>,
): Promise<CarrierStatusBatchResult<string>> {
  const matchesEndpoint = operations.every(
    (operation) =>
      operation.proxyInstanceId === endpoint.proxyInstanceId && operation.buildSetId === endpoint.buildSetId,
  );
  if (!matchesEndpoint) return unansweredBatch();

  const request = proxyOperationStatusParamsSchema.safeParse({ operations, nonce: options.mintNonce() });
  if (!request.success) return unansweredBatch();

  try {
    const client = await clientFor(endpoint);
    const rawResult = await client.call('operation.status.v1', request.data, PROXY_STATUS_RPC_TIMEOUT_MS);
    const batchOutcomes = relationalOutcomes(request.data, endpoint, rawResult);
    return batchOutcomes === null ? unansweredBatch() : { kind: 'supported', outcomes: batchOutcomes };
  } catch (error) {
    if (isUnsupportedStatusMethod(error)) return { kind: 'unsupported' };
    return unansweredBatch();
  }
}

/**
 * Observes durable provider operations through fresh connections owned only for this pass.
 *
 * Grouping, duplicate rejection, and build-homogeneous batching finish before scheduling. Each exact locator
 * owns one fresh connection and one serial scheduler lane for the pass.
 */
export async function observeCarrierStatuses(
  records: readonly CarrierStatusRecord[],
  options: CarrierStatusObserverOptions,
): Promise<Map<string, CarrierStatusOutcome>> {
  const rows = canonicalRows(records);
  const outcomes = new Map<string, CarrierStatusOutcome>(rows.map((row) => [row.tupleKey, 'unknown']));
  const lanes = buildEndpointLanes(rows);
  const clients = createCarrierStatusClientPool(options);

  try {
    const observed = await scheduleCarrierStatusBatches(lanes, {
      keyFor: tupleKey,
      callBatch: (endpoint, operations) => callCarrierStatusBatch(endpoint, operations, options, clients.clientFor),
      log: options.log,
    });
    for (const [key, outcome] of observed) outcomes.set(key, outcome);
    return outcomes;
  } finally {
    clients.close();
  }
}
