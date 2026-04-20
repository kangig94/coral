import { z } from 'zod';

import { type ProviderTurnOutcomeCompat, legacyTerminalOutcomeSchema } from '../shared/legacy-terminal-outcome-compat.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ProviderProgressEventBody {
  type: 'launch.progress';
  message: string;
  ts: string;
}

export type ProviderAction = 'exec' | 'resume' | 'fork';

export interface ProviderInstruction {
  content: string;
  channel: 'prompt' | 'system';
}

export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export const usageSummarySchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    costUsd: z.number().optional(),
  })
  .strict();

export interface ProviderRequest {
  action: ProviderAction;
  sessionId: string;
  name?: string;
  conversationRef?: string;
  prompt: string;
  model?: string;
  cwd: string;
  effort?: EffortLevel;
  bypassPermissions: boolean;
  systemPrompt?: string;
  coralEnv: Record<string, string>;
  instruction?: ProviderInstruction;
}

export interface ProviderTerminalEventBody {
  type: 'launch.terminal';
  content: string;
  conversationRef?: string;
  model?: string;
  durationMs?: number;
  nonResumable?: boolean;
  exitCode?: number | null;
  warnings?: string[];
  usage?: UsageSummary;
  outcome: ProviderTurnOutcomeCompat;
}

export type ProviderEventBody = ProviderProgressEventBody | ProviderTerminalEventBody;

export const providerProgressEventSchema = z
  .object({
    type: z.literal('launch.progress'),
    message: z.string(),
    ts: z.string(),
  })
  .strict();

export const providerTerminalEventSchema = z
  .object({
    type: z.literal('launch.terminal'),
    content: z.string(),
    conversationRef: z.string().optional(),
    model: z.string().optional(),
    durationMs: z.number().optional(),
    nonResumable: z.boolean().optional(),
    exitCode: z.number().nullable().optional(),
    warnings: z.array(z.string()).optional(),
    usage: usageSummarySchema.optional(),
    outcome: legacyTerminalOutcomeSchema,
  })
  .strict();

export const providerEventBodySchema = z.discriminatedUnion('type', [
  providerProgressEventSchema,
  providerTerminalEventSchema,
]);

export function providerProgressEvent(message: string, ts: string): ProviderProgressEventBody {
  return {
    type: 'launch.progress',
    message,
    ts,
  };
}

export function providerTerminalEvent(
  result: Omit<ProviderTerminalEventBody, 'type'>,
): ProviderTerminalEventBody {
  return {
    type: 'launch.terminal',
    ...result,
  };
}

export function streamProviderTerminal(
  terminal:
    | Omit<ProviderTerminalEventBody, 'type'>
    | Promise<Omit<ProviderTerminalEventBody, 'type'>>,
): AsyncIterable<ProviderEventBody> {
  return streamProviderEvents(async (emit) => {
    emit(providerTerminalEvent(await terminal));
  });
}

export function streamProviderTerminalEvent(
  terminal: ProviderTerminalEventBody | Promise<ProviderTerminalEventBody>,
): AsyncIterable<ProviderEventBody> {
  return streamProviderEvents(async (emit) => {
    emit(await terminal);
  });
}

export async function collectProviderEvents(stream: AsyncIterable<ProviderEventBody>): Promise<ProviderEventBody[]> {
  const events: ProviderEventBody[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

export async function collectProviderTerminalEvent(
  stream: AsyncIterable<ProviderEventBody>,
): Promise<ProviderTerminalEventBody> {
  let terminal: ProviderTerminalEventBody | null = null;

  for await (const event of stream) {
    if (event.type !== 'launch.terminal') {
      continue;
    }
    if (terminal) {
      throw new Error('Provider stream emitted multiple launch.terminal events.');
    }
    terminal = event;
  }

  if (!terminal) {
    throw new Error('Provider stream ended without a launch.terminal event.');
  }

  return terminal;
}

type ProviderEventQueueEntry =
  | { kind: 'event'; event: ProviderEventBody }
  | { kind: 'done' }
  | { kind: 'error'; error: unknown };

export function streamProviderEvents(
  producer: (emit: (event: ProviderEventBody) => void) => Promise<void> | void,
): AsyncIterable<ProviderEventBody> {
  const queue: ProviderEventQueueEntry[] = [];
  let waiter:
    | {
        resolve: (entry: ProviderEventQueueEntry) => void;
        reject: (error: unknown) => void;
      }
    | null = null;
  let closed = false;

  const dispatch = (entry: ProviderEventQueueEntry): void => {
    if (waiter) {
      const pending = waiter;
      waiter = null;
      if (entry.kind === 'error') {
        pending.reject(entry.error);
        return;
      }
      pending.resolve(entry);
      return;
    }
    queue.push(entry);
  };

  const emit = (event: ProviderEventBody): void => {
    if (closed) {
      return;
    }
    dispatch({ kind: 'event', event });
  };

  const finish = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    dispatch({ kind: 'done' });
  };

  const fail = (error: unknown): void => {
    if (closed) {
      return;
    }
    closed = true;
    dispatch({ kind: 'error', error });
  };

  void Promise.resolve()
    .then(() => producer(emit))
    .then(() => {
      finish();
    })
    .catch((error: unknown) => {
      fail(error);
    });

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<ProviderEventBody> {
      while (true) {
        const entry =
          queue.shift() ??
          (await new Promise<ProviderEventQueueEntry>((resolve, reject) => {
            waiter = { resolve, reject };
          }));
        if (entry.kind === 'event') {
          yield entry.event;
          continue;
        }
        if (entry.kind === 'done') {
          return;
        }
        throw (entry.error instanceof Error ? entry.error : new Error(String(entry.error)));
      }
    },
  };
}
