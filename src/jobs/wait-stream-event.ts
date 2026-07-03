import { z } from 'zod';

import { jobContinuitySnapshotSchema } from './continuity.js';
import { jobProgressTimingSchema } from './event-bodies.js';
import { jobTerminalSchema } from './terminal/result.js';
import type { WaitStreamEvent } from './wait.js';

const KNOWN_WAIT_STREAM_EVENT_TYPES = new Set<string>(['progress', 'queued', 'terminal', 'waiting']);

const waitProgressEventSchema = z
  .object({
    type: z.literal('progress'),
    jobId: z.string(),
    seq: z.number().int().nonnegative(),
    message: z.string(),
    timing: jobProgressTimingSchema,
  })
  .strict();

const waitQueuedEventSchema = z
  .object({
    type: z.literal('queued'),
    jobId: z.string(),
    sessionId: z.string(),
    queuePosition: z.number(),
    runningJobIds: z.array(z.string()),
    timing: jobProgressTimingSchema,
  })
  .strict();

const waitTerminalEventSchema = z
  .object({
    type: z.literal('terminal'),
    jobId: z.string(),
    seq: z.number().int().nonnegative(),
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
