import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const MAX_GITIGNORE_BYTES = 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
export const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW;
export const TEMP_WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);
export const ARTIFACT_ACCESS_CODES = new Set(['EACCES', 'EPERM']);
export const ARTIFACT_STRUCTURAL_CODES = new Set(['EISDIR', 'ELOOP', 'ENOTDIR']);

export function isMissing(error) {
  return error?.code === 'ENOENT';
}

export function safeUnlink(path) {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

function classifySnapshotError(error, phase) {
  if (phase === 'descriptor') {
    return { kind: 'observation-failed', reason: 'artifact-observation-failed' };
  }
  if (isMissing(error)) return { kind: 'missing' };
  return ARTIFACT_ACCESS_CODES.has(error?.code) || ARTIFACT_STRUCTURAL_CODES.has(error?.code)
    ? { kind: 'structural', reason: 'artifact-unreadable' }
    : { kind: 'observation-failed', reason: 'artifact-observation-failed' };
}

export function readRegularSnapshot(path) {
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      return { ok: false, kind: 'structural', reason: 'artifact-unreadable' };
    }
    if (pathStat.size > MAX_GITIGNORE_BYTES) {
      return { ok: false, kind: 'structural', reason: 'artifact-too-large' };
    }
  } catch (error) {
    const failure = classifySnapshotError(error, 'pathname');
    if (failure.kind === 'missing') {
      return { ok: true, kind: 'missing', exists: false, content: Buffer.alloc(0), mode: 0o666 };
    }
    return { ok: false, ...failure };
  }

  let fd;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch (error) {
    const failure = classifySnapshotError(error, 'pathname');
    if (failure.kind === 'missing') {
      return { ok: true, kind: 'missing', exists: false, content: Buffer.alloc(0), mode: 0o666 };
    }
    return { ok: false, ...failure };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, kind: 'structural', reason: 'artifact-unreadable' };
    }
    if (stat.size > MAX_GITIGNORE_BYTES) {
      return { ok: false, kind: 'structural', reason: 'artifact-too-large' };
    }
    const content = readFileSync(fd);
    if (content.length > MAX_GITIGNORE_BYTES) {
      return { ok: false, kind: 'structural', reason: 'artifact-too-large' };
    }
    return {
      ok: true,
      kind: 'regular',
      exists: true,
      content,
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    const failure = classifySnapshotError(error, 'descriptor');
    return { ok: false, ...failure };
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

export function compareSnapshot(path, snapshot) {
  const current = readRegularSnapshot(path);
  if (!current.ok) return current.kind === 'observation-failed' ? 'observation-failed' : 'changed';
  return current.exists === snapshot.exists && current.content.equals(snapshot.content)
    ? 'unchanged'
    : 'changed';
}

export function fsyncParent(path, { missingParentIsSynced = false } = {}) {
  let fd;
  try {
    fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(fd);
    return { state: 'synced', reasons: [] };
  } catch (error) {
    if (missingParentIsSynced && (isMissing(error) || error?.code === 'ENOTDIR')) {
      return { state: 'synced', reasons: [] };
    }
    return UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code)
      ? { state: 'unsupported', reasons: ['durability-sync-unsupported'] }
      : { state: 'failed', reasons: ['durability-sync-failed'] };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export function observeDirectory(path) {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && stat.isDirectory() ? 'directory' : 'non-directory';
  } catch (error) {
    return isMissing(error) ? 'missing' : 'observation-failed';
  }
}

export function isRealDirectory(path) {
  return observeDirectory(path) === 'directory';
}
