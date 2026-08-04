import { z } from 'zod';

import { continuitySnapshotSchema } from '../sessions/continuity.js';
import { jobProgressTimingSchema } from './event-bodies.js';
import { jobTerminalSchema } from './terminal/result.js';
import { usageSummarySchema } from '../providers/contract.js';
import type { WaitStreamEvent } from './wait.js';

const KNOWN_WAIT_STREAM_EVENT_TYPES = new Set<string>(['progress', 'queued', 'terminal', 'waiting']);

export const MAX_WAIT_JOB_IDS = 128;
export const MAX_WAIT_SNAPSHOT_ACKS = MAX_WAIT_JOB_IDS * 2 + 1;

const MAX_SNAPSHOT_KEY_LENGTH = 16_384;
const MAX_SNAPSHOT_RENDER_ID_LENGTH = 256;

export type SnapshotKey = `queued:${string}` | `waiting:${string}` | `interrupted:${string}`;
export type SnapshotRenderId = string;
export type WaitSnapshotAck = Readonly<{ key: SnapshotKey; id: SnapshotRenderId }>;
export type WaitRenderCursor = Readonly<{
  afterSeq: number;
  snapshotAcks?: readonly WaitSnapshotAck[];
}>;

export type WaitRenderDecision = Readonly<{
  cursor: WaitRenderCursor;
  shouldRender: boolean;
}>;

type SnapshotWaitStreamEvent =
  | (Extract<WaitStreamEvent, { type: 'queued' }> & { readonly snapshotRenderId?: string })
  | (Extract<WaitStreamEvent, { type: 'waiting' }> & { readonly snapshotRenderId?: string });

function isSnapshotKey(value: string): value is SnapshotKey {
  if (value.startsWith('waiting:') && value.length > 'waiting:'.length) {
    return true;
  }

  return (
    (value.startsWith('queued:') && value.length > 'queued:'.length) ||
    (value.startsWith('interrupted:') && value.length > 'interrupted:'.length)
  );
}

const snapshotKeySchema = z
  .string()
  .max(MAX_SNAPSHOT_KEY_LENGTH)
  .refine(isSnapshotKey, 'snapshot acknowledgement key must use a known channel');

const snapshotRenderIdSchema = z.string().min(1).max(MAX_SNAPSHOT_RENDER_ID_LENGTH);

const waitSnapshotAckSchema = z
  .object({
    key: snapshotKeySchema,
    id: snapshotRenderIdSchema,
  })
  .strict();

const waitRenderCursorSchema = z
  .object({
    afterSeq: z.number().int().nonnegative(),
    snapshotAcks: z.array(waitSnapshotAckSchema).max(MAX_WAIT_SNAPSHOT_ACKS).optional(),
  })
  .strict()
  .superRefine((cursor, ctx) => {
    const keys = new Set<string>();
    for (const [index, acknowledgement] of (cursor.snapshotAcks ?? []).entries()) {
      if (keys.has(acknowledgement.key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'snapshot acknowledgement keys must be unique',
          path: ['snapshotAcks', index, 'key'],
        });
      }
      keys.add(acknowledgement.key);
    }
  });

function compareSnapshotAcks(left: WaitSnapshotAck, right: WaitSnapshotAck): number {
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

function normalizeWaitRenderCursor(cursor: WaitRenderCursor): WaitRenderCursor {
  const parsed = waitRenderCursorSchema.parse(cursor);
  const snapshotAcks = parsed.snapshotAcks?.map((acknowledgement) => ({ ...acknowledgement }));
  snapshotAcks?.sort(compareSnapshotAcks);
  return {
    afterSeq: parsed.afterSeq,
    ...(snapshotAcks && snapshotAcks.length > 0 ? { snapshotAcks } : {}),
  };
}

export function parseWaitRenderCursor(raw: string | undefined): WaitRenderCursor | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const result = waitRenderCursorSchema.safeParse(parsed);
    return result.success ? normalizeWaitRenderCursor(result.data) : null;
  } catch {
    return null;
  }
}

export function serializeWaitRenderCursor(cursor: WaitRenderCursor): string {
  return Buffer.from(JSON.stringify(normalizeWaitRenderCursor(cursor))).toString('base64url');
}

function snapshotAcknowledgement(event: SnapshotWaitStreamEvent): WaitSnapshotAck | null {
  if (event.snapshotRenderId === undefined) {
    return null;
  }

  const id = snapshotRenderIdSchema.parse(event.snapshotRenderId);
  if (event.type === 'queued') {
    return { key: snapshotKeySchema.parse(`queued:${event.jobId}`), id };
  }

  const waitingJobIds = [...event.waitingJobIds].sort();
  return { key: snapshotKeySchema.parse(`waiting:${JSON.stringify(waitingJobIds)}`), id };
}

function acknowledgeSnapshot(cursor: WaitRenderCursor, acknowledgement: WaitSnapshotAck): WaitRenderDecision {
  const current = cursor.snapshotAcks ?? [];
  if (current.some((entry) => entry.key === acknowledgement.key && entry.id === acknowledgement.id)) {
    return { cursor, shouldRender: false };
  }

  const replacesWaitingChannel = acknowledgement.key.startsWith('waiting:');
  const retained = current.filter(
    (entry) => entry.key !== acknowledgement.key && !(replacesWaitingChannel && entry.key.startsWith('waiting:')),
  );
  const snapshotAcks = [...retained, acknowledgement].sort(compareSnapshotAcks);
  if (snapshotAcks.length > MAX_WAIT_SNAPSHOT_ACKS) {
    throw new Error(`Wait snapshot acknowledgement limit exceeded (${MAX_WAIT_SNAPSHOT_ACKS})`);
  }

  return {
    cursor: normalizeWaitRenderCursor({ afterSeq: cursor.afterSeq, snapshotAcks }),
    shouldRender: true,
  };
}

export function advanceWaitRenderCursor(cursor: WaitRenderCursor, event: WaitStreamEvent): WaitRenderDecision {
  const current = normalizeWaitRenderCursor(cursor);
  if (event.type === 'progress' || event.type === 'terminal') {
    if (event.seq <= current.afterSeq) {
      return { cursor: current, shouldRender: false };
    }
    return {
      cursor: normalizeWaitRenderCursor({ ...current, afterSeq: event.seq }),
      shouldRender: true,
    };
  }

  const acknowledgement = snapshotAcknowledgement(event as SnapshotWaitStreamEvent);
  return acknowledgement === null
    ? { cursor: current, shouldRender: true }
    : acknowledgeSnapshot(current, acknowledgement);
}

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
  jobId: z.string().min(1),
  queuePosition: z.number(),
  runningJobIds: z.array(z.string().min(1)),
  timing: jobProgressTimingSchema,
  snapshotRenderId: snapshotRenderIdSchema.optional(),
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
    waitingJobIds: z.array(z.string().min(1)),
    snapshotRenderId: snapshotRenderIdSchema.optional(),
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
