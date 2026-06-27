import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import process, { env as processEnv } from 'node:process';
import type * as ClaudePty from '@lydell/node-pty';

import {
  CLAUDE_BROKER_BUSY_RPC_CODE,
  type BrokerShutdownResult,
  buildJsonRpcFailure,
  buildJsonRpcFailureFromError,
  buildJsonRpcSuccess,
  isAutoAllowPermissionMode,
  parseJsonRpcInboundLine,
  requireSessionCloseParams,
  requireSessionEnsureParams,
  requireSessionProbeParams,
  requireTurnInterruptParams,
  requireTurnStartParams,
} from './protocol.js';
import type { JsonRpcRequest } from '../../../infra/json-rpc.js';
import { buildClaudeChildEnv } from './child-env.js';
import { createBrokerSession } from './broker-pool.js';
import { PrintSessionController } from './print-controller.js';
import { resolveClaudeTransportMode } from '../transport-mode.js';
import type {
  ClaudeBrokerChild,
  ClaudeBrokerSession,
  ClaudePrintChild,
  ControlRequestTimer,
  PrintSpawnChild,
  SpawnClaudeChildOptions,
  SpawnClaudePrintChildOptions,
} from './session-contract.js';

interface CreateClaudeBrokerServerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  env?: Readonly<Record<string, string | undefined>>;
  exit?: (code: number) => never | void;
  session?: ClaudeBrokerSession;
}

interface ClaudeBrokerServer {
  start(): void;
}

const realControlRequestTimer = {
  schedule(callback: () => void, delayMs: number): unknown {
    return globalThis.setTimeout(callback, delayMs);
  },
  cancel(handle: unknown): void {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
} satisfies ControlRequestTimer;

export function createClaudeBrokerServer(options: CreateClaudeBrokerServerOptions = {}): ClaudeBrokerServer {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const env = options.env ?? processEnv;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const session = options.session ?? createDefaultBrokerSession(errorOutput, env);

  let shutdownRequested = false;

  function send(message: unknown): void {
    output.write(`${JSON.stringify(message)}\n`);
  }

  session.subscribeNotifications((notification) => {
    send(notification);
  });

  void session.closed.then((result) => {
    if (shutdownRequested) {
      return;
    }
    if (result instanceof Error) {
      errorOutput.write(`${result.message}\n`);
      exit(1);
    }
  });

  async function dispatchRequest(message: JsonRpcRequest<unknown>): Promise<void> {
    if (message.id === null || message.id === undefined) {
      return;
    }
    if (shutdownRequested && message.method !== 'broker/shutdown') {
      send(buildJsonRpcFailure(message.id, CLAUDE_BROKER_BUSY_RPC_CODE, 'Claude broker is shutting down.'));
      return;
    }

    try {
      switch (message.method) {
        case 'session/ensure':
          send(
            buildJsonRpcSuccess(message.id, await session.sessionEnsure(requireSessionEnsureParams(message.params))),
          );
          return;
        case 'session/probe':
          send(buildJsonRpcSuccess(message.id, await session.sessionProbe(requireSessionProbeParams(message.params))));
          return;
        case 'session/close':
          send(buildJsonRpcSuccess(message.id, await session.sessionClose(requireSessionCloseParams(message.params))));
          return;
        case 'turn/start':
          send(buildJsonRpcSuccess(message.id, await session.turnStart(requireTurnStartParams(message.params))));
          return;
        case 'turn/interrupt':
          send(
            buildJsonRpcSuccess(message.id, await session.turnInterrupt(requireTurnInterruptParams(message.params))),
          );
          return;
        case 'broker/shutdown': {
          shutdownRequested = true;
          await session.shutdown();
          send(buildJsonRpcSuccess(message.id, { ok: true } satisfies BrokerShutdownResult));
          exit(0);
          return;
        }
        default:
          send(buildJsonRpcFailure(message.id, -32601, `Unsupported broker method: ${message.method}`));
      }
    } catch (error) {
      send(buildJsonRpcFailureFromError(message.id, error));
    }
  }

  return {
    start(): void {
      if ('setEncoding' in input && typeof input.setEncoding === 'function') {
        input.setEncoding('utf8');
      }

      const reader = createInterface({ input });
      reader.on('line', (line: string) => {
        if (!line.trim()) {
          return;
        }

        let message: ReturnType<typeof parseJsonRpcInboundLine>;
        try {
          message = parseJsonRpcInboundLine(line);
        } catch (error) {
          send(buildJsonRpcFailureFromError(null, error));
          return;
        }

        if (!('id' in message)) {
          return;
        }

        void dispatchRequest(message);
      });
    },
  };
}

function createDefaultBrokerSession(
  errorOutput: NodeJS.WritableStream,
  env: Readonly<Record<string, string | undefined>>,
): ClaudeBrokerSession {
  const mode = resolveClaudeTransportMode(env);
  if (mode === 'tui') {
    return createBrokerSession({
      spawnChild: createNodeClaudeChildFactory(errorOutput),
      ids: { uuid: () => randomUUID() },
    });
  }

  return createBrokerSession<PrintSpawnChild>({
    spawnChild: createNodeClaudePrintChildFactory(errorOutput),
    ids: { uuid: () => randomUUID() },
    createController: (controllerOptions) =>
      new PrintSessionController({ ...controllerOptions, now: Date.now, controlRequestTimer: realControlRequestTimer }),
  });
}

type ClaudePtyModule = typeof ClaudePty;

// Load the native PTY backend lazily (not at module import) so the appserver
// process starts even where no prebuilt binary exists; the failure then becomes
// a clear per-turn provider error instead of a cryptic startup crash.
let ptyModulePromise: Promise<ClaudePtyModule> | null = null;
function loadClaudePtyModule(): Promise<ClaudePtyModule> {
  return (ptyModulePromise ??= import('@lydell/node-pty'));
}

export function createNodeClaudeChildFactory(
  _errorOutput: NodeJS.WritableStream = process.stderr,
  loadPty: () => Promise<ClaudePtyModule> = loadClaudePtyModule,
): (options: SpawnClaudeChildOptions) => Promise<ClaudeBrokerChild> {
  return async (options: SpawnClaudeChildOptions): Promise<ClaudeBrokerChild> => {
    let pty: ClaudePtyModule;
    try {
      pty = await loadPty();
    } catch (error) {
      // No prebuilt PTY binary on this platform (e.g. musl/Alpine or 32-bit
      // ARM). Surface an actionable provider error rather than crash.
      throw new Error(
        `Claude provider unavailable: could not load its PTY backend (@lydell/node-pty) on ${process.platform}/${process.arch}. ` +
          'No prebuilt native binary is available for this platform — use the Codex provider here. ' +
          `(${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
    const child = pty.spawn('claude', buildClaudeChildArgs(options), {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: options.cwd || undefined,
      env: buildClaudeChildEnv(options.env),
    });

    const exitHandlers = new Set<
      (event: { code: number | null; signal: NodeJS.Signals | string | number | null; error?: Error }) => void
    >();
    const dataHandlers = new Set<(chunk: string) => void>();

    let exitEmitted = false;
    const subscriptions: Array<{ dispose(): void }> = [];
    function emitExit(event: {
      code: number | null;
      signal: NodeJS.Signals | string | number | null;
      error?: Error;
    }): void {
      if (exitEmitted) {
        return;
      }
      exitEmitted = true;
      for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
      }
      for (const handler of exitHandlers) {
        handler(event);
      }
    }

    subscriptions.push(
      child.onData((text) => {
        for (const handler of dataHandlers) {
          handler(text);
        }
      }),
    );

    subscriptions.push(
      child.onExit((event) => {
        emitExit({ code: event.exitCode, signal: event.signal ?? null });
      }),
    );

    return {
      write(data: string): void {
        child.write(data);
      },
      kill(signal?: NodeJS.Signals): void {
        child.kill(signal);
      },
      onData(handler: (chunk: string) => void): () => void {
        dataHandlers.add(handler);
        return () => {
          dataHandlers.delete(handler);
        };
      },
      onExit(
        handler: (event: {
          code: number | null;
          signal: NodeJS.Signals | string | number | null;
          error?: Error;
        }) => void,
      ): () => void {
        exitHandlers.add(handler);
        return () => {
          exitHandlers.delete(handler);
        };
      },
    };
  };
}

export function createNodeClaudePrintChildFactory(
  errorOutput: NodeJS.WritableStream = process.stderr,
): (options: SpawnClaudePrintChildOptions) => ClaudePrintChild {
  return (options: SpawnClaudePrintChildOptions): ClaudePrintChild => {
    const child = spawn('claude', buildClaudePrintChildArgs(options), {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd || undefined,
      shell: process.platform === 'win32',
      env: buildClaudeChildEnv(options.env),
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error('Claude child stdio is unavailable.');
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const stdoutHandlers = new Set<(line: string) => void>();
    const exitHandlers = new Set<
      (event: { code: number | null; signal: NodeJS.Signals | string | number | null; error?: Error }) => void
    >();
    const stderrHandlers = new Set<(chunk: string) => void>();
    const stdoutReader = createInterface({ input: child.stdout });

    let exitEmitted = false;
    function emitExit(event: {
      code: number | null;
      signal: NodeJS.Signals | string | number | null;
      error?: Error;
    }): void {
      if (exitEmitted) {
        return;
      }
      exitEmitted = true;
      stdoutReader.close();
      for (const handler of exitHandlers) {
        handler(event);
      }
    }

    stdoutReader.on('line', (line: string) => {
      for (const handler of stdoutHandlers) {
        handler(line);
      }
    });

    child.stderr.on('data', (chunk: string | Buffer) => {
      const text = chunk.toString();
      errorOutput.write(text);
      for (const handler of stderrHandlers) {
        handler(text);
      }
    });

    child.on('error', (error: Error) => {
      emitExit({ code: null, signal: null, error });
    });

    child.on('close', (code, signal) => {
      emitExit({ code, signal });
    });

    return {
      writeLine(line: string): void {
        if (child.stdin.destroyed) {
          throw new Error('Claude child stdin is unavailable.');
        }
        child.stdin.write(line);
      },
      kill(signal?: NodeJS.Signals): void {
        child.kill(signal);
      },
      onStdoutLine(handler: (line: string) => void): () => void {
        stdoutHandlers.add(handler);
        return () => {
          stdoutHandlers.delete(handler);
        };
      },
      onExit(
        handler: (event: {
          code: number | null;
          signal: NodeJS.Signals | string | number | null;
          error?: Error;
        }) => void,
      ): () => void {
        exitHandlers.add(handler);
        return () => {
          exitHandlers.delete(handler);
        };
      },
      onStderrChunk(handler: (chunk: string) => void): () => void {
        stderrHandlers.add(handler);
        return () => {
          stderrHandlers.delete(handler);
        };
      },
    };
  };
}

export function buildClaudeChildArgs(options: SpawnClaudeChildOptions): string[] {
  const args: string[] = [];
  if (options.resume) {
    args.push('--resume', options.conversationRef);
  } else {
    args.push('--session-id', options.conversationRef);
  }
  if (options.systemPrompt) {
    args.push('--append-system-prompt', options.systemPrompt);
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (isAutoAllowPermissionMode(options.permissionMode)) {
    args.push('--dangerously-skip-permissions');
  } else if (options.permissionMode !== 'default') {
    args.push('--permission-mode', options.permissionMode);
  }
  return args;
}

export function buildClaudePrintChildArgs(options: SpawnClaudePrintChildOptions): string[] {
  const args = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (options.conversationRef !== undefined) {
    args.push('--resume', options.conversationRef);
  }
  if (options.systemPrompt) {
    args.push('--append-system-prompt', options.systemPrompt);
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (isAutoAllowPermissionMode(options.permissionMode)) {
    args.push('--dangerously-skip-permissions');
  } else if (options.permissionMode !== 'default') {
    args.push('--permission-mode', options.permissionMode);
  }
  return args;
}

function main(): void {
  createClaudeBrokerServer().start();
}

if (isDirectExecution(process.argv[1])) {
  main();
}

function isDirectExecution(entry: string | undefined): boolean {
  if (!entry) {
    return false;
  }

  const name = basename(entry);
  return name === 'server.ts' || name === 'server.js' || name === 'coral-claude-appserver.cjs';
}
