import { z } from 'zod';
import { jobContinuitySnapshotSchema, jobTerminalSchema } from '../jobs/views.js';
import type { WaitStreamEvent } from '../jobs/wait.js';

export const HEALTH_TIMEOUT_MS = 3_000;
export const TOOL_TIMEOUT_MS = 300_000;
export const MAX_WAIT_FETCH_TIMEOUT_MS = 30 * 60 * 1000;
export const WAIT_FETCH_MARGIN_MS = 30_000;

export type SseEventBlock = {
  event?: string;
  data: string;
  id?: string;
};

const KNOWN_WAIT_STREAM_EVENT_TYPES = new Set<string>(['progress', 'queued', 'terminal', 'waiting']);

const waitProgressEventSchema = z
  .object({
    type: z.literal('progress'),
    jobId: z.string(),
    eventId: z.number().int(),
    message: z.string(),
  })
  .strict();

const waitQueuedEventSchema = z
  .object({
    type: z.literal('queued'),
    jobId: z.string(),
    sessionId: z.string(),
    queuePosition: z.number(),
    runningJobIds: z.array(z.string()),
  })
  .strict();

const waitTerminalEventSchema = z
  .object({
    type: z.literal('terminal'),
    jobId: z.string(),
    remainingJobIds: z.array(z.string()),
    resultPath: z.string(),
    result: jobTerminalSchema,
    continuity: jobContinuitySnapshotSchema.nullable().optional(),
  })
  .strict();

const waitWaitingEventSchema = z
  .object({
    type: z.literal('waiting'),
    waitingJobIds: z.array(z.string()),
  })
  .strict();

export const waitStreamEventSchema = z.discriminatedUnion('type', [
  waitProgressEventSchema,
  waitQueuedEventSchema,
  waitTerminalEventSchema,
  waitWaitingEventSchema,
]);

export function parseWaitStreamEvent(eventType: string | undefined, rawData: string): WaitStreamEvent | null {
  if (!eventType || !KNOWN_WAIT_STREAM_EVENT_TYPES.has(eventType)) {
    return null;
  }

  const parsed: unknown = JSON.parse(rawData);
  const event = waitStreamEventSchema.parse(parsed);
  if (event.type !== eventType) {
    throw new Error(`Invalid wait stream event payload for ${eventType}`);
  }
  return event;
}

export function parseSseBlock(block: string): SseEventBlock | null {
  if (!block.trim()) return null;

  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;

    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';

    switch (field) {
      case 'event':
        event = value;
        break;
      case 'data':
        data.push(value);
        break;
      case 'id':
        id = value;
        break;
    }
  }

  if (data.length === 0) return null;
  return { event, data: data.join('\n'), id };
}

export function describeHttpError(status: number, statusText: string): string {
  if (status === 503) return 'Backend shutting down, retry';
  if (status === 401) return 'Backend auth failure - stale token';
  return `Backend request failed: ${status} ${statusText}`;
}

export async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
