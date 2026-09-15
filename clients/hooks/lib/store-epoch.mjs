// Generated from src/store/epoch.ts by scripts/build-server.mjs. Do not edit directly.
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const EPOCH_DIRECTORY_PATTERN = /^epoch-([1-9]\d*)$/;
const MAX_STORE_EPOCH_METADATA_BYTES = 65536;
const HOOK_LOCK_TIMEOUT_MS = 1000;

function epochNumber(name) {
  const match = EPOCH_DIRECTORY_PATTERN.exec(name);
  return match?.[1] ?? null;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidEpochMetadata(value) {
  if (!isRecord(value)) return false;
  const validSupersedes =
    value.supersedes === null ||
    (typeof value.supersedes === 'string' && /^[1-9]\d*$/.test(value.supersedes)) ||
    (Number.isSafeInteger(value.supersedes) && value.supersedes >= 1);
  if (!validSupersedes) return false;
  if (!isRecord(value.classification) || typeof value.classification.kind !== 'string') return false;
  if (!isRecord(value.build) || typeof value.build.version !== 'string') return false;
  if (typeof value.publishedAt !== 'string') return false;
  return (
    typeof value.build.buildSetId === 'string' &&
    typeof value.build.bundleHash === 'string' &&
    (value.build.flavor === 'prod' || value.build.flavor === 'dev') &&
    typeof value.build.storeFormatFingerprint === 'string'
  );
}

function isRegularFile(path, device) {
  try {
    const entry = lstatSync(path, { bigint: true });
    return entry.isFile() && entry.nlink === 1n && entry.dev === device;
  } catch {
    return false;
  }
}

function resolveStoreRoot(dbDir) {
  const path = realpathSync(dbDir);
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isDirectory()) throw new Error('Store root is not a directory.');
  return { path, device: entry.dev };
}

function isPublishedEpoch(root, name) {
  const directory = join(root.path, name);
  try {
    const entry = lstatSync(directory, { bigint: true });
    if (!entry.isDirectory() || entry.dev !== root.device) return false;
    const relativePath = relative(root.path, realpathSync(directory));
    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith('..' + sep) ||
      isAbsolute(relativePath)
    ) {
      return false;
    }
    const metadataPath = join(directory, 'epoch.json');
    const databasePath = join(directory, 'store.db');
    const lockPath = join(directory, '.lock');
    if (
      !isRegularFile(databasePath, entry.dev) ||
      !isRegularFile(metadataPath, entry.dev) ||
      !isRegularFile(lockPath, entry.dev)
    ) {
      return false;
    }
    const realDirectory = realpathSync(directory);
    if (dirname(realpathSync(databasePath)) !== realDirectory || dirname(realpathSync(lockPath)) !== realDirectory) {
      return false;
    }
    if (lstatSync(metadataPath, { bigint: true }).size > BigInt(MAX_STORE_EPOCH_METADATA_BYTES)) return false;
    return isValidEpochMetadata(JSON.parse(readFileSync(metadataPath, 'utf8')));
  } catch {
    return false;
  }
}

export function resolveCurrentStoreDbPath(dbDir) {
  let current = null;
  let entries;
  let root;
  try {
    root = resolveStoreRoot(dbDir);
    entries = readdirSync(root.path);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    if (
      epoch !== null &&
      (current === null || BigInt(epoch) > BigInt(current)) &&
      isPublishedEpoch(root, entry)
    ) {
      current = epoch;
    }
  }
  if (current === null) return null;
  return join(root.path, 'epoch-' + current, 'store.db');
}

function storeEpochForDbPath(dbPath) {
  const resolvedPath = resolve(dbPath);
  if (basename(resolvedPath) !== 'store.db') return null;
  const directory = dirname(resolvedPath);
  const epoch = epochNumber(basename(directory));
  return epoch === null ? null : { epoch, storeRoot: dirname(directory), path: resolvedPath };
}

function acquireSharedStoreEpochLock(dbDir, epoch) {
  const lock = new DatabaseSync(join(dbDir, 'epoch-' + epoch, '.lock'), {
    readOnly: true,
    timeout: HOOK_LOCK_TIMEOUT_MS,
  });
  try {
    lock.exec('PRAGMA busy_timeout = ' + HOOK_LOCK_TIMEOUT_MS + '; BEGIN; SELECT count(*) FROM sqlite_schema');
  } catch (error) {
    lock.close();
    throw error;
  }
  return () => {
    try {
      lock.exec('ROLLBACK');
    } finally {
      lock.close();
    }
  };
}

export function openLockedReadOnlyStoreDatabase(dbPath) {
  const resolved = storeEpochForDbPath(dbPath);
  if (resolved === null) {
    throw new Error('Resolved store database is outside the proven canonical epoch layout.');
  }
  const root = resolveStoreRoot(resolved.storeRoot);
  if (!isPublishedEpoch(root, 'epoch-' + resolved.epoch)) {
    throw new Error('Resolved store database is outside the proven canonical epoch layout.');
  }
  const releaseLock = acquireSharedStoreEpochLock(resolved.storeRoot, resolved.epoch);
  let db;
  try {
    db = new DatabaseSync(resolved.path, { readOnly: true });
  } catch (error) {
    releaseLock();
    throw error;
  }
  let closed = false;
  return {
    db,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        releaseLock();
      }
    },
  };
}
