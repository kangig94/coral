import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { buildFlavor, coralStateRoot } from '../hook-utils.mjs';
import { isMissing } from './artifacts.mjs';

export const SPAWN_TIMEOUT_MS = 5000;
export const CONTEXT_PROBE_BUDGET_MS = 1500;
export const LOCK_WRAPPER_BUDGET_MS = 250;
export const STAGING_ARENA_MAX_AGE_MS = 600_000;
export const ARENA_SWEEP_BUDGET_MS = 250;
export const ARENA_SWEEP_MAX_RUNS = 32;
export const LOCK_UNAVAILABLE_EXIT_CODE = 69;
export const LOCK_CONFLICT_EXIT_CODE = 75;

export function contextProbeDeadline(startedNs) {
  try {
    return BigInt(startedNs) + BigInt(CONTEXT_PROBE_BUDGET_MS) * 1_000_000n;
  } catch {
    return null;
  }
}

export function fallbackArenaDir() {
  return join(coralStateRoot(), 'staging', 'project-ignore');
}

export function maintenanceLockPath() {
  return join(coralStateRoot(), 'staging', 'project-ignore.maintenance.lock');
}

function ensureRealDirectoryComponent(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { kind: 'structural-conflict' };
    chmodSync(path, 0o700);
    return { kind: 'prepared' };
  } catch (error) {
    if (error?.code !== 'ENOENT') return { kind: 'operational-failure' };
  }

  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return { kind: 'operational-failure' };
  }

  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { kind: 'structural-conflict' };
    chmodSync(path, 0o700);
    return { kind: 'prepared' };
  } catch {
    return { kind: 'operational-failure' };
  }
}

function prepareCoralStateDirectory(components) {
  try {
    const stateRoot = coralStateRoot();
    const home = realpathSync(dirname(stateRoot));
    const expectedStateRoot = join(home, basename(stateRoot));
    const stateRootPreparation = ensureRealDirectoryComponent(expectedStateRoot);
    if (stateRootPreparation.kind !== 'prepared') return stateRootPreparation;
    let canonicalStateRoot = realpathSync(stateRoot);
    if (canonicalStateRoot !== expectedStateRoot) return { kind: 'structural-conflict' };
    for (const component of components) {
      const expectedComponent = join(canonicalStateRoot, component);
      const componentPreparation = ensureRealDirectoryComponent(expectedComponent);
      if (componentPreparation.kind !== 'prepared') return componentPreparation;
      canonicalStateRoot = realpathSync(expectedComponent);
      if (canonicalStateRoot !== expectedComponent) return { kind: 'structural-conflict' };
    }
    return { kind: 'prepared', path: canonicalStateRoot };
  } catch {
    return { kind: 'operational-failure' };
  }
}

function prepareStateStagingDir() {
  const preparation = prepareCoralStateDirectory(['staging']);
  return preparation.kind === 'prepared' ? preparation.path : null;
}

export function prepareCoralProjectDir(target) {
  const projectsRootName = buildFlavor() === 'dev' ? 'projects-dev' : 'projects';
  const projectsRoot = join(coralStateRoot(), projectsRootName);
  if (target === projectsRoot || dirname(target) !== projectsRoot) return { kind: 'structural-conflict' };
  const projectName = basename(target);
  if (join(projectsRoot, projectName) !== target) return { kind: 'structural-conflict' };
  return prepareCoralStateDirectory([projectsRootName, projectName]);
}

export function prepareFallbackArena() {
  const stagingDir = prepareStateStagingDir();
  if (!stagingDir) return null;
  const arena = join(stagingDir, basename(fallbackArenaDir()));
  const arenaPreparation = ensureRealDirectoryComponent(arena);
  if (arenaPreparation.kind !== 'prepared') return null;
  try {
    const canonicalArena = realpathSync(arena);
    return canonicalArena === arena ? canonicalArena : null;
  } catch {
    return null;
  }
}

export function openMaintenanceLock() {
  const stagingDir = prepareStateStagingDir();
  if (!stagingDir) return null;

  const lockPath = maintenanceLockPath();
  let fd;
  try {
    try {
      const named = lstatSync(lockPath);
      if (named.isSymbolicLink() || !named.isFile()) return null;
      chmodSync(lockPath, 0o600);
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
    }
    fd = openSync(
      lockPath,
      constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const opened = fstatSync(fd);
    const named = lstatSync(lockPath);
    if (
      !opened.isFile() ||
      named.isSymbolicLink() ||
      !named.isFile() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    ) {
      closeSync(fd);
      return null;
    }
    fchmodSync(fd, 0o600);
    return fd;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    return null;
  }
}

export function repositoryArenaDir(commonGitDir) {
  return join(commonGitDir, 'coral', 'staging', 'project-ignore');
}

function ensureArenaComponent(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { state: 'structural-conflict', path };
    }
    try {
      chmodSync(path, 0o700);
      return { state: 'ready', path };
    } catch {
      return { state: 'unavailable', path };
    }
  } catch (error) {
    if (!isMissing(error)) return { state: 'unavailable', path };
  }

  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return { state: 'unavailable', path };
  }

  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { state: 'structural-conflict', path };
    }
    chmodSync(path, 0o700);
    return { state: 'ready', path };
  } catch {
    return { state: 'unavailable', path };
  }
}

export function prepareRepositoryArena(commonGitDir) {
  let current = commonGitDir;
  try {
    const canonicalCommonGitDir = realpathSync(commonGitDir);
    const expectedArena = repositoryArenaDir(canonicalCommonGitDir);
    current = canonicalCommonGitDir;
    for (const component of ['coral', 'staging', 'project-ignore']) {
      current = join(current, component);
      const preparation = ensureArenaComponent(current);
      if (preparation.state === 'structural-conflict') return { ...preparation, component };
      if (preparation.state !== 'ready') return preparation;
    }

    const canonicalArena = realpathSync(current);
    if (current !== expectedArena) {
      return { state: 'structural-conflict', path: current, component: 'project-ignore' };
    }
    const containment = relative(canonicalCommonGitDir, canonicalArena);
    if (
      containment.length === 0 ||
      isAbsolute(containment) ||
      containment === '..' ||
      containment.startsWith(`..${sep}`)
    ) {
      return { state: 'structural-conflict', path: current, component: 'project-ignore' };
    }
    return { state: 'prepared', path: canonicalArena };
  } catch {
    return { state: 'unavailable', path: current };
  }
}

export function isRepositoryArenaAuthorized({ gitRoot, commonGitDir }) {
  try {
    const canonicalGitRoot = realpathSync(gitRoot);
    const canonicalCommonGitDir = realpathSync(commonGitDir);
    const containment = relative(canonicalGitRoot, canonicalCommonGitDir);
    const insideWorkingTree =
      containment.length === 0 ||
      (!isAbsolute(containment) && containment !== '..' && !containment.startsWith(`..${sep}`));
    if (!insideWorkingTree) return true;

    const dotGit = join(canonicalGitRoot, '.git');
    const dotGitStat = lstatSync(dotGit);
    return (
      !dotGitStat.isSymbolicLink() &&
      dotGitStat.isDirectory() &&
      realpathSync(dotGit) === canonicalCommonGitDir
    );
  } catch {
    return false;
  }
}

function parseArenaRun(name) {
  const match = /^(0|[1-9]\d*)-(0|[1-9]\d*)$/u.exec(name);
  if (!match) return null;
  const startedAt = Number(match[1]);
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(pid) || startedAt < 1 || pid < 1) return null;
  return { startedAt, pid };
}

export function sweepArenas(
  arenaDirs,
  { now = Date.now(), monotonicNow = () => performance.now() } = {},
) {
  const sweepStartedAt = monotonicNow();
  const candidates = [];
  const failures = [];

  for (const arenaDir of new Set(arenaDirs)) {
    try {
      const arenaStat = lstatSync(arenaDir);
      if (arenaStat.isSymbolicLink() || !arenaStat.isDirectory()) {
        failures.push({ state: 'structural-conflict', path: arenaDir });
        continue;
      }
      chmodSync(arenaDir, 0o700);
      for (const entry of readdirSync(arenaDir, { withFileTypes: true })) {
        const run = parseArenaRun(entry.name);
        if (!run || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        candidates.push({ arenaDir, name: entry.name, ...run });
      }
    } catch {
      failures.push({ state: 'operation-failed', path: arenaDir });
    }
  }

  candidates.sort(
    (left, right) =>
      left.startedAt - right.startedAt || left.pid - right.pid || left.arenaDir.localeCompare(right.arenaDir),
  );

  let inspected = 0;
  let removed = 0;
  for (const candidate of candidates) {
    if (
      inspected >= ARENA_SWEEP_MAX_RUNS ||
      monotonicNow() - sweepStartedAt >= ARENA_SWEEP_BUDGET_MS
    ) {
      break;
    }
    inspected += 1;
    const runDir = join(candidate.arenaDir, candidate.name);
    try {
      const stat = lstatSync(runDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      chmodSync(runDir, 0o700);
      if (now - candidate.startedAt < STAGING_ARENA_MAX_AGE_MS) continue;
      rmSync(runDir, { recursive: true });
      removed += 1;
    } catch {
      failures.push({ state: 'operation-failed', path: runDir });
    }
  }

  return { inspected, removed, failures };
}

export function arenaRunDir(arenaDir, startedAt, pid = process.pid) {
  return join(arenaDir, `${startedAt}-${pid}`);
}

export function createArenaRunDir(arenaDir, startedAt) {
  const runDir = arenaRunDir(arenaDir, startedAt);
  try {
    mkdirSync(runDir, { mode: 0o700 });
    chmodSync(runDir, 0o700);
    const stat = lstatSync(runDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    return runDir;
  } catch {
    return null;
  }
}

export function removeArenaRunDir(runDir) {
  try {
    const stat = lstatSync(runDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    rmSync(runDir, { recursive: true });
  } catch (error) {
    return isMissing(error);
  }

  try {
    lstatSync(runDir);
    return false;
  } catch (error) {
    return isMissing(error);
  }
}
