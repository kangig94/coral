import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const JOBS_DIR = join(tmpdir(), 'coral-jobs');

function coralHome(): string {
  return join(homedir(), '.claude', 'coral');
}

const namespaceCache = new Map<string, string>();

export function pluginRootNamespace(pluginRoot: string): string {
  const cached = namespaceCache.get(pluginRoot);
  if (cached) return cached;
  const canonical = realpathSync(pluginRoot);
  const ns = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  namespaceCache.set(pluginRoot, ns);
  return ns;
}

export function installationDir(pluginRoot: string): string {
  return join(coralHome(), 'installations', pluginRootNamespace(pluginRoot));
}

export function backendInfoPath(pluginRoot: string): string {
  return join(installationDir(pluginRoot), 'backend.json');
}

export function backendLockPath(pluginRoot: string): string {
  return join(installationDir(pluginRoot), 'backend.lock');
}

export function sessionBase(): string {
  return join(coralHome(), 'execution', 'sessions');
}

export function discussProjectRootsPath(): string {
  return join(coralHome(), 'discuss-project-roots.json');
}

/**
 * Returns the base directory that stores discuss sessions for a project.
 */
export function discussBaseDir(projectRoot: string): string {
  return join(projectRoot, '.coral', 'discuss');
}

/**
 * Returns the discovery file path used to enumerate discuss sessions for a project.
 */
export function discussDiscoveryPath(projectRoot: string): string {
  return join(discussBaseDir(projectRoot), 'discovery.json');
}

/**
 * Returns the summary index path used to list discuss sessions without loading snapshots.
 */
export function discussSummaryIndexPath(projectRoot: string): string {
  return join(discussBaseDir(projectRoot), 'summary-index.json');
}

/**
 * Returns the directory that stores one discuss session.
 */
export function discussSessionDir(projectRoot: string, sessionId: string): string {
  return join(discussBaseDir(projectRoot), sessionId);
}

/**
 * Returns the durable snapshot path for a discuss session directory.
 */
export function discussStatePath(sessionDir: string): string {
  return join(sessionDir, 'state.json');
}

/**
 * Returns the durable event log path for a discuss session directory.
 */
export function discussEventLogPath(sessionDir: string): string {
  return join(sessionDir, 'event-log.jsonl');
}
