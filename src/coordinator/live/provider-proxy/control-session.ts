import type { HandoffCapsuleV3 } from '../../../provider-proxy/handoff-capsule.js';
import type { ControlClient } from '../../../provider-proxy/control-client.js';
import type { GuardianIdentity, ProxyIdentity, ReaperIdentity } from '../../../provider-proxy/protocol.js';
import type {
  ProviderProxyAuthorityFault,
  ProviderProxyAuthorityFaultLatch,
  ProviderProxyRoleClients,
} from '../../services/provider-proxy-authority-fault.js';
import type { ProviderProxySetIdentity } from '../../services/provider-proxy-set/identity.js';
import type { ProviderProxyRoleHeartbeats } from './heartbeat.js';
import {
  createProviderProxyOperationAuthority,
  type DurableProviderProxyOperationAuthority,
} from './operation-route.js';
import type { ProviderProxySetRecoveryAuthority } from './set-authority.js';
import {
  runProviderProxySetPublicationTransaction,
  type ProviderProxySetPublicationOutcome,
  type ProviderProxySetPublicationUnknown,
  type PublicationReceipt,
} from './set-publication.js';

const ownedProviderProxyControlSessionBrand: unique symbol = Symbol('OwnedProviderProxyControlSession');

export const providerProxyControlSessionOwner = {
  controlEstablishment: 'control-establishment',
  acquisition: 'acquisition',
  providerHostAcquisition: 'provider-host-acquisition',
  providerHostManager: 'provider-host-manager',
  lifecycle: 'provider-proxy-set-lifecycle',
} as const;

export type ProviderProxyControlSessionOwner =
  (typeof providerProxyControlSessionOwner)[keyof typeof providerProxyControlSessionOwner];

export type ProviderProxyControlSessionBundle = Readonly<{
  setIdentity: ProviderProxySetIdentity;
  clients: ProviderProxyRoleClients<ControlClient>;
  heartbeats: ProviderProxyRoleHeartbeats;
  faults: ProviderProxyAuthorityFaultLatch;
  guardianIdentity: GuardianIdentity;
  reaperIdentity: ReaperIdentity;
  proxyIdentity: ProxyIdentity;
}>;

export type ProviderProxyAcquisitionControlSessionBundle = ProviderProxyControlSessionBundle &
  Readonly<{
    base: ProviderProxySetRecoveryAuthority;
    capsulePath: string;
    capsuleBinding: HandoffCapsuleV3;
    mutationRpcTimeoutMs: number;
  }>;

type ProviderProxyControlSessionCell = {
  state: { kind: 'owned'; owner: ProviderProxyControlSessionOwner } | { kind: 'established' } | { kind: 'closed' };
  readonly bundle: ProviderProxyAcquisitionControlSessionBundle;
};

export type OwnedProviderProxyAcquisitionControlSession<Owner extends ProviderProxyControlSessionOwner> = Readonly<{
  kind: 'owned-provider-proxy-acquisition-control-session';
  owner: Owner;
  [ownedProviderProxyControlSessionBrand]: ProviderProxyControlSessionCell;
}>;

export type ProviderProxyAcquisitionSessionEstablished = Readonly<{
  kind: 'established';
  set: DurableProviderProxyOperationAuthority;
  publicationReceipt: PublicationReceipt;
}>;

export type ProviderProxyAcquisitionSessionHandedOver<Owner extends ProviderProxyControlSessionOwner> = Readonly<{
  kind: 'handed-over';
  session: OwnedProviderProxyAcquisitionControlSession<Owner>;
  incident: ProviderProxySetPublicationUnknown;
}>;

export type ProviderProxyAcquisitionSessionClosed = Readonly<{
  kind: 'closed';
  reason: string;
}>;

export type ProviderProxyAcquisitionSessionDisposition<Owner extends ProviderProxyControlSessionOwner> =
  | ProviderProxyAcquisitionSessionEstablished
  | ProviderProxyAcquisitionSessionHandedOver<Owner>
  | ProviderProxyAcquisitionSessionClosed;

export type ProviderProxyAcquisitionSessionDescriptor = Readonly<{
  setIdentity: ProviderProxySetIdentity;
  capsulePath: string;
  capsuleBinding: HandoffCapsuleV3;
}>;

function ownedCell<Owner extends ProviderProxyControlSessionOwner>(
  session: OwnedProviderProxyAcquisitionControlSession<Owner>,
): ProviderProxyControlSessionCell {
  const cell = session[ownedProviderProxyControlSessionBrand];
  if (cell.state.kind !== 'owned' || cell.state.owner !== session.owner) {
    throw new Error('provider_proxy_control_session_not_owned');
  }
  return cell;
}

function ownedSession<Owner extends ProviderProxyControlSessionOwner>(
  owner: Owner,
  cell: ProviderProxyControlSessionCell,
): OwnedProviderProxyAcquisitionControlSession<Owner> {
  return Object.freeze({
    kind: 'owned-provider-proxy-acquisition-control-session',
    owner,
    [ownedProviderProxyControlSessionBrand]: cell,
  });
}

/** The named owner remains responsible until it returns an explicit session disposition. */
export function createOwnedProviderProxyAcquisitionControlSession<Owner extends ProviderProxyControlSessionOwner>(
  owner: Owner,
  bundle: ProviderProxyAcquisitionControlSessionBundle,
): OwnedProviderProxyAcquisitionControlSession<Owner> {
  return ownedSession(owner, { state: { kind: 'owned', owner }, bundle });
}

/** Ownership changes only here so a superseded handle cannot discharge the session. */
export function handOverProviderProxyAcquisitionControlSession<
  Owner extends ProviderProxyControlSessionOwner,
  Successor extends ProviderProxyControlSessionOwner,
>(
  session: OwnedProviderProxyAcquisitionControlSession<Owner>,
  successor: Successor,
  incident: ProviderProxySetPublicationUnknown,
): ProviderProxyAcquisitionSessionHandedOver<Successor> {
  const cell = ownedCell(session);
  cell.state = { kind: 'owned', owner: successor };
  return { kind: 'handed-over', session: ownedSession(successor, cell), incident };
}

/** Reading session metadata requires the caller's handle to name the current owner. */
export function providerProxyAcquisitionSessionDescriptor<Owner extends ProviderProxyControlSessionOwner>(
  session: OwnedProviderProxyAcquisitionControlSession<Owner>,
): ProviderProxyAcquisitionSessionDescriptor {
  const { setIdentity, capsulePath, capsuleBinding } = ownedCell(session).bundle;
  return { setIdentity, capsulePath, capsuleBinding };
}

/** Fault observation remains coupled to the current session owner. */
export function onProviderProxyAcquisitionSessionFault<Owner extends ProviderProxyControlSessionOwner>(
  session: OwnedProviderProxyAcquisitionControlSession<Owner>,
  listener: (fault: ProviderProxyAuthorityFault) => void,
): () => void {
  return ownedCell(session).bundle.faults.onFault(listener);
}

/** Publication retries must reuse the clients that already hold role control. */
export async function retryProviderProxyAcquisitionPublication<Owner extends ProviderProxyControlSessionOwner>(
  session: OwnedProviderProxyAcquisitionControlSession<Owner>,
): Promise<ProviderProxySetPublicationOutcome> {
  const { clients, guardianIdentity, reaperIdentity, proxyIdentity } = ownedCell(session).bundle;
  return runProviderProxySetPublicationTransaction(
    clients.guardian,
    clients.proxy,
    guardianIdentity,
    reaperIdentity,
    proxyIdentity,
  );
}

/** Establishment consumes ownership only after authority construction succeeds. */
export function establishProviderProxyAcquisitionSession<Owner extends ProviderProxyControlSessionOwner>(
  session: OwnedProviderProxyAcquisitionControlSession<Owner>,
  publicationReceipt: PublicationReceipt,
  decorateAuthority: (authority: DurableProviderProxyOperationAuthority) => DurableProviderProxyOperationAuthority = (
    authority,
  ) => authority,
): ProviderProxyAcquisitionSessionEstablished {
  const cell = ownedCell(session);
  const { base, setIdentity, clients, faults, mutationRpcTimeoutMs } = cell.bundle;
  const set = decorateAuthority(
    createProviderProxyOperationAuthority({ base, setIdentity, clients, faults, mutationRpcTimeoutMs }),
  );
  cell.state = { kind: 'established' };
  return { kind: 'established', set, publicationReceipt };
}

/** Closing a session must consume ownership and release every heartbeat and control client. */
export function closeProviderProxyAcquisitionSession<Owner extends ProviderProxyControlSessionOwner>(
  session: OwnedProviderProxyAcquisitionControlSession<Owner>,
  reason: string,
): ProviderProxyAcquisitionSessionClosed {
  const cell = ownedCell(session);
  const { clients, heartbeats } = cell.bundle;
  heartbeats.proxy.stop();
  heartbeats.guardian.stop();
  heartbeats.reaper.stop();
  clients.proxy.close();
  clients.guardian.close();
  clients.reaper.close();
  cell.state = { kind: 'closed' };
  return { kind: 'closed', reason };
}
