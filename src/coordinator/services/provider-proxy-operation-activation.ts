import { z } from 'zod';

import type { Database } from '../../store/db.js';
import {
  deleteProviderOperationRuntimeMeta,
  writeProviderOperationRuntimeMeta,
} from '../../jobs/runtime-meta-store.js';
import { providerOperationRuntimeMetaSchema, type ProviderOperationRuntimeMeta } from '../../jobs/runtime-meta.js';
import { operationPrepareAttemptKey, operationPrepareStatusParamsSchema } from '../../provider-proxy/ledger.js';
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
 * `operation.activate.v1`, with compensation for authoritative refusals and retained runtime ownership for
 * an activation whose reply is ambiguous. An ambiguous prepare never authorizes local execution until the
 * proxy's status resolves whether it owns the attempt. No other transition may start the kernel.
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
const prepareStatusResultSchema = z.union([
  preparePendingSchema,
  z.object({ state: z.literal('absent') }).strict(),
  z.object({ state: z.literal('preparing') }).strict(),
]);

export type ActivateProviderOperationResult =
  | Readonly<{
      kind: 'executing';
      committedThroughProviderSeq: number;
      /** The exact row this call committed to `provider_operation.v1:<jobId>:<operationId>` — handed back so
       *  the caller (`createAppServerProxyRoute`) can register it with `LocalOperationRegistry.activate()`
       *  without re-deriving it from anything. */
      meta: ProviderOperationRuntimeMeta;
      /** This operation's `operation.stop.v1` and `guardian.operation-release.v1` capabilities, bound to the
       *  exact `proxyClient`/`guardianClient` and identity/reservation/receipt tuple this activation used. */
      control: OperationStopControl;
    }>
  /** The proxy's own ledger is at `MAX_PROXY_OPERATION_LEDGERS` capacity. Admission stays with the caller —
   *  nothing was written, so a retry is exactly as safe as the first attempt. */
  | Readonly<{ kind: 'capacity'; retryable: boolean; reason: string }>
  /** The proxy authoritatively reported that neither prepare attempt left a reservation behind. */
  | Readonly<{ kind: 'absent'; reason: string }>
  /** An authoritative refusal or local commit failure for which compensation completed. */
  | Readonly<{
      kind: 'activation-failed';
      step: 'runtime-meta' | 'guardian-activate' | 'proxy-activate';
      reason: string;
    }>
  | Readonly<{
      kind: 'unknown';
      step: 'proxy-prepare';
      reason: string;
    }>
  | Readonly<{
      kind: 'unknown';
      step: 'guardian-activate' | 'proxy-activate';
      reason: string;
      committedThroughProviderSeq: number;
      meta: ProviderOperationRuntimeMeta;
      control: OperationStopControl;
    }>;

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

function protocolCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as { protocolCode?: unknown }).protocolCode;
  return typeof value === 'string' ? value : undefined;
}

function isAmbiguousControlOutcome(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as { code?: unknown; protocolCode?: unknown };
  return (
    (failure.code === 'control_call_failed' || failure.code === 'control_client_closed') &&
    failure.protocolCode === undefined
  );
}

function shouldRetryPrepare(error: unknown): boolean {
  return isAmbiguousControlOutcome(error);
}

type PrepareResult = z.output<typeof prepareResultSchema>;
type PrepareStatusResult = z.output<typeof prepareStatusResultSchema>;
type ReconciledPrepareResult =
  | PrepareResult
  | Readonly<{ state: 'absent'; reason: string }>
  | Readonly<{ state: 'unknown'; reason: string }>;

async function reconcileAmbiguousPrepare(
  prepare: () => Promise<PrepareResult>,
  status: () => Promise<PrepareStatusResult>,
  initialReason: string,
): Promise<ReconciledPrepareResult> {
  let reason = initialReason;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let statusResult: PrepareStatusResult;
    try {
      statusResult = await status();
    } catch (error: unknown) {
      reason = `${reason}; prepare status failed: ${errorReason(error)}`;
      continue;
    }
    if (statusResult.state === 'absent') return { state: 'absent', reason };
    if (statusResult.state !== 'preparing') return statusResult;

    reason = `${reason}; prepare status is preparing`;
    try {
      return await prepare();
    } catch (error: unknown) {
      reason = `${reason}; prepare recovery failed: ${errorReason(error)}`;
    }
  }
  return { state: 'unknown', reason };
}

/** A lost release reply keeps the capability retryable: only a later authoritative "already absent" proves
 *  the first call landed, while any other refusal leaves the exact membership tuple available to try again. */
function buildGuardianMembershipRelease(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  reservation: Reservation,
  jointContainmentReceipt: JointContainmentReceipt,
  timeoutMs: number,
): () => Promise<void> {
  let releaseState: 'ready' | 'unknown' | 'released' = 'ready';
  return async (): Promise<void> => {
    if (releaseState === 'released') return;
    const retryingUnknown = releaseState === 'unknown';
    try {
      await callStrict(
        deps.guardianClient,
        'guardian.operation-release.v1',
        { operation, reservation, jointContainmentReceipt },
        timeoutMs,
        guardianOperationReleaseParamsSchema,
        guardianOperationReleaseResultSchema,
      );
      releaseState = 'released';
    } catch (error: unknown) {
      if (retryingUnknown && protocolCode(error) === 'unauthorized_control') {
        releaseState = 'released';
        return;
      }
      releaseState = isAmbiguousControlOutcome(error) ? 'unknown' : 'ready';
      throw error;
    }
  };
}

function buildOperationControl(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  reservation: Reservation,
  jointContainmentReceipt: JointContainmentReceipt,
  timeoutMs: number,
): OperationStopControl {
  const releaseMembership = buildGuardianMembershipRelease(
    deps,
    operation,
    reservation,
    jointContainmentReceipt,
    timeoutMs,
  );
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
    releaseMembership,
  };
}

function buildPendingOperationControl(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  reservation: Reservation,
  jointContainmentReceipt: JointContainmentReceipt,
  timeoutMs: number,
): OperationStopControl {
  const releaseMembership = buildGuardianMembershipRelease(
    deps,
    operation,
    reservation,
    jointContainmentReceipt,
    timeoutMs,
  );
  return {
    async stop(): Promise<void> {
      await cancelPendingReservation(deps, operation, reservation);
      await releaseMembership();
    },
    releaseMembership,
  };
}

async function cancelPendingReservation(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  reservation: Reservation,
): Promise<void> {
  const cancel = (): Promise<unknown> =>
    callStrict(
      deps.proxyClient,
      'operation.cancel-pending.v1',
      { operation, reservation },
      deps.mutationRpcTimeoutMs,
      proxyOperationReservationParamsSchema,
      proxyOperationCancelPendingResultSchema,
    );
  try {
    await cancel();
  } catch (error: unknown) {
    if (!isAmbiguousControlOutcome(error)) throw error;
    await cancel();
  }
}

async function releaseGuardianMembership(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  reservation: Reservation,
  jointContainmentReceipt: JointContainmentReceipt,
): Promise<void> {
  const release = (): Promise<unknown> =>
    callStrict(
      deps.guardianClient,
      'guardian.operation-release.v1',
      { operation, reservation, jointContainmentReceipt },
      deps.mutationRpcTimeoutMs,
      guardianOperationReleaseParamsSchema,
      guardianOperationReleaseResultSchema,
    );
  try {
    await release();
  } catch (error: unknown) {
    if (!isAmbiguousControlOutcome(error)) throw error;
    try {
      await release();
    } catch (retryError: unknown) {
      if (protocolCode(retryError) !== 'unauthorized_control') throw retryError;
    }
  }
}

async function compensateAfterActivationFailure(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  reservation: Reservation,
  jointContainmentReceipt: JointContainmentReceipt,
): Promise<void> {
  deleteProviderOperationRuntimeMeta(deps.db, operation.jobId, operation.operationId);
  let failure: unknown;
  try {
    await cancelPendingReservation(deps, operation, reservation);
  } catch (error: unknown) {
    failure = error;
  }
  try {
    await releaseGuardianMembership(deps, operation, reservation, jointContainmentReceipt);
  } catch (error: unknown) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorReason(failure));
}

/**
 * Runs the complete closed publication order for one operation: `operation.prepare.v1` on the proxy,
 * durably committing the runtime-meta locator, `guardian.operation-activate.v1`, then `operation.activate.v1`
 * — in exactly that order, with no other transition permitted to start the kernel. A transport-ambiguous
 * prepare retries, then reconciles by the stable attempt key before publication continues; an ambiguous
 * activation remains remotely owned.
 */
export async function activateProviderOperation(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  prepared: ProxyPreparedAppServerOperation,
): Promise<ActivateProviderOperationResult> {
  const timeoutMs = deps.mutationRpcTimeoutMs || MUTATION_RPC_TIMEOUT_DEFAULT_MS;

  // Step 1: operation.prepare.v1 — reservation, provider root, containment receipt; semantic execution stays
  // forbidden until step 4.
  const prepareRequest = proxyOperationPrepareParamsSchema.parse({
    operation,
    hostFingerprint: deps.setIdentity.hostFingerprint,
    prepared,
  });
  const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
  const prepare = (): Promise<z.output<typeof prepareResultSchema>> =>
    callStrict(
      deps.proxyClient,
      'operation.prepare.v1',
      prepareRequest,
      timeoutMs,
      proxyOperationPrepareParamsSchema,
      prepareResultSchema,
    );
  const status = (): Promise<PrepareStatusResult> =>
    callStrict(
      deps.proxyClient,
      'operation.status.v1',
      { prepareAttemptKey },
      timeoutMs,
      operationPrepareStatusParamsSchema,
      prepareStatusResultSchema,
    );
  let prepareResult: ReconciledPrepareResult;
  try {
    prepareResult = await prepare();
  } catch (error: unknown) {
    if (!shouldRetryPrepare(error)) throw error;
    try {
      prepareResult = await prepare();
    } catch (retryError: unknown) {
      prepareResult = await reconcileAmbiguousPrepare(
        prepare,
        status,
        `${errorReason(error)}; prepare retry failed: ${errorReason(retryError)}`,
      );
    }
  }
  if (prepareResult.state === 'unknown') {
    return { kind: 'unknown', step: 'proxy-prepare', reason: prepareResult.reason };
  }
  if (prepareResult.state === 'absent') {
    return { kind: 'absent', reason: prepareResult.reason };
  }
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
  try {
    writeProviderOperationRuntimeMeta(deps.db, meta);
  } catch (error: unknown) {
    await compensateAfterActivationFailure(deps, operation, reservation, jointContainmentReceipt);
    return { kind: 'activation-failed', step: 'runtime-meta', reason: errorReason(error) };
  }

  // Step 3: guardian.operation-activate.v1, against the exact committed tuple.
  // Branded: the only way to hold one is to have parsed the guardian's reply that carried it, which is what
  // the next step must present. A plain `string` here would silently re-open the send site to any value.
  const authorize = (): Promise<z.output<typeof guardianOperationActivateResultSchema>> =>
    callStrict(
      deps.guardianClient,
      'guardian.operation-activate.v1',
      { operation, reservation, providerRoot, jointContainmentReceipt },
      timeoutMs,
      guardianOperationActivateParamsSchema,
      guardianOperationActivateResultSchema,
    );
  let jointActivationReceipt: JointActivationReceipt;
  try {
    const guardianResult = await authorize();
    jointActivationReceipt = guardianResult.jointActivationReceipt;
  } catch (error: unknown) {
    if (!isAmbiguousControlOutcome(error)) {
      await compensateAfterActivationFailure(deps, operation, reservation, jointContainmentReceipt);
      return { kind: 'activation-failed', step: 'guardian-activate', reason: errorReason(error) };
    }
    try {
      const guardianResult = await authorize();
      jointActivationReceipt = guardianResult.jointActivationReceipt;
    } catch (retryError: unknown) {
      if (!isAmbiguousControlOutcome(retryError)) {
        await compensateAfterActivationFailure(deps, operation, reservation, jointContainmentReceipt);
        return { kind: 'activation-failed', step: 'guardian-activate', reason: errorReason(retryError) };
      }
      return {
        kind: 'unknown',
        step: 'guardian-activate',
        reason: `${errorReason(error)}; retry failed: ${errorReason(retryError)}`,
        committedThroughProviderSeq: 0,
        meta,
        control: buildPendingOperationControl(deps, operation, reservation, jointContainmentReceipt, timeoutMs),
      };
    }
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
  const activate = (): Promise<z.output<typeof proxyOperationActivateResultSchema>> =>
    callStrict(
      deps.proxyClient,
      'operation.activate.v1',
      { operation, reservation, jointContainmentReceipt, jointActivationReceipt },
      timeoutMs,
      proxyOperationActivateParamsSchema,
      proxyOperationActivateResultSchema,
    );
  try {
    const activateResult = await activate();
    return {
      kind: 'executing',
      committedThroughProviderSeq: activateResult.committedThroughProviderSeq,
      meta,
      control: buildOperationControl(deps, operation, reservation, jointContainmentReceipt, timeoutMs),
    };
  } catch (error: unknown) {
    if (!isAmbiguousControlOutcome(error)) {
      await compensateAfterActivationFailure(deps, operation, reservation, jointContainmentReceipt);
      return { kind: 'activation-failed', step: 'proxy-activate', reason: errorReason(error) };
    }
    try {
      const activateResult = await activate();
      return {
        kind: 'executing',
        committedThroughProviderSeq: activateResult.committedThroughProviderSeq,
        meta,
        control: buildOperationControl(deps, operation, reservation, jointContainmentReceipt, timeoutMs),
      };
    } catch (retryError: unknown) {
      if (!isAmbiguousControlOutcome(retryError)) {
        await compensateAfterActivationFailure(deps, operation, reservation, jointContainmentReceipt);
        return { kind: 'activation-failed', step: 'proxy-activate', reason: errorReason(retryError) };
      }
      return {
        kind: 'unknown',
        step: 'proxy-activate',
        reason: `${errorReason(error)}; retry failed: ${errorReason(retryError)}`,
        committedThroughProviderSeq: 0,
        meta,
        control: buildOperationControl(deps, operation, reservation, jointContainmentReceipt, timeoutMs),
      };
    }
  }
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
