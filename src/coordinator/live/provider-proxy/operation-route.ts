import type { OperationIdentity } from '../../../provider-proxy/protocol.js';
import {
  activateProviderOperation,
  attachProviderOperation,
  authorizeProviderOperation,
  buildProviderOperationControl,
  cancelProviderOperation,
  inspectProviderOperation,
  prepareProviderOperation,
  settleProviderOperation,
  type AuthorizeProviderOperationResult,
  type ActivateProviderOperationResult,
  type AttachProviderOperationResult,
  type CancelProviderOperationResult,
  type InspectProviderOperationResult,
  type OperationControlClient,
  type PrepareProviderOperationResult,
  type ProviderProxyOperationActivationDeps,
  type ProviderProxyAuthorityFault,
  type ProviderOperationPrepareAttempt,
  type SettleProviderOperationResult,
} from '../../services/provider-proxy-operation-activation.js';
import type { OperationStopControl } from '../../services/operation-registry.js';
import type { ProviderProxySetIdentity } from '../../services/provider-proxy-set-identity.js';
import type { ProviderProxySetAuthority, ProviderProxySetRecoveryAuthority } from './authority.js';

export interface ProviderProxyOperationAuthority extends ProviderProxySetAuthority {
  readonly setIdentity: ProviderProxySetIdentity;
  registerSuccessionOperation: ProviderProxySetRecoveryAuthority['registerSuccessionOperation'];
}

export interface DurableProviderProxyOperationAuthority extends ProviderProxyOperationAuthority {
  readonly faulted: Promise<ProviderProxyAuthorityFault>;
  onFault(listener: (fault: ProviderProxyAuthorityFault) => void): () => void;
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
  attachOperation(
    operation: OperationIdentity,
    committedThroughProviderSeq: number,
  ): Promise<AttachProviderOperationResult>;
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
    candidate.faulted instanceof Promise &&
    typeof candidate.onFault === 'function' &&
    typeof candidate.prepareOperation === 'function' &&
    typeof candidate.inspectOperation === 'function' &&
    typeof candidate.authorizeOperation === 'function' &&
    typeof candidate.activatePreparedOperation === 'function' &&
    typeof candidate.attachOperation === 'function' &&
    typeof candidate.cancelOperation === 'function' &&
    typeof candidate.settleOperation === 'function' &&
    typeof candidate.buildOperationControl === 'function'
  );
}

export function createProviderProxyOperationAuthority(deps: {
  base: ProviderProxySetAuthority & Pick<ProviderProxySetRecoveryAuthority, 'registerSuccessionOperation'>;
  setIdentity: ProviderProxySetIdentity;
  proxyClient: OperationControlClient;
  guardianClient: OperationControlClient;
  mutationRpcTimeoutMs: number;
}): DurableProviderProxyOperationAuthority {
  let resolveFault!: (fault: ProviderProxyAuthorityFault) => void;
  let faultLatched = false;
  let latchedFault: ProviderProxyAuthorityFault | null = null;
  const faultListeners = new Set<(fault: ProviderProxyAuthorityFault) => void>();
  const faulted = new Promise<ProviderProxyAuthorityFault>((resolve) => {
    resolveFault = resolve;
  });
  const faultAuthority = (fault: ProviderProxyAuthorityFault): void => {
    if (faultLatched) return;
    faultLatched = true;
    latchedFault = fault;
    for (const listener of faultListeners) listener(fault);
    resolveFault(fault);
  };
  for (const client of [deps.proxyClient, deps.guardianClient]) {
    void client.faulted?.then((error) => faultAuthority({ policy: null, error }));
  }
  const activationDeps: ProviderProxyOperationActivationDeps = {
    proxyClient: deps.proxyClient,
    guardianClient: deps.guardianClient,
    setIdentity: deps.setIdentity,
    mutationRpcTimeoutMs: deps.mutationRpcTimeoutMs,
    faultAuthority,
  };
  return {
    ...deps.base,
    faulted,
    onFault: (listener) => {
      if (latchedFault !== null) {
        listener(latchedFault);
        return () => undefined;
      }
      faultListeners.add(listener);
      return () => faultListeners.delete(listener);
    },
    setIdentity: deps.setIdentity,
    prepareOperation: (attempt) => prepareProviderOperation(activationDeps, attempt),
    inspectOperation: (operation, prepareAttemptKey) =>
      inspectProviderOperation(activationDeps, operation, prepareAttemptKey),
    authorizeOperation: (operation, evidence) => authorizeProviderOperation(activationDeps, operation, evidence),
    activatePreparedOperation: (operation, evidence) => activateProviderOperation(activationDeps, operation, evidence),
    attachOperation: (operation, committedThroughProviderSeq) =>
      attachProviderOperation(activationDeps, operation, committedThroughProviderSeq),
    cancelOperation: (operation, prepareAttemptNumber, prepareAttemptKey) =>
      cancelProviderOperation(activationDeps, operation, prepareAttemptNumber, prepareAttemptKey),
    settleOperation: (operation, finalProviderSeq) =>
      settleProviderOperation(activationDeps, operation, finalProviderSeq),
    buildOperationControl: (operation) => buildProviderOperationControl(activationDeps, operation),
  };
}
