import type { ProcessIncarnation } from '../../../infra/node-process.js';
import type { ControlClient } from '../../../provider-proxy/control-client.js';
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
  type PrepareProviderOperationResult,
  type ProviderProxyOperationActivationDeps,
  type ProviderOperationPrepareAttempt,
  type SettleProviderOperationResult,
} from '../../services/provider-proxy-operation-activation.js';
import type { OperationStopControl } from '../../services/operation-registry.js';
import type {
  ProviderProxyAuthorityFault,
  ProviderProxyAuthorityFaultLatch,
  ProviderProxyAuthorityObservation,
  ProviderProxyRoleClients,
} from '../../services/provider-proxy-authority-fault.js';
import {
  providerProxySetIdentitiesEqual,
  type ProviderProxySetIdentity,
} from '../../services/provider-proxy-set/identity.js';
import {
  closeRedeemedProviderProxyControl,
  providerProxyControlRedemptionBundle,
  type ProviderProxyControlRedemptionOutcome,
  type RedeemedProviderProxyControl,
} from './control-redemption.js';
import type { ProviderProxySetAuthority } from './authority.js';
import type { ProviderProxySetRecoveryAuthority } from './set-authority.js';

export interface ProviderProxyOperationAuthority
  extends ProviderProxySetAuthority, Pick<ProviderProxySetRecoveryAuthority, 'autonomousDeadline'> {
  readonly setIdentity: ProviderProxySetIdentity;
  registerSuccessionOperation: ProviderProxySetRecoveryAuthority['registerSuccessionOperation'];
}

export interface DurableProviderProxyOperationAuthority extends ProviderProxyOperationAuthority {
  readonly faulted: Promise<ProviderProxyAuthorityFault>;
  onFault(listener: (fault: ProviderProxyAuthorityFault) => void): () => void;
  onIncident(listener: (observation: ProviderProxyAuthorityObservation) => void): () => void;
  redeemControl(signal: AbortSignal): Promise<ProviderProxyControlRedemptionOutcome>;
  promoteControl(
    redemption: RedeemedProviderProxyControl,
    signal: AbortSignal,
  ): Promise<DurableProviderProxyOperationAuthority>;
  prepareOperation(attempt: ProviderOperationPrepareAttempt): Promise<PrepareProviderOperationResult>;
  inspectOperation(operation: OperationIdentity, prepareAttemptKey: string): Promise<InspectProviderOperationResult>;
  authorizeOperation(
    operation: OperationIdentity,
    evidence: Readonly<{
      reservation: string;
      providerRoot: Readonly<{ pid: number; incarnation: ProcessIncarnation }>;
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
  const deadline = candidate.autonomousDeadline;
  return (
    deadline !== undefined &&
    typeof deadline.orphanTimeoutMs === 'number' &&
    typeof deadline.adoptionWindowMs === 'number' &&
    typeof deadline.heartbeatHoldBound?.spanMs === 'number' &&
    typeof deadline.heartbeatHoldBound.materialSchedulerLatenessMs === 'number' &&
    candidate.setIdentity !== undefined &&
    candidate.faulted instanceof Promise &&
    typeof candidate.onFault === 'function' &&
    typeof candidate.onIncident === 'function' &&
    typeof candidate.redeemControl === 'function' &&
    typeof candidate.promoteControl === 'function' &&
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
  base: ProviderProxySetAuthority &
    Pick<
      ProviderProxySetRecoveryAuthority,
      'autonomousDeadline' | 'controlReattachment' | 'registerSuccessionOperation'
    >;
  setIdentity: ProviderProxySetIdentity;
  clients: ProviderProxyRoleClients<ControlClient>;
  faults: ProviderProxyAuthorityFaultLatch;
  mutationRpcTimeoutMs: number;
}): DurableProviderProxyOperationAuthority {
  const activationDeps: ProviderProxyOperationActivationDeps = {
    proxyClient: deps.clients.proxy,
    guardianClient: deps.clients.guardian,
    setIdentity: deps.setIdentity,
    mutationRpcTimeoutMs: deps.mutationRpcTimeoutMs,
    faultAuthority: deps.faults.latch,
    reportIncident: deps.faults.reportIncident,
  };
  const authority: DurableProviderProxyOperationAuthority = {
    ...deps.base,
    get autonomousDeadline() {
      return deps.base.autonomousDeadline;
    },
    faulted: deps.faults.faulted,
    onFault: deps.faults.onFault,
    onIncident: deps.faults.onIncident,
    redeemControl: (signal) => deps.base.controlReattachment.redeem(deps.setIdentity, signal),
    promoteControl: async (redemption, signal) => {
      const bundle = providerProxyControlRedemptionBundle(redemption);
      if (!providerProxySetIdentitiesEqual(deps.setIdentity, bundle.setIdentity)) {
        closeRedeemedProviderProxyControl(redemption);
        throw new Error('provider_proxy_control_promotion_identity_mismatch');
      }
      const base = await deps.base.controlReattachment.promote(redemption, signal);
      return createProviderProxyOperationAuthority({
        base,
        setIdentity: bundle.setIdentity,
        clients: bundle.clients,
        faults: bundle.faults,
        mutationRpcTimeoutMs: deps.mutationRpcTimeoutMs,
      });
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
  return authority;
}
