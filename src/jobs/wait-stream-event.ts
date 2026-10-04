import { decodeWaitCursor } from './wait-cursor.js';
import { z } from 'zod';

import { isRecord } from '../infra/json.js';
import { continuitySnapshotSchema } from '../sessions/continuity.js';
import { jobPhaseSchema } from './phase.js';
import { jobProgressTimingSchema } from './event-bodies.js';
import { jobTerminalSchema } from './terminal/result.js';
import { usageSummarySchema } from '../providers/contract.js';
import { type WaitCursor, type WaitHandoverNotice, type WaitStreamEvent } from './wait.js';

const KNOWN_WAIT_STREAM_EVENT_TYPES = new Set<string>(['progress', 'queued', 'terminal', 'interrupted', 'waiting']);
const waitCursorV2Schema = z.custom<Extract<WaitCursor, { version: 'jobs.wait.v2' }>>((value) => {
  const decoded = decodeWaitCursor(value);
  return decoded.kind === 'decoded' && decoded.cursor.version === 'jobs.wait.v2';
});

export const MAX_WAIT_JOB_IDS = 128;

export type WaitRenderDecision = Readonly<{
  cursor: WaitCursor;
  shouldRender: boolean;
}>;

export function advanceWaitRenderCursor(cursor: WaitCursor, event: WaitStreamEvent): WaitRenderDecision {
  if (event.type === 'progress' || event.type === 'terminal') {
    if (event.epochKey !== undefined && event.cursor !== undefined) {
      const previous = cursor.version === 'jobs.wait.v2' ? (cursor.positions[event.epochKey] ?? 0) : 0;
      if (
        event.type === 'terminal' &&
        cursor.version === 'jobs.wait.v2' &&
        cursor.deliveredJobIds?.includes(event.jobId)
      )
        return { cursor, shouldRender: false };
      if (event.type === 'progress' && event.seq <= previous) return { cursor, shouldRender: false };
      return {
        cursor: {
          version: 'jobs.wait.v2',
          locations: { ...event.cursor.locations },
          deliveredJobIds: [...new Set([...(cursor.deliveredJobIds ?? []), ...(event.cursor.deliveredJobIds ?? [])])],
          positions: Object.fromEntries(
            Object.entries(event.cursor.positions).map(([key, seq]) => [
              key,
              Math.max(seq, cursor.version === 'jobs.wait.v2' ? (cursor.positions[key] ?? 0) : 0),
            ]),
          ),
        },
        shouldRender: true,
      };
    }

    const legacy = cursor.version === 'jobs.wait.v2' ? legacyRenderCursor(cursor.deliveredJobIds) : cursor;
    if (event.seq <= legacy.afterSeq || (event.type === 'terminal' && legacy.deliveredJobIds?.includes(event.jobId))) {
      return { cursor: legacy, shouldRender: false };
    }
    return { cursor: { ...legacy, afterSeq: event.seq }, shouldRender: true };
  }

  return { cursor: 'cursor' in event && event.cursor ? event.cursor : cursor, shouldRender: true };
}

function legacyRenderCursor(deliveredJobIds: readonly string[] | undefined): Extract<WaitCursor, { afterSeq: number }> {
  return deliveredJobIds === undefined || deliveredJobIds.length === 0
    ? { afterSeq: 0 }
    : { afterSeq: 0, deliveredJobIds: [...deliveredJobIds] };
}

// Every variant below but `interrupted` is `.passthrough()`, not `.strict()`: a coordinator newer than
// this build may add an optional field to any of them, and tolerating that one unknown key is what lets
// this build keep decoding the event instead of `.parse` throwing partway through the wait stream.
const waitProgressEventSchema = z
  .object({
    type: z.literal('progress'),
    jobId: z.string(),
    seq: z.number().int().nonnegative(),
    message: z.string(),
    timing: jobProgressTimingSchema,
    version: z.literal('jobs.wait.v2').optional(),
    epochKey: z.string().min(1).optional(),
    cursor: waitCursorV2Schema.optional(),
  })
  .passthrough();

const waitQueuedEventBaseSchema = z.object({
  type: z.literal('queued'),
  jobId: z.string().min(1),
  queuePosition: z.number(),
  runningJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS),
  timing: jobProgressTimingSchema,
  cursor: waitCursorV2Schema.optional(),
});

const waitQueuedProviderEventSchema = waitQueuedEventBaseSchema
  .extend({
    jobKind: z.literal('provider'),
    sessionId: z.string().min(1),
  })
  .passthrough();

const waitQueuedWorkflowEventSchema = waitQueuedEventBaseSchema
  .extend({
    jobKind: z.literal('workflow'),
    workflowId: z.string().min(1),
  })
  .passthrough();

const waitQueuedKbEventSchema = waitQueuedEventBaseSchema
  .extend({
    jobKind: z.literal('kb'),
    systemTaskId: z.string().min(1),
  })
  .passthrough();

const waitTerminalEventSchema = z
  .object({
    type: z.literal('terminal'),
    jobId: z.string(),
    seq: z.number().int().nonnegative(),
    remainingJobIds: z.array(z.string()).max(MAX_WAIT_JOB_IDS),
    resultPath: z.string(),
    result: jobTerminalSchema,
    version: z.literal('jobs.wait.v2').optional(),
    continuity: continuitySnapshotSchema.nullable().optional(),
    usage: usageSummarySchema.optional(),
    epochKey: z.string().min(1).optional(),
    cursor: waitCursorV2Schema.optional(),
  })
  .passthrough();

/**
 * Structurally incapable of carrying a terminal: no `seq`, no `result`, no `resultPath`, no continuity
 * snapshot. `.strict()` is what enforces that — a producer that tried to smuggle a terminal field through
 * this variant fails to parse rather than reaching a consumer that might honour it.
 */
const waitCarrierInterruptedEventSchema = z
  .object({
    type: z.literal('interrupted'),
    jobId: z.string().min(1),
    storedPhase: jobPhaseSchema,
    observedMaxJournalSeq: z.number().int().nonnegative(),
    remainingJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS),
    observation: z.object({ kind: z.literal('carrier_interrupted'), reason: z.literal('carrier_absent') }).strict(),
    continuity: z.literal('unavailable'),
    outcome: z.literal('unknown'),
    cursor: waitCursorV2Schema.optional(),
  })
  .strict();

const waitWaitingEventSchema = z
  .object({
    type: z.literal('waiting'),
    waitingJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS),
    // Omitted rather than empty: a renderer distinguishes "no unknowns" from "this build does not report
    // unknowns" by the field's absence, and an always-present empty array erases that distinction.
    carrierUnknownJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS).nonempty().optional(),
    cursor: waitCursorV2Schema.optional(),
  })
  .passthrough();

const waitStreamEventSchema = z.union([
  waitProgressEventSchema,
  waitQueuedProviderEventSchema,
  waitQueuedWorkflowEventSchema,
  waitQueuedKbEventSchema,
  waitTerminalEventSchema,
  waitCarrierInterruptedEventSchema,
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

/**
 * Same forward-compatibility gate as `parseWaitStreamEvent`, for a value that has already been decoded —
 * an IPC notification's `params`, rather than a raw SSE `data:` string. A build receiving a `type` it does
 * not recognize (a newer coordinator's addition) returns `null` here instead of throwing, so the caller can
 * skip that one event and keep the stream alive rather than crash on it.
 */
export function parseWaitStreamEventValue(value: unknown): WaitStreamEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !KNOWN_WAIT_STREAM_EVENT_TYPES.has(value.type)) {
    return null;
  }
  return waitStreamEventSchema.parse(value);
}

export function isWaitHandoverNotice(value: unknown): value is WaitHandoverNotice {
  return isRecord(value) && value.type === 'handover';
}
