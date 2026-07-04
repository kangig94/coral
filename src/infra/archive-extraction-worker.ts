import * as timers from 'node:timers';
import { Worker } from 'node:worker_threads';

type TarGzEntryMatcher = {
  readonly key: string;
  readonly exactPath?: string;
  readonly suffix?: string;
};

export type ExtractTarGzEntriesRequest = {
  readonly archive: Buffer;
  readonly archiveLabel: string;
  readonly maxTarBytes: number;
  readonly entries: readonly TarGzEntryMatcher[];
  readonly missingMessage?: string;
};

export type ExtractTarGzEntriesOptions = {
  readonly timeoutMs?: number;
};

const DEFAULT_EXTRACTION_WORKER_TIMEOUT_MS = 60_000;

const TAR_GZ_EXTRACTION_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { gunzipSync } = require('node:zlib');

const TAR_BLOCK_SIZE = 512;
const TAR_FILE_TYPES = new Set(['0', '']);

function tarFieldToString(buffer) {
  return buffer.toString('utf-8').replace(/\\0.*$/, '').trim();
}

function tarFieldToNumber(buffer) {
  const raw = tarFieldToString(buffer);
  return raw === '' ? 0 : Number.parseInt(raw, 8);
}

function gunzipTar(archiveBuffer, archiveLabel, maxTarBytes) {
  try {
    return gunzipSync(archiveBuffer, { maxOutputLength: maxTarBytes });
  } catch (error) {
    if (error instanceof Error && error.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(\`\${archiveLabel} exceeds maximum decompressed size (\${maxTarBytes} bytes)\`, {
        cause: error,
      });
    }
    throw error;
  }
}

function readTarEntrySize(header, fullName, archiveLabel) {
  const size = tarFieldToNumber(header.subarray(124, 136));
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(\`\${archiveLabel} entry has invalid size: \${fullName || '<unnamed>'}\`);
  }
  return size;
}

function tarEntryNextOffset(dataOffset, size, tarLength, fullName, archiveLabel) {
  const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  const dataEnd = dataOffset + size;
  const nextOffset = dataOffset + paddedSize;
  if (dataEnd > tarLength || nextOffset > tarLength) {
    throw new Error(\`\${archiveLabel} entry exceeds archive bounds: \${fullName || '<unnamed>'}\`);
  }
  return nextOffset;
}

function matchesEntry(fullName, spec) {
  if (spec.exactPath !== undefined && fullName === spec.exactPath) {
    return true;
  }
  return (
    spec.suffix !== undefined &&
    (fullName === spec.suffix || fullName.endsWith(\`/\${spec.suffix}\`))
  );
}

function extractEntries() {
  const archiveLabel = workerData.archiveLabel;
  const tarBuffer = gunzipTar(Buffer.from(workerData.archive), archiveLabel, workerData.maxTarBytes);
  const pending = new Map(workerData.entries.map((entry) => [entry.key, entry]));
  const found = [];
  const transferList = [];
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = tarFieldToString(header.subarray(0, 100));
    const prefix = tarFieldToString(header.subarray(345, 500));
    const fullName = prefix ? \`\${prefix}/\${name}\` : name;
    const size = readTarEntrySize(header, fullName, archiveLabel);
    const typeFlag = header[156] === 0 ? '' : String.fromCharCode(header[156]);
    offset += TAR_BLOCK_SIZE;
    const nextOffset = tarEntryNextOffset(offset, size, tarBuffer.length, fullName, archiveLabel);

    if (TAR_FILE_TYPES.has(typeFlag)) {
      for (const [key, spec] of pending) {
        if (!matchesEntry(fullName, spec)) {
          continue;
        }
        const data = Buffer.from(tarBuffer.subarray(offset, offset + size));
        const transferable = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        found.push({ key, data: transferable });
        transferList.push(transferable);
        pending.delete(key);
      }
      if (pending.size === 0) {
        break;
      }
    }

    offset = nextOffset;
  }

  if (pending.size > 0) {
    const missing = Array.from(pending.keys()).join(', ');
    throw new Error(workerData.missingMessage ?? \`\${archiveLabel} is missing required files: \${missing}\`);
  }

  return { found, transferList };
}

try {
  const { found, transferList } = extractEntries();
  parentPort.postMessage({ ok: true, entries: found }, transferList);
} catch (error) {
  parentPort.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
`;

type WorkerSuccess = {
  readonly ok: true;
  readonly entries: readonly { readonly key: string; readonly data: ArrayBuffer }[];
};

type WorkerFailure = {
  readonly ok: false;
  readonly message: string;
  readonly stack?: string;
};

type WorkerReply = WorkerSuccess | WorkerFailure;

function isWorkerReply(value: unknown): value is WorkerReply {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return false;
  }
  const reply = value as { ok?: unknown; entries?: unknown; message?: unknown };
  if (reply.ok === true) {
    return Array.isArray(reply.entries);
  }
  return reply.ok === false && typeof reply.message === 'string';
}

function workerFailureToError(reply: WorkerFailure): Error {
  const error = new Error(reply.message);
  if (reply.stack !== undefined) {
    error.stack = reply.stack;
  }
  return error;
}

function workerSuccessToMap(reply: WorkerSuccess): ReadonlyMap<string, Buffer> {
  const entries = new Map<string, Buffer>();
  for (const entry of reply.entries) {
    entries.set(entry.key, Buffer.from(entry.data));
  }
  return entries;
}

export async function extractTarGzEntriesInWorker(
  request: ExtractTarGzEntriesRequest,
  options: ExtractTarGzEntriesOptions = {},
): Promise<ReadonlyMap<string, Buffer>> {
  if (request.entries.length === 0) {
    return new Map();
  }

  const worker = new Worker(TAR_GZ_EXTRACTION_WORKER_SOURCE, {
    eval: true,
    workerData: request,
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTRACTION_WORKER_TIMEOUT_MS;

  return await new Promise<ReadonlyMap<string, Buffer>>((resolve, reject) => {
    let settled = false;
    const timeout = timers.setTimeout(() => {
      settle(reject, new Error(`${request.archiveLabel} extraction worker timed out after ${timeoutMs}ms`));
      void worker.terminate();
    }, timeoutMs);

    function cleanup(): void {
      timers.clearTimeout(timeout);
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
      if (!isWorkerReply(message)) {
        settle(reject, new Error(`${request.archiveLabel} extraction worker returned an invalid response`));
        void worker.terminate();
        return;
      }
      if (!message.ok) {
        settle(reject, workerFailureToError(message));
        void worker.terminate();
        return;
      }
      settle(resolve, workerSuccessToMap(message));
      void worker.terminate();
    });

    worker.once('error', (error) => {
      settle(reject, error);
    });

    worker.once('exit', (code) => {
      if (code !== 0) {
        settle(reject, new Error(`${request.archiveLabel} extraction worker exited with code ${code}`));
      }
    });
  });
}
