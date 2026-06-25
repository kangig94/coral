import * as timers from 'node:timers';
import { Worker } from 'node:worker_threads';

import { AbortError } from '../../runtime/abort.js';

export const SOURCE_IMPORT_CONVERSION_WORKER_TIMEOUT_MS = 30 * 60 * 1000;

export type SourceConversionWorkerRequest =
  | {
      readonly kind: 'html';
      readonly html: string;
      readonly outputMaxBytes: number | null;
      readonly limitExceededHint?: string;
    }
  | {
      readonly kind: 'docx';
      readonly filePath: string;
      readonly outputMaxBytes: number | null;
      readonly limitExceededHint?: string;
    };

export type SourceConversionWorkerOptions = {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type SourceConversionResult = {
  readonly markdown: string;
  readonly title: string;
};

const SOURCE_CONVERSION_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');

const LEADING_ATX_H1 = /^#(?!#)\\s+(.+?)\\s*#*\\s*(?:\\r?\\n+|$)/;
const LEADING_SETEXT_H1 = /^([^\\r\\n]+)\\r?\\n=+\\s*(?:\\r?\\n+|$)/;
const HTML_TITLE_PATTERN = /<title\\b[^>]*>([\\s\\S]*?)<\\/title>/i;
const HTML_H1_PATTERN = /<h1\\b[^>]*>([\\s\\S]*?)<\\/h1>/i;
const HTML_BODY_PATTERN = /<body\\b[^>]*>([\\s\\S]*?)<\\/body>/i;

const HTML_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function normalizeTextInput(text) {
  return text.replace(/^\\uFEFF/, '');
}

function assertNonEmptyText(value, label) {
  if (typeof value !== 'string') {
    throw new Error(\`\${label} must be a string\`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(\`\${label} must be non-empty\`);
  }
  return normalized;
}

function normalizeTitle(value) {
  return assertNonEmptyText(value.replace(/\\s+/g, ' '), 'title');
}

function decodeHtmlEntity(entity) {
  const normalized = entity.toLowerCase();
  if (normalized.startsWith('#x')) {
    const codePoint = Number.parseInt(normalized.slice(2), 16);
    if (!Number.isInteger(codePoint)) {
      return \`&\${entity};\`;
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return \`&\${entity};\`;
    }
  }

  if (normalized.startsWith('#')) {
    const codePoint = Number.parseInt(normalized.slice(1), 10);
    if (!Number.isInteger(codePoint)) {
      return \`&\${entity};\`;
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return \`&\${entity};\`;
    }
  }

  return HTML_ENTITIES[normalized] ?? \`&\${entity};\`;
}

function htmlFragmentToText(fragment) {
  const withoutComments = fragment.replace(/<!--[\\s\\S]*?-->/g, ' ');
  const withoutTags = withoutComments.replace(/<[^>]+>/g, ' ');
  const decoded = withoutTags.replace(/&(#(?:x[0-9a-f]+|\\d+)|[a-z]+);/gi, (_, entity) =>
    decodeHtmlEntity(entity),
  );
  const normalized = decoded.replace(/\\s+/g, ' ').trim();
  return normalized || undefined;
}

function splitLeadingMarkdownTitle(markdown) {
  const trimmed = markdown.trimStart();
  const atxMatch = trimmed.match(LEADING_ATX_H1);
  if (atxMatch) {
    return {
      title: normalizeTitle(atxMatch[1]),
      body: trimmed.slice(atxMatch[0].length).trim(),
    };
  }

  const setextMatch = trimmed.match(LEADING_SETEXT_H1);
  if (setextMatch) {
    return {
      title: normalizeTitle(setextMatch[1]),
      body: trimmed.slice(setextMatch[0].length).trim(),
    };
  }

  return { body: trimmed.trim() };
}

function extractFirstHtmlH1(html) {
  const h1Match = html.match(HTML_H1_PATTERN)?.[1];
  const h1Text = h1Match ? htmlFragmentToText(h1Match) : undefined;
  return h1Text ? normalizeTitle(h1Text) : undefined;
}

function extractHtmlTitle(html) {
  const titleMatch = html.match(HTML_TITLE_PATTERN)?.[1];
  const titleText = titleMatch ? htmlFragmentToText(titleMatch) : undefined;
  if (titleText) {
    return normalizeTitle(titleText);
  }

  return extractFirstHtmlH1(html);
}

function extractHtmlBody(html) {
  return html.match(HTML_BODY_PATTERN)?.[1] ?? html;
}

function loadTurndownService() {
  const loaded = require('turndown');
  const candidate = loaded.default ?? loaded;
  if (typeof candidate !== 'function') {
    throw new Error('turndown did not export a constructor');
  }
  return candidate;
}

function loadMammoth() {
  const loaded = require('mammoth');
  const candidate = loaded.default ?? loaded;
  if (typeof candidate.convertToHtml !== 'function') {
    throw new Error('mammoth did not export convertToHtml');
  }
  return candidate;
}

function htmlToMarkdownBody(html) {
  const TurndownService = loadTurndownService();
  const turndown = new TurndownService({ headingStyle: 'atx' });
  const markdown = turndown.turndown(extractHtmlBody(html));
  return splitLeadingMarkdownTitle(markdown).body;
}

function assertMarkdownOutputSize(markdown, maxBytes, label, limitExceededHint) {
  if (maxBytes === null) {
    return;
  }
  const observedBytes = Buffer.byteLength(markdown, 'utf-8');
  if (observedBytes > maxBytes) {
    const message = \`\${label} exceeds maximum markdown output size (\${observedBytes} bytes > \${maxBytes} bytes)\`;
    throw new Error(limitExceededHint === undefined ? message : \`\${message}. \${limitExceededHint}\`);
  }
}

async function convertHtml(request) {
  const html = normalizeTextInput(request.html);
  const title = extractHtmlTitle(html);
  if (!title) {
    throw new Error('HTML import requires a <title> or first <h1>');
  }
  const markdown = htmlToMarkdownBody(html);
  assertMarkdownOutputSize(markdown, request.outputMaxBytes, 'KB source import HTML converter output', request.limitExceededHint);
  return { markdown, title };
}

async function convertDocx(request) {
  const mammoth = loadMammoth();
  const result = await mammoth.convertToHtml({ path: request.filePath });
  const html = normalizeTextInput(result.value);
  const title = extractFirstHtmlH1(html);
  if (!title) {
    throw new Error('DOCX import requires the first Heading 1 to provide a title');
  }
  const markdown = htmlToMarkdownBody(html);
  assertMarkdownOutputSize(markdown, request.outputMaxBytes, 'KB source import DOCX converter output', request.limitExceededHint);
  return { markdown, title };
}

async function main() {
  if (workerData.kind === 'html') {
    return await convertHtml(workerData);
  }
  if (workerData.kind === 'docx') {
    return await convertDocx(workerData);
  }
  throw new Error(\`Unsupported source conversion worker kind: \${workerData.kind}\`);
}

main()
  .then((result) => {
    parentPort.postMessage({ ok: true, result });
  })
  .catch((error) => {
    parentPort.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  });
`;

type WorkerSuccess = {
  readonly ok: true;
  readonly result: SourceConversionResult;
};

type WorkerFailure = {
  readonly ok: false;
  readonly message: string;
  readonly stack?: string;
};

type WorkerReply = WorkerSuccess | WorkerFailure;

function isSourceConversionResult(value: unknown): value is SourceConversionResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const result = value as { markdown?: unknown; title?: unknown };
  return typeof result.markdown === 'string' && typeof result.title === 'string';
}

function isWorkerReply(value: unknown): value is WorkerReply {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return false;
  }
  const reply = value as { ok?: unknown; result?: unknown; message?: unknown };
  if (reply.ok === true) {
    return isSourceConversionResult(reply.result);
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

function abortError(signal: AbortSignal): AbortError {
  return new AbortError({ stage: 'convert', reason: signal.reason });
}

export async function convertSourceInWorker(
  request: SourceConversionWorkerRequest,
  options: SourceConversionWorkerOptions = {},
): Promise<SourceConversionResult> {
  if (options.signal?.aborted) {
    throw abortError(options.signal);
  }

  const worker = new Worker(SOURCE_CONVERSION_WORKER_SOURCE, {
    eval: true,
    workerData: request,
  });
  const timeoutMs = options.timeoutMs ?? SOURCE_IMPORT_CONVERSION_WORKER_TIMEOUT_MS;

  return await new Promise<SourceConversionResult>((resolve, reject) => {
    let settled = false;
    const timeout = timers.setTimeout(() => {
      settle(reject, new Error(`KB source import ${request.kind} conversion worker timed out after ${timeoutMs}ms`));
      void worker.terminate();
    }, timeoutMs);

    const onAbort = (): void => {
      const signal = options.signal;
      if (signal === undefined) {
        return;
      }
      settle(reject, abortError(signal));
      void worker.terminate();
    };

    function cleanup(): void {
      timers.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
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

    options.signal?.addEventListener('abort', onAbort, { once: true });

    worker.once('message', (message: unknown) => {
      if (!isWorkerReply(message)) {
        settle(reject, new Error(`KB source import ${request.kind} conversion worker returned an invalid response`));
        void worker.terminate();
        return;
      }
      if (!message.ok) {
        settle(reject, workerFailureToError(message));
        void worker.terminate();
        return;
      }
      settle(resolve, message.result);
      void worker.terminate();
    });

    worker.once('error', (error) => {
      settle(reject, error);
    });

    worker.once('exit', (code) => {
      if (code !== 0) {
        settle(reject, new Error(`KB source import ${request.kind} conversion worker exited with code ${code}`));
      }
    });
  });
}
