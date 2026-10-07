import { sameEpoch } from './identity.js';
import { type Runtime } from '../../runtime/ports.js';
import { type EpochClosureEvidence, observeEpochClosure } from './closure.js';
import { observeProtectedEpochAddresses, protectedEpochRemoved, unrecognizedProtectedEpochs } from './protection.js';
import { dirname, join } from 'node:path';
import { readCustodyLedger, type CustodyEntry } from '../custody-ledger.js';
import { inspectEpochKey } from './key.js';
import { type StoreEpochListEntry } from './types.js';
import { readEpochMetadata } from './metadata.js';
import { unavailableClassification } from './classification.js';
import { epochBytes } from './inventory-bytes.js';
import { STORE_DATABASE_FILE_NAME } from './constants.js';
import {
  resolveObservedStoreRoot,
  type StoreEpochObservation,
  observeStoreEpochs,
  currentProvenEpoch,
  garbageStoreEpochs,
  compareEpoch,
  resolvedStoreEpoch,
  epochDirectory,
} from './observation.js';
import { readPendingProtections, pendingProtectionUnreadable } from './pending-protection.js';

function listProtectedStoreEpochs(
  runtime: Pick<Runtime, 'paths' | 'storage' | 'ids' | 'env'>,
  dbDir: string,
  custodyState: (epochKey: string | null, closure: EpochClosureEvidence | null) => StoreEpochListEntry['custodyState'],
): StoreEpochListEntry[] {
  const protectedAddresses = observeProtectedEpochAddresses(runtime, dbDir);
  const protectedEpochs: StoreEpochListEntry[] = protectedAddresses.map((address) => {
    const epoch = address.epochKey.slice(address.epochKey.lastIndexOf(':') + 1);
    const protectedStoreRoot = dirname(address.protectedPath);
    let addressPresent = false;
    try {
      const observed = runtime.storage.lstatSync(address.protectedPath);
      addressPresent = observed.isDirectory() && !observed.isSymbolicLink();
    } catch {
      // An unobservable address must remain in the inventory.
    }
    const metadata = readEpochMetadata(runtime.storage, address.protectedPath);
    const publicationReason = metadata.kind === 'valid' ? metadata.value.classification : unavailableClassification();
    const read = observeEpochClosure(runtime, runtime.paths.coral.generation.dataRoot, address.epochKey);
    const closure = read.kind === 'recorded' ? read.evidence : null;
    const closureUnreadable = read.kind === 'unreadable' || read.kind === 'unsupported';
    const role: StoreEpochListEntry['role'] = addressPresent
      ? 'protected'
      : closure?.disposition === 'closed' && protectedEpochRemoved(runtime, address)
        ? 'removed'
        : 'unobservable';
    return {
      epoch,
      address: address.protectedPath,
      epochKey: address.epochKey,
      role,
      closureDisposition:
        closure?.disposition ?? (closureUnreadable || role === 'unobservable' ? 'unrecoverable-retained' : 'pending'),
      dataOutcome: closure?.dataOutcome ?? (closureUnreadable || role === 'unobservable' ? 'unreadable' : 'unknown'),
      custodyState:
        closureUnreadable || role === 'unobservable' ? 'undecidable' : custodyState(address.epochKey, closure),
      closureReason:
        closure?.reason ?? (read.kind === 'unsupported' ? `unsupported closure generation ${read.version}` : null),
      bytes: addressPresent ? epochBytes(runtime.storage, protectedStoreRoot, epoch) : null,
      publicationReason,
      supersededStoreVersion:
        'storedProductVersion' in publicationReason ? publicationReason.storedProductVersion : null,
      epochJson: metadata,
      resolved: addressPresent
        ? {
            storeRoot: protectedStoreRoot,
            epoch,
            path: join(address.protectedPath, STORE_DATABASE_FILE_NAME),
            lineageKey: address.epochKey,
            canonicalStoreRoot: dbDir,
          }
        : null,
    };
  });
  const unrecognized: StoreEpochListEntry[] = unrecognizedProtectedEpochs(runtime, dbDir, protectedAddresses).map(
    (entry) => ({
      epoch: entry.epoch,
      address: entry.path,
      epochKey: null,
      role: 'unobservable',
      closureDisposition: 'unrecoverable-retained',
      dataOutcome: 'unreadable',
      custodyState: 'unobserved',
      bytes: null,
      publicationReason: unavailableClassification(),
      supersededStoreVersion: null,
      epochJson: { kind: 'unreadable' },
      resolved: null,
    }),
  );
  return [...protectedEpochs, ...unrecognized];
}

type InventoryRuntime = Pick<Runtime, 'paths' | 'storage' | 'ids' | 'env'>;
type CustodyStateReader = (
  epochKey: string | null,
  closure: EpochClosureEvidence | null,
) => StoreEpochListEntry['custodyState'];

function observeStoreInventory(runtime: InventoryRuntime) {
  const configuredDbDir = runtime.paths.coral.store.dbDir;
  let root: ReturnType<typeof resolveObservedStoreRoot> | null = null;
  let rootUnobservable = false;
  try {
    root = resolveObservedStoreRoot(runtime.storage, configuredDbDir);
  } catch {
    rootUnobservable = true;
  }
  const dbDir = root?.kind === 'present' ? root.path : configuredDbDir;
  let observations: readonly StoreEpochObservation[] = [];
  try {
    if (root?.kind === 'present') observations = observeStoreEpochs(runtime.storage, dbDir);
  } catch {
    rootUnobservable = true;
  }
  return { dbDir, observations, rootUnobservable };
}

function storeEpochCustodyState(
  custody: readonly CustodyEntry[],
  epochKey: string | null,
  closure: EpochClosureEvidence | null,
): StoreEpochListEntry['custodyState'] {
  if (closure?.executionDischarge === 'certified') return 'certified';
  if (closure?.executionDischarge === 'undecidable') return 'undecidable';
  if (custody.some((entry) => entry.kind === 'unreadable')) return 'undecidable';
  if (epochKey === null) return 'unobserved';
  const entries = custody.filter(
    (entry): entry is Exclude<CustodyEntry, { kind: 'unreadable' }> =>
      entry.kind !== 'unreadable' && sameEpoch(entry.intent.epochKey, epochKey),
  );
  if (entries.length === 0) return 'unobserved';
  return entries.every((entry) => entry.kind === 'absent') ? 'absent' : 'holding';
}

function storeEpochClosureEntry(
  runtime: InventoryRuntime,
  epochKey: string | null,
  unresolved: boolean,
  custodyState: CustodyStateReader,
): Pick<StoreEpochListEntry, 'closureDisposition' | 'dataOutcome' | 'custodyState' | 'closureReason'> {
  const read =
    epochKey === null ? null : observeEpochClosure(runtime, runtime.paths.coral.generation.dataRoot, epochKey);
  const closure = read?.kind === 'recorded' ? read.evidence : null;
  const closureUnreadable = read?.kind === 'unreadable' || read?.kind === 'unsupported';
  return {
    closureDisposition:
      closure?.disposition ?? (unresolved || closureUnreadable ? 'unrecoverable-retained' : 'pending'),
    dataOutcome: closure?.dataOutcome ?? (closureUnreadable ? 'unreadable' : 'unknown'),
    custodyState: closureUnreadable ? 'undecidable' : custodyState(epochKey, closure),
    closureReason:
      closure?.reason ?? (read?.kind === 'unsupported' ? `unsupported closure generation ${read.version}` : null),
  };
}

function storeEpochInventoryRole(
  observation: StoreEpochObservation,
  current: string | null,
  garbageEpochs: ReadonlySet<string>,
): StoreEpochListEntry['role'] {
  const { epoch } = observation;
  return observation.proof.kind === 'unobservable'
    ? 'unobservable'
    : observation.proof.kind === 'proven' && epoch === current
      ? 'current'
      : observation.proof.kind === 'proven' && !garbageEpochs.has(epoch)
        ? 'preserved'
        : 'garbage';
}

type StoreEpochInventoryContext = Readonly<{
  runtime: InventoryRuntime;
  dbDir: string;
  current: string | null;
  garbageEpochs: ReadonlySet<string>;
  custodyState: CustodyStateReader;
  pendingRead: ReturnType<typeof readPendingProtections>;
  pendingProtections: ReturnType<typeof readPendingProtections>['records'];
}>;

function storeEpochInventoryEntry(
  { runtime, dbDir, current, garbageEpochs, custodyState, pendingRead, pendingProtections }: StoreEpochInventoryContext,
  observation: StoreEpochObservation,
): StoreEpochListEntry & Readonly<{ address: string }> {
  const { epoch } = observation;
  const protectionPending = pendingProtections.find((pending) => pending.epoch === epoch)?.reason;
  const protectionUnreadable = pendingProtectionUnreadable(runtime, pendingRead, dbDir, epoch);
  const publicationReason =
    observation.epochJson.kind === 'valid' ? observation.epochJson.value.classification : unavailableClassification();
  const resolved = observation.proof.kind === 'proven' ? resolvedStoreEpoch(dbDir, epoch) : null;
  const epochKey = resolved === null ? null : inspectEpochKey(runtime, resolved);
  return {
    epoch,
    address: resolved?.path ?? epochDirectory(dbDir, epoch),
    epochKey,
    ...storeEpochClosureEntry(runtime, epochKey, resolved === null, custodyState),
    ...(protectionPending === undefined ? {} : { protectionPending }),
    ...(protectionUnreadable ? { protectionUnreadable: true } : {}),
    role: storeEpochInventoryRole(observation, current, garbageEpochs),
    bytes: observation.proof.kind === 'proven' ? epochBytes(runtime.storage, dbDir, epoch) : null,
    publicationReason,
    supersededStoreVersion: 'storedProductVersion' in publicationReason ? publicationReason.storedProductVersion : null,
    epochJson: observation.epochJson,
    resolved,
  };
}

function unobservableStoreEpochEntry(): StoreEpochListEntry {
  return {
    epoch: 'unobservable',
    role: 'unobservable',
    bytes: null,
    publicationReason: unavailableClassification(),
    supersededStoreVersion: null,
    epochJson: { kind: 'unreadable' },
    resolved: null,
  };
}

export function listStoreEpochs(runtime: InventoryRuntime): readonly StoreEpochListEntry[] {
  const { dbDir, observations, rootUnobservable } = observeStoreInventory(runtime);
  const current = currentProvenEpoch(observations)?.epoch ?? null;
  const garbageEpochs = garbageStoreEpochs(
    observations.filter(({ proof }) => proof.kind === 'proven').map(({ epoch }) => epoch),
  );
  const custody = readCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir);
  const custodyState: CustodyStateReader = (epochKey, closure) => storeEpochCustodyState(custody, epochKey, closure);
  const pendingRead = readPendingProtections(runtime);
  const pendingProtections = pendingRead.records.filter((pending) => pending.storeRoot === dbDir);
  const context = { runtime, dbDir, current, garbageEpochs, custodyState, pendingRead, pendingProtections };
  const canonical: StoreEpochListEntry[] = [...observations]
    .sort((left, right) => compareEpoch(right.epoch, left.epoch))
    .map((observation) => storeEpochInventoryEntry(context, observation));
  if (rootUnobservable) canonical.unshift(unobservableStoreEpochEntry());
  const unmatchedUnreadableMarkers = pendingRead.unreadableNames.filter(
    (name) => !observations.some(({ epoch }) => name === `${runtime.ids.sha256(epochDirectory(dbDir, epoch))}.json`),
  );
  if (pendingRead.directoryUnreadable || unmatchedUnreadableMarkers.length > 0)
    canonical.push({ ...unobservableStoreEpochEntry(), protectionUnreadable: true });
  return [...canonical, ...listProtectedStoreEpochs(runtime, dbDir, custodyState)];
}
