import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Runtime, StoragePort } from '../runtime/ports.js';
export { acquireDirectoryLock, isDirectoryLockTimeoutError } from './fs-lock.js';

const COMMAND_TIMEOUT_MS = 120_000;

type InstallMeta = {
  version: string;
  method: string;
};

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function findCommand(runtime: Runtime, command: string): string | null {
  const locator = runtime.env.platform() === 'win32' ? 'where' : 'which';
  const result = runtime.process.execSync(locator, [command], {
    encoding: 'utf-8',
    inheritEnv: true,
    timeout: 10_000,
  });

  if (result.status !== 0 || result.error || result.stdout.trim().length === 0) {
    return null;
  }

  return result.stdout.trim().split(/\r?\n/, 1)[0] ?? null;
}

export function ensureExecSucceeded(
  command: string,
  result: Awaited<ReturnType<Runtime['process']['execSync']>>,
): void {
  if (result.status === 0 && !result.error) {
    return;
  }

  const parts = [`${command} failed`];
  if (result.stderr.trim().length > 0) {
    parts.push(result.stderr.trim());
  } else if (result.error instanceof Error) {
    parts.push(result.error.message);
  }
  throw new Error(parts.join(': '));
}

export async function downloadBuffer(runtime: Runtime, url: string): Promise<Buffer> {
  const curl = findCommand(runtime, 'curl');
  if (curl) {
    return downloadBufferWithCommand(runtime, curl, ['-fsSL', '-o'], url);
  }

  const wget = findCommand(runtime, 'wget');
  if (wget) {
    return downloadBufferWithCommand(runtime, wget, ['-q', '-O'], url);
  }

  if (typeof fetch !== 'function') {
    throw new Error('fetch is not available and neither curl nor wget is installed.');
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} when downloading ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function downloadBufferWithCommand(
  runtime: Runtime,
  command: string,
  outputFlags: readonly [string, string],
  url: string,
): Promise<Buffer> {
  const tempDir = mkdtempSync(join(tmpdir(), 'coral-expansion-download-'));
  const destination = join(tempDir, 'download.bin');

  try {
    const result = runtime.process.execSync(command, [outputFlags[0], outputFlags[1], destination, url], {
      inheritEnv: true,
      timeout: COMMAND_TIMEOUT_MS,
    });
    ensureExecSucceeded(command, result);
    return readFileSync(destination);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function readInstallMeta(
  storage: Pick<StoragePort, 'readFileSync'>,
  candidates: readonly string[],
): InstallMeta | null {
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(storage.readFileSync(path, 'utf-8')) as Partial<InstallMeta>;
      if (typeof parsed.version === 'string' && typeof parsed.method === 'string') {
        return {
          version: parsed.version,
          method: parsed.method,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function writeInstallMeta(
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  filePath: string,
  value: InstallMeta,
): void {
  storage.mkdirSync(dirname(filePath), { recursive: true });
  if (!storage.writeAtomicSync(filePath, JSON.stringify(value), { encoding: 'utf-8' })) {
    throw new Error(`Atomic write failed: ${filePath}`);
  }
}
