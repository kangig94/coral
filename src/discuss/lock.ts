import * as fs from 'node:fs';
import * as path from 'node:path';
import { sleep } from './util/time.js';

function tryRemoveSync(targetPath: string): void {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
  }
}

export function writeStateAtomic(filePath: string, state: Record<string, unknown>): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseLockOwner(filePath: string): { pid: number; startedAt: number } | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const [rawPid, rawStartedAt] = content.split('-', 2);
    if (!rawPid || !rawStartedAt) return null;
    const pid = Number.parseInt(rawPid, 10);
    const startedAt = Number.parseInt(rawStartedAt, 10);
    if (Number.isNaN(pid) || Number.isNaN(startedAt)) return null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStaleOwner(owner: { pid: number; startedAt: number } | null, staleThresholdMs: number): boolean {
  return !owner || !isProcessAlive(owner.pid) || Date.now() - owner.startedAt > staleThresholdMs;
}

export class SessionLock {
  async acquire<T>(sessionDir: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = path.join(sessionDir, 'state.lock');
    const pidFile = path.join(lockDir, 'pid');
    const maxRetries = 10;
    const baseDelay = 50;
    const staleThresholdMs = 30_000;
    const clearLockFiles = (): void => {
      tryRemoveSync(pidFile);
      tryRemoveSync(lockDir);
    };

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        fs.mkdirSync(lockDir); // atomic: fails EEXIST if held
        fs.writeFileSync(pidFile, `${process.pid}-${Date.now()}`);
        try {
          return await fn();
        } finally {
          clearLockFiles();
        }
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') {
          throw e;
        }

        const owner = parseLockOwner(pidFile);
        if (isStaleOwner(owner, staleThresholdMs)) {
          clearLockFiles();
          continue;
        }

        const backoffDelay = baseDelay * Math.pow(2, Math.min(attempt, 5)) + Math.random() * baseDelay;
        await sleep(backoffDelay);
      }
    }
    throw new Error(`Lock timeout for session ${sessionDir}`);
  }
}
