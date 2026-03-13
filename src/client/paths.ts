import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const JOBS_DIR = join(tmpdir(), 'coral-jobs');

function coralHome(): string {
  return join(homedir(), '.claude', 'coral');
}

export function sessionBase(): string {
  return join(coralHome(), 'execution', 'sessions');
}

export function backendInfoPath(): string {
  return join(coralHome(), 'backend.json');
}

export function backendLockPath(): string {
  return join(coralHome(), 'backend.lock');
}

export function discussProjectRootsPath(): string {
  return join(coralHome(), 'discuss-project-roots.json');
}

/**
 * Returns the base directory that stores discuss sessions for a project.
 */
export function discussBaseDir(projectRoot: string): string {
  return join(projectRoot, '.claude', 'coral', 'discuss');
}

/**
 * Returns the discovery file path used to enumerate discuss sessions for a project.
 */
export function discussDiscoveryPath(projectRoot: string): string {
  return join(discussBaseDir(projectRoot), 'discovery.json');
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
