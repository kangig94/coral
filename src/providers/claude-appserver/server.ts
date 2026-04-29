import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import process from 'node:process';

import {
  CLAUDE_BROKER_BUSY_RPC_CODE,
  type BrokerShutdownResult,
  buildJsonRpcFailure,
  buildJsonRpcFailureFromError,
  buildJsonRpcSuccess,
  isAutoAllowPermissionMode,
  parseJsonRpcInboundLine,
  type JsonRpcRequest,
  requireSessionEnsureParams,
  requireSessionProbeParams,
  requireTurnInterruptParams,
  requireTurnStartParams,
} from './protocol.js';
import {
  buildClaudeChildEnv,
  type ClaudeBrokerChild,
  type SpawnClaudeChildOptions,
} from './controller.js';
import { createBrokerSession, type ClaudeBrokerSession } from './broker-pool.js';

interface CreateClaudeBrokerServerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  exit?: (code: number) => never | void;
  session?: ClaudeBrokerSession;
}

interface ClaudeBrokerServer {
  start(): void;
}

export function createClaudeBrokerServer(options: CreateClaudeBrokerServerOptions = {}): ClaudeBrokerServer {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const session =
    options.session ??
    createBrokerSession({
      spawnChild: createNodeClaudeChildFactory(errorOutput),
      ids: { uuid: () => randomUUID() },
    });

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
          send(buildJsonRpcSuccess(message.id, await session.sessionEnsure(requireSessionEnsureParams(message.params))));
          return;
        case 'session/probe':
          send(buildJsonRpcSuccess(message.id, await session.sessionProbe(requireSessionProbeParams(message.params))));
          return;
        case 'turn/start':
          send(buildJsonRpcSuccess(message.id, await session.turnStart(requireTurnStartParams(message.params))));
          return;
        case 'turn/interrupt':
          send(buildJsonRpcSuccess(message.id, await session.turnInterrupt(requireTurnInterruptParams(message.params))));
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

export function createNodeClaudeChildFactory(
  errorOutput: NodeJS.WritableStream = process.stderr,
): (options: SpawnClaudeChildOptions) => ClaudeBrokerChild {
  return (options: SpawnClaudeChildOptions): ClaudeBrokerChild => {
    const child = spawn('claude', buildClaudeChildArgs(options), {
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
    const exitHandlers = new Set<(event: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void>();
    const stderrHandlers = new Set<(chunk: string) => void>();
    const stdoutReader = createInterface({ input: child.stdout });

    let exitEmitted = false;
    function emitExit(event: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void {
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
      onExit(handler: (event: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void): () => void {
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
  const args = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (options.conversationRef) {
    args.push('--resume', options.conversationRef);
  }
  if (options.systemPrompt) {
    args.push('--append-system-prompt', options.systemPrompt);
  }
  if (isAutoAllowPermissionMode(options.permissionMode)) {
    args.push('--dangerously-skip-permissions');
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
