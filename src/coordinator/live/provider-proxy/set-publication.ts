import { type z } from 'zod';

import { errorMessage } from '../../../infra/error-format.js';
import type { ControlClient, ControlExchange } from '../../../provider-proxy/control-client.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  PROXY_CONTROL_PRE_DISPATCH_REFUSAL_JSON_RPC_CODE,
  acquisitionPublicationUnknownResultSchema,
  guardianAcquisitionPublishParamsSchema,
  guardianAcquisitionPublishResultSchema,
  proxyAcquisitionPublishParamsSchema,
  proxyAcquisitionPublishResultSchema,
  type GuardianIdentity,
  type ProxyIdentity,
  type ReaperIdentity,
} from '../../../provider-proxy/protocol.js';

const publicationReceiptBrand: unique symbol = Symbol('PublicationReceipt');
const JSON_RPC_METHOD_NOT_FOUND = -32_601;

/** A set may become claimable only after the publication transaction mints this capability. */
export type PublicationReceipt = Readonly<{
  kind: 'provider-proxy-set-published';
  readonly [publicationReceiptBrand]: true;
}>;

type AcquisitionPublicationStageOutcome<T> =
  | Readonly<{ kind: 'ok'; value: T }>
  | Readonly<{ kind: 'not-attempted'; reason: string }>
  | Readonly<{ kind: 'unknown'; reason: string }>;

type AcquisitionStageConfirmed<T> = Exclude<T, z.infer<typeof acquisitionPublicationUnknownResultSchema>>;

export type ProviderProxySetPublicationOutcome =
  | Readonly<{ kind: 'published'; receipt: PublicationReceipt }>
  | Readonly<{ kind: 'not-attempted'; role: 'guardian' | 'proxy'; reason: string }>
  | Readonly<{ kind: 'publication-unknown'; role: 'guardian' | 'proxy'; reason: string }>;

export type ProviderProxySetPublicationUnknown = Extract<
  ProviderProxySetPublicationOutcome,
  { kind: 'publication-unknown' }
>;

/** A reply that cannot confirm publication must never be classified as a refusal or success. */
export async function exchangeAcquisitionStage<T>(
  client: ControlClient,
  method: string,
  params: unknown,
  resultSchema: z.ZodType<T>,
): Promise<AcquisitionPublicationStageOutcome<AcquisitionStageConfirmed<T>>> {
  let exchange: ControlExchange;
  try {
    exchange = await client.exchange(method, params, PROXY_CONTROL_RPC_TIMEOUT_MS);
  } catch (error: unknown) {
    return { kind: 'unknown', reason: errorMessage(error) };
  }
  if (exchange.kind === 'not-sent') {
    return { kind: 'not-attempted', reason: errorMessage(exchange.error) };
  }
  if (exchange.kind === 'response') {
    if (exchange.response.kind === 'refusal') {
      const { failure, error } = exchange.response;
      if (
        failure.kind === 'json-rpc-error' &&
        (failure.jsonRpcCode === PROXY_CONTROL_PRE_DISPATCH_REFUSAL_JSON_RPC_CODE ||
          (failure.jsonRpcCode === JSON_RPC_METHOD_NOT_FOUND && failure.protocolCode === 'method_not_found'))
      ) {
        return { kind: 'not-attempted', reason: error.message };
      }
      return { kind: 'unknown', reason: error.message };
    }
    const explicitOutcome = acquisitionPublicationUnknownResultSchema.safeParse(exchange.response.value);
    if (explicitOutcome.success) {
      return { kind: 'unknown', reason: explicitOutcome.data.reason };
    }
    const parsed = resultSchema.safeParse(exchange.response.value);
    if (!parsed.success) {
      return { kind: 'unknown', reason: `${method} replied with an undecodable result: ${parsed.error.message}` };
    }
    return { kind: 'ok', value: parsed.data as AcquisitionStageConfirmed<T> };
  }
  return { kind: 'unknown', reason: errorMessage(exchange.error) };
}

async function attemptAcquisitionStageWithRetry<T>(
  client: ControlClient,
  method: string,
  params: unknown,
  resultSchema: z.ZodType<T>,
): Promise<AcquisitionPublicationStageOutcome<AcquisitionStageConfirmed<T>>> {
  const first = await exchangeAcquisitionStage(client, method, params, resultSchema);
  return first.kind === 'unknown' ? exchangeAcquisitionStage(client, method, params, resultSchema) : first;
}

/** The receipt is minted only after guardian/reaper and proxy publication both return confirmed success. */
export async function runProviderProxySetPublicationTransaction(
  guardianClient: ControlClient,
  proxyClient: ControlClient,
  guardian: GuardianIdentity,
  reaper: ReaperIdentity,
  proxy: ProxyIdentity,
): Promise<ProviderProxySetPublicationOutcome> {
  const guardianOutcome = await attemptAcquisitionStageWithRetry(
    guardianClient,
    'guardian.acquisition-publish.v1',
    guardianAcquisitionPublishParamsSchema.parse({ guardian, reaper, proxy }),
    guardianAcquisitionPublishResultSchema,
  );
  if (guardianOutcome.kind !== 'ok') {
    return guardianOutcome.kind === 'unknown'
      ? { kind: 'publication-unknown', role: 'guardian', reason: guardianOutcome.reason }
      : { ...guardianOutcome, role: 'guardian' };
  }

  const proxyOutcome = await attemptAcquisitionStageWithRetry(
    proxyClient,
    'proxy.acquisition-publish.v1',
    proxyAcquisitionPublishParamsSchema.parse({
      certificate: guardianOutcome.value.certificate,
      guardian: guardianOutcome.value.guardian,
      reaper: guardianOutcome.value.reaper,
    }),
    proxyAcquisitionPublishResultSchema,
  );
  if (proxyOutcome.kind !== 'ok') {
    return proxyOutcome.kind === 'unknown'
      ? { kind: 'publication-unknown', role: 'proxy', reason: proxyOutcome.reason }
      : { ...proxyOutcome, role: 'proxy' };
  }
  return {
    kind: 'published',
    receipt: Object.freeze({ kind: 'provider-proxy-set-published' }) as PublicationReceipt,
  };
}
