// Generated from src/store/epoch.ts by scripts/build-server.mjs. Do not edit directly.
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
    (typeof value.supersedes === 'string' && /^(0|[1-9]\d*)$/.test(value.supersedes)) ||
    (Number.isSafeInteger(value.supersedes) && value.supersedes >= 0);
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

function isRegularFile(path) {
  try {
    const entry = lstatSync(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function isPublishedEpoch(dbDir, name) {
  const directory = join(dbDir, name);
  try {
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    const relativePath = relative(realpathSync(dbDir), realpathSync(directory));
    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith('..' + sep) ||
      isAbsolute(relativePath)
    ) {
      return false;
    }
    const metadataPath = join(directory, 'epoch.json');
    if (!isRegularFile(join(directory, 'store.db')) || !isRegularFile(metadataPath)) return false;
    if (statSync(metadataPath, { bigint: true }).size > BigInt(MAX_STORE_EPOCH_METADATA_BYTES)) return false;
    return isValidEpochMetadata(JSON.parse(readFileSync(metadataPath, 'utf8')));
  } catch {
    return false;
  }
}

export function resolveCurrentStoreDbPath(dbDir) {
  let current = isRegularFile(join(dbDir, 'store.db')) ? '0' : null;
  let entries;
  try {
    entries = readdirSync(dbDir);
  } catch {
    return join(dbDir, 'store.db');
  }
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    if (
      epoch !== null &&
      epoch !== '0' &&
      (current === null || BigInt(epoch) > BigInt(current)) &&
      isPublishedEpoch(dbDir, entry)
    ) {
      current = epoch;
    }
  }
  if (current === null) return null;
  return current === '0' ? join(dbDir, 'store.db') : join(dbDir, 'epoch-' + current, 'store.db');
}

function storeEpochForDbPath(dbDir, dbPath) {
  if (resolve(dbPath) === resolve(dbDir, 'store.db')) return '0';
  const directory = dirname(resolve(dbPath));
  return dirname(directory) === resolve(dbDir) ? epochNumber(basename(directory)) : null;
}

function acquireSharedStoreEpochLock(dbDir, epoch) {
  const lock = new DatabaseSync(join(dbDir, '.epoch-lock-' + epoch + '.sqlite'), {
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

export function openLockedReadOnlyStoreDatabase(dbDir, dbPath) {
  const epoch = storeEpochForDbPath(dbDir, dbPath);
  if (epoch === null) throw new Error('Resolved store database is outside the canonical epoch layout.');
  const releaseLock = acquireSharedStoreEpochLock(dbDir, epoch);
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
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
