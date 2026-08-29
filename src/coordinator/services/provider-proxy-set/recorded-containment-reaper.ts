import type { ProviderProxySetContainmentProof } from './containment-proof.js';
import type { ProviderProxySetIdentity } from './identity.js';

/** Signals the exact recorded containment with one stage of the bounded escalation. */
export type ProviderProxySetContainmentSignal = 'SIGTERM' | 'SIGKILL';

/** The only terminal observations produced by exact recorded-containment reaping. */
export type ProviderProxySetRecordedContainmentReapResult =
  | Readonly<{ kind: 'containment-absent'; disappearanceReceipt: string }>
  | Readonly<{ kind: 'recorded-group-unattributable' }>;

/** Destructive owner port that accepts only an identity-bound opaque containment proof. */
export type ProviderProxySetRecordedContainmentReaper = (
  identity: ProviderProxySetIdentity,
  proof: ProviderProxySetContainmentProof,
  signal: AbortSignal,
  onSignal: (signal: ProviderProxySetContainmentSignal) => void,
  assertSignalAuthorized?: () => void,
) => Promise<ProviderProxySetRecordedContainmentReapResult>;
