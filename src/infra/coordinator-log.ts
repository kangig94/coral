import { closeSync, fstatSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { setBackendLogSink } from './backend-log.js';

export const LOG_ROTATE_THRESHOLD_BYTES = 2 * 1024 * 1024;

function rotateLogIfLarge(runDir: string): void {
  const path = join(runDir, 'coordinator.log');
  const archive = `${path}.1`;
  try {
    if (statSync(path).size < LOG_ROTATE_THRESHOLD_BYTES) return;
    try {
      unlinkSync(archive);
    } catch {
      // A missing archive must not prevent rotation.
    }
    renameSync(path, archive);
  } catch {
    // Rotation failure must not prevent launch.
  }
}

function openCoordinatorLog(runDir: string): number {
  mkdirSync(runDir, { recursive: true });
  return openSync(join(runDir, 'coordinator.log'), 'a');
}

/** A launcher must retain its own stderr if the run directory cannot be opened. */
export function withCoordinatorLog<T>(runDir: string, launch: (stderr: number) => T): T {
  let fd: number;
  try {
    rotateLogIfLarge(runDir);
    fd = openCoordinatorLog(runDir);
  } catch {
    return launch(2);
  }
  try {
    return launch(fd);
  } finally {
    closeSync(fd);
  }
}

/** Pipes and terminals remain launcher-owned; null devices cannot retain diagnostics. */
export function installCoordinatorLog(runDir: string): void {
  try {
    const stderr = fstatSync(2);
    writeSync(2, '');
    if (!stderr.isCharacterDevice() || process.stderr.isTTY) return;
  } catch {
    // An invalid or read-only descriptor needs the same fallback as a null device.
  }
  setBackendLogSink(() => {});
  let fd: number;
  try {
    fd = openCoordinatorLog(runDir);
  } catch {
    return;
  }
  setBackendLogSink((message) => {
    try {
      writeSync(fd, message);
    } catch {
      // Diagnostic failures must not select a startup or recovery disposition.
    }
  });
}
