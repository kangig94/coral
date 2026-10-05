import { waitJobHash, decodeWaitCursor } from './cursor.js';
import { z } from 'zod';

import { isRecord } from '../../infra/json.js';
import { continuitySnapshotSchema } from '../../sessions/continuity.js';
import { jobPhaseSchema } from '../phase.js';
import { jobProgressTimingSchema } from '../event-bodies.js';
import { jobTerminalSchema } from '../terminal/result.js';
import { usageSummarySchema } from '../../providers/contract.js';
import { type WaitCursor, type WaitHandoverNotice, type WaitStreamEvent } from './contract.js';

const KNOWN_WAIT_STREAM_EVENT_TYPES = new Set<string>([
  'progress',
  'queued',
  'terminal',
  'interrupted',
  'waiting',
  'notice',
  'disposition',
  'artifact',
]);
const waitCursorV3Schema = z.custom<Extract<WaitCursor, { version: 'jobs.wait.v3' }>>((value) => {
  const decoded = decodeWaitCursor(value);
  return decoded.kind === 'decoded' && decoded.cursor.version === 'jobs.wait.v3';
});
const waitCursorV2Schema = z.custom<Exclude<WaitCursor, { afterSeq: number }>>((value) => {
  const decoded = decodeWaitCursor(value);
  return decoded.kind === 'decoded' && decoded.cursor.version !== undefined;
});

export const MAX_WAIT_JOB_IDS = 128;

export type WaitRenderDecision = Readonly<{
  cursor: WaitCursor;
  shouldRender: boolean;
}>;

export function advanceWaitRenderCursor(cursor: WaitCursor, event: WaitStreamEvent): WaitRenderDecision {
  if ('cursor' in event && event.cursor?.version === 'jobs.wait.v3') {
    const acknowledged =
      cursor.version === 'jobs.wait.v3' &&
      event.type === 'terminal' &&
      cursor.jobs.some((job) => job.hash === waitJobHash(event.jobId) && (job.flags & 1) !== 0);
    return { cursor: event.cursor, shouldRender: !acknowledged };
  }
  if (cursor.version === 'jobs.wait.v3') return { cursor, shouldRender: true };
  if (event.type === 'progress' || event.type === 'terminal') {
    if (event.epochKey !== undefined && event.cursor?.version === 'jobs.wait.v2') {
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
    if (event.type === 'terminal') {
      if (legacy.deliveredJobIds?.includes(event.jobId)) return { cursor: legacy, shouldRender: false };
      return {
        cursor: { ...legacy, deliveredJobIds: [...(legacy.deliveredJobIds ?? []), event.jobId] },
        shouldRender: true,
      };
    }
    if (event.seq <= legacy.afterSeq) return { cursor: legacy, shouldRender: false };
    return { cursor: { ...legacy, afterSeq: event.seq }, shouldRender: true };
  }

  return { cursor: 'cursor' in event && event.cursor ? event.cursor : cursor, shouldRender: true };
}

function legacyRenderCursor(deliveredJobIds: readonly string[] | undefined): Extract<WaitCursor, { afterSeq: number }> {
  return deliveredJobIds === undefined || deliveredJobIds.length === 0
    ? { afterSeq: 0 }
    : { afterSeq: 0, deliveredJobIds: [...deliveredJobIds] };
}

const waitProgressEventSchema = z
  .object({
    type: z.literal('progress'),
    jobId: z.string(),
    seq: z.number().int().nonnegative(),
    message: z.string(),
    timing: jobProgressTimingSchema,
    version: z.enum(['jobs.wait.v2', 'jobs.wait.v3']).optional(),
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

export const resultAvailabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('available'), resultPath: z.string().min(1) }).strip(),
  z.object({ kind: z.literal('retained-away'), retentionDays: z.number().positive() }).strip(),
  z.object({ kind: z.literal('repair-pending'), ageUncertain: z.boolean() }).strip(),
  z
    .object({
      kind: z.literal('failed'),
      cause: z.enum([
        'repair-failed',
        'workflow-facts-unavailable',
        'source-epoch-retired',
        'terminal-age-unknown',
        'terminal-clock-regression',
        'cutoff-untrusted',
        'terminal-unusable',
      ]),
      retryScheduled: z.boolean(),
      ageUncertain: z.boolean().optional(),
      unverifiedResultPath: z.string().min(1).optional(),
    })
    .strip(),
]);

const waitTerminalEventSchema = z
  .object({
    type: z.literal('terminal'),
    jobId: z.string(),
    seq: z.number().int().nonnegative(),
    remainingJobIds: z.array(z.string()).max(MAX_WAIT_JOB_IDS),
    resultPath: z.string().min(1).optional(),
    availability: resultAvailabilitySchema.optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
    result: jobTerminalSchema,
    version: z.enum(['jobs.wait.v2', 'jobs.wait.v3']).optional(),
    continuity: continuitySnapshotSchema.nullable().optional(),
    usage: usageSummarySchema.optional(),
    epochKey: z.string().min(1).optional(),
    cursor: waitCursorV2Schema.optional(),
  })
  .passthrough();

/** Carrier interruption must reject terminal fields and cannot acknowledge an outcome. */
const waitCarrierInterruptedEventSchema = z
  .object({
    type: z.literal('interrupted'),
    version: z.literal('jobs.wait.v3').optional(),
    jobId: z.string().min(1),
    storedPhase: jobPhaseSchema,
    observedMaxJournalSeq: z.number().int().nonnegative(),
    remainingJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS),
    observation: z.object({ kind: z.literal('carrier_interrupted'), reason: z.literal('carrier_absent') }).strip(),
    continuity: z.literal('unavailable'),
    outcome: z.literal('unknown'),
    cursor: waitCursorV2Schema.optional(),
  })
  .strip();

const waitWaitingEventSchema = z
  .object({
    type: z.literal('waiting'),
    version: z.literal('jobs.wait.v3').optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
    waitingJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS),
    // Empty unknown coverage must omit the wire field.
    carrierUnknownJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS).nonempty().optional(),
    cursor: waitCursorV2Schema.optional(),
  })
  .passthrough();

const waitStreamEventSchema = z
  .union([
    waitProgressEventSchema,
    waitQueuedProviderEventSchema,
    waitQueuedWorkflowEventSchema,
    waitQueuedKbEventSchema,
    waitTerminalEventSchema,
    waitCarrierInterruptedEventSchema,
    waitWaitingEventSchema,
    z
      .object({
        type: z.literal('notice'),
        version: z.literal('jobs.wait.v3'),
        message: z.string(),
        exitCode: z.number().int().min(0).max(255).optional(),
        cursor: waitCursorV3Schema.optional(),
      })
      .strip(),
    z
      .object({
        type: z.literal('disposition'),
        version: z.literal('jobs.wait.v3'),
        jobId: z.string().min(1),
        disposition: z.enum([
          'missing',
          'discovery-unknown',
          'pre-epoch-history',
          'outcome-unrecoverable',
          'outcome-unreadable',
          'discovery-unreadable',
          'scope-mismatch',
        ]),
        message: z.string().optional(),
        cursor: waitCursorV3Schema.optional(),
      })
      .strip(),
    z
      .object({
        type: z.literal('artifact'),
        version: z.literal('jobs.wait.v3'),
        jobId: z.string().min(1),
        availability: resultAvailabilitySchema,
        remainingJobIds: z.array(z.string()).max(MAX_WAIT_JOB_IDS),
        cursor: waitCursorV3Schema,
        exitCode: z.number().int().min(0).max(255),
      })
      .strip(),
  ])
  .superRefine((event, ctx) => {
    const generation = 'version' in event ? event.version : undefined;
    if (generation !== 'jobs.wait.v3' && event.cursor?.version === 'jobs.wait.v3')
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'V3 cursor requires a V3 event' });
    if (generation === 'jobs.wait.v3' && event.cursor && event.cursor.version !== 'jobs.wait.v3')
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'V3 event requires a V3 cursor' });
    if (
      generation === 'jobs.wait.v3' &&
      (event.type === 'terminal' || event.type === 'progress' || event.type === 'waiting') &&
      (!event.cursor || ((event.type === 'terminal' || event.type === 'waiting') && event.exitCode === undefined))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete V3 delivery contract' });
    if (
      event.type === 'terminal' &&
      (generation === 'jobs.wait.v3'
        ? !event.availability ||
          (event.availability.kind === 'available'
            ? event.resultPath !== event.availability.resultPath
            : event.resultPath !== undefined)
        : !event.resultPath || event.availability !== undefined)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Terminal artifact contract mismatch' });
  });

export function parseWaitStreamEvent(eventType: string | undefined, rawData: string): WaitStreamEvent | null {
  if (!eventType || !KNOWN_WAIT_STREAM_EVENT_TYPES.has(eventType)) {
    return null;
  }

  const parsed: unknown = JSON.parse(rawData);
  const event = parseWaitStreamEventValue(parsed);
  if (event === null || event.type !== eventType) {
    throw new Error(`Invalid wait stream event payload for ${eventType}`);
  }
  return event;
}

/** Unknown event types must not terminate the subscription. */
export function parseWaitStreamEventValue(value: unknown): WaitStreamEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !KNOWN_WAIT_STREAM_EVENT_TYPES.has(value.type)) {
    return null;
  }
  if (
    value.type === 'interrupted' &&
    ['result', 'resultPath', 'availability', 'exitCode', 'usage'].some((key) => key in value)
  )
    throw new Error('Carrier interruption cannot deliver a terminal outcome');
  return waitStreamEventSchema.parse(value);
}

export function isWaitHandoverNotice(value: unknown): value is WaitHandoverNotice {
  return isRecord(value) && value.type === 'handover';
}
