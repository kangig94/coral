import { createInterface, type Interface } from 'node:readline';
import { backendLog } from '../../infra/backend-log.js';
import { buildJsonRpcError } from '../../infra/json-rpc.js';
import type { ChildProcessLike, Runtime } from '../../runtime/ports.js';
import { appendBuffer, gracefulKill, requirePipedHandles } from './process-supervision.js';

export type ProviderServerNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type ProviderServerPendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type ProviderServerRpc = {
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
  readline: Interface;
  stderr: string;
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
  initializeRequest?: {
    method: string;
    params: Record<string, unknown>;
  };
};

export type SpawnProviderServerFn = (options: SpawnProviderServerOptions) => Promise<ProviderServerHandle>;

export async function spawnProviderServerTransport(params: {
  runtime: Runtime;
  options: SpawnProviderServerOptions;
  generation: number;
}): Promise<ProviderServerHandle> {
  const { runtime, options, generation } = params;
  const child = runtime.process.spawn({
    command: options.command,
    args: options.args,
    cwd: options.cwd === '' ? undefined : options.cwd,
    shell: runtime.env.platform() === 'win32',
    envAdditions: options.extraEnv,
  });
  const { stdin, stdout: childStdout, stderr: childStderr } = requirePipedHandles(child, options.command);

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`Failed to spawn ${options.command}: child pid is unavailable`);
  }

  childStdout.setEncoding('utf8');
  childStderr.setEncoding('utf8');

  let resolveClose!: (outcome: Error | void) => void;
  const closePromise = new Promise<Error | void>((resolve) => {
    resolveClose = resolve;
  });

  const entry: ProviderServerEntry = {
    provider: options.provider,
    child,
    pid,
    generation,
    pending: new Map(),
    nextRequestId: 1,
    notificationHandlers: new Set(),
    readline: createInterface({ input: childStdout as unknown as NodeJS.ReadableStream }),
    stderr: '',
    closed: false,
    closeRequested: false,
    closePromise,
    resolveClose,
    closeOutcome: undefined,
  };

  const finalizeClose = (outcome?: Error): void => {
    if (outcome) {
      entry.closeOutcome = outcome;
    }
    detachProviderServer(entry, outcome);
    entry.resolveClose(entry.closeRequested ? undefined : entry.closeOutcome);
  };

  entry.readline.on('line', (line: string) => {
    handleProviderServerLine(entry, line, runtime);
  });

  childStderr.on('data', (chunk: string | Buffer) => {
    entry.stderr = appendBuffer(entry.stderr, chunk.toString());
  });

  stdin.on('error', (error: Error) => {
    if (entry.closed) return;
    const stdinError = createProviderServerError(entry.provider, `stdin error: ${error.message}`, {
      stderr: entry.stderr,
    });
    backendLog.error(stdinError.message, error);
    detachProviderServer(entry, stdinError);
    gracefulKill(child, runtime);
  });

  child.on('error', (error: Error) => {
    const closeError = createProviderServerError(options.provider, `failed: ${error.message}`, {
      stderr: entry.stderr,
    });
    if (!entry.closeRequested) {
      backendLog.error(`Provider server ${options.provider} failed`, error);
    }
    detachProviderServer(entry, closeError);
    entry.resolveClose(entry.closeRequested ? undefined : closeError);
  });

  child.on('close', (code, signal) => {
    let closeError: Error | undefined;
    if (!entry.closeRequested) {
      const detail = signal ? `exited unexpectedly (signal ${signal})` : `exited unexpectedly (exit ${code})`;
      closeError = createProviderServerError(options.provider, detail, { stderr: entry.stderr });
      if (code !== 0 || signal !== null) {
        backendLog.error(closeError.message);
      }
    }
    finalizeClose(closeError);
  });

  const rpc: ProviderServerRpc = {
    request: <TResult = unknown>(method: string, params: Record<string, unknown> = {}): Promise<TResult> => {
      if (entry.closed) {
        return Promise.reject(createProviderServerError(entry.provider, 'is closed', { stderr: entry.stderr }));
      }

      const id = entry.nextRequestId;
      entry.nextRequestId += 1;

      return new Promise<TResult>((resolve, reject) => {
        entry.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
        try {
          sendProviderServerMessage(entry, { id, method, params });
        } catch (error) {
          entry.pending.delete(id);
          reject(
            error instanceof Error ? error : createProviderServerError(entry.provider, `failed to send ${method}`),
          );
        }
      });
    },
    notify: (method: string, params: Record<string, unknown> = {}): void => {
      if (entry.closed) return;
      try {
        sendProviderServerMessage(entry, { method, params });
      } catch (error) {
        const notifyError =
          error instanceof Error ? error : createProviderServerError(entry.provider, `failed to send ${method}`);
        backendLog.error(notifyError.message, error);
        detachProviderServer(entry, notifyError);
        gracefulKill(entry.child, runtime);
      }
    },
  };

  if (options.initializeRequest) {
    await rpc.request(options.initializeRequest.method, options.initializeRequest.params);
  }

  return {
    pid,
    child,
    generation,
    rpc,
    onNotification: (handler: (message: ProviderServerNotification) => void): (() => void) => {
      if (entry.closed) return () => {};
      entry.notificationHandlers.add(handler);
      return () => {
        entry.notificationHandlers.delete(handler);
      };
    },
    closePromise,
    markExpectedClose: () => {
      entry.closeRequested = true;
    },
    close: async () => {
      shutdownProviderServer(entry, 'closed', runtime);
      await entry.closePromise;
    },
  };
}

function createProviderServerError(
  provider: string,
  detail: string,
  extra?: { stderr?: string; rpcCode?: number; data?: unknown },
): Error {
  const stderr = extra?.stderr?.trim();
  const suffix = stderr ? `: ${stderr}` : '';
  const error = new Error(`Provider server ${provider} ${detail}${suffix}`) as Error & {
    rpcCode?: number;
    data?: unknown;
  };
  if (extra?.rpcCode !== undefined) error.rpcCode = extra.rpcCode;
  if (extra?.data !== undefined) error.data = extra.data;
  return error;
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
  rejectPendingProviderRequests(
    entry,
    error ?? createProviderServerError(entry.provider, 'closed', { stderr: entry.stderr }),
  );
  entry.readline.close();
}

function encodeProviderServerMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function sendProviderServerMessage(entry: ProviderServerEntry, message: unknown): void {
  const stdin = entry.child.stdin;
  if (entry.closed || !stdin || stdin.destroyed) {
    throw createProviderServerError(entry.provider, 'stdin is not available', { stderr: entry.stderr });
  }
  stdin.write(encodeProviderServerMessage(message));
}

function handleProviderServerLine(entry: ProviderServerEntry, line: string, runtime: Runtime): void {
  if (!line.trim() || entry.closed) return;

  let message: {
    id?: number;
    method?: string;
    result?: unknown;
    error?: { code?: number; message?: string; data?: unknown };
    params?: Record<string, unknown>;
  };
  try {
    message = JSON.parse(line) as typeof message;
  } catch (error) {
    const parseError = createProviderServerError(entry.provider, 'emitted invalid JSONL', {
      stderr: entry.stderr,
      data: { line, message: error instanceof Error ? error.message : String(error) },
    });
    backendLog.error(parseError.message, error);
    detachProviderServer(entry, parseError);
    gracefulKill(entry.child, runtime);
    return;
  }

  if (typeof message.id === 'number' && typeof message.method === 'string') {
    try {
      sendProviderServerMessage(entry, {
        id: message.id,
        error: buildJsonRpcError(-32601, `Unsupported provider-server request: ${message.method}`),
      });
    } catch (error) {
      const protocolError =
        error instanceof Error ? error : createProviderServerError(entry.provider, 'failed to answer server request');
      backendLog.error(protocolError.message, error);
      detachProviderServer(entry, protocolError);
      gracefulKill(entry.child, runtime);
    }
    return;
  }

  if (typeof message.id === 'number') {
    const pending = entry.pending.get(message.id);
    if (!pending) return;
    entry.pending.delete(message.id);

    if (message.error) {
      pending.reject(
        createProviderServerError(entry.provider, `${pending.method} failed`, {
          stderr: entry.stderr,
          rpcCode: message.error.code,
          data: message.error.data,
        }),
      );
      return;
    }

    pending.resolve(message.result);
    return;
  }

  if (typeof message.method !== 'string') {
    const protocolError = createProviderServerError(entry.provider, 'emitted a malformed JSON-RPC message', {
      stderr: entry.stderr,
      data: message,
    });
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
    handler(notification);
  }
}

function beginProviderServerShutdown(entry: ProviderServerEntry, detail: string): void {
  if (entry.closed) return;
  entry.closeRequested = true;
  detachProviderServer(entry, createProviderServerError(entry.provider, detail, { stderr: entry.stderr }));
}

function shutdownProviderServer(entry: ProviderServerEntry, detail: string, runtime: Runtime): void {
  beginProviderServerShutdown(entry, detail);
  gracefulKill(entry.child, runtime);
}
