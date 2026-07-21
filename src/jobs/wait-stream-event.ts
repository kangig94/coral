import { z } from 'zod';

import { continuitySnapshotSchema } from '../sessions/continuity.js';
import { jobProgressTimingSchema } from './event-bodies.js';
import { jobTerminalSchema } from './terminal/result.js';
import { usageSummarySchema } from '../providers/contract.js';
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

const waitQueuedEventBaseSchema = z.object({
  type: z.literal('queued'),
  jobId: z.string(),
  queuePosition: z.number(),
  runningJobIds: z.array(z.string()),
  timing: jobProgressTimingSchema,
});

const waitQueuedProviderEventSchema = waitQueuedEventBaseSchema
  .extend({
    jobKind: z.literal('provider'),
    sessionId: z.string().min(1),
  })
  .strict();

const waitQueuedWorkflowEventSchema = waitQueuedEventBaseSchema
  .extend({
    jobKind: z.literal('workflow'),
    workflowId: z.string().min(1),
  })
  .strict();

const waitQueuedKbEventSchema = waitQueuedEventBaseSchema
  .extend({
    jobKind: z.literal('kb'),
    systemTaskId: z.string().min(1),
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
    continuity: continuitySnapshotSchema.nullable().optional(),
    usage: usageSummarySchema.optional(),
  })
  .strict();

const waitWaitingEventSchema = z
  .object({
    type: z.literal('waiting'),
    waitingJobIds: z.array(z.string()),
  })
  .strict();

const waitStreamEventSchema = z.union([
  waitProgressEventSchema,
  waitQueuedProviderEventSchema,
  waitQueuedWorkflowEventSchema,
  waitQueuedKbEventSchema,
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
