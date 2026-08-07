import { z } from 'zod';

import type { Database } from '../../store/db.js';
import {
  deleteProviderOperationRuntimeMeta,
  writeProviderOperationRuntimeMeta,
} from '../../jobs/runtime-meta-store.js';
import type { ProviderOperationRuntimeMeta } from '../../jobs/runtime-meta.js';
import type { OperationIdentity, ProxyPreparedAppServerOperation } from '../../provider-proxy/protocol.js';
import type { ProviderStopCause } from '../../providers/contract.js';
import type { OperationStopControl } from './operation-registry.js';

/**
 * The coordinator half of W2.3's closed publication order: `operation.prepare.v1` → one coordinator
 * transaction committing `provider_operation.v1` runtime meta → `guardian.operation-activate.v1` →
 * `operation.activate.v1`, with the exact activation-expiry compensation the plan requires. No other
 * transition may start the kernel — every step below either advances toward `operation.activate.v1`'s
 * `executing` ACK or runs the full compensation before returning; there is no path that returns success
 * without an execution ACK, and no path that leaves committed meta behind without either an executing
 * operation or a completed release.
 *
 * Lives in `coordinator/services/`, not `coordinator/live/`: it imports `jobs/runtime-meta*.ts` directly
 * (`architecture-layering.test.ts`'s coordinator-contract-entrypoint rule exempts `services/`, matching where
 * `terminal-materializer.ts` already sits for the same reason).
 *
 * This module owns the orchestration only. It is deliberately not wired to a live proxy set: doing so needs
 * a caller that can resolve this job's guardian/proxy `ControlClient`s from its executable identity, and the
 * only production registry for a live set (`ProviderProxySetAuthority`, `coordinator/live/provider-proxy-
 * authority.ts`) is written from coordinated shutdown's side on purpose — it exposes no raw RPC capability.
 * Building that connector is `src/coordinator/live/provider-proxy-acquisition-steps.ts`'s territory (W2.2),
 * not this file's.
 */

/** The minimal wire capability this file needs from a role's control connection: `ControlClient.call` from
 *  `provider-proxy/control-client.ts`, restated here rather than imported so this module depends on a shape,
 *  not that module's class identity — the same reason `carrier-observer.ts`'s `CarrierProbeTransport` exists. */
export interface OperationControlClient {
  call(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

/** The set-level identity fields every operation this proxy ever prepares shares. Everything here is fixed
 *  for the lifetime of one guardian/reaper/proxy set; only the operation-scoped fields below (reservation,
 *  provider root, receipt, watermark) vary per call. */
export type ProviderProxySetIdentity = Readonly<{
  buildSetId: string;
  hostFingerprint: string;
  guardianInstanceId: string;
  guardianPid: number;
  guardianProcessStartedAtSeconds: number;
  guardianControlEndpoint: string;
  proxyInstanceId: string;
  proxyPid: number;
  reaperInstanceId: string;
  reaperPid: number;
  reaperProcessStartedAtSeconds: number;
  reaperControlEndpoint: string;
  containmentKind: string;
  proxyProcessStartedAtSeconds: number;
  proxyProcessGroupId: number;
  canonicalEndpoint: string;
}>;

export interface ProviderProxyOperationActivationDeps {
  readonly db: Database;
  readonly proxyClient: OperationControlClient;
  readonly guardianClient: OperationControlClient;
  readonly setIdentity: ProviderProxySetIdentity;
  readonly mutationRpcTimeoutMs: number;
}

const MUTATION_RPC_TIMEOUT_DEFAULT_MS = 5_000;

const providerRootSchema = z
  .object({
    pid: z.number().int().nonnegative().safe(),
    processStartedAtSeconds: z.number().int().nonnegative().safe(),
  })
  .strict();

const preparePendingSchema = z
  .object({
    state: z.literal('pending-activation'),
    reservationId: z.string().min(1),
    activationNonce: z.string().min(1),
    leaseExpiresInMs: z.number(),
    providerRoot: providerRootSchema,
    jointContainmentReceipt: z.string().min(1),
  })
  .strict();
const prepareCapacitySchema = z
  .object({ state: z.literal('capacity'), retryable: z.boolean(), reason: z.string() })
  .strict();
const prepareResultSchema = z.union([preparePendingSchema, prepareCapacitySchema]);

const guardianActivateResultSchema = z
  .object({ state: z.literal('activation-authorized'), jointActivationReceipt: z.string().min(1) })
  .strict();

const proxyActivateResultSchema = z
  .object({ state: z.literal('executing'), committedThroughProviderSeq: z.number().int().nonnegative().safe() })
  .strict();

const cancelPendingResultSchema = z.object({ state: z.literal('released') }).strict();
const guardianReleaseResultSchema = z.object({ state: z.literal('membership-released') }).strict();
const stopResultSchema = z
  .object({ state: z.string().min(1), committedThroughProviderSeq: z.number().int().nonnegative().safe() })
  .strict();

export type ActivateProviderOperationResult =
  | Readonly<{
      kind: 'executing';
      committedThroughProviderSeq: number;
      /** The exact row this call committed to `provider_operation.v1:<jobId>:<operationId>` — handed back so
       *  the caller (`createAppServerProxyRoute`) can register it with `LocalOperationRegistry.activate()`
       *  without re-deriving it from anything. */
      meta: ProviderOperationRuntimeMeta;
      /** This operation's `operation.stop.v1` capability, bound to the exact `proxyClient` and identity this
       *  activation used. */
      control: OperationStopControl;
    }>
  /** The proxy's own ledger is at `MAX_PROXY_OPERATION_LEDGERS` capacity. Admission stays with the caller —
   *  nothing was written, so a retry is exactly as safe as the first attempt. */
  | Readonly<{ kind: 'capacity'; retryable: boolean; reason: string }>
  /** Activation could not complete after the meta commit. Compensation already ran — the meta row named by
   *  `operation` is durably deleted, the proxy's pending reservation is released, and the guardian's staged
   *  membership is released — and the kernel was never started. */
  | Readonly<{ kind: 'activation-failed'; step: 'guardian-activate' | 'proxy-activate'; reason: string }>;

async function callStrict<T>(
  client: OperationControlClient,
  method: string,
  params: unknown,
  timeoutMs: number,
  schema: z.ZodType<T>,
): Promise<T> {
  const raw = await client.call(method, params, timeoutMs);
  return schema.parse(raw);
}

/**
 * Binds `operation.stop.v1` to the exact `proxyClient` and `operation` this activation used, for
 * `LocalOperationRegistry` (`operation-registry.ts`) to hold once activation succeeds. The RPC's own reply
 * (`state`, a ledger transition this module has no reason to interpret) is validated and discarded — the
 * caller only needs to know the send either completed or threw.
 */
function buildStopControl(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  timeoutMs: number,
): OperationStopControl {
  return {
    async stop(cause: ProviderStopCause): Promise<void> {
      await callStrict(deps.proxyClient, 'operation.stop.v1', { operation, cause }, timeoutMs, stopResultSchema);
    },
  };
}

/**
 * Deletes the exact matching meta row, then releases the pending reservation, then releases the guardian's
 * staged membership — the plan's exact compensation order, reversed from commit order. Every step is
 * idempotent on the receiving end (`operation.cancel-pending.v1` reports a repeated cancel as `released`
 * rather than not-found), so a retry of this whole sequence after a partial failure is safe to attempt again.
 */
async function compensateAfterActivationFailure(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  reservationId: string,
  activationNonce: string,
): Promise<void> {
  deleteProviderOperationRuntimeMeta(deps.db, operation.jobId, operation.operationId);
  await callStrict(
    deps.proxyClient,
    'operation.cancel-pending.v1',
    { operation, reservationId, activationNonce },
    deps.mutationRpcTimeoutMs,
    cancelPendingResultSchema,
  );
  await callStrict(
    deps.guardianClient,
    'guardian.operation-release.v1',
    { operation, reservationId, activationNonce },
    deps.mutationRpcTimeoutMs,
    guardianReleaseResultSchema,
  );
}

/**
 * Runs the complete closed publication order for one operation: `operation.prepare.v1` on the proxy,
 * durably committing the runtime-meta locator, `guardian.operation-activate.v1`, then `operation.activate.v1`
 * — in exactly that order, with no other transition permitted to start the kernel. A failure at either
 * activation call runs the full compensation and returns `activation-failed`; the kernel is never started on
 * that path. A `capacity` reply from prepare writes nothing and returns immediately — admission stays with
 * the caller.
 */
export async function activateProviderOperation(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  prepared: ProxyPreparedAppServerOperation,
): Promise<ActivateProviderOperationResult> {
  const timeoutMs = deps.mutationRpcTimeoutMs || MUTATION_RPC_TIMEOUT_DEFAULT_MS;

  // Step 1: operation.prepare.v1 — reservation, provider root, containment receipt; semantic execution stays
  // forbidden until step 4.
  const prepareResult = await callStrict(
    deps.proxyClient,
    'operation.prepare.v1',
    { operation, hostFingerprint: deps.setIdentity.hostFingerprint, prepared },
    timeoutMs,
    prepareResultSchema,
  );
  if (prepareResult.state === 'capacity') {
    return { kind: 'capacity', retryable: prepareResult.retryable, reason: prepareResult.reason };
  }
  const { reservationId, activationNonce, providerRoot, jointContainmentReceipt } = prepareResult;

  // Step 2: one coordinator transaction commits the exact locator every later step and every later recovery
  // reads back — never DDL, never an event-body codec, never registered in PersistedCodecRegistry.
  const meta: ProviderOperationRuntimeMeta = {
    version: 1,
    jobId: operation.jobId,
    operationId: operation.operationId,
    buildSetId: deps.setIdentity.buildSetId,
    hostFingerprint: deps.setIdentity.hostFingerprint,
    guardianInstanceId: deps.setIdentity.guardianInstanceId,
    guardianPid: deps.setIdentity.guardianPid,
    guardianProcessStartedAtSeconds: deps.setIdentity.guardianProcessStartedAtSeconds,
    guardianControlEndpoint: deps.setIdentity.guardianControlEndpoint,
    proxyInstanceId: deps.setIdentity.proxyInstanceId,
    proxyPid: deps.setIdentity.proxyPid,
    reaperInstanceId: deps.setIdentity.reaperInstanceId,
    reaperPid: deps.setIdentity.reaperPid,
    reaperProcessStartedAtSeconds: deps.setIdentity.reaperProcessStartedAtSeconds,
    reaperControlEndpoint: deps.setIdentity.reaperControlEndpoint,
    containmentKind: deps.setIdentity.containmentKind,
    proxyProcessStartedAtSeconds: deps.setIdentity.proxyProcessStartedAtSeconds,
    proxyProcessGroupId: deps.setIdentity.proxyProcessGroupId,
    canonicalEndpoint: deps.setIdentity.canonicalEndpoint,
    reservationId,
    activationNonce,
    providerRootPid: providerRoot.pid,
    providerRootProcessStartedAtSeconds: providerRoot.processStartedAtSeconds,
    jointContainmentReceipt,
    committedThroughProviderSeq: 0,
  };
  writeProviderOperationRuntimeMeta(deps.db, meta);

  // Step 3: guardian.operation-activate.v1, against the exact committed tuple.
  let jointActivationReceipt: string;
  try {
    const guardianResult = await callStrict(
      deps.guardianClient,
      'guardian.operation-activate.v1',
      { operation, reservationId, activationNonce, providerRoot, jointContainmentReceipt },
      timeoutMs,
      guardianActivateResultSchema,
    );
    jointActivationReceipt = guardianResult.jointActivationReceipt;
  } catch (error: unknown) {
    await compensateAfterActivationFailure(deps, operation, reservationId, activationNonce);
    return { kind: 'activation-failed', step: 'guardian-activate', reason: errorReason(error) };
  }

  // Step 4: operation.activate.v1 — verifies both receipts against the committed tuple, starts the
  // proxy-local kernel, and returns the executing ACK.
  //
  // No `committedThroughProviderSeq` in the request, though the plan's method table lists one. A freshly
  // activated operation has emitted nothing, so the only value it could ever carry is 0 — and the proxy's
  // `activateParamsSchema` is `.strict()`, so sending it made every activation fail `unrecognized_keys`,
  // compensate, and fall back to in-process execution. The watermark matters for the one case where it can
  // be non-zero, and `operation.adopt.v1` already owns that.
  try {
    const activateResult = await callStrict(
      deps.proxyClient,
      'operation.activate.v1',
      { operation, reservationId, activationNonce, jointContainmentReceipt, jointActivationReceipt },
      timeoutMs,
      proxyActivateResultSchema,
    );
    return {
      kind: 'executing',
      committedThroughProviderSeq: activateResult.committedThroughProviderSeq,
      meta,
      control: buildStopControl(deps, operation, timeoutMs),
    };
  } catch (error: unknown) {
    await compensateAfterActivationFailure(deps, operation, reservationId, activationNonce);
    return { kind: 'activation-failed', step: 'proxy-activate', reason: errorReason(error) };
  }
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
