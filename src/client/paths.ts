import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const JOBS_DIR = join(tmpdir(), 'coral-jobs');

export let SESSION_BASE = join(readHomeDir(), '.claude', 'coral', 'execution', 'sessions');

export let BACKEND_INFO_PATH = join(readHomeDir(), '.claude', 'coral', 'backend.json');

export let BACKEND_LOCK_PATH = join(readHomeDir(), '.claude', 'coral', 'backend.lock');

function readHomeDir(): string {
  try {
    return homedir();
  } catch (error: unknown) {
    if (error instanceof ReferenceError) {
      return '';
    }
    throw error;
  }
}

/**
 * Synchronizes home-directory-based paths with the current `homedir()` value.
 */
export function syncHomePaths(): void {
  const home = readHomeDir();
  SESSION_BASE = join(home, '.claude', 'coral', 'execution', 'sessions');
  BACKEND_INFO_PATH = join(home, '.claude', 'coral', 'backend.json');
  BACKEND_LOCK_PATH = join(home, '.claude', 'coral', 'backend.lock');
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
