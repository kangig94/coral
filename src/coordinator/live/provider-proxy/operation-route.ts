import type { OperationIdentity } from '../../../provider-proxy/protocol.js';
import {
  activateProviderOperation,
  authorizeProviderOperation,
  buildProviderOperationControl,
  cancelProviderOperation,
  inspectProviderOperation,
  prepareProviderOperation,
  settleProviderOperation,
  type ActivateProviderOperationResult,
  type AuthorizeProviderOperationResult,
  type CancelProviderOperationResult,
  type InspectProviderOperationResult,
  type OperationControlClient,
  type PrepareProviderOperationResult,
  type ProviderProxyOperationActivationDeps,
  type ProviderOperationPrepareAttempt,
  type ProviderProxySetIdentity,
  type SettleProviderOperationResult,
} from '../../services/provider-proxy-operation-activation.js';
import type { OperationStopControl } from '../../services/operation-registry.js';
import type { ProviderProxySetAuthority } from './authority.js';

export interface ProviderProxyOperationAuthority extends ProviderProxySetAuthority {
  readonly setIdentity: ProviderProxySetIdentity;
}

export interface DurableProviderProxyOperationAuthority extends ProviderProxyOperationAuthority {
  prepareOperation(attempt: ProviderOperationPrepareAttempt): Promise<PrepareProviderOperationResult>;
  inspectOperation(operation: OperationIdentity, prepareAttemptKey: string): Promise<InspectProviderOperationResult>;
  authorizeOperation(
    operation: OperationIdentity,
    evidence: Readonly<{
      reservation: string;
      providerRoot: Readonly<{ pid: number; processStartedAtSeconds: number }>;
      jointContainmentReceipt: string;
    }>,
  ): Promise<AuthorizeProviderOperationResult>;
  activatePreparedOperation(
    operation: OperationIdentity,
    evidence: Parameters<typeof activateProviderOperation>[2],
  ): Promise<ActivateProviderOperationResult>;
  cancelOperation(
    operation: OperationIdentity,
    prepareAttemptNumber: number,
    prepareAttemptKey: string,
  ): Promise<CancelProviderOperationResult>;
  settleOperation(operation: OperationIdentity, finalProviderSeq: number): Promise<SettleProviderOperationResult>;
  buildOperationControl(operation: OperationIdentity): OperationStopControl;
}

type ProviderProxyControlEstablishedListener = (authority: DurableProviderProxyOperationAuthority) => void;
const controlEstablishedListeners = new Set<ProviderProxyControlEstablishedListener>();

export function subscribeProviderProxyControlEstablished(
  listener: ProviderProxyControlEstablishedListener,
): () => void {
  controlEstablishedListeners.add(listener);
  return () => controlEstablishedListeners.delete(listener);
}

export function notifyProviderProxyControlEstablished(authority: DurableProviderProxyOperationAuthority): void {
  for (const listener of controlEstablishedListeners) listener(authority);
}

export function isProviderProxyOperationAuthority(
  value: ProviderProxySetAuthority,
): value is DurableProviderProxyOperationAuthority {
  const candidate = value as Partial<DurableProviderProxyOperationAuthority>;
  return (
    candidate.setIdentity !== undefined &&
    typeof candidate.prepareOperation === 'function' &&
    typeof candidate.inspectOperation === 'function' &&
    typeof candidate.authorizeOperation === 'function' &&
    typeof candidate.activatePreparedOperation === 'function' &&
    typeof candidate.cancelOperation === 'function' &&
    typeof candidate.settleOperation === 'function' &&
    typeof candidate.buildOperationControl === 'function'
  );
}

export function createProviderProxyOperationAuthority(deps: {
  base: ProviderProxySetAuthority;
  setIdentity: ProviderProxySetIdentity;
  proxyClient: OperationControlClient;
  guardianClient: OperationControlClient;
  mutationRpcTimeoutMs: number;
}): DurableProviderProxyOperationAuthority {
  const activationDeps: ProviderProxyOperationActivationDeps = {
    proxyClient: deps.proxyClient,
    guardianClient: deps.guardianClient,
    setIdentity: deps.setIdentity,
    mutationRpcTimeoutMs: deps.mutationRpcTimeoutMs,
  };
  return {
    ...deps.base,
    setIdentity: deps.setIdentity,
    prepareOperation: (attempt) => prepareProviderOperation(activationDeps, attempt),
    inspectOperation: (operation, prepareAttemptKey) =>
      inspectProviderOperation(activationDeps, operation, prepareAttemptKey),
    authorizeOperation: (operation, evidence) => authorizeProviderOperation(activationDeps, operation, evidence),
    activatePreparedOperation: (operation, evidence) => activateProviderOperation(activationDeps, operation, evidence),
    cancelOperation: (operation, prepareAttemptNumber, prepareAttemptKey) =>
      cancelProviderOperation(activationDeps, operation, prepareAttemptNumber, prepareAttemptKey),
    settleOperation: (operation, finalProviderSeq) =>
      settleProviderOperation(activationDeps, operation, finalProviderSeq),
    buildOperationControl: (operation) => buildProviderOperationControl(activationDeps, operation),
  };
}
