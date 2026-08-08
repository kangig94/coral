import { z } from 'zod';

import { writeProviderOperationRuntimeMeta } from '../../jobs/runtime-meta-store.js';
import type { ProviderOperationRuntimeMeta } from '../../jobs/runtime-meta.js';
import { operationPrepareAttemptKey } from '../../provider-proxy/ledger.js';
import {
  guardianOperationActivateParamsSchema,
  guardianOperationActivateResultSchema,
  proxyOperationActivateParamsSchema,
  proxyOperationActivateResultSchema,
  proxyOperationCancelParamsSchema,
  proxyOperationCancelResultSchema,
  proxyOperationInspectParamsSchema,
  proxyOperationInspectResultSchema,
  proxyOperationPrepareCapacityResultSchema,
  proxyOperationPrepareParamsSchema,
  proxyOperationPreparePendingResultSchema,
  proxyOperationSettleParamsSchema,
  proxyOperationSettleResultSchema,
  proxyOperationStopParamsSchema,
  proxyOperationStopResultSchema,
  type OperationIdentity,
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

const prepareResultSchema = z.union([
  proxyOperationPreparePendingResultSchema,
  proxyOperationPrepareCapacityResultSchema,
]);

export type PrepareProviderOperationResult = z.output<typeof prepareResultSchema>;
export type InspectProviderOperationResult = z.output<typeof proxyOperationInspectResultSchema>;
export type AuthorizeProviderOperationResult = z.output<typeof guardianOperationActivateResultSchema>;
export type ActivateProviderOperationResult = z.output<typeof proxyOperationActivateResultSchema>;
export type CancelProviderOperationResult = z.output<typeof proxyOperationCancelResultSchema>;
export type SettleProviderOperationResult = z.output<typeof proxyOperationSettleResultSchema>;

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
): Readonly<{
  request: z.output<typeof proxyOperationPrepareParamsSchema>;
  prepareAttemptKey: string;
}> {
  const request = proxyOperationPrepareParamsSchema.parse({
    operation,
    hostFingerprint: deps.setIdentity.hostFingerprint,
    prepareAttemptNumber,
    prepared,
  });
  return { request, prepareAttemptKey: operationPrepareAttemptKey(request) };
}

export async function prepareProviderOperation(
  deps: ProviderProxyOperationActivationDeps,
  operation: OperationIdentity,
  prepared: ProxyPreparedAppServerOperation,
): Promise<PrepareProviderOperationResult> {
  const { request } = providerOperationPrepareAttempt(deps, operation, prepared);
  return callStrict(deps.proxyClient, 'operation.prepare.v1', request, deps.mutationRpcTimeoutMs, prepareResultSchema);
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
): Promise<ActivateProviderOperationResult> {
  const params = proxyOperationActivateParamsSchema.parse({ operation, ...evidence });
  return callStrict(
    deps.proxyClient,
    'operation.activate.v1',
    params,
    deps.mutationRpcTimeoutMs,
    proxyOperationActivateResultSchema,
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

export function providerOperationRuntimeMeta(
  record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
): ProviderOperationRuntimeMeta {
  return {
    version: 1,
    jobId: record.operation.jobId,
    operationId: record.operation.operationId,
    buildSetId: record.operation.buildSetId,
    hostFingerprint: record.locator.hostFingerprint,
    guardianInstanceId: record.locator.guardian.instanceId,
    guardianPid: record.locator.guardian.pid,
    guardianProcessStartedAtSeconds: record.locator.guardian.processStartedAtSeconds,
    guardianControlEndpoint: record.locator.guardian.controlEndpoint,
    proxyInstanceId: record.locator.proxy.instanceId,
    proxyPid: record.locator.proxy.pid,
    reaperInstanceId: record.locator.reaper.instanceId,
    reaperPid: record.locator.reaper.pid,
    reaperProcessStartedAtSeconds: record.locator.reaper.processStartedAtSeconds,
    reaperControlEndpoint: record.locator.reaper.controlEndpoint,
    containmentKind: record.locator.containment.kind,
    proxyProcessStartedAtSeconds: record.locator.proxy.processStartedAtSeconds,
    proxyProcessGroupId: record.locator.containment.processGroupId,
    canonicalEndpoint: record.locator.proxy.controlEndpoint,
    reservation: record.reservation,
    providerRootPid: record.providerRoot.pid,
    providerRootProcessStartedAtSeconds: record.providerRoot.processStartedAtSeconds,
    jointContainmentReceipt: record.jointContainmentReceipt,
    committedThroughProviderSeq: record.committedThroughProviderSeq,
  };
}

export function writeProviderOperationCompatibilityMeta(
  db: Parameters<typeof writeProviderOperationRuntimeMeta>[0],
  record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
): ProviderOperationRuntimeMeta {
  const meta = providerOperationRuntimeMeta(record);
  writeProviderOperationRuntimeMeta(db, meta);
  return meta;
}
