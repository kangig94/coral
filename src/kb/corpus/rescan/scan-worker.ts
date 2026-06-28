import * as timers from 'node:timers';
import { Worker } from 'node:worker_threads';

import {
  CORPUS_SCAN_MAX_FILE_BYTES_ENV,
  CORPUS_SCAN_MAX_FILES_ENV,
  CORPUS_SCAN_MAX_TOTAL_BYTES_ENV,
  CorpusScanLimitError,
  createCorpusScanViewFromInput,
  resolveCorpusScanLimits,
  type CorpusScanLimits,
  type CorpusScanView,
  type CorpusScanViewInput,
} from './scan.js';
import type { EnvPort } from '../../../infra/port-types.js';

export const CORPUS_SCAN_WORKER_TIMEOUT_MS = 120_000;

type CorpusScanWorkerRequest = {
  readonly markdownRoot: string;
  readonly entityGraphPath: string;
  readonly limits: CorpusScanLimits;
};

type CorpusScanWorkerSuccess = {
  readonly ok: true;
  readonly scan: CorpusScanViewInput;
};

type CorpusScanWorkerFailure = {
  readonly ok: false;
  readonly error: {
    readonly name?: string;
    readonly message: string;
    readonly stack?: string;
  };
};

type CorpusScanWorkerReply = CorpusScanWorkerSuccess | CorpusScanWorkerFailure;

const CORPUS_SCAN_WORKER_SOURCE = `
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const CORPUS_SCAN_MAX_FILES_ENV = ${JSON.stringify(CORPUS_SCAN_MAX_FILES_ENV)};
const CORPUS_SCAN_MAX_FILE_BYTES_ENV = ${JSON.stringify(CORPUS_SCAN_MAX_FILE_BYTES_ENV)};
const CORPUS_SCAN_MAX_TOTAL_BYTES_ENV = ${JSON.stringify(CORPUS_SCAN_MAX_TOTAL_BYTES_ENV)};

const CORPUS_SUBDIR_BY_KIND = {
  note: 'notes',
  source: 'sources',
  community: 'communities',
  principle: 'principles',
  wiki: 'wiki',
};
const CORPUS_KINDS = ['note', 'source', 'community', 'principle', 'wiki'];

class CorpusScanLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorpusScanLimitError';
  }
}

function isNoEntryError(error) {
  return error instanceof Error && error.code === 'ENOENT';
}

function sortedMarkdownEntries(dirPath) {
  try {
    const entries = [];
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        entries.push(entry.name);
      }
    }
    return entries.sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }
}

function readMarkdownFiles(markdownRoot, limits) {
  const markdownFiles = [];
  let totalBytes = 0;
  for (const kind of CORPUS_KINDS) {
    const dirPath = join(markdownRoot, CORPUS_SUBDIR_BY_KIND[kind]);
    for (const name of sortedMarkdownEntries(dirPath)) {
      if (markdownFiles.length >= limits.maxFiles) {
        throw new CorpusScanLimitError(
          \`KB corpus scan exceeds maximum markdown file count (\${markdownFiles.length + 1} files > \${limits.maxFiles} files). Increase \${CORPUS_SCAN_MAX_FILES_ENV} to allow a larger corpus.\`,
        );
      }
      const path = join(dirPath, name);
      const sizeBytes = statSync(path).size;
      if (sizeBytes > limits.maxFileBytes) {
        throw new CorpusScanLimitError(
          \`KB corpus scan file \${path} exceeds maximum size (\${sizeBytes} bytes > \${limits.maxFileBytes} bytes). Increase \${CORPUS_SCAN_MAX_FILE_BYTES_ENV} to allow larger markdown files.\`,
        );
      }
      totalBytes += sizeBytes;
      if (totalBytes > limits.maxTotalBytes) {
        throw new CorpusScanLimitError(
          \`KB corpus scan exceeds maximum total markdown size (\${totalBytes} bytes > \${limits.maxTotalBytes} bytes). Increase \${CORPUS_SCAN_MAX_TOTAL_BYTES_ENV} to allow a larger corpus.\`,
        );
      }
      markdownFiles.push({
        kind,
        path,
        content: readFileSync(path, 'utf-8'),
      });
    }
  }
  return markdownFiles;
}

function readEntityGraph(entityGraphPath, limits) {
  try {
    const sizeBytes = statSync(entityGraphPath).size;
    if (sizeBytes > limits.maxFileBytes) {
      throw new CorpusScanLimitError(
        \`KB corpus entity graph \${entityGraphPath} exceeds maximum size (\${sizeBytes} bytes > \${limits.maxFileBytes} bytes). Increase \${CORPUS_SCAN_MAX_FILE_BYTES_ENV} to allow a larger entity graph.\`,
      );
    }
    return {
      path: entityGraphPath,
      content: readFileSync(entityGraphPath, 'utf-8'),
    };
  } catch (error) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
}

try {
  const request = workerData;
  parentPort.postMessage({
    ok: true,
    scan: {
      markdownFiles: readMarkdownFiles(request.markdownRoot, request.limits),
      entityGraph: readEntityGraph(request.entityGraphPath, request.limits),
    },
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) },
  });
}
`;

function workerFailureToError(reply: CorpusScanWorkerFailure): Error {
  const error =
    reply.error.name === 'CorpusScanLimitError'
      ? new CorpusScanLimitError(reply.error.message)
      : new Error(reply.error.message);
  error.name = reply.error.name ?? error.name;
  if (reply.error.stack !== undefined) {
    error.stack = reply.error.stack;
  }
  return error;
}

function isCorpusScanWorkerReply(value: unknown): value is CorpusScanWorkerReply {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return false;
  }
  const reply = value as { ok?: unknown; scan?: unknown; error?: unknown };
  if (reply.ok === true) {
    return typeof reply.scan === 'object' && reply.scan !== null;
  }
  return reply.ok === false && typeof reply.error === 'object' && reply.error !== null;
}

export async function buildCorpusScanViewInWorker(
  kb: {
    readonly markdownRoot: string;
    readonly envPort?: Pick<EnvPort, 'get'>;
    entityGraphPath(): string;
  },
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CorpusScanView> {
  if (options.signal?.aborted) {
    throw new Error('KB corpus scan worker aborted');
  }
  const limits = resolveCorpusScanLimits(kb.envPort);
  const request: CorpusScanWorkerRequest = {
    markdownRoot: kb.markdownRoot,
    entityGraphPath: kb.entityGraphPath(),
    limits,
  };
  const timeoutMs = options.timeoutMs ?? CORPUS_SCAN_WORKER_TIMEOUT_MS;
  const worker = new Worker(CORPUS_SCAN_WORKER_SOURCE, {
    eval: true,
    workerData: request,
  });

  return await new Promise<CorpusScanView>((resolve, reject) => {
    let settled = false;
    const timeout = timers.setTimeout(() => {
      settle(reject, new Error(`KB corpus scan worker timed out after ${timeoutMs}ms`));
      void worker.terminate();
    }, timeoutMs);
    timeout.unref?.();

    const abort = (): void => {
      settle(reject, new Error('KB corpus scan worker aborted'));
      void worker.terminate();
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    function cleanup(): void {
      timers.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      worker.removeAllListeners('message');
      worker.removeAllListeners('error');
      worker.removeAllListeners('exit');
    }

    function settle<T>(done: (value: T) => void, value: T): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      done(value);
    }

    worker.once('message', (message: unknown) => {
      if (!isCorpusScanWorkerReply(message)) {
        settle(reject, new Error('KB corpus scan worker returned an invalid response'));
        void worker.terminate();
        return;
      }
      if (!message.ok) {
        settle(reject, workerFailureToError(message));
        void worker.terminate();
        return;
      }
      settle(resolve, createCorpusScanViewFromInput(message.scan, limits));
      void worker.terminate();
    });

    worker.once('error', (error) => {
      settle(reject, error);
    });

    worker.once('exit', (code) => {
      if (code !== 0) {
        settle(reject, new Error(`KB corpus scan worker exited with code ${code}`));
      }
    });
  });
}
