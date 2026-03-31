#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import process from 'node:process';

import { isRecord } from '../../shared/mcp-utils.js';
import {
  buildJsonRpcError,
  ClaudeBrokerRpcError,
  type BrokerShutdownResult,
  type JsonRpcId,
  type JsonRpcRequest,
  type SessionEnsureParams,
  type SessionProbeParams,
  type TurnInterruptParams,
  type TurnStartParams,
} from './protocol.js';
import {
  buildClaudeChildEnv,
  createBrokerSession,
  type ClaudeBrokerChild,
  type ClaudeBrokerSession,
  type SpawnClaudeChildOptions,
} from './session.js';

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
    });

  let shutdownRequested = false;

  function send(message: unknown): void {
    output.write(`${JSON.stringify(message)}\n`);
  }

  function sendSuccess(id: JsonRpcId, result: unknown): void {
    send({ id, result });
  }

  function sendFailure(id: JsonRpcId, error: unknown): void {
    if (error instanceof ClaudeBrokerRpcError) {
      send({
        id,
        error: buildJsonRpcError(error.code, error.message, error.data),
      });
      return;
    }

    const message = error instanceof Error ? error.message : 'Claude broker request failed.';
    send({
      id,
      error: buildJsonRpcError(-32000, message),
    });
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

    try {
      switch (message.method) {
        case 'session/ensure':
          sendSuccess(message.id, await session.sessionEnsure(requireSessionEnsureParams(message.params)));
          return;
        case 'session/probe':
          sendSuccess(message.id, await session.sessionProbe(requireSessionProbeParams(message.params)));
          return;
        case 'turn/start':
          sendSuccess(message.id, await session.turnStart(requireTurnStartParams(message.params)));
          return;
        case 'turn/interrupt':
          sendSuccess(message.id, await session.turnInterrupt(requireTurnInterruptParams(message.params)));
          return;
        case 'broker/shutdown': {
          shutdownRequested = true;
          await session.shutdown();
          sendSuccess(message.id, { ok: true } satisfies BrokerShutdownResult);
          exit(0);
          return;
        }
        default:
          send({
            id: message.id,
            error: buildJsonRpcError(-32601, `Unsupported broker method: ${message.method}`),
          });
      }
    } catch (error) {
      sendFailure(message.id, error);
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

        let message: JsonRpcRequest<unknown>;
        try {
          message = JSON.parse(line) as JsonRpcRequest<unknown>;
        } catch (error) {
          send({
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${(error as Error).message}`),
          });
          return;
        }

        if (!isRecord(message) || typeof message.method !== 'string') {
          send({
            id: null,
            error: buildJsonRpcError(-32600, 'Invalid JSON-RPC request.'),
          });
          return;
        }

        if (message.id === undefined) {
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
  if (bypassesPermissions(options.permissionMode)) {
    args.push('--dangerously-skip-permissions');
  }
  return args;
}

function requireSessionEnsureParams(params: unknown): SessionEnsureParams {
  if (
    !isRecord(params) ||
    typeof params.cwd !== 'string' ||
    typeof params.systemPromptHash !== 'string' ||
    typeof params.permissionMode !== 'string'
  ) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/ensure.');
  }

  return {
    cwd: params.cwd,
    systemPromptHash: params.systemPromptHash,
    permissionMode: params.permissionMode,
    brokerSessionKey: typeof params.brokerSessionKey === 'string' ? params.brokerSessionKey : undefined,
    conversationRef: typeof params.conversationRef === 'string' ? params.conversationRef : undefined,
    controllerEnv: readControllerEnv(params.controllerEnv),
    systemPrompt: typeof params.systemPrompt === 'string' ? params.systemPrompt : undefined,
  };
}

function requireSessionProbeParams(params: unknown): SessionProbeParams {
  if (!isRecord(params) || typeof params.brokerSessionKey !== 'string') {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/probe.');
  }
  return {
    brokerSessionKey: params.brokerSessionKey,
    conversationRef: typeof params.conversationRef === 'string' ? params.conversationRef : undefined,
  };
}

function requireTurnStartParams(params: unknown): TurnStartParams {
  if (
    !isRecord(params) ||
    typeof params.brokerSessionKey !== 'string' ||
    typeof params.brokerTurnId !== 'string' ||
    typeof params.prompt !== 'string'
  ) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for turn/start.');
  }

  return {
    brokerSessionKey: params.brokerSessionKey,
    brokerTurnId: params.brokerTurnId,
    prompt: params.prompt,
    model: typeof params.model === 'string' ? params.model : undefined,
    maxThinkingTokens:
      typeof params.maxThinkingTokens === 'number' || params.maxThinkingTokens === null
        ? params.maxThinkingTokens
        : undefined,
  };
}

function requireTurnInterruptParams(params: unknown): TurnInterruptParams {
  if (!isRecord(params) || typeof params.brokerSessionKey !== 'string') {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for turn/interrupt.');
  }
  return {
    brokerSessionKey: params.brokerSessionKey,
    brokerTurnId: typeof params.brokerTurnId === 'string' ? params.brokerTurnId : undefined,
  };
}

function readControllerEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/ensure.');
  }

  const entries = Object.entries(value);
  if (entries.some(([, entryValue]) => typeof entryValue !== 'string')) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/ensure.');
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function bypassesPermissions(permissionMode: string): boolean {
  return permissionMode === 'bypass' || permissionMode === 'bypassPermissions' || permissionMode === 'dontAsk';
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
