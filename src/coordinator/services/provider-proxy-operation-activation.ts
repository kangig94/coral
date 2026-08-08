import { z } from 'zod';

import type { Database } from '../../store/db.js';
import {
  deleteProviderOperationRuntimeMeta,
  writeProviderOperationRuntimeMeta,
} from '../../jobs/runtime-meta-store.js';
import { providerOperationRuntimeMetaSchema, type ProviderOperationRuntimeMeta } from '../../jobs/runtime-meta.js';
import {
  guardianOperationActivateParamsSchema,
  guardianOperationActivateResultSchema,
  guardianOperationReleaseParamsSchema,
  guardianOperationReleaseResultSchema,
  proxyOperationActivateParamsSchema,
  proxyOperationActivateResultSchema,
  proxyOperationCancelPendingResultSchema,
  proxyOperationPrepareCapacityResultSchema,
  proxyOperationPrepareParamsSchema,
  proxyOperationPreparePendingResultSchema,
  proxyOperationReservationParamsSchema,
  proxyOperationStopParamsSchema,
  proxyOperationStopResultSchema,
  type JointActivationReceipt,
  type JointContainmentReceipt,
  type OperationIdentity,
  type Reservation,
  type ProxyPreparedAppServerOperation,
} from '../../provider-proxy/protocol.js';
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
 * This module owns the orchestration only, not the connector to a live proxy set. That connector is
 * `coordinator/live/provider-proxy/operation-route.ts`'s `createProviderProxyOperationAuthority`, which wraps
 * an already-built `ProviderProxySetAuthority` (`coordinator/live/provider-proxy/authority.ts`, still written
 * from coordinated shutdown's side on purpose) with the two control clients the steps below actually need and
 * calls `activateProviderOperation` against them. `coordinator/live/provider-hosts/` acquires that set per
 * executable identity and routes to it; `coordinator/services/provider-proxy-launch-route.ts` is the
 * production caller that composes the prepared envelope and drives the route end to end.
 */

/** The minimal wire capability this file needs from a role's control connection: `ControlClient.call` from
 *  `provider-proxy/control-client.ts`, restated here rather than imported so this module depends on a shape,
 *  not that module's class identity — decoupling the connection this file is handed from the concrete
 *  transport class that produces it. */
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

/**
 * The two correlation fields are taken from the row this same function is about to write, not restated:
 * `z.string().min(1)` accepted values the durable schema refuses, so a non-canonical reservation passed this
 * ingress and then threw at `writeProviderOperationRuntimeMeta` — after `operation.prepare.v1` had already
 * staged a provider root. Two files independently choosing the same shape agree by coincidence; deriving one
 * from the other agrees by construction. `coordinator/services/` may reach for it because it imports both,
 * and `jobs/runtime-meta.ts` deliberately cannot import the wire schemas (see its own note on why).
 *
 * The brand is applied on top of that derivation rather than instead of it. Validation still comes from the
 * row — one shape, by construction — while the brand records that this value arrived in the proxy's reply and
 * was not invented here. It cannot live on the durable schema: a `jobs/` module may not name a
 * `provider-proxy/` type, and a value read back out of SQLite after a restart was minted by no live authority
 * in this process, so branding it would need a `trustTheStore()` constructor — a mint with nothing behind it.
 * Writing the branded value back is free, since a brand is assignable to the plain string the row holds.
 *
 * Which leaves the rest of the reply shape coming from the proxy's own schema, extended rather than retyped.
 * The proxy is the authority on what it emits; this function is the authority on what it can still persist.
 * Two questions, and the `extend` is what keeps them one shape: a field the proxy adds arrives here without
 * anyone remembering to add it, and only the two the durable row constrains are named.
 */
const preparePendingSchema = proxyOperationPreparePendingResultSchema.extend({
  reservation: providerOperationRuntimeMetaSchema.shape.reservation.brand<'Reservation'>(),
  jointContainmentReceipt:
    providerOperationRuntimeMetaSchema.shape.jointContainmentReceipt.brand<'JointContainmentReceipt'>(),
});
const prepareResultSchema = z.union([preparePendingSchema, proxyOperationPrepareCapacityResultSchema]);

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

/**
 * Calls one control method, checking the request against its own schema on the way out and the reply on the
 * way back. `paramsSchema` is required: every method this module sends has a shared schema, so an unvalidated
 * send from here is not expressible rather than merely discouraged.
 *
 * `TSchema` is inferred from `paramsSchema` alone and `params` is typed `z.output<TSchema>` — an indexed
 * access, which is not an inference site — so the payload is checked against what the schema *produces*. The
 * earlier shape, `params: TParams` with `paramsSchema: z.ZodType<TParams>`, inferred `TParams` from the
 * payload instead and then accepted any schema contravariantly, which was fine while every field was a plain
 * string and silently useless the moment one carried a brand: a `runtime.ids.uuid()` handed to a field that
 * requires a received value compiled without complaint. Measured, not assumed.
 *
 * `resultSchema`'s input slot is `unknown` for the same reason: a branded schema's input and output types
 * diverge, so the one-parameter `z.ZodType<TResult>` stops unifying with it.
 */
async function callStrict<TSchema extends z.ZodTypeAny, TResult>(
  client: OperationControlClient,
  method: string,
  params: z.output<TSchema>,
  timeoutMs: number,
  paramsSchema: TSchema,
  resultSchema: z.ZodType<TResult, z.ZodTypeDef, unknown>,
): Promise<TResult> {
  // The parsed value is what goes on the wire, not the input it was parsed from. Identical today — none of
  // these schemas transforms — but the first `.default()` or `z.coerce` would otherwise make the value that
  // was validated and the bytes that were sent two different things, which is this branch's own thesis
  // pointed inward. `provider-proxy-set-inheritance.ts`'s two inline sends already do it this way.
  const validated = paramsSchema.parse(params) as z.output<TSchema>;
  const raw = await client.call(method, validated, timeoutMs);
  return resultSchema.parse(raw);
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
      await callStrict(
        deps.proxyClient,
        'operation.stop.v1',
        { operation, cause },
        timeoutMs,
        proxyOperationStopParamsSchema,
        proxyOperationStopResultSchema,
      );
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
  reservation: Reservation,
  jointContainmentReceipt: JointContainmentReceipt,
): Promise<void> {
  deleteProviderOperationRuntimeMeta(deps.db, operation.jobId, operation.operationId);
  await callStrict(
    deps.proxyClient,
    'operation.cancel-pending.v1',
    { operation, reservation },
    deps.mutationRpcTimeoutMs,
    proxyOperationReservationParamsSchema,
    proxyOperationCancelPendingResultSchema,
  );
  // The receipt travels here for the same reason `guardian.operation-activate.v1` carries it: the guardian's
  // release handler refuses a caller that cannot present the receipt its own staging minted, and its params
  // schema is `.strict()` with the receipt required. Omitting it used to reach the wire and throw there,
  // which replaced the activation failure that called it with a validation error about the compensation —
  // `guardianOperationReleaseParamsSchema` now parses this payload here too, so that omission fails at this
  // call site instead, with this exact intent visible in the stack rather than a generic wire refusal.
  await callStrict(
    deps.guardianClient,
    'guardian.operation-release.v1',
    { operation, reservation, jointContainmentReceipt },
    deps.mutationRpcTimeoutMs,
    guardianOperationReleaseParamsSchema,
    guardianOperationReleaseResultSchema,
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
    proxyOperationPrepareParamsSchema,
    prepareResultSchema,
  );
  if (prepareResult.state === 'capacity') {
    return { kind: 'capacity', retryable: prepareResult.retryable, reason: prepareResult.reason };
  }
  const { reservation, providerRoot, jointContainmentReceipt } = prepareResult;

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
    reservation,
    providerRootPid: providerRoot.pid,
    providerRootProcessStartedAtSeconds: providerRoot.processStartedAtSeconds,
    jointContainmentReceipt,
    committedThroughProviderSeq: 0,
  };
  writeProviderOperationRuntimeMeta(deps.db, meta);

  // Step 3: guardian.operation-activate.v1, against the exact committed tuple.
  // Branded: the only way to hold one is to have parsed the guardian's reply that carried it, which is what
  // the next step must present. A plain `string` here would silently re-open the send site to any value.
  let jointActivationReceipt: JointActivationReceipt;
  try {
    const guardianResult = await callStrict(
      deps.guardianClient,
      'guardian.operation-activate.v1',
      { operation, reservation, providerRoot, jointContainmentReceipt },
      timeoutMs,
      guardianOperationActivateParamsSchema,
      guardianOperationActivateResultSchema,
    );
    jointActivationReceipt = guardianResult.jointActivationReceipt;
  } catch (error: unknown) {
    await compensateAfterActivationFailure(deps, operation, reservation, jointContainmentReceipt);
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
  //
  // That extra field is now unstateable from here: `proxyOperationActivateParamsSchema` is `.strict()` and is
  // parsed at this sender before the frame is written, so the same mistake fails here rather than on arrival.
  try {
    const activateResult = await callStrict(
      deps.proxyClient,
      'operation.activate.v1',
      { operation, reservation, jointContainmentReceipt, jointActivationReceipt },
      timeoutMs,
      proxyOperationActivateParamsSchema,
      proxyOperationActivateResultSchema,
    );
    return {
      kind: 'executing',
      committedThroughProviderSeq: activateResult.committedThroughProviderSeq,
      meta,
      control: buildStopControl(deps, operation, timeoutMs),
    };
  } catch (error: unknown) {
    await compensateAfterActivationFailure(deps, operation, reservation, jointContainmentReceipt);
    return { kind: 'activation-failed', step: 'proxy-activate', reason: errorReason(error) };
  }
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
