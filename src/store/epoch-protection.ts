import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

import { attemptExclusiveFileLockSync } from '../infra/fs-lock.js';
import { readEpochKey, readOrCreateEpochKey } from './epoch-key.js';
import type { ResolvedStoreEpoch } from './epoch.js';
import type { Runtime } from '../runtime/ports.js';

const addressSchema = z.object({
  version: z.literal('v1'),
  epochKey: z.string().regex(/^[0-9a-f-]{36}:[1-9]\d*$/),
  originalPath: z.string().min(1),
  protectedPath: z.string().min(1),
}).passthrough();

export type ProtectedEpochAddress = z.infer<typeof addressSchema>;

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function protectedStoreEpochRoot(storeRoot: string): string {
  return join(dirname(storeRoot), '.coral-protected-store-epochs.v1', basename(storeRoot));
}

function addressPath(storeRoot: string, epochKey: string): string {
  return join(protectedStoreEpochRoot(storeRoot), 'addresses', `${Buffer.from(epochKey).toString('base64url')}.json`);
}

function writeAddress(address: ProtectedEpochAddress, storeRoot: string): void {
  const path = addressPath(storeRoot, address.epochKey);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  syncDirectory(dirname(dirname(path)));
  const stage = `${path}.stage.${process.pid}.${randomUUID()}`;
  const fd = openSync(stage, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(address)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(stage, path);
  syncDirectory(dirname(path));
}

function observedAddress(storeRoot: string, epochKey: string): ProtectedEpochAddress | null {
  try {
    const address = addressSchema.parse(JSON.parse(readFileSync(addressPath(storeRoot, epochKey), 'utf8')) as unknown);
    return address.epochKey === epochKey ? address : null;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** A protected directory is authoritative before its address record is published. */
export function reconcileProtectedEpochs(storeRoot: string): readonly ProtectedEpochAddress[] {
  const root = protectedStoreEpochRoot(storeRoot);
  if (!existsSync(root)) return [];
  try {
    const observed = lstatSync(root);
    if (!observed.isDirectory() || observed.isSymbolicLink()) return [];
  } catch { return []; }
  const addresses: ProtectedEpochAddress[] = [];
  let lineageIds: string[];
  try { lineageIds = readdirSync(root); } catch { return []; }
  for (const lineageId of lineageIds) {
    if (lineageId === 'addresses') continue;
    const lineageRoot = join(root, lineageId);
    let names: string[];
    try {
      const observed = lstatSync(lineageRoot);
      if (!observed.isDirectory() || observed.isSymbolicLink()) continue;
      names = readdirSync(lineageRoot);
    } catch { continue; }
    for (const name of names) {
      if (name.startsWith('.reaping-')) continue;
      const match = /^epoch-([1-9]\d*)$/.exec(name);
      if (match === null) continue;
      const epoch = match[1]!;
      const protectedPath = join(lineageRoot, name);
      try {
        const observed = lstatSync(protectedPath);
        if (!observed.isDirectory() || observed.isSymbolicLink()) continue;
      } catch { continue; }
      const epochKey = readEpochKey({ storeRoot: lineageRoot, epoch, path: join(protectedPath, 'store.db') });
      if (epochKey === null) continue;
      if (epochKey !== `${lineageId}:${epoch}`) continue;
      const address = addressSchema.parse({
        version: 'v1', epochKey, originalPath: join(storeRoot, name), protectedPath,
      });
      let published: ProtectedEpochAddress | null;
      try { published = observedAddress(storeRoot, epochKey); } catch { continue; }
      if (published !== null &&
          (published.originalPath !== address.originalPath || published.protectedPath !== protectedPath)) {
        continue;
      }
      if (published === null) writeAddress(address, storeRoot);
      addresses.push(address);
    }
  }
  return addresses;
}

export function unrecognizedProtectedEpochs(
  storeRoot: string,
  recognized: readonly ProtectedEpochAddress[],
): readonly { epoch: string; path: string }[] {
  const root = protectedStoreEpochRoot(storeRoot);
  if (!existsSync(root)) return [];
  try {
    const observed = lstatSync(root);
    if (!observed.isDirectory() || observed.isSymbolicLink()) return [{ epoch: 'unobservable', path: root }];
  } catch { return [{ epoch: 'unobservable', path: root }]; }
  const known = new Set(recognized.map((address) => address.protectedPath));
  const unknown: { epoch: string; path: string }[] = [];
  let lineageIds: string[];
  try { lineageIds = readdirSync(root); } catch { return [{ epoch: 'unobservable', path: root }]; }
  for (const lineageId of lineageIds) {
    if (lineageId === 'addresses') continue;
    const lineageRoot = join(root, lineageId);
    let names: string[];
    try {
      const observed = lstatSync(lineageRoot);
      if (!observed.isDirectory() || observed.isSymbolicLink()) throw new Error('Protected lineage is not a directory.');
      names = readdirSync(lineageRoot);
    } catch {
      unknown.push({ epoch: 'unobservable', path: lineageRoot });
      continue;
    }
    for (const name of names) {
      const match = /^epoch-([1-9]\d*)$/.exec(name);
      if (match !== null && !known.has(join(lineageRoot, name))) {
        unknown.push({ epoch: match[1]!, path: join(lineageRoot, name) });
      } else if (name.startsWith('.reaping-')) {
        unknown.push({ epoch: 'unobservable', path: join(lineageRoot, name) });
      }
    }
  }
  return unknown;
}

export function knownProtectedEpochAddresses(storeRoot: string): readonly ProtectedEpochAddress[] {
  reconcileProtectedEpochs(storeRoot);
  const directory = join(protectedStoreEpochRoot(storeRoot), 'addresses');
  let names: string[];
  try { names = readdirSync(directory); } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => name.endsWith('.json')).map((name) => {
    const encodedKey = name.slice(0, -'.json'.length);
    const epochKey = Buffer.from(encodedKey, 'base64url').toString('utf8');
    if (Buffer.from(epochKey).toString('base64url') !== encodedKey) {
      throw new Error('Protected epoch address filename is invalid.');
    }
    const address = observedAddress(storeRoot, epochKey);
    const epoch = epochKey.slice(epochKey.lastIndexOf(':') + 1);
    const lineage = epochKey.slice(0, epochKey.lastIndexOf(':'));
    if (address === null || address.originalPath !== join(storeRoot, `epoch-${epoch}`) ||
        address.protectedPath !== join(protectedStoreEpochRoot(storeRoot), lineage, `epoch-${epoch}`)) {
      throw new Error('Protected epoch address does not match its lineage key.');
    }
    return address;
  });
}

export function resolveProtectedEpoch(storeRoot: string, epochKey: string): ResolvedStoreEpoch | null {
  const address = observedAddress(storeRoot, epochKey) ??
    reconcileProtectedEpochs(storeRoot).find((entry) => entry.epochKey === epochKey) ?? null;
  if (address === null) return null;
  const epoch = epochKey.slice(epochKey.lastIndexOf(':') + 1);
  const lineage = epochKey.slice(0, epochKey.lastIndexOf(':'));
  if (address.originalPath !== join(storeRoot, `epoch-${epoch}`) ||
      address.protectedPath !== join(protectedStoreEpochRoot(storeRoot), lineage, `epoch-${epoch}`)) {
    throw new Error('Protected epoch address does not match its lineage key.');
  }
  return {
    storeRoot: dirname(address.protectedPath), epoch, path: join(address.protectedPath, 'store.db'),
    lineageKey: epochKey, canonicalStoreRoot: storeRoot,
  };
}

export function removeClosedProtectedEpoch(
  runtime: Runtime,
  address: ProtectedEpochAddress,
): 'removed' | 'locked' | 'failed' {
  const lineageRoot = dirname(address.protectedPath);
  const epoch = address.epochKey.slice(address.epochKey.lastIndexOf(':') + 1);
  const tombstone = join(lineageRoot, `.reaping-epoch-${epoch}`);
  if (!existsSync(address.protectedPath) && !existsSync(tombstone)) return 'removed';
  if (existsSync(address.protectedPath) && existsSync(tombstone)) return 'failed';
  let release: (() => void) | null = null;
  if (existsSync(address.protectedPath)) {
    const attempt = attemptExclusiveFileLockSync(join(address.protectedPath, '.lock'));
    if (attempt.kind === 'contended') return 'locked';
    if (attempt.kind !== 'acquired') return 'failed';
    release = attempt.lease;
  }
  try {
    if (existsSync(address.protectedPath)) {
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

export function protectedDeletionResidues(storeRoot: string): readonly ProtectedEpochAddress[] {
  const root = protectedStoreEpochRoot(storeRoot);
  if (!existsSync(root)) return [];
  const addresses: ProtectedEpochAddress[] = [];
  let lineages: string[];
  try { lineages = readdirSync(root); } catch { return []; }
  for (const lineage of lineages) {
    if (lineage === 'addresses') continue;
    let names: string[];
    try { names = readdirSync(join(root, lineage)); } catch { continue; }
    for (const name of names) {
      const match = /^\.reaping-epoch-([1-9]\d*)$/.exec(name);
      if (match === null) continue;
      const epochKey = `${lineage}:${match[1]}`;
      const address = observedAddress(storeRoot, epochKey);
      if (address !== null && address.protectedPath === join(root, lineage, `epoch-${match[1]}`)) {
        addresses.push(address);
      }
    }
  }
  return addresses;
}

/** A live opener must keep its legacy address until it closes. */
export function protectStoreEpoch(epoch: ResolvedStoreEpoch): ProtectedEpochAddress {
  reconcileProtectedEpochs(epoch.storeRoot);
  const epochKey = readOrCreateEpochKey(epoch);
  const originalPath = dirname(epoch.path);
  const lineageId = epochKey.slice(0, epochKey.lastIndexOf(':'));
  const lineageRoot = join(protectedStoreEpochRoot(epoch.storeRoot), lineageId);
  const protectedPath = join(lineageRoot, `epoch-${epoch.epoch}`);
  const address = addressSchema.parse({
    version: 'v1', epochKey, originalPath, protectedPath,
  });
  const lease = attemptExclusiveFileLockSync(join(originalPath, '.lock'));
  if (lease.kind !== 'acquired') throw new Error(`Epoch ${epochKey} cannot be protected while its opener is ${lease.kind}.`);
  try {
    mkdirSync(lineageRoot, { recursive: true, mode: 0o700 });
    syncDirectory(dirname(dirname(protectedStoreEpochRoot(epoch.storeRoot))));
    syncDirectory(dirname(protectedStoreEpochRoot(epoch.storeRoot)));
    syncDirectory(dirname(lineageRoot));
    if (existsSync(protectedPath)) throw new Error(`Epoch ${epochKey} already has a protected address.`);
    renameSync(originalPath, protectedPath);
    syncDirectory(epoch.storeRoot);
    syncDirectory(lineageRoot);
    writeAddress(address, epoch.storeRoot);
    return address;
  } finally {
    lease.lease();
  }
}
