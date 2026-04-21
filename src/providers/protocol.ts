import { z } from 'zod';

import { type ProviderTurnOutcomeCompat, legacyTerminalOutcomeSchema } from '../shared/legacy-terminal-outcome-compat.js';
import { streamProviderEvents as streamProviderEventsBase } from './stream.js';

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
    | ProviderTerminalEventBody
    | Omit<ProviderTerminalEventBody, 'type'>
    | Promise<ProviderTerminalEventBody | Omit<ProviderTerminalEventBody, 'type'>>,
): AsyncIterable<ProviderEventBody> {
  return streamProviderEvents(async (emit) => {
    const resolved = await terminal;
    emit('type' in resolved && resolved.type === 'launch.terminal' ? resolved : providerTerminalEvent(resolved));
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

export { ProviderEventBackpressureError, QUEUE_CAP } from './stream.js';

export function streamProviderEvents(
  producer: (emit: (event: ProviderEventBody) => void) => Promise<void> | void,
): AsyncIterable<ProviderEventBody> {
  return streamProviderEventsBase(producer);
}
