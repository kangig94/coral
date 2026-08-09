import type { z } from 'zod';

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
  type ProxyPreparedAppServerOperation,
} from '../../provider-proxy/protocol.js';
import type { ProviderOperationRecord } from '../../store/provider-operation-record.js';
import type { ProviderStopCause } from '../../providers/contract.js';
import type { OperationStopControl } from './operation-registry.js';

export interface OperationControlClient {
  call(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

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
  readonly proxyClient: OperationControlClient;
  readonly guardianClient: OperationControlClient;
  readonly setIdentity: ProviderProxySetIdentity;
  readonly mutationRpcTimeoutMs: number;
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
  method: string,
  params: unknown,
  timeoutMs: number,
  resultSchema: z.ZodType<TResult, z.ZodTypeDef, unknown>,
): Promise<TResult> {
  const raw = await client.call(method, params, timeoutMs);
  return resultSchema.parse(raw);
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
    'operation.prepare.v1',
    request,
    deps.mutationRpcTimeoutMs,
    proxyOperationPrepareResultSchema,
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
    'operation.inspect.v2',
    params,
    deps.mutationRpcTimeoutMs,
    proxyOperationInspectResultSchema,
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
    'guardian.operation-activate.v1',
    params,
    deps.mutationRpcTimeoutMs,
    guardianOperationActivateResultSchema,
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
    'operation.activate.v1',
    params,
    deps.mutationRpcTimeoutMs,
    proxyOperationActivationOutcomeSchema,
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
    'operation.attach.v1',
    params,
    deps.mutationRpcTimeoutMs,
    proxyOperationAttachResultSchema,
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
    'operation.cancel.v2',
    params,
    deps.mutationRpcTimeoutMs,
    proxyOperationCancelResultSchema,
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
    'operation.settle.v2',
    params,
    deps.mutationRpcTimeoutMs,
    proxyOperationSettleResultSchema,
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
        'operation.stop.v1',
        params,
        deps.mutationRpcTimeoutMs,
        proxyOperationStopResultSchema,
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
