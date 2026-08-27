import type { z } from 'zod';

import { PROXY_CONTROL_RPC_TIMEOUT_MS } from '../../../provider-proxy/protocol.js';
import type { ProxyControlProtocolErrorCode } from '../../../provider-proxy/protocol.js';
import {
  connectRoleControlWithRetry,
  type RoleConnectRetryOptions,
  type runtimeControlTimer,
} from '../../../provider-proxy/role-spawn.js';
import {
  ControlClientError,
  type ControlClient,
  type ControlClientErrorCode,
  type ControlClientRemoteFailure,
  type ProviderEventHandler,
} from '../../../provider-proxy/control-client.js';
import type { HeartbeatObservation } from '../../../provider-proxy/heartbeat-observation.js';
import type { ProviderProxyHeartbeatMethod, ProviderProxyRole } from '../../services/provider-proxy-authority-fault.js';
import { heartbeatOnce } from './heartbeat.js';

export type ProviderProxyRoleOpenMethod =
  | 'control.open.v1'
  | 'guardian.open.v1'
  | 'reaper.open.v1'
  | 'guardian.handoff-redeem.v1'
  | 'reaper.handoff-rotate.v1'
  | 'handoff.redeem.v1';

export type ProviderProxyRecoveryOpenMethod = Extract<
  ProviderProxyRoleOpenMethod,
  'guardian.handoff-redeem.v1' | 'reaper.handoff-rotate.v1' | 'handoff.redeem.v1'
>;

export type ProviderProxyRoleControlAvailabilityIncident =
  | Readonly<{
      kind: 'role-control-unavailable';
      role: ProviderProxyRole;
      stage: 'connect' | 'open' | 'heartbeat';
      method: ProviderProxyRoleOpenMethod | ProviderProxyHeartbeatMethod | null;
      origin: 'timeout' | 'write' | 'closed';
      controlCode: ControlClientErrorCode;
    }>
  | Readonly<{
      kind: 'role-control-busy';
      role: ProviderProxyRole;
      method: ProviderProxyRecoveryOpenMethod;
      protocolCode: 'invalid_state';
      admissionReason: 'control-active';
    }>
  | Readonly<{
      kind: 'role-heartbeat-indeterminate';
      role: ProviderProxyRole;
      method: ProviderProxyHeartbeatMethod;
      observation: HeartbeatObservation;
    }>;

export class ProviderProxyRoleControlUnavailableError extends Error {
  readonly incident: ProviderProxyRoleControlAvailabilityIncident;

  constructor(incident: ProviderProxyRoleControlAvailabilityIncident, options?: ErrorOptions) {
    super('Provider proxy role control is temporarily unavailable.', options);
    this.name = 'ProviderProxyRoleControlUnavailableError';
    this.incident = incident;
    Object.setPrototypeOf(this, ProviderProxyRoleControlUnavailableError.prototype);
  }
}

function requireRemoteFailure(error: ControlClientError): ControlClientRemoteFailure {
  if (error.origin !== 'remote-response' || error.remoteFailure === null) {
    throw new Error('provider_proxy_role_control_remote_error_origin_mismatch');
  }
  return error.remoteFailure;
}

function remoteFailureDiagnostic(remoteFailure: ControlClientRemoteFailure): string {
  if (remoteFailure.kind === 'invalid-frame') return remoteFailure.kind;
  const diagnostic = [
    remoteFailure.kind,
    String(remoteFailure.jsonRpcCode),
    remoteFailure.protocolCode ?? 'unrecognized',
  ].join(':');
  const admission = remoteFailure.admissionReason === null ? '' : `:admission-reason=${remoteFailure.admissionReason}`;
  const heartbeat =
    remoteFailure.heartbeatRefusal === null ? '' : `:heartbeat-refusal=${remoteFailure.heartbeatRefusal.reason}`;
  return `${diagnostic}${admission}${heartbeat}`;
}

export class ProviderProxyRoleControlRemoteError extends Error {
  readonly role: ProviderProxyRole;
  readonly stage: 'connect' | 'open' | 'heartbeat';
  readonly method: ProviderProxyRoleOpenMethod | ProviderProxyHeartbeatMethod | null;
  readonly remoteFailure: ControlClientRemoteFailure;

  constructor(
    role: ProviderProxyRole,
    stage: ProviderProxyRoleControlRemoteError['stage'],
    method: ProviderProxyRoleControlRemoteError['method'],
    error: ControlClientError,
  ) {
    const remoteFailure = requireRemoteFailure(error);
    super(
      `Provider proxy role control returned a definitive remote failure: ${remoteFailureDiagnostic(remoteFailure)}.`,
      {
        cause: error,
      },
    );
    this.name = 'ProviderProxyRoleControlRemoteError';
    this.role = role;
    this.stage = stage;
    this.method = method;
    this.remoteFailure = remoteFailure;
    Object.setPrototypeOf(this, ProviderProxyRoleControlRemoteError.prototype);
  }
}

const RECOVERY_OPEN_METHODS = new Set<string>([
  'guardian.handoff-redeem.v1',
  'reaper.handoff-rotate.v1',
  'handoff.redeem.v1',
]);

function isRecoveryOpenMethod(
  method: ProviderProxyRoleOpenMethod | ProviderProxyHeartbeatMethod,
): method is ProviderProxyRecoveryOpenMethod {
  return RECOVERY_OPEN_METHODS.has(method);
}

function classifyRoleControlFailure(
  role: ProviderProxyRole,
  stage: 'connect' | 'open' | 'heartbeat',
  method: ProviderProxyRoleOpenMethod | ProviderProxyHeartbeatMethod | null,
  error: unknown,
): never {
  if (!(error instanceof ControlClientError)) throw error;
  if (error.origin !== 'remote-response') {
    throw new ProviderProxyRoleControlUnavailableError(
      {
        kind: 'role-control-unavailable',
        role,
        stage,
        method,
        origin: error.origin,
        controlCode: error.code,
      },
      { cause: error },
    );
  }
  const remote = error.remoteFailure;
  const recoveryOpenMethod = stage === 'open' && method !== null && isRecoveryOpenMethod(method) ? method : null;
  if (
    stage === 'open' &&
    recoveryOpenMethod !== null &&
    remote?.kind === 'json-rpc-error' &&
    remote.protocolCode === ('invalid_state' satisfies ProxyControlProtocolErrorCode) &&
    remote.admissionReason === 'control-active'
  ) {
    throw new ProviderProxyRoleControlUnavailableError(
      {
        kind: 'role-control-busy',
        role,
        method: recoveryOpenMethod,
        protocolCode: 'invalid_state',
        admissionReason: 'control-active',
      },
      { cause: error },
    );
  }
  throw new ProviderProxyRoleControlRemoteError(role, stage, method, error);
}

async function establishHeartbeat(
  role: ProviderProxyRole,
  client: ControlClient,
  method: ProviderProxyHeartbeatMethod,
  controlEpoch: number,
  firstChallenge: string,
): Promise<{ nextHeartbeatChallenge: string }> {
  let challenge = firstChallenge;
  let resynchronized = false;
  for (;;) {
    const observation = await heartbeatOnce(client, method, controlEpoch, challenge);
    if (observation.kind === 'locally-unsent') throw observation.error;
    if (observation.kind === 'channel-fault') {
      classifyRoleControlFailure(role, 'heartbeat', method, observation.error);
    }
    if (observation.kind === 'reply') {
      if (observation.reply.kind === 'accepted') {
        return { nextHeartbeatChallenge: observation.reply.nextChallenge };
      }
      if (observation.reply.kind === 'challenge-mismatch' && !resynchronized) {
        challenge = observation.reply.nextChallenge;
        resynchronized = true;
        continue;
      }
      if (observation.reply.kind === 'teardown-latched') {
        throw new ProviderProxyRoleControlRemoteError(role, 'heartbeat', method, observation.reply.error);
      }
    }
    throw new ProviderProxyRoleControlUnavailableError(
      { kind: 'role-heartbeat-indeterminate', role, method, observation },
      { cause: observation },
    );
  }
}

/**
 * Correctness depends on `client.faulted` settling before the same event settles the pending heartbeat exchange;
 * the types do not enforce that ordering. See `connectControlClient` in `src/provider-proxy/control-client.ts`.
 */
async function establishHeartbeatOrChannelFault(
  role: ProviderProxyRole,
  client: ControlClient,
  method: ProviderProxyHeartbeatMethod,
  controlEpoch: number,
  firstChallenge: string,
): Promise<{ nextHeartbeatChallenge: string }> {
  const channelFaulted = client.faulted.then((fault): never =>
    classifyRoleControlFailure(role, 'heartbeat', method, fault),
  );
  return Promise.race([establishHeartbeat(role, client, method, controlEpoch, firstChallenge), channelFaulted]);
}

/** Compares only the fields this acquisition can independently verify — everything it minted, plus (for the
 *  guardian alone) the pid and incarnation the acquisition observed by spawning it itself. A disagreement here
 *  means the connected process is not the one this acquisition created. */
function assertIdentityFieldsAgree(
  role: string,
  expected: Readonly<Record<string, string | number>>,
  actual: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(
        `${role} identity disagreement on ${key}: this acquisition issued ${String(value)}, the process reported ${String(actual[key])}.`,
      );
    }
  }
}

export type ControlTimer = ReturnType<typeof runtimeControlTimer>;

/** One role's connect→open→verify→heartbeat plan. `identity` pulls the role's own identity field out of the
 *  already-schema-validated open result — a selector rather than a `result[role]` lookup, so the compiler
 *  checks it against the concrete open-result type instead of trusting a string key at runtime. Exported so
 *  `services/provider-proxy-set/inheritance.ts` can describe its own redeem/rotate opens the same shape
 *  `establishRoleControl` already consumes, rather than a second, parallel plan type. */
export type RoleControlPlan<
  TOpened extends { controlEpoch: number; heartbeatChallenge: string },
  /** No default: `RoleControlPlan<TOpened>` would make `openParams` `any` and quietly undo the check below.
   *  Every use infers it from the schema at a call site, so there is nothing for a default to serve. */
  TOpenParams extends z.ZodTypeAny,
> = Readonly<
  {
    endpoint: string;
    /** Typed as the schema's own output rather than as its own parameter: an indexed access is not an inference
     *  site, so the schema below decides the shape instead of being inferred from whatever payload was written.
     *  Inferring the other way is how a `paramsSchema` argument ends up accepting any schema at all. */
    openParams: z.output<TOpenParams>;
    /** Required, which is the whole point: an open that skips validation no longer type-checks. */
    openParamsSchema: TOpenParams;
    openResultSchema: z.ZodType<TOpened>;
    identity: (opened: TOpened) => Record<string, unknown>;
    expectedIdentity: Readonly<Record<string, string | number>>;
  } & (
    | Readonly<{
        role: 'proxy';
        openMethod: 'control.open.v1' | 'handoff.redeem.v1';
        heartbeatMethod: 'control.heartbeat.v1';
        /** Only the proxy role ever pushes `provider.event.v1` back over this connection. */
        onProviderEvent?: ProviderEventHandler;
      }>
    | Readonly<{
        role: 'guardian';
        openMethod: 'guardian.open.v1' | 'guardian.handoff-redeem.v1';
        heartbeatMethod: 'guardian.heartbeat.v1';
        onProviderEvent?: never;
      }>
    | Readonly<{
        role: 'reaper';
        openMethod: 'reaper.open.v1' | 'reaper.handoff-rotate.v1';
        heartbeatMethod: 'reaper.heartbeat.v1';
        onProviderEvent?: never;
      }>
  )
>;

/**
 * Connects one role's control endpoint, opens it, verifies the identity it reports against what this
 * acquisition expects, and sends the first heartbeat — the sequence every one of the three roles goes
 * through in the same order, differing only in which method/params/schema/expected-identity apply.
 *
 * `opened` is mutated (the connected client is pushed the moment it exists, before anything can fail) so the
 * caller's own try/catch can still close every role connected so far, including this one, on a later
 * failure — the same close-everything-opened behavior a single inline try/catch gave when this was one block
 * per role instead of one shared function.
 *
 * Exported: `services/provider-proxy-set/inheritance.ts` drives the identical connect→open→verify→heartbeat
 * sequence for a redeemed tenancy (`guardian.handoff-redeem.v1`, `reaper.handoff-rotate.v1`,
 * `handoff.redeem.v1`) that `acquisition-steps.ts` drives for a freshly minted one — the opening credential
 * differs, the mechanics do not, so there is exactly one function that dials a role and keeps its first
 * challenge alive.
 */
export async function establishRoleControl<
  TOpened extends { controlEpoch: number; heartbeatChallenge: string },
  TOpenParams extends z.ZodTypeAny,
>(
  opened: ControlClient[],
  timer: ControlTimer,
  retry: RoleConnectRetryOptions,
  plan: RoleControlPlan<TOpened, TOpenParams>,
): Promise<Readonly<{ client: ControlClient; opened: TOpened; nextHeartbeatChallenge: string }>> {
  let client: ControlClient;
  try {
    client = await connectRoleControlWithRetry(plan.endpoint, timer, retry, plan.onProviderEvent);
  } catch (error: unknown) {
    classifyRoleControlFailure(plan.role, 'connect', null, error);
  }
  opened.push(client);
  const params = plan.openParamsSchema.parse(plan.openParams) as z.output<TOpenParams>;
  let raw: unknown;
  try {
    const exchange = await client.exchange(plan.openMethod, params, PROXY_CONTROL_RPC_TIMEOUT_MS);
    if (exchange.kind === 'response') {
      if (exchange.response.kind === 'result') raw = exchange.response.value;
      else classifyRoleControlFailure(plan.role, 'open', plan.openMethod, exchange.response.error);
    } else {
      classifyRoleControlFailure(plan.role, 'open', plan.openMethod, exchange.error);
    }
  } catch (error: unknown) {
    classifyRoleControlFailure(plan.role, 'open', plan.openMethod, error);
  }
  const result = plan.openResultSchema.parse(raw);
  assertIdentityFieldsAgree(plan.role, plan.expectedIdentity, plan.identity(result));
  const beat = await establishHeartbeatOrChannelFault(
    plan.role,
    client,
    plan.heartbeatMethod,
    result.controlEpoch,
    result.heartbeatChallenge,
  );
  return { client, opened: result, nextHeartbeatChallenge: beat.nextHeartbeatChallenge };
}
