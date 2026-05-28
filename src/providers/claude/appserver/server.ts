import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import process from 'node:process';
import { spawn as spawnPty } from 'node-pty';

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
import type { ClaudeBrokerChild, ClaudeBrokerSession, SpawnClaudeChildOptions } from './session-contract.js';

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

export function createNodeClaudeChildFactory(
  _errorOutput: NodeJS.WritableStream = process.stderr,
): (options: SpawnClaudeChildOptions) => ClaudeBrokerChild {
  return (options: SpawnClaudeChildOptions): ClaudeBrokerChild => {
    const child = spawnPty('claude', buildClaudeChildArgs(options), {
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
