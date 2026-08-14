import type { z } from 'zod';

import type { ControlClientError } from '../../provider-proxy/control-client.js';
import { operationPrepareAttemptKey } from '../../provider-proxy/ledger.js';
import {
  guardianOperationActivateParamsSchema,
  guardianOperationActivateResultSchema,
  proxyOperationActivateParamsSchema,
  proxyOperationActivationOutcomeSchema,
  proxyOperationAttachParamsSchema,
  proxyOperationAttachResultSchema,
  proxyOperationCancelParamsSchema,
  proxyOperationCancelResultSchema,
  proxyOperationInspectParamsSchema,
  proxyOperationInspectResultSchema,
  proxyOperationPrepareParamsSchema,
  proxyOperationPrepareResultSchema,
  proxyOperationSettleParamsSchema,
  proxyOperationSettleResultSchema,
  proxyOperationStopParamsSchema,
  proxyOperationStopResultSchema,
  type OperationIdentity,
  type ProxyOperationActivationOutcome,
  type ProxyControlProtocolErrorCode,
  type ProxyPreparedAppServerOperation,
} from '../../provider-proxy/protocol.js';
import type { ProviderOperationRecord } from '../../store/provider-operation-record.js';
import type { ProviderStopCause } from '../../providers/contract.js';
import type { OperationStopControl } from './operation-registry.js';
import type {
  ControlCallPolicy,
  ProviderProxyAuthorityFault,
  ProviderProxyOperationIncident,
  ProviderProxyRole,
} from './provider-proxy-authority-fault.js';
import type { ProviderProxySetIdentity } from './provider-proxy-set-identity.js';

export interface OperationControlClient {
  call(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

export interface ProviderProxyOperationActivationDeps {
  readonly proxyClient: OperationControlClient;
  readonly guardianClient: OperationControlClient;
  readonly setIdentity: ProviderProxySetIdentity;
  readonly mutationRpcTimeoutMs: number;
  readonly faultAuthority: (fault: ProviderProxyAuthorityFault) => void;
  readonly reportIncident?: (incident: ProviderProxyOperationIncident) => void;
}

export type PrepareProviderOperationResult = z.output<typeof proxyOperationPrepareResultSchema>;
export type InspectProviderOperationResult = z.output<typeof proxyOperationInspectResultSchema>;
export type AuthorizeProviderOperationResult = z.output<typeof guardianOperationActivateResultSchema>;
export type CancelProviderOperationResult = z.output<typeof proxyOperationCancelResultSchema>;
export type SettleProviderOperationResult = z.output<typeof proxyOperationSettleResultSchema>;
export type ActivateProviderOperationResult = z.output<typeof proxyOperationActivationOutcomeSchema>;
export type AttachProviderOperationResult = z.output<typeof proxyOperationAttachResultSchema>;

async function callStrict<TResult>(
  client: OperationControlClient,
  role: ProviderProxyRole,
  policy: ControlCallPolicy,
  params: unknown,
  timeoutMs: number,
  resultSchema: z.ZodType<TResult, z.ZodTypeDef, unknown>,
  faultAuthority: (fault: ProviderProxyAuthorityFault) => void,
  reportIncident: ((incident: ProviderProxyOperationIncident) => void) | undefined,
): Promise<TResult> {
  let raw: unknown;
  try {
    raw = await client.call(policy.method, params, timeoutMs);
  } catch (error: unknown) {
    routeControlCallFailure(role, policy, error, faultAuthority, reportIncident);
    throw error;
  }
  try {
    return resultSchema.parse(raw);
  } catch (error: unknown) {
    routeControlCallFailure(role, policy, error, faultAuthority, reportIncident);
    throw error;
  }
}

function routeControlCallFailure(
  role: ProviderProxyRole,
  policy: ControlCallPolicy,
  error: unknown,
  faultAuthority: (fault: ProviderProxyAuthorityFault) => void,
  reportIncident: ((incident: ProviderProxyOperationIncident) => void) | undefined,
): void {
  if (controlClientErrorCode(error) === 'control_client_closed') {
    faultAuthority({ kind: 'control-channel-fault', role, error: error as ControlClientError });
    return;
  }
  if (policy.effect === 'observation') return;
  const protocolCode = controlProtocolErrorCode(error);
  if (protocolCode !== null && policy.preEffectProtocolCodes.has(protocolCode)) return;
  if (policy.indeterminate === 'retry-safe') {
    reportIncident?.({ kind: 'operation-control-failed', policy, error });
    return;
  }
  faultAuthority({ kind: 'operation-control-failed', policy, error });
}

function controlClientErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function controlProtocolErrorCode(error: unknown): ProxyControlProtocolErrorCode | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { protocolCode?: unknown }).protocolCode;
  return typeof code === 'string' ? (code as ProxyControlProtocolErrorCode) : null;
}

const NO_PRE_EFFECT_PROTOCOL_CODES: ReadonlySet<ProxyControlProtocolErrorCode> = new Set();
const ACTIVATE_PRE_EFFECT_PROTOCOL_CODES: ReadonlySet<ProxyControlProtocolErrorCode> = new Set([
  'method_not_found',
  'identity_mismatch',
  'operation_not_found',
  'unauthorized_control',
]);

function policy(definition: ControlCallPolicy): ControlCallPolicy {
  return Object.freeze(definition);
}

export function providerOperationErrorIsAmbiguous(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as { code?: unknown; protocolCode?: unknown };
  return (
    (failure.code === 'control_call_failed' || failure.code === 'control_client_closed') &&
    failure.protocolCode === undefined
  );
}

export function providerOperationErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const failure = error as { code?: unknown; protocolCode?: unknown };
    if (typeof failure.protocolCode === 'string') return failure.protocolCode;
    if (typeof failure.code === 'string') return failure.code;
  }
  return 'provider_operation_failed';
}

export function providerOperationErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function providerOperationPrepareAttempt(
  deps: Pick<ProviderProxyOperationActivationDeps, 'setIdentity'>,
  operation: OperationIdentity,
  prepared: ProxyPreparedAppServerOperation,
  prepareAttemptNumber = 1,
): ProviderOperationPrepareAttempt {
  const request = proxyOperationPrepareParamsSchema.parse({
    operation,
    hostFingerprint: deps.setIdentity.hostFingerprint,
    prepareAttemptNumber,
    prepared,
  });
  return { request, prepareAttemptKey: operationPrepareAttemptKey(request) };
}

export type ProviderOperationPrepareAttempt = Readonly<{
  request: z.output<typeof proxyOperationPrepareParamsSchema>;
  prepareAttemptKey: string;
}>;

export async function prepareProviderOperation(
  deps: ProviderProxyOperationActivationDeps,
  attempt: ProviderOperationPrepareAttempt,
): Promise<PrepareProviderOperationResult> {
  const request = proxyOperationPrepareParamsSchema.parse(attempt.request);
  if (operationPrepareAttemptKey(request) !== attempt.prepareAttemptKey) {
    throw new Error('Provider operation prepare attempt fingerprint does not match its exact request.');
  }
  return callStrict(
    deps.proxyClient,
    'proxy',
    policy({
      method: 'operation.prepare.v1',
      phase: 'prepare-pending',
      effect: 'mutation',
      indeterminate: 'requires-containment',
      preEffectProtocolCodes: NO_PRE_EFFECT_PROTOCOL_CODES,
    }),
    request,
    deps.mutationRpcTimeoutMs,
    proxyOperationPrepareResultSchema,
    deps.faultAuthority,
    deps.reportIncident,
  );
}

export async function inspectProviderOperation(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  prepareAttemptKey: string,
): Promise<InspectProviderOperationResult> {
  const params = proxyOperationInspectParamsSchema.parse({ operation, prepareAttemptKey });
  return callStrict(
    deps.proxyClient,
    'proxy',
    policy({
      method: 'operation.inspect.v1',
      phase: 'prepare-pending',
      effect: 'observation',
      preEffectProtocolCodes: NO_PRE_EFFECT_PROTOCOL_CODES,
    }),
    params,
    deps.mutationRpcTimeoutMs,
    proxyOperationInspectResultSchema,
    deps.faultAuthority,
    deps.reportIncident,
  );
}

export async function authorizeProviderOperation(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  evidence: Readonly<{
    reservation: string;
    providerRoot: Readonly<{ pid: number; processStartedAtSeconds: number }>;
    jointContainmentReceipt: string;
  }>,
): Promise<AuthorizeProviderOperationResult> {
  const params = guardianOperationActivateParamsSchema.parse({ operation, ...evidence });
  return callStrict(
    deps.guardianClient,
    'guardian',
    policy({
      method: 'guardian.operation-activate.v1',
      phase: 'guardian-activation-pending',
      effect: 'mutation',
      indeterminate: 'requires-containment',
      preEffectProtocolCodes: NO_PRE_EFFECT_PROTOCOL_CODES,
    }),
    params,
    deps.mutationRpcTimeoutMs,
    guardianOperationActivateResultSchema,
    deps.faultAuthority,
    deps.reportIncident,
  );
}

export async function activateProviderOperation(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  evidence: Readonly<{
    reservation: string;
    jointContainmentReceipt: string;
    jointActivationReceipt: string;
  }>,
): Promise<ProxyOperationActivationOutcome> {
  const params = proxyOperationActivateParamsSchema.parse({ operation, ...evidence });
  return callStrict(
    deps.proxyClient,
    'proxy',
    policy({
      method: 'operation.activate.v1',
      phase: 'proxy-activation-pending',
      effect: 'mutation',
      indeterminate: 'requires-containment',
      preEffectProtocolCodes: ACTIVATE_PRE_EFFECT_PROTOCOL_CODES,
    }),
    params,
    deps.mutationRpcTimeoutMs,
    proxyOperationActivationOutcomeSchema,
    deps.faultAuthority,
    deps.reportIncident,
  );
}

export async function attachProviderOperation(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  committedThroughProviderSeq: number,
): Promise<AttachProviderOperationResult> {
  const params = proxyOperationAttachParamsSchema.parse({ operation, committedThroughProviderSeq });
  return callStrict(
    deps.proxyClient,
    'proxy',
    policy({
      method: 'operation.attach.v1',
      phase: 'executing',
      effect: 'mutation',
      indeterminate: 'retry-safe',
      preEffectProtocolCodes: NO_PRE_EFFECT_PROTOCOL_CODES,
    }),
    params,
    deps.mutationRpcTimeoutMs,
    proxyOperationAttachResultSchema,
    deps.faultAuthority,
    deps.reportIncident,
  );
}

export async function cancelProviderOperation(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  prepareAttemptNumber: number,
  prepareAttemptKey: string,
): Promise<CancelProviderOperationResult> {
  const params = proxyOperationCancelParamsSchema.parse({ operation, prepareAttemptNumber, prepareAttemptKey });
  return callStrict(
    deps.proxyClient,
    'proxy',
    policy({
      method: 'operation.cancel.v1',
      phase: 'prestart-cleanup-pending',
      effect: 'mutation',
      indeterminate: 'requires-containment',
      preEffectProtocolCodes: NO_PRE_EFFECT_PROTOCOL_CODES,
    }),
    params,
    deps.mutationRpcTimeoutMs,
    proxyOperationCancelResultSchema,
    deps.faultAuthority,
    deps.reportIncident,
  );
}

export async function settleProviderOperation(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  finalProviderSeq: number,
): Promise<SettleProviderOperationResult> {
  const params = proxyOperationSettleParamsSchema.parse({ operation, finalProviderSeq });
  return callStrict(
    deps.proxyClient,
    'proxy',
    policy({
      method: 'operation.settle.v1',
      phase: 'settlement-pending',
      effect: 'mutation',
      indeterminate: 'retry-safe',
      preEffectProtocolCodes: NO_PRE_EFFECT_PROTOCOL_CODES,
    }),
    params,
    deps.mutationRpcTimeoutMs,
    proxyOperationSettleResultSchema,
    deps.faultAuthority,
    deps.reportIncident,
  );
}

export function buildProviderOperationControl(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
): OperationStopControl {
  return {
    async stop(cause: ProviderStopCause): Promise<void> {
      const params = proxyOperationStopParamsSchema.parse({ operation, cause });
      await callStrict(
        deps.proxyClient,
        'proxy',
        policy({
          method: 'operation.stop.v1',
          phase: 'executing',
          effect: 'mutation',
          indeterminate: 'retry-safe',
          preEffectProtocolCodes: NO_PRE_EFFECT_PROTOCOL_CODES,
        }),
        params,
        deps.mutationRpcTimeoutMs,
        proxyOperationStopResultSchema,
        deps.faultAuthority,
        deps.reportIncident,
      );
    },
  };
}

export function providerOperationSetLocator(setIdentity: ProviderProxySetIdentity): ProviderOperationRecord['locator'] {
  return {
    hostFingerprint: setIdentity.hostFingerprint,
    proxy: {
      instanceId: setIdentity.proxyInstanceId,
      pid: setIdentity.proxyPid,
      processStartedAtSeconds: setIdentity.proxyProcessStartedAtSeconds,
      controlEndpoint: setIdentity.canonicalEndpoint,
    },
    guardian: {
      instanceId: setIdentity.guardianInstanceId,
      pid: setIdentity.guardianPid,
      processStartedAtSeconds: setIdentity.guardianProcessStartedAtSeconds,
      controlEndpoint: setIdentity.guardianControlEndpoint,
    },
    reaper: {
      instanceId: setIdentity.reaperInstanceId,
      pid: setIdentity.reaperPid,
      processStartedAtSeconds: setIdentity.reaperProcessStartedAtSeconds,
      controlEndpoint: setIdentity.reaperControlEndpoint,
    },
    containment: {
      pid: setIdentity.proxyPid,
      processStartedAtSeconds: setIdentity.proxyProcessStartedAtSeconds,
      processGroupId: setIdentity.proxyProcessGroupId,
      kind: setIdentity.containmentKind,
    },
  };
}
