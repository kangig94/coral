import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Runtime } from './ports.js';
import { ensureExecSucceeded, findCommand } from './exec-checks.js';

const COMMAND_TIMEOUT_MS = 120_000;

/** Download a URL to a Buffer, preferring `curl` then `wget` then `fetch`. */
export async function downloadBuffer(runtime: Runtime, url: string): Promise<Buffer> {
  const curl = await findCommand(runtime, 'curl');
  if (curl) {
    return downloadBufferWithCommand(runtime, curl, ['-fsSL', '-o'], url);
  }

  const wget = await findCommand(runtime, 'wget');
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
  const tempDir = mkdtempSync(join(tmpdir(), 'coral-runtime-download-'));
  const destination = join(tempDir, 'download.bin');

  try {
    const result = await runtime.process.exec(command, [outputFlags[0], outputFlags[1], destination, url], {
      inheritEnv: true,
      timeout: COMMAND_TIMEOUT_MS,
    });
    ensureExecSucceeded(command, result);
    return readFileSync(destination);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
