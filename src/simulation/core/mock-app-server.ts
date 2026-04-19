import type { ThreadStartResponse, TurnStartResponse } from '../../providers/codex/protocol.js';
import type { MockSpawnScript } from './mock-process.js';
import { MockStdin } from './mock-process.js';

type JsonRpcRequest = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type JsonRpcNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export type MockAppServerScript = {
  threadStart?: {
    response: Partial<ThreadStartResponse>;
    delayMs?: number;
  };
  turnCreate?: {
    events: Array<{ type: string; data: unknown; delayMs?: number }>;
    result: { content: string };
    delayMs?: number;
  };
  shutdown?: {
    delayMs?: number;
  };
};

function toParams(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { data: value };
}

function encodeJsonLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function mergeThreadStartResponse(
  script: MockAppServerScript,
  threadId: string,
  turnId: string | null = null,
): ThreadStartResponse {
  const response = script.threadStart?.response;
  return {
    thread: {
      ...(response?.thread ?? {}),
      id: typeof response?.thread?.id === 'string' ? response.thread.id : threadId,
    },
    ...(response?.turn
      ? {
          turn: {
            ...(response.turn ?? {}),
            id: typeof response.turn.id === 'string' ? response.turn.id : (turnId ?? 'mock-turn-0'),
          },
        }
      : {}),
  };
}

function buildTurnStartResponse(turnId: string): TurnStartResponse {
  return {
    turn: {
      id: turnId,
      status: 'inProgress',
    },
  };
}

function buildDefaultTurnStarted(threadId: string, turnId: string): JsonRpcNotification {
  return {
    method: 'turn/started',
    params: {
      threadId,
      turn: {
        id: turnId,
        status: 'inProgress',
      },
    },
  };
}

function buildDefaultAgentMessage(threadId: string, content: string): JsonRpcNotification {
  return {
    method: 'item/completed',
    params: {
      threadId,
      item: {
        type: 'agentMessage',
        text: content,
        phase: 'final_answer',
        status: 'completed',
      },
    },
  };
}

function buildDefaultTurnCompleted(threadId: string, turnId: string): JsonRpcNotification {
  return {
    method: 'turn/completed',
    params: {
      threadId,
      turn: {
        id: turnId,
        status: 'completed',
      },
    },
  };
}

function buildInterruptedTurnCompleted(threadId: string, turnId: string): JsonRpcNotification {
  return {
    method: 'turn/completed',
    params: {
      threadId,
      turn: {
        id: turnId,
        status: 'interrupted',
      },
    },
  };
}

function buildEventNotification(
  event: { type: string; data: unknown },
  defaults: { threadId: string; turnId: string },
): JsonRpcNotification {
  const params = toParams(event.data);
  if (!params) {
    return { method: event.type };
  }

  if ((event.type.startsWith('turn/') || event.type.startsWith('item/')) && params.threadId === undefined) {
    params.threadId = defaults.threadId;
  }
  if (event.type.startsWith('turn/') && params.turnId === undefined && params.turn === undefined) {
    params.turn = { id: defaults.turnId };
  }

  return {
    method: event.type,
    params,
  };
}

function buildJsonRpcError(code: number, message: string): { code: number; message: string } {
  return { code, message };
}

export function createMockAppServerSpawnScript(script: MockAppServerScript): MockSpawnScript {
  return {
    close: null,
    onSpawn: ({ child, schedule, close }) => {
      const stdin = child.stdin;
      if (!(stdin instanceof MockStdin)) {
        throw new Error('Mock app-server requires piped stdin');
      }

      let nextThreadId = 1;
      let nextTurnId = 1;
      let currentThreadId = `mock-thread-${nextThreadId}`;
      let activeTurn: { threadId: string; turnId: string; completed: boolean } | null = null;
      let buffer = '';

      const emit = (message: unknown): void => {
        child.pushStdout(encodeJsonLine(message));
      };

      const scheduleEmit = (delayMs: number | undefined, message: unknown): void => {
        schedule(delayMs ?? 0, () => {
          emit(message);
        });
      };

      const handleTurnStart = (id: unknown, params: Record<string, unknown>, mode: 'start' | 'create'): void => {
        const requestedThreadId =
          typeof params.threadId === 'string'
            ? params.threadId
            : currentThreadId;
        const turnId = `mock-turn-${nextTurnId++}`;
        activeTurn = { threadId: requestedThreadId, turnId, completed: false };

        const responseDelay = script.turnCreate?.delayMs ?? 0;
        scheduleEmit(responseDelay, {
          id,
          result:
            mode === 'create'
              ? { content: script.turnCreate?.result.content ?? '' }
              : buildTurnStartResponse(turnId),
        });

        const scriptedEvents = script.turnCreate?.events ?? [];
        const scriptedTypes = new Set(scriptedEvents.map((event) => event.type));
        if (!scriptedTypes.has('turn/started')) {
          scheduleEmit(responseDelay, buildDefaultTurnStarted(requestedThreadId, turnId));
        }

        for (const event of scriptedEvents) {
          scheduleEmit(
            responseDelay + (event.delayMs ?? 0),
            buildEventNotification(event, {
              threadId: requestedThreadId,
              turnId,
            }),
          );
        }

        const completionDelay =
          responseDelay + scriptedEvents.reduce((max, event) => Math.max(max, event.delayMs ?? 0), 0);
        if (!scriptedTypes.has('item/completed')) {
          schedule(completionDelay, () => {
            if (activeTurn?.turnId === turnId && activeTurn.completed) {
              return;
            }
            emit(buildDefaultAgentMessage(requestedThreadId, script.turnCreate?.result.content ?? ''));
          });
        }
        if (!scriptedTypes.has('turn/completed')) {
          schedule(completionDelay, () => {
            if (activeTurn?.turnId === turnId && activeTurn.completed) {
              return;
            }
            if (activeTurn?.turnId === turnId) {
              activeTurn.completed = true;
            }
            emit(buildDefaultTurnCompleted(requestedThreadId, turnId));
          });
        }
      };

      const handleShutdown = (id: unknown): void => {
        const delayMs = script.shutdown?.delayMs ?? 0;
        scheduleEmit(0, {
          id,
          result: {},
        });
        schedule(delayMs, () => {
          close({ code: 0, signal: null });
        });
      };

      const handleRequest = (request: JsonRpcRequest): void => {
        const method = typeof request.method === 'string' ? request.method : null;
        if (!method) {
          if (request.id !== undefined) {
            emit({
              id: request.id,
              error: buildJsonRpcError(-32600, 'Invalid JSON-RPC request'),
            });
          }
          return;
        }

        const params = toParams(request.params) ?? {};
        switch (method) {
          case 'initialize':
            emit({
              id: request.id,
              result: { ready: true },
            });
            return;
          case 'thread/start': {
            currentThreadId = typeof params.cwd === 'string' ? `mock-thread-${nextThreadId++}` : currentThreadId;
            const response = mergeThreadStartResponse(script, currentThreadId);
            currentThreadId = response.thread.id;
            scheduleEmit(script.threadStart?.delayMs, {
              id: request.id,
              result: response,
            });
            scheduleEmit(script.threadStart?.delayMs, {
              method: 'thread/started',
              params: {
                threadId: currentThreadId,
                thread: response.thread,
              },
            });
            return;
          }
          case 'thread/resume': {
            const threadId = typeof params.threadId === 'string' ? params.threadId : currentThreadId;
            currentThreadId = threadId;
            scheduleEmit(script.threadStart?.delayMs, {
              id: request.id,
              result: {
                thread: mergeThreadStartResponse(script, threadId).thread,
              },
            });
            return;
          }
          case 'turn/start':
            handleTurnStart(request.id, params, 'start');
            return;
          case 'turn/create':
            handleTurnStart(request.id, params, 'create');
            return;
          case 'turn/interrupt':
            emit({
              id: request.id,
              result: {
                threadId: params.threadId ?? currentThreadId,
                turnId: params.turnId ?? activeTurn?.turnId ?? null,
              },
            });
            if (
              activeTurn &&
              !activeTurn.completed &&
              (params.turnId === undefined || params.turnId === activeTurn.turnId)
            ) {
              activeTurn.completed = true;
              scheduleEmit(0, buildInterruptedTurnCompleted(activeTurn.threadId, activeTurn.turnId));
            }
            return;
          case 'thread/shutdown':
            handleShutdown(request.id);
            return;
          default:
            if (request.id !== undefined) {
              emit({
                id: request.id,
                error: buildJsonRpcError(-32601, `Unsupported mock app-server method: ${method}`),
              });
            }
        }
      };

      stdin.on('write', (chunk: string) => {
        buffer += chunk;
        while (true) {
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex < 0) {
            return;
          }
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.trim()) {
            continue;
          }
          handleRequest(JSON.parse(line) as JsonRpcRequest);
        }
      });
    },
  };
}
