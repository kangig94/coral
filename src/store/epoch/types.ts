import { type StoreFormatClassification, type StoreFormatDescription } from '../format-fingerprint.js';
import { type StrictBundleManifest } from '../../infra/bundle-manifest.js';
import { type Database } from '../db.js';
import { type ProtectedEpochAddress } from './protection.js';
import { type StoreMintDisposition } from './mint-disposition.js';

export type StoreEpochFailureCause = Readonly<{
  attempts?: number;
  code?: string;
  errcode?: number;
  message: string;
}>;

export type StoreEpochOpenFailureStage = 'lock' | 'openable-probe' | 'writable-open' | 'holder-registration';

export type StoreEpochUnprovenCandidate = Readonly<{
  epoch: StoreEpoch;
  address?: string;
  proof: Readonly<{ kind: 'disproven'; cause?: string }> | Readonly<{ kind: 'unobservable'; cause: string }>;
}>;

export type StoreEpochClassification = (
  | Exclude<StoreFormatClassification, { readonly kind: 'absent' }>
  | {
      readonly kind: 'absent';
      readonly attempts?: number;
      readonly candidateCount?: number;
      readonly candidates?: readonly StoreEpochUnprovenCandidate[];
    }
  | {
      readonly kind: 'unavailable';
      readonly stage?: StoreEpochOpenFailureStage;
      readonly cause?: StoreEpochFailureCause;
    }
  | { readonly kind: 'operator-discard' }
) & { readonly releaseFailure?: StoreEpochFailureCause };

export type StoreEpochMetadata = Readonly<{
  supersedes: StoreEpoch | null;
  classification: StoreEpochClassification;
  build: Readonly<{
    version: string;
    buildSetId: string;
    bundleHash: string;
    flavor: StrictBundleManifest['flavor'];
    storeFormatFingerprint: string;
  }>;
  publishedAt: string;
}>;

export type StoreEpochSettlement = Readonly<{
  db: Database;
  store: ResolvedStoreEpoch;
}>;

export type ExactStoreEpochOpen =
  | (Readonly<{ kind: 'opened' }> & StoreEpochSettlement)
  | Readonly<{ kind: 'holding'; reason: 'epoch-unproven' | 'open-failed'; classification?: StoreEpochClassification }>;

export type StoreEpochListEntry = Readonly<{
  epoch: StoreEpoch;
  role: 'current' | 'preserved' | 'garbage' | 'protected' | 'removed' | 'unobservable';
  epochKey?: string | null;
  closureDisposition?: 'closed' | 'unrecoverable-retained' | 'pending';
  dataOutcome?: 'retained' | 'unreadable' | 'unknown';
  custodyState?: 'certified' | 'undecidable' | 'holding' | 'absent' | 'unobserved';
  closureReason?: string | null;
  protectionPending?: string;
  protectionUnreadable?: boolean;
  bytes: number | null;
  publicationReason: StoreEpochClassification;
  supersededStoreVersion: string | null;
  epochJson: StoreEpochMetadataDisposition;
  resolved: ResolvedStoreEpoch | null;
}>;

export type StoreEpochHolderListEntry = Readonly<{
  id: string;
  epoch: StoreEpoch | null;
  pid: number | null;
  state: 'live' | 'stale' | 'unobservable';
}>;

export type StoreEpochResidueListEntry = Readonly<{
  name: string;
  bytes: number | null;
  state: 'live' | 'reclaimable' | 'retained' | 'unobservable';
}>;

export type StoreEpochSweepResult =
  | 'absent'
  | 'cancelled'
  | 'complete'
  | 'current'
  | 'unobservable-metadata'
  | 'live-holder'
  | 'unobservable-holder'
  | 'holder-cleanup-failed'
  | 'deletion-failed'
  | 'closure-required'
  | 'lock-release-failed'
  | 'pre-deletion-durability-sync-failed'
  | 'absent-durability-sync-failed'
  | 'durability-sync-failed';

export type StoreEpochMetadataDisposition =
  | Readonly<{ kind: 'valid'; value: StoreEpochMetadata }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'malformed' }>
  | Readonly<{ kind: 'unreadable' }>;

export type StoreEpochOptions = Readonly<{
  path?: string;
  storeFormat: StoreFormatDescription;
  build: StrictBundleManifest;
  startupBusyTimeoutMs?: number;
  steadyStateBusyTimeoutMs?: number;
  deferProductVersionRaise?: boolean;
  authorizeMint?: (observation: StoreMintObservation) => StoreMintDisposition | null;
  selectProtectedPredecessor?: (addresses: readonly ProtectedEpochAddress[]) => string | null;
}>;

export type StoreMintObservation = Readonly<{
  incumbent: ResolvedStoreEpoch | null;
  incumbentEpochKey: string | null;
  classification: StoreEpochClassification;
  observedEpochCount: number;
}>;

export type StoreEpoch = string;

export type ResolvedStoreEpoch = Readonly<{
  storeRoot: string;
  epoch: StoreEpoch;
  path: string;
  lineageKey?: string;
  canonicalStoreRoot?: string;
}>;

export type ResolvedStorePath = Readonly<{
  path: string;
  epoch: ResolvedStoreEpoch | null;
  epochCandidate: boolean;
}>;

export type CurrentStoreInspection =
  | Readonly<{ kind: 'current'; epoch: ResolvedStoreEpoch }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unobservable' }>;

export type StoreEpochProof =
  | Readonly<{ kind: 'proven' }>
  | Readonly<{ kind: 'disproven' }>
  | Readonly<{ kind: 'unobservable'; cause: string }>;
