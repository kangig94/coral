import type {
  OwnedProviderProxyAcquisitionControlSession,
  ProviderProxyAcquisitionSessionDisposition,
} from '../../src/coordinator/live/provider-proxy/control-session.js';

declare const session: OwnedProviderProxyAcquisitionControlSession<'provider-proxy-set-lifecycle'>;

function boundaryThatDropsItsSessionOwner(): ProviderProxyAcquisitionSessionDisposition<'provider-proxy-set-lifecycle'> {
  // @ts-expect-error a live session must be established, handed over, or closed at the boundary.
  return session;
}

void boundaryThatDropsItsSessionOwner;
