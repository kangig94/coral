import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const EPOCH_DIRECTORY_PATTERN = /^epoch-(0|[1-9]\d*)$/;

function epochNumber(name) {
  const match = EPOCH_DIRECTORY_PATTERN.exec(name);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER ? value : null;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidEpochMetadata(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.supersedes) || value.supersedes < 0) return false;
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
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return false;
    }
    if (!isRegularFile(join(directory, 'store.db')) || !isRegularFile(join(directory, 'epoch.json'))) return false;
    return isValidEpochMetadata(JSON.parse(readFileSync(join(directory, 'epoch.json'), 'utf8')));
  } catch {
    return false;
  }
}

export function resolveCurrentStoreDbPath(dbDir) {
  let current = 0;
  let entries;
  try {
    entries = readdirSync(dbDir);
  } catch {
    return join(dbDir, 'store.db');
  }
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    if (epoch !== null && epoch > current && isPublishedEpoch(dbDir, entry)) current = epoch;
  }
  return current === 0 ? join(dbDir, 'store.db') : join(dbDir, `epoch-${current}`, 'store.db');
}
