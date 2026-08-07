import { z } from 'zod';

import { ControlClientError } from '../../provider-proxy/control-client.js';
import { operationIdentitySchema, type OperationIdentity } from '../../provider-proxy/protocol.js';
import type { CarrierLiveness } from '../../jobs/carrier-observation.js';

/**
 * The bounded, read-only probe half of carrier observation.
 *
 * Separate from the pure classifier because asking a foreign process is a different act from reading local
 * state, and the difference has to be visible at the call site: health and idle may classify freely, but a
 * coordinator that probed the network to decide whether hard retirement is safe would have handed authority
 * over its own durable state to a process it does not control. Every bound below exists so that one slow or
 * hostile endpoint cannot turn a read into an unbounded wait — and every way of failing lands on `unknown`,
 * because an unanswered question is not an answer.
 */

/**
 * Operations one `operation.status.v1` request may name.
 *
 * Restated here rather than imported from the proxy's ledger: this is the coordinator side of a wire
 * contract, and reaching into `provider-proxy/ledger.ts` for it would put a coordinator read module on the
 * proxy's internal implementation seam for one number. The two must agree, so
 * `tests/unit/coordinator/carrier-observer.test.ts` asserts the equality instead — drift fails a test rather
 * than being prevented by a dependency nobody wanted.
 */
export const MAX_OPERATIONS_PER_STATUS_REQUEST = 128;
/** Endpoints contacted for one top-level read. Beyond this the read reports overflow rather than truncating. */
export const MAX_OBSERVED_ENDPOINTS_PER_READ = 32;
/** Endpoints in flight at once. Bounds the fan-out a single read may impose on the host. */
export const MAX_CONCURRENT_OBSERVATIONS = 8;
/** Absolute budget for one endpoint's request, including connect. */
export const OBSERVATION_REQUEST_TIMEOUT_MS = 500;
/** Rows one top-level read may return. A request past this reports overflow rather than a partial truth. */
export const MAX_OBSERVED_ROWS_PER_READ = 4_096;

const observedOperationSchema = z.union([
  z.object({ operation: operationIdentitySchema, held: z.literal(false) }).strict(),
  z
    .object({
      operation: operationIdentitySchema,
      held: z.literal(true),
      state: z.string().min(1),
      committedThroughProviderSeq: z.number().int().nonnegative(),
    })
    .strict(),
]);

const operationStatusResultSchema = z
  .object({
    proxyInstanceId: z.string().min(1),
    operations: z.array(observedOperationSchema).max(MAX_OPERATIONS_PER_STATUS_REQUEST),
  })
  .strict();

/**
 * One operation to ask about, with the endpoint to ask and the identity that decides what a refused
 * connection means.
 *
 * `expectedInstanceGone` is supplied by the caller, not derived here, because it is a *local* fact — the
 * recorded pid and start second no longer name a live process — and the observer must not be the thing that
 * decides it. Without that proof, a refused connection is `unknown`: a socket can be missing because the
 * process died, or because it never finished binding, or because the path was cleaned up under a proxy that
 * is still running.
 */
export type CarrierProbeTarget = Readonly<{
  endpoint: string;
  operation: OperationIdentity;
  expectedInstanceGone: boolean;
}>;

export type CarrierProbeResult = Readonly<{
  operation: OperationIdentity;
  liveness: CarrierLiveness;
  /** Present only for a `live` verdict, and only as reported by the proxy that holds the operation. */
  state?: string;
  committedThroughProviderSeq?: number;
}>;

export type CarrierObservationRead = Readonly<{
  results: readonly CarrierProbeResult[];
  /** True when a declared bound stopped the read. Every unasked target is reported `unknown`. */
  overflowed: boolean;
}>;

/** How the observer reaches an endpoint. Injected so the bounds are testable without real sockets. */
export type CarrierProbeTransport = Readonly<{
  call(endpoint: string, method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}>;

export type CarrierObserverOptions = Readonly<{
  transport: CarrierProbeTransport;
  /** Overridable only so tests can drive the concurrency bound; production uses the constant. */
  maxConcurrent?: number;
}>;

/**
 * A connection refused or absent means the endpoint is not there — which answers the question only when the
 * caller already proved the instance that owned it is gone. Everything else, including any protocol error
 * and any unclassified failure, is `unknown`: the point of the tri-state is that a probe which did not
 * complete must never read as a job that ended.
 */
function livenessFromFailure(error: unknown, expectedInstanceGone: boolean): CarrierLiveness {
  if (!expectedInstanceGone) return 'unknown';
  const code = (error as { code?: unknown } | null)?.code;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  const refused = [code, cause].some((value) => value === 'ENOENT' || value === 'ECONNREFUSED');
  const connectFailed = error instanceof ControlClientError && error.code === 'control_client_connect_failed';
  return refused || connectFailed ? 'absent' : 'unknown';
}

function unknownFor(targets: readonly CarrierProbeTarget[]): CarrierProbeResult[] {
  return targets.map((target) => ({ operation: target.operation, liveness: 'unknown' }));
}

/**
 * Groups targets by endpoint and orders both the groups and each group's operations by bytes.
 *
 * Deterministic order is what makes the caps honest: with a stable order, "the first 32 endpoints" is a
 * reproducible set rather than whichever ones a map happened to yield first, so an overflowing read drops
 * the same targets every time instead of rotating silently through them.
 */
function byteSortedGroups(targets: readonly CarrierProbeTarget[]): Map<string, CarrierProbeTarget[]> {
  const groups = new Map<string, CarrierProbeTarget[]>();
  for (const target of [...targets].sort((left, right) => compareTargets(left, right))) {
    const existing = groups.get(target.endpoint);
    if (existing === undefined) groups.set(target.endpoint, [target]);
    else existing.push(target);
  }
  return new Map([...groups].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

function compareTargets(left: CarrierProbeTarget, right: CarrierProbeTarget): number {
  if (left.endpoint !== right.endpoint) return left.endpoint < right.endpoint ? -1 : 1;
  if (left.operation.jobId !== right.operation.jobId) return left.operation.jobId < right.operation.jobId ? -1 : 1;
  if (left.operation.operationId === right.operation.operationId) return 0;
  return left.operation.operationId < right.operation.operationId ? -1 : 1;
}

/** Runs `work` over `items` with at most `limit` in flight, preserving input order in the output. */
async function mapBounded<Item, Out>(
  items: readonly Item[],
  limit: number,
  work: (item: Item) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface CarrierObserver {
  /** One top-level read. Holds nothing across calls — there is deliberately no cross-request cache. */
  observe(targets: readonly CarrierProbeTarget[]): Promise<CarrierObservationRead>;
}

export function createCarrierObserver(options: CarrierObserverOptions): CarrierObserver {
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_OBSERVATIONS;

  const probeEndpoint = async (
    endpoint: string,
    batch: readonly CarrierProbeTarget[],
  ): Promise<CarrierProbeResult[]> => {
    let raw: unknown;
    try {
      raw = await options.transport.call(
        endpoint,
        'operation.status.v1',
        { operations: batch.map((target) => target.operation) },
        OBSERVATION_REQUEST_TIMEOUT_MS,
      );
    } catch (error: unknown) {
      return batch.map((target) => ({
        operation: target.operation,
        liveness: livenessFromFailure(error, target.expectedInstanceGone),
      }));
    }

    const parsed = operationStatusResultSchema.safeParse(raw);
    // A reply that does not match the contract answers nothing, however confident it looks. Trusting a
    // malformed shape here is how a foreign build's stray response would end a live job.
    if (!parsed.success) return unknownFor(batch);

    const held = new Map(
      parsed.data.operations.map((entry) => [`${entry.operation.jobId}\u0000${entry.operation.operationId}`, entry]),
    );
    return batch.map((target) => {
      const entry = held.get(`${target.operation.jobId}\u0000${target.operation.operationId}`);
      // An operation the proxy did not answer for is not an operation it denied holding — the reply simply
      // did not cover it, which is exactly what `unknown` is for.
      if (entry === undefined) return { operation: target.operation, liveness: 'unknown' as const };
      return entry.held
        ? {
            operation: target.operation,
            liveness: 'live' as const,
            state: entry.state,
            committedThroughProviderSeq: entry.committedThroughProviderSeq,
          }
        : // The proxy is alive, it answered, and it holds no such operation: the one authority that can
          // turn a missing operation into a positive absence.
          { operation: target.operation, liveness: 'absent' as const };
    });
  };

  return {
    async observe(targets: readonly CarrierProbeTarget[]): Promise<CarrierObservationRead> {
      if (targets.length === 0) return { results: [], overflowed: false };
      if (targets.length > MAX_OBSERVED_ROWS_PER_READ) {
        // Refusing the whole read rather than the tail: a caller handed more rows than one read may carry,
        // and answering some of them would look like a complete picture of a set it never covered.
        return { results: unknownFor(targets), overflowed: true };
      }

      const groups = [...byteSortedGroups(targets)];
      const asked = groups.slice(0, MAX_OBSERVED_ENDPOINTS_PER_READ);
      const skipped = groups.slice(MAX_OBSERVED_ENDPOINTS_PER_READ);

      const answered = await mapBounded(asked, maxConcurrent, async ([endpoint, batch]) => {
        const chunks: CarrierProbeResult[][] = [];
        // Chunked to the proxy's own per-request cap, in the same byte order, so one endpoint holding more
        // than a request may carry is still fully covered rather than silently truncated.
        for (let index = 0; index < batch.length; index += MAX_OPERATIONS_PER_STATUS_REQUEST) {
          chunks.push(await probeEndpoint(endpoint, batch.slice(index, index + MAX_OPERATIONS_PER_STATUS_REQUEST)));
        }
        return chunks.flat();
      });

      return {
        results: [...answered.flat(), ...unknownFor(skipped.flatMap(([, batch]) => batch))],
        overflowed: skipped.length > 0,
      };
    },
  };
}
