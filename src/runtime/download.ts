import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Runtime } from './ports.js';
import { ensureExecSucceeded, findCommand } from './exec-checks.js';

const COMMAND_TIMEOUT_MS = 120_000;

export type DownloadBufferOptions = {
  maxBytes?: number;
};

function assertDownloadSize(url: string, observedBytes: number, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && observedBytes > maxBytes) {
    throw new Error(`Download exceeded maximum size (${observedBytes} bytes > ${maxBytes} bytes): ${url}`);
  }
}

function contentLengthBytes(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (raw === null) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readFetchBody(response: Response, url: string, maxBytes: number | undefined): Promise<Buffer> {
  const declaredBytes = contentLengthBytes(response);
  if (declaredBytes !== null) {
    assertDownloadSize(url, declaredBytes, maxBytes);
  }

  if (response.body === null) {
    const buffer = Buffer.from(await response.arrayBuffer());
    assertDownloadSize(url, buffer.length, maxBytes);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        return Buffer.concat(chunks, totalBytes);
      }
      const chunk = Buffer.from(next.value);
      totalBytes += chunk.length;
      if (maxBytes !== undefined && totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        assertDownloadSize(url, totalBytes, maxBytes);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

/** Download a URL to a Buffer, preferring `curl` then `wget` then `fetch`. */
export async function downloadBuffer(
  runtime: Runtime,
  url: string,
  options: DownloadBufferOptions = {},
): Promise<Buffer> {
  const curl = await findCommand(runtime, 'curl');
  if (curl) {
    return downloadBufferWithCommand(runtime, curl, ['-fsSL', '-o'], url, options);
  }

  const wget = await findCommand(runtime, 'wget');
  if (wget) {
    return downloadBufferWithCommand(runtime, wget, ['-q', '-O'], url, options);
  }

  if (typeof fetch !== 'function') {
    throw new Error('fetch is not available and neither curl nor wget is installed.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} when downloading ${url}`);
    }
    return await readFetchBody(response, url, options.maxBytes);
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new Error(`Download timed out after ${COMMAND_TIMEOUT_MS}ms: ${url}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadBufferWithCommand(
  runtime: Runtime,
  command: string,
  outputFlags: readonly [string, string],
  url: string,
  options: DownloadBufferOptions,
): Promise<Buffer> {
  const tempDir = mkdtempSync(join(tmpdir(), 'coral-runtime-download-'));
  const destination = join(tempDir, 'download.bin');

  try {
    const result = await runtime.process.exec(command, [outputFlags[0], outputFlags[1], destination, url], {
      inheritEnv: true,
      timeout: COMMAND_TIMEOUT_MS,
    });
    ensureExecSucceeded(command, result);
    assertDownloadSize(url, statSync(destination).size, options.maxBytes);
    return readFileSync(destination);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
