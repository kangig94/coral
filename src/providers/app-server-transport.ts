import { backendLog } from '../infra/backend-log.js';
import { errorMessage } from '../infra/error-format.js';
import { buildJsonRpcError } from '../infra/json-rpc.js';
import { MAX_BUFFER } from '../infra/process-constants.js';
import { shouldUseWindowsCommandShell } from '../infra/windows-shell.js';
import type { ChildProcessLike } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import { AbortError } from '../runtime/abort.js';
import { gracefulKill, requirePipedHandles } from '../infra/process-supervision.js';
import {
  appendProviderHostLog,
  createProviderHostDiagnostics,
  currentProviderHostLogSeq,
  inspectProviderHostDiagnostics,
  recordProviderResponseDiagnostic,
  type ProviderHostDiagnosticsSnapshot,
  type ProviderHostDiagnosticsState,
  type ProviderHostLogCursorSpan,
  type ProviderResponseObservationSink as HostResponseObservationSink,
} from './host-diagnostics.js';

export type ProviderResponseObservationSink = HostResponseObservationSink;

export const PROVIDER_SERVER_MAX_JSONL_LINE_BYTES = MAX_BUFFER;
export const PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS = 30_000;

class ProviderServerLineTooLargeError extends Error {
  readonly code = 'provider_server_line_too_large';
  readonly maxLineBytes: number;
  readonly observedBytes: number;

  constructor(observedBytes: number, maxLineBytes = PROVIDER_SERVER_MAX_JSONL_LINE_BYTES) {
    super(`Provider server JSONL line exceeded ${maxLineBytes} bytes (observed ${observedBytes}).`);
    this.name = 'ProviderServerLineTooLargeError';
    this.maxLineBytes = maxLineBytes;
    this.observedBytes = observedBytes;
    Object.setPrototypeOf(this, ProviderServerLineTooLargeError.prototype);
  }
}

export type ProviderHostDiagnosticReference = Readonly<{
  generation: number;
  inspect: () => ProviderHostDiagnosticsSnapshot;
}>;

export class ProviderRpcError extends Error {
  readonly requestId: number;
  readonly method: string;
  readonly rpcCode: number | undefined;
  readonly providerMessage: string | undefined;
  readonly providerData: unknown;
  readonly hostLog: ProviderHostLogCursorSpan;

  constructor(params: {
    requestId: number;
    method: string;
    rpcCode: number | undefined;
    providerMessage: string | undefined;
    providerData: unknown;
    hostLog: ProviderHostLogCursorSpan;
  }) {
    super(renderProviderRpcErrorMessage(params));
    this.name = 'ProviderRpcError';
    this.requestId = params.requestId;
    this.method = params.method;
    this.rpcCode = params.rpcCode;
    this.providerMessage = params.providerMessage;
    this.providerData = params.providerData;
    this.hostLog = Object.freeze({ ...params.hostLog });
    Object.setPrototypeOf(this, ProviderRpcError.prototype);
  }
}

export class ProviderHostFault extends Error {
  readonly provider: string;
  readonly detail: string;
  readonly data: unknown;
  readonly diagnosticRef: ProviderHostDiagnosticReference;

  constructor(provider: string, detail: string, diagnosticRef: ProviderHostDiagnosticReference, data?: unknown) {
    super(`Provider server ${provider} ${detail}`);
    this.name = 'ProviderHostFault';
    this.provider = provider;
    this.detail = detail;
    this.data = data;
    this.diagnosticRef = diagnosticRef;
    Object.setPrototypeOf(this, ProviderHostFault.prototype);
  }
}

type ProviderServerNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type ProviderServerMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  params?: Record<string, unknown>;
};

type ProviderServerPendingRequest = {
  method: string;
  startSeq: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ProviderServerRpc = {
  request: <TResult = unknown>(method: string, params?: Record<string, unknown>) => Promise<TResult>;
  notify: (method: string, params?: Record<string, unknown>) => void;
};

export type ProviderServerHandle = {
  pid: number;
  child: ChildProcessLike;
  generation: number;
  rpc: ProviderServerRpc;
  onNotification: (handler: (message: ProviderServerNotification) => void) => () => void;
  closePromise: Promise<Error | void>;
  isClosed(): boolean;
  inspectDiagnostics: () => ProviderHostDiagnosticsSnapshot;
  markExpectedClose: () => void;
  close: () => Promise<void>;
};

type ProviderServerEntry = {
  provider: string;
  child: ChildProcessLike;
  pid: number;
  generation: number;
  pending: Map<number, ProviderServerPendingRequest>;
  nextRequestId: number;
  notificationHandlers: Set<(message: ProviderServerNotification) => void>;
  stdoutBuffer: string;
  stdoutBufferBytes: number;
  diagnostics: ProviderHostDiagnosticsState;
  diagnosticRef: ProviderHostDiagnosticReference;
  observeProviderResponse: ProviderResponseObservationSink;
  closed: boolean;
  closeRequested: boolean;
  closePromise: Promise<Error | void>;
  resolveClose: (outcome: Error | void) => void;
  closeOutcome: Error | void;
};

export type SpawnProviderServerOptions = {
  provider: string;
  command: string;
  args: string[];
  cwd?: string;
  extraEnv?: Record<string, string>;
  exactEnv?: Record<string, string>;
  signal?: AbortSignal;
  initializeRequest?: {
    method: string;
    params: Record<string, unknown>;
  };
  initializeTimeoutMs?: number;
};

export type SpawnProviderServerFn = (
  options: SpawnProviderServerOptions,
  observeProviderResponse: ProviderResponseObservationSink,
  generation: number,
) => Promise<ProviderServerHandle>;

function resolveProviderServerInitializeTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS;
}

export async function spawnProviderServerTransport(params: {
  runtime: Runtime;
  options: SpawnProviderServerOptions;
  generation: number;
  observeProviderResponse: ProviderResponseObservationSink;
}): Promise<ProviderServerHandle> {
  const spawned = spawnProviderServerProcess(params);
  bindProviderServerEvents(spawned.entry, spawned.pipes, params.runtime);
  const rpc = createProviderServerRpc(spawned.entry, params.runtime);
  await initializeSpawnedProviderServer(spawned.entry, rpc, params.options, params.runtime);
  return exposeProviderServerHandle(spawned.entry, rpc, params.runtime);
}

type ProviderServerPipes = ReturnType<typeof requirePipedHandles>;

function spawnProviderServerProcess(params: {
  runtime: Runtime;
  options: SpawnProviderServerOptions;
  generation: number;
  observeProviderResponse: ProviderResponseObservationSink;
}): Readonly<{ entry: ProviderServerEntry; pipes: ProviderServerPipes }> {
  const { runtime, options, generation, observeProviderResponse } = params;
  if (options.signal?.aborted) {
    throw createProviderServerSpawnAbortError(options.provider, options.signal);
  }

  const command = options.command;
  const child = runtime.process.spawn({
    command,
    args: options.args,
    cwd: options.cwd === '' ? undefined : options.cwd,
    shell: shouldUseWindowsCommandShell(command, runtime.env.platform()),
    ...(options.exactEnv ? { env: options.exactEnv } : { envAdditions: options.extraEnv }),
  });
  const pipes = requirePipedHandles(child, options.command);
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`Failed to spawn ${options.command}: child pid is unavailable`);
  }
  pipes.stdout.setEncoding('utf8');
  pipes.stderr.setEncoding('utf8');

  let resolveClose!: (outcome: Error | void) => void;
  const closePromise = new Promise<Error | void>((resolve) => {
    resolveClose = resolve;
  });
  const diagnostics = createProviderHostDiagnostics();
  const entry: ProviderServerEntry = {
    provider: options.provider,
    child,
    pid,
    generation,
    pending: new Map(),
    nextRequestId: 1,
    notificationHandlers: new Set(),
    stdoutBuffer: '',
    stdoutBufferBytes: 0,
    diagnostics,
    diagnosticRef: createProviderHostDiagnosticReference(generation, diagnostics),
    observeProviderResponse,
    closed: false,
    closeRequested: false,
    closePromise,
    resolveClose,
    closeOutcome: undefined,
  };
  return Object.freeze({ entry, pipes });
}

function bindProviderServerEvents(entry: ProviderServerEntry, pipes: ProviderServerPipes, runtime: Runtime): void {
  const finalizeClose = (outcome?: Error): void => {
    if (outcome) entry.closeOutcome = outcome;
    detachProviderServer(entry, outcome);
    entry.resolveClose(entry.closeRequested ? undefined : entry.closeOutcome);
  };

  pipes.stdout.on('data', (chunk: string | Buffer) => {
    handleProviderServerStdout(entry, chunk, runtime);
  });
  pipes.stderr.on('data', (chunk: string | Buffer) => {
    appendProviderHostLog(entry.diagnostics, {
      observedAt: runtime.time.now(),
      stream: 'stderr',
      text: chunk.toString(),
    });
  });
  pipes.stdin.on('error', (error: Error) => {
    if (entry.closed) return;
    const stdinError = createProviderHostFault(entry, `stdin error: ${error.message}`);
    backendLog.error(stdinError.message, error);
    detachProviderServer(entry, stdinError);
    gracefulKill(entry.child, runtime);
  });
  entry.child.on('error', (error: Error) => {
    const closeError = createProviderHostFault(entry, `failed: ${error.message}`);
    if (!entry.closeRequested) backendLog.error(`Provider server ${entry.provider} failed`, error);
    detachProviderServer(entry, closeError);
    entry.resolveClose(entry.closeRequested ? undefined : closeError);
  });
  entry.child.on('close', (code, signal) => {
    if (entry.closed) {
      entry.resolveClose(entry.closeRequested ? undefined : entry.closeOutcome);
      return;
    }

    let closeError: Error | undefined;
    if (!entry.closeRequested) {
      const detail = signal ? `exited unexpectedly (signal ${signal})` : `exited unexpectedly (exit ${code})`;
      closeError = createProviderHostFault(entry, detail);
      if (code !== 0 || signal !== null) backendLog.error(closeError.message);
    }
    finalizeClose(closeError);
  });
}

function createProviderServerRpc(entry: ProviderServerEntry, runtime: Runtime): ProviderServerRpc {
  return {
    request: <TResult = unknown>(method: string, params: Record<string, unknown> = {}): Promise<TResult> => {
      if (entry.closed) return Promise.reject(createProviderHostFault(entry, 'is closed'));
      const id = entry.nextRequestId;
      entry.nextRequestId += 1;

      return new Promise<TResult>((resolve, reject) => {
        const startSeq = currentProviderHostLogSeq(entry.diagnostics);
        entry.pending.set(id, { method, startSeq, resolve: resolve as (value: unknown) => void, reject });
        try {
          sendProviderServerMessage(entry, { id, method, params });
        } catch (error) {
          entry.pending.delete(id);
          reject(error instanceof Error ? error : createProviderHostFault(entry, `failed to send ${method}`));
        }
      });
    },
    notify: (method: string, params: Record<string, unknown> = {}): void => {
      if (entry.closed) return;
      try {
        sendProviderServerMessage(entry, { method, params });
      } catch (error) {
        const notifyError = error instanceof Error ? error : createProviderHostFault(entry, `failed to send ${method}`);
        backendLog.error(notifyError.message, error);
        detachProviderServer(entry, notifyError);
        gracefulKill(entry.child, runtime);
      }
    },
  };
}

async function initializeSpawnedProviderServer(
  entry: ProviderServerEntry,
  rpc: ProviderServerRpc,
  options: SpawnProviderServerOptions,
  runtime: Runtime,
): Promise<void> {
  if (options.initializeRequest === undefined) return;
  try {
    await initializeProviderServer({
      entry,
      rpc,
      request: options.initializeRequest,
      timeoutMs: options.initializeTimeoutMs,
      runtime,
      signal: options.signal,
    });
  } catch (error) {
    // The child is alive but rejected `initialize` (protocol/version/auth mismatch). Nothing upstream owns this
    // handle yet, so kill and detach it here before rethrowing — otherwise the OS process leaks per failure.
    const initError = error instanceof Error ? error : createProviderHostFault(entry, `initialize failed`);
    detachProviderServer(entry, initError);
    gracefulKill(entry.child, runtime);
    throw initError;
  }
}

function exposeProviderServerHandle(
  entry: ProviderServerEntry,
  rpc: ProviderServerRpc,
  runtime: Runtime,
): ProviderServerHandle {
  return {
    pid: entry.pid,
    child: entry.child,
    generation: entry.generation,
    rpc,
    onNotification: (handler) => {
      if (entry.closed) return () => {};
      entry.notificationHandlers.add(handler);
      return () => {
        entry.notificationHandlers.delete(handler);
      };
    },
    closePromise: entry.closePromise,
    isClosed: () => entry.closed,
    inspectDiagnostics: entry.diagnosticRef.inspect,
    markExpectedClose: () => {
      entry.closeRequested = true;
    },
    close: async () => {
      shutdownProviderServer(entry, 'closed', runtime);
      await entry.closePromise;
    },
  };
}

function initializeProviderServer(params: {
  entry: ProviderServerEntry;
  rpc: ProviderServerRpc;
  request: NonNullable<SpawnProviderServerOptions['initializeRequest']>;
  timeoutMs?: number;
  runtime: Runtime;
  signal?: AbortSignal;
}): Promise<unknown> {
  const { entry, rpc, request, runtime, signal } = params;
  const timeoutMs = resolveProviderServerInitializeTimeoutMs(params.timeoutMs);
  if (signal?.aborted) {
    return Promise.reject(createProviderServerInitializeAbortError(entry, signal));
  }

  let timeoutHandle: ReturnType<Runtime['time']['setTimeout']> | null = null;
  let abortHandler: (() => void) | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = runtime.time.setTimeout(() => {
      reject(createProviderHostFault(entry, `initialize timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  const abort =
    signal === undefined
      ? null
      : new Promise<never>((_, reject) => {
          abortHandler = () => reject(createProviderServerInitializeAbortError(entry, signal));
          signal.addEventListener('abort', abortHandler, { once: true });
        });

  return Promise.race([rpc.request(request.method, request.params), timeout, ...(abort ? [abort] : [])]).finally(() => {
    if (timeoutHandle !== null) {
      runtime.time.clearTimeout(timeoutHandle);
    }
    if (abortHandler !== null && signal !== undefined) {
      signal.removeEventListener('abort', abortHandler);
    }
  });
}

function createProviderServerSpawnAbortError(provider: string, signal: AbortSignal): Error {
  return new AbortError({ stage: `provider ${provider} spawn`, reason: signal.reason });
}

function createProviderServerInitializeAbortError(entry: ProviderServerEntry, signal: AbortSignal): Error {
  // Canonical abort vocabulary (src/runtime/abort.ts) — preserves signal.reason
  // so callers can distinguish a user abort from a deadline abort. Constructing
  // the error locally is forbidden by the architecture-boundary invariant.
  const reason = signal.reason;
  return new AbortError({ stage: `provider ${entry.provider} initialize`, reason });
}

function renderProviderRpcErrorMessage(params: {
  method: string;
  rpcCode: number | undefined;
  providerMessage: string | undefined;
  providerData: unknown;
}): string {
  const code = params.rpcCode === undefined ? '' : ` [code=${params.rpcCode}]`;
  const cause = params.providerMessage === undefined ? '' : `: ${params.providerMessage}`;
  const data = params.providerData === undefined ? '' : `; data=${JSON.stringify(params.providerData)}`;
  return `${params.method} failed${code}${cause}${data}`;
}

function createProviderHostDiagnosticReference(
  generation: number,
  diagnostics: ProviderHostDiagnosticsState,
): ProviderHostDiagnosticReference {
  return Object.freeze({
    generation,
    inspect: () => inspectProviderHostDiagnostics(diagnostics),
  });
}

function createProviderHostFault(entry: ProviderServerEntry, detail: string, data?: unknown): ProviderHostFault {
  return new ProviderHostFault(entry.provider, detail, entry.diagnosticRef, data);
}

function rejectPendingProviderRequests(entry: ProviderServerEntry, error: Error): void {
  for (const pending of entry.pending.values()) {
    pending.reject(error);
  }
  entry.pending.clear();
}

function detachProviderServer(entry: ProviderServerEntry, error?: Error): void {
  if (entry.closed) return;
  entry.closed = true;
  if (error) {
    entry.closeOutcome = error;
  }
  entry.notificationHandlers.clear();
  rejectPendingProviderRequests(entry, error ?? createProviderHostFault(entry, 'closed'));
}

function encodeProviderServerMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function sendProviderServerMessage(entry: ProviderServerEntry, message: unknown): void {
  const stdin = entry.child.stdin;
  if (entry.closed || !stdin || stdin.destroyed) {
    throw createProviderHostFault(entry, 'stdin is not available');
  }
  const encoded = encodeProviderServerMessage(message);
  try {
    stdin.write(encoded);
  } catch (error) {
    throw createProviderHostFault(entry, `stdin error: ${errorMessage(error)}`);
  }
}

function handleProviderServerStdout(entry: ProviderServerEntry, chunk: string | Buffer, runtime: Runtime): void {
  if (entry.closed) return;

  const text = chunk.toString();
  let start = 0;
  while (start < text.length) {
    const newlineIndex = text.indexOf('\n', start);
    if (newlineIndex === -1) {
      appendProviderServerLineFragment(entry, text.slice(start), runtime);
      return;
    }

    const fragmentEnd =
      newlineIndex > start && text.charCodeAt(newlineIndex - 1) === 13 ? newlineIndex - 1 : newlineIndex;
    if (!appendProviderServerLineFragment(entry, text.slice(start, fragmentEnd), runtime)) {
      return;
    }

    const line = entry.stdoutBuffer;
    entry.stdoutBuffer = '';
    entry.stdoutBufferBytes = 0;
    handleProviderServerLine(entry, line, runtime);
    if (entry.closed) return;
    start = newlineIndex + 1;
  }
}

function appendProviderServerLineFragment(entry: ProviderServerEntry, fragment: string, runtime: Runtime): boolean {
  if (fragment.length === 0) {
    return true;
  }

  const fragmentBytes = Buffer.byteLength(fragment, 'utf8');
  const observedBytes = entry.stdoutBufferBytes + fragmentBytes;
  if (observedBytes > PROVIDER_SERVER_MAX_JSONL_LINE_BYTES) {
    const lineError = new ProviderServerLineTooLargeError(observedBytes);
    const protocolError = createProviderHostFault(entry, 'emitted an oversized JSONL line', {
      code: lineError.code,
      maxLineBytes: lineError.maxLineBytes,
      observedBytes: lineError.observedBytes,
    });
    backendLog.error(protocolError.message, lineError);
    entry.stdoutBuffer = '';
    entry.stdoutBufferBytes = 0;
    detachProviderServer(entry, protocolError);
    gracefulKill(entry.child, runtime);
    return false;
  }

  entry.stdoutBuffer += fragment;
  entry.stdoutBufferBytes = observedBytes;
  return true;
}

function handleProviderServerLine(entry: ProviderServerEntry, line: string, runtime: Runtime): void {
  if (!line.trim() || entry.closed) return;

  const message = parseProviderServerLine(entry, line, runtime);
  if (message === undefined) return;

  if (typeof message.id === 'number' && typeof message.method === 'string') {
    handleProviderServerRequest(entry, message.id, message.method, runtime);
  } else if (typeof message.id === 'number') {
    handleProviderServerResponse(entry, message.id, message);
  } else {
    handleProviderServerNotification(entry, message, runtime);
  }
}

function parseProviderServerLine(
  entry: ProviderServerEntry,
  line: string,
  runtime: Runtime,
): ProviderServerMessage | undefined {
  try {
    return JSON.parse(line) as ProviderServerMessage;
  } catch (error) {
    const parseError = createProviderHostFault(entry, 'emitted invalid JSONL', {
      line,
      message: errorMessage(error),
    });
    backendLog.error(parseError.message, error);
    detachProviderServer(entry, parseError);
    gracefulKill(entry.child, runtime);
    return undefined;
  }
}

function handleProviderServerRequest(
  entry: ProviderServerEntry,
  requestId: number,
  method: string,
  runtime: Runtime,
): void {
  try {
    sendProviderServerMessage(entry, {
      id: requestId,
      error: buildJsonRpcError(-32601, `Unsupported provider-server request: ${method}`),
    });
  } catch (error) {
    const protocolError =
      error instanceof Error ? error : createProviderHostFault(entry, 'failed to answer server request');
    backendLog.error(protocolError.message, error);
    detachProviderServer(entry, protocolError);
    gracefulKill(entry.child, runtime);
  }
}

function handleProviderServerResponse(
  entry: ProviderServerEntry,
  requestId: number,
  message: ProviderServerMessage,
): void {
  const endSeq = currentProviderHostLogSeq(entry.diagnostics);
  const pending = entry.pending.get(requestId);
  if (!pending) return;
  const diagnostic = recordProviderResponseDiagnostic(entry.diagnostics, {
    generation: entry.generation,
    requestId,
    method: pending.method,
    response: message.error
      ? Object.freeze({
          kind: 'failure',
          rpcCode: message.error.code,
          providerMessage: message.error.message,
          providerData: message.error.data,
        })
      : Object.freeze({ kind: 'success' }),
    startSeq: pending.startSeq,
    endSeq,
  });
  entry.observeProviderResponse(diagnostic);
  entry.pending.delete(requestId);

  if (message.error) {
    pending.reject(
      new ProviderRpcError({
        requestId,
        method: pending.method,
        rpcCode: message.error.code,
        providerMessage: message.error.message,
        providerData: message.error.data,
        hostLog: diagnostic.hostLog,
      }),
    );
    return;
  }

  pending.resolve(message.result);
}

function handleProviderServerNotification(
  entry: ProviderServerEntry,
  message: ProviderServerMessage,
  runtime: Runtime,
): void {
  if (typeof message.method !== 'string') {
    const protocolError = createProviderHostFault(entry, 'emitted a malformed JSON-RPC message', message);
    backendLog.error(protocolError.message);
    detachProviderServer(entry, protocolError);
    gracefulKill(entry.child, runtime);
    return;
  }

  const notification: ProviderServerNotification = {
    method: message.method,
    params: message.params,
  };
  for (const handler of entry.notificationHandlers) {
    try {
      handler(notification);
    } catch (error) {
      const dispatchError = createProviderHostFault(entry, `notification handler failed: ${errorMessage(error)}`);
      backendLog.error(dispatchError.message, error);
      if (!entry.closed) {
        detachProviderServer(entry, dispatchError);
        gracefulKill(entry.child, runtime);
      }
      return;
    }
  }
}

function beginProviderServerShutdown(entry: ProviderServerEntry, detail: string): void {
  if (entry.closed) return;
  entry.closeRequested = true;
  detachProviderServer(entry, createProviderHostFault(entry, detail));
}

function shutdownProviderServer(entry: ProviderServerEntry, detail: string, runtime: Runtime): void {
  beginProviderServerShutdown(entry, detail);
  gracefulKill(entry.child, runtime);
}
