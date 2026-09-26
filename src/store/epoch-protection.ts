import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

import { attemptExclusiveFileLockSync } from '../infra/fs-lock.js';
import { readEpochKey, readOrCreateEpochKey } from './epoch-key.js';
import { observeStorePath } from './path-observation.js';
import type { ResolvedStoreEpoch } from './epoch.js';
import type { Runtime } from '../runtime/ports.js';

const PROTECTED_EPOCH_KEY_PATTERN = /^[0-9a-f-]{36}:[1-9]\d*$/;
const addressSchema = z
  .object({
    version: z.literal('v1'),
    epochKey: z.string().regex(PROTECTED_EPOCH_KEY_PATTERN),
    originalPath: z.string().min(1),
    protectedPath: z.string().min(1),
  })
  .passthrough();

export type ProtectedEpochAddress = z.infer<typeof addressSchema>;
type StorePathRuntime = Pick<Runtime, 'storage' | 'ids' | 'env'>;

function syncDirectory(runtime: Pick<Runtime, 'storage'>, path: string): void {
  if (!runtime.storage.syncDirectoryDurableSync(path)) throw new Error('Protected epoch directory sync failed.');
}

export function protectedStoreEpochRoot(storeRoot: string): string {
  return join(dirname(storeRoot), '.coral-protected-store-epochs.v1', basename(storeRoot));
}

function addressPath(storeRoot: string, epochKey: string): string {
  return join(protectedStoreEpochRoot(storeRoot), 'addresses', `${Buffer.from(epochKey).toString('base64url')}.json`);
}

function writeAddress(runtime: StorePathRuntime, address: ProtectedEpochAddress, storeRoot: string): void {
  const path = addressPath(storeRoot, address.epochKey);
  runtime.storage.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  syncDirectory(runtime, dirname(dirname(path)));
  const stage = `${path}.stage.${runtime.env.pid()}.${runtime.ids.uuid()}`;
  const fd = runtime.storage.openSync(stage, 'wx', 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(address)}\n`);
    runtime.storage.writeSync(fd, bytes, 0, bytes.length, null);
    runtime.storage.fdatasyncSync(fd);
  } finally {
    runtime.storage.closeSync(fd);
  }
  runtime.storage.renameSync(stage, path);
  syncDirectory(runtime, dirname(path));
}

function observedAddress(
  runtime: Pick<Runtime, 'storage'>,
  storeRoot: string,
  epochKey: string,
): ProtectedEpochAddress | null {
  try {
    const address = addressSchema.parse(
      JSON.parse(runtime.storage.readFileSync(addressPath(storeRoot, epochKey), 'utf-8')) as unknown,
    );
    return address.epochKey === epochKey ? address : null;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** A protected directory is authoritative before its address record is published. */
export function reconcileProtectedEpochs(
  runtime: StorePathRuntime,
  storeRoot: string,
): readonly ProtectedEpochAddress[] {
  const root = protectedStoreEpochRoot(storeRoot);
  if (observeStorePath(runtime.storage, root) === 'absent') return [];
  try {
    const observed = runtime.storage.lstatSync(root);
    if (!observed.isDirectory() || observed.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  const addresses: ProtectedEpochAddress[] = [];
  let lineageIds: string[];
  try {
    lineageIds = runtime.storage.readdirSync(root);
  } catch {
    return [];
  }
  for (const lineageId of lineageIds) {
    if (lineageId === 'addresses') continue;
    const lineageRoot = join(root, lineageId);
    let names: string[];
    try {
      const observed = runtime.storage.lstatSync(lineageRoot);
      if (!observed.isDirectory() || observed.isSymbolicLink()) continue;
      names = runtime.storage.readdirSync(lineageRoot);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.reaping-')) continue;
      const match = /^epoch-([1-9]\d*)$/.exec(name);
      if (match === null) continue;
      const epoch = match[1];
      const protectedPath = join(lineageRoot, name);
      try {
        const observed = runtime.storage.lstatSync(protectedPath);
        if (!observed.isDirectory() || observed.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      const epochKey = readEpochKey(runtime, { storeRoot: lineageRoot, epoch, path: join(protectedPath, 'store.db') });
      if (epochKey === null) continue;
      if (epochKey !== `${lineageId}:${epoch}`) continue;
      const address = addressSchema.parse({
        version: 'v1',
        epochKey,
        originalPath: join(storeRoot, name),
        protectedPath,
      });
      let published: ProtectedEpochAddress | null;
      try {
        published = observedAddress(runtime, storeRoot, epochKey);
      } catch {
        continue;
      }
      if (
        published !== null &&
        (published.originalPath !== address.originalPath || published.protectedPath !== protectedPath)
      ) {
        continue;
      }
      if (published === null) writeAddress(runtime, address, storeRoot);
      addresses.push(address);
    }
  }
  return addresses;
}

export function unrecognizedProtectedEpochs(
  runtime: Pick<Runtime, 'storage'>,
  storeRoot: string,
  recognized: readonly ProtectedEpochAddress[],
): readonly { epoch: string; path: string }[] {
  const root = protectedStoreEpochRoot(storeRoot);
  try {
    if (observeStorePath(runtime.storage, root) === 'absent') return [];
    const observed = runtime.storage.lstatSync(root);
    if (!observed.isDirectory() || observed.isSymbolicLink()) return [{ epoch: 'unobservable', path: root }];
  } catch {
    return [{ epoch: 'unobservable', path: root }];
  }
  const known = new Set(recognized.map((address) => address.protectedPath));
  const unknown: { epoch: string; path: string }[] = [];
  let lineageIds: string[];
  try {
    lineageIds = runtime.storage.readdirSync(root);
  } catch {
    return [{ epoch: 'unobservable', path: root }];
  }
  for (const lineageId of lineageIds) {
    if (lineageId === 'addresses') continue;
    const lineageRoot = join(root, lineageId);
    let names: string[];
    try {
      const observed = runtime.storage.lstatSync(lineageRoot);
      if (!observed.isDirectory() || observed.isSymbolicLink())
        throw new Error('Protected lineage is not a directory.');
      names = runtime.storage.readdirSync(lineageRoot);
    } catch {
      unknown.push({ epoch: 'unobservable', path: lineageRoot });
      continue;
    }
    for (const name of names) {
      const match = /^epoch-([1-9]\d*)$/.exec(name);
      if (match !== null && !known.has(join(lineageRoot, name))) {
        unknown.push({ epoch: match[1], path: join(lineageRoot, name) });
      } else if (name.startsWith('.reaping-')) {
        unknown.push({ epoch: 'unobservable', path: join(lineageRoot, name) });
      }
    }
  }
  return unknown;
}

export function knownProtectedEpochAddresses(
  runtime: StorePathRuntime,
  storeRoot: string,
): readonly ProtectedEpochAddress[] {
  reconcileProtectedEpochs(runtime, storeRoot);
  const directory = join(protectedStoreEpochRoot(storeRoot), 'addresses');
  let names: string[];
  try {
    names = runtime.storage.readdirSync(directory);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const encodedKey = name.slice(0, -'.json'.length);
      const epochKey = Buffer.from(encodedKey, 'base64url').toString('utf8');
      if (Buffer.from(epochKey).toString('base64url') !== encodedKey) {
        throw new Error('Protected epoch address filename is invalid.');
      }
      const address = observedAddress(runtime, storeRoot, epochKey);
      const epoch = epochKey.slice(epochKey.lastIndexOf(':') + 1);
      const lineage = epochKey.slice(0, epochKey.lastIndexOf(':'));
      if (
        address === null ||
        address.originalPath !== join(storeRoot, `epoch-${epoch}`) ||
        address.protectedPath !== join(protectedStoreEpochRoot(storeRoot), lineage, `epoch-${epoch}`)
      ) {
        throw new Error('Protected epoch address does not match its lineage key.');
      }
      return address;
    });
}

function resolvedProtectedAddress(
  storeRoot: string,
  epochKey: string,
  address: ProtectedEpochAddress,
): ResolvedStoreEpoch {
  const epoch = epochKey.slice(epochKey.lastIndexOf(':') + 1);
  const lineage = epochKey.slice(0, epochKey.lastIndexOf(':'));
  if (
    address.originalPath !== join(storeRoot, `epoch-${epoch}`) ||
    address.protectedPath !== join(protectedStoreEpochRoot(storeRoot), lineage, `epoch-${epoch}`)
  ) {
    throw new Error('Protected epoch address does not match its lineage key.');
  }
  return {
    storeRoot: dirname(address.protectedPath),
    epoch,
    path: join(address.protectedPath, 'store.db'),
    lineageKey: epochKey,
    canonicalStoreRoot: storeRoot,
  };
}

/** Pre-bind selection may not publish a missing address while deciding whether to delegate. */
export function observeProtectedEpoch(
  runtime: Pick<Runtime, 'storage'>,
  storeRoot: string,
  epochKey: string,
): ResolvedStoreEpoch | null {
  const published = observedAddress(runtime, storeRoot, epochKey);
  if (published !== null) return resolvedProtectedAddress(storeRoot, epochKey, published);
  if (!PROTECTED_EPOCH_KEY_PATTERN.test(epochKey)) return null;
  const separator = epochKey.lastIndexOf(':');
  if (separator < 0) return null;
  const lineage = epochKey.slice(0, separator);
  const epoch = epochKey.slice(separator + 1);
  const protectedRoot = protectedStoreEpochRoot(storeRoot);
  const protectedPath = join(protectedRoot, lineage, `epoch-${epoch}`);
  try {
    for (const directory of [protectedRoot, dirname(protectedPath), protectedPath]) {
      const entry = runtime.storage.lstatSync(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    }
    if (
      readEpochKey(runtime, { storeRoot: dirname(protectedPath), epoch, path: join(protectedPath, 'store.db') }) !==
      epochKey
    )
      return null;
  } catch {
    return null;
  }
  const address = addressSchema.parse({
    version: 'v1',
    epochKey,
    originalPath: join(storeRoot, `epoch-${epoch}`),
    protectedPath,
  });
  return resolvedProtectedAddress(storeRoot, epochKey, address);
}

export function resolveProtectedEpoch(
  runtime: StorePathRuntime,
  storeRoot: string,
  epochKey: string,
): ResolvedStoreEpoch | null {
  const published = observedAddress(runtime, storeRoot, epochKey);
  if (published !== null) return resolvedProtectedAddress(storeRoot, epochKey, published);
  const address = reconcileProtectedEpochs(runtime, storeRoot).find((entry) => entry.epochKey === epochKey);
  return address === undefined ? null : resolvedProtectedAddress(storeRoot, epochKey, address);
}

function deletionTombstone(address: ProtectedEpochAddress): string {
  const epoch = address.epochKey.slice(address.epochKey.lastIndexOf(':') + 1);
  return join(dirname(address.protectedPath), `.reaping-epoch-${epoch}`);
}

/** Removed means both the directory and its deletion tombstone are observed absent; unobservable is not removed. */
export function protectedEpochRemoved(runtime: Pick<Runtime, 'storage'>, address: ProtectedEpochAddress): boolean {
  try {
    return (
      observeStorePath(runtime.storage, address.protectedPath) === 'absent' &&
      observeStorePath(runtime.storage, deletionTombstone(address)) === 'absent'
    );
  } catch {
    return false;
  }
}

export function removeClosedProtectedEpoch(
  runtime: Runtime,
  address: ProtectedEpochAddress,
): 'removed' | 'locked' | 'failed' {
  const lineageRoot = dirname(address.protectedPath);
  const tombstone = deletionTombstone(address);
  const protectedPresent = observeStorePath(runtime.storage, address.protectedPath) === 'present';
  const tombstonePresent = observeStorePath(runtime.storage, tombstone) === 'present';
  if (!protectedPresent && !tombstonePresent) return 'removed';
  if (protectedPresent && tombstonePresent) return 'failed';
  let release: (() => void) | null = null;
  if (protectedPresent) {
    const attempt = attemptExclusiveFileLockSync(join(address.protectedPath, '.lock'));
    if (attempt.kind === 'contended') return 'locked';
    if (attempt.kind !== 'acquired') return 'failed';
    release = attempt.lease;
  }
  try {
    if (observeStorePath(runtime.storage, address.protectedPath) === 'present') {
      runtime.storage.renameSync(address.protectedPath, tombstone);
      if (!runtime.storage.syncDirectoryDurableSync(lineageRoot)) return 'failed';
    }
    runtime.storage.rmSync(tombstone, { recursive: true, force: true });
    return runtime.storage.syncDirectoryDurableSync(lineageRoot) ? 'removed' : 'failed';
  } catch {
    return 'failed';
  } finally {
    release?.();
  }
}

export function protectedDeletionResidues(
  runtime: Pick<Runtime, 'storage'>,
  storeRoot: string,
): readonly ProtectedEpochAddress[] {
  const root = protectedStoreEpochRoot(storeRoot);
  if (observeStorePath(runtime.storage, root) === 'absent') return [];
  const addresses: ProtectedEpochAddress[] = [];
  let lineages: string[];
  try {
    lineages = runtime.storage.readdirSync(root);
  } catch {
    return [];
  }
  for (const lineage of lineages) {
    if (lineage === 'addresses') continue;
    let names: string[];
    try {
      names = runtime.storage.readdirSync(join(root, lineage));
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^\.reaping-epoch-([1-9]\d*)$/.exec(name);
      if (match === null) continue;
      const epochKey = `${lineage}:${match[1]}`;
      const address = observedAddress(runtime, storeRoot, epochKey);
      if (address !== null && address.protectedPath === join(root, lineage, `epoch-${match[1]}`)) {
        addresses.push(address);
      }
    }
  }
  return addresses;
}

/** An opener still held the epoch after the protector's drain: a later protection may find it released. */
export class StoreEpochOpenerHeldError extends Error {
  constructor(epochKey: string) {
    super(`Epoch ${epochKey} cannot be protected while its opener is contended.`);
    this.name = 'StoreEpochOpenerHeldError';
  }
}

/**
 * A live opener must keep its legacy address until it closes. `openerDrainMs` bounds how long protection waits
 * for openers already holding the epoch; no new opener is admitted while it waits.
 */
export function protectStoreEpoch(
  runtime: StorePathRuntime,
  epoch: ResolvedStoreEpoch,
  openerDrainMs = 0,
): ProtectedEpochAddress {
  reconcileProtectedEpochs(runtime, epoch.storeRoot);
  const epochKey = readOrCreateEpochKey(runtime, epoch);
  const originalPath = dirname(epoch.path);
  const lineageId = epochKey.slice(0, epochKey.lastIndexOf(':'));
  const lineageRoot = join(protectedStoreEpochRoot(epoch.storeRoot), lineageId);
  const protectedPath = join(lineageRoot, `epoch-${epoch.epoch}`);
  const address = addressSchema.parse({
    version: 'v1',
    epochKey,
    originalPath,
    protectedPath,
  });
  const lease = attemptExclusiveFileLockSync(join(originalPath, '.lock'), openerDrainMs);
  if (lease.kind === 'contended') throw new StoreEpochOpenerHeldError(epochKey);
  if (lease.kind !== 'acquired')
    throw new Error(`Epoch ${epochKey} cannot be protected while its opener is ${lease.kind}.`);
  try {
    runtime.storage.mkdirSync(lineageRoot, { recursive: true, mode: 0o700 });
    syncDirectory(runtime, dirname(dirname(protectedStoreEpochRoot(epoch.storeRoot))));
    syncDirectory(runtime, dirname(protectedStoreEpochRoot(epoch.storeRoot)));
    syncDirectory(runtime, dirname(lineageRoot));
    if (observeStorePath(runtime.storage, protectedPath) === 'present')
      throw new Error(`Epoch ${epochKey} already has a protected address.`);
    runtime.storage.renameSync(originalPath, protectedPath);
    syncDirectory(runtime, epoch.storeRoot);
    syncDirectory(runtime, lineageRoot);
    writeAddress(runtime, address, epoch.storeRoot);
    return address;
  } finally {
    lease.lease();
  }
}

export function restoreProtectedEpoch(runtime: Pick<Runtime, 'storage'>, storeRoot: string, epochKey: string): void {
  const address = observedAddress(runtime, storeRoot, epochKey);
  if (
    address === null ||
    observeStorePath(runtime.storage, address.protectedPath) === 'absent' ||
    observeStorePath(runtime.storage, address.originalPath) === 'present'
  ) {
    throw new Error('Retiring epoch cannot return to its canonical address.');
  }
  const lock = attemptExclusiveFileLockSync(join(address.protectedPath, '.lock'));
  if (lock.kind !== 'acquired') throw new Error(`Retiring epoch restoration is ${lock.kind}.`);
  try {
    runtime.storage.unlinkSync(addressPath(storeRoot, epochKey));
    syncDirectory(runtime, join(protectedStoreEpochRoot(storeRoot), 'addresses'));
    runtime.storage.renameSync(address.protectedPath, address.originalPath);
    syncDirectory(runtime, dirname(address.protectedPath));
    syncDirectory(runtime, storeRoot);
  } finally {
    lock.lease();
  }
}
